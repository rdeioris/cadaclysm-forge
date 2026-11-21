// The page's sketch and curve commands as document batches (forge-commands.js) over the
// kernel's public exports: what each writes in the node layout (forge-model.js's header),
// the counters through the `forge` meta, the sketch fillet and trim through the kernel's
// profile calls (checked against the 0.14 layer's own answers, recorded in
// test/fixtures/layer-0.14-answers.json), the readers of what a
// command removes, and the stand-in for a node the kernel refuses.
//
// Run: node test/forge-commands.mjs   (after npm run setup)
import assert from "node:assert";
import { loadWasm } from "./package.mjs";
import { Model, UNITS } from "../forge-model.js";
import { command, commandOps, readItem, Draft, sketchFillet, trimmedCurves, kernelTakes, pageItems, touchesPlane } from "../forge-commands.js";
import { buildModel, freeModel, solveModel, writeBack, addConstraint, removeConstraint, dragModel, setValue } from "../forge-constraints.js";
import { isBody } from "../forge-model.js";
import { readFileSync } from "node:fs";

const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
// A kernel whose curve split takes `along` (0.15.1 on): a trim runs along its curve's frame,
// no direction copied; before it, the direction as numbers, kept by the copies.
const ALONG = kernelTakes(wasm, "sheet.split_by_curve", "along");
// What the 0.14 layer answered for the same commands, recorded before it went.
const answers = JSON.parse(readFileSync(new URL("./fixtures/layer-0.14-answers.json", import.meta.url), "utf8")).commands;

function fresh() {
    const doc = wasm[K + "document_new"](UNITS);
    const model = new Model(wasm, doc);
    const run = (cmd) => {
        wasm[K + "document_evaluate"](doc, false);
        return command(wasm, model, doc, cmd);
    };
    const raw = (op) => model.refresh(wasm[K + "document_apply"](doc, JSON.stringify(op), undefined), op);
    const nodes = () => JSON.parse(wasm[K + "document_nodes"](doc, null));
    const node = (id) => nodes().find((n) => n.id === id);
    const meta = () => JSON.parse(wasm[K + "document_meta"](doc, "forge") ?? "null");
    const item = (n) => readItem(new Draft(model), n);
    const revision = () => wasm[K + "document_revision"](doc);
    const statusOf = (id) => JSON.parse(wasm[K + "document_evaluate"](doc, false)).find((s) => s.id === id);
    return { doc, model, run, raw, nodes, node, meta, item, revision, statusOf, free: () => wasm[K + "document_free"](doc) };
}

// A body's solid: its kind, counts, volume, area and bounds.
function solidOf(doc, id) {
    const kind = wasm[K + "document_result_kind"](doc, id);
    if (kind !== "solid" && kind !== "sheet") return { kind };
    const s = wasm[K + "document_result_solid"](doc, id);
    try {
        const m = wasm[K + "mass_properties"](s, 1e-9);
        return { kind, faces: wasm[K + "face_count"](s), edges: wasm[K + "edge_count"](s), volume: m[0] ? m[6] : 0, area: m[4], bounds: Array.from(wasm[K + "bounds64"](s, 0.01)) };
    } finally {
        wasm[K + "solid_free"](s);
    }
}

// The same, the document evaluated first.
const solidNow = (t, id) => {
    wasm[K + "document_evaluate"](t.doc, false);
    return solidOf(t.doc, id);
};

const close = (a, b, tol = 1e-5) => {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i], tol));
    if (a && b && typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
        return ka.length === kb.length && ka.every((k, i) => k === kb[i] && close(a[k], b[k], tol));
    }
    return a === b;
};

// add: the curve's head node, its name off the counters, the meta op in the same batch, the
// model kept by the changed set; the `{ changed, op }` the scene and the worker take.
{
    const t = fresh();
    const { changed, op } = t.run({ op: "add", id: 1, kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } });
    assert.deepStrictEqual(changed.added, ["i1"]);
    assert.deepStrictEqual(changed.meta, ["forge"]);
    assert.strictEqual(op.op, "batch");
    assert.strictEqual(op.message, "forge: add");
    assert.deepStrictEqual(op.ops.map((o) => o.op), ["add", "meta"]);
    assert.deepStrictEqual(t.node("i1"), { id: "i1", kind: "curve.line", name: "Line 1", meta: { forge: { kind: "line" } }, x0: 0, y0: 0, x1: 10, y1: 0, frame: "xy" });
    assert.deepStrictEqual(t.meta(), { counters: { line: 1 }, nextId: 2 });
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    assert.deepStrictEqual(t.model.items().map((i) => [i.id, i.kind, i.name]), [[1, "line", "Line 1"]]);
    assert.deepStrictEqual(t.item(1), { id: 1, name: "Line 1", kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 10, y1: 0 }, hidden: false });
    // A second line: the counter moves on; a set moves nothing, so no meta op.
    t.run({ op: "add", id: 2, kind: "line", plane: "front", shape: { x0: 0, y0: 0, x1: 0, y1: 5 } });
    assert.strictEqual(t.node("i2").name, "Line 2");
    assert.strictEqual(t.node("i2").frame, "xz");
    const set = t.run({ op: "set", id: 1, name: "a", cache: 3, dirty: true });
    assert.deepStrictEqual(set.op.ops, [{ op: "set", id: "i1", fields: { name: "a" } }]);
    // commandOps alone applies nothing.
    const rev = t.revision();
    const { ops, meta } = commandOps(t.model, { op: "add", id: 9, kind: "circle", plane: "top", shape: { cx: 0, cy: 0, r: 1 } });
    assert.strictEqual(t.revision(), rev);
    assert.deepStrictEqual(ops.map((o) => o.op), ["add"]);
    assert.deepStrictEqual(meta, { counters: { line: 2, circle: 1 }, nextId: 10 });
    // Undo takes the command and its counters back together.
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    assert.deepStrictEqual(t.meta(), { counters: { line: 1 }, nextId: 2 });
    t.free();
}

// A sketch and what is on it; edits; a kind change replaces the node in its place.
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 5, constraints: [{ kind: "fixed" }] });
    assert.deepStrictEqual(t.node("i1_frame"), { id: "i1_frame", kind: "frame.offset", base: "xy", offset: 5 });
    assert.deepStrictEqual(t.node("i1"), { id: "i1", kind: "sketch", name: "Sketch 1", meta: { forge: { kind: "sketch", mode: "offset", hinge: null, path: null, face: null, mid: null, points: null } }, frame: "i1_frame", forge_constraints: [{ kind: "fixed" }] });
    const sk = t.item(1);
    assert.strictEqual(sk.base, "top");
    assert.strictEqual(sk.offset, 5);
    assert.deepStrictEqual(sk.constraints, [{ kind: "fixed" }]);
    t.run({ op: "add", id: 2, kind: "rect", plane: 1, shape: { x0: -10, y0: -10, x1: 10, y1: 10 } });
    t.run({ op: "add", id: 3, kind: "line", plane: 1, shape: { x0: 0, y0: 0, x1: 4, y1: 4 } });
    assert.strictEqual(t.node("i2").frame, "i1");
    assert.strictEqual(t.item(2).plane, 1);
    // An offset edit is the frame node's; a look is the page's.
    t.run({ op: "set", id: 1, offset: 8, look: { colour: "#ff0000" } });
    assert.strictEqual(t.node("i1_frame").offset, 8);
    assert.deepStrictEqual(t.node("i1").meta.forge.look, { colour: "#ff0000" });
    // A shape edited, hidden through `edit` (runtime keys dropped at any depth).
    t.run({ op: "edit", items: [{ id: 3, hidden: true, dirty: true, shape: { x0: 1, y0: 1, x1: 4, y1: 4, sig: 7 } }] });
    assert.strictEqual(t.node("i3").hidden, true);
    assert.deepStrictEqual([t.node("i3").x0, t.node("i3").y0], [1, 1]);
    assert.strictEqual(t.node("i3").meta.forge.shape, undefined);
    // The line made a polyline: the same id at the same place, a curve.polyline.
    const at = t.nodes().findIndex((n) => n.id === "i3");
    t.run({ op: "set", id: 3, kind: "polyline", shape: { points: [[0, 0], [4, 4], [8, 0]], closed: false } });
    assert.strictEqual(t.nodes().findIndex((n) => n.id === "i3"), at);
    assert.strictEqual(t.node("i3").kind, "curve.polyline");
    assert.strictEqual(t.item(3).kind, "polyline");
    // The other sketch modes: a tilted plane on a hinge curve, one along a path.
    t.run({ op: "add", id: 7, kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 4, y1: 0 } });
    t.run({ op: "sketch", id: 4, mode: "angle", hinge: 7, tilt: 30, path: null, face: null, mid: null, points: null });
    assert.deepStrictEqual(t.node("i4_frame"), { id: "i4_frame", kind: "frame.tilted", hinge: "i7", tilt: 30 });
    t.run({ op: "sketch", id: 5, mode: "path", path: 3 });
    assert.deepStrictEqual(t.node("i5_frame"), { id: "i5_frame", kind: "frame.on_path", path: "i3" });
    assert.strictEqual(t.statusOf("i4_frame").state, "ok", JSON.stringify(t.statusOf("i4_frame")));
    // The constraints a structural command prunes, and the curves its red records moved.
    t.run({ op: "set", id: 2, hidden: false, sketchConstraints: [{ sketch: 1, constraints: [] }], sketchEdits: [{ id: 2, shape: { x0: -5, y0: -5, x1: 5, y1: 5 } }] });
    assert.deepStrictEqual(t.node("i1").forge_constraints, []);
    assert.strictEqual(t.node("i2").x1, 5);
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// The sketch fillet through the kernel: one curve rounded into a polycurve, as the 0.14
// layer rounded it (its own f32 Béziers: the digits move in the sixth place).
for (const [k, c] of [
    { kind: "rect", shape: { x0: 0, y0: 0, x1: 20, y1: 10 } },
    { kind: "polygon", shape: { cx: 0, cy: 0, r: 10, sides: 6, angle: 0 } },
    { kind: "polyline", shape: { points: [[0, 0], [10, 0], [10, 10], [20, 10]], closed: false } },
    { kind: "polyline", shape: { points: [[0, 0], [10, 0], [10, 10]], closed: true } },
    { kind: "polycurve", shape: { pieces: [{ kind: "line", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } }, { kind: "arc", shape: { x0: 10, y0: 0, xm: 12, ym: 5, x1: 10, y1: 10 } }, { kind: "line", shape: { x0: 10, y0: 10, x1: 0, y1: 10 } }], closed: false } },
].entries()) {
    const t = fresh();
    t.run({ op: "add", id: 1, kind: c.kind, plane: "top", shape: c.shape });
    t.run({ op: "round", ids: [1], radius: 2 });
    const now = t.item(1);
    const was = answers.fillets[k];
    assert.strictEqual(now.kind, "polycurve", c.kind);
    assert.strictEqual(t.node("i1").kind, "curve.polycurve");
    assert.strictEqual(now.shape.pieces.length, was.pieces.length, `${c.kind}: pieces`);
    assert.ok(close(now.shape, was), `${c.kind}: ${JSON.stringify(now.shape)} != ${JSON.stringify(was)}`);
    assert.strictEqual(t.statusOf("i1").state, "ok");
    t.free();
}

// Two lines: each cut back to its tangent point, the arc a new curve right after the
// second, every profile loop through the corner taking it; a radius that does not fit is
// refused in the kernel's words, the document untouched.
{
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } });
    t.run({ op: "add", id: 2, kind: "line", plane: "top", shape: { x0: 10, y0: 0, x1: 10, y1: 10 } });
    t.run({ op: "add", id: 4, kind: "line", plane: "top", shape: { x0: 10, y0: 10, x1: 0, y1: 0 } });
    // A profile over the three, as a body's would be (its layout is the made bodies' group's).
    t.raw({ op: "add", node: { id: "i9_src", kind: "profile.from_curves", curves: ["i1", "i2", "i4"], per_loop: [3] } });
    const rev = t.revision();
    assert.throws(() => t.run({ op: "round", ids: [1, 2], radius: 30, arc: 3 }), /the radius does not fit/);
    assert.strictEqual(t.revision(), rev);
    t.run({ op: "round", ids: [1, 2], radius: 3, arc: 3 });
    const was = answers.twoLines;
    assert.ok(close(t.item(1).shape, { x0: 0, y0: 0, x1: 7, y1: 0 }));
    assert.ok(close({ x1: t.item(1).shape.x1, y1: t.item(1).shape.y1 }, was.a), JSON.stringify(was));
    assert.ok(close({ x0: t.item(2).shape.x0, y0: t.item(2).shape.y0 }, was.b));
    assert.ok(close(t.item(3).shape, was.arc));
    assert.deepStrictEqual([t.item(3).kind, t.item(3).name, t.item(3).plane], ["arc", "Arc 1", "top"]);
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i1", "i2", "i3", "i4", "i9_src"]);
    assert.deepStrictEqual(t.node("i9_src").curves, ["i1", "i3", "i2", "i4"]);
    assert.deepStrictEqual(t.node("i9_src").per_loop, [4]);
    assert.strictEqual(t.statusOf("i9_src").state, "ok");
    t.free();
}

