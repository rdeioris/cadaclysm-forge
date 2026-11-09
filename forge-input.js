// The forge's pointer input, handed to the View's one gesture handler (`View`'s,
// read by the camera under the press: a left drag looks in Perspective and
// pans an orthographic view, Alt and the left button orbit the pivot, the right button
// pans). The page claims what it handles itself -- a handle or the gizmo, the view cube, a
// name, a curve being drawn -- by not forwarding the press; everything it forwards is the
// view's until the button comes up. A tap comes back as `viewer.input`'s answer to the
// "up", and the page runs what the press would have done (`tap`). Across a worker the answer
// is only `{ seq }`: the press is kept under it, and the tap comes later as the worker's
// view.tapped, given to `tapped(message)`.
//
// Pixels: the overlay's events are CSS pixels; the View's are its device pixels, `ratio`
// to a CSS pixel (`forge.js`'s `drawRatio`, which caps the device ratio), so the tap's
// distance is set in device pixels and follows the ratio.

/** The forge's click: a press that travels at most this many CSS pixels. */
export const CLICK_PX = 3;

/** A DOM pointer event on the overlay as `View.input` takes it, or null. */
export function viewEvent(e, ratio) {
    const pointer = e.pointerType || "mouse";
    const at = { x: e.offsetX * ratio, y: e.offsetY * ratio };
    switch (e.type) {
        case "pointerdown":
            return { kind: "down", pointerId: e.pointerId, pointer, button: pointer === "mouse" ? e.button : 0, ...at, shift: !!e.shiftKey, alt: !!e.altKey, time: e.timeStamp };
        case "pointermove": return { kind: "move", pointerId: e.pointerId, pointer, ...at, time: e.timeStamp };
        case "pointerup": return { kind: "up", pointerId: e.pointerId, pointer, ...at, time: e.timeStamp };
        case "pointercancel": return { kind: "cancel", pointerId: e.pointerId };
        default: return null;
    }
}

export function createRouter({ viewer, ratio, tap, onError = () => {} }) {
    const held = new Map();   // pointerId -> { i, px, e, button, moved }: presses the view has
    const waiting = new Map();   // seq -> press, for a viewer across a worker
    let tapRatio = null;
    const send = (event) => {
        // A refusal (an event the View will not take) is reported, and the router, with its
        // held presses, carries on.
        let answer;
        try { answer = viewer.input(event); } catch (e) { onError(e); return undefined; }
        if (answer && typeof answer.then === "function") answer.catch(() => {});
        return answer;
    };
    return {
        // `shiftTap`: a Shift press the View would not tap (it refuses them) but the page
        // wants as a click if it never became a drag -- a face pick of several.
        forward(e, i, px, { shiftTap = false } = {}) {
            held.set(e.pointerId, { i, px, e, button: (e.pointerType || "mouse") === "mouse" ? e.button : 0, moved: false, shiftTap });
            send(viewEvent(e, ratio()));
        },
        move(e) {
            const press = held.get(e.pointerId);
            if (!press) return false;
            // The old forge's dead zone: nothing moves until the pointer has left CLICK_PX
            // CSS pixels of its press, so a click does not nudge the view. The View measures
            // each drag step from the last position it was sent, so the first move sent
            // carries the whole travel; a tap is judged from down to up, so held-back moves
            // change no tap.
            if (!press.moved) {
                if (Math.hypot(e.offsetX - press.px[0], e.offsetY - press.px[1]) <= CLICK_PX) return true;
                press.moved = true;
            }
            send(viewEvent(e, ratio()));
            return true;
        },
        up(e) {
            const press = held.get(e.pointerId);
            if (!press) return false;
            held.delete(e.pointerId);
            const answer = send(viewEvent(e, ratio()));
            if (answer && typeof answer === "object" && typeof answer.seq === "number" && !Array.isArray(answer.tap) && press.button === 0 && !press.shiftTap) {
                waiting.set(answer.seq, press);
                if (waiting.size > 16) waiting.delete(waiting.keys().next().value);
            }
            // A tap comes back as `{ tap, viewport, double }` (`setPickOnTap(false)`); the
            // View already refused Shift and Alt presses. The left button's tap is the
            // page's click, run where the press landed.
            const isTap = answer !== null && typeof answer === "object" && Array.isArray(answer.tap);
            if (press.shiftTap && !press.moved && press.button === 0 && Math.hypot(e.offsetX - press.px[0], e.offsetY - press.px[1]) <= CLICK_PX) { tap(press.i, press.px, press.e, false); return true; }
            if (isTap && press.button === 0) tap(press.i, press.px, press.e, !!answer.double);
            return true;
        },
        cancel(e) {
            if (!held.has(e.pointerId)) return false;
            held.delete(e.pointerId);
            send({ kind: "cancel", pointerId: e.pointerId });
            return true;
        },
        // A viewer across a worker answers an up with `{ seq }` only; the tap, if it was one,
        // comes later as view.tapped. Runs the click for the press kept under its seq, and
        // drops the kept presses up to it (their ups were not taps).
        tapped(message) {
            const press = waiting.get(message.seq);
            for (const s of [...waiting.keys()]) if (s <= message.seq) waiting.delete(s);
            if (press) tap(press.i, press.px, press.e, !!message.double);
        },
        holds: (pointerId) => held.has(pointerId),
        syncTap() {
            const r = ratio();
            if (r === tapRatio) return;
            tapRatio = r;
            viewer.setTap(CLICK_PX * r, 0);
        },
    };
}
