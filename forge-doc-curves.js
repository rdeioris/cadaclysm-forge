// The curve helpers the forge's item model needs, from forge's old recipe.js and forge.js:
// a curve's Béziers (`beziersOf`), a polycurve's chain (`chainPieces`), the sketch fillet
// (`sketchFillet` and its `roundCorner` / `roundPolyline` / `roundPolycurve`), and a
// body's pivot (the middle of its Béziers' control-point box, `bodyOf`). A port of the
// Rust `forge::curves`, which calls the kernel's own run functions
// (`cadaclysm_blacksmith::runs`); here every one of them comes through `kernel`, an
// object the caller hands in -- the kernel wasm build's module itself, whose public
// `cadaclysm_blacksmith_profile_*` exports the run helpers below are made of:
//
//   lineBeziers(kernel, x0, y0, x1, y1)                    runs::line          -> Float32Array
//   polylineBeziers(kernel, points, closed)                runs::polyline      -> Float32Array, throws
//   rectBeziers(kernel, x0, y0, x1, y1)                    runs::rect          -> Float32Array
//   circleBeziers(kernel, cx, cy, r)                       runs::circle        -> Float32Array
//   arcThroughBeziers(kernel, x0, y0, xm, ym, x1, y1)      runs::arc_through   -> Float32Array, throws
//   ellipseBeziers(kernel, cx, cy, rx, ry)                 runs::ellipse       -> Float32Array
//   curveBeziers(kernel, points, degree, weights, closed)  runs::spline        -> Float32Array, throws
//   regularPolygonPoints(kernel, cx, cy, r, sides, angleDegrees)
//                                                          runs::regular_polygon_points -> Float64Array
//   chainCurves(kernel, beziers, perPiece, tolerance)      runs::chain         -> Float32Array, throws
//   chainOrder(kernel, beziers, perPiece, tolerance)       runs::chain_order   -> Uint32Array, throws
//   roundCurve(kernel, beziers, closed, radius)            runs::round_pieces  -> Float64Array, throws
//   trimPieces / trimCurve(kernel, beziers, cutters, perCutter, [piece,] tolerance)
//                                                          the sketch trim's pieces and chains
//   closeCurve(kernel, beziers, tolerance)                 the closing side    -> Float64Array, throws
//   detectLoops(kernel, ends, tolerance)                   runs::loops         -> Uint32Array
//   embedBeziers(kernel, beziers, frame9)                  runs::embedded      -> Float32Array
//
// The Béziers are `f32` records (sixteen floats each), as the page's `Float32Array`s are;
// the numbers read off them are those `f32`s widened, as JavaScript reads a
// `Float32Array`. The kernel's refusals are thrown as `Error`s with its own words (the
// wasm throws them as bare strings).
//
//   LOOP_TOLERANCE
//   polygonPoints(kernel, shape)            [[x, y], ...]
//   beziersOf(kernel, kind, shape)          Float32Array
//   chainPieces(kernel, pieces)             { beziers, closed }
//   sketchFillet(kernel, items, radius)     { two: { a, b, arc } } | { one: { shape } } | undefined
//   loopsCurves(items, loops)               [{ kind, shape }]  (an `Items`, curve ids per loop)
//   sourcePivot(kernel, curves)             [x, y]
import { get, put, putOpt, kindOf, clone, U32_MAX } from "./forge-doc-items.js";

/// forge's old recipe.js `LOOP_TOLERANCE` (38).
export const LOOP_TOLERANCE = 1e-3;

// A number field, or NaN (the page reads `undefined` arithmetic as NaN).
const nan = (fields, key) => {
    const v = get(fields, key);
    return typeof v === "number" ? v : NaN;
};

// A Rust `as u32`: NaN 0, saturating, truncated -- not wasm-bindgen's `>>> 0`, which
// wraps a negative round.
const u32 = (v) => (Number.isNaN(v) ? 0 : Math.min(Math.max(Math.trunc(v), 0), U32_MAX));

// Rust's `f64::min` / `max`: a NaN on either side gives the other.
const fmin = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.min(a, b));
const fmax = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));

function pointsOf(shape) {
    const pts = get(shape, "points");
    if (!Array.isArray(pts)) return [];
    const at = (xy, k) => (Array.isArray(xy) && typeof xy[k] === "number" ? xy[k] : NaN);
    return pts.map((p) => [at(p, 0), at(p, 1)]);
}

/// forge's old recipe.js `flat` (40).
const flat = (points) => Float64Array.from(points.flat());

const closedOf = (shape) => Boolean(get(shape, "closed"));

