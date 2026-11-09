// The forge's constraint layer against the real wasm (run `npm run setup` first).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm } from "./package.mjs";
import { KINDS, DIMENSIONS, spotsOf, buildModel, freeModel, writeBack, rebase } from "../forge-constraints.js";
import { inferForCurve, migrateCoincidences, pruneConstraints } from "../forge-constraints.js";
import { solveModel, dragModel, diagnoseModel, addConstraint, removeConstraint, setValue, setDriving, measure, nextConstraintId } from "../forge-constraints.js";
import { placeSpot } from "../forge-constraints.js";
import { stackMarks } from "../forge-constraints.js";
import { retryRefused, revertRetried, isConflictRefusal } from "../forge-constraints.js";
import { mergedEnds, remapMerged, remapExploded } from "../forge-constraints.js";

const here = dirname(fileURLToPath(import.meta.url));
const w = await loadWasm();

const sketch = (constraints) => ({ id: 1, kind: "sketch", constraints });
const curve = (id, kind, shape) => ({ id, kind, plane: 1, shape });
const byId = (cs) => new Map(cs.map((c) => [c.id, c]));

// 27 kinds in code order, 11 dimensions
assert.equal(KINDS.length, 27);
assert.equal(KINDS[0], "coincident");
assert.equal(KINDS[26], "diameter");
assert.equal(DIMENSIONS.size, 11);

// spots per kind
assert.deepEqual(spotsOf(curve(2, "line", { x0: 0, y0: 0, x1: 1, y1: 0 })), ["start", "end", "curve"]);
assert.deepEqual(spotsOf(curve(2, "rect", { x0: 0, y0: 0, x1: 1, y1: 1 })), ["corner:0", "corner:1", "corner:2", "corner:3", "side:0", "side:1", "side:2", "side:3"]);
assert.deepEqual(spotsOf(curve(2, "polyline", { points: [[0, 0], [1, 0], [1, 1]], closed: false })), ["vertex:0", "vertex:1", "vertex:2", "side:0", "side:1", "start", "end"]);

// an unconstrained build writes nothing back
{
    const cs = [
        curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 1 }),
        curve(3, "arc", { x0: 10, y0: 0, xm: 13, ym: 3, x1: 10, y1: 6 }),
        curve(4, "circle", { cx: 20, cy: 20, r: 4 }),
        curve(5, "rect", { x0: 30, y0: 0, x1: 40, y1: 8 }),
        curve(6, "polygon", { cx: 0, cy: 30, r: 5, sides: 6, angle: 15 }),
        curve(7, "nurbs", { points: [[0, 50], [5, 55], [10, 50], [15, 55]], weights: null, degree: 3, closed: false }),
        curve(8, "ellipse", { cx: 50, cy: 50, rx: 6, ry: 3 }),
    ];
    const m = buildModel(w, sketch([]), cs);
    assert.deepEqual(m.stale, []);
    assert.deepEqual(m.refused, []);
    w.cadaclysm_blacksmith_sketch_solve(m.h);
    assert.deepEqual(writeBack(w, m, byId(cs)), [], "a solved, unconstrained sketch moves nothing");
    freeModel(w, m);
}

// a clockwise 3-point arc round-trips with its direction kept
{
    const arc = curve(2, "arc", { x0: 0, y0: 6, xm: 3, ym: 3, x1: 0, y1: 0 });
    const m = buildModel(w, sketch([]), [arc]);
    assert.equal(m.parts.get(2).reversed, true);
    const s = m.entity.get("2:start");
    w.cadaclysm_blacksmith_sketch_drag(m.h, Uint32Array.of(s), Float64Array.of(0, 7));
    const [moved] = writeBack(w, m, byId([arc]));
    assert.equal(moved.id, 2);
    assert.ok(Math.abs(moved.shape.x0) < 1e-9 && Math.abs(moved.shape.y0 - 7) < 1e-9, JSON.stringify(moved.shape));
    // the through-point stays on the arc between its ends, on the side it was drawn
    const c = w.cadaclysm_blacksmith_sketch_point(m.h, m.entity.get("2:centre"));
    const r = Math.hypot(moved.shape.x0 - c[0], moved.shape.y0 - c[1]);
    assert.ok(Math.abs(Math.hypot(moved.shape.xm - c[0], moved.shape.ym - c[1]) - r) < 1e-9);
    assert.ok(moved.shape.xm > c[0], "the through-point is still on the arc's own side");
    freeModel(w, m);
}

// a dragged polygon vertex keeps it regular
{
    const poly = curve(2, "polygon", { cx: 0, cy: 0, r: 5, sides: 5, angle: 0 });
    const m = buildModel(w, sketch([]), [poly]);
    w.cadaclysm_blacksmith_sketch_drag(m.h, Uint32Array.of(m.entity.get("2:vertex:0")), Float64Array.of(8, 0));
    const [moved] = writeBack(w, m, byId([poly]));
    assert.equal(moved.shape.sides, 5);
    assert.ok(Math.abs(moved.shape.r - Math.hypot(8 - moved.shape.cx, 0 - moved.shape.cy)) < 1e-9);
    freeModel(w, m);
}

