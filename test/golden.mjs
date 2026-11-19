// The 0.14 forge layer's answers (test/fixtures/golden/, its README), replayed on nodes:
// each sequence that starts from a new document is run step by step through
// forge-commands.js (raw ops, undo and redo straight on the document), and after each step
// every body item's summary is compared with the recorded one -- face, edge and vertex
// counts and closure exact; area, volume and bounds to 1e-6 relative. A body that failed
// must fail again (its words may differ: the node layout did). A refused command must be
// refused again. A sequence that starts from a file starts from it as converted to nodes
// (examples/, test/fixtures/, the corpus's own `startText`: scripts/convert-examples.mjs,
// run once and gone, wrote them from the 0.14 files' items). Every sequence is replayed
// whole.
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
import { command } from "../forge-commands.js";

const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures", "golden", "sequences");
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

// Summaries by the kernel's hash of a result and its kind: a body no step changed is not
// measured again. (The hash is the shape's: a sphere and the sheet of its one face share it.)
const summaries = new Map();

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
        let s = null;
        if (st?.state === "ok") {
            const hk = st.hash ? `${wasm[K + "document_result_kind"](doc, id)} ${st.hash}` : "";
            if (!hk || !summaries.has(hk)) summaries.set(hk, summary(doc, id));
            s = structuredClone(summaries.get(hk));
            if (!hk) summaries.delete("");
        }
        const key = names.get(it.name) > 1 ? `${it.name} #${it.id}` : it.name;
        if (s) out[key] = s;
        else if (isBody(it)) out[key] = { error: !st ? `no node ${id}` : (st.error ?? `${st.state} by ${st.by}`) };
    }
    return out;
}

// What the recorder had open when a command was refused so: the calls that open and close it.
const BUSY = {
    "a preview is open": ["document_preview_begin", "document_end_preview"],
    "a batch is open": ["document_batch_begin", "document_batch_abort", "busy"],
};

const near = (a, b) => a === b || Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1);

