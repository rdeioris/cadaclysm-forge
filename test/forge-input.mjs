// forge-input.js: the forge's pointer events go to View.input in device pixels, a
// press the page claims never does, only held pointers' moves are sent, and the page's
// click runs on a tap the View hands back ({ tap, viewport, double }, setPickOnTap(false))
// for a left press -- with the press's own viewport, pixel and event.
//
// Run: node test/forge-input.mjs
import assert from "node:assert/strict";
import { CLICK_PX, viewEvent, createRouter } from "../forge-input.js";

const TAP = { tap: [20, 40], viewport: 3, double: false };
const ev = (type, o = {}) => ({ type, pointerId: 1, pointerType: "mouse", button: 0, offsetX: 10, offsetY: 20, shiftKey: false, altKey: false, timeStamp: 5, ...o });

// viewEvent: device pixels, alt and shift carried, a touch is button 0.
assert.deepEqual(viewEvent(ev("pointerdown", { altKey: true }), 2), { kind: "down", pointerId: 1, pointer: "mouse", button: 0, x: 20, y: 40, shift: false, alt: true, time: 5 });
assert.deepEqual(viewEvent(ev("pointerdown", { pointerType: "touch", button: -1 }), 1).button, 0);
assert.deepEqual(viewEvent(ev("pointermove", { offsetX: 11 }), 2), { kind: "move", pointerId: 1, pointer: "mouse", x: 22, y: 40, time: 5 });
assert.deepEqual(viewEvent(ev("pointerup"), 1), { kind: "up", pointerId: 1, pointer: "mouse", x: 10, y: 20, time: 5 });
assert.deepEqual(viewEvent(ev("pointercancel"), 1), { kind: "cancel", pointerId: 1 });
assert.equal(viewEvent(ev("pointerover"), 1), null);

// A viewer that records what it is sent and answers an "up" as told.
function fake() {
    const v = { sent: [], taps: [], answer: undefined, setTaps: [] };
    v.viewer = { input: (e) => { v.sent.push(e); return e.kind === "up" ? v.answer : undefined; }, setTap: (px, ms) => v.setTaps.push([px, ms]) };
    v.router = createRouter({ viewer: v.viewer, ratio: () => v.ratio ?? 1, tap: (i, px, e, double) => v.taps.push([i, px, e, double]) });
    return v;
}

// 1. A forwarded press: down sent, its moves sent; another pointer's move is not.
{
    const v = fake();
    const down = ev("pointerdown");
    v.router.forward(down, 0, [10, 20]);
    assert.equal(v.router.holds(1), true);
    assert.equal(v.router.move(ev("pointermove", { offsetX: 30 })), true);
    assert.equal(v.router.move(ev("pointermove", { pointerId: 2 })), false, "a pointer the view never got is not its");
    assert.deepEqual(v.sent.map((e) => e.kind), ["down", "move"]);
}

// 2. A tap (the viewer answers the up): the page's click runs once, with the press's own
// viewport, pixel and event (not the answer's device pixels), and says whether it was a double.
{
    const v = fake();
    const down = ev("pointerdown", { ctrlKey: true });
    v.router.forward(down, 2, [10, 20]);
    v.answer = TAP;
    assert.equal(v.router.up(ev("pointerup")), true);
    assert.deepEqual(v.taps, [[2, [10, 20], down, false]]);
    v.router.forward(down, 2, [10, 20]);
    v.answer = { ...TAP, double: true };
    v.router.up(ev("pointerup"));
    assert.deepEqual(v.taps[1], [2, [10, 20], down, true]);
    v.taps.pop();
    assert.equal(v.router.up(ev("pointerup")), false, "released already: not the view's");
    assert.equal(v.taps.length, 1);
}

// 3. A drag (the viewer answers nothing): no click.
{
    const v = fake();
    v.router.forward(ev("pointerdown"), 0, [10, 20]);
    v.router.up(ev("pointerup"));
    assert.deepEqual(v.taps, []);
}

// 4. A right press the viewer answers as a tap is still not a click.
{
    const v = fake();
    v.router.forward(ev("pointerdown", { button: 2 }), 0, [10, 20]);
    v.answer = TAP;
    v.router.up(ev("pointerup", { button: 2 }));
    assert.deepEqual(v.taps, []);
}

// 5. An answer that is not a tap -- a pick's promise, from a viewer left with pick-on-tap on --
// is no click (the forge must call setPickOnTap(false), Task 5).
{
    const v = fake();
    v.router.forward(ev("pointerdown"), 0, [10, 20]);
    v.answer = Promise.resolve(null);
    v.router.up(ev("pointerup"));
    assert.deepEqual(v.taps, []);
}

// 6. A cancel is sent and ends the hold; a later up is not the view's.
{
    const v = fake();
    v.router.forward(ev("pointerdown"), 0, [10, 20]);
    assert.equal(v.router.cancel(ev("pointercancel")), true);
    assert.equal(v.router.up(ev("pointerup")), false);
    assert.deepEqual(v.sent.map((e) => e.kind), ["down", "cancel"]);
}

