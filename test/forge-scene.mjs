// The forge worker's scene on its replica of the document: opened from a file, it posts
// every body with the figures pinned in forge-pins.json; fed the ops the page's replica
// makes, it posts the bodies whose node changed (and nothing else), saves the same bytes
// as the page, answers picks, follows undo, redo, a branch switch and a drag's preview,
// reports progress, and shows what the page wants on its View. The page's replica is driven as the page drives
// it: forge-doc-convert.js over the kernel's public exports.
//
// Run: node test/forge-scene.mjs   (after npm run setup)
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadWasm } from "./package.mjs";
import { createForgeScene, createForgeRouter, VIEW_ID, MESH_TOLERANCE, EDGE_TOLERANCE, bodyTable, massOf, itemOfNode, dropRedo, createQuarantine } from "../forge-scene.js";
import { createWantedSender, typedBytes } from "../forge-wanted.js";
import { command, commandOp, commandNeedsGeometry, openDocument, documentPickRefs, toJson } from "../forge-doc-convert.js";
import { itemsOf } from "../forge-doc-nodes.js";
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const wasm = await loadWasm();

// The built answer of the reference join (a box and a cylinder): its table and refs only.
// A regression guard on the answer's size, as before the document: the cap is well under the
// display snapshot the page took before (24508 bytes on the exact path).
const BRIDGE_CAP = 12288;
const SNAPSHOT_EXACT_BYTES = 24508;
const pins = JSON.parse(readFileSync(join(here, "fixtures", "forge-pins.json"), "utf8"));
const harness = (host = null, extra = {}) => { const posted = []; const s = createForgeScene({ wasm, post: (m) => posted.push(m), host, ...extra }); return { s, posted }; };
const of = (posted, kind) => posted.filter((m) => m.kind === kind);
// A document's items, as the page reads them off its save.
const itemsNow = (doc) => itemsOf(JSON.parse(wasm.cadaclysm_blacksmith_document_save(doc))).toLit();

// The page's replica: forge commands as the page runs them, each giving the op it sends.
function pageDoc(text = null) {
    const doc = text === null ? wasm.cadaclysm_blacksmith_document_new("mm") : openDocument(wasm, text);
    return {
        doc,
        run: (cmd) => toJson(command(wasm, doc, cmd).op),
        save: () => wasm.cadaclysm_blacksmith_document_save(doc),
        status: () => new Map(JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, false)).map((s) => [s.id, s])),
        free: () => wasm.cadaclysm_blacksmith_document_free(doc),
    };
}
// A page and a worker scene on the same document, the page's every command sent as its op.
async function pair(host = null, extra = {}) {
    const page = pageDoc(), h = harness(host, extra);
    h.s.open(page.save()); await h.s.drain();
    const run = async (...cmds) => { for (const c of cmds) h.s.op(page.run(c)); await h.s.drain(); };
    return { page, ...h, run };
}
const BOX = { op: "primitive", id: 1, kind: "box", plane: "top", dims: [20, 20, 20] };
const PEG = { op: "primitive", id: 2, kind: "cylinder", plane: "top", dims: [6, 30] };
const JOIN = { op: "join", id: 3, parts: [1, 2] };

const close = (got, want, rel) => Math.abs(got - want) <= rel * Math.max(1, Math.abs(want));
// The kernel with its solid frees counted: what the scene frees, handed in as its `wasm`.
function countingFrees() {
    const counter = { frees: 0 };
    counter.wasm = { ...wasm, cadaclysm_blacksmith_solid_free: (h) => { counter.frees++; return wasm.cadaclysm_blacksmith_solid_free(h); } };
    return counter;
}
// A solid's bounds as the scene's table gives them: its mesh's box at MESH_TOLERANCE.
function meshBounds(solid) {
    const b = wasm.cadaclysm_blacksmith_bounds(solid, MESH_TOLERANCE);
    const d = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    return d < 1e-12 ? { centre: [b[0], b[1], b[2]], radius: 1 } : { centre: [0, 1, 2].map((k) => (b[k] + b[k + 3]) / 2), radius: d / 2 };
}

// Every pinned document opened: every pinned body built (none failed), at its pinned
// figures -- faces and edges exact, volume and area within 1e-9 (the kernel's public solid
// getters: B-rep faces, `cadaclysm_blacksmith_edge_count`, mass properties). The bounds are
// the kernel mesh's box at MESH_TOLERANCE, no longer the box round the exact surfaces the
// pins hold (a looser box): checked against the solid read here, the distance from the pin
// reported.
{
    let checked = 0, offPin = 0;
    for (const [file, pin] of Object.entries(pins)) {
        if (!pin.bodies.length) continue;
        const { s, posted } = harness();
        s.open(readFileSync(join(repo, file), "utf8")); await s.drain();
        const built = new Map(of(posted, "built").map((m) => [m.id, m]));
        assert.deepStrictEqual(of(posted, "failed"), [], `${file}: nothing fails`);
        assert.deepStrictEqual([...built.keys()].sort((a, b) => a - b), pin.bodies.map((b) => b.id).sort((a, b) => a - b), `${file}: every pinned body, once`);
        for (const b of pin.bodies) {
            const m = built.get(b.id), solid = s.solidOf(b.id);
            assert.ok(/^[0-9a-f]{16}$/.test(m.key) && m.version === 1, `${file} ${b.id}: key and version`);
            const [volume, area] = massOf(wasm, solid);
            const got = { faces: m.table.faceKinds.length, edges: wasm.cadaclysm_blacksmith_edge_count(solid) };
            assert.deepStrictEqual(got, { faces: b.faces, edges: b.edges }, `${file} ${b.id}: faces and edges`);
            assert.strictEqual(wasm.cadaclysm_blacksmith_face_count(solid), b.faces, `${file} ${b.id}: the solid's faces`);
            assert.strictEqual(m.table.edges[0], b.edges, `${file} ${b.id}: the table's edge list`);
            assert.ok(close(volume, b.volume, 1e-9) && close(area, b.area, 1e-9), `${file} ${b.id}: volume ${volume} area ${area}, pinned ${b.volume} ${b.area}`);
            if (b.faces) assert.deepStrictEqual(m.table.bounds, meshBounds(solid), `${file} ${b.id}: bounds`);
            offPin = Math.max(offPin, Math.abs(m.table.bounds.radius - b.bounds.radius), ...m.table.bounds.centre.map((v, k) => Math.abs(v - b.bounds.centre[k])));
            assert.strictEqual(m.refs.length, m.table.faceKinds.length * 8, "eight numbers a face");
            assert.strictEqual(m.table.frames.length, m.table.faceKinds.length * 12, "twelve numbers a face's frame");
            m.table.faceKinds.forEach((kind, f) => assert.strictEqual(kind === 0 && m.table.frames.subarray(12 * f, 12 * f + 12).every(Number.isFinite), kind === 0, `${file} ${b.id}: face ${f}'s frame, kind ${kind}`));
            // Nothing the View draws crosses.
            assert.deepStrictEqual(Object.keys(m).sort(), ["elapsed", "ghostFaces", "id", "key", "kind", "refs", "table", "version"]);
            checked++;
        }
    }
    assert.ok(checked >= 100, `only ${checked} pinned bodies checked`);
    console.log(`  ${checked} pinned bodies; the mesh bounds at most ${offPin.toFixed(3)} from the pinned exact-surface bounds`);
}