// stored constraints bind spots; a missing spot is stale, not an error
{
    const a = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 });
    const b = curve(3, "line", { x0: 10, y0: 0, x1: 10, y1: 5 });
    const m = buildModel(w, sketch([
        { id: 1, kind: "coincident", refs: [{ curve: 2, at: "end" }, { curve: 3, at: "start" }] },
        { id: 2, kind: "length", refs: [{ curve: 3, at: "curve" }], value: 5, driving: true },
        { id: 3, kind: "horizontal", refs: [{ curve: 9, at: "start" }, { curve: 2, at: "end" }] },
    ]), [a, b]);
    assert.deepEqual(m.stale, [3]);
    assert.equal(m.kernelOf.size, 2);
    freeModel(w, m);
}
// a rectangle fixed at a corner with both sizes is fully defined; its free curves go away
{
    const r = curve(2, "rect", { x0: 0, y0: 0, x1: 40, y1: 30 });
    const m = buildModel(w, sketch([]), [r]);
    assert.equal(diagnoseModel(w, m).state, "under");
    assert.ok(diagnoseModel(w, m).freeCurves.has(2));
    assert.ok(addConstraint(w, m, { id: 1, kind: "fix", refs: [{ curve: 2, at: "corner:0" }] }).ok);
    assert.ok(addConstraint(w, m, { id: 2, kind: "length", refs: [{ curve: 2, at: "side:0" }], value: 60, driving: true }).ok);
    assert.ok(addConstraint(w, m, { id: 3, kind: "length", refs: [{ curve: 2, at: "side:1" }], value: 30, driving: true }).ok);
    const d = diagnoseModel(w, m);
    assert.equal(d.state, "full");
    assert.equal(d.freeCurves.size, 0);
    const [moved] = writeBack(w, m, byId([r]));
    assert.ok(Math.abs(moved.shape.x1 - 60) < 1e-9);
    // a conflicting diagonal is refused, names what it fights, and changes nothing
    const refused = addConstraint(w, m, { id: 4, kind: "distance", refs: [{ curve: 2, at: "corner:0" }, { curve: 2, at: "corner:2" }], value: 10, driving: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /over-constrained/);
    assert.ok(refused.with.includes(2) && refused.with.includes(3), JSON.stringify(refused.with));
    assert.ok(!refused.with.includes(4));
    assert.equal(m.kernelOf.has(4), false);
    assert.ok(Math.abs(measure(w, m, 2) - 60) < 1e-9);
    // a dimension edit moves the geometry
    assert.ok(setValue(w, m, 2, 50).ok);
    assert.ok(Math.abs(writeBack(w, m, byId([r]))[0].shape.x1 - 50) < 1e-9);
    // a driven dimension reports; made driving again it holds what it measures
    const driven = setDriving(w, m, 3, false);
    assert.ok(driven.ok && driven.report.status === "converged", JSON.stringify(driven));
    assert.equal(diagnoseModel(w, m).state, "under");
    assert.ok(setDriving(w, m, 3, true).ok);
    assert.equal(diagnoseModel(w, m).state, "full");
    // removing a constraint frees what it held
    removeConstraint(w, m, 1);
    assert.equal(m.kernelOf.has(1), false);
    assert.equal(diagnoseModel(w, m).state, "under");
    const unknown = setValue(w, m, 1, 5);
    assert.equal(unknown.ok, false);
    freeModel(w, m);
}

// a drag through a coincident joint carries the other line along
{
    const a = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 });
    const b = curve(3, "line", { x0: 10, y0: 0, x1: 10, y1: 5 });
    const m = buildModel(w, sketch([{ id: 1, kind: "coincident", refs: [{ curve: 2, at: "end" }, { curve: 3, at: "start" }] }]), [a, b]);
    const rep = dragModel(w, m, [{ curve: 2, at: "end", x: 12, y: 1 }]);
    assert.equal(rep.status, "converged");
    assert.ok(Array.isArray(rep.ids) && Number.isFinite(rep.iterations) && Number.isFinite(rep.residual));
    const moved = new Map(writeBack(w, m, byId([a, b])).map((c) => [c.id, c.shape]));
    assert.ok(Math.abs(moved.get(3).x0 - 12) < 1e-9 && Math.abs(moved.get(3).y0 - 1) < 1e-9);
    assert.equal(solveModel(w, m).status, "converged");
    freeModel(w, m);
}
assert.equal(nextConstraintId(sketch([])), 1);
assert.equal(nextConstraintId(sketch(undefined)), 1);
assert.equal(nextConstraintId(sketch([{ id: 4 }, { id: 9 }])), 10);

// a polygon whose session vertices fold out of order is not written, and says so
{
    const sq = curve(2, "polygon", { cx: 0, cy: 0, r: 5, sides: 4, angle: 0 });
    const m = buildModel(w, sketch([]), [sq]);
    // +x, -y, -x, +y: every side still equal and on the ring, but run clockwise
    w.cadaclysm_blacksmith_sketch_set_point(m.h, m.entity.get("2:vertex:1"), 0, -5);
    w.cadaclysm_blacksmith_sketch_set_point(m.h, m.entity.get("2:vertex:3"), 0, 5);
    assert.equal(solveModel(w, m).status, "converged");
    assert.deepEqual(writeBack(w, m, byId([sq])), []);
    assert.deepEqual(m.withheld.map((x) => x.id), [2], JSON.stringify(m.withheld));
    assert.match(m.withheld[0].error, /polygon 2/);
    freeModel(w, m);
}
// a regular drag leaves nothing withheld
{
    const poly = curve(2, "polygon", { cx: 0, cy: 0, r: 5, sides: 5, angle: 0 });
    const m = buildModel(w, sketch([]), [poly]);
    dragModel(w, m, [{ curve: 2, at: "vertex:0", x: 8, y: 0 }]);
    assert.equal(writeBack(w, m, byId([poly])).length, 1);
    assert.deepEqual(m.withheld, []);
    freeModel(w, m);
}

// a curve refused part way leaves none of its entities behind
{
    const a = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 });
    const c = curve(3, "circle", { cx: 5, cy: 5, r: 0 });
    const m = buildModel(w, sketch([]), [a, c]);
    assert.equal(m.refused.length, 1);
    assert.equal(diagnoseModel(w, m).free, 4);
    assert.deepEqual(Array.from(w.cadaclysm_blacksmith_sketch_entities(m.h)).length, 3);
    freeModel(w, m);
}