/// forge's old recipe.js `polygonPoints` (59): `sides` vertices (at least three, rounded) on the
/// circle, the first at `angle` degrees.
export function polygonPoints(kernel, shape) {
    const sides = fmax(Math.floor(nan(shape, "sides") + 0.5), 3);
    const angle = get(shape, "angle");
    const out = regularPolygonPoints(kernel, nan(shape, "cx"), nan(shape, "cy"), nan(shape, "r"), u32(sides), typeof angle === "number" ? angle : 0);
    const points = [];
    for (let k = 0; k + 1 < out.length; k += 2) points.push([out[k], out[k + 1]]);
    return points;
}

/// forge's old recipe.js `beziersOf` (44): a curve definition (`kind`, `shape`) as the wasm converts it.
export function beziersOf(kernel, kind, shape) {
    const g = (k) => nan(shape, k);
    switch (kind) {
        case "polycurve": return chainPieces(kernel, piecesOf(shape)).beziers;
        case "line": return lineBeziers(kernel, g("x0"), g("y0"), g("x1"), g("y1"));
        case "polyline": return polylineBeziers(kernel, flat(pointsOf(shape)), closedOf(shape));
        case "rect": return rectBeziers(kernel, g("x0"), g("y0"), g("x1"), g("y1"));
        case "circle": return circleBeziers(kernel, g("cx"), g("cy"), g("r"));
        case "arc": return arcThroughBeziers(kernel, g("x0"), g("y0"), g("xm"), g("ym"), g("x1"), g("y1"));
        case "ellipse": return ellipseBeziers(kernel, g("cx"), g("cy"), g("rx"), g("ry"));
        case "polygon": return polylineBeziers(kernel, flat(polygonPoints(kernel, shape)), true);
        default: {
            const w = get(shape, "weights");
            const weights = Float64Array.from(Array.isArray(w) ? w.map((v) => (typeof v === "number" ? v : NaN)) : []);
            return curveBeziers(kernel, flat(pointsOf(shape)), u32(g("degree")), weights, closedOf(shape));
        }
    }
}

/// A piece definition's kind ("" when it has none) and shape (null when it has none).
function pieceParts(p) {
    const kind = get(p, "kind");
    const shape = get(p, "shape");
    return [typeof kind === "string" ? kind : "", shape === undefined ? null : shape];
}

function piecesOf(shape) {
    const p = get(shape, "pieces");
    if (!Array.isArray(p)) throw new Error("a polycurve without pieces");
    return p;
}

/// Every piece's Béziers laid end to end, and how many each has; a piece with nothing
/// drawn is refused by name.
function pieceRuns(kernel, pieces) {
    const runs = pieces.map((p, i) => {
        const [kind, shape] = pieceParts(p);
        const b = beziersOf(kernel, kind, shape);
        if (b.length < 16) throw new Error(`piece ${i + 1} (${kind}) has nothing drawn`);
        return b;
    });
    const all = new Float32Array(runs.reduce((n, r) => n + r.length, 0));
    let at = 0;
    for (const r of runs) { all.set(r, at); at += r.length; }
    return { all, per: Uint32Array.from(runs, (r) => Math.floor(r.length / 16)) };
}

/// forge's old recipe.js `chainPieces` (78): the pieces chained into one run, and whether it closes.
export function chainPieces(kernel, pieces) {
    const { all, per } = pieceRuns(kernel, pieces);
    const beziers = chainCurves(kernel, all, per, LOOP_TOLERANCE);
    const n = beziers.length;
    return { beziers, closed: n > 0 && beziers[0] === beziers[n - 4] && beziers[1] === beziers[n - 3] };
}

/// forge's old recipe.js `parsePieces` (114): the kernel's piece records -- a line (0), an
/// arc through its middle (1), or a cubic (2) as a four-point spline -- as piece definitions.
function parsePieces(out) {
    const pieces = [];
    let i = 0;
    while (i < out.length) {
        const kind = out[i];
        if (kind === 0) {
            pieces.push({ kind: "line", shape: { x0: out[i + 1], y0: out[i + 2], x1: out[i + 3], y1: out[i + 4] } });
            i += 5;
        } else if (kind === 1) {
            pieces.push({ kind: "arc", shape: { x0: out[i + 1], y0: out[i + 2], xm: out[i + 3], ym: out[i + 4], x1: out[i + 5], y1: out[i + 6] } });
            i += 7;
        } else {
            const c = Array.from(out.slice(i + 1, i + 9)), w = Array.from(out.slice(i + 9, i + 13));
            const points = [0, 1, 2, 3].map((k) => [c[2 * k], c[2 * k + 1]]);
            pieces.push({ kind: "nurbs", shape: { points, degree: 3, weights: w, closed: false } });
            i += 13;
        }
    }
    return pieces;
}

