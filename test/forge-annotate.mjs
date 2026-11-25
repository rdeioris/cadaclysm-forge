// Annotate (forge-commands.js `annotate`): an Annotations item stands in for a solid, each
// of its PMI entries a `solid.pmi` node chained on the solid; the entries stay on their
// faces through a later cut and fillet, keep through a save and an open, are edited and
// deleted by `set`, and a STEP export of the last body writes them as AP242 -- read back
// by the package's own reader. Skipped (and says so) on a package without PMI.
//
// Run: node test/forge-annotate.mjs   (after npm run setup)
import assert from "node:assert";
import { loadWasm } from "./package.mjs";
import { Model, UNITS, openDocument } from "../forge-model.js";
import { command, readItem, Draft } from "../forge-commands.js";
import { hasPmi, pmiOf } from "../forge-scene.js";

const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
if (!hasPmi(wasm)) {
    console.log("skip: this package has no PMI (the Annotate tool hides itself)");
    process.exit(0);
}

function over(doc) {
    const model = new Model(wasm, doc);
    const run = (cmd) => {
        wasm[K + "document_evaluate"](doc, false);
        return command(wasm, model, doc, cmd);
    };
    const nodes = () => JSON.parse(wasm[K + "document_nodes"](doc, null));
    const node = (id) => nodes().find((n) => n.id === id);
    const item = (n) => readItem(new Draft(model), n);
    const statusOf = (id) => JSON.parse(wasm[K + "document_evaluate"](doc, false)).find((s) => s.id === id);
    // A body node's PMI, as the worker's table carries it.
    const pmi = (id) => {
        wasm[K + "document_evaluate"](doc, false);
        const s = wasm[K + "document_result_solid"](doc, id);
        try { return pmiOf(wasm, s); } finally { wasm[K + "solid_free"](s); }
    };
    // Face `f` of a body node's solid: its outward normal at its reference point.
    const normalOf = (id, f) => {
        const s = wasm[K + "document_result_solid"](doc, id);
        try { return Array.from(wasm[K + "face_ref"](s, f)).slice(4, 7).map((v) => Math.round(v * 1e9) / 1e9 + 0); } finally { wasm[K + "solid_free"](s); }
    };
    return { doc, model, run, nodes, node, item, statusOf, pmi, normalOf };
}

const fresh = () => over(wasm[K + "document_new"](UNITS));
// The face of body node `id` facing `n`.
function facing(t, id, n) {
    wasm[K + "document_evaluate"](t.doc, false);
    const s = wasm[K + "document_result_solid"](t.doc, id);
    try {
        for (let f = 0; f < wasm[K + "face_count"](s); f++) {
            const r = wasm[K + "face_ref"](s, f);
            if (r[0] === 0 && Math.abs(r[4] - n[0]) < 1e-9 && Math.abs(r[5] - n[1]) < 1e-9 && Math.abs(r[6] - n[2]) < 1e-9) return f;
        }
    } finally { wasm[K + "solid_free"](s); }
    throw new Error(`no face of ${id} facing ${n}`);
}
const UP = [0, 0, 1], DOWN = [0, 0, -1];
// Each item's kind and the normals of the faces it stands on (a body node's PMI).
// The kernel lists an item's targets by face index, so they are compared as a set of
// (normal, side), sorted.
const onFaces = (t, id) => t.pmi(id).map((p) => [p.kind, p.targets.filter((x) => x.element === "face").map((x) => [...t.normalOf(id, x.index), x.side]).sort((a, b) => a.join() < b.join() ? -1 : 1)]);