// A flat face's frame is the one the document's `frame.on_face` gives it: the face sketch of
// face-sketch.json stands on face 0 of i1, and the table's frame of that face is its node's value.
{
    const text = readFileSync(join(repo, "examples/face-sketch.json"), "utf8");
    const { s, posted } = harness();
    s.open(text); await s.drain();
    const table = of(posted, "built").find((m) => m.id === 1).table;
    const doc = openDocument(wasm, text);
    wasm.cadaclysm_blacksmith_document_evaluate(doc, false);
    const node = JSON.parse(wasm.cadaclysm_blacksmith_document_save(doc)).nodes.find((n) => n.kind === "frame.on_face" && n.solid === "i1");
    const want = JSON.parse(wasm.cadaclysm_blacksmith_document_value(doc, node.id));
    const solid = s.solidOf(1);
    const face = wasm.cadaclysm_blacksmith_find_face(solid, Float64Array.of(node.face.surface, ...node.face.at, ...node.face.normal, node.face.extent), -1, 1e-6);
    assert.deepStrictEqual(Array.from(table.frames.subarray(12 * face, 12 * face + 12)), want, `face ${face}'s frame is ${node.id}'s`);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// Ops: each command's op posts the bodies whose node changed and nothing else; the keys are
// the page's own, and both replicas save the same bytes.
{
    const { page, s, posted, run } = await pair();
    await run(BOX);
    assert.deepStrictEqual(of(posted, "built").map((m) => [m.id, m.version]), [[1, 1]]);
    assert.strictEqual(of(posted, "built")[0].key, page.status().get("i1").key, "the page's key");
    posted.length = 0;
    await run(PEG);
    assert.deepStrictEqual(of(posted, "built").map((m) => m.id), [2], "the box is not posted again");
    posted.length = 0;
    await run(JOIN);
    assert.deepStrictEqual(of(posted, "built").map((m) => m.id), [3], "only the join");
    // Progress: from the join's own nodes, throttled, at each phase's start.
    const progress = of(posted, "progress");
    assert.ok(progress.length > 0, "the join reports its progress");
    for (const p of progress) {
        assert.strictEqual(p.id, 3); assert.strictEqual(itemOfNode(p.node), 3); assert.strictEqual(p.op, "join");
        assert.ok(p.steps >= 1 && p.step >= 0 && p.step < p.steps && typeof p.phase === "string" && p.done <= p.total, JSON.stringify(p));
    }
    assert.ok(progress.some((p) => p.done === 0), "a phase's start is posted");
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save(), "the replicas save the same bytes");
    // The byte cap: what crosses for a built body is its table and refs.
    const msg = of(posted, "built")[0], bytes = typedBytes(msg);
    assert.ok(bytes <= BRIDGE_CAP, `built answer ${bytes} B over the cap ${BRIDGE_CAP} B`);
    assert.ok(BRIDGE_CAP < SNAPSHOT_EXACT_BYTES);
    // The table is the solid's: the same faces and bounds as reading it here.
    const direct = bodyTable(wasm, s.solidOf(3));
    assert.deepStrictEqual(Array.from(msg.table.faceKinds), Array.from(direct.faceKinds));
    assert.deepStrictEqual(Array.from(msg.table.edges), Array.from(direct.edges));
    assert.deepStrictEqual(msg.table.bounds, direct.bounds);
    assert.ok(msg.table.edges && "closure" in msg.table);

    // A pick answers the references the page's replica gives for the same picks.
    posted.length = 0;
    s.pick({ req: 7, id: 1, what: "edges", indices: [0, 1] });
    s.pick({ req: 8, id: 3, what: "faces", indices: [0] });
    s.pick({ req: 9, id: 99, what: "faces", indices: [0] });
    await s.drain();
    const picked = of(posted, "picked");
    assert.deepStrictEqual(picked.map((m) => m.req), [7, 8, 9]);
    assert.deepStrictEqual(picked[0].refs, documentPickRefs(wasm, page.doc, "i1", "edges", [0, 1]));
    assert.deepStrictEqual(picked[1].refs, documentPickRefs(wasm, page.doc, "i3", "faces", [0]));
    assert.ok(/i99/.test(picked[2].error) && !picked[2].refs, picked[2].error);

    // Undo: the join is gone (freed, and forgotten); redo makes it again, a new version.
    posted.length = 0;
    wasm.cadaclysm_blacksmith_document_undo(page.doc); s.undo(); await s.drain();
    assert.deepStrictEqual(posted, [{ kind: "forgotten", ids: [3] }], "an undone join is forgotten");
    assert.strictEqual(s.solidOf(3), null, "and its solid is freed");
    wasm.cadaclysm_blacksmith_document_redo(page.doc); s.redo(); await s.drain();
    assert.deepStrictEqual(of(posted, "built").map((m) => [m.id, m.version]), [[3, 2]]);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save());
    // Nothing to redo: nothing happens.
    posted.length = 0; s.redo(); await s.drain();
    assert.deepStrictEqual(posted, []);

    // A failing body is `failed` with its error and keeps its last solid; one reading it is
    // `failed`, blocked, naming it.
    await run({ op: "set", id: 1, dims: [20, 20, 20] });   // no change at all: nothing posted
    assert.deepStrictEqual(of(posted, "built"), []);
    const kept = s.solidOf(3);
    posted.length = 0;
    await run({ op: "fillet", id: 4, source: 3, radius: 1, style: "round" }, { op: "set", id: 4, edges: [0] });
    assert.deepStrictEqual(of(posted, "built").map((m) => m.id), [4], "the fillet, once: the two ops are one evaluation");
    const before = of(posted, "built").at(-1).version;
    posted.length = 0;
    await run({ op: "set", id: 4, radius: 500 });
    const failed = of(posted, "failed");
    assert.deepStrictEqual(failed.map((m) => m.id), [4]);
    assert.ok(failed[0].error && !/blocked/.test(failed[0].error), failed[0].error);
    assert.ok(s.solidOf(4), "a failed body keeps its last solid");
    assert.strictEqual(s.solidOf(3), kept);
    posted.length = 0;
    await run({ op: "primitive", id: 5, kind: "box", plane: "top", dims: [5, 5, 50] }, { op: "join", id: 6, parts: [4, 5] });
    const blocked = of(posted, "failed").find((m) => m.id === 6);
    assert.ok(blocked && /^blocked by /.test(blocked.error) && itemOfNode(blocked.by) === 4, JSON.stringify(blocked));
    assert.deepStrictEqual(of(posted, "built").map((m) => m.id), [5]);
    // The same failure is not posted again when something else changes.
    posted.length = 0;
    await run({ op: "primitive", id: 7, kind: "box", plane: "top", dims: [3, 3, 3] });
    assert.deepStrictEqual(of(posted, "built").map((m) => m.id), [7]);
    assert.deepStrictEqual(of(posted, "failed"), []);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save());

    // An op the replica refuses is answered, and the next one still applies.
    posted.length = 0;
    s.op({ op: "remove", id: "nothing" }); s.op(page.run({ op: "set", id: 4, radius: 1 })); await s.drain();
    assert.deepStrictEqual(posted.filter((m) => m.kind !== "progress").map((m) => [m.kind, m.id ?? m.what]), [["opFailed", "op"], ["built", 4], ["built", 6]]);
    // The fillet came back to the solid it kept: answered from it, the same version.
    assert.strictEqual(of(posted, "built")[0].version, before, "a recovered body is not a new version");
    page.free();
}

