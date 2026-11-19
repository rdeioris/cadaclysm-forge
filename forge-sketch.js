// The page's sketch geometry, asked of the kernel: a curve item's Béziers, a regular
// polygon's corners, the loops curves' ends close, a sketch trim's pieces, a chain of pieces
// and the side that closes it. Every answer is a `cadaclysm_blacksmith_profile_*` call on the
// curve as `curve.polycurve` holds its pieces (forge-commands.js's `curveProfile`): nothing
// here computes geometry of its own. No DOM: importable by the page, the worker and node.
//
//   curveBeziers(kernel, c, frame?)       curve item `c` (`{ kind, shape }`) as rational cubic
//                                         Béziers (Float32Array, 16 per Bézier, `x y z w`): in
//                                         its sketch's coordinates (z 0), or on `frame` (twelve
//                                         numbers: origin, x, y, z). Empty while it has nothing
//                                         to draw (a NURBS or a polyline of one point).
//   polygonPoints(kernel, shape)          a regular polygon's corners `[[x, y], ...]`, the first
//                                         at `angle` degrees (`profile_regular_polygon`)
//   regularPolygonPoints(kernel, cx, cy, r, sides, angleDegrees)   the same, flat `x y` pairs
//   chainOf(kernel, pieces)               polycurve pieces (the page's `{ kind, shape }`) put in
//                                         chain order and joined (`profile_from_pieces`):
//                                         `{ beziers, closed }`; refused as the page words it
//                                         ("piece 2 (line) does not meet the others")
//   closingSide(kernel, pieces)           the straight side `[x0, y0, x1, y1]` that closes a
//                                         chain of pieces (`profile_close_loop`), or null where
//                                         its ends meet
//   detectLoops(kernel, ends, tolerance)  `ends` `x0 y0 x1 y1` per curve: the loops they close,
//                                         each its length then its curves' indices
//                                         (`profile_loops`), a Uint32Array
//   trimPieces(kernel, c, cutters, frame) curve item `c` cut by the curve items `cutters`
//                                         (`profile_piece_count` / `profile_piece`): per piece
//                                         `{ beziers, world }`, in sketch coordinates and on
//                                         `frame` (twelve numbers)
import { curveProfile, withProfile, pieceToNode } from "./forge-commands.js";

/// How close two pieces' ends must be to meet (the page's `LOOP_TOLERANCE`).
export const LOOP_TOLERANCE = 1e-3;

/// One kernel call; its refusal an `Error` in the kernel's words, the export's `<what>: ` off.
function call(kernel, name, ...args) {
    const fn = kernel?.[name];
    if (typeof fn !== "function") throw new Error(`the kernel has no \`${name}\``);
    try {
        return fn(...args);
    } catch (e) {
        const text = String(e?.message ?? e);
        const what = `${name.replace(/^cadaclysm_blacksmith_/, "")}: `;
        throw new Error(text.startsWith(what) ? text.slice(what.length) : text);
    }
}

const free = (kernel, h) => call(kernel, "cadaclysm_blacksmith_profile_free", h);
const beziersOf = (kernel, h, frame) => Float32Array.from(call(kernel, "cadaclysm_blacksmith_profile_beziers", h, frame ?? undefined));
const asFrame = (frame) => (frame ? Float64Array.from(frame) : undefined);

/// Whether curve item `c` has nothing to draw yet (not an error): a NURBS or a polyline of
/// fewer than two points, a polycurve of no pieces.
function empty(c) {
    const s = c?.shape;
    if (c?.kind === "nurbs" || c?.kind === "polyline") return !Array.isArray(s?.points) || s.points.length < 2;
    if (c?.kind === "polycurve") return !Array.isArray(s?.pieces) || !s.pieces.length;
    return false;
}

/// Curve item `c`'s Béziers (see the header).
export function curveBeziers(kernel, c, frame = null) {
    if (empty(c)) return new Float32Array(0);
    return withProfile(kernel, () => curveProfile(kernel, c), (h) => beziersOf(kernel, h, asFrame(frame)));
}

/// A regular polygon's corners, flat `x y` pairs (at least three corners).
export function regularPolygonPoints(kernel, cx, cy, r, sides, angleDegrees) {
    const n = Math.max(sides >>> 0, 3);
    return withProfile(kernel, () => call(kernel, "cadaclysm_blacksmith_profile_regular_polygon", cx, cy, r, n, angleDegrees * (Math.PI / 180)), (h) => {
        const pieces = JSON.parse(call(kernel, "cadaclysm_blacksmith_profile_pieces_json", h));
        return Float64Array.from(pieces.flatMap((p) => [p.x0, p.y0]));
    });
}