// explode, snip (the page's items, or made here by the kernel), merge: the curves in the
// old one's place, the loops through it rewritten.
{
    const t = fresh();
    const pieces = [{ kind: "line", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } }, { kind: "arc", shape: { x0: 10, y0: 0, xm: 12, ym: 5, x1: 10, y1: 10 } }];
    t.run({ op: "add", id: 1, kind: "polycurve", plane: "top", shape: { pieces, closed: false } });
    t.run({ op: "add", id: 2, kind: "line", plane: "top", shape: { x0: 10, y0: 10, x1: 0, y1: 0 } });
    t.raw({ op: "add", node: { id: "i9_src", kind: "profile.from_curves", curves: ["i1", "i2"] } });
    t.run({ op: "explode", id: 1, ids: [3, 4] });
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i3", "i4", "i2", "i9_src"]);
    assert.deepStrictEqual([t.item(3).kind, t.item(3).name, t.item(4).kind, t.item(4).name], ["line", "Line 2", "arc", "Arc 1"]);
    assert.deepStrictEqual(t.node("i9_src").curves, ["i3", "i4", "i2"]);
    assert.strictEqual(t.statusOf("i9_src").state, "ok");
    // merge them back into one polycurve where the first of them was.
    t.run({ op: "merge", id: 5, plane: "top", pieces, closed: false, ends: [[0, 0], [10, 10]], ids: [3, 4] });
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i5", "i2", "i9_src"]);
    assert.deepStrictEqual(t.node("i9_src").curves, ["i5", "i2"]);
    assert.deepStrictEqual(t.item(5).shape.ends, [[0, 0], [10, 10]]);
    assert.deepStrictEqual(t.node("i5").meta.forge, { kind: "polycurve", shape: { ends: [[0, 0], [10, 10]] } });
    // A sketch trim: a line crossed by another, its middle taken away.
    t.run({ op: "add", id: 6, kind: "line", plane: "top", shape: { x0: 0, y0: 5, x1: 20, y1: 5 } });
    t.run({ op: "add", id: 7, kind: "line", plane: "top", shape: { x0: 8, y0: -5, x1: 8, y1: 15 } });
    t.run({ op: "add", id: 8, kind: "line", plane: "top", shape: { x0: 12, y0: -5, x1: 12, y1: 15 } });
    const cut = trimmedCurves(wasm, t.item(6), [t.item(7), t.item(8)], 1);
    assert.ok(close(cut, [{ kind: "line", shape: { x0: 0, y0: 5, x1: 8, y1: 5 } }, { kind: "line", shape: { x0: 12, y0: 5, x1: 20, y1: 5 } }], 1e-9), JSON.stringify(cut));
    t.run({ op: "snip", id: 6, ids: [9, 10], piece: 1, cutters: [7, 8] });
    assert.ok(close([t.item(9).shape, t.item(10).shape], cut.map((c) => c.shape), 1e-12));
    // The page's own items: the same command, as the page sends it.
    t.run({ op: "snip", id: 9, ids: [11], items: [{ kind: "line", shape: { x0: 0, y0: 5, x1: 4, y1: 5 } }] });
    assert.deepStrictEqual(t.item(11).shape, { x0: 0, y0: 5, x1: 4, y1: 5 });
    assert.strictEqual(t.node("i9"), undefined);
    assert.throws(() => t.run({ op: "explode", id: 2, ids: [12] }), /explode: not a polycurve/);
    t.free();
}

// delete: a sketch takes its curves along; a node reading a curve that went is a stand-in
// of its own type with the 0.14 layer's words; a sketch tilted on it falls back to Top and
// keeps its hinge; a face plane goes with its body, and a curve on it falls back to Top
// keeping its plane.
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: 0, x1: 1, y1: 0 } });
    t.run({ op: "add", id: 3, kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 5, y1: 0 } });
    t.run({ op: "add", id: 4, kind: "rect", plane: "top", shape: { x0: 0, y0: 0, x1: 5, y1: 5 } });
    t.run({ op: "sketch", id: 5, mode: "angle", hinge: 3, tilt: 45 });
    t.raw({ op: "batch", ops: [
        { op: "add", node: { id: "i9_src", kind: "profile.from_curves", curves: ["i4"] } },
        { op: "add", node: { id: "i9", kind: "solid.extrude", profile: "i9_src", distance: 5, name: "Extrusion 1", meta: { forge: { kind: "extrusion" } } } },
        { op: "add", node: { id: "i8", kind: "solid.cuboid", x: 10, y: 10, z: 10, anchor: "base", name: "Box 1", meta: { forge: { kind: "box" } } } },
    ] });
    t.run({ op: "add", id: 6, kind: "circle", plane: "face:8:1", shape: { cx: 0, cy: 0, r: 2 } });
    assert.deepStrictEqual(t.nodes().map((n) => n.id).slice(-3), ["i8", "f8_1", "i6"]);
    assert.strictEqual(t.node("f8_1").kind, "frame.on_face");
    assert.strictEqual(t.node("f8_1").solid, "i8");
    assert.strictEqual(t.node("i6").frame, "f8_1");
    assert.strictEqual(t.statusOf("i6").state, "ok");
    t.run({ op: "delete", ids: [1, 3, 4] });
    assert.strictEqual(t.node("i1"), undefined);
    assert.strictEqual(t.node("i1_frame"), undefined);
    assert.strictEqual(t.node("i2"), undefined);
    const src = t.node("i9_src");
    assert.deepStrictEqual([src.kind, src.type, src.why], ["value.unresolved", "profile", "i9_src: curve #4 is gone"]);
    assert.deepStrictEqual(src.meta.forge.was, { kind: "profile.from_curves", curves: ["i4"] });
    assert.strictEqual(t.statusOf("i9").state, "blocked");
    assert.deepStrictEqual(t.node("i5_frame"), { id: "i5_frame", kind: "frame.offset", base: "xy", offset: 0 });
    assert.deepStrictEqual([t.item(5).mode, t.item(5).hinge, t.item(5).tilt], ["angle", 3, 45]);
    t.run({ op: "delete", ids: [8] });
    assert.strictEqual(t.node("f8_1"), undefined);
    assert.strictEqual(t.node("i6").frame, "xy");
    assert.strictEqual(t.item(6).plane, "face:8:1");
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    // Undo brings all of it back.
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    assert.strictEqual(t.node("i6").frame, "f8_1");
    t.free();
}

// duplicate: a curve and a sketch copied after their originals; an image's copy only takes
// its id; a held body copied gets a head of its own, as does the original.
{
    const t = fresh();
    t.run({ op: "image", id: 1 });
    assert.deepStrictEqual(t.meta(), { counters: {}, nextId: 2 });
    t.run({ op: "sketch", id: 2, mode: "offset", base: "front", offset: 3, constraints: [{ kind: "fixed" }] });
    t.run({ op: "add", id: 3, kind: "circle", plane: 2, shape: { cx: 1, cy: 2, r: 3 } });
    t.run({ op: "duplicate", ids: [1, 2, 3], copies: [4, 5, 6] });
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i2_frame", "i2", "i5_frame", "i5", "i3", "i6"]);
    assert.deepStrictEqual([t.item(5).name, t.item(5).base, t.item(5).offset, t.item(5).constraints], ["Sketch 1 copy", "front", 3, []]);
    assert.deepStrictEqual([t.item(6).name, t.item(6).plane, t.item(6).shape], ["Circle 1 copy", 2, { cx: 1, cy: 2, r: 3 }]);
    assert.strictEqual(t.meta().nextId, 7);
    t.raw({ op: "add", node: { id: "plate", kind: "solid.cuboid", x: 4, y: 4, z: 1, name: "Plate", meta: { show: true } } });
    const held = t.model.items().find((i) => i.node === "plate");
    t.run({ op: "duplicate", ids: [held.id], copies: [9] });
    assert.deepStrictEqual(t.model.items().filter((i) => i.kind === "held").map((i) => [i.id, i.name, i.head.id]), [[held.id, "Plate", `i${held.id}`], [9, "Plate copy", "i9"]]);
    assert.strictEqual(t.statusOf("i9").state, "ok");
    // Deleted one by one: the held node goes with the last item naming it.
    t.run({ op: "delete", ids: [held.id] });
    assert.ok(t.node("plate"));
    t.run({ op: "delete", ids: [9] });
    assert.strictEqual(t.node("plate"), undefined);
    t.free();
}

// A node the kernel refuses (a polygon of 2.5 sides) is a stand-in, its page fields whole in
// its meta, and builds again once a command gives it values the kernel takes.
{
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "polygon", plane: "top", shape: { cx: 0, cy: 0, r: 5, sides: 2.5, angle: 0 } });
    const n = t.node("i1");
    assert.deepStrictEqual([n.kind, n.type, n.name], ["value.unresolved", "curve", "Polygon 1"]);
    assert.match(n.why, /^i1: `sides`/);
    assert.deepStrictEqual(t.item(1).shape, { cx: 0, cy: 0, r: 5, sides: 2.5, angle: 0 });
    assert.strictEqual(t.model.item(1).kind, "polygon");
    t.run({ op: "set", id: 1, shape: { cx: 0, cy: 0, r: 5, sides: 6, angle: 0 } });
    assert.strictEqual(t.node("i1").kind, "curve.polygon");
    assert.strictEqual(t.statusOf("i1").state, "ok");
    t.free();
}