// The page's tables follow the messages alone -- built sets one, forgotten drops it -- and
// match the bodies the page's own replica has, whether the changes come one evaluation each
// or several in one (undo then redo, delete then undo: nothing to forget, nothing to post).
{
    const { page, s, posted, run } = await pair();
    const tables = new Map();
    const follow = () => {
        for (const m of posted.splice(0)) {
            if (m.kind === "built") tables.set(m.id, m.version);
            else if (m.kind === "forgotten") for (const id of m.ids) tables.delete(id);
        }
        const bodies = itemsNow(page.doc).filter((i) => ["box", "cylinder", "join"].includes(i.kind)).map((i) => i.id);
        assert.deepStrictEqual([...tables.keys()].sort(), bodies.sort(), "the page's tables are its bodies");
    };
    await run(BOX, PEG, JOIN); follow();
    const step = async (...what) => { for (const w of what) { wasm[`cadaclysm_blacksmith_document_${w}`](page.doc); s[w](); } await s.drain(); };
    await step("undo", "redo");
    assert.deepStrictEqual(posted, [], "undo then redo in one evaluation: nothing");
    follow();
    await step("undo"); assert.deepStrictEqual(posted, [{ kind: "forgotten", ids: [3] }]); follow();
    await step("redo"); assert.deepStrictEqual(of(posted, "built").map((m) => m.id), [3]); follow();
    s.op(page.run({ op: "delete", ids: [3] })); wasm.cadaclysm_blacksmith_document_undo(page.doc); s.undo(); await s.drain();
    assert.deepStrictEqual(posted, [], "delete then undo in one evaluation: nothing");
    follow();
    await run({ op: "delete", ids: [3] });
    assert.deepStrictEqual(posted, [{ kind: "forgotten", ids: [3] }]); follow();
    page.free();
}
// A change that lists nothing evaluates nothing; a body item with no node is failed, once; an
// evaluation that fails outside any node is opFailed.
{
    let evaluations = 0, hide = null, broken = false;
    const spy = { ...wasm,
        cadaclysm_blacksmith_document_evaluate_with: (doc, cheap, report) => {
            evaluations++;
            const out = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate_with(doc, cheap, report));
            return JSON.stringify(out.filter((st) => st.id !== hide));
        },
        cadaclysm_blacksmith_document_save: (doc) => { if (broken) throw new Error("save broke"); return wasm.cadaclysm_blacksmith_document_save(doc); },
    };
    const { s, posted, run } = await pair(null, { wasm: spy });
    await run(BOX);
    const n = evaluations;
    await run({ op: "set", id: 1, dims: [20, 20, 20] });
    s.redo(); await s.drain();
    assert.strictEqual(evaluations, n, "a no-op set and an empty redo evaluate nothing");
    posted.length = 0;
    hide = "i1";
    await run(PEG, { op: "set", id: 2, dims: [6, 31] });
    assert.deepStrictEqual(of(posted, "failed").map((m) => [m.id, m.error]), [[1, "no node i1"]], "failed once");
    hide = null; broken = true; posted.length = 0;
    await run({ op: "set", id: 2, dims: [6, 32] });
    assert.deepStrictEqual(posted.map((m) => [m.kind, m.what]), [["opFailed", "evaluate"]]);
    assert.ok(/save broke/.test(posted[0].error));
}
// Open again: every body is posted again; a branch switch on both replicas leaves them equal.
{
    const text = readFileSync(join(repo, "examples/kinds-history.json"), "utf8");
    const page = pageDoc(text), { s, posted } = harness();
    s.open(page.save()); await s.drain();
    const first = of(posted, "built").map((m) => m.id);
    assert.deepStrictEqual(first, [3, 4]);
    posted.length = 0;
    s.open(page.save()); await s.drain();
    assert.deepStrictEqual(of(posted, "built").map((m) => [m.id, m.version]), [[3, 1], [4, 1]], "an open posts every body again, an unchanged one from the solid it keeps");
    const [tip] = JSON.parse(wasm.cadaclysm_blacksmith_document_tips(page.doc));
    posted.length = 0;
    wasm.cadaclysm_blacksmith_document_branch_switch(page.doc, tip.id); s.switchBranch(tip.id); await s.drain();
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save(), "the same save after the switch");
    const items = itemsNow(page.doc), status = page.status();
    for (const item of items.filter((i) => ["box", "join", "cylinder", "fillet", "cut", "shell"].includes(i.kind))) {
        assert.ok(status.get(`i${item.id}`).state !== "ok" || s.solidOf(item.id), `body ${item.id} is kept after the switch`);
    }
    assert.ok(posted.length > 0, "the switch changed something");
    page.free();
}

