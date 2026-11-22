// manipulator.js, the forge's manipulator: its layout on the screen
// (arrows sized in pixels, the edge-on ones dropped), its hit test (tips, the square, the
// centre, a ring between its sample points, in that order), the world point a drag reads,
// a drag's delta (slide, turn, scale) and that delta as a matrix about the pivot, and what it
// draws -- against cameras worked out by hand, not against another reading of the same maths.
// F3's look too: plane squares and quarter arcs laid out, hit, dragged and drawn, stepping
// (stepDelta), hover and the sweep; the older rings-only look pinned to what it laid out and
// drew before (fixtures/manipulator-old.json).
//
// Run: node test/manipulator.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AXES3, RINGS3, COLOURS, AXIS_COLOURS, GIZMO3_PX, MIN_SCALE, ARCS3, PLANES3, PLANES2, ARROW_PX, HEAD_PX, HEAD_W, PLANE_AT, PLANE_PX, ARC_AT, GRIP_PX, layoutManipulator, hitManipulator, manipulatorPoint, beginDrag, dragDelta, stepDelta, deltaMatrix, drawManipulator, segmentDistance } from "../manipulator.js";

const near = (a, b, tol, what) => { assert.equal(a.length, b.length, what); for (let k = 0; k < a.length; k++) assert.ok(Math.abs(a[k] - b[k]) <= tol, `${what}: ${a} vs ${b}`); };
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const SIZE = [800, 600];
let checks = 0;
const check = (name, f) => { f(); checks++; console.log(`ok ${name}`); };

// Looking down -Z at 100 px a unit, the world origin at the middle: X runs right, Y up the
// screen, Z at the eye -- its arrow edge-on, and the rings about X and Y edge-on.
const top = {
    worldToPx: (p) => [400 + 100 * p[0], 300 - 100 * p[1]],
    ray: (q) => ({ origin: [(q[0] - 400) / 100, (300 - q[1]) / 100, 50], dir: [0, 0, -1] }),
    look: [0, 0, -1], ahead: false,
};
// Looking at the origin from the front, the right and above (orthographic, 100 px a unit):
// nothing edge-on.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const LOOK = unit([-0.6, 1, -1]), RIGHT = unit([LOOK[1], -LOOK[0], 0]);   // look x Z
const UP = [RIGHT[1] * LOOK[2] - RIGHT[2] * LOOK[1], RIGHT[2] * LOOK[0] - RIGHT[0] * LOOK[2], RIGHT[0] * LOOK[1] - RIGHT[1] * LOOK[0]];
const tilted = {
    worldToPx: (p) => [400 + 100 * dot(p, RIGHT), 300 - 100 * dot(p, UP)],
    ray: (q) => {
        const x = (q[0] - 400) / 100, y = (300 - q[1]) / 100;
        return { origin: [0, 1, 2].map((i) => x * RIGHT[i] + y * UP[i] - 50 * LOOK[i]), dir: LOOK };
    },
    look: LOOK, ahead: false,
};
const full = (pivot) => ({ pivot, axes: AXES3, rings: RINGS3, scale: true });

check("arrows_are_80_px_and_edge_on_ones_dropped", () => {
    const g = layoutManipulator(full([1, 2, 3]), top, SIZE);
    near(g.centre, [500, 100], 1e-9, "the pivot");
    assert.deepEqual(g.axes.map((a) => a.name), ["X", "Y"], "Z points at the eye: no arrow");
    near(g.axes[0].tip, [500 + GIZMO3_PX, 100], 1e-9, "X, 80 px right");
    near(g.axes[1].tip, [500, 100 - GIZMO3_PX], 1e-9, "Y, 80 px up");
    assert.deepEqual(g.rings.map((r) => r.name), ["Z"], "the rings about X and Y are edge-on: dropped");
    assert.equal(g.rings[0].points.length, 48);
    for (const p of g.rings[0].points) assert.ok(Math.abs(Math.hypot(p[0] - 500, p[1] - 100) - 0.75 * GIZMO3_PX) < 1e-9, "a 60 px ring");
    near(g.scale, [544, 144], 1e-9, "the square beside the centre");
    const t = layoutManipulator(full([0, 0, 0]), tilted, SIZE);
    assert.deepEqual([t.axes.length, t.rings.length], [3, 3], "tilted: every handle");
    // The size is on the screen, whatever the zoom: twice the pixels a unit, the same arrow.
    const zoomed = { ...top, worldToPx: (p) => [400 + 200 * p[0], 300 - 200 * p[1]] };
    near(layoutManipulator(full([0, 0, 0]), zoomed, SIZE).axes[0].tip, [480, 300], 1e-9, "80 px at any zoom");
    assert.equal(layoutManipulator(full([0, 0, 0]), { ...top, worldToPx: () => null }, SIZE), null, "behind the eye: none");
    const bare = layoutManipulator({ pivot: [0, 0, 0], axes: AXES3, rings: [], scale: false }, tilted, SIZE);
    assert.deepEqual([bare.rings, bare.scale], [[], null], "what the subject cannot do is not there");
});

