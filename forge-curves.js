// The forge's curve helpers: a curve's Béziers by its kind, a polycurve's pieces chained,
// a sketch fillet's and a sketch trim's pieces, the vector and quaternion arithmetic of a
// body's place, and the reading of a built body's edge list and closure. None of them is an
// evaluator -- the blacksmith document builds every body (forge-doc-*.js): these call the
// kernel's run functions for what the page draws and what its sketch tools work out
// (the page's own beziers, the fillet a tool proposes, the pieces a trim offers), through
// forge-doc-curves.js's run helpers on the kernel's public `cadaclysm_blacksmith_profile_*`.
import * as kernel from "./pkg/index.js";
import { lineBeziers, polylineBeziers, rectBeziers, circleBeziers, arcThroughBeziers, ellipseBeziers, curveBeziers,
         regularPolygonPoints, chainCurves, chainOrder, roundCurve, trimPieces as kernelTrimPieces, trimCurve } from "./forge-doc-curves.js";

export const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    unit: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; },
};

// How close two curves' ends must come to count as joined, in sketch units: a
// micrometre -- a snapped end is the other's exact coordinates, and the tolerance only
// absorbs the arithmetic in between. A curve with no ends is closed by kind.
export const LOOP_TOLERANCE = 1e-3;

export function flat(points) {
    const out = new Float64Array(points.length * 2);
    points.forEach(([x, y], i) => { out[2 * i] = x; out[2 * i + 1] = y; });
    return out;
}

// A curve as the wasm converts it, by its kind: the same rational cubic Béziers a solid's
// edges are. Empty while there is nothing to draw (a NURBS of one point), which is not an
// error. A conic is refused by nothing here: its handles keep it a size. A polycurve is
// its pieces' Béziers laid end to end (`chainPieces`), which throws where they do not meet.
export function beziersOf(c) {
    const s = c.shape;
    if (c.kind === "polycurve") return chainPieces(s.pieces).beziers;
    if (c.kind === "line") return lineBeziers(kernel, s.x0, s.y0, s.x1, s.y1);
    if (c.kind === "polyline") return polylineBeziers(kernel, flat(s.points), s.closed);
    if (c.kind === "rect") return rectBeziers(kernel, s.x0, s.y0, s.x1, s.y1);
    if (c.kind === "circle") return circleBeziers(kernel, s.cx, s.cy, s.r);
    if (c.kind === "arc") return arcThroughBeziers(kernel, s.x0, s.y0, s.xm, s.ym, s.x1, s.y1);
    if (c.kind === "ellipse") return ellipseBeziers(kernel, s.cx, s.cy, s.rx, s.ry);
    if (c.kind === "polygon") return polylineBeziers(kernel, flat(polygonPoints(s)), true);
    return curveBeziers(kernel, flat(s.points), s.degree >>> 0, new Float64Array(s.weights), s.closed);
}
// A regular polygon's vertices: `sides` of them on the circle of radius `r` about
// `(cx, cy)`, the first at `angle` degrees from x, counter-clockwise.
export function polygonPoints({ cx, cy, r, sides, angle }) {
    const flat = regularPolygonPoints(kernel, cx, cy, r, Math.max(3, Math.round(sides)), angle ?? 0);   // the kernel's Profile::regular_polygon
    return Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
}