/// forge's old recipe.js `roundedRun` (110).
const roundedRun = (kernel, beziers, closed, radius) => parsePieces(roundCurve(kernel, beziers, closed, radius));

/// forge's old recipe.js `roundCorner` (164): the arc's tangent points `t1`, `t2` and its
/// middle `m`; `undefined` where the legs run straight on or the radius does not fit.
function roundCorner(kernel, p, a, b, radius) {
    let pieces;
    try {
        const ap = lineBeziers(kernel, a[0], a[1], p[0], p[1]), pb = lineBeziers(kernel, p[0], p[1], b[0], b[1]);
        const beziers = new Float32Array(ap.length + pb.length);
        beziers.set(ap, 0);
        beziers.set(pb, ap.length);
        pieces = roundedRun(kernel, beziers, false, radius);
    } catch {
        return undefined;
    }
    const arc = pieces.find((q) => q.kind === "arc");
    if (!arc) return undefined;
    const g = (k) => nan(arc.shape, k);
    return { t1: [g("x0"), g("y0")], t2: [g("x1"), g("y1")], m: [g("xm"), g("ym")] };
}

/// forge's old recipe.js `roundPolyline` (177).
function roundPolyline(kernel, points, closed, radius) {
    if (points.length < (closed ? 3 : 2)) throw new Error("nothing to round: fewer than two segments");
    return { pieces: roundedRun(kernel, polylineBeziers(kernel, flat(points), closed), closed, radius), closed };
}

/// forge's old recipe.js `reversedPiece` (183): a piece turned round, end for start. A
/// key the piece lacks is null in the turned line or arc.
function reversedPiece(p) {
    const [kind, sh] = pieceParts(p);
    const g = (k) => clone(get(sh, k) ?? null);
    const rev = (key, s) => {
        const l = get(s, key);
        if (Array.isArray(l)) put(s, key, l.slice().reverse());
    };
    switch (kind) {
        case "line": return { kind: "line", shape: { x0: g("x1"), y0: g("y1"), x1: g("x0"), y1: g("y0") } };
        case "arc": return { kind: "arc", shape: { x0: g("x1"), y0: g("y1"), xm: g("xm"), ym: g("ym"), x1: g("x0"), y1: g("y0") } };
        case "polyline": {
            const s = clone(sh);
            rev("points", s);
            return { kind: "polyline", shape: s };
        }
        case "nurbs": {
            const s = clone(sh);
            rev("points", s);
            rev("weights", s);
            return { kind: "nurbs", shape: s };
        }
        default: return clone(p);
    }
}

/// forge's old recipe.js `orderPieces` (197): the pieces in the kernel's chain order, each
/// turned to run on from the last.
function orderPieces(kernel, pieces) {
    const { all, per } = pieceRuns(kernel, pieces);
    const out = chainOrder(kernel, all, per, LOOP_TOLERANCE);
    const ordered = [];
    for (let k = 0; k + 1 < out.length; k += 2) ordered.push(out[k + 1] !== 0 ? reversedPiece(pieces[out[k]]) : clone(pieces[out[k]]));
    return ordered;
}

/// forge's old recipe.js `roundPolycurve` (214).
function roundPolycurve(kernel, pieces, radius) {
    const ordered = orderPieces(kernel, pieces);
    const { beziers, closed } = chainPieces(kernel, ordered);
    return { pieces: roundedRun(kernel, beziers, closed, radius), closed };
}

