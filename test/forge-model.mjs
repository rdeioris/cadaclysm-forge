// The forge's model (forge-model.js) over the kernel's public document exports: the items
// read straight off a document's nodes in the 0.15 layout -- curves, a sketch frame, a body's
// transform chain, a stand-in, held foreign bodies -- the counters from the document's
// `forge` meta, and a refresh that re-reads only what a changed set names, in one
// `document_nodes` call, and never saves.
//
// Run: node test/forge-model.mjs   (after npm run setup)
import assert from "node:assert";
import { loadWasm } from "./package.mjs";
import { Model, isBody, isSketch, isCurve, isImage, isHeldProfile, helper, bumpId, takeId, metaOp, label } from "../forge-model.js";

const wasm = await loadWasm();

// The kernel with its document reads counted.
function counted() {
    const calls = [];
    const k = {};
    for (const [name, fn] of Object.entries(wasm)) {
        k[name] = typeof fn !== "function" ? fn : (...args) => {
            calls.push([name.replace(/^cadaclysm_blacksmith_/, ""), ...args.slice(1)]);
            return fn(...args);
        };
    }
    return { k, calls, of: (what) => calls.filter((c) => c[0] === what) };
}

const apply = (doc, op) => JSON.parse(wasm.cadaclysm_blacksmith_document_apply(doc, JSON.stringify(op), undefined));
const ids = (list) => list.map((n) => n.id);
const fullNodes = (doc) => JSON.parse(wasm.cadaclysm_blacksmith_document_nodes(doc, null));

// A small document in the new layout.
function sample() {
    const doc = wasm.cadaclysm_blacksmith_document_new("mm");
    apply(doc, { op: "batch", ops: [
        // Another app's nodes come first: shown solids (one the page places below), a plain
        // profile, a shown sheet.
        { op: "add", node: { id: "plate", kind: "solid.cuboid", x: 4, y: 4, z: 1, meta: { show: true } } },
        { op: "add", node: { id: "bracket", kind: "solid.cuboid", x: 2, y: 2, z: 2, name: "Bracket", meta: { show: true } } },
        { op: "add", node: { id: "rim", kind: "profile.circle", r: 3 } },
        { op: "add", node: { id: "stand", kind: "sheet.face", profile: "rim", meta: { show: true } } },
        // Sketch 1: its plane helper, then its head.
        { op: "add", node: { id: "i1_frame", kind: "frame.offset", base: "xy", offset: 5 } },
        { op: "add", node: { id: "i1", kind: "frame.translate", frame: "i1_frame", name: "Sketch 1", meta: { forge: { kind: "sketch", mode: "2d", look: "plain" } } } },
        // Two curves on it: one with no page meta (its kind from the node's), one a rect.
        { op: "add", node: { id: "i2", kind: "curve.line", x0: 0, y0: 0, x1: 10, y1: 0, frame: "i1", name: "Line 1" } },
        { op: "add", node: { id: "i7", kind: "curve.line", x0: 0, y0: 0, x1: 0, y1: 10, frame: "i1", name: "Rectangle 1", meta: { forge: { kind: "rect", style: "dash" } } } },
        // A box made into a chain: verb, in-plane move, world place as the head.
        { op: "add", node: { id: "i3_inner", kind: "solid.cuboid", x: 1, y: 2, z: 3, frame: "i1", anchor: "base" } },
        { op: "add", node: { id: "i3_moved", kind: "solid.transform", solid: "i3_inner", frame: "i1", turn: [0, 0, 30], by: [1, 2, 0] } },
        { op: "add", node: { id: "i3", kind: "solid.transform", solid: "i3_moved", turn_in: "world", turn: [0, 0, 0], by_in: "world", by: [0, 0, 7], name: "Box 1", meta: { forge: { kind: "box", scale: 1 } } } },
        // A stand-in for an item that cannot be built.
        { op: "add", node: { id: "i4", kind: "value.unresolved", type: "solid", why: "its part is gone", name: "Fillet 1", meta: { forge: { kind: "fillet", edges: [0, 2] } } } },
        // A held body the page has placed: the foreign node is named, not a held item.
        { op: "add", node: { id: "i5", kind: "solid.transform", solid: "plate", turn_in: "world", by_in: "world", by: [0, 0, 1], name: "Plate", meta: { forge: { kind: "held", node: "plate" } } } },
        { op: "meta", app: "forge", value: { counters: { line: 1, rect: 1, sketch: 1, box: 1, fillet: 1 }, nextId: 8 } },
    ] });
    return doc;
}