check("hits_tips_square_centre_then_rings", () => {
    const g = layoutManipulator(full([0, 0, 0]), top, SIZE);
    assert.deepEqual(hitManipulator(g, [480 + 6, 300 + 5]), { kind: "move", name: "X", axis: [1, 0, 0] }, "within 9 px of the X tip");
    assert.equal(hitManipulator(g, [480 + 7, 300 + 7]), null, "not 9.9 px off it");
    assert.deepEqual(hitManipulator(g, [444, 344 + 8]), { kind: "scale", name: null, axis: null });
    assert.deepEqual(hitManipulator(g, [403, 302]), { kind: "move", name: null, axis: null }, "the centre: the free move");
    // The ring sampled every 7.5 degrees; pressed half way between two samples, on the circle.
    const between = [400 + 60 * Math.cos(Math.PI / 96 * 5), 300 - 60 * Math.sin(Math.PI / 96 * 5)];
    assert.ok(g.rings[0].points.every((p) => Math.hypot(p[0] - between[0], p[1] - between[1]) > 1), "not on a sample");
    assert.deepEqual(hitManipulator(g, between), { kind: "rotate", name: "Z", axis: [0, 0, 1] });
    assert.deepEqual(hitManipulator(g, [400, 300 - 67])?.kind, "rotate", "7 px outside the ring");
    assert.equal(hitManipulator(g, [400, 300 - 70]), null, "10 px outside it");
    assert.equal(hitManipulator(g, [400 - 30, 300]), null, "inside the ring, off the handles");
    // A tip on the ring wins: tips are tried first.
    const crowd = { centre: [0, 0], axes: [{ name: "X", a: [1, 0, 0], tip: [60, 0] }], rings: [{ name: "Z", n: [0, 0, 1], points: [[60, -10], [60, 10]] }], scale: null };
    assert.equal(hitManipulator(crowd, [60, 0]).kind, "move");
    assert.equal(hitManipulator(null, [0, 0]), null);
    assert.equal(segmentDistance([5, 5], [0, 0], [10, 0]), 5);
    assert.equal(segmentDistance([-3, 4], [0, 0], [10, 0]), 5, "past an end: to the end");
});

check("a_slide_reads_the_axis_under_the_pointer", () => {
    const pivot = [1, 2, 0];
    const h = { kind: "move", name: "X", axis: [1, 0, 0], pivot };
    const from = top.worldToPx([1.8, 2, 0]);
    const d = beginDrag(h, tilted, tilted.worldToPx([1.8, 2, 0]), SIZE);
    near(d.from, [1.8, 2, 0], 1e-9, "the axis point under the press");
    near(dragDelta(d, tilted, tilted.worldToPx([2.3, 2, 0]), SIZE).slide, [0.5, 0, 0], 1e-9, "half a unit along X");
    // Off the axis on the screen: the nearest point of the axis, so only the along part counts.
    const off = tilted.worldToPx([2.3, 2, 0]), o = tilted.worldToPx([1, 2, 0]), x = tilted.worldToPx([2, 2, 0]);
    const l = Math.hypot(x[0] - o[0], x[1] - o[1]), across = [-(x[1] - o[1]) / l, (x[0] - o[0]) / l];
    near(dragDelta(d, tilted, [off[0] + 40 * across[0], off[1] + 40 * across[1]], SIZE).slide, [0.5, 0, 0], 1e-9, "the across part is dropped");
    // The axis along the look: no point.
    assert.equal(manipulatorPoint({ kind: "move", axis: [0, 0, 1], pivot }, top, from, SIZE), null);
    // The free move: in the plane facing the camera, through the pivot.
    const free = beginDrag({ kind: "move", name: null, axis: null, pivot }, tilted, tilted.worldToPx(pivot), SIZE);
    const v = [0, 1, 2].map((i) => 0.3 * RIGHT[i] + 0.2 * UP[i]);   // 0.3 right, 0.2 up as the eye sees it
    near(dragDelta(free, tilted, tilted.worldToPx([1 + v[0], 2 + v[1], v[2]]), SIZE).slide, v, 1e-9, "follows the pointer");
    // A perspective reading ahead only: a ray that meets the plane behind its origin reads nothing.
    const behind = { ...top, ray: () => ({ origin: [0, 0, -5], dir: [0, 0, -1] }), ahead: true };
    assert.equal(manipulatorPoint({ kind: "rotate", axis: [0, 0, 1], pivot: [0, 0, 0] }, behind, [0, 0], SIZE), null);
    assert.notEqual(manipulatorPoint({ kind: "rotate", axis: [0, 0, 1], pivot: [0, 0, 0] }, { ...behind, ahead: false }, [0, 0], SIZE), null);
});