// 7. The tap distance follows the ratio: 3 CSS px are 6 device px at 2; set once per change, no time limit.
{
    const v = fake();
    v.ratio = 2; v.router.syncTap(); v.router.syncTap();
    v.ratio = 1; v.router.syncTap();
    assert.deepEqual(v.setTaps, [[CLICK_PX * 2, 0], [CLICK_PX, 0]]);
}

// 8. A promise answer that rejects (pick-on-tap left on, a lost device) is no click and no unhandled rejection.
{
    let unhandled = false;
    const on = () => { unhandled = true; };
    process.on("unhandledRejection", on);
    const v = fake();
    v.router.forward(ev("pointerdown"), 0, [10, 20]);
    v.answer = Promise.reject(new Error("lost"));
    v.router.up(ev("pointerup"));
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", on);
    assert.equal(unhandled, false);
}

// 9. The dead zone: moves within 3 CSS px of the press are held back (still the view's); the
// first beyond is sent, and it is the pointer's own position, so the View gets the whole travel.
{
    const v = fake();
    v.router.forward(ev("pointerdown"), 0, [10, 20]);
    assert.equal(v.router.move(ev("pointermove", { offsetX: 12, offsetY: 21 })), true);
    assert.equal(v.router.move(ev("pointermove", { offsetX: 13, offsetY: 20 })), true, "exactly 3 px is still a click");
    assert.deepEqual(v.sent.map((e) => e.kind), ["down"]);
    v.router.move(ev("pointermove", { offsetX: 14, offsetY: 20 }));
    v.router.move(ev("pointermove", { offsetX: 11, offsetY: 20 }));
    assert.deepEqual(v.sent.map((e) => e.kind), ["down", "move", "move"], "once out, every move is sent, even back inside");
    assert.equal(v.sent[1].x, 14);
    v.answer = undefined;
    v.router.up(ev("pointerup"));
    assert.equal(v.sent.at(-1).kind, "up", "the up is always sent");
}

// 10. The exit is the distance, on any axis: straight down, or on the diagonal (2.5, 2.5 is
// 3.54 px out); and the threshold is in CSS pixels at any ratio -- 3 px at ratio 2 is 6 device
// px, so a move of 2 CSS px (4 device) stays held and one of 4 CSS px (8 device) goes out.
{
    const v = fake();
    v.router.forward(ev("pointerdown"), 0, [10, 20]);
    v.router.move(ev("pointermove", { offsetX: 10, offsetY: 23 }));
    assert.deepEqual(v.sent.map((e) => e.kind), ["down"], "3 px down is still a click");
    v.router.move(ev("pointermove", { offsetX: 10, offsetY: 24 }));
    assert.deepEqual(v.sent.map((e) => e.kind), ["down", "move"], "4 px down is a drag");
    assert.equal(v.sent[1].y, 24);
    const d = fake();
    d.router.forward(ev("pointerdown"), 0, [10, 20]);
    d.router.move(ev("pointermove", { offsetX: 12, offsetY: 22 }));
    assert.equal(d.sent.length, 1, "2 px on each axis is 2.83 px: held");
    d.router.move(ev("pointermove", { offsetX: 13, offsetY: 23 }));
    assert.equal(d.sent.length, 2, "3 px on each axis is 4.24 px: out");
    const r = fake();
    r.ratio = 2;
    r.router.forward(ev("pointerdown"), 0, [10, 20]);
    r.router.move(ev("pointermove", { offsetX: 12, offsetY: 20 }));
    assert.equal(r.sent.length, 1, "2 CSS px at ratio 2 is held");
    r.router.move(ev("pointermove", { offsetX: 14, offsetY: 20 }));
    assert.equal(r.sent.length, 2, "4 CSS px at ratio 2 goes out");
    assert.equal(r.sent[1].x, 28, "in device pixels");
}

// 11. A shiftTap press (a Shift press the View refuses to tap, wanted as a click for a face
// pick of several): still within 3 px at the up it is a tap, with no double; moved past it
// is a drag -- its moves are forwarded and there is no tap; a plain press is unchanged.
{
    const v = fake();
    v.router.forward(ev("pointerdown", { shiftKey: true }), 2, [10, 20], { shiftTap: true });
    v.router.move(ev("pointermove", { offsetX: 12 }));
    assert.equal(v.router.up(ev("pointerup", { offsetX: 12 })), true);
    assert.equal(v.taps.length, 1);
    assert.deepEqual([v.taps[0][0], v.taps[0][1], v.taps[0][3]], [2, [10, 20], false]);
    const d = fake();
    d.router.forward(ev("pointerdown", { shiftKey: true }), 2, [10, 20], { shiftTap: true });
    d.router.move(ev("pointermove", { offsetX: 20 }));
    d.router.up(ev("pointerup", { offsetX: 20 }));
    assert.equal(d.taps.length, 0, "a drag is no click");
    assert.deepEqual(d.sent.map((e) => e.kind), ["down", "move", "up"], "and its moves went to the view");
    const p = fake();
    p.router.forward(ev("pointerdown", { shiftKey: true }), 2, [10, 20]);
    p.router.up(ev("pointerup"));
    assert.equal(p.taps.length, 0, "without the flag the View's answer decides");
}

