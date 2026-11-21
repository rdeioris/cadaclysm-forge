// The Move command's maths (forge-move.js): a move about any pivot composed into a body's
// place, the selection's box centre, and a typed turn in world or object axes.
//
// Run: node test/forge-move.mjs
import assert from "node:assert";
import { V, Q } from "../forge-curves.js";
import { boxCentre, composeMove, turnOf, rotate, placed } from "../forge-move.js";

const near = (a, b, tol) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
const I = [0, 0, 0, 1];
const sameTurn = (a, b, tol) => { const p = Q.fromEuler(a), q = Q.fromEuler(b); return near(p, q, tol) || near(p, q.map((x) => -x), tol); };

// The identity: nothing moves.
{
    const place = { offset: [3, -4, 5], turn: [10, 20, 30] };
    const out = composeMove(place, [1, 2, 0], { pivot: [7, 7, 7], by: [0, 0, 0], q: I });
    assert.ok(near(out.offset, place.offset, 1e-12), JSON.stringify(out));
    assert.ok(sameTurn(out.turn, place.turn, 1e-12), JSON.stringify(out));
}

// A slide only: the offset gains `by`, wherever the pivot is.
{
    const place = { offset: [3, -4, 5], turn: [0, 45, 0] };
    const out = composeMove(place, [1, 2, 0], { pivot: [-50, 9, 2], by: [1, 2, 3], q: I });
    assert.ok(near(out.offset, [4, -2, 8], 1e-12), JSON.stringify(out));
    assert.ok(sameTurn(out.turn, place.turn, 1e-12));
}

// A turn about the body's own pivot: the offset stays, the turn composed as the manipulator's
// ring drag composes it.
{
    const place = { offset: [3, -4, 5], turn: [10, 20, 30] }, pv = [1, 2, 0];
    const q = Q.fromAxisAngle([0, 1, 1], 0.7);
    const out = composeMove(place, pv, { pivot: V.add(pv, place.offset), by: [0, 0, 0], q });
    assert.ok(near(out.offset, place.offset, 1e-12), JSON.stringify(out));
    const want = Q.mul(Q.fromAxisAngle([0, 1, 1], 0.7), Q.fromEuler(place.turn));
    const got = Q.fromEuler(out.turn);
    assert.ok(near(got, want, 1e-12) || near(got, want.map((x) => -x), 1e-12), JSON.stringify([got, want]));
}

// A quarter turn about Z through a point off the body: a corner of the body lands where the
// turn about that point puts it.
{
    const place = { offset: [20, 0, 0], turn: [0, 0, 0] }, pv = [0, 0, 0];
    const P = [30, 0, 2], q = Q.fromAxisAngle([0, 0, 1], Math.PI / 2);
    const out = composeMove(place, pv, { pivot: P, by: [0, 0, 0], q });
    for (const x of [[-2, -2, 0], [2, 2, 4], [2, -2, 4]]) {
        const p = placed(place, pv, x);
        const want = V.add(rotate(q, V.sub(p, P)), P);
        assert.ok(near(placed(out, pv, x), want, 1e-9), JSON.stringify([placed(out, pv, x), want]));
    }
    assert.ok(near(out.offset, [30, -10, 0], 1e-9), JSON.stringify(out));
    assert.ok(near(out.turn, [0, 0, 90], 1e-9), JSON.stringify(out));
}

// Composition: two moves one after the other are one move with the composed turn and the
// combined slide (about the same pivot, the first slide carried by the second turn).
{
    const place = { offset: [1, 2, 3], turn: [15, -30, 60] }, pv = [4, -1, 2];
    const P = [5, 5, -5];
    const q1 = Q.fromAxisAngle([1, 2, 3], 0.4), b1 = [2, -1, 0.5];
    const q2 = Q.fromAxisAngle([-1, 0, 2], 1.1), b2 = [-3, 0, 4];
    const twice = composeMove(composeMove(place, pv, { pivot: P, by: b1, q: q1 }), pv, { pivot: V.add(P, b1), by: b2, q: q2 });
    const once = composeMove(place, pv, { pivot: P, by: V.add(b1, b2), q: Q.mul(q2, q1) });
    assert.ok(near(twice.offset, once.offset, 1e-9), JSON.stringify([twice, once]));
    assert.ok(sameTurn(twice.turn, once.turn, 1e-9), JSON.stringify([twice, once]));
    for (const x of [[0, 0, 0], [3, -7, 11]]) assert.ok(near(placed(twice, pv, x), placed(once, pv, x), 1e-9));
}

// boxCentre: the middle of the union of the boxes; none, undefined.
{
    assert.deepStrictEqual(boxCentre([{ lo: [18, -2, 0], hi: [22, 2, 4] }, { lo: [38, -2, 0], hi: [42, 2, 4] }]), [30, 0, 2]);
    assert.deepStrictEqual(boxCentre([{ lo: [0, 0, 0], hi: [2, 4, 6] }]), [1, 2, 3]);
    assert.strictEqual(boxCentre([]), undefined);
    assert.strictEqual(boxCentre([null, undefined]), undefined);
}

// turnOf: Euler degrees in the world's axes are fromEuler's; in the object's, the same turn
// about the first body's own axes (R · Q · R⁻¹).
{
    const e = [10, -20, 35];
    assert.ok(near(turnOf(e, "world", I), Q.fromEuler(e), 1e-15));
    const R = Q.fromEuler([0, 0, 90]);
    const got = turnOf([90, 0, 0], "object", R);
    const want = Q.fromEuler([0, 90, 0]);
    assert.ok(near(got, want, 1e-12) || near(got, want.map((x) => -x), 1e-12), JSON.stringify([got, want]));
    // without a body's turn, object is world
    assert.ok(near(turnOf(e, "object", I), Q.fromEuler(e), 1e-12));
}

console.log("forge-move: ok");