check("a_ring_turns_by_the_angle_dragged_round_it", () => {
    const pivot = [1, 2, 0];
    const at = (deg) => top.worldToPx([pivot[0] + 0.6 * Math.cos(deg * Math.PI / 180), pivot[1] + 0.6 * Math.sin(deg * Math.PI / 180), 0]);
    const d = beginDrag({ kind: "rotate", name: "Z", axis: [0, 0, 1], pivot }, top, at(10), SIZE);
    const delta = dragDelta(d, top, at(55), SIZE);
    assert.ok(Math.abs(delta.turn - Math.PI / 4) < 1e-9, `against the clock on the screen, Z at the eye: +45 degrees (${delta.turn})`);
    assert.ok(Math.abs(dragDelta(d, top, at(-20), SIZE).turn + Math.PI / 6) < 1e-9, "back past the start: negative");
    // The angle about the pivot, not the distance: far out along the same ray, the same turn.
    const far = top.worldToPx([pivot[0] + 3 * Math.cos(55 * Math.PI / 180), pivot[1] + 3 * Math.sin(55 * Math.PI / 180), 0]);
    assert.ok(Math.abs(dragDelta(d, top, far, SIZE).turn - Math.PI / 4) < 1e-9);
    const m = deltaMatrix(delta, pivot, d.axis);
    near(apply(m, pivot), pivot, 1e-12, "the pivot stays");
    near(apply(m, [pivot[0] + 1, pivot[1], 5]), [pivot[0] + Math.SQRT1_2, pivot[1] + Math.SQRT1_2, 5], 1e-12, "X turned towards Y, Z kept");
    // About X, the right hand's way: Y turns onto Z.
    const mx = deltaMatrix({ slide: null, turn: Math.PI / 2, scale: 1 }, [0, 0, 0], [1, 0, 0]);
    near(apply(mx, [0, 1, 0]), [0, 0, 1], 1e-12, "about X");
    const my = deltaMatrix({ slide: null, turn: Math.PI / 2, scale: 1 }, [0, 0, 0], [0, 1, 0]);
    near(apply(my, [0, 0, 1]), [1, 0, 0], 1e-12, "about Y: Z onto X");
});

check("the_square_scales_by_the_distance_from_the_centre", () => {
    const pivot = [1, 2, 0];
    const c = top.worldToPx(pivot);
    const d = beginDrag({ kind: "scale", name: null, axis: null, pivot }, top, [c[0] + 44, c[1] + 44], SIZE);
    assert.equal(d.from, null, "a scale reads no world point");
    assert.equal(dragDelta(d, top, [c[0] + 88, c[1] + 88], SIZE).scale, 2, "twice as far: twice the size");
    assert.equal(dragDelta(d, top, [c[0] - 22, c[1] - 22], SIZE).scale, 0.5, "the distance, not the side");
    assert.equal(dragDelta(d, top, c, SIZE).scale, MIN_SCALE, "never to nothing");
    const m = deltaMatrix({ slide: null, turn: 0, scale: 2 }, pivot);
    near(apply(m, pivot), pivot, 1e-12, "the pivot stays");
    near(apply(m, [2, 3, 1]), [3, 4, 2], 1e-12, "uniform about the pivot");
    near(Array.from(deltaMatrix({ slide: [1, 2, 3], turn: 0, scale: 1 }, pivot)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], 0, "a slide is a translation");
    assert.equal(dragDelta({ ...d, fromPx: c }, top, [c[0] + 5, c[1]], SIZE), null, "pressed on the centre itself: no ratio");
});

check("draws_the_hot_handle_in_the_accent", () => {
    const g = layoutManipulator(full([0, 0, 0]), tilted, SIZE);
    const strokes = [], fills = [];
    const ctx = new Proxy({}, {
        get: (o, k) => (k in o ? o[k] : (...a) => { if (k === "stroke") strokes.push(o.strokeStyle); if (k === "fill" || k === "fillRect") fills.push(o.fillStyle); }),
        set: (o, k, v) => { o[k] = v; return true; },
    });
    drawManipulator(ctx, g, [10, 20, 800, 600], { hot: (kind, name) => kind === "rotate" && name === "Y" });
    assert.deepEqual(strokes.slice(0, 3), [AXIS_COLOURS.X, COLOURS.accent, AXIS_COLOURS.Z], "the rings, Y held");
    assert.deepEqual(strokes.slice(3, 6), [AXIS_COLOURS.X, AXIS_COLOURS.Y, AXIS_COLOURS.Z], "the arrows' shafts");
    assert.deepEqual(fills.slice(-2), [COLOURS.handle, COLOURS.handle], "the centre and the square");
    fills.length = 0;
    drawManipulator(ctx, g, [0, 0, 800, 600], { hot: (kind, name) => kind === "scale" && name === null, colours: { accent: "#123456" } });
    assert.equal(fills.at(-1), "#123456", "a page's own accent");
    assert.doesNotThrow(() => drawManipulator(ctx, null, [0, 0, 1, 1]), "nothing laid out, nothing drawn");
    // Hollow: the centre a circle stroked, not a disc filled, so the pivot's own dot shows.
    strokes.length = 0; fills.length = 0;
    drawManipulator(ctx, g, [0, 0, 800, 600], { hollow: true });
    assert.equal(strokes.length, 3 + 3 + 1 + 1, "rings, shafts, the centre circle, the square's stem");
    assert.equal(strokes[6], COLOURS.handle, "the centre circle");
    assert.equal(fills.length, 3 + 1, "the arrow heads and the square: no disc");
});