// The made bodies: a surface on a sketch and the solid over it, as nodes -- the profile
// `i<n>_src` (`profile.from_curves` over the curves' heads, the pivot the centre of their
// exact bounds), the verb `i<n>` on the sketch's frame; what they were made of hidden; the
// page fields no node holds in the head's meta. A set goes through the item's diff: a
// height is one field of one node; a place puts a world `solid.transform` at `i<n>` and
// the verb becomes `i<n>_inner`; taken away, the verb is `i<n>` again.
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 5 });
    t.run({ op: "add", id: 2, kind: "rect", plane: 1, shape: { x0: -10, y0: -10, x1: 10, y1: 14 } });
    t.run({ op: "add", id: 3, kind: "circle", plane: 1, shape: { cx: 0, cy: 0, r: 3 } });
    t.run({ op: "surface", id: 4, loops: [[2], [3]], plane: 1 });
    assert.deepStrictEqual(t.node("i4_src"), { id: "i4_src", kind: "profile.from_curves", curves: ["i2", "i3"], per_loop: [1, 1], pivot: [0, 2] });
    assert.deepStrictEqual(t.node("i4"), { id: "i4", kind: "sheet.face", name: "Surface 1", meta: { forge: { kind: "surface", source: null, holes: 1, height: 0, axis: null, angle: 0 } }, profile: "i4_src", frame: "i1" });
    assert.deepStrictEqual([1, 2, 3].map((n) => t.node(`i${n}`).hidden), [true, true, true]);
    const { op } = t.run({ op: "solid", id: 5, from: 4, height: 8 });
    assert.deepStrictEqual(op.ops.map((o) => [o.op, o.id ?? o.node?.id ?? o.app]), [["add", "i5_src"], ["add", "i5"], ["set", "i4"], ["meta", "forge"]]);
    assert.deepStrictEqual(t.node("i5"), { id: "i5", kind: "solid.extrude", name: "Solid 1", meta: { forge: { kind: "solid", source: null, holes: 1, axis: null, angle: 0, from: 4 } }, profile: "i5_src", frame: "i1", distance: 8 });
    assert.strictEqual(t.node("i4").hidden, true);
    assert.deepStrictEqual(t.item(5), {
        id: 5, name: "Solid 1", kind: "solid", plane: 1, loops: [[2], [3]], pivot: [0, 2], transform: { tx: 0, ty: 0, angle: 0, scale: 1 }, place: { offset: [0, 0, 0], turn: [0, 0, 0] },
        height: 8, taper: 0, source: null, holes: 1, axis: null, angle: 0, from: 4, hidden: false,
    });
    assert.strictEqual(t.statusOf("i5").state, "ok");
    assert.deepStrictEqual(t.run({ op: "set", id: 5, height: 9 }).op.ops, [{ op: "set", id: "i5", fields: { distance: 9 } }]);
    // Placed: a world transform about the pivot, the verb under it.
    t.run({ op: "set", id: 5, place: { offset: [0, 0, 10], turn: [0, 0, 30] } });
    assert.deepStrictEqual(t.nodes().map((n) => n.id).slice(-3), ["i5_src", "i5_inner", "i5"]);
    const head = t.node("i5");
    assert.deepStrictEqual([head.kind, head.solid, head.frame, head.pivot, head.turn_in, head.turn, head.by_in, head.by], ["solid.transform", "i5_inner", "i1", [0, 2, 0], "world", [0, 0, 30], "world", [0, 0, 10]]);
    assert.strictEqual(t.node("i5_inner").kind, "solid.extrude");
    assert.deepStrictEqual(t.item(5).place, { offset: [0, 0, 10], turn: [0, 0, 30] });
    assert.strictEqual(t.statusOf("i5").state, "ok");
    t.run({ op: "set", id: 5, place: { offset: [0, 0, 0], turn: [0, 0, 0] } });
    assert.deepStrictEqual(t.nodes().map((n) => n.id).slice(-2), ["i5_src", "i5"]);
    assert.strictEqual(t.node("i5").kind, "solid.extrude");
    // A sketch command on a curve the profile reads: the body builds on what it made.
    t.run({ op: "round", ids: [2], radius: 1 });
    assert.deepStrictEqual(t.item(5).loops, [[2], [3]]);
    assert.strictEqual(t.statusOf("i5").state, "ok");
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// A revolution: its axis kept in sketch coordinates (meta), the verb reading it as it is;
// its in-plane move a `solid.transform` `i<n>_moved` after the verb; its scale the
// profile's (and the axis's with it). A quick solid on its sketch's frame, a box standing
// on it; a coil a circle, its wire, the coil and its place.
{
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "rect", plane: "front", shape: { x0: 20, y0: 0, x1: 24, y1: 4 } });
    t.run({ op: "sweep", id: 2, source: 1, kind: "revolution", axis: [[0, 0], [0, 1]], angle: 270 });
    assert.deepStrictEqual(t.node("i2"), { id: "i2", kind: "solid.revolve_open_in_plane", name: "Revolution 1", meta: { forge: { kind: "revolution", source: null, holes: 0, height: 0, axis: [[0, 0], [0, 1]] } }, profile: "i2_src", frame: "xz", from: [0, 0], to: [0, 1], angle: 270 });
    assert.strictEqual(t.node("i2_src").open, true);
    t.run({ op: "set", id: 2, transform: { tx: 3, ty: -1, angle: 0.5, scale: 1 } });
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i1", "i2_src", "i2_inner", "i2"]);
    const moved = t.node("i2");
    assert.deepStrictEqual([moved.kind, moved.solid, moved.frame, moved.pivot, moved.by, moved.turn_in], ["solid.transform", "i2_inner", "xz", [22, 2, 0], [3, -1, 0], undefined]);
    assert.ok(Math.abs(moved.turn[2] - 0.5 * 180 / Math.PI) < 1e-12);
    assert.deepStrictEqual(t.node("i2_inner").from, [0, 0]);
    assert.deepStrictEqual(t.item(2).transform, { tx: 3, ty: -1, angle: 0.5, scale: 1 });
    // Scaled about the pivot (22, 2): the profile's scale, and the axis scaled with it.
    t.run({ op: "set", id: 2, transform: { tx: 0, ty: 0, angle: 0, scale: 2 } });
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i1", "i2_src", "i2"]);
    assert.strictEqual(t.node("i2_src").scale, 2);
    assert.deepStrictEqual([t.node("i2").from, t.node("i2").to], [[-22, -2], [-22, 0]]);
    assert.deepStrictEqual(t.item(2).axis, [[0, 0], [0, 1]]);
    t.run({ op: "sketch", id: 3, mode: "offset", base: "front", offset: 2 });
    t.run({ op: "primitive", id: 4, kind: "box", plane: 3, dims: [4, 6, 8] });
    assert.deepStrictEqual(t.node("i4"), { id: "i4", kind: "solid.cuboid", name: "Box 1", meta: { forge: { kind: "box", parts: [], pivot: [0, 0], holes: 0, height: 0, axis: null, angle: 0, source: null } }, x: 4, y: 6, z: 8, anchor: "base", frame: "i3" });
    assert.deepStrictEqual(t.item(4).dims, [4, 6, 8]);
    t.run({ op: "primitive", id: 5, kind: "coil", plane: "top", dims: [10, 1, 4, 3] });
    assert.deepStrictEqual(t.nodes().map((n) => n.id).slice(-4), ["i5_circle", "i5_wire", "i5_coil", "i5"]);
    assert.deepStrictEqual([t.node("i5_wire").by, t.node("i5").kind, t.node("i5").frame], [[10, 1], "solid.place", "xy"]);
    assert.deepStrictEqual(t.item(5).dims, [10, 1, 4, 3]);
    for (const id of ["i2", "i4", "i5"]) assert.strictEqual(t.statusOf(id).state, "ok", id);
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// Every made body against the 0.14 layer (its answers recorded off the 0.15.0 package):
// the same commands, each item read back off the nodes as the old layer has it,
// each body the same solid (counts exact; volume, area, bounds to 1e-6). The quick solids
// on a tilted sketch, against `forge.primitive`. Where they differ by decision: the pivot
// is the exact bounds' centre (a circle's to an ulp), a revolution says it is a sheet.
{
    const t = fresh();
    const seq = [
        { op: "add", id: 1, kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 6, y1: 0 } },
        { op: "sketch", id: 2, mode: "angle", hinge: 1, tilt: 35 },
        { op: "add", id: 3, kind: "rect", plane: 2, shape: { x0: -10, y0: -10, x1: 10, y1: 10 } },
        { op: "add", id: 4, kind: "circle", plane: 2, shape: { cx: 1, cy: 0, r: 3 } },
        { op: "surface", id: 5, loops: [[3], [4]], plane: 2 },
        { op: "solid", id: 6, from: 5, height: 8 },
        { op: "set", id: 6, height: 9, taper: 3 },
        { op: "set", id: 6, place: { offset: [1, 2, 3], turn: [10, 20, 30] }, transform: { tx: 1, ty: 2, angle: 0.3, scale: 1.5 } },
        { op: "add", id: 7, kind: "rect", plane: "front", shape: { x0: 20, y0: 0, x1: 24, y1: 4 } },
        { op: "sweep", id: 8, source: 7, kind: "revolution", axis: [[0, 0], [0, 1]], angle: 180 },
        { op: "set", id: 8, transform: { tx: 3, ty: -1, angle: 0.4, scale: 1.25 } },
        { op: "add", id: 9, kind: "rect", plane: "top", shape: { x0: 30, y0: 0, x1: 34, y1: 4 } },
        { op: "sweep", id: 10, source: 9, kind: "extrusion", height: 5, taper: 0 },
        { op: "add", id: 11, kind: "circle", plane: "top", shape: { cx: 40, cy: 0, r: 4 } },
        { op: "sketch", id: 12, mode: "offset", base: "top", offset: 10 },
        { op: "add", id: 13, kind: "circle", plane: 12, shape: { cx: 40, cy: 0, r: 2 } },
        { op: "sketch", id: 14, mode: "offset", base: "top", offset: 20 },
        { op: "add", id: 15, kind: "circle", plane: 14, shape: { cx: 40, cy: 0, r: 3 } },
        { op: "lofted", id: 16, from: 11, to: 15, via: [13] },
        { op: "add", id: 17, kind: "line", plane: "front", shape: { x0: 60, y0: 0, x1: 60, y1: 20 } },
        { op: "add", id: 18, kind: "circle", plane: "top", shape: { cx: 60, cy: 0, r: 2 } },
        { op: "swept", id: 19, from: 18, path: 17 },
        { op: "pipe", id: 20, path: 17, dims: [1, 0.5] },
        { op: "add", id: 21, kind: "rect", plane: "top", shape: { x0: 70, y0: 0, x1: 74, y1: 4 } },
        { op: "surface", id: 22, loops: [[21]], plane: "top" },
        { op: "add", id: 23, kind: "rect", plane: 14, shape: { x0: 70, y0: 0, x1: 72, y1: 2 } },
        { op: "surface", id: 24, loops: [[23]], plane: 14 },
        { op: "lofted", id: 25, from: 22, to: 24 },
        { op: "add", id: 26, kind: "rect", plane: "top", shape: { x0: 80, y0: 1, x1: 84, y1: 4 } },
        { op: "surface", id: 27, loops: [[26]], plane: "top" },
        { op: "revolved", id: 28, from: 27, axis: [[80, 0], [81, 0]], angle: 90 },
        { op: "set", id: 28, transform: { tx: 1, ty: 0, angle: 0.25, scale: 1 } },
        ...["box", "cylinder", "cone", "pyramid", "sphere", "torus", "coil"].map((kind, k) => ({
            op: "primitive", id: 30 + k, kind, plane: 2,
            dims: { box: [4, 6, 8], cylinder: [3, 7], cone: [3, 7], pyramid: [5, 4, 6], sphere: [5], torus: [6, 1], coil: [10, 1, 4, 3] }[kind],
        })),
        { op: "set", id: 36, transform: { tx: 5, ty: 1, angle: 0.5, scale: 1 }, place: { offset: [0, 0, 7], turn: [0, 45, 0] } },
        { op: "set", id: 33, place: { offset: [1, 0, 0], turn: [90, 0, 0] } },
    ];
    for (const cmd of seq) t.run(cmd);
    const statuses = JSON.parse(wasm[K + "document_evaluate"](t.doc, false));
    let bodies = 0;
    for (const [n, fields] of answers.made.items) {
        const now = t.item(n);
        if (fields.kind === "revolution" && fields.sheet === undefined) assert.strictEqual(now.sheet, true);
        const want = { ...fields }, got = { ...now };
        if (want.kind === "revolution" && want.sheet === undefined) delete got.sheet;
        assert.ok(close(got, want, 1e-12), `#${n}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        if (!isBody(t.model.item(n))) continue;
        assert.strictEqual(statuses.find((s) => s.id === `i${n}`)?.state, "ok", `#${n}`);
        const [a, b] = [solidOf(t.doc, `i${n}`), answers.made.solids[n]];
        assert.ok(close(a, b, 1e-6), `#${n} ${fields.kind}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
        bodies++;
    }
    assert.strictEqual(bodies, 19);
    t.free();
}

// The pivot: the centre of the curves' exact bounds, not the 0.14 layer's control-point box
// (an arc's Béziers bulge past it).
{
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "polycurve", plane: "top", shape: { pieces: [{ kind: "line", shape: { x0: 0, y0: 0, x1: 8, y1: 0 } }, { kind: "arc", shape: { x0: 8, y0: 0, xm: 4, ym: 6, x1: 0, y1: 0 } }], closed: true } });
    t.run({ op: "surface", id: 2, loops: [[1]], plane: "top" });
    assert.ok(close(t.item(2).pivot, [4, 3], 1e-12), JSON.stringify(t.item(2).pivot));
    assert.deepStrictEqual(t.node("i2_src").pivot, t.item(2).pivot);
    t.free();
}

// What cannot be built is a stand-in in its own words (the old layer's); a curve a new
// body is over that is not there is refused, as the page refused it.
{
    const t = fresh();
    t.run({ op: "primitive", id: 1, kind: "box", plane: "top", dims: [4, 4] });
    assert.deepStrictEqual([t.node("i1").kind, t.node("i1").type, t.node("i1").why], ["value.unresolved", "solid", "i1: box: 3 dimensions, not 2"]);
    assert.deepStrictEqual(t.item(1).dims, [4, 4]);
    t.run({ op: "set", id: 1, dims: [4, 4, 4] });
    assert.strictEqual(t.node("i1").kind, "solid.cuboid");
    // The kernel refuses a pyramid of 2.5 sides: the stand-in is the retry's.
    t.run({ op: "primitive", id: 2, kind: "pyramid", plane: "top", dims: [2.5, 4, 4] });
    assert.deepStrictEqual([t.node("i2").kind, t.node("i2").type], ["value.unresolved", "solid"]);
    assert.throws(() => t.run({ op: "surface", id: 3, loops: [[9]], plane: "top" }), /#9 is gone/);
    t.run({ op: "add", id: 4, kind: "line", plane: "top", shape: { x0: 0, y0: 0, x1: 1, y1: 0 } });
    t.run({ op: "sweep", id: 5, source: 4, kind: "extrusion", height: 2 });
    t.run({ op: "delete", ids: [4] });
    assert.strictEqual(t.node("i5_src").kind, "value.unresolved");
    // A later write of the body knows its curve is gone.
    t.run({ op: "set", id: 5, height: 3 });
    assert.deepStrictEqual([t.node("i5").kind, t.node("i5").type, t.node("i5").why], ["value.unresolved", "sheet", "i5_src: curve #4 is gone"]);
    assert.strictEqual(t.node("i5_src"), undefined);
    // A sweep whose path went: its head stood in by the delete, the item read as it was.
    t.run({ op: "add", id: 6, kind: "line", plane: "front", shape: { x0: 0, y0: 0, x1: 0, y1: 9 } });
    t.run({ op: "add", id: 7, kind: "circle", plane: "top", shape: { cx: 0, cy: 0, r: 1 } });
    t.run({ op: "swept", id: 8, from: 7, path: 6 });
    t.run({ op: "delete", ids: [6] });
    assert.deepStrictEqual([t.node("i8").kind, t.node("i8").why], ["value.unresolved", "i8: curve #6 is gone"]);
    assert.deepStrictEqual([t.item(8).kind, t.item(8).path, t.item(8).loops, t.item(8).sheet], ["sweep", 6, [[7]], true]);
    t.free();
}

// Held items: every command first gives each held item the model lists without a head one
// of its own, under the number the model shows, and moves the next id past it -- so the
// primitive below (id 4, which moves the next id to 5) does not renumber the plate, and
// the join after it finds it as #1. A held body placed is a world transform of its node.
{
    const t = fresh();
    t.raw({ op: "add", node: { id: "plate", kind: "solid.cuboid", x: 40, y: 30, z: 20, name: "plate part", meta: { show: true } } });
    t.raw({ op: "add", node: { id: "outline", kind: "profile.path", name: "outline part", path: { start: [-5, -3], segments: [{ type: "line", to: [5, -3] }, { type: "line", to: [5, 3] }, { type: "line", to: [-5, -3] }] } } });
    const before = t.model.items().map((i) => [i.id, i.name]);
    assert.deepStrictEqual(before, [[1, "plate part"], [2, "outline part"]]);
    t.run({ op: "primitive", id: 4, kind: "box", plane: "top", dims: [10, 10, 40] });
    assert.deepStrictEqual(t.model.items().map((i) => [i.id, i.name]), [[1, "plate part"], [2, "outline part"], [4, "Box 1"]]);
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["plate", "i1", "outline", "i2", "i4"]);
    assert.deepStrictEqual(t.node("i1"), { id: "i1", kind: "solid.transform", name: "plate part", meta: { forge: { kind: "held", node: "plate" } }, solid: "plate" });
    assert.deepStrictEqual(t.node("i2").meta.forge, { kind: "held_profile", node: "outline" });
    assert.strictEqual(t.meta().nextId, 5);
    t.run({ op: "set", id: 1, place: { offset: [0, 0, 10], turn: [0, 0, 0] } });
    assert.deepStrictEqual([t.node("i1").solid, t.node("i1").by, t.node("i1").by_in], ["plate", [0, 0, 10], "world"]);
    assert.strictEqual(t.statusOf("i1").state, "ok");
    assert.ok(close(solidOf(t.doc, "i1").bounds, [-20, -15, 0, 20, 15, 20]), JSON.stringify(solidOf(t.doc, "i1").bounds));
    // A held node another app adds later is adopted at the number the model shows it under.
    t.raw({ op: "add", node: { id: "post", kind: "solid.cylinder", r: 1, h: 2, meta: { show: true } } });
    assert.strictEqual(t.model.items().find((i) => i.node === "post").id, 5);
    t.run({ op: "image", id: 6 });
    assert.strictEqual(t.node("i5").meta.forge.node, "post");
    assert.deepStrictEqual(t.meta().nextId, 7);
    assert.deepStrictEqual(t.model.items().map((i) => i.of), t.model.items().map(() => undefined));
    t.free();
}

// The body verbs against the 0.14 layer (its answers recorded off the 0.15.0 package): the
// same commands, each item read back off the nodes as the old layer has it, each
// body the same solid (counts exact; volume, area, bounds to 1e-6). A trim's face reference
// is the split's (`sheet.split_by_curve`, not `forge.curve_tool`): the same face, its
// numbers to 1e-6.
{
    const t = fresh();
    const at = (id, x, y = 0, z = 0) => ({ op: "set", id, place: { offset: [x, y, z], turn: [0, 0, 0] } });
    const box = (id, s = 10) => ({ op: "primitive", id, kind: "box", plane: "top", dims: [s, s, s] });
    const seq = [
        box(1, 20), { op: "primitive", id: 2, kind: "cylinder", plane: "top", dims: [6, 30] },
        { op: "join", id: 3, parts: [1, 2] },
        box(4), at(4, 40), { op: "primitive", id: 5, kind: "cylinder", plane: "top", dims: [3, 20] }, at(5, 45, 5, -5),
        { op: "cut", id: 6, parts: [4, 5] },
        box(7), at(7, 80), box(8), at(8, 85),
        { op: "intersect", id: 9, parts: [7, 8], flush: true },
        box(10), at(10, 80, 40), box(11), at(11, 90, 40),
        { op: "join", id: 12, parts: [10, 11], flush: true },
        { op: "set", id: 12, place: { offset: [0, 0, 5], turn: [0, 0, 10] }, transform: { tx: 1, ty: 2, angle: 0.2, scale: 1 } },
        box(13, 20), at(13, 0, 80),
        { op: "shell", id: 14, source: 13, thickness: 1, open: [1] },
        { op: "add", id: 15, kind: "rect", plane: "top", shape: { x0: 150, y0: 0, x1: 160, y1: 10 } },
        { op: "surface", id: 16, loops: [[15]], plane: "top" },
        { op: "thicken", id: 17, source: 16, thickness: 2 },
        { op: "add", id: 18, kind: "rect", plane: "top", shape: { x0: 170, y0: 0, x1: 180, y1: 10 } },
        { op: "surface", id: 19, loops: [[18]], plane: "top" },
        { op: "prism", id: 20, from: 19, height: 3 },
        // A trim on a tilted sketch: its curve split along the sketch's normal.
        { op: "add", id: 21, kind: "line", plane: "top", shape: { x0: 0, y0: 50, x1: 10, y1: 50 } },
        { op: "sketch", id: 22, mode: "angle", hinge: 21, tilt: 30 },
        { op: "add", id: 23, kind: "rect", plane: 22, shape: { x0: -20, y0: -20, x1: 20, y1: 20 } },
        { op: "surface", id: 24, loops: [[23]], plane: 22 },
        { op: "add", id: 25, kind: "circle", plane: 22, shape: { cx: 3, cy: -2, r: 8 } },
        { op: "trim", id: 26, sheet: 24, tool: 25 },
        { op: "set", id: 26, drop: [1] },
        box(27), at(27, 0, -60),
        { op: "fillet", id: 28, source: 27, radius: 1, style: "chamfer" },
        { op: "set", id: 28, edges: [0, 3] },
        { op: "face", id: 29, from: 28, face: 0, curved: true },
        { op: "rechamfer", id: 30, from: 29, radius: 2 },
        { op: "remove", id: 31, from: 29, what: "chamfer" },
        box(32), at(32, 30, -60),
        { op: "fillet", id: 33, source: 32, radius: 1 },
        { op: "set", id: 33, edges: [1, 2] },
        { op: "face", id: 34, from: 33, face: 6, curved: true },
        { op: "refillet", id: 35, from: 34, radius: 2 },
        { op: "remove", id: 36, from: 34, what: "fillet" },
        box(37), at(37, 60, -60),
        { op: "face", id: 38, from: 37, face: 1 },
        { op: "press", id: 39, from: [38], height: 2 },
        box(40), at(40, 90, -60),
        { op: "face", id: 41, from: 40, face: 2 },
        { op: "face", id: 42, from: 40, face: 3 },
        { op: "press", id: 43, from: [41, 42], height: 2 },
        // A split by a curve, by a sketch's plane, by a body.
        box(44), at(44, 200),
        { op: "add", id: 45, kind: "circle", plane: "top", shape: { cx: 200, cy: 0, r: 3 } },
        { op: "split", target: 44, ids: [46, 47], cutter: 45 },
        box(48), at(48, 230),
        { op: "sketch", id: 49, mode: "offset", base: "top", offset: 4 },
        { op: "split", target: 48, ids: [50, 51], cutter: 49 },
        box(52), at(52, 260),
        box(53, 6), at(53, 264, 0, 2),
        { op: "split", target: 52, ids: [54, 55], cutter: 53 },
        { op: "set", id: 54, transform: { tx: 3, ty: 0, angle: 0, scale: 1 } },
    ];
    for (const cmd of seq) t.run(cmd);
    // Measured to 1e-6: the comparison is to 1e-6.
    const measure = (doc, id) => {
        const kind = wasm[K + "document_result_kind"](doc, id);
        const s = wasm[K + "document_result_solid"](doc, id);
        try {
            const m = wasm[K + "mass_properties"](s, 1e-6);
            return { kind, faces: wasm[K + "face_count"](s), edges: wasm[K + "edge_count"](s), volume: m[0] ? m[6] : 0, area: m[4], bounds: Array.from(wasm[K + "bounds64"](s, 0.01)) };
        } finally {
            wasm[K + "solid_free"](s);
        }
    };
    const ns = JSON.parse(wasm[K + "document_evaluate"](t.doc, false));
    const verbs = new Set();
    let built = 0;
    for (const [n, fields] of answers.verbs.items) {
        const got = t.item(n), want = { ...fields };
        if (want.kind === "trim") {
            assert.ok(close(got.faceRefs, want.faceRefs, 1e-6), `#${n}: ${JSON.stringify(got.faceRefs)}`);
            delete got.faceRefs;
            delete want.faceRefs;
        }
        assert.ok(close(got, want, 1e-12), `#${n}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
        if (!isBody(t.model.item(n))) continue;
        // Built on both, or failed on both in the kernel's same words (a rechamfer of a face
        // that is no chamfer).
        const a = ns.find((s) => s.id === `i${n}`), b = answers.verbs.states[n];
        assert.deepStrictEqual([a.state, a.error ?? null], b, `#${n} ${fields.kind}`);
        if (a.state === "ok") {
            const [x, y] = [measure(t.doc, `i${n}`), answers.verbs.solids[n]];
            assert.ok(close(x, y, 1e-6), `#${n} ${fields.kind}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
            built++;
        }
        verbs.add(fields.kind === "remove" ? `${fields.kind} ${fields.what}` : fields.kind === "fillet" ? fields.style : fields.kind);
    }
    assert.strictEqual(built, 45);
    assert.deepStrictEqual([...verbs].sort(), ["box", "chamfer", "cut", "cylinder", "face", "intersect", "join", "press", "prism", "rechamfer", "refillet", "remove chamfer", "remove fillet", "round", "shell", "split", "surface", "thicken", "trim"]);
    // The layout: a flush after the verb, the in-plane move and the world place after it.
    assert.deepStrictEqual(t.nodes().filter((x) => x.id.startsWith("i12")).map((x) => [x.id, x.kind, x.solid ?? x.solids]), [
        ["i12_inner", "solid.join", ["i10", "i11"]], ["i12_flush", "solid.merge_flush", "i12_inner"], ["i12_moved", "solid.transform", "i12_flush"], ["i12", "solid.transform", "i12_moved"],
    ]);
    assert.deepStrictEqual([t.node("i9").kind, t.node("i9").solid, t.node("i9_inner").kind], ["solid.merge_flush", "i9_inner", "solid.common"]);
    // A trim: the curve as a NURBS, the sheet split along the sketch's normal, the faces dropped
    // by reference; the dropped indices are the page's (meta).
    const [tool, split, trim] = ["i26_tool", "i26_split", "i26"].map(t.node);
    assert.deepStrictEqual([tool.kind, tool.curve, split.kind, split.sheet, split.curve, trim.kind, trim.solid], ["curve.as_nurbs", "i25", "sheet.split_by_curve", "i24", "i26_tool", "solid.drop_faces", "i26_split"]);
    if (ALONG) assert.deepStrictEqual([split.along, split.direction], [t.node("i25").frame, undefined]);
    else assert.ok(close(split.direction, [0, -0.5, Math.sqrt(3) / 2], 1e-12), JSON.stringify(split.direction));
    assert.deepStrictEqual([trim.meta.forge.drop, trim.faces.length], [[1], 1]);
    // A fillet's edges: indices in the meta, references in the node.
    assert.deepStrictEqual([t.node("i33").meta.forge.edges, t.node("i33").edges.length, t.node("i33").edges[0].curve], [[1, 2], 2, 0]);
    // A press copies its face item's body and reference.
    assert.deepStrictEqual([t.node("i39").solid, t.node("i39").face], ["i37", t.node("i38").face]);
    assert.deepStrictEqual([t.node("i47").kind, t.node("i47").profile, t.node("i47_cut").curves, t.node("i51").plane, t.node("i54_inner").tool], ["solid.split_side_by_profile", "i47_cut", ["i45"], "i49", "i53"]);
    t.free();
}

// Picks: an index pick resolves to a reference off the evaluated document when it is made or
// its indices change (the command's own references taken as they are); a write that leaves
// it alone keeps the references (an edge the source moved away from is gone, in the
// kernel's words, when it does not find its edge any more). An index the solid has not refuses the command; a source that has not
// built makes the item a stand-in in those words, which builds once a write finds it.
{
    const t = fresh();
    t.run({ op: "primitive", id: 1, kind: "box", plane: "top", dims: [20, 20, 20] });
    t.run({ op: "fillet", id: 2, source: 1, radius: 2, style: "round" });
    assert.deepStrictEqual([t.node("i2").edges, t.item(2).edgeRefs, t.node("i1").hidden], [[], [], true]);
    t.run({ op: "set", id: 2, edges: [0, 1] });
    const refs = t.node("i2").edges;
    assert.strictEqual(refs.length, 2);
    assert.deepStrictEqual(t.item(2).edgeRefs, refs);
    assert.strictEqual(t.node("i2").meta.forge.edgeRefs, undefined);
    assert.strictEqual(solidNow(t, "i2").faces, 8);
    t.run({ op: "set", id: 2, name: "Rounded", radius: 3 });
    assert.deepStrictEqual(t.node("i2").edges, refs);
    // The source moved: the references stay as they were picked (the same indices picked
    // again too), until the edges picked change.
    t.run({ op: "set", id: 1, transform: { tx: 10, ty: 0, angle: 0, scale: 1 } });
    assert.deepStrictEqual(t.node("i2").edges, refs);
    t.run({ op: "set", id: 2, edges: [0, 1] });
    assert.deepStrictEqual(t.node("i2").edges, refs);
    t.run({ op: "set", id: 2, edges: [0] });
    assert.deepStrictEqual(t.node("i2").edges.map((e) => e.mid), [[0, 0, 0]]);
    assert.strictEqual(t.statusOf("i2").state, "ok");
    // The page's own references are taken as they are.
    const given = [refs[0]];
    t.run({ op: "set", id: 2, edges: [5], edgeRefs: given });
    assert.deepStrictEqual(t.node("i2").edges, given);
    const before = t.nodes();
    assert.throws(() => t.run({ op: "set", id: 2, edges: [0, 40] }), /^Error: edge 40 is not on the solid$/);
    assert.throws(() => t.run({ op: "face", id: 3, from: 1, face: 9 }), /^Error: face 9 is not on the solid$/);
    assert.deepStrictEqual(t.nodes(), before);
    // A source with no solid: a stand-in, built once a write finds the solid.
    t.run({ op: "set", id: 1, dims: [30, 30, -1] });
    t.run({ op: "set", id: 2, edges: [1] });
    assert.deepStrictEqual([t.node("i2").kind, t.node("i2").type], ["value.unresolved", "solid"]);
    assert.match(t.node("i2").why, /^i2: #1 has not been built$/);
    assert.deepStrictEqual([t.item(2).edges, t.item(2).name, t.item(2).radius], [[1], "Rounded", 3]);
    t.run({ op: "set", id: 1, dims: [30, 30, 30] });
    t.run({ op: "set", id: 2, edges: [1] });
    assert.deepStrictEqual([t.node("i2").kind, t.node("i2").edges.length, t.statusOf("i2").state], ["solid.fillet", 1, "ok"]);
    // A shell's face the page kept a reference to: found by it on the body as its verb made it.
    t.run({ op: "primitive", id: 4, kind: "box", plane: "top", dims: [20, 20, 20] });
    t.run({ op: "set", id: 4, place: { offset: [50, 0, 0], turn: [0, 0, 0] } });
    t.run({ op: "shell", id: 5, source: 4, thickness: 1, open: [0], openRefs: [[0, 0, 0, 20, 0, 0, 1, 28.284271247461902]] });
    assert.deepStrictEqual([t.node("i5").open[0].at, t.node("i5").open[0].normal], [[50, 0, 20], [0, 0, 1]]);
    assert.strictEqual(solidNow(t, "i5").faces, 11);
    t.free();
}

// Face items: a press, a refillet, a rechamfer or a remove copies its face item's body and
// reference into its node, so the face picked again reaches it, and the face gone makes it
// a stand-in. A command is refused while a preview or a batch is open, in the kernel's words.
{
    const t = fresh();
    t.run({ op: "primitive", id: 1, kind: "box", plane: "top", dims: [10, 10, 10] });
    t.run({ op: "face", id: 2, from: 1, face: 1 });
    assert.deepStrictEqual([t.item(2).plane, t.node("i2").solid, t.node("i2").face.normal], ["face:1:1", "i1", [0, 0, 1]]);
    t.run({ op: "press", id: 3, from: 2, height: 2 });
    assert.deepStrictEqual(t.node("i3").face, t.node("i2").face);
    t.run({ op: "set", id: 2, face: 0 });
    assert.deepStrictEqual(t.node("i2").face.normal, [0, 0, -1]);
    assert.deepStrictEqual(t.node("i3").face, t.node("i2").face);
    assert.ok(close(solidNow(t, "i3").bounds, [-5, -5, -2, 5, 5, 10]), JSON.stringify(solidNow(t, "i3").bounds));
    t.run({ op: "delete", ids: [2] });
    assert.deepStrictEqual([t.node("i3").kind, t.node("i3").why], ["value.unresolved", "i3: face #2 is gone"]);
    assert.deepStrictEqual(t.item(3).parts, [2]);
    wasm[K + "document_preview_begin"](t.doc);
    assert.throws(() => t.run({ op: "set", id: 1, dims: [5, 5, 5] }), /^Error: a preview is open$/);
    wasm[K + "document_end_preview"](t.doc);
    wasm[K + "document_batch_begin"](t.doc, "busy");
    assert.throws(() => t.run({ op: "set", id: 1, dims: [5, 5, 5] }), /^Error: a batch is open$/);
    wasm[K + "document_batch_abort"](t.doc);
    t.run({ op: "set", id: 1, dims: [5, 5, 5] });
    assert.strictEqual(t.node("i1").x, 5);
    t.free();
}

// A sketch deleted takes the bodies on it along -- by the item's plane, as the page did: a
// join of two boxes on the sketch (not moved, so no node of it is on the sketch's frame)
// goes too, and nothing stands in for it.
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 5 });
    t.run({ op: "primitive", id: 2, kind: "box", plane: 1, dims: [10, 10, 10] });
    t.run({ op: "primitive", id: 3, kind: "cylinder", plane: 1, dims: [3, 20] });
    t.run({ op: "join", id: 4, parts: [2, 3] });
    assert.deepStrictEqual([t.item(4).plane, t.node("i4").frame], [1, undefined]);
    t.run({ op: "delete", ids: [1] });
    assert.deepStrictEqual(t.model.items(), []);
    assert.deepStrictEqual(t.nodes(), []);
    t.free();
}

// A loft through sections outputs a body; a verb that wants a solid takes it (the reader
// checks what it got): a fillet and a shell on a solid loft build, no cast between. (A
// fillet of one of its spline edges is the kernel's to refuse, past the type check.)
{
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "rect", plane: "top", shape: { x0: -10, y0: -10, x1: 10, y1: 10 } });
    t.run({ op: "surface", id: 2, loops: [[1]], plane: "top" });
    for (const [s, off, r] of [[3, 10, 6], [5, 20, 8]]) {
        t.run({ op: "sketch", id: s, mode: "offset", base: "top", offset: off });
        t.run({ op: "add", id: s + 1, kind: "rect", plane: s, shape: { x0: -r, y0: -r, x1: r, y1: r } });
    }
    t.run({ op: "surface", id: 7, loops: [[6]], plane: 5 });
    t.run({ op: "surface", id: 8, loops: [[4]], plane: 3 });
    t.run({ op: "lofted", id: 9, from: 2, to: 7, via: [8] });
    assert.strictEqual(t.node("i9").kind, "solid.loft_through");
    t.run({ op: "fillet", id: 10, source: 9, radius: 0.5 });
    t.run({ op: "shell", id: 11, source: 9, thickness: 0.5, open: [0] });
    assert.deepStrictEqual([t.node("i10").solid, t.node("i11").solid], ["i9", "i9"]);
    // Kind and faces only: a loft's spline faces are slow to measure.
    const faces = (id) => {
        const s = wasm[K + "document_result_solid"](t.doc, id);
        try {
            return wasm[K + "face_count"](s);
        } finally {
            wasm[K + "solid_free"](s);
        }
    };
    for (const id of ["i9", "i10", "i11"]) assert.deepStrictEqual([id, t.statusOf(id).state, wasm[K + "document_result_kind"](t.doc, id)], [id, "ok", "solid"]);
    assert.ok(faces("i11") > faces("i9"));
    t.run({ op: "set", id: 10, edges: [0] });
    assert.match(t.statusOf("i10").error, /^fillet: a spline edge ending at a corner/);
    t.free();
}

// Place, move, rename, hide: a quick solid moved in its plane only ends in its in-plane
// `solid.transform` as `i<n>`, read back as its move (no transform kept in its meta); each
// drag frame is one `set` on one node and no meta op -- in its plane the `_moved` step (the
// head while nothing is placed), in the world the head; a rename and a hide one field of the
// head. Placed but not turned, the world step has no pivot, so an in-plane drag moves
// nothing else; turned, its pivot follows the move.
{
    const t = fresh();
    t.run({ op: "primitive", id: 1, kind: "box", plane: "top", dims: [10, 10, 10] });
    const ops = (cmd) => t.run(cmd).op.ops;
    const move = (tx, ty, angle) => ({ op: "set", id: 1, transform: { tx, ty, angle, scale: 1 } });
    const place = (x, rz) => ({ op: "set", id: 1, place: { offset: [x, 0, 0], turn: [0, 0, rz] } });
    t.run(move(3, 0, 0));
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i1_inner", "i1"]);
    assert.deepStrictEqual([t.node("i1").kind, t.node("i1").solid, t.node("i1").by, t.node("i1").turn_in], ["solid.transform", "i1_inner", [3, 0, 0], undefined]);
    assert.strictEqual(t.node("i1").meta.forge.transform, undefined);
    assert.deepStrictEqual(t.item(1).transform, { tx: 3, ty: 0, angle: 0, scale: 1 });
    assert.deepStrictEqual(ops(move(4, 1, 0.25)), [{ op: "set", id: "i1", fields: { by: [4, 1, 0], turn: [0, 0, t.node("i1").turn[2]] } }]);
    assert.deepStrictEqual(t.item(1).transform, { tx: 4, ty: 1, angle: 0.25, scale: 1 });
    assert.strictEqual(t.node("i1").meta.forge.transform, undefined);
    assert.deepStrictEqual(ops(move(5, 1, 0.25)), [{ op: "set", id: "i1", fields: { by: [5, 1, 0] } }]);
    // Placed: the move is `i1_moved`, the world step the head.
    t.run(place(20, 0));
    assert.deepStrictEqual(t.nodes().map((n) => n.id), ["i1_inner", "i1_moved", "i1"]);
    assert.deepStrictEqual([t.node("i1").solid, t.node("i1").pivot, t.node("i1").by], ["i1_moved", undefined, [20, 0, 0]]);
    assert.deepStrictEqual(ops(move(6, 1, 0.25)), [{ op: "set", id: "i1_moved", fields: { by: [6, 1, 0] } }]);
    assert.deepStrictEqual(ops(place(25, 0)), [{ op: "set", id: "i1", fields: { by: [25, 0, 0] } }]);
    assert.deepStrictEqual(ops(place(25, 30)), [{ op: "set", id: "i1", fields: { pivot: [6, 1, 0], turn: [0, 0, 30] } }]);
    assert.deepStrictEqual(ops(place(25, 40)), [{ op: "set", id: "i1", fields: { turn: [0, 0, 40] } }]);
    assert.deepStrictEqual(t.item(1).transform, { tx: 6, ty: 1, angle: 0.25, scale: 1 });
    assert.deepStrictEqual(t.item(1).place, { offset: [25, 0, 0], turn: [0, 0, 40] });
    assert.strictEqual(t.node("i1").meta.forge.transform, undefined);
    // A rename, a hide: one field of the head, no meta op.
    assert.deepStrictEqual(ops({ op: "set", id: 1, name: "Plinth" }), [{ op: "set", id: "i1", fields: { name: "Plinth" } }]);
    assert.deepStrictEqual(ops({ op: "set", id: 1, hidden: true }), [{ op: "set", id: "i1", fields: { hidden: true } }]);
    assert.deepStrictEqual([t.item(1).name, t.item(1).hidden], ["Plinth", true]);
    // Back home: the verb is `i1` again, its name and its hidden flag with it.
    t.run(place(0, 0));
    t.run(move(0, 0, 0));
    assert.deepStrictEqual(t.nodes().map((n) => [n.id, n.kind, n.name, n.hidden]), [["i1", "solid.cuboid", "Plinth", true]]);
    assert.strictEqual(t.statusOf("i1").state, "ok");
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// Copies follow their source: a value a verb's node copies from another item is written
// again by the command that writes that item, in the same batch. A sketch tilted under a
// trimmed curve turns the trim's split direction with it (the trim reads the sketch's frame
// through its curve); a split's curve moved to another plane takes the split's frame along.
// On a kernel with `along` the trim copies nothing: it names its curve's frame, the tilt is
// one write, and even a raw op on the frame turns the split (no copy goes stale).
if (ALONG) {
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "line", plane: "top", shape: { x0: 0, y0: 50, x1: 10, y1: 50 } });
    t.run({ op: "sketch", id: 2, mode: "angle", hinge: 1, tilt: 30 });
    t.run({ op: "add", id: 3, kind: "rect", plane: 2, shape: { x0: -20, y0: -20, x1: 20, y1: 20 } });
    t.run({ op: "surface", id: 4, loops: [[3]], plane: 2 });
    t.run({ op: "add", id: 5, kind: "circle", plane: 2, shape: { cx: 3, cy: -2, r: 8 } });
    t.run({ op: "trim", id: 6, sheet: 4, tool: 5 });
    assert.deepStrictEqual([t.node("i6_split").along, t.node("i6_split").direction], [t.node("i5").frame, undefined]);
    const { op } = t.run({ op: "set", id: 2, tilt: 60 });
    assert.deepStrictEqual(op.ops.map((o) => [o.op, o.id]), [["set", "i2_frame"]]);
    assert.strictEqual(t.statusOf("i6").state, "ok");
    t.raw({ op: "set", id: "i2_frame", fields: { tilt: 45 } });
    assert.strictEqual(t.statusOf("i6").state, "ok");
    t.free();
}
{
    const t = fresh();
    t.run({ op: "add", id: 1, kind: "line", plane: "top", shape: { x0: 0, y0: 50, x1: 10, y1: 50 } });
    t.run({ op: "sketch", id: 2, mode: "angle", hinge: 1, tilt: 30 });
    t.run({ op: "add", id: 3, kind: "rect", plane: 2, shape: { x0: -20, y0: -20, x1: 20, y1: 20 } });
    t.run({ op: "surface", id: 4, loops: [[3]], plane: 2 });
    t.run({ op: "add", id: 5, kind: "circle", plane: 2, shape: { cx: 3, cy: -2, r: 8 } });
    t.run({ op: "trim", id: 6, sheet: 4, tool: 5 });
    if (!ALONG) {
    assert.ok(close(t.node("i6_split").direction, [0, -0.5, Math.sqrt(3) / 2], 1e-12), JSON.stringify(t.node("i6_split").direction));
    const { op } = t.run({ op: "set", id: 2, tilt: 60 });
    assert.deepStrictEqual(op.ops.map((o) => [o.op, o.id]), [["set", "i2_frame"], ["set", "i6_split"]]);
    assert.ok(close(t.node("i6_split").direction, [0, -Math.sqrt(3) / 2, 0.5], 1e-12), JSON.stringify(t.node("i6_split").direction));
    assert.strictEqual(t.statusOf("i6").state, "ok");
    // A write that moves nothing it copies writes nothing more.
    assert.deepStrictEqual(t.run({ op: "set", id: 5, shape: { cx: 3, cy: -2, r: 7 } }).op.ops.map((o) => o.id), ["i5"]);
    // Undone, the direction goes back with the tilt: one commit.
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    assert.ok(close(t.node("i6_split").direction, [0, -0.5, Math.sqrt(3) / 2], 1e-12));
    }

    t.run({ op: "primitive", id: 7, kind: "box", plane: "top", dims: [10, 10, 10] });
    t.run({ op: "set", id: 7, place: { offset: [200, 0, 0], turn: [0, 0, 0] } });
    t.run({ op: "add", id: 8, kind: "rect", plane: "top", shape: { x0: 190, y0: -20, x1: 202, y1: 3 } });
    t.run({ op: "split", target: 7, ids: [9, 10], cutter: 8 });
    assert.deepStrictEqual([t.node("i9").frame, t.node("i10").frame], ["xy", "xy"]);
    const before = solidNow(t, "i10");
    const moved = t.run({ op: "set", id: 8, plane: "front" }).op;
    assert.deepStrictEqual(moved.ops.map((o) => [o.op, o.id]), [["set", "i8"], ["set", "i9"], ["set", "i10"]]);
    assert.deepStrictEqual([t.node("i9").frame, t.node("i10").frame], ["xz", "xz"]);
    for (const id of ["i9", "i10"]) assert.strictEqual(t.statusOf(id).state, "ok", id);
    const after = solidNow(t, "i10");
    assert.ok(!close(after.bounds, before.bounds), JSON.stringify([before.bounds, after.bounds]));
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// A version-1 file's items (`state`) are refused in words, the document untouched; an
// unknown command and a bad id are refused as the page refused them.
{
    const t = fresh();
    const before = t.revision();
    assert.throws(() => t.run({ op: "state", items: [], counters: { line: 1 } }), /^Error: state: a version-1 forge file's items are not loaded; open a document$/);
    assert.deepStrictEqual([t.revision(), t.meta()], [before, null]);
    assert.throws(() => t.run({ op: "frobnicate" }), /^Error: unknown command frobnicate$/);
    assert.throws(() => t.run({ op: "add", id: -1 }), /add: `id` is not an id/);
    assert.throws(() => t.run({ op: "join", id: 1, parts: [7] }), /^Error: join: item 7 is not there$/);
    assert.throws(() => sketchFillet(wasm, [{ kind: "line", shape: { x0: 0, y0: 0, x1: 1, y1: 0 } }, { kind: "line", shape: { x0: 5, y0: 5, x1: 6, y1: 5 } }], 1), /do not meet/);
    t.free();
}

// A sketch's curves solved the way the page solves them (its session, built from the curve
// items and the stored records, then written back): each curve's shape by id.
function solvedSketch(t, s, edit = (m) => solveModel(wasm, m)) {
    const items = pageItems(t.model);
    const sketch = items.find((c) => c.id === s);
    const curves = items.filter((c) => c.plane === s && c.shape !== undefined);
    const m = buildModel(wasm, sketch, curves);
    assert.deepStrictEqual([m.stale, m.refused], [[], []], "every record applies");
    edit(m);
    const moved = new Map(writeBack(wasm, m, new Map(curves.map((c) => [c.id, c]))).map((x) => [x.id, x.shape]));
    freeModel(wasm, m);
    return new Map(curves.map((c) => [c.id, moved.get(c.id) ?? c.shape]));
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
// A refused command: its words, and the document as it was.
function refused(t, cmd, words) {
    const before = JSON.stringify(t.nodes()), rev = t.revision();
    assert.throws(() => t.run(cmd), (e) => e instanceof Error && words.test(e.message), JSON.stringify(cmd));
    assert.strictEqual(JSON.stringify(t.nodes()), before);
    assert.strictEqual(t.revision(), rev);
}

// sketch_pattern, circular about the sketch origin: the copies and the two construction step
// lines as curve items on the sketch, the session's holds as records (ROTATED, the step lines'
// equal length, a driving angle), the first step line's start fixed as the origin. The
// source's radius and the angle record drive every copy; undo takes it back whole.
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "circle", plane: 1, shape: { cx: 10, cy: 0, r: 3 } });
    const before = JSON.stringify(t.nodes());
    t.run({ op: "sketch_pattern", sketch: 1, ids: [2], type: "circular", centre: null, count: 6, angle: 360, copies: [3, 4, 5, 6, 7, 8, 9] });
    const copies = [3, 4, 5, 6, 7].map((n) => t.item(n));
    assert.deepStrictEqual(copies.map((c) => [c.kind, c.plane, c.name]), [3, 4, 5, 6, 7].map((n) => ["circle", 1, `Circle ${n - 1}`]));
    copies.forEach((c, i) => {
        const a = Math.PI / 3 * (i + 1);
        assert.ok(near(c.shape.cx, 10 * Math.cos(a)) && near(c.shape.cy, 10 * Math.sin(a)) && near(c.shape.r, 3), JSON.stringify(c.shape));
    });
    const steps = [8, 9].map((n) => t.item(n));
    assert.deepStrictEqual(steps.map((c) => [c.kind, c.construction]), [["line", true], ["line", true]]);
    assert.ok(near(steps[0].shape.x0, 0) && near(steps[0].shape.y0, 0) && near(steps[0].shape.x1, 10) && near(steps[0].shape.y1, 0), JSON.stringify(steps[0].shape));
    assert.strictEqual(t.meta().nextId, 10);
    const records = t.item(1).constraints;
    const kinds = records.map((k) => k.kind);
    assert.strictEqual(kinds.filter((k) => k === "rotated").length, 4, JSON.stringify(kinds));
    const angle = records.filter((k) => k.kind === "angle");
    assert.strictEqual(angle.length, 1);
    assert.ok(near(angle[0].value, Math.PI / 3) && angle[0].driving === true);
    assert.ok(records.some((k) => k.kind === "fix" && k.refs[0].curve === 8 && k.refs[0].at === "start"), "the origin is the first step line's start, fixed");
    assert.deepStrictEqual(records.map((k) => k.id), records.map((_, i) => i + 1));
    // the sketch as stored solves where the pattern put it
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    // the source's radius typed as 4 drives every copy (the page's typed radius: a driving
    // radius held while its centre is pinned where it is, as forge.js's typed shape edit does)
    const grown = solvedSketch(t, 1, (m) => {
        assert.ok(addConstraint(wasm, m, { id: 999, kind: "radius", refs: [{ curve: 2, at: "curve" }], value: 4, driving: true }).ok);
        dragModel(wasm, m, [{ curve: 2, at: "centre", x: 10, y: 0 }]);
        removeConstraint(wasm, m, 999);
    });
    for (const n of [2, 3, 4, 5, 6, 7]) assert.ok(near(grown.get(n).r, 4), `#${n} r ${grown.get(n).r}`);
    // the angle record re-spaces them
    // (the page's dimension edit: `setValue` on the session, forge.js `editDimension`)
    const spaced = solvedSketch(t, 1, (m) => assert.ok(setValue(wasm, m, angle[0].id, Math.PI / 6).ok));
    const polar = [2, 3, 4, 5, 6, 7].map((n) => [Math.hypot(spaced.get(n).cx, spaced.get(n).cy), Math.atan2(spaced.get(n).cy, spaced.get(n).cx)]);
    polar.forEach(([r, a], i) => {
        assert.ok(near(r, polar[0][0], 1e-7), `#${i + 2} at radius ${r}`);
        if (i) assert.ok(near(Math.cos(a - polar[i - 1][1]), Math.cos(Math.PI / 6), 1e-7) && Math.sin(a - polar[i - 1][1]) > 0, `#${i + 2} turned ${(a - polar[i - 1][1]) * 180 / Math.PI}`);
    });
    // undo: the document as it was before the pattern, node for node
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    assert.strictEqual(JSON.stringify(t.nodes()), before);
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// sketch_pattern, circular about a picked point (another circle's centre), part of a turn:
// both ends occupied (step = angle / (count - 1))
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "circle", plane: 1, shape: { cx: 5, cy: 5, r: 1 } });
    t.run({ op: "add", id: 3, kind: "line", plane: 1, shape: { x0: 10, y0: 5, x1: 12, y1: 5 } });
    t.run({ op: "sketch_pattern", sketch: 1, ids: [3], type: "circular", centre: { curve: 2, at: "centre" }, count: 3, angle: 180, copies: [4, 5, 6, 7] });
    const [a, b] = [t.item(4).shape, t.item(5).shape];
    assert.ok(near(a.x0, 5) && near(a.y0, 10) && near(a.x1, 5) && near(a.y1, 12), JSON.stringify(a));
    assert.ok(near(b.x0, 0) && near(b.y0, 5) && near(b.x1, -2) && near(b.y1, 5), JSON.stringify(b));
    assert.ok(t.item(1).constraints.some((k) => k.kind === "coincident" && k.refs.some((r) => r.curve === 2 && r.at === "centre")), "the step lines start on the picked centre");
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    t.free();
}

// sketch_pattern, rectangular: a line on a 3 x 2 grid, held by TRANSLATED records and the
// step dimensions; a rectangle copied stays a rectangle
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: 0, x1: 2, y1: 1 } });
    t.run({ op: "sketch_pattern", sketch: 1, ids: [2], type: "rectangular", d1: [1, 0], count1: 3, spacing1: 5, d2: [0, 1], count2: 2, spacing2: 4, copies: [3, 4, 5, 6, 7] });
    [[5, 0], [10, 0], [0, 4], [5, 4], [10, 4]].forEach(([dx, dy], i) => {
        const s = t.item(3 + i).shape;
        assert.ok(near(s.x0, dx) && near(s.y0, dy) && near(s.x1, 2 + dx) && near(s.y1, 1 + dy), `#${3 + i} ${JSON.stringify(s)}`);
    });
    assert.ok(t.item(1).constraints.some((k) => k.kind === "translated"));
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    t.run({ op: "add", id: 8, kind: "rect", plane: 1, shape: { x0: 20, y0: 0, x1: 24, y1: 2 } });
    t.run({ op: "sketch_pattern", sketch: 1, ids: [8], type: "rectangular", d1: [0, 1], count1: 2, spacing1: 3, count2: 1, copies: [9] });
    assert.deepStrictEqual([t.item(9).kind, t.item(9).shape].map((v) => JSON.stringify(v)), ['"rect"', JSON.stringify({ x0: 20, y0: 3, x1: 24, y1: 5 })]);
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    // turned, a rectangle is a closed polyline
    t.run({ op: "sketch_pattern", sketch: 1, ids: [8], type: "circular", centre: null, count: 4, angle: 360, copies: [10, 11, 12, 13, 14] });
    assert.strictEqual(t.item(10).kind, "polyline");
    assert.ok(close(t.item(10).shape.points, [[0, 20], [0, 24], [-2, 24], [-2, 20]], 1e-9), JSON.stringify(t.item(10).shape));
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    t.free();
}

