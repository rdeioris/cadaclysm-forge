// The 0.14 forge layer's answers (test/fixtures/golden/, its README), replayed on nodes:
// each sequence that starts from a new document is run step by step through
// forge-commands.js (raw ops, undo and redo straight on the document), and after each step
// every body item's summary is compared with the recorded one -- face, edge and vertex
// counts and closure exact; area, volume and bounds to 1e-6 relative. A body that failed
// must fail again (its words may differ: the node layout did). A refused command must be
// refused again.
//
// A sequence is replayed up to the first step whose command is not on nodes yet
// (forge-commands.js's `Unported`): the groups of task 5.3 extend the replay as they land.
// Sequences that start from a 0.14 file wait for the converted files (task 5.4).
//
//     node test/golden.mjs            # every sequence
//     node test/golden.mjs a-rect     # those whose file name contains a word, each listed
//     GOLDEN_VERBOSE=1 node test/golden.mjs   # every sequence listed: how far it replays
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm } from "./package.mjs";
import { Model, isBody, UNITS } from "../forge-model.js";
import { command, Unported } from "../forge-commands.js";

const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden", "sequences");
const words = process.argv.slice(2);

// A body's summary, as scripts/forge-golden.mjs recorded it.
function summary(doc, id) {
    const kind = wasm[K + "document_result_kind"](doc, id);
    if (kind !== "solid" && kind !== "sheet") return null;
    const s = wasm[K + "document_result_solid"](doc, id);
    try {
        const row = Array.from(wasm[K + "manifold"](s));
        const out = {
            kind,
            faces: wasm[K + "face_count"](s),
            edges: wasm[K + "edge_count"](s),
            vertices: row[2],
            closed: row[7] === 1,
            bounds: Array.from(wasm[K + "bounds64"](s, 0.01)),
        };
        try {
            const m = wasm[K + "mass_properties"](s, 1e-9);
            out.area = m[4];
            out.volume = m[0] ? m[6] : 0;
        } catch (e) {
            out.mass = String(e?.message ?? e);
        }
        return out;
    } finally {
        wasm[K + "solid_free"](s);
    }
}

// Every body item by name (`name #id` where a name repeats): its summary or its error.
function bodies(doc, model) {
    const statuses = JSON.parse(wasm[K + "document_evaluate"](doc, false));
    const items = model.items();
    const names = new Map();
    for (const it of items) names.set(it.name, (names.get(it.name) ?? 0) + 1);
    const out = {};
    for (const it of items) {
        const id = it.of !== undefined ? it.node : `i${it.id}`;
        const st = statuses.find((s) => s.id === id);
        const s = st?.state === "ok" ? summary(doc, id) : null;
        const key = names.get(it.name) > 1 ? `${it.name} #${it.id}` : it.name;
        if (s) out[key] = s;
        else if (isBody(it)) out[key] = { error: !st ? `no node ${id}` : (st.error ?? `${st.state} by ${st.by}`) };
    }
    return out;
}

const near = (a, b) => a === b || Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1);

// The differences ACCEPTED.md lists, by sequence: from step `from` on, body `body` may
// differ as `allow` says -- "builds" (it builds where the 0.14 layer failed) or "placed"
// (only where it is: its counts, closure, area and volume still hold); step `step`'s
// command may be "refused" where the 0.14 layer did nothing.
const ACCEPTED = {
    // A sketch fillet that cannot be done is refused.
    "two-lines-rounded.json": [{ step: 6, allow: "refused" }],
    // A revolution of a curve builds.
    "every-command.json": [{ from: 7, body: "Revolution 1", allow: "builds" }],
};

function accepted(file, k, name) {
    return (ACCEPTED[file] ?? []).find((a) => k >= a.from && a.body === name)?.allow;
}

const acceptedRefusal = (file, k) => (ACCEPTED[file] ?? []).some((a) => a.step === k && a.allow === "refused");