// ---- F3: arrows 90 px, plane squares, quarter arcs ---------------------------------------
// The forge's Move sessions pass `arcs` and `planes`; a manipulator with `rings` and no `arcs`
// is the one above, unchanged (pinned against what the code laid out before F3).
const OLD = JSON.parse(readFileSync(new URL("./fixtures/manipulator-old.json", import.meta.url), "utf8"));
const look = (pivot) => ({ pivot, axes: AXES3, arcs: ARCS3, planes: PLANES3 });
const P = (cam, p) => cam.worldToPx(p, SIZE);
const scaleV = (v, s) => v.map((x) => x * s);
const plus = (a, b) => a.map((x, i) => x + b[i]);

check("f3_the_handle_sets", () => {
    assert.deepEqual(ARCS3.map((a) => [a.name, a.n, a.from, a.to]), [
        ["X", [1, 0, 0], [0, 1, 0], [0, 0, 1]],
        ["Y", [0, 1, 0], [0, 0, 1], [1, 0, 0]],
        ["Z", [0, 0, 1], [1, 0, 0], [0, 1, 0]],
    ], "each a quarter turn from one positive axis to the next, about the third");
    assert.deepEqual(PLANES3, [{ n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], name: "Z" }, { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1], name: "X" }, { n: [0, 1, 0], a: [0, 0, 1], b: [1, 0, 0], name: "Y" }]);
    assert.deepEqual(PLANES2, [], "a sketch's own plane is the centre's");
    assert.deepEqual([ARROW_PX, HEAD_PX, HEAD_W, PLANE_AT, PLANE_PX, ARC_AT, GRIP_PX], [90, 14, 10, 0.38, 13, 0.75, 4.5]);
});

check("f3_arcs_and_squares_laid_out_in_the_oblique_view", () => {
    // 100 px a unit, so the arrow is 0.9 units, an arc 0.675 round, a square 0.13 a side.
    const g = layoutManipulator(look([0, 0, 0]), tilted, SIZE);
    near(g.centre, [400, 300], 1e-9, "the pivot");
    near(g.axes[0].tip, P(tilted, [0.9, 0, 0]), 1e-9, "X, 90 px out");
    assert.deepEqual(g.arcs.map((a) => a.name), ["X", "Y", "Z"], "nothing edge-on");
    const r = 0.75 * 0.9;
    for (const a of g.arcs) {
        const arc = ARCS3.find((k) => k.name === a.name);
        assert.equal(a.points.length, 13, `${a.name}: 13 samples`);
        near(a.points[0], P(tilted, scaleV(arc.from, r)), 1e-9, `${a.name} starts at from`);
        near(a.points[12], P(tilted, scaleV(arc.to, r)), 1e-9, `${a.name} ends at to`);
        near(a.points[6], P(tilted, plus(scaleV(arc.from, r * Math.SQRT1_2), scaleV(arc.to, r * Math.SQRT1_2))), 1e-9, `${a.name}: half way`);
        near(a.grip, a.points[6], 0, `${a.name}'s grip at its middle sample`);
        assert.equal(a.ring.length, 48, "the full ring, for the sweep");
        near(a.ring[0], a.points[0], 1e-9, "the ring starts at from");
        near(a.ring[12], a.points[12], 1e-9, "a quarter of the way round it, at to");
    }
    assert.deepEqual(g.planes.map((p) => p.name), ["Z", "X", "Y"]);
    for (const p of g.planes) {
        const pl = PLANES3.find((k) => k.name === p.name);
        near(p.centre, P(tilted, scaleV(plus(pl.a, pl.b), 0.38 * 0.9)), 1e-6, `${p.name}'s square centre`);
        assert.equal(p.quad.length, 4);
        const h = 0.065, c = scaleV(plus(pl.a, pl.b), 0.38 * 0.9);
        near(p.quad[0], P(tilted, plus(c, plus(scaleV(pl.a, -h), scaleV(pl.b, -h)))), 1e-9, `${p.name}'s first corner`);
        near(p.quad[2], P(tilted, plus(c, plus(scaleV(pl.a, h), scaleV(pl.b, h)))), 1e-9, `${p.name}'s opposite corner`);
    }
    // A pivot away from the origin: the square's centre in px to 1e-6.
    const g2 = layoutManipulator(look([1, 2, 3]), tilted, SIZE);
    near(g2.planes[0].centre, P(tilted, [1 + 0.342, 2 + 0.342, 3]), 1e-6, "the Z square at the pivot + 0.38 arrow (X + Y)");
});

check("f3_edge_on_arcs_and_squares_dropped", () => {
    const g = layoutManipulator(look([0, 0, 0]), top, SIZE);
    assert.deepEqual(g.axes.map((a) => a.name), ["X", "Y"]);
    near(g.axes[0].tip, [490, 300], 1e-9, "X, 90 px right");
    assert.deepEqual(g.arcs.map((a) => a.name), ["Z"], "the arcs about X and Y are edge-on");
    assert.deepEqual(g.planes.map((p) => p.name), ["Z"], "the squares about X and Y are edge-on");
    for (const p of g.arcs[0].points) assert.ok(Math.abs(Math.hypot(p[0] - 400, p[1] - 300) - 67.5) < 1e-9, "a 67.5 px arc");
    near(g.arcs[0].grip, [400 + 67.5 * Math.SQRT1_2, 300 - 67.5 * Math.SQRT1_2], 1e-9, "the grip at 45 degrees");
    near(g.planes[0].centre, [434.2, 265.8], 1e-6, "the square 34.2 px along X and Y");
    near(g.planes[0].quad.flat(), [427.7, 272.3, 440.7, 272.3, 440.7, 259.3, 427.7, 259.3], 1e-6, "13 px a side");
});

