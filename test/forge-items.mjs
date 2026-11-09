// The forge's items on the View, checked against a stand-in viewer: shown once, shown
// again only when what they are drawn from changes, removed when gone, face colours set
// only when they change, an item's own colour set only when it changes, and a body the
// View refuses remembered, not retried.
//
// Run: node test/forge-items.mjs
import assert from "node:assert";
import { createItemSync, faceColoursOver } from "../forge-items.js";

function fakeViewer() {
    let next = 1;
    const calls = [];
    return {
        calls,
        show(tag) { const id = next++; calls.push(["show", tag, id]); return id; },
        remove(id) { calls.push(["remove", id]); return true; },
        setFaceColours(id, colours) { calls.push(["faces", id, colours]); return true; },
        setColour(id, colour) { calls.push(["colour", id, colour]); return true; },
    };
}
const want = (v, key, deps, extra = {}) => ({ key, deps, show: () => v.show(key), ...extra });

// Shown once; the same list again does nothing.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3);
    items.sync([want(v, "body:1", [a, "0.5,0.5,0.5"], { value: { body: 1 } }), want(v, "curve:2", [a])]);
    assert.deepStrictEqual(v.calls, [["show", "body:1", 1], ["show", "curve:2", 2]]);
    v.calls.length = 0;
    items.sync([want(v, "body:1", [a, "0.5,0.5,0.5"], { value: { body: 1 } }), want(v, "curve:2", [a])]);
    assert.deepStrictEqual(v.calls, []);
    assert.deepStrictEqual(items.valueOf(1), { body: 1 });
    assert.strictEqual(items.valueOf(2), null);   // shown with no value
    assert.strictEqual(items.valueOf(99), null);
}

// A changed dependency shows it again (the old id removed first); a key gone is removed.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3), b = new Float32Array(3);
    items.sync([want(v, "body:1", [a]), want(v, "curve:2", [a])]);
    v.calls.length = 0;
    items.sync([want(v, "body:1", [b])]);
    assert.deepStrictEqual(v.calls, [["remove", 2], ["remove", 1], ["show", "body:1", 3]]);
}

// Face colours: set when they change, not repeated, cleared with null when dropped.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3);
    items.sync([want(v, "body:1", [a], { faceColours: { 2: [1, 0, 0] } })]);
    items.sync([want(v, "body:1", [a], { faceColours: { 2: [1, 0, 0] } })]);
    items.sync([want(v, "body:1", [a])]);
    assert.deepStrictEqual(v.calls, [["show", "body:1", 1], ["faces", 1, { 2: [1, 0, 0] }], ["faces", 1, null]]);
}

// A body the View refuses: logged, remembered without an id, not retried until it
// changes, and the others still shown.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3), b = new Float32Array(3);
    const logged = [];
    const error = console.error;
    console.error = (...args) => logged.push(args);
    try {
        const bad = { key: "body:1", deps: [a], show: () => { throw new Error("no faces"); }, faceColours: { 0: [1, 0, 0] } };
        items.sync([bad, want(v, "curve:2", [a])]);
        items.sync([bad, want(v, "curve:2", [a])]);
        assert.strictEqual(logged.length, 1);
        assert.deepStrictEqual(v.calls, [["show", "curve:2", 1]]);
        items.sync([{ ...bad, deps: [b], show: () => v.show("body:1") }, want(v, "curve:2", [a])]);
        assert.deepStrictEqual(v.calls.slice(1), [["show", "body:1", 2], ["faces", 2, { 0: [1, 0, 0] }]]);
    } finally { console.error = error; }
}

// clear removes everything shown.
{
    const v = fakeViewer(), items = createItemSync(v);
    items.sync([want(v, "a", []), want(v, "b", [])]);
    v.calls.length = 0;
    items.clear();
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["remove", "remove"]);
    assert.strictEqual(items.valueOf(1), null);
}
// faceColoursOver: every face tinted with no overrides.
{
    assert.deepStrictEqual(faceColoursOver(3, [1, 0, 0], undefined), { 0: [1, 0, 0], 1: [1, 0, 0], 2: [1, 0, 0] });
}
// faceColoursOver: overrides win over the base on the faces they name.
{
    assert.deepStrictEqual(faceColoursOver(3, [1, 0, 0], { 1: [0, 1, 0] }), { 0: [1, 0, 0], 1: [0, 1, 0], 2: [1, 0, 0] });
}
// faceColoursOver: no base -- the overrides alone.
{
    assert.deepStrictEqual(faceColoursOver(3, undefined, { 1: [0, 1, 0] }), { 1: [0, 1, 0] });
}
// faceColoursOver: neither base nor overrides -- undefined, so the caller clears with null.
{
    assert.strictEqual(faceColoursOver(3, undefined, undefined), undefined);
    assert.strictEqual(faceColoursOver(0, undefined, undefined), undefined);
}