// Each difference between the bodies `got` and the recorded `want`.
function differences(got, want, allow = () => undefined) {
    const out = [];
    const check = (ok, why) => { if (!ok) out.push(why); };
    const gk = Object.keys(got).sort(), wk = Object.keys(want).sort();
    check(JSON.stringify(gk) === JSON.stringify(wk), `the bodies: ${gk.join(", ")} != ${wk.join(", ")}`);
    for (const [name, w] of Object.entries(want)) {
        const g = got[name];
        if (!g) continue;
        const ok = allow(name);
        if (w.error !== undefined) {
            if (ok !== "builds") check(g.error !== undefined, `${name} must fail (${w.error}), it builds`);
            continue;
        }
        if (g.error !== undefined) { out.push(`${name} must build, it fails: ${g.error}`); continue; }
        for (const k of ["kind", "faces", "edges", "vertices", "closed"]) check(g[k] === w[k], `${name}: ${k} ${g[k]} != ${w[k]}`);
        check((g.mass !== undefined) === (w.mass !== undefined), `${name}: measured`);
        for (const k of ["area", "volume"]) if (w[k] !== undefined) check(near(g[k], w[k]), `${name}: ${k} ${g[k]} != ${w[k]}`);
        if (ok === "placed") continue;
        check(g.bounds.length === w.bounds.length, `${name}: bounds`);
        g.bounds.forEach((v, i) => check(near(v, w.bounds[i]), `${name}: bounds[${i}] ${v} != ${w.bounds[i]}`));
    }
    return out;
}

let sequences = 0, whole = 0, steps = 0;
const started = Date.now();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    if (words.length && !words.some((w) => file.includes(w))) continue;
    const seq = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (seq.start !== null) continue;
    const doc = wasm[K + "document_new"](UNITS);
    let model = new Model(wasm, doc);
    let ran = 0, stopped;
    try {
        for (const [k, st] of seq.steps.entries()) {
            const where = `${file} step ${k}`;
            const what = st.do;
            if (what === "open") {
                // A new document: nothing to do.
            } else if (what === "undo" || what === "redo") {
                model.refresh(wasm[K + `document_${what}`](doc));
            } else if (what.op !== undefined) {
                const op = typeof what.op === "string" ? what.op : JSON.stringify(what.op);
                model.refresh(wasm[K + "document_apply"](doc, op, undefined), typeof what.op === "string" ? JSON.parse(what.op) : what.op);
            } else {
                let refused;
                try {
                    wasm[K + "document_evaluate"](doc, false);
                    command(wasm, model, doc, what.command);
                } catch (e) {
                    if (e instanceof Unported) { stopped = `${k}: ${e.message}`; break; }
                    refused = e.message;
                }
                if (st.refused !== undefined) {
                    assert.ok(refused !== undefined, `${where}: must be refused (${st.refused})`);
                    ran++;
                    continue;
                }
                assert.ok(refused === undefined || acceptedRefusal(file, k), `${where}: refused: ${refused}`);
            }
            if (st.bodies) {
                const diff = differences(bodies(doc, model), st.bodies, (name) => accepted(file, k, name));
                if (diff.length && process.env.GOLDEN_ALL) console.log(`${where}:\n  ${diff.join("\n  ")}`);
                else assert.deepStrictEqual(diff, [], where);
            }
            // The model kept by changed sets reads as a fresh one does.
            assert.deepStrictEqual(model.items(), new Model(wasm, doc).items(), `${where}: the model's items`);
            ran++;
        }
    } finally {
        wasm[K + "document_free"](doc);
    }
    if (ran === 0) continue;
    sequences++;
    steps += ran;
    if (stopped === undefined) whole++;
    if (words.length || process.env.GOLDEN_VERBOSE) console.log(`${file}: ${ran} of ${seq.steps.length} steps${stopped ? ` (then ${stopped})` : ""}`);
}
console.log(`golden: ${steps} steps of ${sequences} sequences (${whole} whole) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