// sketch_pattern refusals: each in the command's words, the document untouched
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "circle", plane: 1, shape: { cx: 10, cy: 0, r: 3 } });
    t.run({ op: "sketch", id: 3, mode: "offset", base: "front", offset: 0 });
    t.run({ op: "add", id: 4, kind: "circle", plane: 3, shape: { cx: 10, cy: 0, r: 3 } });
    const circ = { op: "sketch_pattern", sketch: 1, ids: [2], type: "circular", centre: null, count: 6, angle: 360, copies: [10, 11, 12, 13, 14, 15, 16] };
    refused(t, { ...circ, ids: [] }, /^sketch_pattern: nothing to pattern/);
    refused(t, { ...circ, ids: [2, 4] }, /^sketch_pattern: #4 is not a curve on sketch #1/);
    refused(t, { ...circ, count: 1 }, /^sketch_pattern: `count` must be/);
    refused(t, { ...circ, angle: 0 }, /^sketch_pattern: the angle must be/);
    refused(t, { ...circ, angle: 400 }, /^sketch_pattern: the angle must be/);
    refused(t, { op: "sketch_pattern", sketch: 1, ids: [2], type: "rectangular", d1: [0, 0], count1: 3, spacing1: 5, count2: 1, copies: [10, 11] }, /^sketch_pattern: a zero direction/);
    t.free();
}