check("f3_hits_tips_squares_centre_grips_arcs_rings", () => {
    const g = layoutManipulator(look([0, 0, 0]), top, SIZE);
    assert.deepEqual(hitManipulator(g, [496, 305]), { kind: "move", name: "X", axis: [1, 0, 0] }, "within 9 px of the X tip");
    assert.deepEqual(hitManipulator(g, [434, 266]), { kind: "plane", name: "Z", axis: [0, 0, 1] }, "inside the Z square");
    assert.deepEqual(hitManipulator(g, [443.7, 266])?.kind, "plane", "3 px outside it");
    assert.equal(hitManipulator(g, [445.7, 266]), null, "5 px outside it");
    assert.deepEqual(hitManipulator(g, [403, 302]), { kind: "move", name: null, axis: null }, "the centre");
    const grip = g.arcs[0].grip, out = [Math.SQRT1_2, -Math.SQRT1_2];
    assert.deepEqual(hitManipulator(g, plus(grip, scaleV(out, 8.5))), { kind: "rotate", name: "Z", axis: [0, 0, 1] }, "8.5 px out from the grip: the grip");
    assert.equal(hitManipulator(g, plus(grip, scaleV(out, 9.5))), null, "9.5 px out: nothing");
    const t = Math.PI / 96;   // half way between the first two samples
    assert.deepEqual(hitManipulator(g, [400 + 74.5 * Math.cos(t), 300 - 74.5 * Math.sin(t)]), { kind: "rotate", name: "Z", axis: [0, 0, 1] }, "7 px outside the arc");
    assert.equal(hitManipulator(g, [400 + 76.5 * Math.cos(t), 300 - 76.5 * Math.sin(t)]), null, "9 px outside it");
    assert.equal(hitManipulator(g, [400 - 67.5, 300]), null, "the arc is a quarter: nothing on the far side");
    // Every kind at one pixel: tips, squares, the centre, grips, arcs, rings -- in that order.
    const crowd = {
        centre: [0, 0],
        axes: [{ name: "X", a: [1, 0, 0], tip: [0, 0] }],
        planes: [{ name: "Z", n: [0, 0, 1], quad: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }],
        arcs: [{ name: "Y", n: [0, 1, 0], points: [[-10, 0], [10, 0]], grip: [50, 50] }, { name: "Z", n: [0, 0, 1], points: [[50, 50], [60, 60]], grip: [0, 0] }],
        rings: [{ name: "X", n: [1, 0, 0], points: [[0, -10], [0, 10]] }],
        scale: null,
    };
    const order = [];
    for (const drop of [(c) => { c.axes = []; }, (c) => { c.planes = []; }, (c) => { c.centre = [500, 500]; }, (c) => { c.arcs[1].grip = [500, 500]; }, (c) => { c.arcs = []; }, (c) => { c.rings = []; }]) {
        const h = hitManipulator(crowd, [0, 0]);
        order.push(h && `${h.kind} ${h.name}`);
        drop(crowd);
    }
    order.push(hitManipulator(crowd, [0, 0]));
    assert.deepEqual(order, ["move X", "plane Z", "move null", "rotate Z", "rotate Y", "rotate X", null], "Z's grip before Y's arc");
});

check("f3_a_rings_only_manipulator_lays_out_as_before", () => {
    assert.deepStrictEqual(layoutManipulator(full([1, 2, 3]), top, SIZE), OLD.layouts.topFull);
    assert.deepStrictEqual(layoutManipulator(full([0, 0, 0]), tilted, SIZE), OLD.layouts.tiltedFull);
    assert.deepStrictEqual(layoutManipulator({ pivot: [0, 0, 0], axes: AXES3, rings: [], scale: false }, tilted, SIZE), OLD.layouts.tiltedBare);
});