/// forge.js `sketchFillet` (2128): what a sketch fillet of `radius` makes of the picked
/// items (`items`: each one's fields, or `undefined` where the pick names none) --
///   `{ two: { a, b, arc } }`  two lines: the fields each takes (its trimmed end) and the
///                             arc's shape between;
///   `{ one: { shape } }`      one curve as a polycurve: its new shape;
///   `undefined`               where it cannot be done (the page's `null`).
export function sketchFillet(kernel, items, radius) {
    if (items.length === 2) {
        const [a, b] = items;
        if (a === undefined || b === undefined) return undefined;
        const sa = get(a, "shape"), sb = get(b, "shape");
        if (sa === undefined || sb === undefined) return undefined;
        const ends = (sh) => [[nan(sh, "x0"), nan(sh, "y0")], [nan(sh, "x1"), nan(sh, "y1")]];
        const ea = ends(sa), eb = ends(sb);
        const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= LOOP_TOLERANCE * 10;
        let meet;
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if (near(ea[i], eb[j])) meet = [i, j];
        if (!meet) return undefined;
        const [i, j] = meet;
        const corner = roundCorner(kernel, ea[i], ea[1 - i], eb[1 - j], radius);
        if (!corner) return undefined;
        const { t1, t2, m } = corner;
        const trimmed = (k, t) => (k === 0 ? { x0: t[0], y0: t[1] } : { x1: t[0], y1: t[1] });
        const arc = { x0: t1[0], y0: t1[1], xm: m[0], ym: m[1], x1: t2[0], y1: t2[1] };
        return { two: { a: trimmed(i, t1), b: trimmed(j, t2), arc } };
    }
    const c = items[0];
    if (c === undefined) return undefined;
    const sh = get(c, "shape");
    if (sh === undefined) return undefined;
    // The shape's `closed` is what `roundPolyline` was handed: a polyline's own, absent
    // where it has none (and then open), as JSON leaves an `undefined` out.
    let closedAs = null;   // null: not a polyline; else { v } with v possibly undefined
    let rounded;
    try {
        switch (kindOf(c)) {
            case "rect": {
                const g = (k) => nan(sh, k);
                rounded = roundPolyline(kernel, [[g("x0"), g("y0")], [g("x1"), g("y0")], [g("x1"), g("y1")], [g("x0"), g("y1")]], true, radius);
                break;
            }
            case "polygon":
                rounded = roundPolyline(kernel, polygonPoints(kernel, sh), true, radius);
                break;
            case "polyline":
                closedAs = { v: clone(get(sh, "closed")) };
                rounded = roundPolyline(kernel, pointsOf(sh), closedOf(sh), radius);
                break;
            default:
                rounded = roundPolycurve(kernel, piecesOf(sh), radius);
        }
    } catch {
        return undefined;
    }
    const { pieces, closed } = rounded;
    let beziers;
    try {
        beziers = chainPieces(kernel, pieces).beziers;
    } catch {
        return undefined;
    }
    const n = beziers.length;
    const at = (k) => (k >= 0 && k < n ? beziers[k] : null);
    const ends = closed ? [[0, 0], [0, 0]] : [[at(0), at(1)], [n >= 4 ? at(n - 4) : null, n >= 3 ? at(n - 3) : null]];
    const shape = { pieces };
    putOpt(shape, "closed", closedAs ? closedAs.v : closed);
    put(shape, "ends", ends);
    return { one: { shape } };
}

/// The curves a source is made of, as definitions (`{kind, shape}`): a body's `loops`
/// read off the items (forge's old recipe.js `sourceOf`, 793), refused where one is not
/// there or has no shape.
export function loopsCurves(items, loops) {
    const out = [];
    for (const l of loops) {
        for (const id of l) {
            const k = items.get(id);
            if (!k || get(k.fields, "shape") === undefined) throw new Error(`#${id} is gone`);
            out.push({ kind: clone(get(k.fields, "kind") ?? null), shape: clone(get(k.fields, "shape") ?? null) });
        }
    }
    return out;
}

/// A body's pivot as `bodyOf` (forge.js 2298) takes it: the middle of its source
/// Béziers' control-point box, in sketch coordinates. Not finite (the page's `NaN`,
/// written `null`) when the source draws nothing.
export function sourcePivot(kernel, curves) {
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const c of curves) {
        const [kind, shape] = pieceParts(c);
        const b = beziersOf(kernel, kind, shape);
        for (let k = 0; k + 1 < b.length; k += 4) {
            lo = [fmin(lo[0], b[k]), fmin(lo[1], b[k + 1])];
            hi = [fmax(hi[0], b[k]), fmax(hi[1], b[k + 1])];
        }
    }
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
}

// ---------------------------------------------------------------------------------
// The run helpers on the kernel's public profile calls (`cadaclysm_blacksmith_profile_*`,
// the kernel wasm build's exports): each the forge's old helper of the same
// job, with the same answer -- a profile made, its Béziers read back (`profile_beziers`,
// f64) and handed out as the page's `f32` records -- and the same refusals (the kernel's
// words, the call's name dropped). Where the kernel refuses what the old helper drew
// anyway (a line or a rectangle through a coordinate that is not finite, a polygon of no
// radius), the record is made here, as the old helper made it.

const K = "cadaclysm_blacksmith_";