// sketch_mirror: a right triangle's two free sides mirrored across its vertical side. The
// points on the line are not copied: each copy's end there is a `coincident` record onto
// its source's; the free corner is reflected exactly and held by a `symmetric` record.
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: 0, x1: 0, y1: 5 } });
    t.run({ op: "add", id: 3, kind: "line", plane: 1, shape: { x0: 0, y0: 5, x1: 4, y1: 0 } });
    t.run({ op: "add", id: 4, kind: "line", plane: 1, shape: { x0: 4, y0: 0, x1: 0, y1: 0 } });
    const before = JSON.stringify(t.nodes());
    t.run({ op: "sketch_mirror", sketch: 1, ids: [3, 4], line: 2, copies: [5, 6] });
    assert.deepStrictEqual([t.item(5).kind, t.item(6).kind], ["line", "line"]);
    assert.deepStrictEqual(t.item(5).shape, { x0: 0, y0: 5, x1: -4, y1: 0 });
    assert.deepStrictEqual(t.item(6).shape, { x0: -4, y0: 0, x1: 0, y1: 0 });
    assert.deepStrictEqual(t.model.items().map((i) => i.id), [1, 2, 3, 4, 5, 6]);
    const records = t.item(1).constraints;
    const has = (kind, a, b) => records.some((k) => k.kind === kind && k.refs.length >= 2
        && ((k.refs[0].curve === a.curve && k.refs[0].at === a.at && k.refs[1].curve === b.curve && k.refs[1].at === b.at)
            || (k.refs[1].curve === a.curve && k.refs[1].at === a.at && k.refs[0].curve === b.curve && k.refs[0].at === b.at)));
    assert.ok(has("coincident", { curve: 5, at: "start" }, { curve: 3, at: "start" }), JSON.stringify(records));
    assert.ok(has("coincident", { curve: 6, at: "end" }, { curve: 4, at: "end" }), JSON.stringify(records));
    assert.ok(records.some((k) => k.kind === "symmetric" && k.refs[2].curve === 2 && k.refs[2].at === "curve"), JSON.stringify(records));
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    // the free corner dragged: its mirror follows
    const dragged = solvedSketch(t, 1, (m) => dragModel(wasm, m, [{ curve: 3, at: "end", x: 6, y: 1 }]));
    {
        // reflected across the line where the solve left it
        const L = dragged.get(2), [px, py] = [dragged.get(3).x1, dragged.get(3).y1];
        const [ux, uy] = [L.x1 - L.x0, L.y1 - L.y0], u = Math.hypot(ux, uy);
        const along = ((px - L.x0) * ux + (py - L.y0) * uy) / (u * u);
        const [fx, fy] = [L.x0 + along * ux, L.y0 + along * uy];
        assert.ok(near(dragged.get(5).x1, 2 * fx - px, 1e-7) && near(dragged.get(5).y1, 2 * fy - py, 1e-7), JSON.stringify([...dragged]));
    }
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    assert.strictEqual(JSON.stringify(t.nodes()), before);
    t.free();
}