// unknown sense or end names are refused, not defaulted
{
    const a = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 });
    const b = curve(3, "line", { x0: 0, y0: 0, x1: 10, y1: 5 });
    const m = buildModel(w, sketch([
        { id: 1, kind: "angle", refs: [{ curve: 2, at: "curve" }, { curve: 3, at: "curve" }], value: 0.4, driving: true, sense: "sideways" },
        { id: 2, kind: "parallel", refs: [{ curve: 2, at: "curve" }, { curve: 3, at: "curve" }], end: "middle" },
    ]), [a, b]);
    assert.deepEqual(m.refused.map((x) => x.id).sort(), [1, 2], JSON.stringify(m.refused));
    assert.equal(m.kernelOf.size, 0);
    const added = addConstraint(w, m, { id: 3, kind: "angle", refs: [{ curve: 2, at: "curve" }, { curve: 3, at: "curve" }], value: 0.4, driving: true, sense: "up" });
    assert.equal(added.ok, false);
    assert.match(added.error, /sense/);
    freeModel(w, m);
}
// ---- inference, migration, pruning ----
{
    const ang = (deg) => ({ x0: 0, y0: 0, x1: 10 * Math.cos(deg * Math.PI / 180), y1: 10 * Math.sin(deg * Math.PI / 180) });
    const kinds = (c, snaps = [], others = []) => inferForCurve(c, snaps, byId([c, ...others]), 5).map((k) => k.kind);
    assert.deepEqual(kinds(curve(2, "line", ang(2.5))), ["horizontal"]);
    assert.deepEqual(kinds(curve(2, "line", ang(3.5))), []);
    assert.deepEqual(kinds(curve(2, "line", ang(87.5))), ["vertical"]);
    assert.deepEqual(kinds(curve(2, "line", ang(86.5))), []);
    assert.deepEqual(kinds(curve(2, "line", { x0: 1, y0: 1, x1: 1, y1: 1 })), []);
    assert.deepEqual(kinds(curve(2, "line", { x0: 1, y0: 1, x1: 1 + 1e-10, y1: 1 })), []);
    const hk = inferForCurve(curve(2, "line", ang(1)), [], byId([]), 7);
    assert.deepEqual(hk[0].refs, [{ curve: 2, at: "start" }, { curve: 2, at: "end" }]);
    assert.equal(hk[0].id, 7);

    // coincident from snaps
    const l1 = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 5 });
    const l2 = curve(3, "line", { x0: 10, y0: 5, x1: 20, y1: 20 });
    const co = inferForCurve(l2, [{ at: "start", target: { curve: 2, at: "end" } }], byId([l1, l2]), 1);
    assert.deepEqual(co.map((k) => k.kind), ["coincident"]);
    assert.deepEqual(co[0].refs, [{ curve: 3, at: "start" }, { curve: 2, at: "end" }]);
    const rc = curve(4, "rect", { x0: 0, y0: 0, x1: 3, y1: 3 });
    assert.deepEqual(kinds(l2, [{ at: "end", target: { curve: 4, at: "corner:2" } }], [rc]), ["coincident"]);
    assert.deepEqual(kinds(l2, [{ at: "curve", target: { curve: 2, at: "end" } }], [l1]), []);

    // concentric
    const c1 = curve(2, "circle", { cx: 5, cy: 5, r: 2 });
    const c2 = curve(3, "circle", { cx: 5, cy: 5, r: 4 });
    const cc = inferForCurve(c2, [{ at: "centre", target: { curve: 2, at: "centre" } }], byId([c1, c2]), 1);
    assert.deepEqual(cc.map((k) => k.kind), ["concentric"]);
    assert.deepEqual(cc[0].refs, [{ curve: 3, at: "curve" }, { curve: 2, at: "curve" }]);
    const pg = curve(4, "polygon", { cx: 5, cy: 5, r: 3, sides: 5, angle: 0 });
    const cp = inferForCurve(c2, [{ at: "centre", target: { curve: 4, at: "centre" } }], byId([pg, c2]), 1);
    assert.deepEqual(cp.map((k) => k.kind), ["coincident"]);
    assert.deepEqual(cp[0].refs, [{ curve: 3, at: "centre" }, { curve: 4, at: "centre" }]);

    // tangent: a line along +x ending at (10, 0); an arc starting there, leaving at `deg` from +x
    const ln = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 });
    const arcAt = (deg, dir = 1) => {
        const t = deg * Math.PI / 180, r = 5;
        // a circle through (10,0) whose tangent there is (cos t, sin t); dir -1 runs it clockwise
        const o = [10 - dir * r * Math.sin(t), dir * r * Math.cos(t)];
        const a0 = Math.atan2(-o[1], 10 - o[0]);
        const pt = (a) => [o[0] + r * Math.cos(a), o[1] + r * Math.sin(a)];
        const m = pt(a0 + dir * 0.6), e = pt(a0 + dir * 1.2);
        return curve(3, "arc", { x0: 10, y0: 0, xm: m[0], ym: m[1], x1: e[0], y1: e[1] });
    };
    const snapEnd = [{ at: "start", target: { curve: 2, at: "end" } }];
    const t4 = inferForCurve(arcAt(4), snapEnd, byId([ln]), 1);
    assert.deepEqual(t4.map((k) => k.kind), ["coincident", "tangent"]);
    assert.deepEqual(t4[1].refs, [{ curve: 2, at: "curve" }, { curve: 3, at: "curve" }]);
    assert.equal(t4[1].sense, "auto");
    assert.deepEqual(inferForCurve(arcAt(6), snapEnd, byId([ln]), 1).map((k) => k.kind), ["coincident"]);
    // a clockwise arc leaving at 4 degrees, and at 6
    assert.deepEqual(inferForCurve(arcAt(4, -1), snapEnd, byId([ln]), 1).map((k) => k.kind), ["coincident", "tangent"]);
    assert.deepEqual(inferForCurve(arcAt(6, -1), snapEnd, byId([ln]), 1).map((k) => k.kind), ["coincident"]);
    // a cusp (the arc doubles back along the line) is only coincident
    for (const dir of [1, -1]) for (const d of [176, 184]) {
        assert.deepEqual(inferForCurve(arcAt(d, dir), snapEnd, byId([ln]), 1).map((k) => k.kind), ["coincident"], `cusp ${d} ${dir}`);
    }
    // at the line's START the line travels in along -d: carrying on along -d is tangent
    const ls = curve(2, "line", { x0: 10, y0: 0, x1: 20, y1: 0 });
    const snapStart = [{ at: "start", target: { curve: 2, at: "start" } }];
    for (const dir of [1, -1]) {
        assert.deepEqual(inferForCurve(arcAt(176, dir), snapStart, byId([ls]), 1).map((k) => k.kind), ["coincident", "tangent"]);
        assert.deepEqual(inferForCurve(arcAt(4, dir), snapStart, byId([ls]), 1).map((k) => k.kind), ["coincident"]);
    }
    // never between two spots of one curve
    assert.deepEqual(inferForCurve(arcAt(0), [{ at: "start", target: { curve: 3, at: "end" } }], byId([arcAt(0)]), 1), []);
    // no snap, no tangent
    assert.deepEqual(inferForCurve(arcAt(4), [], byId([ln]), 1), []);
}
{
    const mk = (cs) => migrateCoincidences({ id: 1, kind: "sketch" }, cs);
    const a = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 5 });
    const b = curve(3, "line", { x0: 10, y0: 5, x1: 20, y1: 0 });
    const m2 = mk([a, b]);
    assert.equal(m2.length, 1);
    assert.deepEqual(m2[0], { id: 1, kind: "coincident", refs: [{ curve: 2, at: "end" }, { curve: 3, at: "start" }], driving: true });
    const c = curve(4, "line", { x0: 30, y0: 30, x1: 10, y1: 5 });
    const m3 = mk([a, b, c]);
    assert.equal(m3.length, 2);
    assert.deepEqual(m3.map((k) => k.id), [1, 2]);
    assert.ok(m3.every((k) => k.refs[0].curve === 2 && k.refs[0].at === "end"));
    assert.equal(mk([a, curve(3, "line", { x0: 10, y0: 5 + 1e-9, x1: 20, y1: 0 })]).length, 0);
    const pl = curve(5, "polyline", { points: [[0, 0], [4, 4]], closed: false });
    assert.equal(mk([a, pl]).length, 1);
    assert.equal(migrateCoincidences({ id: 1, kind: "sketch", constraints: [] }, [a, b]).length, 0);
}
{
    const l = curve(2, "line", { x0: 0, y0: 0, x1: 1, y1: 0 });
    const p = curve(3, "polyline", { points: [[0, 0], [1, 0], [1, 1]], closed: false });
    const keep = { id: 1, kind: "coincident", refs: [{ curve: 2, at: "end" }, { curve: 3, at: "vertex:2" }] };
    const gone = { id: 2, kind: "horizontal", refs: [{ curve: 9, at: "start" }, { curve: 2, at: "end" }] };
    const vtx = { id: 3, kind: "coincident", refs: [{ curve: 2, at: "end" }, { curve: 3, at: "vertex:3" }] };
    const r = pruneConstraints([keep, gone, vtx], byId([l, p]));
    assert.deepEqual(r.kept.map((k) => k.id), [1]);
    assert.deepEqual(r.dropped.map((k) => k.id), [2, 3]);
}
// base is read before the stored constraints go in. An arc whose through-point
// is off its mid-angle and a polygon at -30 degrees, untouched by an unrelated constraint,
// are not written; a line the constraint moved at build time is; a rebased curve is
// skipped until it moves again.
{
    const arc = curve(2, "arc", { x0: 10, y0: 0, xm: 0, ym: 10, x1: -6, y1: -8 });   // the through-point is not at the mid-angle
    const poly = curve(3, "polygon", { cx: 40, cy: 0, r: 5, sides: 6, angle: -30 });
    const a = curve(4, "line", { x0: 0, y0: 30, x1: 10, y1: 30 });
    const b = curve(5, "line", { x0: 12, y0: 31, x1: 20, y1: 40 });
    const m = buildModel(w, sketch([{ id: 1, kind: "coincident", refs: [{ curve: 4, at: "end" }, { curve: 5, at: "start" }] }]), [arc, poly, a, b]);
    assert.equal(solveModel(w, m).status, "converged");
    const out = writeBack(w, m, byId([arc, poly, a, b]));
    assert.deepEqual(out.map((c) => c.id).filter((id) => id === 2 || id === 3), [], "untouched arc and polygon are not rewritten");
    assert.ok(out.some((c) => c.id === 4 || c.id === 5), "the line pair the coincident moved at build time is written");
    const after = [arc, poly, a, b].map((c) => ({ ...c, shape: out.find((o) => o.id === c.id)?.shape ?? c.shape }));
    rebase(w, m, after);
    assert.deepEqual(writeBack(w, m, byId(after)), [], "rebased curves are skipped");
    freeModel(w, m);
}
// a typed radius held exactly by a throwaway driving radius while the
// rest solves (the forge's typed-r path); refused, naming the dimension, where one holds it.
{
    const circ = curve(2, "circle", { cx: 0, cy: 10, r: 10 });
    const ln = curve(3, "line", { x0: -20, y0: 0, x1: 20, y1: 0 });
    const m = buildModel(w, sketch([{ id: 1, kind: "tangent", refs: [{ curve: 2, at: "curve" }, { curve: 3, at: "curve" }] }]), [circ, ln]);
    const tmp = addConstraint(w, m, { id: -1, kind: "radius", refs: [{ curve: 2, at: "curve" }], value: 12, driving: true });
    assert.equal(tmp.ok, true, JSON.stringify(tmp));
    assert.equal(solveModel(w, m).status, "converged");
    const out = new Map(writeBack(w, m, byId([circ, ln])).map((c) => [c.id, c.shape]));
    removeConstraint(w, m, -1);
    assert.ok(Math.abs(out.get(2)?.r - 12) <= 1e-9 * 12, `r lands exactly: ${JSON.stringify(out.get(2))}`);
    assert.ok(out.has(3), "the free line moves to stay tangent");
    assert.ok(!m.kernelOf.has(-1));
    freeModel(w, m);
}
{
    const circ = curve(2, "circle", { cx: 0, cy: 0, r: 10 });
    const m = buildModel(w, sketch([{ id: 4, kind: "radius", refs: [{ curve: 2, at: "curve" }], value: 10, driving: true }]), [circ]);
    const tmp = addConstraint(w, m, { id: -1, kind: "radius", refs: [{ curve: 2, at: "curve" }], value: 12, driving: true });
    assert.equal(tmp.ok, false);
    assert.deepEqual(tmp.with, [4]);
    assert.deepEqual(writeBack(w, m, byId([circ])), [], "a refused radius changes nothing");
    freeModel(w, m);
}
// a polycurve's fixed end placed (a block carried by the gizmo): what is held to it follows
// at the next drag, and the end stays where it was put.
{
    const pc = curve(2, "polycurve", { pieces: [{ kind: "line", shape: { x0: 0, y0: 0, x1: 10, y1: 0 } }], closed: false, ends: [[0, 0], [10, 0]] });
    const ln = curve(3, "line", { x0: 10, y0: 0, x1: 20, y1: 5 });
    const m = buildModel(w, sketch([{ id: 1, kind: "coincident", refs: [{ curve: 3, at: "start" }, { curve: 2, at: "end" }] }]), [pc, ln]);
    placeSpot(w, m, 2, "end", 10, 4);
    assert.equal(dragModel(w, m, [{ curve: 3, at: "end", x: 20, y: 5 }]).status, "converged");
    const out = new Map(writeBack(w, m, byId([pc, ln])).map((c) => [c.id, c.shape]));
    assert.ok(Math.hypot(out.get(3).x0 - 10, out.get(3).y0 - 4) < 1e-9, JSON.stringify(out.get(3)));
    assert.deepEqual(Array.from(w.cadaclysm_blacksmith_sketch_point(m.h, m.entity.get("2:end"))), [10, 4]);
    assert.throws(() => placeSpot(w, m, 2, "curve", 0, 0));
    freeModel(w, m);
}
// a build that throws part way frees the session it made (no leaked handle)
{
    let made = 0, freed = 0;
    const leaky = new Proxy(w, { get: (t, k) => k === "cadaclysm_blacksmith_sketch_new" ? () => { made++; return t[k](); }
        : k === "cadaclysm_blacksmith_sketch_free" ? (h) => { freed++; return t[k](h); }
        : k === "cadaclysm_blacksmith_sketch_point" ? () => { throw new Error("no point"); } : t[k] });
    assert.throws(() => buildModel(leaky, sketch([]), [curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 })]), /no point/);
    assert.deepEqual([made, freed], [1, 1], "the handle is freed");
}
// the glyphs' stacking: the old linear placement, kept here as the oracle
function stackLinear(anchors) {
    const slots = [], boxes = [];
    return anchors.map((p) => {
        if (!p) return null;
        let slot = slots.find((s) => Math.hypot(s.p[0] - p[0], s.p[1] - p[1]) < 12);
        if (!slot) { slot = { p, n: 0 }; slots.push(slot); }
        let x = slot.p[0] + 12 + 16 * slot.n;
        const y = slot.p[1] - 12;
        while (boxes.some((b) => Math.abs(b[0] - x) < 15 && Math.abs(b[1] - y) < 15)) { x += 16; slot.n++; }
        slot.n++;
        boxes.push([x, y]);
        return [x, y];
    });
}
{
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 20; trial++) {
        const centres = Array.from({ length: 30 }, () => [rnd() * 800, rnd() * 600]);
        const anchors = Array.from({ length: 400 }, () => rnd() < 0.05 ? null : (([x, y]) => [x + rnd() * 20 - 10, y + rnd() * 20 - 10])(centres[Math.floor(rnd() * 30)]));
        assert.deepEqual(stackMarks(anchors), stackLinear(anchors), `trial ${trial}`);
    }
    // clusters far and near, fractional and whole pixels, strongly negative ones, gaps (null),
    // and anchors off any finite pixel (NaN, Infinity): never blocked, never blocking
    for (let trial = 0; trial < 300; trial++) {
        const spread = [50, 200, 2000][trial % 3], jit = [3, 12, 30][Math.floor(trial / 3) % 3];
        const far = trial % 5 === 0 ? -1e6 : 0;
        const centres = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => [far + rnd() * spread - spread / 2, far + rnd() * spread - spread / 2]);
        const anchors = Array.from({ length: 600 }, () => {
            const r = rnd();
            if (r < 0.03) return null;
            if (r < 0.04) return [NaN, 5];
            if (r < 0.045) return [Infinity, -Infinity];
            const [x, y] = centres[Math.floor(rnd() * centres.length)];
            const q = [x + rnd() * jit * 2 - jit, y + rnd() * jit * 2 - jit];
            return trial % 2 ? q.map(Math.round) : q;
        });
        assert.deepEqual(stackMarks(anchors), stackLinear(anchors), `cluster trial ${trial}`);
    }
    // anchors on exact pitches: the 12 px slot, the 15 px box and the 16 px step each met on the nose
    for (let trial = 0; trial < 50; trial++) {
        const [px, py] = [[12, 15], [15, 12], [16, 9], [3, 3]][trial % 4];
        const anchors = Array.from({ length: 500 }, () => [Math.floor(rnd() * 20) * px, Math.floor(rnd() * 20) * py]);
        assert.deepEqual(stackMarks(anchors), stackLinear(anchors), `pitch trial ${trial}`);
    }
    // a big sketch's marks: well under the linear scan's time
    const many = Array.from({ length: 20000 }, (_, i) => [(i % 200) * 9, Math.floor(i / 200) * 9]);
    const t = performance.now();
    stackMarks(many);
    assert.ok(performance.now() - t < 250, `stackMarks took ${performance.now() - t} ms`);
}
// a point held on a circle while it sits at the centre is refused (the kernel reads the
// degenerate geometry as over-constrained); dragged off the centre, it applies
{
    const ln = curve(2, "line", { x0: 0, y0: 0, x1: 20, y1: 0 });
    const circ = curve(3, "circle", { cx: 0, cy: 0, r: 5 });
    const cons = [{ id: 1, kind: "fix", refs: [{ curve: 3, at: "curve" }] }, { id: 2, kind: "fix", refs: [{ curve: 2, at: "end" }] },
                  { id: 3, kind: "point_on_circle", refs: [{ curve: 2, at: "start" }, { curve: 3, at: "curve" }], driving: true }];
    const m = buildModel(w, sketch(cons), [ln, circ]);
    assert.deepEqual(m.refused.map((r) => r.id), [3]);
    assert.ok(isConflictRefusal(m.refused[0].error), m.refused[0].error);
    assert.deepEqual(retryRefused(w, m, sketch(cons)), [], "still degenerate: still refused");
    assert.equal(dragModel(w, m, [{ curve: 2, at: "start", x: 3, y: 1 }]).status, "converged");
    // applied, then taken out again: refused as it was, the start back where the drag left it
    const startAt = () => Array.from(w.cadaclysm_blacksmith_sketch_point(m.h, m.entity.get("2:start")));
    const dragged = startAt();
    assert.deepEqual(retryRefused(w, m, sketch(cons)), [3]);
    assert.ok(Math.abs(Math.hypot(...startAt()) - 5) < 1e-9, `${startAt()}`);
    const was = m.refused.length;
    revertRetried(w, m);
    assert.equal(was, 0);
    assert.deepEqual(m.refused.map((r) => r.id), [3]);
    assert.ok(isConflictRefusal(m.refused[0].error) && !m.kernelOf.has(3));
    assert.deepEqual(startAt(), dragged);
    assert.equal(solveModel(w, m).status, "converged");
    assert.deepEqual(startAt(), dragged, "the record is out of the session: a solve leaves the start alone");
    assert.deepEqual(retryRefused(w, m, sketch(cons)), [3]);
    assert.deepEqual(m.refused, []);
    const s = new Map(writeBack(w, m, byId([ln, circ])).map((c) => [c.id, c.shape])).get(2);
    assert.ok(Math.abs(Math.hypot(s.x0, s.y0) - 5) < 1e-9, JSON.stringify(s));
    freeModel(w, m);
}
// a structural conflict and a grey refusal are never applied by a retry
{
    const ln = curve(2, "line", { x0: 0, y0: 0, x1: 30, y1: 10 });
    const cons = [{ id: 1, kind: "fix", refs: [{ curve: 2, at: "start" }] }, { id: 2, kind: "fix", refs: [{ curve: 2, at: "end" }] },
                  { id: 3, kind: "horizontal", refs: [{ curve: 2, at: "start" }, { curve: 2, at: "end" }] }, { id: 4, kind: "bogus", refs: [{ curve: 2, at: "end" }] }];
    const m = buildModel(w, sketch(cons), [ln]);
    assert.deepEqual(m.refused.map((r) => r.id).sort(), [3, 4]);
    assert.deepEqual(retryRefused(w, m, sketch(cons)), []);
    assert.deepEqual(m.refused.map((r) => r.id).sort(), [3, 4]);
    freeModel(w, m);
}
// a grey refusal is never tried, even where its record would now apply: only a conflict
// is judged again; and a refused id with no record left in the sketch is not tried
{
    const ln = curve(2, "line", { x0: 0, y0: 0, x1: 30, y1: 10 });
    const fix = { id: 1, kind: "fix", refs: [{ curve: 2, at: "start" }] };
    const m = buildModel(w, sketch([]), [ln]);
    m.refused.push({ id: 1, error: "constraint 1: unknown end 'tip'" });
    assert.ok(!isConflictRefusal(m.refused[0].error));
    assert.deepEqual(retryRefused(w, m, sketch([fix])), []);
    assert.deepEqual(m.refused.map((r) => r.id), [1]);
    assert.equal(m.kernelOf.size, 0);
    m.refused[0].error = "sketch_constrain: over-constrained: conflicts with []";
    assert.deepEqual(retryRefused(w, m, sketch([])), []);
    assert.deepEqual(retryRefused(w, m, sketch([fix])), [1], "a conflict whose record stands is tried");
    freeModel(w, m);
}
// merge: the outer ends' records move to the polycurve; interior ones are left to the prune
{
    const a = curve(3, "line", { x0: 30, y0: 0.1, x1: 30, y1: 20 });
    const b = curve(4, "line", { x0: 10.1, y0: 25.3, x1: 30, y1: 20 });   // runs back to the joint
    const ends = mergedEnds([a, b], [[Math.fround(30), Math.fround(0.1)], [Math.fround(10.1), Math.fround(25.3)]]);
    assert.deepEqual(ends, [[30, 0.1], [10.1, 25.3]], "exact, not Float32");
    const recs = [
        { id: 1, kind: "coincident", refs: [{ curve: 2, at: "end" }, { curve: 3, at: "start" }] },
        { id: 2, kind: "coincident", refs: [{ curve: 3, at: "end" }, { curve: 4, at: "end" }] },
        { id: 3, kind: "fix", refs: [{ curve: 4, at: "start" }] },
        { id: 4, kind: "vertical", refs: [{ curve: 3, at: "start" }, { curve: 3, at: "end" }] },
    ];
    const out = remapMerged(recs, [a, b], 5, ends);
    assert.deepEqual(out[0].refs, [{ curve: 2, at: "end" }, { curve: 5, at: "start" }]);
    assert.deepEqual(out[2].refs, [{ curve: 5, at: "end" }]);
    assert.deepEqual(out[1].refs, recs[1].refs, "the joint is not an end");
    assert.deepEqual(out[3].refs, [{ curve: 5, at: "start" }, { curve: 3, at: "end" }], "pruned later: 3 is gone");
    // a run end with no picked end near it is kept as given; a closed merge remaps nothing
    assert.deepEqual(mergedEnds([a, b], [[0, 0], ends[1]]), [[0, 0], [10.1, 25.3]]);
    assert.deepEqual(remapMerged(recs, [a, b], 5, null), recs);
    // only refs exactly at an end move: the Float32 run's end is not the picked end
    assert.deepEqual(remapMerged(recs, [a, b], 5, [[Math.fround(30), Math.fround(0.1)], ends[1]])[0].refs, recs[0].refs);
}
// explode: the polycurve's ends to the pieces' ends at those points, whichever way a piece runs
{
    const pc = curve(3, "polycurve", { pieces: [{ kind: "line", shape: { x0: 0, y0: 20, x1: 15, y1: 20 } }, { kind: "line", shape: { x0: 30, y0: 30, x1: 15, y1: 20 } }],
                                       closed: false, ends: [[0, 20], [30, 30]] });
    const pieces = pc.shape.pieces.map((p, k) => ({ id: 5 + k, kind: p.kind, shape: p.shape }));
    const out = remapExploded([{ id: 1, kind: "coincident", refs: [{ curve: 4, at: "start" }, { curve: 3, at: "end" }] },
                               { id: 2, kind: "fix", refs: [{ curve: 3, at: "start" }] }], pc, pieces);
    assert.deepEqual(out.map((k) => k.refs), [[{ curve: 4, at: "start" }, { curve: 6, at: "start" }], [{ curve: 5, at: "start" }]]);
}
// explode, ties: where pieces meet at the polycurve's start the first piece takes it, where
// they meet at its end the last piece does, and one piece end is never given to both
{
    const line = (x0, y0, x1, y1) => ({ kind: "line", shape: { x0, y0, x1, y1 } });
    const explodeEnds = (pcs, ends) => {
        const pc = curve(3, "polycurve", { pieces: pcs, closed: false, ends });
        const pieces = pcs.map((p, k) => ({ id: 5 + k, kind: p.kind, shape: p.shape }));
        return remapExploded([{ id: 1, kind: "fix", refs: [{ curve: 3, at: "start" }] }, { id: 2, kind: "fix", refs: [{ curve: 3, at: "end" }] }], pc, pieces)
            .map((k) => k.refs[0]);
    };
    // back through its start: pieces 7 and 8 meet there too
    assert.deepEqual(explodeEnds([line(10, 0, 20, 0), line(20, 0, 20, 10), line(20, 10, 10, 0), line(10, 0, 0, 0)], [[10, 0], [0, 0]]),
                     [{ curve: 5, at: "start" }, { curve: 8, at: "end" }]);
    // back to its first joint: the end is piece 7's, not piece 5's end there
    assert.deepEqual(explodeEnds([line(0, 0, 10, 0), line(10, 0, 20, 0), line(20, 0, 10, 0)], [[0, 0], [10, 0]]),
                     [{ curve: 5, at: "start" }, { curve: 7, at: "end" }]);
    // both ends at one place (an open run back to its start): two different piece ends
    assert.deepEqual(explodeEnds([line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 0)], [[0, 0], [0, 0]]),
                     [{ curve: 5, at: "start" }, { curve: 7, at: "end" }]);
}
// far out (1e6): the Float32 run's ends are ~0.03 off, inside 1e-6 of |p|, and the exact ends win
{
    const a = curve(3, "line", { x0: 1e6 + 0.1, y0: 2e6 + 0.3, x1: 1e6 + 20, y1: 2e6 });
    const b = curve(4, "line", { x0: 1e6 + 20, y0: 2e6, x1: 1e6 + 40.7, y1: 2e6 + 5.9 });
    const f = (x, y) => [Math.fround(x), Math.fround(y)];
    const ends = mergedEnds([a, b], [f(1e6 + 0.1, 2e6 + 0.3), f(1e6 + 40.7, 2e6 + 5.9)]);
    assert.deepEqual(ends, [[1e6 + 0.1, 2e6 + 0.3], [1e6 + 40.7, 2e6 + 5.9]]);
    const pc = curve(5, "polycurve", { pieces: [a, b].map((c) => ({ kind: c.kind, shape: c.shape })), closed: false, ends });
    const pieces = [a, b].map((c, k) => ({ id: 6 + k, kind: c.kind, shape: c.shape }));
    assert.deepEqual(remapExploded([{ id: 1, kind: "fix", refs: [{ curve: 5, at: "end" }] }], pc, pieces)[0].refs, [{ curve: 7, at: "end" }]);
}
// a centre placed on a line's end: coincident (a circle's, a polygon's, an ellipse's)
{
    const ln = curve(2, "line", { x0: 0, y0: 0, x1: 10, y1: 0 });
    for (const [kind, shape] of [["circle", { cx: 10, cy: 0, r: 4 }], ["polygon", { cx: 10, cy: 0, r: 4, sides: 6, angle: 0 }], ["ellipse", { cx: 10, cy: 0, rx: 4, ry: 2 }]]) {
        const c = curve(3, kind, shape);
        const got = inferForCurve(c, [{ at: "centre", target: { curve: 2, at: "end" } }], byId([ln, c]), 1);
        assert.deepEqual(got.map((k) => [k.kind, k.refs]), [["coincident", [{ curve: 3, at: "centre" }, { curve: 2, at: "end" }]]], kind);
    }
}
// a stored record whose add collapses a curve is not applied (grey, never retried as a
// conflict); the session is as it was before it: the line still 30 long, nothing written
{
    const ln = { ...curve(2, "line", { x0: 0, y0: 0, x1: 30, y1: 0 }), name: "Line 1" };
    const fix = { id: 1, kind: "fix", refs: [{ curve: 2, at: "start" }], driving: true };
    const tiny = { id: 3, kind: "length", refs: [{ curve: 2, at: "curve" }], value: 1e-9, driving: true };
    const m = buildModel(w, sketch([fix, tiny]), [ln]);
    assert.deepEqual(m.refused.map((r) => [r.id, r.collapse, r.curve, isConflictRefusal(r)]), [[3, true, 2, false]]);
    assert.equal(m.refused[0].error, "constraint 3: it would shrink Line 1 to a point");
    assert.ok(m.kernelOf.has(1) && !m.kernelOf.has(3));
    assert.deepEqual(Array.from(w.cadaclysm_blacksmith_sketch_point(m.h, m.entity.get("2:end"))), [30, 0]);
    assert.equal(solveModel(w, m).status, "converged");
    assert.deepEqual(writeBack(w, m, byId([ln])), [], "the line stays 30 long");
    assert.deepEqual(retryRefused(w, m, sketch([fix, tiny])), [], "not judged again");
    freeModel(w, m);
    // two records that collapse a line together: the second is refused, the first kept
    const h = { id: 1, kind: "horizontal", refs: [{ curve: 2, at: "start" }, { curve: 2, at: "end" }], driving: true };
    const v = { id: 2, kind: "vertical", refs: [{ curve: 2, at: "start" }, { curve: 2, at: "end" }], driving: true };
    const slant = { ...curve(2, "line", { x0: 0, y0: 0, x1: 30, y1: 1 }), name: "Line 1" };
    const m2 = buildModel(w, sketch([h, v]), [slant]);
    assert.deepEqual(m2.refused.map((r) => [r.id, r.error]), [[2, "constraint 2: it would shrink Line 1 to a point"]]);
    assert.equal(solveModel(w, m2).status, "converged");
    const [moved] = writeBack(w, m2, byId([slant]));
    assert.ok(moved && Math.abs(moved.shape.y1 - moved.shape.y0) < 1e-9 && Math.abs(moved.shape.x1 - moved.shape.x0) > 29, JSON.stringify(moved));
    freeModel(w, m2);
    // an unnamed curve is named by what it is, never by its id
    const m3 = buildModel(w, sketch([fix, tiny]), [curve(2, "line", { x0: 0, y0: 0, x1: 30, y1: 0 })]);
    assert.equal(m3.refused[0].error, "constraint 3: it would shrink a line to a point");
    freeModel(w, m3);
    // the previous session's collapse refusals, passed in: left out, tried last, refused the
    // same; one that no longer collapses (a stale hint) is built in the plain order
    const m4 = buildModel(w, sketch([fix, tiny]), [ln], { collapsed: new Set([3]) });
    assert.deepEqual(m4.refused.map((r) => [r.id, r.collapse]), [[3, true]]);
    assert.deepEqual(Array.from(w.cadaclysm_blacksmith_sketch_point(m4.h, m4.entity.get("2:end"))), [30, 0]);
    freeModel(w, m4);
    const thirty = { ...tiny, value: 30 };
    const m5 = buildModel(w, sketch([fix, thirty]), [ln], { collapsed: new Set([3]) });
    assert.deepEqual([m5.refused, m5.kernelOf.has(3)], [[], true]);
    freeModel(w, m5);
    // the hint spares the search: a hinted build makes one session; unhinted, the build that
    // ends collapsed makes three (the build, the search for the record, the build again)
    const sessions = (opt) => {
        let made = 0;
        const counted = new Proxy(w, { get: (t, k) => k === "cadaclysm_blacksmith_sketch_new" ? (...a) => { made++; return t[k](...a); } : t[k] });
        freeModel(w, buildModel(counted, sketch([fix, tiny]), [ln], opt));
        return made;
    };
    assert.deepEqual([sessions({ collapsed: new Set([3]) }), sessions()], [1, 3]);
    // a conflict-red refusal is still one (the object form and the text form agree)
    assert.equal(isConflictRefusal({ error: "sketch_constrain: over-constrained: conflicts with [2]" }), true);
    assert.equal(isConflictRefusal({ error: "over-constrained", collapse: true }), false);
}
console.log("forge-constraints.mjs: ok");