// 12. A viewer that refuses an event (input throws): the router reports it and carries on --
// the press stays held, the next press and its tap work.
{
    const v = fake();
    const said = [];
    let refuse = true;
    const input = v.viewer.input;
    v.viewer.input = (e) => { if (refuse) throw new Error("refused"); return input(e); };
    v.router = createRouter({ viewer: v.viewer, ratio: () => 1, tap: (i, px, e, double) => v.taps.push([i, px, e, double]), onError: (e) => said.push(e.message) });
    v.router.forward(ev("pointerdown"), 1, [10, 20]);
    assert.deepEqual(said, ["refused"], "the refusal was reported");
    assert.equal(v.router.holds(1), true, "and the press is still held");
    assert.equal(v.router.move(ev("pointermove", { offsetX: 30 })), true);
    v.router.up(ev("pointerup", { offsetX: 30 }));
    refuse = false;
    v.router.forward(ev("pointerdown"), 2, [10, 20]);
    v.answer = TAP;
    assert.equal(v.router.up(ev("pointerup")), true);
    assert.equal(v.taps.length, 1, "the next press taps as ever");
}

// 13. A viewer across the worker: input answers { seq }; the tap arrives later as view.tapped.
{
    let seq = 0; const taps = [];
    const viewer = { input: () => ({ seq: ++seq }), setTap: () => {} };
    const r = createRouter({ viewer, ratio: () => 1, tap: (i, px, e, double) => taps.push([i, px, double]) });
    r.forward(ev("pointerdown"), 2, [10, 20]); r.up(ev("pointerup"));            // seq 1 down, 2 up: a tap
    r.forward(ev("pointerdown", { pointerId: 2 }), 0, [5, 5]); r.up(ev("pointerup", { pointerId: 2 }));   // 3, 4: a drag
    r.forward(ev("pointerdown", { pointerId: 3, button: 2 }), 1, [1, 1]); r.up(ev("pointerup", { pointerId: 3, button: 2 }));   // right button: never a click
    assert.deepEqual(taps, [], "nothing until the worker answers");
    r.tapped({ seq: 2, tap: [10, 20], viewport: 2, double: false });
    r.tapped({ seq: 6, tap: [1, 1], viewport: 1, double: false });
    assert.deepEqual(taps, [[2, [10, 20], false]], "the press kept under the tap's seq, the right button's dropped");
    r.tapped({ seq: 4, tap: [5, 5], viewport: 0, double: false });
    assert.equal(taps.length, 1, "a seq below one answered is gone");
    r.tapped({ seq: 2, tap: [10, 20], viewport: 2, double: false });
    assert.equal(taps.length, 1, "a seq answered once is not answered twice");
    // At most 16 kept: the oldest goes.
    const old = [];
    const r2 = createRouter({ viewer, ratio: () => 1, tap: (i) => old.push(i) });
    const first = seq + 2;
    for (let i = 0; i < 17; i++) { r2.forward(ev("pointerdown"), i, [10, 20]); r2.up(ev("pointerup")); }
    r2.tapped({ seq: first, tap: [10, 20], viewport: 0, double: false });
    assert.deepEqual(old, [], "the 17th press pushed the first out");
    r2.tapped({ seq: first + 2, tap: [10, 20], viewport: 0, double: true });
    assert.deepEqual(old, [1], "the second is still there");
}

// 14. Ups that were never taps do not evict a real tap, and a Shift tap the page already ran is not kept.
{
    let seq = 0; const taps = [];
    const viewer = { input: () => ({ seq: ++seq }), setTap: () => {} };
    const r = createRouter({ viewer, ratio: () => 1, tap: (i) => taps.push(i) });
    for (let i = 0; i < 20; i++) { r.forward(ev("pointerdown"), 100 + i, [1, 1]); r.up(ev("pointerup")); }
    r.forward(ev("pointerdown"), 9, [10, 20]); r.up(ev("pointerup"));
    r.tapped({ seq, tap: [10, 20], viewport: 0, double: false });
    assert.deepEqual(taps, [9], "the tap's click ran after 20 ups that were not taps");
    const s = createRouter({ viewer, ratio: () => 1, tap: (i) => taps.push(i) });
    taps.length = 0;
    s.forward(ev("pointerdown"), 3, [10, 20], { shiftTap: true }); s.up(ev("pointerup"));
    assert.deepEqual(taps, [3], "the shift tap ran at the up");
    s.tapped({ seq, tap: [10, 20], viewport: 0, double: false });
    assert.deepEqual(taps, [3], "and does not run again when the worker answers");
}

console.log("forge-input: the overlay's events, forwarded");