// sketch_mirror of a circle: its copy held to its radius (`equal_radius`), so a typed radius
// on the source moves the copy too; an arc mirrored runs the other way round
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: -10, x1: 0, y1: 10 } });
    t.run({ op: "add", id: 3, kind: "circle", plane: 1, shape: { cx: 5, cy: 2, r: 1.5 } });
    t.run({ op: "add", id: 4, kind: "arc", plane: 1, shape: { x0: 8, y0: 0, xm: 9, ym: 1, x1: 10, y1: 0 } });
    t.run({ op: "sketch_mirror", sketch: 1, ids: [3, 4], line: 2, copies: [5, 6] });
    assert.ok(close(t.item(5).shape, { cx: -5, cy: 2, r: 1.5 }, 1e-12), JSON.stringify(t.item(5).shape));
    assert.ok(close(t.item(6).shape, { x0: -8, y0: 0, xm: -9, ym: 1, x1: -10, y1: 0 }, 1e-9), JSON.stringify(t.item(6).shape));
    assert.ok(t.item(1).constraints.some((k) => k.kind === "equal_radius" && k.refs.some((r) => r.curve === 3) && k.refs.some((r) => r.curve === 5)));
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    const grown = solvedSketch(t, 1, (m) => {
        assert.ok(addConstraint(wasm, m, { id: 999, kind: "radius", refs: [{ curve: 3, at: "curve" }], value: 2.5, driving: true }).ok);
        dragModel(wasm, m, [{ curve: 3, at: "centre", x: 5, y: 2 }]);
        removeConstraint(wasm, m, 999);
    });
    assert.ok(near(grown.get(3).r, 2.5) && near(grown.get(5).r, 2.5), JSON.stringify([grown.get(3), grown.get(5)]));
    t.free();
}

