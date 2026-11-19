// The forge's picks (forge-picks.js) over the kernel's public document exports: references
// to a body's faces and edges that find them again, a pick off a document node, the geometry
// env a command asks (item `n`'s body through the model, a held body its own node), and the
// frames faces take as planes -- off ONE `document_probe` of `frame.on_face` nodes
// `f<b>_<k>`, the same frames the 0.14 layer's preview gave, the document's revision and
// save text untouched, the probe ended also when a read throws.
//
// Run: node test/forge-picks.mjs   (after npm run setup)
import assert from "node:assert";
import { loadWasm } from "./package.mjs";
import { Model } from "../forge-model.js";
import { faceRefOf, edgeRefOf, pickRefs, documentPickRefs, docPicks, bodyNode, faceFrames } from "../forge-picks.js";
import { faceFrames as oldFaceFrames, docPicks as oldDocPicks } from "../forge-doc-convert.js";

const wasm = await loadWasm();

const apply = (doc, op) => JSON.parse(wasm.cadaclysm_blacksmith_document_apply(doc, JSON.stringify(op), undefined));
const evaluate = (doc) => JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, false));
const save = (doc) => wasm.cadaclysm_blacksmith_document_save(doc);
const revision = (doc) => wasm.cadaclysm_blacksmith_document_revision(doc);
const faceCount = (s) => wasm.cadaclysm_blacksmith_face_count(s);

// `f` with node `id`'s solid handle, freed after.
function withSolid(doc, id, f) {
    const s = wasm.cadaclysm_blacksmith_document_result_solid(doc, id);
    try { return f(s); } finally { wasm.cadaclysm_blacksmith_solid_free(s); }
}

// The kernel with its calls counted.
function counted(over = {}) {
    const calls = [];
    const k = {};
    for (const [name, fn] of Object.entries(wasm)) {
        k[name] = typeof fn !== "function" ? fn : (...args) => {
            calls.push(name.replace(/^cadaclysm_blacksmith_/, ""));
            return (over[name] ?? fn)(...args);
        };
    }
    return { k, of: (what) => calls.filter((c) => c === what).length };
}

// A document in the 0.15 layout: a box (#1), a cylinder turned and slid in the world (#2,
// its verb `i2_inner`), the box with two edges rounded and moved (#3), and another app's
// shown plate (a held item).
function sample() {
    const doc = wasm.cadaclysm_blacksmith_document_new("mm");
    apply(doc, { op: "batch", ops: [
        { op: "add", node: { id: "plate", kind: "solid.cuboid", x: 12, y: 6, z: 2, at: [0, 0, -20], meta: { show: true } } },
        { op: "add", node: { id: "i1", kind: "solid.cuboid", x: 10, y: 20, z: 30, meta: { forge: { kind: "box" } } } },
        { op: "add", node: { id: "i2_inner", kind: "solid.cylinder", r: 5, h: 8 } },
        { op: "add", node: { id: "i2", kind: "solid.transform", solid: "i2_inner", pivot: [1, 2, 3], turn_in: "world", turn: [30, 45, 10], by_in: "world", by: [3, 4, 5], meta: { forge: { kind: "cylinder" } } } },
    ] });
    evaluate(doc);
    const edges = withSolid(doc, "i1", (s) => pickRefs(wasm, s, false, [0, 3]));
    apply(doc, { op: "batch", ops: [
        { op: "add", node: { id: "i3_inner", kind: "solid.fillet", solid: "i1", edges, radius: 2 } },
        { op: "add", node: { id: "i3", kind: "solid.transform", solid: "i3_inner", pivot: [0, 0, 0], turn_in: "world", turn: [0, 0, 60], by_in: "world", by: [40, 0, 0], meta: { forge: { kind: "fillet", edges: [0, 3] } } } },
    ] });
    evaluate(doc);
    return doc;
}