// A drag on both replicas: each frame the page's op (`commandOp`, its last
// frame's preview ended first) previewed on both; the worker posts the moved box once for
// two frames, at the page's previewed key, and the preview is in neither save. The commit
// ends the preview on both sides and commits the drag's command: the same save, and nothing
// posted again (the last frame built it). A drag that ends with nothing to commit ends its
// preview, and the box is answered back where the document has it. A Cancel's `dropRedo`
// leaves both replicas saving the same bytes, with nothing to redo. The router passes the
// preview messages on as the scene's own calls.
{
    const { page, s, posted, run } = await pair();
    const route = createForgeRouter({ scene: s, post: (m) => posted.push(m), ready: Promise.resolve() });
    const routed = async (m) => { route(m); await new Promise((r) => setTimeout(r, 0)); await s.drain(); };
    await run(BOX);
    const before = page.save();
    const keyNow = () => JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(page.doc, true)).find((st) => st.id === "i1").key;
    const frame = (tx) => {
        wasm.cadaclysm_blacksmith_document_end_preview(page.doc);
        const op = toJson(commandOp(wasm, page.doc, { op: "edit", items: [{ id: 1, transform: { tx, ty: 0, angle: 0, scale: 1 } }] }));
        wasm.cadaclysm_blacksmith_document_preview(page.doc, op);
        return op;
    };
    posted.length = 0;
    s.preview(frame(5)); s.preview(frame(10)); await s.drain();
    const built = of(posted, "built");
    assert.deepStrictEqual(built.map((m) => [m.id, m.key]), [[1, keyNow()]], "two frames, one evaluation, at the page's previewed key");
    assert.ok(Math.abs(built[0].table.bounds.centre[0] - 10) < 1e-6, `the box followed the drag: ${built[0].table.bounds.centre}`);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), before, "a preview is not in the worker's save");
    assert.strictEqual(page.save(), before, "nor in the page's");
    // Committed: the preview ended on both, the drag's command committed as its op.
    posted.length = 0;
    wasm.cadaclysm_blacksmith_document_end_preview(page.doc);
    route({ kind: "endPreview" });   // sent together, as the page sends them: one evaluation
    await routed({ kind: "op", op: page.run({ op: "set", id: 1, transform: { tx: 10, ty: 0, angle: 0, scale: 1 } }) });
    assert.notStrictEqual(page.save(), before);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save(), "the same save after the commit");
    assert.deepStrictEqual(of(posted, "built"), [], "the last frame built what was committed");
    assert.deepStrictEqual(of(posted, "opFailed"), []);
    // A drag that commits nothing: its preview ended, the box answered back at the committed key.
    const committed = keyNow(), saved = page.save();
    await routed({ kind: "preview", op: frame(30) });
    assert.strictEqual(of(posted, "built").at(-1).key, keyNow());
    posted.length = 0;
    wasm.cadaclysm_blacksmith_document_end_preview(page.doc);
    await routed({ kind: "endPreview" });
    assert.strictEqual(keyNow(), committed);
    assert.deepStrictEqual(of(posted, "built").map((m) => [m.id, m.key]), [[1, committed]], "back where the document has it");
    assert.ok(Math.abs(of(posted, "built")[0].table.bounds.centre[0] - 10) < 1e-6);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), saved);
    // A Cancel: the peg taken back on both, and the commit past the head left unnamed on both.
    await run(PEG);
    wasm.cadaclysm_blacksmith_document_undo(page.doc); s.undo(); await s.drain();
    assert.ok(JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(page.doc)).can_redo);
    assert.ok(dropRedo(wasm, page.doc));
    await routed({ kind: "dropRedo" });
    for (const doc of [page.doc, s.doc]) {
        const b = JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(doc));
        assert.ok(!b.can_redo && b.branch === "main" && b.unnamed.length === 1, JSON.stringify(b));
    }
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save(), "the same save after the Cancel");
    assert.ok(!dropRedo(wasm, page.doc), "nothing to drop at the tip");
    page.free();
}