// A polycurve's pieces (curve definitions, kind and shape) chained into one run of
// Béziers -- the kernel's merge (`Profile::chain`, through `profile_chain`):
// the first piece as it is, then the first of the rest to meet either end of the chain,
// after it or in front of it, turned round where that is what makes it meet, until every
// piece is placed. A joint is the chain's own point, and a chain whose ends meet is closed
// on its start exactly. A piece that meets nothing, or is closed on its own (a circle), is
// an error naming it -- the kernel counts pieces from 0, the page from 1, by kind. Ends
// meet within `tolerance` in sketch units.
export function chainPieces(pieces, tolerance = LOOP_TOLERANCE) {
    const runs = pieces.map((p, i) => {
        const b = beziersOf(p);
        if (b.length < 16) throw new Error(`piece ${i + 1} (${p.kind}) has nothing drawn`);
        return b;
    });
    const all = new Float32Array(runs.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of runs) { all.set(r, at); at += r.length; }
    let beziers;
    try {
        beziers = chainCurves(kernel, all, Uint32Array.from(runs, (r) => r.length / 16), tolerance);
    } catch (error) {
        const said = String(error?.message ?? error);
        const piece = /^chain: piece (\d+) (.*)$/.exec(said);
        throw new Error(piece ? `piece ${+piece[1] + 1} (${pieces[+piece[1]].kind}) ${piece[2]}` : said.replace(/^chain: /, ""));
    }
    const n = beziers.length;
    return { beziers, closed: n > 0 && beziers[0] === beziers[n - 4] && beziers[1] === beziers[n - 3] };
}

// A sketch fillet is the kernel's (`Profile::round`, through `profile_round`):
// the pieces chained into one run of Béziers, every corner between two straight pieces
// rounded by `radius` with an exact tangent arc, and the run handed back as pieces -- a
// line, an arc through its middle, or a cubic for anything else. Throws the kernel's
// words where the radius does not fit.
function roundedRun(beziers, closed, radius) {
    return parsePieces(roundCurve(kernel, beziers, closed, radius), 0, Infinity).pieces;
}
// The kernel's piece encoding (forge-doc-curves.js's `roundCurve`, `trimCurve`) read from `out[at]`: `count`
// pieces (or to the end), each a line (0), an arc through its middle (1), or a cubic
// (2) as a four-point spline; the pieces and where the next record starts.
function parsePieces(out, at, count) {
    const pieces = [];
    let i = at;
    while (i < out.length && pieces.length < count) {
        const kind = out[i];
        if (kind === 0) {
            pieces.push({ kind: "line", shape: { x0: out[i + 1], y0: out[i + 2], x1: out[i + 3], y1: out[i + 4] } });
            i += 5;
        } else if (kind === 1) {
            pieces.push({ kind: "arc", shape: { x0: out[i + 1], y0: out[i + 2], xm: out[i + 3], ym: out[i + 4], x1: out[i + 5], y1: out[i + 6] } });
            i += 7;
        } else {
            const c = out.slice(i + 1, i + 9), w = Array.from(out.slice(i + 9, i + 13));
            pieces.push({ kind: "nurbs", shape: { points: [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]], degree: 3, weights: w, closed: false } });
            i += 13;
        }
    }
    return { pieces, next: i };
}

// The sketch trim, the kernel's (`Profile::pieces_cut_by` / `Profile::trim`). A curve's
// Béziers cut by the `cutters` (their Béziers laid end to end, `perCutter` each) into
// pieces -- each `{ beziers }`, a Float32Array of the piece's own Béziers, in order along
// the curve -- and, a piece removed, what is left as chains of pieces. Throws the
// kernel's words.
export function trimPieces(beziers, cutters, perCutter, tolerance = LOOP_TOLERANCE) {
    const out = kernelTrimPieces(kernel, beziers, cutters, perCutter, tolerance);
    const n = out[0], pieces = [];
    let at = 1 + n;
    for (let k = 0; k < n; k++) {
        const count = out[1 + k];
        pieces.push({ beziers: out.slice(at, at + 16 * count) });
        at += 16 * count;
    }
    return pieces;
}
export function trimmedChains(beziers, cutters, perCutter, piece, tolerance = LOOP_TOLERANCE) {
    const out = trimCurve(kernel, beziers, cutters, perCutter, piece, tolerance);
    const chains = [];
    let at = 1;
    for (let k = 0; k < out[0]; k++) {
        const { pieces, next } = parsePieces(out, at + 1, out[at]);
        chains.push(pieces);
        at = next;
    }
    return chains;
}
// A chain of pieces as one curve definition: the piece itself where it is one, a
// polyline where every piece is a line, a polycurve otherwise.
export function chainCurve(pieces) {
    if (pieces.length === 1) return structuredClone(pieces[0]);
    const endsOf = (p) => p.kind === "line" ? [[p.shape.x0, p.shape.y0], [p.shape.x1, p.shape.y1]] : p.kind === "arc" ? [[p.shape.x0, p.shape.y0], [p.shape.x1, p.shape.y1]] : [p.shape.points[0], p.shape.points[p.shape.points.length - 1]];
    if (pieces.every((p) => p.kind === "line")) {
        return { kind: "polyline", shape: { points: [endsOf(pieces[0])[0], ...pieces.map((p) => endsOf(p)[1])], closed: false } };
    }
    return { kind: "polycurve", shape: { pieces: structuredClone(pieces), closed: false, ends: [endsOf(pieces[0])[0], endsOf(pieces[pieces.length - 1])[1]] } };
}