// The differences ACCEPTED.md lists, by sequence: from step `from` on (to `to`, when
// given), body `body` may differ as `allow` says -- "builds" (it builds where the 0.14 layer
// failed), "placed" (only where it is: its counts, closure, area and volume still hold),
// "fails" (it fails where the 0.14 layer built: the 0.15 kernel refuses it, the 0.14 layer
// on the 0.15 package too) or "kernel" (its `keys` differ: the 0.15 kernel answers
// otherwise, the 0.14 layer on the 0.15 package the same) or "differs" (its `keys` differ:
// the node layer builds it otherwise, the 0.14 layer on the 0.15 package as recorded); where
// two cover a step, the later one in the list. Step `step`'s command may be "refused" where
// the 0.14 layer did nothing or did what the node layer refuses (the bodies it made, `lacks`,
// missing; undoing it is nothing); "unsupported" where the node layer refuses what the 0.14
// layer did (the document stays as it was, so the recording of that step is not compared);
// "stands-in" where the 0.14 layer refused and the node layer writes a stand-in; its raw op
// "raw-refused" where it names the 0.14 layout's nodes.
const ACCEPTED = {
    // A sketch fillet that cannot be done is refused.
    "two-lines-rounded.json": [{ step: 6, allow: "refused" }],
    "every-command.json": [
        // A revolution of a curve builds.
        { from: 7, body: "Revolution 1", allow: "builds" },
        // The 0.15 kernel: a box less a sphere counts 34 vertices; the shell of it has more
        // vertices, and with the face the page's own reference finds open it is too thick.
        { from: 19, body: "Cut 1", allow: "kernel", keys: ["vertices"] },
        { from: 58, body: "Cut 1 copy", allow: "kernel", keys: ["vertices"] },
        { from: 20, to: 20, body: "Shell 1", allow: "kernel", keys: ["vertices"] },
        { from: 21, body: "Shell 1", allow: "fails" },
        // A version-1 file's items are not loaded.
        { step: 63, allow: "unsupported" },
    ],
    // The 0.15 kernel: a box's rounded edges meet in fewer edges.
    "a-fillet-s-life.json": [{ from: 3, to: 3, body: "Fillet 1", allow: "kernel", keys: ["edges"] }],
    "a-replica.json": [{ from: 3, body: "Fillet 1", allow: "kernel", keys: ["edges"] }],
    "busy.json": [{ from: 5, body: "Fillet 1", allow: "kernel", keys: ["edges"] }],
    "held-bodies.json": [
        { from: 8, body: "Fillet 1", allow: "kernel", keys: ["edges"] },
        // A held body placed is summarized where it is (the recorder read the held node).
        { from: 9, body: "plate part", allow: "placed" },
    ],
    // The 0.15 kernel: the join of a box moved off a cylinder's middle counts one more edge.
    "the-scene-s-commands.json": [{ from: 20, body: "Join 1", allow: "kernel", keys: ["edges"] }],
    // A raw op on the 0.14 trim's nodes.
    "a-late-tool.json": [{ step: 6, allow: "raw-refused" }],
    // The 0.15 kernel: a box's rounded edges meet in fewer edges. A pick on a body that has
    // not built is a stand-in.
    "a-broken-pick.json": [
        { from: 0, body: "Fillet 2", allow: "kernel", keys: ["edges"] },
        { from: 6, body: "Fillet 1", allow: "kernel", keys: ["edges"] },
        { step: 3, allow: "stands-in" },
        { from: 4, body: "Fillet 3", allow: "fails" },
    ],
    "box-fillet-resized.json": [{ from: 0, body: "Fillet 1", allow: "kernel", keys: ["edges"] }],
    "forge-box-fillet.json": [
        { from: 0, body: "Fillet 1", allow: "kernel", keys: ["edges"] },
        { from: 0, body: "Fillet 2", allow: "kernel", keys: ["edges"] },
        { from: 0, body: "Refillet 1", allow: "kernel", keys: ["edges"] },
    ],
    "forge-kinds-made.json": [
        { from: 0, body: "Fillet 1", allow: "kernel", keys: ["edges"] },
        { from: 0, body: "Fillet 2", allow: "kernel", keys: ["edges"] },
        { from: 0, body: "Refillet 1", allow: "kernel", keys: ["edges"] },
        { from: 0, body: "Fillet 3", allow: "kernel", keys: ["edges"] },
        { from: 0, body: "Refillet 2", allow: "kernel", keys: ["edges"] },
        // A trim by a closed curve: its edge has one vertex; the prism of it three faces.
        { from: 0, body: "Trim 1", allow: "differs", keys: ["vertices"] },
        { from: 0, body: "Solid 1", allow: "differs", keys: ["faces", "edges", "volume"] },
        { from: 241, to: 264, body: "Face 9", allow: "differs", keys: ["vertices"] },
        { from: 267, to: 267, body: "Face 9", allow: "differs", keys: ["edges"] },
        { from: 279, to: 279, body: "Fillet 3", allow: "differs", keys: ["faces", "edges", "volume"] },
        { step: 273, allow: "refused" },
        { step: 277, allow: "refused", lacks: ["Shell 2"] },
        { step: 283, allow: "refused", lacks: ["Face 9"] },
        { step: 284, allow: "refused", lacks: ["Face 9", "Press Pull 3"] },
        { step: 286, allow: "refused", lacks: ["Face 9", "Refillet 2"] },
        { step: 288, allow: "refused", lacks: ["Face 9", "Rechamfer 2"] },
        { step: 290, allow: "refused", lacks: ["Face 9", "Unfillet 2"] },
    ],
    // The 0.15 kernel: a press of a cone's face counts 28 vertices.
    "forge-kinds-quick.json": [{ from: 96, to: 96, body: "Press Pull 1", allow: "kernel", keys: ["vertices"] }],
    // A trim by a closed curve: its edge has one vertex.
    "forge-sheet-trim.json": [
        { from: 0, body: "Trim 1", allow: "differs", keys: ["vertices"] },
        { from: 0, body: "Face 1", allow: "differs", keys: ["vertices"] },
    ],
    "sheet-trim.json": [{ from: 0, body: "Trim 1", allow: "differs", keys: ["vertices"] }],
    // A version-1 file's parts are not on nodes: its join is a stand-in.
    "forge-v1.json": [
        { from: 0, body: "Join 1", allow: "fails" },
        { from: 27, body: "Face 1", allow: "fails" },
        { from: 39, body: "Fillet 1", allow: "fails" },
        { from: 44, body: "Press Pull 1", allow: "fails" },
        { step: 29, allow: "refused" },
        { step: 31, allow: "refused" },
        { step: 33, allow: "refused" },
        { step: 35, allow: "refused" },
    ],
};

function accepted(file, k, name) {
    return (ACCEPTED[file] ?? []).filter((a) => k >= a.from && (a.to === undefined || k <= a.to) && a.body === name).pop();
}

const acceptedRefusal = (file, k) => (ACCEPTED[file] ?? []).some((a) => a.step === k && (a.allow === "refused" || a.allow === "unsupported"));
const lacks = (file, k) => (ACCEPTED[file] ?? []).filter((a) => a.step === k && a.allow === "refused").flatMap((a) => a.lacks ?? []);
const standsIn = (file, k) => (ACCEPTED[file] ?? []).some((a) => a.step === k && a.allow === "stands-in");
const unsupported = (file, k) => (ACCEPTED[file] ?? []).some((a) => a.step === k && a.allow === "unsupported");
const acceptedRaw = (file, k) => (ACCEPTED[file] ?? []).some((a) => a.step === k && a.allow === "raw-refused");