// The bracket: a plate, annotated -- datum A under it, its top flat to 0.05 against A, its
// height 10 +0.1/-0.1 from A, and a note on the whole part.
const t = fresh();
t.run({ op: "primitive", id: 1, kind: "box", plane: "top", dims: [40, 20, 10] });
const [top, bottom] = [facing(t, "i1", UP), facing(t, "i1", DOWN)];
t.run({ op: "annotate", id: 2, source: 1 });
assert.strictEqual(t.node("i1").hidden, true, "the solid hides behind its annotations");
assert.deepStrictEqual([t.node("i2").kind, t.node("i2").solid], ["solid.transform", "i1"], "no entry: the solid passed through");
const entries = [
    { item: "datum", faces: [bottom], edges: [], label: "A" },
    { item: "tolerance", faces: [top], edges: [], type: "flatness", value: 0.05, datums: "A", modifiers: "" },
    { item: "dimension", faces: [bottom, top], edges: [], type: "linear_distance", value: 10, lower: -0.1, upper: 0.1, origin: 1 },
    { item: "note", faces: [], edges: [], text: "Break sharp edges" },
];
t.run({ op: "set", id: 2, pmi: entries });
// The chain: one `solid.pmi` an entry, the first on the solid, the last the item's head.
assert.deepStrictEqual(t.nodes().filter((n) => /^i2(_|$)/.test(n.id)).map((n) => [n.id, n.kind, n.solid, n.item]), [
    ["i2_pmi0", "solid.pmi", "i1", "datum"], ["i2_pmi1", "solid.pmi", "i2_pmi0", "tolerance"], ["i2_pmi2", "solid.pmi", "i2_pmi1", "dimension"], ["i2", "solid.pmi", "i2_pmi2", "note"],
]);
assert.strictEqual(t.statusOf("i2").state, "ok");
// The item reads back: its parts and entries (references resolved off the solid, kept).
const back = t.item(2);
assert.deepStrictEqual([back.kind, back.parts, back.pmi.length, back.pmi[0].faceRefs.length, back.pmi[2].faceRefs.length], ["annotate", [1], 4, 1, 2]);
const annotated = onFaces(t, "i2");
// The dimension runs from the bottom (its origin, side 0) to the top (side 1).
assert.deepStrictEqual(annotated, [["datum", [[...DOWN, 0]]], ["tolerance", [[...UP, 0]]], ["dimension", [[...DOWN, 0], [...UP, 1]]], ["note", []]]);
const dim = t.pmi("i2")[2];
assert.deepStrictEqual([dim.type, dim.value, dim.lower, dim.upper], ["linear_distance", 10, -0.1, 0.1]);

// A hole cut through the annotated top, then a round on an edge: every item rides on its face.
t.run({ op: "primitive", id: 3, kind: "cylinder", plane: "top", dims: [3, 30] });
t.run({ op: "cut", id: 4, parts: [2, 3] });
assert.strictEqual(t.statusOf("i4").state, "ok");
assert.deepStrictEqual(onFaces(t, "i4"), annotated, "the cut keeps every item on its faces");
t.run({ op: "fillet", id: 5, source: 4, radius: 2, style: "round" });
t.run({ op: "set", id: 5, edges: [0] });
assert.strictEqual(t.statusOf("i5").state, "ok");
assert.deepStrictEqual(onFaces(t, "i5"), annotated, "the fillet keeps every item on its faces");

// Saved and opened again: the same entries, built the same.
const saved = wasm[K + "document_save"](t.doc);
const u = over(openDocument(wasm, saved));
assert.deepStrictEqual(u.item(2).pmi, t.item(2).pmi);
assert.deepStrictEqual(onFaces(u, "i5"), annotated);

// Edited (the zone tightened) and deleted (the note): one `set` each.
const edited = t.item(2).pmi.slice(0, 3);
edited[1] = { ...edited[1], value: 0.02 };
t.run({ op: "set", id: 2, pmi: edited });
assert.deepStrictEqual(t.pmi("i5").map((p) => p.kind), ["datum", "tolerance", "dimension"]);
assert.strictEqual(t.pmi("i5")[1].value, 0.02);
// A bad entry (a tolerance naming a datum the part has not) is the item's error, in the kernel's words.
t.run({ op: "set", id: 2, pmi: [...edited, { item: "tolerance", faces: [top], edges: [], type: "position", value: 0.1, datums: "B" }] });
assert.match(t.statusOf("i2").error ?? "", /datum "B" is not defined/);
t.run({ op: "set", id: 2, pmi: entries });

// STEP: the last body written as the forge's export writes one (named, then `step`), AP242,
// read back by the package's reader with its four items.
wasm[K + "document_evaluate"](t.doc, false);
const solid = wasm[K + "document_result_solid"](t.doc, "i5");
const named = wasm[K + "named"](solid, "Bracket");
const step = wasm[K + "step"](Uint32Array.of(named), undefined, 1);
wasm[K + "solid_free"](named);
wasm[K + "solid_free"](solid);
assert.match(step, /AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF/, "PMI writes AP242");
if (typeof wasm.open === "function") {
    const scene = wasm.open(new TextEncoder().encode(step), "step");
    const read = scene.pmi();
    const items = typeof read === "string" ? JSON.parse(read) : read;
    assert.deepStrictEqual(items.map((p) => p.kind), ["datum", "tolerance", "dimension", "note"]);
    assert.strictEqual(items.find((p) => p.kind === "tolerance").type, "flatness");
    scene.free?.();
} else console.log("note: this package has no reader (`open`): the STEP is checked by its schema line only");
console.log("annotate: ok");