// One public kernel call; a refusal an `Error` in the kernel's words, the call's name dropped.
function kernelCall(kernel, name, ...args) {
    const fn = kernel?.[K + name];
    if (typeof fn !== "function") throw new Error(`the kernel has no \`${K + name}\``);
    try {
        return fn(...args);
    } catch (e) {
        const said = e instanceof Error ? e.message : String(e);
        throw new Error(said.replace(/^profile_[a-z_]+: /, ""));
    }
}
const freeProfile = (kernel, h) => { try { kernel[K + "profile_free"](h); } catch { /* gone already */ } };
// `make` a profile handle, `read` it, the handle freed whatever happens.
function withProfile(kernel, make, read) {
    const h = make();
    try { return read(h); } finally { freeProfile(kernel, h); }
}
// A profile's Béziers on the sketch plane, sixteen doubles each.
const beziers64 = (kernel, h) => kernelCall(kernel, "profile_beziers", h, undefined);
// A new profile's Béziers as the page's `f32` records, the profile freed.
const madeBeziers = (kernel, name, ...args) => withProfile(kernel, () => kernelCall(kernel, name, ...args), (h) => Float32Array.from(beziers64(kernel, h)));
const allFinite = (...v) => v.every(Number.isFinite);
// `runs::line`'s record, made here: `RationalBezier::line` (thirds of the way), z 0, weights 1.
function lineRecord(out, at, x0, y0, x1, y1) {
    const dx = (x1 - x0) * (1 / 3), dy = (y1 - y0) * (1 / 3);
    out.set([x0, y0, 0, 1, x0 + dx, y0 + dy, 0, 1, x0 + dx * 2, y0 + dy * 2, 0, 1, x1, y1, 0, 1], at);
}
// An f32 run's Béziers widened, `count` of them from Bézier `first`.
const widened = (beziers, first = 0, count = beziers.length / 16 - first) => Float64Array.from(beziers.subarray(16 * first, 16 * (first + count)));

/// `runs::line`: a line Bézier, of no length too.
export function lineBeziers(kernel, x0, y0, x1, y1) {
    if (!allFinite(x0, y0, x1, y1)) { const out = new Float32Array(16); lineRecord(out, 0, x0, y0, x1, y1); return out; }
    return madeBeziers(kernel, "profile_polyline", Float64Array.of(x0, y0, x1, y1), false);
}

/// `runs::polyline`: a line Bézier per side, closed with three points or more; empty below two.
export function polylineBeziers(kernel, points, closed) {
    if (points.length % 2 !== 0) throw new Error("points must be x y pairs");
    if (!points.every(Number.isFinite)) throw new Error("every coordinate must be finite");
    const n = points.length / 2;
    if (n < 2) return new Float32Array(0);
    return madeBeziers(kernel, "profile_polyline", Float64Array.from(points), Boolean(closed) && n >= 3);
}

/// `runs::rect`: four line Béziers round the corners in order, of no length too.
export function rectBeziers(kernel, x0, y0, x1, y1) {
    if (!allFinite(x0, y0, x1, y1)) {
        const out = new Float32Array(64), c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (let i = 0; i < 4; i++) lineRecord(out, 16 * i, ...c[i], ...c[(i + 1) % 4]);
        return out;
    }
    return madeBeziers(kernel, "profile_polyline", Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1), true);
}

/// `runs::circle`: four exact quarters from angle 0; empty for a radius not positive.
export function circleBeziers(kernel, cx, cy, r) {
    if (!(r > 0)) return new Float32Array(0);
    if (!allFinite(cx, cy, r)) return new Float32Array(64).fill(NaN);
    return madeBeziers(kernel, "profile_arc", cx, cy, r, 0, 0);
}

/// `runs::arc_through`: the arc from the start through the middle point to the end.
export function arcThroughBeziers(kernel, x0, y0, xm, ym, x1, y1) {
    return madeBeziers(kernel, "profile_arc_through", x0, y0, xm, ym, x1, y1);
}

/// `runs::ellipse`: four exact quarter conics; empty for a semi-axis not positive.
export function ellipseBeziers(kernel, cx, cy, rx, ry) {
    if (!(rx > 0 && ry > 0)) return new Float32Array(0);
    if (!allFinite(cx, cy, rx, ry)) return new Float32Array(64).fill(NaN);
    return madeBeziers(kernel, "profile_ellipse", cx, cy, rx, ry);
}

/// `runs::spline`: the spline through the control polygon, its degree grown with the
/// points (`n - 1` below `degree`), closed (periodic) from three points; empty below two.
export function curveBeziers(kernel, points, degree, weights, closed) {
    if (points.length % 2 !== 0) throw new Error("points must be x y pairs");
    if (degree === 0) throw new Error("degree must be at least 1");
    const n = points.length / 2;
    if (n < 2) return new Float32Array(0);
    return madeBeziers(kernel, "profile_spline", Float64Array.from(points), Math.min(degree, n - 1),
        weights.length ? Float64Array.from(weights) : null, Boolean(closed) && n >= 3);
}