// The crash quarantine: a worker whose kernel traps on the join (a shim that traps once the
// join says it starts) reports the crash naming the node running, and posts no body; a new
// worker opened with that node skipped builds the others and fails the join ("the kernel
// crashed on this node") without trapping. A second trap on a node held already is no new
// culprit (the page counts it against its restarts). An edit that moves the join's key lets
// it go, and the worker told so (`skip`) tries it again -- and traps again.
{
    const TRAP = "i3";
    const shim = { ...wasm,
        cadaclysm_blacksmith_document_evaluate_with: (doc, cheap, report) => {
            const heard = [];
            const out = wasm.cadaclysm_blacksmith_document_evaluate_with(doc, cheap, report ? (...r) => heard.push(r) : undefined);
            for (const r of heard) {
                report(...r);
                if (r[0] === TRAP && r[1] === "start") throw new WebAssembly.RuntimeError("unreachable");
            }
            return out;
        },
    };
    const page = pageDoc();
    page.run(BOX); page.run(PEG); page.run(JOIN);
    const quarantine = createQuarantine();
    const keyOf = () => { const st = page.status(); return (id) => st.get(`i${id}`)?.key ?? null; };
    const worker = async (skip) => {
        const crashes = [], h = harness(null, { wasm: shim, crashed: (c) => crashes.push(c) });
        h.s.open(page.save(), skip); await h.s.drain();
        return { ...h, crashes };
    };
    const first = await worker([]);
    assert.deepStrictEqual(first.crashes.map((c) => [c.id, c.node]), [[3, TRAP]], "the crash names the node running");
    assert.deepStrictEqual(of(first.posted, "built"), [], "and no body is posted");
    assert.ok(quarantine.add(first.crashes[0].node, keyOf()(3)), "a new culprit");
    const second = await worker(quarantine.nodes());
    assert.deepStrictEqual(second.crashes, [], "the skipped join does not trap");
    assert.deepStrictEqual(of(second.posted, "built").map((m) => m.id), [1, 2], "the others build");
    assert.deepStrictEqual(of(second.posted, "failed").map((m) => [m.id, m.error]), [[3, "the kernel crashed on this node"]]);
    assert.ok(!quarantine.add(TRAP, keyOf()(3)), "a trap on a node held already is no new culprit");
    assert.ok(!quarantine.refresh(keyOf()), "nothing moved: the join stays out");
    // The peg made taller: the join's key moves, it leaves the quarantine and is tried again.
    second.s.op(page.run({ op: "set", id: 2, dims: [6, 31] }));
    assert.ok(quarantine.refresh(keyOf()));
    assert.deepStrictEqual(quarantine.nodes(), []);
    second.s.skip(quarantine.nodes()); await second.s.drain();
    assert.deepStrictEqual(second.crashes.map((c) => c.node), [TRAP], "tried again, it traps again");
    // The router passes `open`'s skip and `skip` on.
    const posted = [], s = createForgeScene({ wasm, post: (m) => posted.push(m) });
    const route = createForgeRouter({ scene: s, post: (m) => posted.push(m), ready: Promise.resolve() });
    route({ kind: "open", text: page.save(), skip: ["i1"] });
    await new Promise((r) => setTimeout(r, 0)); await s.drain();
    assert.deepStrictEqual(of(posted, "failed").map((m) => [m.id, m.error]), [[1, "the kernel crashed on this node"], [3, "blocked by Box 1"]]);
    posted.length = 0;
    route({ kind: "skip", nodes: [] });
    await new Promise((r) => setTimeout(r, 0)); await s.drain();
    assert.deepStrictEqual(of(posted, "built").map((m) => m.id).sort(), [1, 3]);
    page.free();
}

// A command that needs built geometry (a face taken without its references) is made an op
// on the worker's evaluated replica (`resolve`), which the page applies and sends back as
// any other: the replicas save the same. A command the document refuses is answered with
// the error.
{
    const { page, s, posted, run } = await pair();
    await run(BOX);
    const face = { op: "face", id: 2, from: 1, face: 1 };
    assert.ok(commandNeedsGeometry(wasm, page.doc, face));
    assert.ok(!commandNeedsGeometry(wasm, page.doc, { op: "set", id: 1, dims: [21, 20, 20] }));
    posted.length = 0;
    s.resolve({ req: 4, cmd: face });
    s.resolve({ req: 5, cmd: { op: "face", id: 3, from: 99, face: 0 } });
    await s.drain();
    const [ok, refused] = of(posted, "resolved");
    assert.strictEqual(ok.req, 4);
    assert.strictEqual(refused.req, 5);
    assert.ok(refused.error && !refused.op, refused.error);
    wasm.cadaclysm_blacksmith_document_apply(page.doc, ok.op, undefined);
    s.op(ok.op); await s.drain();
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(s.doc), page.save(), "the same save");
    assert.ok(itemsNow(page.doc).find((it) => it.id === 2)?.faceRefs?.length === 1, "the face carries its reference");
    page.free();
}

// A fake View that records what it is asked, each show answering a new id; a face colour past the
// solid's face count is refused as the real one refuses it.
function fakeViewer() {
    let next = 1; const calls = [], faces = new Map(); let refused = 0;
    const show = (name, count) => (...args) => { const id = next++; faces.set(id, count?.(...args)); calls.push([name, id, ...args]); return id; };
    return {
        calls, get refused() { return refused; },
        showSolid: show("showSolid", (solid) => wasm.cadaclysm_blacksmith_face_count(solid)),
        showCurves: show("showCurves"), showImage: show("showImage"),
        remove(id) { calls.push(["remove", id]); return true; },
        setColour(id, c) { calls.push(["setColour", id, c]); return true; },
        setFaceColours(id, m) {
            calls.push(["setFaceColours", id, m]);
            if (m && Object.keys(m).some((k) => k >= faces.get(id))) { refused++; throw new Error("face past the count"); }
            return true;
        },
    };
}
const fakeHost = (viewer) => { const dirty = []; return { views: new Map(viewer ? [[VIEW_ID, viewer]] : []), markDirty: (id) => dirty.push(id), dirty }; };
const look = { colour: [0.8, 0.8, 0.8], material: "plastic", opacity: 1 };
const named = (v, n) => v.calls.filter((c) => c[0] === n);
const bodyItem = (id, extra = {}) => ({ key: `body:${id}`, deps: [], kind: "body", body: id, look, ...extra });