// References: each finds its face or edge again; an index the solid has none at is refused
// in words, as a kind that is neither faces nor edges.
{
    const doc = sample();
    withSolid(doc, "i1", (s) => {
        assert.strictEqual(faceCount(s), 6);
        const refs = pickRefs(wasm, s, true, [0, 1, 2, 3, 4, 5]);
        refs.forEach((r, k) => {
            const a = Float64Array.from([r.surface, ...r.at, ...r.normal, r.extent]);
            assert.strictEqual(wasm.cadaclysm_blacksmith_find_face(s, a, -1, 1e-6), k, `face ${k} found again by its reference`);
        });
        assert.deepStrictEqual(faceRefOf(wasm, s, 2), refs[2]);
        const e = edgeRefOf(wasm, s, 5);
        assert.deepStrictEqual(Object.keys(e), ["curve", "mid", "tangent", "length", "faces", "span"]);
        assert.ok(Math.abs(e.length - [10, 20, 30].find((l) => Math.abs(l - e.length) < 1e-9)) < 1e-9, `a box edge is one of its sides: ${e.length}`);
        assert.throws(() => faceRefOf(wasm, s, 6), /face 6 is not on the solid/);
        assert.throws(() => edgeRefOf(wasm, s, 12), /edge 12 is not on the solid/);
    });
    // Off a node: the document evaluated first, then the node's solid.
    assert.deepStrictEqual(documentPickRefs(wasm, doc, "i3", "edges", [0, 1]), withSolid(doc, "i3", (s) => pickRefs(wasm, s, false, [0, 1])));
    assert.throws(() => documentPickRefs(wasm, doc, "i1", "vertices", [0]), /kind `vertices` is not `edges` or `faces`/);
    assert.throws(() => documentPickRefs(wasm, doc, "i9", "faces", [0]), /`i9` has no solid/);
    // forge-doc-convert.js hands out the very same functions.
    const old = oldDocPicks(wasm, doc);
    assert.strictEqual(typeof old.sourcePivot, "function", "the 0.14 env keeps its pivot");
    assert.deepStrictEqual(old.edgeRef(3, 2), docPicks(wasm, doc).edgeRef(3, 2));
    assert.throws(() => old.faceFrame(1, 0), /frame\.on_face/);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// The env over the model: item `n`'s body is `i<n>`, a held item's its own node; an item the
// model lacks, or one not built, is refused by number.
{
    const doc = sample();
    const model = new Model(wasm, doc);
    const held = model.items().find((it) => it.kind === "held");
    assert.ok(held && held.node === "plate");
    assert.strictEqual(bodyNode(model, 2), "i2");
    assert.strictEqual(bodyNode(model, held.id), "plate");
    assert.strictEqual(bodyNode(model, 77), undefined);
    assert.strictEqual(bodyNode(undefined, 77), "i77");
    const env = docPicks(wasm, doc, model);
    assert.deepStrictEqual(env.faceRef(held.id, 1), documentPickRefs(wasm, doc, "plate", "faces", [1])[0]);
    assert.deepStrictEqual(env.edgeRef(2, 0), documentPickRefs(wasm, doc, "i2", "edges", [0])[0]);
    assert.throws(() => env.faceRef(77, 0), /#77 is not an item/);
    // A face frame through the probe; a curved face has none.
    const top = env.faceFrame(1, 0);
    assert.strictEqual(top.length, 12);
    const side = withSolid(doc, "i2", (s) => [...Array(faceCount(s)).keys()].find((k) => wasm.cadaclysm_blacksmith_face_ref(s, k)[0] !== 0));
    assert.throws(() => env.faceFrame(2, side), new RegExp(`face ${side} of #2 has no frame`));
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// Face frames: per face of each body, the frame the 0.14 layer's preview gave (to 1e-9),
// a curved face null, off ONE probe for every body, which is ended. The document's
// revision and save text are as they were.
{
    const doc = sample();
    const model = new Model(wasm, doc);
    const held = model.items().find((it) => it.kind === "held").id;
    const bodies = [[1, "i1"], [2, "i2"], [3, "i3"], [held, "plate"]];
    const wanted = [], expected = [];
    for (const [b, id] of bodies) {
        withSolid(doc, id, (s) => {
            const faces = [...Array(faceCount(s)).keys()];
            const old = oldFaceFrames(wasm, doc, id, s, faces);
            faces.forEach((k) => { wanted.push({ body: b, face: k }); expected.push(old[k]); });
        });
    }
    assert.ok(expected.filter(Boolean).length >= 6 + 2 + 6 + 6, "the old frames: every flat face");
    assert.ok(expected.some((f) => f === null), "and the cylinder's side and the fillets' rounds have none");
    const rev = revision(doc), text = save(doc);
    const c = counted();
    const frames = faceFrames(c.k, doc, model, wanted);
    assert.strictEqual(c.of("document_probe"), 1, "one probe for every frame");
    assert.strictEqual(c.of("document_probe_end"), 1, "and it is ended");
    assert.strictEqual(c.of("document_evaluate"), 0, "an evaluated document is not evaluated again");
    assert.strictEqual(frames.length, wanted.length);
    frames.forEach((f, i) => {
        const e = expected[i], w = JSON.stringify(wanted[i]);
        if (e === null) return assert.strictEqual(f, null, `${w}: no frame`);
        assert.ok(f && f.length === 12, `${w}: a frame`);
        f.forEach((x, j) => assert.ok(Math.abs(x - e[j]) < 1e-9, `${w}[${j}]: ${x} vs ${e[j]}`));
    });
    // A turned body's frame is turned: the cylinder's top is not the world's z.
    const cylTop = frames[wanted.findIndex((w) => w.body === 2 && expected[wanted.indexOf(w)] !== null)];
    assert.ok(Math.abs(cylTop[11]) < 0.999, `the cylinder's caps lean: ${cylTop.slice(9)}`);
    assert.strictEqual(revision(doc), rev, "the revision is as it was");
    assert.strictEqual(save(doc), text, "the save text is as it was");
    // The probe is over: the document takes a change again, and the frames come again.
    assert.deepStrictEqual(faceFrames(wasm, doc, model, wanted), frames);
    apply(doc, { op: "set", id: "i1", fields: { z: 31 } });
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// A face plane the document has already (`f1_2`) is set in the probe, not added: the frame
// is face 2's of the box as it is now, also after the box changed under the node's old
// reference; the document keeps its own node. Duplicates and a face off the solid.
{
    const doc = sample();
    const ref = withSolid(doc, "i1", (s) => faceRefOf(wasm, s, 2));
    apply(doc, { op: "add", node: { id: "f1_2", kind: "frame.on_face", solid: "i1", face: ref } });
    apply(doc, { op: "set", id: "i1", fields: { y: 26 } });   // face 2 (-y) moves off its old reference
    evaluate(doc);
    const model = new Model(wasm, doc);
    const before = JSON.stringify(model.node("f1_2")), text = save(doc);
    const old = withSolid(doc, "i1", (s) => oldFaceFrames(wasm, doc, "i1", s, [2, 0]));
    let probed;
    const c = counted({ cadaclysm_blacksmith_document_probe: (d, op, ids) => { probed = [JSON.parse(op), JSON.parse(ids)]; return wasm.cadaclysm_blacksmith_document_probe(d, op, ids); } });
    const frames = faceFrames(c.k, doc, model, [{ body: 1, face: 2 }, { body: 1, face: 0 }, { body: 1, face: 2 }, { body: 1, face: 40 }]);
    const now = withSolid(doc, "i1", (s) => faceRefOf(wasm, s, 2));
    assert.deepStrictEqual(probed[1], ["f1_2", "f1_0"], "each face plane once");
    assert.deepStrictEqual(probed[0].ops[0], { op: "set", id: "f1_2", fields: { solid: "i1", face: now } }, "the node there is set to the face as it is now");
    assert.strictEqual(probed[0].ops[1].op, "add");
    assert.deepStrictEqual(frames[0], frames[2], "a face asked twice gives its frame twice");
    assert.strictEqual(frames[3], null, "a face off the solid has none");
    [0, 1].forEach((i) => frames[i].forEach((x, j) => assert.ok(Math.abs(x - old[i][j]) < 1e-9)));
    assert.strictEqual(save(doc), text);
    assert.strictEqual(JSON.stringify(JSON.parse(wasm.cadaclysm_blacksmith_document_nodes(doc, JSON.stringify(["f1_2"])))[0]), before);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// Solids handed in are read instead of the document's; a document not evaluated yet is
// evaluated once. A read that throws inside the probe still ends it; a probe the kernel
// refuses (a preview open) is thrown and ends nothing.
{
    const doc = sample();
    const model = new Model(wasm, doc);
    const handle = wasm.cadaclysm_blacksmith_document_result_solid(doc, "i1");
    const c = counted();
    const given = faceFrames(c.k, doc, model, [{ body: 1, face: 1 }], new Map([[1, handle]]));
    assert.strictEqual(c.of("document_result_solid"), 0, "the handed-in solid is read");
    assert.deepStrictEqual(given, faceFrames(wasm, doc, model, [{ body: 1, face: 1 }]));
    wasm.cadaclysm_blacksmith_solid_free(handle);

    const fresh = wasm.cadaclysm_blacksmith_document_load(save(doc));
    const c2 = counted();
    const late = faceFrames(c2.k, fresh, new Model(wasm, fresh), [{ body: 1, face: 1 }, { body: 2, face: 0 }]);
    assert.strictEqual(c2.of("document_evaluate"), 1, "an unevaluated document is evaluated once");
    assert.deepStrictEqual(late[0], given[0]);
    wasm.cadaclysm_blacksmith_document_free(fresh);

    const boom = counted({ cadaclysm_blacksmith_document_value: () => { throw new Error("boom"); } });
    assert.deepStrictEqual(faceFrames(boom.k, doc, model, [{ body: 1, face: 1 }]), [null], "a value that throws is no frame");
    assert.strictEqual(boom.of("document_probe_end"), 1);
    const parse = counted({ cadaclysm_blacksmith_document_probe_end: (d) => wasm.cadaclysm_blacksmith_document_probe_end(d) });
    const badJson = { ...parse.k, cadaclysm_blacksmith_document_value: () => "[1,2" };
    assert.deepStrictEqual(faceFrames(badJson, doc, model, [{ body: 1, face: 1 }]), [null]);
    assert.strictEqual(parse.of("document_probe_end"), 1);
    apply(doc, { op: "set", id: "i1", fields: { z: 32 } });

    wasm.cadaclysm_blacksmith_document_preview_begin(doc);
    const busy = counted();
    assert.throws(() => faceFrames(busy.k, doc, model, [{ body: 1, face: 1 }]), /./);
    assert.strictEqual(busy.of("document_probe_end"), 0, "a refused probe ends nothing");
    wasm.cadaclysm_blacksmith_document_end_preview(doc);
    assert.throws(() => faceFrames(wasm, doc, model, [{ body: 77, face: 0 }]), /#77 is not an item/);
    assert.deepStrictEqual(faceFrames(wasm, doc, model, []), []);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

console.log("forge-picks: ok");