// The items: one per head in document order, each with its helpers before it, its page
// kind and name; then the held foreign bodies, numbered from the next free id.
{
    const doc = sample();
    const m = new Model(wasm, doc);
    assert.deepStrictEqual(ids(m.nodes()), ids(fullNodes(doc)), "the mirror is the document, in order");
    assert.strictEqual(m.revision, wasm.cadaclysm_blacksmith_document_revision(doc));
    const items = m.items();
    assert.deepStrictEqual(items.map((it) => [it.id, it.kind, it.name]), [
        [1, "sketch", "Sketch 1"], [2, "line", "Line 1"], [7, "rect", "Rectangle 1"], [3, "box", "Box 1"],
        [4, "fillet", "Fillet 1"], [5, "held", "Plate"], [8, "held", "Bracket"], [9, "held", "stand"],
    ]);
    const box = m.item(3);
    assert.deepStrictEqual(ids(box.helpers), ["i3_inner", "i3_moved"]);
    assert.strictEqual(box.head.id, "i3");
    assert.strictEqual(helper(box, "moved").kind, "solid.transform");
    assert.strictEqual(helper(box, "flush"), undefined);
    assert.deepStrictEqual(ids(m.item(1).helpers), ["i1_frame"]);
    assert.deepStrictEqual(m.item(4).head.meta.forge, { kind: "fillet", edges: [0, 2] }, "page fields read as they are");
    assert.strictEqual(m.item(4).head.kind, "value.unresolved");
    assert.strictEqual(m.item(8).node, "bracket");
    assert.strictEqual(m.item(8).of, "solid");
    assert.strictEqual(m.item(9).of, "sheet");
    assert.strictEqual(m.itemKind(m.item(2)), "line");
    assert.strictEqual(m.itemKind({ head: { id: "i9", kind: "curve.spline" } }), "nurbs");
    assert.strictEqual(m.itemKind({ head: { id: "i9", kind: "curve.spline", meta: { forge: { kind: "polycurve" } } } }), "polycurve");
    // The predicates.
    const pred = (f) => items.filter(f).map((it) => it.id);
    assert.deepStrictEqual(pred(isBody), [3, 4, 5, 8, 9]);
    assert.deepStrictEqual(pred(isSketch), [1]);
    assert.deepStrictEqual(pred(isCurve), [2, 7]);
    assert.deepStrictEqual(pred(isImage), []);
    assert.deepStrictEqual(pred(isHeldProfile), []);
    assert.ok(isHeldProfile({ kind: "held_profile" }) && isImage({ kind: "image" }) && !isCurve({ kind: "image" }));
}

// The counters: read from the `forge` meta; a name moves its kind's counter in the meta
// copy the caller writes; absent meta is every counter 0 and the next id 1.
{
    const doc = sample();
    const m = new Model(wasm, doc);
    assert.strictEqual(m.label("press"), "Press Pull");
    assert.strictEqual(label("nope"), "undefined");
    const { name, meta } = m.nameFor("line");
    assert.strictEqual(name, "Line 2");
    assert.strictEqual(m.nameFor("line", meta).name, "Line 3", "one meta names several items");
    assert.strictEqual(m.nameFor("cone", meta).name, "Cone 1");
    assert.strictEqual(m.nameFor("line").name, "Line 2", "the model's own meta is untouched until written");
    assert.strictEqual(takeId(meta), 8);
    assert.strictEqual(bumpId(meta, 20).nextId, 21);
    apply(doc, { op: "batch", ops: [metaOp(meta)] });
    m.refresh(wasm.cadaclysm_blacksmith_document_apply(doc, JSON.stringify({ op: "set", id: "i2", fields: { x1: 11 } }), undefined));
    assert.strictEqual(m.nameFor("line").name, "Line 2", "a changed set without `forge` in its meta keeps the meta");
    const m2 = new Model(wasm, doc);
    assert.strictEqual(m2.nameFor("line").name, "Line 4");
    assert.deepStrictEqual(m2.forgeMeta(), { counters: { line: 3, rect: 1, sketch: 1, box: 1, fillet: 1, cone: 1 }, nextId: 21 });
    const empty = new Model(wasm, wasm.cadaclysm_blacksmith_document_new("mm"));
    assert.deepStrictEqual(empty.forgeMeta(), { counters: {}, nextId: 1 });
    assert.strictEqual(empty.nameFor("polycurve").name, "Polycurve 1");
    assert.deepStrictEqual(empty.items(), []);
}