check("f3_a_plane_drag_reads_the_ray_met_with_the_plane", () => {
    // The tilted camera is orthographic along LOOK: the ray through a point's pixel is that
    // point plus t LOOK, so it meets the plane z = 0 at the point itself.
    const pivot = [1, 2, 0];
    const h = { kind: "plane", name: "Z", axis: [0, 0, 1], pivot };
    near(manipulatorPoint(h, tilted, tilted.worldToPx([1.3, 2.5, 0]), SIZE), [1.3, 2.5, 0], 1e-9, "on the plane z = 0");
    // A pixel of a point off the plane: the ray from (0.5, 0.5, 1) along LOOK meets z = 0 at
    // t = 1 / -LOOK.z further on -- worked out from LOOK's components.
    const t = 1 / -LOOK[2], want = [0.5 + t * LOOK[0], 0.5 + t * LOOK[1], 0];
    near(manipulatorPoint(h, tilted, tilted.worldToPx([0.5, 0.5, 1]), SIZE), want, 1e-9, "a pixel of a point above it");
    // The plane about X through the pivot (x = 1).
    near(manipulatorPoint({ kind: "plane", name: "X", axis: [1, 0, 0], pivot }, tilted, tilted.worldToPx([1, 3, 4]), SIZE), [1, 3, 4], 1e-9, "on x = 1");
    // Edge-on to the eye: nothing.
    assert.equal(manipulatorPoint({ kind: "plane", axis: [1, 0, 0], pivot }, top, [400, 300], SIZE), null);
    const d = beginDrag(h, tilted, tilted.worldToPx([1.3, 2.5, 0]), SIZE);
    near(d.from, [1.3, 2.5, 0], 1e-9, "where it began");
    for (const q of [[1.8, 2.2, 0], [0.5, 0.5, 1], [-3, 7, 2]]) {
        const p = tilted.worldToPx(q, SIZE), delta = dragDelta(d, tilted, p, SIZE);
        assert.ok(Math.abs(delta.slide[2]) < 1e-12, `in the plane: ${delta.slide}`);
        near(delta.slide, manipulatorPoint(h, tilted, p, SIZE).map((v, i) => v - d.from[i]), 1e-12, "q - from");
        assert.deepEqual([delta.turn, delta.scale], [0, 1]);
    }
    near(dragDelta(d, tilted, tilted.worldToPx([1.8, 2.2, 0]), SIZE).slide, [0.5, -0.3, 0], 1e-9, "0.5 along X, -0.3 along Y");
});

check("f3_steps_on_the_grid_and_at_15_degrees", () => {
    const X = { kind: "move", name: "X", axis: [1, 0, 0] };
    near(stepDelta({ slide: [12.7, 0, 0], turn: 0, scale: 1 }, X, { step: 10, angle: 15 }).slide, [10, 0, 0], 1e-12, "12.7 by tens: 10");
    near(stepDelta({ slide: [12.7, 0, 0], turn: 0, scale: 1 }, X, { step: 5, angle: 15 }).slide, [15, 0, 0], 1e-12, "by fives: 15");
    near(stepDelta({ slide: [-12.7, 0, 0], turn: 0, scale: 1 }, X, { step: 5 }).slide, [-15, 0, 0], 1e-12, "backwards too");
    // Along an axis that is not the world's: the distance along it, stepped.
    const s = Math.SQRT1_2, D = { kind: "move", name: "X", axis: [s, s, 0] };
    near(stepDelta({ slide: [12.7 * s, 12.7 * s, 0], turn: 0, scale: 1 }, D, { step: 5 }).slide, [15 * s, 15 * s, 0], 1e-12, "along a slanted axis");
    // A square: each in-plane part, along its a and b.
    const Z = { kind: "plane", name: "Z", axis: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] };
    near(stepDelta({ slide: [12.7, -3.2, 0], turn: 0, scale: 1 }, Z, { step: 5 }).slide, [15, -5, 0], 1e-12, "X and Y by fives");
    const Y = { kind: "plane", name: "Y", axis: [0, 1, 0], a: [0, 0, 1], b: [1, 0, 0] };
    near(stepDelta({ slide: [7.4, 0, 2.6], turn: 0, scale: 1 }, Y, { step: 5 }).slide, [5, 0, 5], 1e-12, "Z and X by fives");
    // A turn by 15 degrees.
    const R = { kind: "rotate", name: "Z", axis: [0, 0, 1] };
    assert.ok(Math.abs(stepDelta({ slide: null, turn: 0.30, scale: 1 }, R, { step: 10, angle: 15 }).turn - 0.2618) < 1e-4, "0.30 rad: 15 degrees");
    assert.ok(Math.abs(stepDelta({ slide: null, turn: 0.40, scale: 1 }, R, { step: 10, angle: 15 }).turn - Math.PI / 6) < 1e-12, "0.40 rad: 30 degrees");
    assert.ok(Math.abs(stepDelta({ slide: null, turn: -0.40, scale: 1 }, R, { angle: 15 }).turn + Math.PI / 6) < 1e-12, "-0.40 rad: -30 degrees");
    // Free: as it came.
    const raw = { slide: [12.7, 0, 0], turn: 0, scale: 1 };
    assert.deepEqual(stepDelta(raw, X, { step: 10, angle: 15, free: true }), raw, "Shift: free");
    assert.deepEqual(stepDelta({ slide: null, turn: 0.3, scale: 1 }, R, { step: 10, angle: 15, free: true }).turn, 0.3);
    // The centre's free move follows the pointer: its snaps are the page's.
    const free = { slide: [12.7, 3.3, 1.1], turn: 0, scale: 1 };
    assert.deepEqual(stepDelta(free, { kind: "move", name: null, axis: null }, { step: 10, angle: 15 }), free, "the centre: not stepped");
    // No step given: nothing stepped; a delta of nothing is nothing.
    assert.deepEqual(stepDelta(raw, X, { angle: 15 }), raw);
    assert.equal(stepDelta(null, X, { step: 10 }), null);
});