/// `runs::regular_polygon_points`: the corners (at least three) on the circle, the first
/// at `angleDegrees`, flat `x y` pairs -- the profile's Béziers' starts.
export function regularPolygonPoints(kernel, cx, cy, r, sides, angleDegrees) {
    const n = Math.max(sides >>> 0, 3), angle = angleDegrees * (Math.PI / 180);
    let b;
    try {
        b = withProfile(kernel, () => kernelCall(kernel, "profile_regular_polygon", cx, cy, r, n, angle), (h) => beziers64(kernel, h));
    } catch {
        // A radius or centre the kernel refuses: the corners as `regular_polygon_corners` makes them.
        const out = new Float64Array(2 * n);
        for (let i = 0; i < n; i++) {
            const a = angle + Math.PI * 2 * i / n;
            out[2 * i] = cx + r * Math.cos(a);
            out[2 * i + 1] = cy + r * Math.sin(a);
        }
        return out;
    }
    const out = new Float64Array(b.length / 8);
    for (let k = 0; 16 * k < b.length; k++) { out[2 * k] = b[16 * k]; out[2 * k + 1] = b[16 * k + 1]; }
    return out;
}

// Each piece's Béziers (`perPiece[i]` of them, laid end to end in `beziers`) as an open
// profile of exact cubics (`recognise` false) or with lines and arcs recognised; `use`
// the handles, freed afterwards.
function withPieces(kernel, beziers, perPiece, recognise, use) {
    const handles = [];
    try {
        let at = 0;
        for (const n of perPiece) {
            if (n > 0) handles.push(kernelCall(kernel, "profile_from_beziers", widened(beziers, at, n), recognise));
            at += n;
        }
        return use(Uint32Array.from(handles));
    } finally {
        for (const h of handles) freeProfile(kernel, h);
    }
}

/// `runs::chain`: the pieces chained by `Profile::chain`, as Béziers.
export function chainCurves(kernel, beziers, perPiece, tolerance) {
    return withPieces(kernel, beziers, perPiece, false, (hs) =>
        withProfile(kernel, () => kernelCall(kernel, "profile_chain", hs, tolerance), (h) => Float32Array.from(beziers64(kernel, h))));
}

/// `runs::chain_order`: per piece in chain order its index, then 1 where it was turned round.
export function chainOrder(kernel, beziers, perPiece, tolerance) {
    return withPieces(kernel, beziers, perPiece, false, (hs) => Uint32Array.from(kernelCall(kernel, "profile_chain_order", hs, tolerance)));
}

// A profile's outline as JSON (`document_profile_path`): `{ start, segments }`.
const pathOf = (kernel, h) => JSON.parse(kernelCall(kernel, "document_profile_path", h));
const segmentEnd = (s) => s.to ?? s.points[s.points.length - 1];
// A free segment's own Béziers, from `from`, as the kernel decomposes it (its spline's).
function freeBeziers(kernel, from, s) {
    const p = kernelCall(kernel, "path_begin", from[0], from[1]);
    let h;
    try {
        if (s.type === "bezier") kernelCall(kernel, "path_bezier_to", p, s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.to[0], s.to[1]);
        else if (s.type === "conic") kernelCall(kernel, "path_conic_to", p, s.to[0], s.to[1], s.control[0], s.control[1], s.weight);
        else kernelCall(kernel, "path_nurbs_to", p, Float64Array.from(s.points.flat()), s.weights ? Float64Array.from(s.weights) : null, Float64Array.from(s.knots), s.degree);
    } catch (e) {
        try { kernel[K + "path_free"](p); } catch { /* taken */ }
        throw e;
    }
    h = kernelCall(kernel, "path_end_open", p);
    return withProfile(kernel, () => h, (q) => beziers64(kernel, q));
}
// Béziers (sixteen doubles each) as piece records: `2`, four points, four weights.
function cubicRecords(b, out) {
    for (let k = 0; k < b.length; k += 16) out.push(2, b[k], b[k + 1], b[k + 4], b[k + 5], b[k + 8], b[k + 9], b[k + 12], b[k + 13], b[k + 3], b[k + 7], b[k + 11], b[k + 15]);
}
const TAU = Math.PI * 2;
// The point at `angle` on the circle of radius `r` about `c`, as the kernel works it out
// (`centre + (cos, sin) * r`, its own sine and cosine): the start of the whole circle
// from that angle.
const arcPoint = (kernel, c, r, angle) => withProfile(kernel, () => kernelCall(kernel, "profile_arc", c[0], c[1], r, angle, angle), (h) => pathOf(kernel, h).start);
const remEuclid = (a, b) => { const r = a % b; return r < 0 ? r + Math.abs(b) : r; };

