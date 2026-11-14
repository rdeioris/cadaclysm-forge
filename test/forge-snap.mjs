import assert from "node:assert";
import { KINDS, defaultSettings, readSettings, writeSettings, viewKinds, bodyAnswer, choose, fresh, glyphOf } from "../forge-snap.js";

// The kinds the toolbar offers, in its order; "plane" is the sketch's own, never offered.
assert.deepStrictEqual(KINDS, ["vertex", "midpoint", "centre", "quadrant", "edge", "face", "grid"]);

// The defaults: on, every point kind and edges, no faces, no grid, a 10 mm step.
{
    const s = defaultSettings();
    assert.strictEqual(s.on, true);
    assert.strictEqual(s.step, 10);
    assert.deepStrictEqual(viewKinds(s, { grid: true }), ["vertex", "midpoint", "centre", "quadrant", "edge"]);
    s.kinds.grid = true;
    assert.deepStrictEqual(viewKinds(s, { grid: true }), ["vertex", "midpoint", "centre", "quadrant", "edge", "grid"]);
    assert.deepStrictEqual(viewKinds(s, { grid: false }), ["vertex", "midpoint", "centre", "quadrant", "edge"]);   // Measure
    s.on = false;
    assert.strictEqual(viewKinds(s, { grid: true }), null);
}
// Nothing on: no snapping at all, not an empty list (an empty list would mean "all" to no one).
{
    const s = defaultSettings();
    for (const k of KINDS) s.kinds[k] = false;
    assert.strictEqual(viewKinds(s, { grid: true }), null);
    s.kinds.grid = true;
    assert.strictEqual(viewKinds(s, { grid: false }), null);   // grid only, and Measure takes no grid
}
// Saved settings: garbage and gaps fall back to the defaults, field by field; a round trip keeps them.
{
    assert.deepStrictEqual(readSettings(null), defaultSettings());
    assert.deepStrictEqual(readSettings("not json"), defaultSettings());
    assert.deepStrictEqual(readSettings("[1,2]"), defaultSettings());
    const partial = readSettings(JSON.stringify({ on: false, kinds: { grid: true, face: "yes" }, step: -3 }));
    assert.strictEqual(partial.on, false);
    assert.strictEqual(partial.kinds.grid, true);
    assert.strictEqual(partial.kinds.face, false);   // not a boolean: the default
    assert.strictEqual(partial.kinds.vertex, true);
    assert.strictEqual(partial.step, 10);            // not a positive number: the default
    const s = defaultSettings(); s.kinds.face = true; s.step = 2.5;
    assert.deepStrictEqual(readSettings(writeSettings(s)), s);
}
// What the forge takes from the View: a body's snaps and the grid's, never a curve item's
// (the page snaps onto curves itself, and the View shows the curve being drawn too).
{
    const vertex = { kind: "vertex", point: [1, 2, 3], item: 7, body: 4 };
    assert.strictEqual(bodyAnswer(vertex), vertex);
    assert.strictEqual(bodyAnswer({ kind: "vertex", point: [1, 2, 3], item: 9, body: null }), null);
    assert.strictEqual(bodyAnswer({ kind: "edge", point: [1, 2, 3], item: 9 }), null);
    // Measure measures curves too.
    const onCurve = { kind: "vertex", point: [1, 2, 0], item: 9, body: null };
    assert.strictEqual(bodyAnswer(onCurve, { grid: false, curves: true }), onCurve);
    assert.strictEqual(bodyAnswer({ kind: "grid", point: [5, 5, 0], body: null }, { grid: false, curves: true }), null);
    const grid = { kind: "grid", point: [5, 5, 0], item: 0, body: null };
    assert.strictEqual(bodyAnswer(grid), grid);
    assert.strictEqual(bodyAnswer(grid, { grid: false }), null);
    assert.strictEqual(bodyAnswer({ kind: "plane", point: [1, 1, 0], body: null }), null);
    assert.strictEqual(bodyAnswer(null), null);
    assert.strictEqual(bodyAnswer({ kind: "vertex", point: [NaN, 0, 0], body: 1 }), null);
}
// A curve end the page found wins over the View's; the View's stands in only when there is none.
{
    const page = { at: [0, 0], curve: 3, spot: "end" };
    const view = { at: [1, 1], kind: "vertex" };
    assert.strictEqual(choose(page, view), page);
    assert.strictEqual(choose(null, view), view);
    assert.strictEqual(choose(null, null), null);
}
// The cached answer counts for a pointer within a CSS pixel of where it was asked, in that view.
{
    const cache = { px: [100, 50], view: 0, answer: { kind: "vertex" } };
    assert.strictEqual(fresh(cache, [100.5, 50], 0), cache.answer);
    assert.strictEqual(fresh(cache, [102, 50], 0), null);
    assert.strictEqual(fresh(cache, [100, 50], 2), null);
    assert.strictEqual(fresh(null, [100, 50], 0), null);
}
// A glyph for every kind the overlay marks, and the plain ring for a curve end.
{
    for (const k of KINDS) assert.notStrictEqual(glyphOf(k), "ring", k);
    assert.strictEqual(glyphOf(undefined), "ring");
}
console.log("forge-snap: ok");