// A context that records what is filled and stroked: each op with the style, the width, the
// alpha and the path built since the last beginPath (save and restore kept).
function recording() {
    const ops = [], texts = [], stack = [];
    let path = [];
    const st = { fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, globalAlpha: 1 };
    const ctx = new Proxy(st, {
        get: (o, k) => (k in o ? o[k] : (...a) => {
            if (k === "beginPath") path = [];
            else if (["moveTo", "lineTo", "arc", "closePath"].includes(k)) path.push([k, ...a]);
            else if (k === "fill" || k === "stroke") ops.push({ op: k, style: k === "fill" ? o.fillStyle : o.strokeStyle, width: o.lineWidth, alpha: o.globalAlpha, path: path.slice() });
            else if (k === "fillText") texts.push({ text: a[0], at: [a[1], a[2]], style: o.fillStyle });
            else if (k === "save") stack.push({ ...o });
            else if (k === "restore") Object.assign(o, stack.pop());
        }),
        set: (o, k, v) => { o[k] = v; return true; },
    });
    return { ctx, ops, texts };
}
// The old test's recorder, as the fixture's log was captured with: every call and every set.
function logging() {
    const log = [];
    const ctx = new Proxy({}, {
        get: (o, k) => (k in o ? o[k] : (...a) => { log.push([String(k), ...a]); }),
        set: (o, k, v) => { o[k] = v; log.push(["=" + String(k), Array.isArray(v) ? [...v] : v]); return true; },
    });
    return { ctx, log };
}
const pathPoints = (path) => path.filter((s) => s[0] === "moveTo" || s[0] === "lineTo").map((s) => [s[1], s[2]]);
const near2 = (a, b, tol = 1e-9) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// The axis colours mixed 35% toward white, worked by hand: X #e06060 -> (235, 152, 152), Z #6090e8 -> (152, 183, 240).
const BRIGHT = { X: "#eb9898", Z: "#98b7f0" };

check("f3_draws_heads_squares_and_arcs", () => {
    const g = layoutManipulator(look([0, 0, 0]), tilted, SIZE);
    const { ctx, ops, texts } = recording();
    drawManipulator(ctx, g, [0, 0, 800, 600]);
    for (const ax of g.axes) {
        const colour = AXIS_COLOURS[ax.name];
        const shaft = ops.find((o) => o.op === "stroke" && o.style === colour && o.width === 2.5 && o.path.length === 2);
        assert.ok(shaft, `${ax.name}: a shaft 2.5 wide`);
        const [from, base] = pathPoints(shaft.path);
        near(from, g.centre, 1e-9, `${ax.name}'s shaft from the centre`);
        const head = ops.find((o) => o.op === "fill" && o.style === colour && o.path.length === 4 && near2(pathPoints(o.path)[0], ax.tip));
        assert.ok(head, `${ax.name}: a filled head at the tip`);
        const [tip, c1, c2] = pathPoints(head.path);
        assert.ok(Math.abs(dist(tip, [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2]) - 14) < 1e-9, "14 px long");
        assert.ok(Math.abs(dist(c1, c2) - 10) < 1e-9, "10 px wide");
        near(base, [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2], 1e-9, "the shaft ends at the head's base");
        assert.ok(texts.some((t) => t.text === ax.name && dist(t.at, ax.tip) < 20 && dist(t.at, g.centre) > dist(ax.tip, g.centre)), `${ax.name}'s letter beyond its head`);
    }
    for (const pl of g.planes) {
        const colour = AXIS_COLOURS[pl.name];
        const fill = ops.find((o) => o.op === "fill" && o.style === colour && o.alpha === 0.55);
        assert.ok(fill, `${pl.name}: a square at alpha 0.55`);
        near(pathPoints(fill.path).flat(), pl.quad.flat(), 1e-9, `${pl.name}: the quad`);
        assert.equal(fill.path.at(-1)[0], "closePath");
        const edge = ops.find((o) => o.op === "stroke" && o.style === colour && o.width === 1 && o.alpha === 1 && near2(pathPoints(o.path).flat(), pl.quad.flat()));
        assert.ok(edge, `${pl.name}: outlined 1 px at full alpha`);
    }
    for (const arc of g.arcs) {
        const colour = AXIS_COLOURS[arc.name];
        const line = ops.find((o) => o.op === "stroke" && o.style === colour && o.width === 2.5 && o.path.length === 13);
        assert.ok(line, `${arc.name}: an arc 2.5 wide`);
        near(pathPoints(line.path).flat(), arc.points.flat(), 1e-9, `${arc.name}: its 13 points`);
        const grip = ops.find((o) => o.op === "fill" && o.style === colour && o.path.length === 1 && o.path[0][0] === "arc");
        assert.ok(grip, `${arc.name}: a grip`);
        near(grip.path[0].slice(1, 4), [...arc.grip, 4.5], 1e-9, `${arc.name}: the grip 4.5 round at the middle`);
    }
    assert.equal(ops.filter((o) => o.alpha !== 1 && o.alpha !== 0.55).length, 0, "no sweep without one");
});