// A refresh re-reads only what a changed set names, in one `document_nodes` call; places an
// added node by the op's own positions; re-reads the meta only when the set names `forge`;
// and never saves.
{
    const doc = sample();
    const { k, calls, of } = counted();
    const m = new Model(k, doc);
    m.items();
    const step = (op, withOps = true) => {
        calls.length = 0;
        const changed = JSON.parse(k.cadaclysm_blacksmith_document_apply(doc, JSON.stringify(op), undefined));
        calls.length = 0;
        m.refresh(changed, withOps ? op : undefined);
        assert.deepStrictEqual(m.nodes(), fullNodes(doc), "the mirror is the document after the refresh");
        assert.strictEqual(m.revision, wasm.cadaclysm_blacksmith_document_revision(doc));
        assert.strictEqual(of("document_save").length, 0, "a refresh never saves");
        return changed;
    };
    // A curve edited, a curve added at the end, the counters moved.
    const c1 = step({ op: "batch", ops: [
        { op: "set", id: "i2", fields: { x1: 12 } },
        { op: "add", node: { id: "i8", kind: "curve.circle", cx: 0, cy: 0, r: 2, frame: "i1", name: "Circle 1" } },
        metaOp({ counters: { line: 1, circle: 1 }, nextId: 9 }),
    ] });
    assert.deepStrictEqual(of("document_nodes"), [["document_nodes", JSON.stringify(["i8", "i2"])]], "one read, of only the changed ids");
    assert.deepStrictEqual(c1.meta, ["forge"]);
    assert.strictEqual(of("document_meta").length, 1, "the meta re-read");
    assert.strictEqual(m.nameFor("circle").name, "Circle 2");
    assert.deepStrictEqual(m.items().slice(-4).map((it) => it.id), [5, 8, 9, 10], "the new circle last of the heads, then the held items renumbered from the new next id");
    // A helper inserted before its head, at a position.
    const at = ids(m.nodes()).indexOf("i8");
    step({ op: "batch", ops: [
        { op: "add", node: { id: "i8_frame", kind: "frame.offset", base: "xy", offset: 1 }, at },
        { op: "set", id: "i8", fields: { frame: "i8_frame" } },
    ] });
    assert.deepStrictEqual(of("document_nodes"), [["document_nodes", JSON.stringify(["i8_frame", "i8"])]]);
    assert.strictEqual(of("document_meta").length, 0, "no `forge` in the set: the meta is not read");
    assert.deepStrictEqual(ids(m.item(8).helpers), ["i8_frame"]);
    // A remove reads no node at all.
    step({ op: "remove", id: "i7" });
    assert.strictEqual(of("document_nodes").length, 0);
    assert.strictEqual(m.item(7), undefined);
    // An add with no ops to place it (an undo's set, say): one read of every node.
    const undo = () => {
        calls.length = 0;
        m.refresh(k.cadaclysm_blacksmith_document_undo(doc));
        assert.deepStrictEqual(m.nodes(), fullNodes(doc));
    };
    undo();
    assert.deepStrictEqual(of("document_nodes"), [["document_nodes", null]], "an add with nothing placing it: one full read");
    assert.deepStrictEqual(m.item(7).name, "Rectangle 1");
    // An undo that only removes and changes reads only the changed.
    undo();
    assert.deepStrictEqual(of("document_nodes"), [["document_nodes", JSON.stringify(["i8"])]]);
    assert.strictEqual(m.node("i8_frame"), undefined);
    // A cascade before a positioned add cannot be replayed: one full read.
    step({ op: "batch", ops: [
        { op: "remove", id: "i1", cascade: true },
        { op: "add", node: { id: "i9", kind: "curve.line", x0: 0, y0: 0, x1: 1, y1: 1 }, at: 3 },
    ] });
    assert.deepStrictEqual(of("document_nodes"), [["document_nodes", null]]);
    assert.strictEqual(of("document_save").length, 0);
}

console.log("forge-model: ok");