// The wanted set: a body shown once, again when rebuilt, never when the list repeats.
{
    const v = fakeViewer(), host = fakeHost(v), { s, run } = await pair(host);
    assert.strictEqual(s.viewer, v, "the viewer getter reads the host");
    await run(BOX);
    s.wanted([bodyItem(1)]);
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["showSolid"]);
    assert.strictEqual(v.calls[0][2], s.solidOf(1), "the kept solid's handle");
    assert.deepStrictEqual(v.calls[0][3], { tolerance: MESH_TOLERANCE, ...look }, "in the page's look");
    assert.ok(host.dirty.length > 0 && host.dirty.every((id) => id === VIEW_ID), "the host is asked for a draw");
    v.calls.length = 0;
    s.wanted([bodyItem(1)]);
    assert.deepStrictEqual(v.calls, [], "the same list again shows nothing");
    // Rebuilt: shown again with no `wanted` from the page; another body's op shows nothing new.
    await run({ op: "set", id: 1, dims: [10, 10, 10] });
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["remove", "showSolid"]);
    assert.deepStrictEqual(s.bodyOfItem(v.calls[1][1]), { body: 1, ghost: false });
    await run(PEG);
    assert.strictEqual(named(v, "showSolid").length, 1, "an unrelated body changes nothing shown");
    assert.strictEqual(s.bodyOfItem(999), null);
    s.wanted([]);
    assert.strictEqual(named(v, "remove").length, 2, "an empty list removes everything");
    assert.strictEqual(s.bodyOfItem(v.calls[1][1]), null);
}
// No View: `wanted` keeps the list; the viewer arriving later is shown it on the next build.
{
    const host = fakeHost(null), { s, run } = await pair(host);
    await run(BOX);
    assert.strictEqual(s.viewer, null);
    s.wanted([bodyItem(1)]);
    const v = fakeViewer(); host.views.set(VIEW_ID, v);
    await run({ op: "set", id: 1, dims: [10, 10, 10] });
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["showSolid"]);
    assert.strictEqual(harness().s.viewer, null, "no host at all");
}
// A trim's ghost shows the dropped faces -- the split pieces, under the trim's move -- in the
// ghost colour; isocurves are made when shown, and both are shown again when their body is
// rebuilt (the worker adds the version to deps).
{
    const page = pageDoc(readFileSync(join(repo, "examples/sheet-trim.json"), "utf8"));
    const v = fakeViewer(), counter = countingFrees(), { s, posted } = harness(fakeHost(v), { wasm: counter.wasm });
    s.open(page.save()); await s.drain();
    const run = async (cmd) => { s.op(page.run(cmd)); await s.drain(); };
    assert.deepStrictEqual(of(posted, "built").map((m) => [m.id, m.ghostFaces]), [[2, 0], [4, 1]]);
    s.wanted([
        { key: "ghost:4", deps: [], kind: "ghost", body: 4 },
        { key: "iso:2", deps: [], kind: "isocurves", body: 2, colour: [0.5, 0.5, 0.5] },
    ]);
    const ghost = named(v, "showSolid")[0];
    assert.deepStrictEqual(Array.from(ghost[3].faces), [0], "the drop is the ghost's faces, by the split's B-rep index");
    assert.deepStrictEqual(Array.from(ghost[3].colour), [0.26, 0.26, 0.25]);
    assert.strictEqual(wasm.cadaclysm_blacksmith_face_count(ghost[2]), 2, "the ghost is both pieces");
    assert.deepStrictEqual(s.bodyOfItem(ghost[1]), { body: 4, ghost: true, faces: [0] });
    // The page keys a ghost's face colours by the place in `drop`; the View gets the split's faces.
    s.wanted([
        { key: "ghost:4", deps: [], kind: "ghost", body: 4, faceColours: { 0: [1, 0, 0] } },
        { key: "iso:2", deps: [], kind: "isocurves", body: 2, colour: [0.5, 0.5, 0.5] },
    ]);
    assert.deepStrictEqual(named(v, "setFaceColours").at(-1)[2], { 0: [1, 0, 0] });
    const iso = named(v, "showCurves")[0];
    assert.ok(iso[2] instanceof Float64Array && Array.from(iso[3]).join() === "0.5,0.5,0.5", "the isocurves (none on a flat sheet), in their colour");
    // Moved, the ghost moves with the trim.
    v.calls.length = 0;
    await run({ op: "set", id: 4, transform: { tx: 7, ty: 0, angle: 0, scale: 1 } });
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["remove", "showSolid"], "the ghost follows a rebuild");
    const gb = wasm.cadaclysm_blacksmith_bounds(v.calls[1][2], MESH_TOLERANCE);
    assert.ok(Math.abs((gb[0] + gb[3]) / 2 - 7) < 1e-4, `the ghost moved with the trim: x centre ${(gb[0] + gb[3]) / 2}`);
    v.calls.length = 0;
    await run({ op: "set", id: 2, shape: undefined, hidden: true });   // not the sheet's geometry: nothing rebuilt
    assert.deepStrictEqual(v.calls, []);
    // The ghost's solid is freed when the body goes, with the body's.
    counter.frees = 0;
    await run({ op: "delete", ids: [4] });
    assert.strictEqual(counter.frees, 2, "the body and its ghost");
    page.free();
}
// Sketch curves: floats come once per key and are kept here; a curve left out of the list and
// shown again (the page's sender sends its floats again) still shows. Images wait for their bitmap.
{
    const v = fakeViewer(), { s } = harness(fakeHost(v));
    const sender = createWantedSender((m) => s.wanted(m.items));
    const curve = { key: "curve:1", deps: [3], kind: "curves", colour: [1, 0, 0] };
    const floats = new Float32Array(16).fill(2);
    sender.send([curve], () => ({ beziers: floats }));
    assert.deepStrictEqual(v.calls.map((c) => [c[0], Array.from(c[2])[0]]), [["showCurves", 2]]);
    sender.send([curve], () => ({ beziers: floats }));
    assert.strictEqual(v.calls.length, 1, "the same list: nothing");
    sender.send([], null);
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["showCurves", "remove"]);
    sender.send([curve], () => ({ beziers: floats }));
    assert.strictEqual(named(v, "showCurves").length, 2, "hidden, then shown again, the floats there");
    const shown = named(v, "showCurves").length;
    s.wanted([]); s.wanted([curve]);
    assert.strictEqual(named(v, "showCurves").length, shown, "no stale floats for a key that left");
    assert.doesNotThrow(() => s.wanted([{ ...curve, key: "curve:9" }]));
    const image = { key: "image:1", deps: [0], kind: "image", image: 1, corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], opacity: 0.5, flipX: false, flipY: true };
    v.calls.length = 0;
    s.wanted([image]);
    assert.deepStrictEqual(v.calls, [], "no bitmap yet, nothing shown");
    const px = { close() {} };
    s.bitmap({ id: 1, bitmap: px });
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["showImage"]);
    assert.strictEqual(v.calls[0][2].bitmap, px); assert.strictEqual(v.calls[0][2].opacity, 0.5); assert.strictEqual(v.calls[0][2].flipY, true);
    const closed = [];
    const px2 = { close() { closed.push("px2"); } };
    px.close = () => closed.push("px");
    s.bitmap({ id: 1, bitmap: px2 });
    assert.deepStrictEqual(v.calls.slice(1).map((c) => c[0]), ["remove", "showImage"]);
    assert.deepStrictEqual(closed, ["px"], "the replaced bitmap is closed");
    const early = { close() { closed.push("early"); } };
    s.bitmap({ id: 2, bitmap: early });
    s.wanted([image]);
    assert.deepStrictEqual(closed, ["px"], "an early bitmap is not pruned by the list before the one naming it");
    s.wanted([image, { ...image, key: "image:2", image: 2 }]);
    assert.strictEqual(named(v, "showImage").length, 3, "and the list naming it finds it");
    s.wanted([image]);
    assert.deepStrictEqual(closed, ["px", "early"], "an unnamed bitmap is closed at the next list");
    s.wanted([]);
    assert.deepStrictEqual(closed, ["px", "early", "px2"]);
}
// F8: a selected body's tint colours every face; a rebuild with fewer faces must not replay the
// old colours into the new solid.
{
    const v = fakeViewer(), { s, run } = await pair(fakeHost(v));
    await run(BOX, { op: "fillet", id: 2, source: 1, radius: 2, style: "round" }, { op: "set", id: 2, edges: [0, 1, 2, 3] });
    const many = bodyTable(wasm, s.solidOf(2)).faceKinds.length;
    const tint = {}; for (let k = 0; k < many; k++) tint[k] = [1, 0.5, 0];
    s.wanted([bodyItem(2, { faceColours: tint })]);
    assert.strictEqual(named(v, "setFaceColours").length, 1);
    await run({ op: "set", id: 2, edges: [0] });
    assert.ok(bodyTable(wasm, s.solidOf(2)).faceKinds.length < many, "the rebuilt fillet has fewer faces");
    assert.strictEqual(v.refused, 0, "no stale face colour reached the new solid");
    assert.deepStrictEqual(named(v, "showSolid").length, 2, "and the rebuilt body is shown");
    s.wanted([bodyItem(2, { faceColours: { 0: [1, 0, 0] } })]);
    assert.strictEqual(v.refused, 0); assert.strictEqual(named(v, "setFaceColours").length, 2);
}
// Exports: the same bytes as `cadaclysm_blacksmith_mesh_file` over the same solids, text when
// asked; the triangles the kernel's mesh of them at the same tolerance.
{
    const { s, posted, run } = await pair();
    await run(BOX, PEG);
    const both = Uint32Array.of(s.solidOf(1), s.solidOf(2));
    s.exportFile({ req: 9, format: "stl", ids: [1, 2], names: { 1: "Solid 1", 2: "Solid 2" }, looks: {}, text: false, tolerance: 0.02 });
    const out = posted.at(-1);
    assert.deepStrictEqual(Array.from(out.bytes), Array.from(wasm.cadaclysm_blacksmith_mesh_file(both, "stl", undefined, undefined, 0.02)));
    assert.strictEqual(out.kind, "exported"); assert.strictEqual(out.bodies, 2);
    assert.strictEqual(out.triangles, new DataView(out.bytes.buffer, out.bytes.byteOffset).getUint32(80, true), "the STL's own triangle count");
    s.exportFile({ req: 10, format: "stl", ids: [1], names: { 1: "Solid 1", file: "plate" }, looks: {}, text: true, tolerance: 0.02 });
    assert.ok(new TextDecoder().decode(posted.at(-1).bytes).startsWith("solid plate"), "ascii stl when text");
    s.exportFile({ req: 11, format: "glb", ids: [1, 2], names: { 1: "A", 2: "B", file: "forge" }, looks: { 1: [1, 0, 0, 1, 0, 0.5], 2: [0, 1, 0, 1, 1, 0.3] }, text: false, tolerance: 0.02 });
    assert.deepStrictEqual(Array.from(posted.at(-1).bytes), Array.from(wasm.cadaclysm_blacksmith_mesh_file(both, "glb", ["A", "B"], [1, 0, 0, 1, 0, 0.5, 0, 1, 0, 1, 1, 0.3], 0.02)));
    s.exportFile({ req: 14, format: "glb", ids: [1], names: { 1: "A" }, looks: {}, text: true, tolerance: 0.02 });
    assert.ok(new TextDecoder().decode(posted.at(-1).bytes).trimStart().startsWith("{"), "glTF text when text");
    s.exportFile({ req: 12, format: "obj", ids: [1], names: { 1: "A" }, looks: {}, text: false, tolerance: 0.02 });
    assert.ok(new TextDecoder().decode(posted.at(-1).bytes).includes("v "), "obj is text");
    s.exportFile({ req: 13, format: "stl", ids: [99], names: {}, looks: {}, text: false, tolerance: 0.02 });
    assert.deepStrictEqual([posted.at(-1).kind, posted.at(-1).req], ["exportFailed", 13]);
}
// The solid frees: none for an unchanged body, one on a replace, none on a failure, one on removal.
{
    const counter = countingFrees();
    const { s, run } = await pair(null, { wasm: counter.wasm });
    await run(BOX, { op: "fillet", id: 2, source: 1, radius: 2, style: "round" }, { op: "set", id: 2, edges: [0] });
    counter.frees = 0;
    await run({ op: "set", id: 2, name: "Rounded" }); assert.strictEqual(counter.frees, 0, "nothing rebuilt");
    await run({ op: "set", id: 2, radius: 3 }); assert.strictEqual(counter.frees, 1, "replace");
    await run({ op: "set", id: 2, radius: 500 }); assert.strictEqual(counter.frees, 1, "failed");
    await run({ op: "delete", ids: [2] }); assert.strictEqual(counter.frees, 2, "removed");
}
// The router: a handler that throws is answered and the next message still works.
{
    const page = pageDoc(), { s, posted } = harness();
    const route = createForgeRouter({ scene: s, post: (m) => posted.push(m), ready: Promise.resolve() });
    route({ kind: "op", op: "{" });   // no op: refused by the replica
    route({ kind: "open", text: "{\"format\": \"nothing\"}" });
    route({ kind: "open", text: page.save() });
    route({ kind: "op", op: page.run(BOX) });
    route({ kind: "pick", req: 3, id: 1, what: "verts", indices: [0] });
    await new Promise((r) => setTimeout(r, 20)); await s.drain();
    assert.deepStrictEqual(posted.filter((m) => m.kind !== "progress").map((m) => [m.kind, m.what ?? m.id ?? m.req]), [["opFailed", "op"], ["opFailed", "open"], ["built", 1], ["picked", 3]]);
    assert.ok(/verts/.test(posted.at(-1).error));
    const dead = createForgeRouter({ scene: s, post: (m) => posted.push(m), ready: Promise.reject(new Error("no wasm")) });
    dead({ kind: "op", op: page.run(PEG) }); dead({ kind: "export", req: 8, format: "stl", ids: [1] }); dead({ kind: "pick", req: 9, id: 1, what: "faces", indices: [0] });
    await new Promise((r) => setTimeout(r, 20));
    const tail = posted.slice(-3);
    assert.deepStrictEqual(tail.map((m) => m.kind), ["opFailed", "exportFailed", "picked"]); assert.ok(/did not start/.test(tail[0].error));
    page.free();
}
// The router carries wanted and bitmap to the scene and every view.* to the host, in order;
// a trap is answered with crashed beside the usual answer.
{
    const seen = [];
    const scene = { wanted: (items) => seen.push(["wanted", items]), bitmap: (m) => seen.push(["bitmap", m.id]), undo: () => { throw new WebAssembly.RuntimeError("unreachable"); } };
    const host = { handle: (m) => seen.push([m.kind, m.id]) };
    const posted = [];
    const route = createForgeRouter({ scene, host, post: (m) => posted.push(m), ready: Promise.resolve() });
    route({ kind: "view.create", id: VIEW_ID });
    route({ kind: "wanted", items: [{ key: "a" }] });
    route({ kind: "bitmap", id: 4, bitmap: {} });
    route({ kind: "view.input", id: VIEW_ID });
    route({ kind: "undo" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(seen, [["view.create", VIEW_ID], ["wanted", [{ key: "a" }]], ["bitmap", 4], ["view.input", VIEW_ID]]);
    assert.deepStrictEqual(posted.map((m) => m.kind), ["opFailed", "crashed"], "a trap is a crash too");
    assert.ok(/unreachable/.test(posted[1].message));
}
// Traps: an evaluation that traps is one `crashed` naming the body whose node was reporting
// (no `failed`, nothing built); a trap in the resync after a build is `built` once and
// `crashed` once, never `built` then `failed`.
{
    const page = pageDoc(), empty = page.save();
    const ops = [BOX, PEG, JOIN].map((c) => page.run(c));
    // The kernel traps mid-join, after the join's node has reported.
    const trapping = { ...wasm, cadaclysm_blacksmith_document_evaluate_with: (doc, cheap, report) => {
        if (!cheap && report) { report("i3_inner", "meshing", 0, 1); throw new WebAssembly.RuntimeError("unreachable"); }
        return wasm.cadaclysm_blacksmith_document_evaluate_with(doc, cheap, report);
    } };
    const crashes = [];
    const { s, posted } = harness(null, { wasm: trapping, crashed: (c) => crashes.push(c) });
    s.open(empty); for (const op of ops) s.op(op);
    await s.drain();
    assert.deepStrictEqual(posted.filter((m) => m.kind !== "progress"), [], "a trap builds nothing and is not failed");
    assert.deepStrictEqual(crashes.map((c) => c.id), [3], "one crash, naming the body reporting");
    assert.ok(/unreachable/.test(crashes[0].message));
    page.free();
}
{
    const trap = () => { throw new WebAssembly.RuntimeError("unreachable"); };
    const viewer = new Proxy({}, { get: () => trap });
    const crashes = [];
    const { s, posted, run } = await pair({ views: { get: () => viewer }, markDirty() {} }, { crashed: (c) => crashes.push(c) });
    s.wanted([{ key: "k", deps: [], kind: "body", body: 1, look: {} }]);
    await run(BOX);
    assert.deepStrictEqual(posted.filter((m) => m.kind === "built" || m.kind === "failed").map((m) => m.kind), ["built"], "built once, never failed");
    assert.deepStrictEqual(crashes.map((c) => c.id), [1], "and one crash");
}
console.log("forge-scene: ok");