// The corner at `p` between the lines from `a` and to `b`, rounded by `radius`: the arc's
// tangent point on each leg (`t1` towards `a`, `t2` towards `b`) and its middle (`m`).
// Null where the legs run straight on or the radius does not fit.
export function roundCorner(p, a, b, radius) {
    let pieces;
    try { pieces = roundedRun(new Float32Array([...lineBeziers(kernel, a[0], a[1], p[0], p[1]), ...lineBeziers(kernel, p[0], p[1], b[0], b[1])]), false, radius); }
    catch (_) { return null; }
    const arc = pieces.find((q) => q.kind === "arc");
    if (!arc) return null;
    const s = arc.shape;
    return { t1: [s.x0, s.y0], t2: [s.x1, s.y1], m: [s.xm, s.ym] };
}

// A run of points (a polyline's, a rectangle's corners) with every corner rounded by
// `radius`: the pieces of a polycurve -- each side shortened to the tangent points, an
// arc at each corner -- and whether it closes. An open run keeps its two ends square.
export function roundPolyline(points, closed, radius) {
    if (points.length < (closed ? 3 : 2)) throw new Error("nothing to round: fewer than two segments");
    return { pieces: roundedRun(polylineBeziers(kernel, new Float64Array(points.flat()), closed), closed, radius), closed };
}

// A piece's definition turned round, end for start.
function reversedPiece(p) {
    const s = p.shape;
    if (p.kind === "line") return { kind: "line", shape: { x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0 } };
    if (p.kind === "arc") return { kind: "arc", shape: { x0: s.x1, y0: s.y1, xm: s.xm, ym: s.ym, x1: s.x0, y1: s.y0 } };
    if (p.kind === "polyline") return { kind: "polyline", shape: { ...s, points: s.points.slice().reverse() } };
    if (p.kind === "nurbs") return { kind: "nurbs", shape: { ...s, points: s.points.slice().reverse(), weights: s.weights.slice().reverse() } };
    return p;
}

// A polycurve's pieces in chain order, each turned to run on from the last: the order the
// kernel's chain takes them in (`profile_chain_order`, the walk `chainPieces` makes of the
// Béziers), applied to the pieces' own definitions. Throws the kernel's refusal, or naming
// a piece with nothing drawn.
export function orderPieces(pieces, tolerance = LOOP_TOLERANCE) {
    const runs = pieces.map((p, i) => {
        const b = beziersOf(p);
        if (b.length < 16) throw new Error(`piece ${i + 1} (${p.kind}) has nothing drawn`);
        return b;
    });
    const all = new Float32Array(runs.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of runs) { all.set(r, at); at += r.length; }
    const out = chainOrder(kernel, all, Uint32Array.from(runs, (r) => r.length / 16), tolerance);
    const ordered = [];
    for (let k = 0; k < out.length; k += 2) ordered.push(out[k + 1] ? reversedPiece(pieces[out[k]]) : pieces[out[k]]);
    return { pieces: ordered };
}

// A polycurve with every corner between two straight pieces rounded by `radius`, its
// pieces put in chain order first; any other junction (an arc's, a spline's) is left as
// it is. Throws where the radius does not fit, or where the pieces do not chain.
export function roundPolycurve(pieces, radius, tolerance = LOOP_TOLERANCE) {
    const { pieces: ordered } = orderPieces(pieces, tolerance);
    const { beziers, closed } = chainPieces(ordered, tolerance);
    return { pieces: roundedRun(beziers, closed, radius), closed };
}

