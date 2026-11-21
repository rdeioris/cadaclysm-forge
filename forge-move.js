// The Move command's maths: a move about any pivot composed into a body's place, the middle
// of a selection's boxes, and a typed turn read in the world's axes or the first body's own.
// Pure: no DOM, no document. The page's session and the `move` op (forge-commands.js) share it.
//
// A body's place `{ offset, turn }` (turn: Euler degrees, X then Y then Z, as `Q.fromEuler`
// reads them) is applied by its `_placed` `solid.transform` as
//
//     x  ->  R(turn) · (x − pv) + pv + offset
//
// where `pv` is the body's world pivot without its offset (its in-plane pivot, moved by its
// in-plane transform, on its plane). A further move about pivot `P` -- turn `q`, then slide
// `by` -- gives
//
//     turn'   = q · R(turn)
//     offset' = q · (pv + offset − P) + P + by − pv
import { V, Q } from "./forge-curves.js";

/// Vector `v` turned by quaternion `q` (`[x, y, z, w]`).
export function rotate(q, v) {
    const [x, y, z, w] = q;
    const u = [x, y, z];
    const t = V.mul(V.cross(u, v), 2);
    return V.add(V.add(v, V.mul(t, w)), V.cross(u, t));
}

/// The X-then-Y-then-Z Euler degrees of `q`, as `Q.toEuler` reads them, unrounded but for an
/// angle within 1e-9 of a millionth of a degree, which is taken as that (a quarter turn is
/// 90, not 90.00000000000001).
export function eulerOf(q) {
    const [x, y, z, w] = q;
    const d = 180 / Math.PI;
    const sy = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
    const out = [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d, Math.asin(sy) * d, Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d];
    return out.map((v) => { const r = Math.round(v * 1e6) / 1e6; const o = Math.abs(v - r) < 1e-9 ? r : v; return o === 0 ? 0 : o; });
}

/// Where point `x` of a body lands under its place (`pv` its world pivot without the offset).
export function placed(place, pv, x) {
    return V.add(V.add(rotate(Q.fromEuler(place.turn), V.sub(x, pv)), pv), place.offset);
}

/// A move `{ pivot, by, q }` (q a quaternion, the identity none) composed into a body's place
/// `{ offset, turn }`, `pv` the body's world pivot without its offset: the new place.
export function composeMove(place, pv, move) {
    const q = move.q ?? [0, 0, 0, 1];
    const at = V.add(pv, place.offset);
    const offset = V.sub(V.add(V.add(rotate(q, V.sub(at, move.pivot)), move.pivot), move.by), pv);
    const still = Math.abs(q[0]) < 1e-15 && Math.abs(q[1]) < 1e-15 && Math.abs(q[2]) < 1e-15;
    const turn = still ? place.turn.slice() : eulerOf(Q.mul(q, Q.fromEuler(place.turn)));
    return { offset: offset.map((v) => (v === 0 ? 0 : v)), turn };
}

/// The middle of the union of boxes `{ lo, hi }` (those missing left out); undefined for none.
export function boxCentre(boxes) {
    const list = (boxes ?? []).filter((b) => b && Array.isArray(b.lo) && Array.isArray(b.hi));
    if (!list.length) return undefined;
    const lo = [0, 1, 2].map((k) => Math.min(...list.map((b) => b.lo[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...list.map((b) => b.hi[k])));
    return [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
}

/// A typed turn (Euler degrees `[rx, ry, rz]`) as a quaternion: about the world's axes, or --
/// `axes` "object" -- about the axes of a body turned by `R` (a quaternion): `R · Q · R⁻¹`.
export function turnOf(euler, axes, R = [0, 0, 0, 1]) {
    const q = Q.fromEuler(euler);
    if (axes !== "object") return q;
    const inv = [-R[0], -R[1], -R[2], R[3]];
    return Q.mul(Q.mul(R, q), inv);
}