// sketch_mirror: an open polyline with both ends on a construction line closes onto its
// mirror -- the session's profiles hold one loop
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: -10, x1: 0, y1: 10 } });
    t.run({ op: "set", id: 2, construction: true });
    t.run({ op: "add", id: 3, kind: "polyline", plane: 1, shape: { points: [[0, 5], [4, 2], [4, -2], [0, -5]], closed: false } });
    t.run({ op: "sketch_mirror", sketch: 1, ids: [3], line: 2, copies: [4] });
    assert.ok(close(t.item(4).shape.points, [[0, 5], [-4, 2], [-4, -2], [0, -5]], 1e-12), JSON.stringify(t.item(4).shape));
    const items = pageItems(t.model);
    const m = buildModel(wasm, items.find((c) => c.id === 1), items.filter((c) => c.plane === 1 && c.shape !== undefined));
    assert.deepStrictEqual([m.stale, m.refused], [[], []]);
    solveModel(wasm, m);
    const loops = wasm[K + "sketch_profiles"](m.h, 0);
    assert.strictEqual(wasm[K + "profile_list_count"](loops), 1);
    wasm[K + "profile_list_free"](loops);
    freeModel(wasm, m);
    t.free();
}

// sketch_mirror refusals
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: -10, x1: 0, y1: 10 } });
    t.run({ op: "add", id: 3, kind: "circle", plane: 1, shape: { cx: 5, cy: 2, r: 1.5 } });
    refused(t, { op: "sketch_mirror", sketch: 1, ids: [2], line: 3, copies: [9] }, /^sketch_mirror: `line` is not a line/);
    refused(t, { op: "sketch_mirror", sketch: 1, ids: [2, 3], line: 2, copies: [9, 10] }, /^sketch_mirror: the line is among/);
    refused(t, { op: "sketch_mirror", sketch: 1, ids: [], line: 2, copies: [] }, /^sketch_mirror: nothing to mirror/);
    t.free();
}

// sketch_mirror of a polygon: its vertices go round the other way, so copy vertex k is the
// mirror of source vertex -k; the stored records re-solve to where the mirror put it
{
    const t = fresh();
    t.run({ op: "sketch", id: 1, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 2, kind: "line", plane: 1, shape: { x0: 0, y0: -10, x1: 0, y1: 10 } });
    t.run({ op: "add", id: 3, kind: "polygon", plane: 1, shape: { cx: 5, cy: -5, r: 2, sides: 5, angle: 10 } });
    t.run({ op: "sketch_mirror", sketch: 1, ids: [3], line: 2, copies: [4] });
    assert.ok(close(t.item(4).shape, { cx: -5, cy: -5, r: 2, sides: 5, angle: 170 }, 1e-9), JSON.stringify(t.item(4).shape));
    for (const [id, shape] of solvedSketch(t, 1)) assert.ok(close(shape, t.item(id).shape, 1e-9), `#${id} moved on a re-solve`);
    t.free();
}

// A box's bounds turned `deg` about the world Z through the origin: the box of its eight
// corners turned (exact for a box).
function turnedBounds(b, deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const xs = [], ys = [];
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) { xs.push(c * x - s * y); ys.push(s * x + c * y); }
    return [Math.min(...xs), Math.min(...ys), b[2], Math.max(...xs), Math.max(...ys), b[5]];
}
const BOX_AT = (id, s, x, y) => [{ op: "primitive", id, kind: "box", plane: "top", dims: [s, s, s] }, { op: "set", id, place: { offset: [x, y, 0], turn: [0, 0, 0] } }];

// pattern of bodies, circular about Z: one group item (kind `pattern`, no parts: the sources
// stay tips) whose head `i<id>` is `solid.pattern` over `i<id>_at` `placements.circular`, and
// one instance item per (placement >= 1, source), instance-major, each `solid.nth` of the
// list, named "<source> <p+1>". An edit of a source flows into its instances; a `set` of
// the group's count re-makes the instances in one command; undo takes it all back.
{
    const t = fresh();
    for (const c of [...BOX_AT(1, 4, 20, 0), ...BOX_AT(2, 2, 30, 5)]) t.run(c);
    const before = JSON.stringify(t.nodes());
    const ids = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    t.run({ op: "pattern", id: 3, sources: [1, 2], type: "circular", axis: "z", count: 6, instances: ids });
    assert.deepStrictEqual(t.node("i3_at"), { id: "i3_at", kind: "placements.circular", axis: "xy", count: 6 });
    assert.deepStrictEqual([t.node("i3").kind, t.node("i3").solids, t.node("i3").placements, t.node("i3").combine], ["solid.pattern", ["i1", "i2"], "i3_at", "separate"]);
    const g = t.item(3);
    assert.deepStrictEqual([g.kind, g.name, g.sources, g.type, g.axis, g.count, g.instances, g.parts], ["pattern", "Pattern 1", [1, 2], "circular", "z", 6, ids, undefined]);
    assert.deepStrictEqual(t.model.items().filter((i) => i.kind === "instance").map((i) => i.id), ids);
    assert.ok(!isBody(t.model.item(3)) && isBody(t.model.item(4)));
    assert.deepStrictEqual(ids.map((n) => t.item(n).name), ["Box 1 2", "Box 2 2", "Box 1 3", "Box 2 3", "Box 1 4", "Box 2 4", "Box 1 5", "Box 2 5", "Box 1 6", "Box 2 6"]);
    assert.deepStrictEqual(ids.map((n) => [t.node(`i${n}`).kind, t.node(`i${n}`).list, t.node(`i${n}`).index]), ids.map((_, k) => ["solid.nth", "i3", k + 2]));
    assert.deepStrictEqual([t.item(7).pattern, t.item(7).index, t.item(7).source, t.item(7).kind, t.item(7).parts], [3, 5, 2, "instance", []]);
    assert.ok(!t.item(1).hidden && !t.item(2).hidden, "the sources are not consumed");
    const b1 = solidNow(t, "i1"), b2 = solidNow(t, "i2");
    ids.forEach((n, k) => assert.ok(close(solidOf(t.doc, `i${n}`).volume, k % 2 ? 8 : 64, 1e-9), `#${n} ${solidOf(t.doc, `i${n}`).volume}`));
    // (p = 2, s = 1): box 2 turned 120 degrees
    assert.ok(close(solidOf(t.doc, "i7").bounds, turnedBounds(b2.bounds, 120), 1e-3), JSON.stringify([solidOf(t.doc, "i7").bounds, turnedBounds(b2.bounds, 120)]));
    assert.ok(close(solidOf(t.doc, "i4").bounds, turnedBounds(b1.bounds, 60), 1e-3));
    // the source's size: every instance of it follows
    t.run({ op: "set", id: 1, dims: [5, 5, 5] });
    for (const n of [4, 6, 8, 10, 12]) assert.ok(close(solidNow(t, `i${n}`).volume, 125, 1e-9), `#${n}`);
    // the count set to 4: the group and its instances re-made in one command
    const rev = t.revision();
    t.run({ op: "set", id: 3, count: 4 });
    assert.strictEqual(t.revision(), rev + 1);
    assert.strictEqual(t.node("i3_at").count, 4);
    assert.deepStrictEqual(t.item(3).instances, [4, 5, 6, 7, 8, 9]);
    assert.deepStrictEqual(t.model.items().filter((i) => i.kind === "instance").map((i) => [i.id, i.name]), [[4, "Box 1 2"], [5, "Box 2 2"], [6, "Box 1 3"], [7, "Box 2 3"], [8, "Box 1 4"], [9, "Box 2 4"]]);
    for (const n of [10, 11, 12, 13]) assert.strictEqual(t.node(`i${n}`), undefined);
    assert.ok(close(solidNow(t, "i7").bounds, turnedBounds(b2.bounds, 180), 1e-3));
    // up again: the command names the new ids
    t.run({ op: "set", id: 3, count: 5, instances: [4, 5, 6, 7, 8, 9, 14, 15] });
    assert.deepStrictEqual(t.model.items().filter((i) => i.kind === "instance").map((i) => i.id), [4, 5, 6, 7, 8, 9, 14, 15]);
    assert.strictEqual(t.meta().nextId, 16);
    // too few ids: refused, nothing written
    refused(t, { op: "set", id: 3, count: 7 }, /^pattern: fewer `instances` ids than instances/);
    // undo, back to before the pattern (the three sets, then the pattern)
    for (let k = 0; k < 4; k++) t.model.refresh(wasm[K + "document_undo"](t.doc));
    assert.strictEqual(JSON.stringify(t.nodes()), before);
    assert.deepStrictEqual(t.model.nodes(), t.nodes());
    t.free();
}

// skip: the skipped placement is absent, the rest named in order; rectangular and along a
// sketch line (its `curve.as_nurbs` the path) once each; an axis picked off geometry is
// numbers; the pattern round-trips through a save and a load (the same page items).
{
    const t = fresh();
    for (const c of BOX_AT(1, 2, 10, 0)) t.run(c);
    t.run({ op: "pattern", id: 2, sources: [1], type: "circular", count: 6, skip: [2], instances: [3, 4, 5, 6, 7] });
    assert.deepStrictEqual(t.node("i2_at").skip, [2]);
    assert.deepStrictEqual(t.item(2).instances, [3, 4, 5, 6]);
    assert.deepStrictEqual([3, 4, 5, 6].map((n) => [t.item(n).name, t.item(n).index]), [["Box 1 2", 1], ["Box 1 3", 2], ["Box 1 4", 3], ["Box 1 5", 4]]);
    const b = solidNow(t, "i1").bounds;
    // index 2 (120 degrees) skipped: the second instance is the one at 180
    assert.ok(close(solidOf(t.doc, "i4").bounds, turnedBounds(b, 180), 1e-3), JSON.stringify(solidOf(t.doc, "i4").bounds));
    t.run({ op: "pattern", id: 8, sources: [1], type: "rectangular", d1: "x", count1: 3, spacing1: 5, d2: [0, 1, 0], count2: 2, spacing2: 7, instances: [9, 10, 11, 12, 13] });
    assert.deepStrictEqual(t.node("i8_at"), { id: "i8_at", kind: "placements.rectangular", direction1: [1, 0, 0], count1: 3, spacing1: 5, direction2: [0, 1, 0], count2: 2, spacing2: 7 });
    [[5, 0], [10, 0], [0, 7], [5, 7], [10, 7]].forEach(([dx, dy], k) => {
        const got = solidNow(t, `i${9 + k}`).bounds;
        assert.ok(close(got, [b[0] + dx, b[1] + dy, b[2], b[3] + dx, b[4] + dy, b[5]], 1e-6), `#${9 + k} ${JSON.stringify(got)}`);
    });
    t.run({ op: "sketch", id: 14, mode: "offset", base: "top", offset: 0 });
    t.run({ op: "add", id: 15, kind: "line", plane: 14, shape: { x0: 0, y0: 0, x1: 0, y1: 30 } });
    t.run({ op: "pattern", id: 16, sources: [1], type: "along", path: 15, count: 4, instances: [17, 18, 19] });
    assert.deepStrictEqual(t.node("i16_path"), { id: "i16_path", kind: "curve.as_nurbs", curve: "i15" });
    assert.deepStrictEqual(t.node("i16_at"), { id: "i16_at", kind: "placements.along", path: "i16_path", count: 4 });
    [10, 20, 30].forEach((dy, k) => {
        const got = solidNow(t, `i${17 + k}`).bounds;
        assert.ok(close(got, [b[0], b[1] + dy, b[2], b[3], b[4] + dy, b[5]], 1e-6), `#${17 + k} ${JSON.stringify(got)}`);
    });
    assert.deepStrictEqual([t.item(16).path, t.item(16).type, t.item(16).count], [15, "along", 4]);
    // the axis picked off geometry: numbers, a `frame.at` helper (and Y, the world's, the same)
    t.run({ op: "pattern", id: 20, sources: [1], type: "circular", axis: { origin: [10, 0, 0], dir: [0, 0, 1] }, count: 2, angle: 180, instances: [21] });
    assert.deepStrictEqual(t.node("i20_axis"), { id: "i20_axis", kind: "frame.at", origin: [10, 0, 0], normal: [0, 0, 1] });
    assert.strictEqual(t.node("i20_at").axis, "i20_axis");
    assert.deepStrictEqual(t.item(20).axis, { origin: [10, 0, 0], dir: [0, 0, 1] });
    assert.ok(close(solidNow(t, "i21").bounds, b, 1e-6), "a box centred on the axis turned half a turn is where it was");
    t.run({ op: "pattern", id: 22, sources: [1], type: "circular", axis: "y", count: 4, instances: [23, 24, 25] });
    assert.deepStrictEqual(t.node("i22_axis"), { id: "i22_axis", kind: "frame.at", origin: [0, 0, 0], normal: [0, 1, 0] });
    assert.strictEqual(t.item(22).axis, "y");
    // a quarter turn about +Y takes +X to -Z
    assert.ok(close(solidNow(t, "i23").bounds, [b[2], b[1], -b[3], b[5], b[4], -b[0]], 1e-6), JSON.stringify(solidOf(t.doc, "i23").bounds));
    t.run({ op: "pattern", id: 26, sources: [1], type: "circular", axis: "x", count: 2, instances: [27] });
    assert.strictEqual(t.node("i26_at").axis, "yz");
    // a save, a load: the same page items
    const items = pageItems(t.model);
    const text = wasm[K + "document_save"](t.doc);
    const again = wasm[K + "document_load"](text);
    assert.deepStrictEqual(pageItems(new Model(wasm, again)), items);
    wasm[K + "document_free"](again);
    t.free();
}