// A body's axis in the world: its source axis under its transform.
export function worldAxis(c) { return c.axis.map((q) => mapPoint(c, q)); }
export function mapPoint(c, q) {
    const { tx, ty, angle, scale } = c.transform, [px, py] = c.pivot;
    const cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale, x = q[0] - px, y = q[1] - py;
    return [px + tx + cos * x - sin * y, py + ty + sin * x + cos * y];
}

// A body's closure in words, as the reader page's Topology row puts it.
export function closureText(m) {
    if (!m) return "";
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (m.closed) return "closed";
    if (m.manifold) return `open · ${count(m.boundaryEdges, "boundary edge", "boundary edges")}`;
    const where = [];
    if (m.nonManifoldEdges) where.push(`${count(m.nonManifoldEdges, "edge", "edges")} on 3+ faces`);
    if (m.nonManifoldVertices) where.push(count(m.nonManifoldVertices, "pinched vertex", "pinched vertices"));
    return `not manifold · ${where.join(", ")}`;
}

// The edge list as the wasm flattens it, read back: per edge the faces it lies
// between and its segments, six numbers each (two points).
export function parseEdges(flat) {
    const out = [];
    let at = 1;
    const n = flat[0] | 0;
    for (let k = 0; k < n; k++) {
        const faces = flat[at++] | 0;
        const f = [];
        for (let i = 0; i < faces; i++) f.push(flat[at++] | 0);
        const segs = flat[at++] | 0;
        const segments = [];
        for (let i = 0; i < segs; i++) { segments.push([[flat[at], flat[at + 1], flat[at + 2]], [flat[at + 3], flat[at + 4], flat[at + 5]]]); at += 6; }
        out.push({ faces: f, segments });
    }
    return out;
}

// Quaternions `[x, y, z, w]`, for a body's turn in the world: made from an axis and an
// angle or from turns about the world axes (X, then Y, then Z, in degrees), composed,
// and read back as either. Enough for the place a drag composes and the fields show.
export const Q = {
    fromAxisAngle: (axis, angle) => { const u = V.unit(axis); if (!u) return [0, 0, 0, 1]; const s = Math.sin(angle / 2); return [u[0] * s, u[1] * s, u[2] * s, Math.cos(angle / 2)]; },
    mul: (a, b) => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
    fromEuler: ([rx, ry, rz]) => {
        const d = Math.PI / 180;
        return Q.mul(Q.fromAxisAngle([0, 0, 1], rz * d), Q.mul(Q.fromAxisAngle([0, 1, 0], ry * d), Q.fromAxisAngle([1, 0, 0], rx * d)));
    },
    toEuler: ([x, y, z, w]) => {
        // The X-then-Y-then-Z angles that make this turn back.
        const d = 180 / Math.PI;
        const sy = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
        const rx = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d;
        const ry = Math.asin(sy) * d;
        const rz = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d;
        return [rx, ry, rz].map((v) => Math.round(v * 1e6) / 1e6);
    },
    toAxisAngle: ([x, y, z, w]) => {
        const s = Math.hypot(x, y, z);
        if (s < 1e-12) return { axis: [0, 0, 1], angle: 0 };
        return { axis: [x / s, y / s, z / s], angle: 2 * Math.atan2(s, w) };
    },
};
// A body's place in the world, after its in-plane transform: an offset and turns about
// the world axes (degrees) about its pivot. The identity for a body without one.
export const placeOf = (body) => body.place ?? { offset: [0, 0, 0], turn: [0, 0, 0] };
export const isPlaced = (body) => { const p = placeOf(body); return p.offset.some((v) => v !== 0) || p.turn.some((v) => v !== 0); };

// The quick solids' kinds: a box, a cylinder and the rest, each its own `primitive` command.
export const QUICK_KINDS = ["box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil"];
export const isQuickKind = (kind) => QUICK_KINDS.includes(kind);