/// A regular polygon's corners as points.
export function polygonPoints(kernel, { cx, cy, r, sides, angle }) {
    const flat = regularPolygonPoints(kernel, cx, cy, r, Math.max(3, Math.round(sides)), angle ?? 0);
    return Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
}

/// The pieces as one profile (free it), refused in the page's words; `closed`: closed on its
/// start.
function piecesProfile(kernel, pieces, closed = false) {
    try {
        return call(kernel, "cadaclysm_blacksmith_profile_from_pieces", JSON.stringify(pieces.map(pieceToNode)), closed, LOOP_TOLERANCE);
    } catch (e) {
        const said = String(e.message).replace(/^chain: /, "");
        const m = /^piece (\d+) (.*)$/.exec(said);
        throw new Error(m && pieces[+m[1]] ? `piece ${+m[1] + 1} (${pieces[+m[1]].kind}) ${m[2]}` : said);
    }
}

/// The pieces chained (see the header): a chain whose ends meet within the tolerance closed on
/// its start exactly.
export function chainOf(kernel, pieces) {
    const open = withProfile(kernel, () => piecesProfile(kernel, pieces), (h) => beziersOf(kernel, h));
    const n = open.length;
    if (n < 32 || Math.hypot(open[n - 4] - open[0], open[n - 3] - open[1]) > LOOP_TOLERANCE) return { beziers: open, closed: false };
    return { beziers: withProfile(kernel, () => piecesProfile(kernel, pieces, true), (h) => beziersOf(kernel, h)), closed: true };
}

/// The side that closes a chain of pieces, or null where its ends meet already.
export function closingSide(kernel, pieces) {
    return withProfile(kernel, () => piecesProfile(kernel, pieces), (h) => {
        const before = JSON.parse(call(kernel, "cadaclysm_blacksmith_profile_pieces_json", h)).length;
        return withProfile(kernel, () => call(kernel, "cadaclysm_blacksmith_profile_close_loop", h), (c) => {
            const after = JSON.parse(call(kernel, "cadaclysm_blacksmith_profile_pieces_json", c));
            const side = after.length > before ? after[after.length - 1] : null;
            return side?.kind === "line" ? [side.x0, side.y0, side.x1, side.y1] : null;
        });
    });
}

/// The loops curves' ends close (see the header). An end that is not finite meets nothing.
export function detectLoops(kernel, ends, tolerance = LOOP_TOLERANCE) {
    if (ends.length % 4 !== 0) throw new Error("ends must be x0 y0 x1 y1 per curve");
    const handles = [];
    let far = 0;
    const end = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? [x, y] : [1e300, 1e290 * ++far]);
    try {
        for (let i = 0; 4 * i < ends.length; i++) {
            const e = [...end(ends[4 * i], ends[4 * i + 1]), ...end(ends[4 * i + 2], ends[4 * i + 3])];
            handles.push(call(kernel, "cadaclysm_blacksmith_profile_polyline", Float64Array.from(e), false));
        }
        if (!handles.length) return new Uint32Array(0);
        const flat = call(kernel, "cadaclysm_blacksmith_profile_loops", Uint32Array.from(handles), tolerance);
        let n = 0;
        for (let at = 0; at < flat.length && flat[at] > 0; at += flat[at] + 1) n = at + flat[at] + 1;
        return Uint32Array.from(flat.subarray(0, n));
    } finally {
        for (const h of handles) free(kernel, h);
    }
}

/// A sketch trim's pieces (see the header).
export function trimPieces(kernel, c, cutters, frame) {
    const handles = [];
    try {
        for (const k of cutters) if (!empty(k)) handles.push(curveProfile(kernel, k));
        const hs = Uint32Array.from(handles);
        return withProfile(kernel, () => curveProfile(kernel, c), (h) => {
            const n = call(kernel, "cadaclysm_blacksmith_profile_piece_count", h, hs, LOOP_TOLERANCE);
            const out = [];
            for (let k = 0; k < n; k++) {
                out.push(withProfile(kernel, () => call(kernel, "cadaclysm_blacksmith_profile_piece", h, hs, k, LOOP_TOLERANCE),
                    (p) => ({ beziers: beziersOf(kernel, p), world: beziersOf(kernel, p, asFrame(frame)) })));
            }
            return out;
        });
    } finally {
        for (const h of handles) free(kernel, h);
    }
}