// pattern refusals: in the command's words, the document untouched
{
    const t = fresh();
    for (const c of BOX_AT(1, 2, 10, 0)) t.run(c);
    t.run({ op: "sketch", id: 2, mode: "offset", base: "top", offset: 0 });
    refused(t, { op: "pattern", id: 3, sources: [], type: "circular", count: 6, instances: [4, 5, 6, 7, 8] }, /^pattern: nothing to pattern/);
    refused(t, { op: "pattern", id: 3, sources: [1], type: "circular", count: 1, instances: [4] }, /^pattern: `count` must be a whole number, 2 or more/);
    refused(t, { op: "pattern", id: 3, sources: [1], type: "along", path: 2, count: 3, instances: [4, 5] }, /^pattern: the path is not a curve/);
    refused(t, { op: "pattern", id: 3, sources: [2], type: "circular", count: 3, instances: [4, 5] }, /^pattern: #2 is not a body/);
    refused(t, { op: "pattern", id: 3, sources: [1], type: "circular", count: 3, skip: [0], instances: [4, 5] }, /^pattern: the original \(instance 0\) cannot be skipped/);
    t.free();
}

// A pattern group deleted takes its instances along; a source deleted leaves the group and
// its instances standing, failed (the group a stand-in, the instances blocked by it).
{
    const t = fresh();
    for (const c of BOX_AT(1, 2, 10, 0)) t.run(c);
    t.run({ op: "pattern", id: 2, sources: [1], type: "circular", count: 3, instances: [3, 4] });
    t.run({ op: "delete", ids: [2] });
    assert.deepStrictEqual(t.model.items().map((i) => [i.id, i.kind]), [[1, "box"]]);
    t.model.refresh(wasm[K + "document_undo"](t.doc));
    t.run({ op: "delete", ids: [1] });
    assert.deepStrictEqual(t.model.items().map((i) => [i.id, i.kind]), [[2, "pattern"], [3, "instance"], [4, "instance"]]);
    assert.deepStrictEqual([t.statusOf("i2").state, t.statusOf("i3").state, t.statusOf("i3").by], ["error", "blocked", "i2"]);
    t.free();
}

// A plate with an off-centre hole cut (a cylinder at x 10 through a 40 x 40 x 4 plate).
const PLATE = [
    { op: "primitive", id: 1, kind: "box", plane: "top", dims: [40, 40, 4] },
    { op: "primitive", id: 2, kind: "cylinder", plane: "top", dims: [2, 10] },
    { op: "set", id: 2, place: { offset: [10, 0, -3], turn: [0, 0, 0] } },
    { op: "cut", id: 3, parts: [1, 2] },
];
const HOLE = Math.PI * 2 * 2 * 4;

// pattern_feature: the cut's tool placed again on the cut's target (its target and tool,
// not its result), one item at the chain's end that consumes the cut; 4 about Z: the plate
// less 4 holes. A change of the cut's parts reaches it (a copy, see Copies). A save and a
// load give the same page items.
{
    const t = fresh();
    for (const c of PLATE) t.run(c);
    t.run({ op: "pattern_feature", id: 4, feature: 3, type: "circular", axis: "z", count: 4 });
    assert.deepStrictEqual(t.node("i4_at"), { id: "i4_at", kind: "placements.circular", axis: "xy", count: 4 });
    const v = t.node("i4");
    assert.deepStrictEqual([v.kind, v.solid, v.tool, v.op, v.placements], ["solid.pattern_feature", "i1", "i2", "cut", "i4_at"]);
    const it = t.item(4);
    assert.deepStrictEqual([it.kind, it.name, it.parts, it.type, it.axis, it.count, it.hidden], ["pattern_feature", "Pattern 1", [3], "circular", "z", 4, false]);
    assert.ok(t.item(3).hidden, "the cut is consumed");
    assert.strictEqual(t.statusOf("i4").state, "ok", JSON.stringify(t.statusOf("i4")));
    assert.ok(close(solidOf(t.doc, "i4").volume, 6400 - 4 * HOLE, 1e-6), String(solidOf(t.doc, "i4").volume));
    // the cut's tool changed: the pattern reads the new one
    t.run({ op: "primitive", id: 5, kind: "cylinder", plane: "top", dims: [3, 10] });
    t.run({ op: "set", id: 5, place: { offset: [10, 0, -3], turn: [0, 0, 0] } });
    t.run({ op: "set", id: 3, parts: [1, 5] });
    assert.strictEqual(t.node("i4").tool, "i5");
    assert.ok(close(solidNow(t, "i4").volume, 6400 - 4 * Math.PI * 9 * 4, 1e-6));
    // the count set: one node
    const set = t.run({ op: "set", id: 4, count: 6 }).op;
    assert.deepStrictEqual(set.ops, [{ op: "set", id: "i4_at", fields: { count: 6 } }]);
    const items = pageItems(t.model);
    const again = wasm[K + "document_load"](wasm[K + "document_save"](t.doc));
    assert.deepStrictEqual(pageItems(new Model(wasm, again)), items);
    wasm[K + "document_free"](again);
    t.free();
}

// mirror of a feature: pattern_feature over `placements.mirror` across Right: 2 holes, at +-x
{
    const t = fresh();
    for (const c of PLATE) t.run(c);
    t.run({ op: "mirror", id: 4, objects: "feature", feature: 3, plane: "right" });
    assert.deepStrictEqual(t.node("i4_at"), { id: "i4_at", kind: "placements.mirror", plane: "yz" });
    assert.deepStrictEqual([t.node("i4").kind, t.node("i4").solid, t.node("i4").tool], ["solid.pattern_feature", "i1", "i2"]);
    assert.deepStrictEqual([t.item(4).kind, t.item(4).name, t.item(4).type, t.item(4).across], ["pattern_feature", "Mirror 1", "mirror", "right"]);
    const got = solidNow(t, "i4");
    assert.ok(close(got.volume, 6400 - 2 * HOLE, 1e-6), String(got.volume));
    // the same as two holes cut by hand, at +-10
    for (const c of [{ op: "primitive", id: 5, kind: "box", plane: "top", dims: [40, 40, 4] },
        { op: "primitive", id: 6, kind: "cylinder", plane: "top", dims: [2, 10] }, { op: "set", id: 6, place: { offset: [10, 0, -3], turn: [0, 0, 0] } },
        { op: "primitive", id: 7, kind: "cylinder", plane: "top", dims: [2, 10] }, { op: "set", id: 7, place: { offset: [-10, 0, -3], turn: [0, 0, 0] } },
        { op: "cut", id: 8, parts: [5, 6] }, { op: "cut", id: 9, parts: [8, 7] }]) t.run(c);
    const hand = solidNow(t, "i9");
    assert.deepStrictEqual([got.faces, got.edges], [hand.faces, hand.edges]);
    assert.ok(close(got.area, hand.area, 1e-6));
    t.free();
}

// mirror of bodies, joined: a half touching the plane is `solid.mirror_join` (one body, twice
// the volume, no face on the plane -- as one box of twice the length); the same half off the
// plane is a mirrored copy and a join (two lumps in one item). The source is consumed.
{
    const t = fresh();
    for (const c of BOX_AT(1, 6, 3, 0)) t.run(c);   // x 0..6: touching YZ
    t.run({ op: "set", id: 1, dims: [6, 6, 4] });
    t.run({ op: "mirror", id: 2, objects: "bodies", sources: [1], plane: "right", operation: "join" });
    assert.deepStrictEqual([t.node("i2").kind, t.node("i2").solid, t.node("i2").plane, t.node("i2").snap], ["solid.mirror_join", "i1", "yz", 0.01]);
    assert.deepStrictEqual([t.item(2).kind, t.item(2).name, t.item(2).parts, t.item(2).across, t.item(2).touch], ["mirror", "Mirror 1", [1], "right", true]);
    assert.ok(t.item(1).hidden);
    // KERNEL GAP (this web package): `solid.mirror_join` refuses every flat-sided half touching
    // the plane (a box, a cylinder, an L of two boxes) in these words. Pinned so it flips when
    // the kernel takes it; then: one solid, volume 288, 6 faces, bounds [-6, -3, 0, 6, 3, 4].
    wasm[K + "document_evaluate"](t.doc, false);
    assert.deepStrictEqual([t.statusOf("i2").state, t.statusOf("i2").error], ["error", "mirror_join: edge_continuity: edge 0 bounds 4 face(s), not two"]);
    // off the plane: a copy and a join, two lumps in one item
    for (const c of BOX_AT(3, 6, 8, 0)) t.run(c);   // x 5..11
    t.run({ op: "mirror", id: 4, objects: "bodies", sources: [3], plane: "right", operation: "join" });
    assert.deepStrictEqual(t.node("i4_copy"), { id: "i4_copy", kind: "solid.mirror", solid: "i3", plane: "yz" });
    assert.deepStrictEqual([t.node("i4").kind, t.node("i4").solids], ["solid.join", ["i3", "i4_copy"]]);
    assert.deepStrictEqual([t.item(4).touch, t.item(4).parts, t.item(4).across], [false, [3], "right"]);
    const two = solidNow(t, "i4");
    assert.ok(close(two.volume, 432, 1e-6) && two.faces === 12, JSON.stringify(two));
    // the page's own word wins: the touch it gives is kept and written
    t.run({ op: "mirror", id: 5, objects: "bodies", sources: [4], plane: "front", operation: "join", touch: false });
    assert.deepStrictEqual([t.item(5).touch, t.node("i5").kind], [false, "solid.join"]);
    assert.ok(touchesPlane([0, -3, 0, 6, 3, 4], [0, 0, 0], [1, 0, 0]) && !touchesPlane([0.02, -3, 0, 6, 3, 4], [0, 0, 0], [1, 0, 0]) && !touchesPlane([-1, -3, 0, 6, 3, 4], [0, 0, 0], [1, 0, 0]));
    // a corner on a slanted plane, the box on both sides of it: no touch
    assert.ok(!touchesPlane([0, -2, 0, 2, 0, 1], [0, 0, 0], [1, 1, 0]) && touchesPlane([0, 0, 0, 2, 2, 1], [0, 0, 0], [1, 1, 0]));
    t.free();
}

// mirror of bodies, new: a group over `placements.mirror`, one instance per source named
// "<source> mirror", its bounds reflected; the sources stay.
{
    const t = fresh();
    for (const c of BOX_AT(1, 4, 10, 5)) t.run(c);
    t.run({ op: "mirror", id: 2, objects: "bodies", sources: [1], plane: "front", operation: "new", instances: [3] });
    assert.deepStrictEqual(t.node("i2_at"), { id: "i2_at", kind: "placements.mirror", plane: "xz" });
    assert.deepStrictEqual([t.item(2).kind, t.item(2).name, t.item(2).type, t.item(2).across, t.item(2).instances], ["pattern", "Mirror 1", "mirror", "front", [3]]);
    assert.deepStrictEqual([t.item(3).kind, t.item(3).name, t.item(3).index], ["instance", "Box 1 mirror", 1]);
    assert.ok(!t.item(1).hidden);
    const b = solidNow(t, "i1").bounds;
    assert.ok(close(solidNow(t, "i3").bounds, [b[0], -b[4], b[2], b[3], -b[1], b[5]], 1e-6), JSON.stringify(solidOf(t.doc, "i3").bounds));
    t.free();
}

// pattern_feature and mirror refusals: in the command's words, the document untouched
{
    const t = fresh();
    for (const c of PLATE) t.run(c);
    t.run({ op: "fillet", id: 4, source: 1, radius: 1 });
    refused(t, { op: "pattern_feature", id: 5, feature: 4, type: "circular", count: 3 }, /^pattern_feature: #4 is not a cut or a join/);
    refused(t, { op: "pattern_feature", id: 5, feature: 3, type: "circular", count: 1 }, /^pattern_feature: `count` must be a whole number, 2 or more/);
    refused(t, { op: "mirror", id: 5, objects: "bodies", sources: [1], operation: "new", instances: [6] }, /^mirror: no plane/);
    refused(t, { op: "mirror", id: 5, objects: "feature", feature: 3, plane: "nowhere" }, /^mirror: no plane/);
    refused(t, { op: "mirror", id: 5, objects: "feature", feature: 4, plane: "top" }, /^mirror: #4 is not a cut or a join/);
    refused(t, { op: "mirror", id: 5, objects: "bodies", sources: [1, 2], plane: "top", operation: "join" }, /^mirror: a join mirrors one body/);
    t.free();
}

console.log("forge-commands: ok");
