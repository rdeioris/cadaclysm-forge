// The page's sketch and curve commands as document batches (forge-commands.js) over the
// kernel's public exports: what each writes in the node layout (forge-model.js's header),
// the counters through the `forge` meta, the sketch fillet and trim through the kernel's
// profile calls (checked against the 0.14 layer's own answers), the readers of what a
// command removes, and the stand-in for a node the kernel refuses.
//
// Run: node test/forge-commands.mjs   (after npm run setup)
import assert from "node:assert";
import { loadWasm } from "./package.mjs";
import { Model, UNITS } from "../forge-model.js";
import { command, commandOps, readItem, Draft, sketchFillet, trimmedCurves, Unported } from "../forge-commands.js";
import { sketchFillet as oldFillet } from "../forge-doc-curves.js";

const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";

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
for (const c of [
    { kind: "rect", shape: { x0: 0, y0: 0, x1: 20, y1: 10 } },
    { kind: "polygon", shape: { cx: 0, cy: 0, r: 10, sides: 6, angle: 0 } },
    { kind: "polyline", shape: { points: [[0, 0], [10, 0], [10, 10], [20, 10]], closed: false } },
    { kind: "polyline", shape: { points: [[0, 0], [10, 0], [10, 10]], closed: true } },
    { kind: "polycurve", shape: { pieces: [{ kind: "line", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } }, { kind: "arc", shape: { x0: 10, y0: 0, xm: 12, ym: 5, x1: 10, y1: 10 } }, { kind: "line", shape: { x0: 10, y0: 10, x1: 0, y1: 10 } }], closed: false } },
]) {
    const t = fresh();
    t.run({ op: "add", id: 1, kind: c.kind, plane: "top", shape: c.shape });
    t.run({ op: "round", ids: [1], radius: 2 });
    const now = t.item(1);
    const was = oldFillet(wasm, [c], 2).one.shape;
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
    const was = oldFillet(wasm, [{ kind: "line", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } }, { kind: "line", shape: { x0: 10, y0: 0, x1: 10, y1: 10 } }], 3).two;
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

// What is not on nodes yet says so; an unknown command and a bad id are refused as the
// page refused them.
{
    const t = fresh();
    assert.throws(() => t.run({ op: "surface", id: 1, loops: [[1]] }), (e) => e instanceof Unported);
    assert.throws(() => t.run({ op: "frobnicate" }), /^Error: unknown command frobnicate$/);
    assert.throws(() => t.run({ op: "add", id: -1 }), /add: `id` is not an id/);
    assert.throws(() => sketchFillet(wasm, [{ kind: "line", shape: { x0: 0, y0: 0, x1: 1, y1: 0 } }, { kind: "line", shape: { x0: 5, y0: 5, x1: 6, y1: 5 } }], 1), /do not meet/);
    t.free();
}

console.log("forge-commands: ok");