/// `runs::round_pieces`: one curve's Béziers rounded by `Profile::round` (its start's
/// corner too when `closed`), as piece records: `0, x0 y0 x1 y1` a line, `1, x0 y0 xm ym
/// x1 y1` an arc through its middle, `2`, four points and four weights a cubic.
export function roundCurve(kernel, beziers, closed, radius) {
    if (beziers.length < 16) throw new Error("nothing to round");
    const path = withProfile(kernel, () => kernelCall(kernel, "profile_from_beziers", widened(beziers), true), (h) =>
        withProfile(kernel, () => kernelCall(kernel, "profile_round", h, radius, null, !closed), (r) => pathOf(kernel, r)));
    const out = [];
    let from = path.start;
    for (const s of path.segments) {
        if (s.type === "line") out.push(0, from[0], from[1], s.to[0], s.to[1]);
        else if (s.type === "arc") {
            const c = s.centre, u = [from[0] - c[0], from[1] - c[1]], v = [s.to[0] - c[0], s.to[1] - c[1]];
            const au = Math.atan2(u[1], u[0]), av = Math.atan2(v[1], v[0]);
            const turn = s.ccw ? remEuclid(av - au, TAU) : -remEuclid(au - av, TAU);
            const m = arcPoint(kernel, c, Math.sqrt(u[0] * u[0] + u[1] * u[1]), au + turn / 2);
            out.push(1, from[0], from[1], m[0], m[1], s.to[0], s.to[1]);
        } else if (s.type === "bezier") out.push(2, from[0], from[1], s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.to[0], s.to[1], 1, 1, 1, 1);
        else if (s.type === "conic") cubicRecords(freeBeziers(kernel, from, s), out);
        else if (s.degree === 3 && s.points.length === 3) {
            const w = s.weights ?? [1, 1, 1, 1], [c1, c2, to] = s.points;
            out.push(2, from[0], from[1], c1[0], c1[1], c2[0], c2[1], to[0], to[1], w[0], w[1], w[2], w[3]);
        } else throw new Error("a piece is not a cubic");
        from = segmentEnd(s);
    }
    return Float64Array.from(out);
}

// The trim's curve (lines and arcs recognised) and its cutters (each `perCutter[i]`
// Béziers; none: left out), `use`d as profile handles.
function withTrim(kernel, beziers, cutters, perCutter, use) {
    if (beziers.length < 16) throw new Error("trim: the curve has nothing drawn");
    return withProfile(kernel, () => kernelCall(kernel, "profile_from_beziers", widened(beziers), true), (curve) =>
        withPieces(kernel, cutters, perCutter, true, (hs) => use(curve, hs)));
}

/// `Profile::pieces_cut_by` for the page: the piece count, each piece's Bézier count,
/// then the pieces' Béziers, as `f32`s.
export function trimPieces(kernel, beziers, cutters, perCutter, tolerance) {
    return withTrim(kernel, beziers, cutters, perCutter, (curve, hs) => {
        const n = kernelCall(kernel, "profile_piece_count", curve, hs, tolerance), runs = [];
        for (let k = 0; k < n; k++) runs.push(withProfile(kernel, () => kernelCall(kernel, "profile_piece", curve, hs, k, tolerance), (h) => beziers64(kernel, h)));
        const out = new Float32Array(1 + n + runs.reduce((s, r) => s + r.length, 0));
        out[0] = n;
        let at = 1 + n;
        runs.forEach((r, k) => { out[1 + k] = r.length / 16; out.set(r, at); at += r.length; });
        return out;
    });
}

// A profile's segments as piece records, an arc's middle at the middle of its angle span
// (`arc_angle_span`), a free segment one cubic per Bézier of its spline.
function pieceRecords(kernel, path, out) {
    let from = path.start, count = 0;
    for (const s of path.segments) {
        if (s.type === "line") { out.push(0, from[0], from[1], s.to[0], s.to[1]); count++; }
        else if (s.type === "arc") {
            const c = s.centre, a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
            let a1 = Math.atan2(s.to[1] - c[1], s.to[0] - c[0]);
            if (s.ccw && a1 <= a0) a1 += TAU;
            else if (!s.ccw && a1 >= a0) a1 -= TAU;
            const dx = from[0] - c[0], dy = from[1] - c[1], m = arcPoint(kernel, c, Math.sqrt(dx * dx + dy * dy), (a0 + a1) / 2);
            out.push(1, from[0], from[1], m[0], m[1], s.to[0], s.to[1]);
            count++;
        } else {
            const b = freeBeziers(kernel, from, s);
            cubicRecords(b, out);
            count += b.length / 16;
        }
        from = segmentEnd(s);
    }
    return count;
}