// Selecting a body tints every face through setFaceColours alone: the same deps (the
// item's own colour never changes), so no show or remove -- only one faces call.
// Deselecting drops the tint with a faces(null), again with no show or remove.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3);
    const unselected = { key: "body:1", deps: [a, "0.5,0.5,0.5"], show: () => v.show("body:1") };
    items.sync([unselected]);
    v.calls.length = 0;
    const tint = faceColoursOver(2, [0.7, 0.66, 0.58], undefined);
    const selected = { ...unselected, faceColours: tint };
    items.sync([selected]);
    assert.deepStrictEqual(v.calls, [["faces", 1, tint]]);
    v.calls.length = 0;
    items.sync([unselected]);
    assert.deepStrictEqual(v.calls, [["faces", 1, null]]);
}
// An item's colour: applied by its show, so not sent after it; the same colour again (a
// fresh array of the same values) sends nothing.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3);
    items.sync([want(v, "curve:1", [a], { colour: [0.1, 0.2, 0.3] })]);
    items.sync([want(v, "curve:1", [a], { colour: [0.1, 0.2, 0.3] })]);
    assert.deepStrictEqual(v.calls, [["show", "curve:1", 1]]);
}

// A sketch curve selected: its colour changes, its deps do not -- no show, no remove, one
// setColour; the frame after, nothing; deselected, one setColour back.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3);
    const curve = (colour) => want(v, "curve:1", [a], { colour });
    items.sync([curve([0.1, 0.2, 0.3]), want(v, "iso:2", [a], { colour: [0.5, 0.5, 0.5] })]);
    v.calls.length = 0;
    items.sync([curve([0.9, 0.5, 0.1]), want(v, "iso:2", [a], { colour: [0.5, 0.5, 0.5] })]);
    assert.deepStrictEqual(v.calls, [["colour", 1, [0.9, 0.5, 0.1]]]);
    v.calls.length = 0;
    items.sync([curve([0.9, 0.5, 0.1]), want(v, "iso:2", [a], { colour: [0.5, 0.5, 0.5] })]);
    assert.deepStrictEqual(v.calls, []);
    items.sync([curve([0.1, 0.2, 0.3]), want(v, "iso:2", [a], { colour: [0.5, 0.5, 0.5] })]);
    assert.deepStrictEqual(v.calls, [["colour", 1, [0.1, 0.2, 0.3]]]);
}

// Changed deps show it again in the colour wanted then -- no setColour after the show --
// and an item the View refused is never coloured.
{
    const v = fakeViewer(), items = createItemSync(v);
    const a = new Float32Array(3), b = new Float32Array(3);
    items.sync([want(v, "curve:1", [a], { colour: [0.1, 0.2, 0.3] })]);
    v.calls.length = 0;
    items.sync([want(v, "curve:1", [b], { colour: [0.9, 0.5, 0.1] })]);
    assert.deepStrictEqual(v.calls, [["remove", 1], ["show", "curve:1", 2]]);
    const error = console.error;
    console.error = () => {};
    try {
        const bad = (colour) => ({ key: "curve:3", deps: [a], colour, show: () => { throw new Error("no curves"); } });
        v.calls.length = 0;
        items.sync([bad([0.1, 0.2, 0.3])]);
        items.sync([bad([0.9, 0.5, 0.1])]);
        assert.deepStrictEqual(v.calls, [["remove", 2]]);
    } finally { console.error = error; }
}
// A face colour the View refuses (a face past the solid's count) is logged, not thrown: the
// next item is still handled, and the colours are tried again at the next sync.
{
    const v = fakeViewer(), items = createItemSync(v), error = console.error, logged = [];
    let refuse = true;
    v.setFaceColours = (id, colours) => { v.calls.push(["faces", id, colours]); if (refuse) throw new Error("face 9 >= 6"); return true; };
    console.error = (...a) => logged.push(a);
    try {
        const list = () => [want(v, "body:1", [1], { faceColours: { 9: [1, 0, 0] } }), want(v, "curve:2", [1], { colour: [0, 0, 1] })];
        assert.doesNotThrow(() => items.sync(list()));
        assert.strictEqual(logged.length, 1, "the refusal is logged");
        assert.ok(v.calls.some((c) => c[0] === "colour" || (c[0] === "show" && c[1] === "curve:2")), "the next item is still shown");
        v.calls.length = 0; refuse = false;
        items.sync(list());
        assert.deepStrictEqual(v.calls, [["faces", 1, { 9: [1, 0, 0] }]], "tried again, once, at the next sync");
    } finally { console.error = error; }
}
console.log("forge-items: ok");