// Each difference between the bodies `got` and the recorded `want`.
function differences(got, want, allow = () => undefined, lacking = []) {
    const out = [];
    const check = (ok, why) => { if (!ok) out.push(why); };
    const gk = Object.keys(got).sort(), wk = Object.keys(want).filter((n) => !lacking.includes(n)).sort();
    check(JSON.stringify(gk) === JSON.stringify(wk), `the bodies: ${gk.join(", ")} != ${wk.join(", ")}`);
    for (const [name, w] of Object.entries(want)) {
        const g = got[name];
        if (!g) continue;
        const a = allow(name), ok = a?.allow;
        const free = (k) => (ok === "kernel" || ok === "differs") && a.keys.includes(k);
        if (w.error !== undefined) {
            if (ok !== "builds") check(g.error !== undefined, `${name} must fail (${w.error}), it builds`);
            continue;
        }
        if (g.error !== undefined) {
            if (ok !== "fails") out.push(`${name} must build, it fails: ${g.error}`);
            continue;
        }
        if (ok === "fails") { out.push(`${name} must fail (the 0.15 kernel), it builds`); continue; }
        for (const k of ["kind", "faces", "edges", "vertices", "closed"]) if (!free(k)) check(g[k] === w[k], `${name}: ${k} ${g[k]} != ${w[k]}`);
        check((g.mass !== undefined) === (w.mass !== undefined), `${name}: measured`);
        for (const k of ["area", "volume"]) if (w[k] !== undefined && !free(k)) check(near(g[k], w[k]), `${name}: ${k} ${g[k]} != ${w[k]}`);
        if (ok === "placed") continue;
        check(g.bounds.length === w.bounds.length, `${name}: bounds`);
        g.bounds.forEach((v, i) => check(near(v, w.bounds[i]), `${name}: bounds[${i}] ${v} != ${w.bounds[i]}`));
    }
    return out;
}

let sequences = 0, steps = 0, files = 0;
const started = Date.now();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    if (words.length && !words.some((w) => file.includes(w))) continue;
    const seq = JSON.parse(readFileSync(join(dir, file), "utf8"));
    files++;
    // A new document, or the file it was opened from (converted: the 0.14 file's items as
    // nodes, no history), as the page opens one.
    const doc = seq.start === null ? wasm[K + "document_new"](UNITS)
        : wasm[K + "document_load"](seq.start === "inline" ? seq.startText : readFileSync(join(here, "..", seq.start), "utf8"));
    let model = new Model(wasm, doc);
    let ran = 0;
    // The recording's commits as the replay has them, for its undo and redo: true where the
    // replay committed too, false where it refuses what the 0.14 layer did (an accepted
    // difference) -- undoing or redoing that is nothing.
    const done = [], undone = [];
    const commit = (real) => { done.push(real); undone.length = 0; };
    try {
        for (const [k, st] of seq.steps.entries()) {
            const where = `${file} step ${k}`;
            const what = st.do;
            if (what === "open") {
                // Opened above.
            } else if (what === "undo" || what === "redo") {
                const real = (what === "undo" ? done : undone).pop();
                if (real !== undefined) (what === "undo" ? undone : done).push(real);
                if (real !== false) model.refresh(wasm[K + `document_${what}`](doc));
            } else if (what.op !== undefined) {
                const op = typeof what.op === "string" ? what.op : JSON.stringify(what.op);
                try {
                    model.refresh(wasm[K + "document_apply"](doc, op, undefined), typeof what.op === "string" ? JSON.parse(what.op) : what.op);
                    commit(true);
                } catch (e) {
                    // A raw op written for the 0.14 layout may name nodes this one does not have.
                    if (!acceptedRaw(file, k)) throw e;
                    commit(false);
                    ran++;
                    continue;
                }
            } else {
                let refused;
                // A refusal recorded with the document busy: the recorder had a preview or
                // a batch open, and so does the replay.
                const busy = BUSY[st.refused];
                try {
                    wasm[K + "document_evaluate"](doc, false);
                    if (busy) wasm[K + busy[0]](doc, ...busy.slice(2));
                    try {
                        command(wasm, model, doc, what.command);
                    } finally {
                        if (busy) wasm[K + busy[1]](doc);
                    }
                } catch (e) {
                    refused = e.message;
                }
                if (st.refused !== undefined && !standsIn(file, k)) {
                    assert.ok(refused !== undefined, `${where}: must be refused (${st.refused})`);
                    ran++;
                    continue;
                }
                if (st.refused !== undefined) {
                    // Refused by the 0.14 layer, written as a stand-in here: a commit the
                    // recording has not (no later step of such a sequence undoes past it).
                    assert.ok(refused === undefined, `${where}: refused: ${refused}`);
                    done.push(true);
                    ran++;
                    continue;
                }
                assert.ok(refused === undefined || acceptedRefusal(file, k), `${where}: refused: ${refused}`);
                commit(refused === undefined);
                if (unsupported(file, k)) {
                    assert.ok(refused !== undefined, `${where}: must be refused (not supported)`);
                    ran++;
                    continue;
                }
            }
            if (st.bodies) {
                const diff = differences(bodies(doc, model), st.bodies, (name) => accepted(file, k, name), lacks(file, k));
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
    assert.strictEqual(ran, seq.steps.length, `${file}: replayed whole`);
    sequences++;
    steps += ran;
    if (words.length || process.env.GOLDEN_VERBOSE) console.log(`${file}: ${ran} steps`);
}
assert.strictEqual(sequences, files, "every sequence replayed");
console.log(`golden: ${steps} steps of ${sequences} sequences in ${((Date.now() - started) / 1000).toFixed(1)} s`);