/// `Profile::trim` for the page: piece `piece` removed, what is left as chains -- the
/// chain count, then per chain its piece count and its piece records.
export function trimCurve(kernel, beziers, cutters, perCutter, piece, tolerance) {
    return withTrim(kernel, beziers, cutters, perCutter, (curve, hs) => {
        const n = kernelCall(kernel, "profile_trim_count", curve, hs, piece, tolerance), out = [n];
        for (let k = 0; k < n; k++) {
            const path = withProfile(kernel, () => kernelCall(kernel, "profile_trim_chain", curve, hs, piece, k, tolerance), (h) => pathOf(kernel, h));
            const records = [];
            out.push(pieceRecords(kernel, path, records), ...records);
        }
        return Float64Array.from(out);
    });
}

/// `Profile::close_loop_within` for the page: one curve's Béziers and the straight side
/// that closes them, `x0 y0 x1 y1` from its end back to its start -- empty where the ends
/// meet within `tolerance`.
export function closeCurve(kernel, beziers, tolerance) {
    if (beziers.length < 16) throw new Error("the curve has nothing drawn");
    const n = beziers.length, sx = beziers[0], sy = beziers[1], ex = beziers[n - 4], ey = beziers[n - 3];
    const dx = ex - sx, dy = ey - sy;
    if ((ex === sx && ey === sy) || Math.sqrt(dx * dx + dy * dy) <= tolerance) return new Float64Array(0);
    const b = withProfile(kernel, () => kernelCall(kernel, "profile_from_beziers", widened(beziers), false), (h) =>
        withProfile(kernel, () => kernelCall(kernel, "profile_close_loop", h), (c) => beziers64(kernel, c)));
    const k = b.length - 16;
    return Float64Array.of(b[k], b[k + 1], b[k + 12], b[k + 13]);
}

/// `runs::loops` for the page: `ends` is `x0 y0 x1 y1` per curve; the loops, each its
/// length then its curves' indices in order. An end that is not finite meets nothing (it
/// is a corner of its own, as a NaN is far from everything): it goes to the kernel as a
/// point far from every other.
export function detectLoops(kernel, ends, tolerance) {
    if (ends.length % 4 !== 0) throw new Error("ends must be x0 y0 x1 y1 per curve");
    const handles = [];
    let far = 0;
    const end = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? [x, y] : [1e300, 1e290 * ++far]);
    try {
        for (let i = 0; 4 * i < ends.length; i++) {
            const e = [...end(ends[4 * i], ends[4 * i + 1]), ...end(ends[4 * i + 2], ends[4 * i + 3])];
            handles.push(kernelCall(kernel, "profile_polyline", Float64Array.from(e), false));
        }
        if (!handles.length) return new Uint32Array(0);
        const flat = kernelCall(kernel, "profile_loops", Uint32Array.from(handles), tolerance);
        let n = 0;
        for (let at = 0; at < flat.length && flat[at] > 0; at += flat[at] + 1) n = at + flat[at] + 1;
        return Uint32Array.from(flat.subarray(0, n));
    } finally {
        for (const h of handles) freeProfile(kernel, h);
    }
}

/// `runs::embedded` for the page: Béziers drawn in a sketch carried onto its plane
/// (`frame`: nine numbers, origin, x, y), the weights as they were.
export function embedBeziers(kernel, beziers, frame) {
    if (frame.length !== 9) throw new Error("a sketch plane is nine numbers: origin, x, y");
    if (beziers.length < 16) return new Float32Array(0);
    const [ox, oy, oz, xx, xy, xz, yx, yy, yz] = frame;
    const frame12 = Float64Array.of(ox, oy, oz, xx, xy, xz, yx, yy, yz, xy * yz - xz * yy, xz * yx - xx * yz, xx * yy - xy * yx);
    const out = withProfile(kernel, () => kernelCall(kernel, "profile_from_beziers", widened(beziers), false), (h) =>
        Float32Array.from(kernelCall(kernel, "profile_beziers", h, frame12)));
    // The weights as they came, as the old record kept them.
    for (let k = 3; k < out.length; k += 4) out[k] = beziers[k];
    return out;
}