check("f3_hover_brightens_hot_stays_the_accent", () => {
    const g = layoutManipulator(look([0, 0, 0]), tilted, SIZE);
    const arcOf = (ops, colour) => ops.find((o) => o.op === "stroke" && o.style === colour && o.path.length === 13);
    let r = recording();
    drawManipulator(r.ctx, g, [0, 0, 800, 600], { hover: (kind, name) => kind === "rotate" && name === "Z" });
    const z = arcOf(r.ops, BRIGHT.Z);
    assert.ok(z, "the hovered arc mixed 35% toward white");
    assert.equal(z.width, 3.5, "and 1 px wider");
    assert.ok(arcOf(r.ops, AXIS_COLOURS.X)?.width === 2.5, "the others as they were");
    assert.ok(r.ops.some((o) => o.op === "fill" && o.style === BRIGHT.Z && o.path[0][0] === "arc"), "its grip too");
    r = recording();
    drawManipulator(r.ctx, g, [0, 0, 800, 600], { hover: (kind, name) => kind === "move" && name === "X" });
    assert.ok(r.ops.some((o) => o.op === "stroke" && o.style === BRIGHT.X && o.width === 3.5 && o.path.length === 2), "a hovered arrow's shaft");
    r = recording();
    drawManipulator(r.ctx, g, [0, 0, 800, 600], { hover: (kind, name) => kind === "plane" && name === "Z" });
    assert.ok(r.ops.some((o) => o.op === "fill" && o.style === BRIGHT.Z && o.alpha === 0.55), "a hovered square");
    assert.ok(r.ops.some((o) => o.op === "stroke" && o.style === BRIGHT.Z && o.width === 2), "its outline 1 px wider");
    r = recording();
    const held = (kind, name) => kind === "rotate" && name === "Z";
    drawManipulator(r.ctx, g, [0, 0, 800, 600], { hover: held, hot: held, colours: { accent: "#123456" } });
    assert.ok(arcOf(r.ops, "#123456"), "held: the accent");
    assert.ok(!arcOf(r.ops, BRIGHT.Z), "not the hover's");
});

check("f3_the_sweep_of_a_turn", () => {
    const g = layoutManipulator(look([0, 0, 0]), tilted, SIZE);
    const z = g.arcs.find((a) => a.name === "Z"), colour = AXIS_COLOURS.Z;
    const sweepOf = (turn) => { const r = recording(); drawManipulator(r.ctx, g, [0, 0, 800, 600], { sweep: { name: "Z", turn } }); return r.ops; };
    let ops = sweepOf(Math.PI / 4);
    const ring = ops.find((o) => o.op === "stroke" && o.alpha === 0.35);
    assert.ok(ring && ring.style === colour, "the whole ring, faint, in the axis colour");
    near(pathPoints(ring.path).flat(), z.ring.flat(), 1e-9, "its 48 points");
    assert.equal(ring.path.at(-1)[0], "closePath");
    const wedge = ops.find((o) => o.op === "fill" && o.alpha === 0.2);
    assert.ok(wedge && wedge.style === colour, "the wedge at alpha 0.2");
    near(pathPoints(wedge.path).flat(), [g.centre, ...z.ring.slice(0, 7)].flat(), 1e-9, "45 degrees: the centre and six steps of 7.5 from `from`");
    ops = sweepOf(-Math.PI / 4);
    near(pathPoints(ops.find((o) => o.op === "fill" && o.alpha === 0.2).path).flat(), [g.centre, z.ring[0], ...z.ring.slice(42).reverse()].flat(), 1e-9, "backwards round the ring");
    ops = sweepOf(0.1);
    const f = 0.1 / (Math.PI / 24), last = pathPoints(ops.find((o) => o.op === "fill" && o.alpha === 0.2).path).at(-1);
    near(last, [z.ring[0][0] + f * (z.ring[1][0] - z.ring[0][0]), z.ring[0][1] + f * (z.ring[1][1] - z.ring[0][1])], 1e-9, "between two samples: on the chord");
    assert.doesNotThrow(() => drawManipulator(recording().ctx, layoutManipulator(look([0, 0, 0]), top, SIZE), [0, 0, 800, 600], { sweep: { name: "X", turn: 1 } }), "an edge-on arc: no sweep");
});

check("f3_a_rings_only_manipulator_draws_as_before", () => {
    const layouts = { topFull: layoutManipulator(full([1, 2, 3]), top, SIZE), tiltedFull: layoutManipulator(full([0, 0, 0]), tilted, SIZE) };
    const draw = (g, rect, opts) => { const r = logging(); drawManipulator(r.ctx, g, rect, opts); return JSON.parse(JSON.stringify(r.log)); };
    assert.deepStrictEqual(draw(layouts.tiltedFull, [10, 20, 800, 600], {}), OLD.draws.tilted);
    assert.deepStrictEqual(draw(layouts.tiltedFull, [10, 20, 800, 600], { hot: (k, n) => k === "rotate" && n === "Y" }), OLD.draws.tiltedHotY);
    assert.deepStrictEqual(draw(layouts.tiltedFull, [0, 0, 800, 600], { hollow: true }), OLD.draws.tiltedHollow);
    assert.deepStrictEqual(draw(layouts.topFull, [0, 0, 800, 600], { hot: (k, n) => k === "move" && n === "X", colours: { accent: "#123456" } }), OLD.draws.top);
});

console.log(`ok manipulator: ${checks} checks`);
