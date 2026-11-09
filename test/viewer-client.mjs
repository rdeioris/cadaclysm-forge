// The page-side client: transfers a canvas to a worker's View, keeps its size in step,
// forwards input and turns picks into promises. Checked here against a fake canvas, a fake
// worker and fake ResizeObserver/devicePixelRatio globals -- no wasm, no real worker.
//
// Run: node test/viewer-client.mjs
import assert from "node:assert/strict";
import { attachViewer } from "../viewer-client.js";
// On the site the client loads view.js as ./pkg/view.js by itself; here it is injected from
// its source, the way attachViewer's `normalise`/`listen` options allow.
import { normalise, listen } from "../pkg/view.js";

const OFFSCREEN_TOKEN = { offscreen: true };

class FakeResizeObserver {
    constructor(cb) { this.cb = cb; FakeResizeObserver.instances.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
}
FakeResizeObserver.instances = [];
globalThis.ResizeObserver = FakeResizeObserver;
globalThis.devicePixelRatio = 2;

function fakeCanvas(width, height) {
    const listeners = new Map();
    return {
        clientWidth: width,
        clientHeight: height,
        style: {},
        listeners,
        transferControlToOffscreen() { return OFFSCREEN_TOKEN; },
        getBoundingClientRect: () => ({ left: 10, top: 20 }),
        setPointerCapture() {},
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type) => listeners.delete(type),
    };
}

function fakeWorker() {
    const sent = [];
    return { worker: { postMessage: (m, t) => sent.push([m, t]) }, sent };
}

// 1. view.create carries the offscreen token in the transfer list, the CSS size x ratio,
// and surfaces.
{
    const { worker, sent } = fakeWorker();
    attachViewer({ canvas: fakeCanvas(300, 150), worker, id: 7, surfaces: "triangles" });
    assert.equal(sent.length, 1);
    assert.strictEqual(sent[0][0].kind, "view.create");
    assert.strictEqual(sent[0][0].id, 7);
    assert.strictEqual(sent[0][0].width, 300);
    assert.strictEqual(sent[0][0].height, 150);
    assert.strictEqual(sent[0][0].ratio, 2);
    assert.strictEqual(sent[0][0].surfaces, "triangles");
    assert.deepStrictEqual(sent[0][1], [OFFSCREEN_TOKEN]);
    assert.strictEqual(sent[0][0].canvas, OFFSCREEN_TOKEN);
    // Nothing asked for: exact, the default (a WebGL2 View draws triangles by itself).
    const other = fakeWorker();
    attachViewer({ canvas: fakeCanvas(300, 150), worker: other.worker, id: 8 });
    assert.strictEqual(other.sent[0][0].surfaces, "exact");
}

// 2. ready resolves on view.ready and rejects on view.failed.
{
    const { worker } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 1 });
    client.receive({ kind: "view.ready", id: 1, backend: "webgpu", surfaces: "exact", maxDrawingSize: 4096 });
    assert.deepEqual(await client.ready, { backend: "webgpu", surfaces: "exact", maxDrawingSize: 4096 });
}
{
    const { worker } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 1 });
    client.receive({ kind: "view.failed", id: 1, message: "no WebGPU or WebGL2 in this browser" });
    await assert.rejects(client.ready, /no WebGPU or WebGL2 in this browser/);
}

// 3. `view` calls any View method by name: view.orbit(1, 2) posts view.call with a fresh
// seq and resolves with view.result's value for that seq; view.error for a call's seq
// rejects with its message (and does not reach onError); a view.error with no seq still
// does. `view` is not a thenable, so `await client.view` sends nothing.
{
    const { worker, sent } = fakeWorker();
    const errors = [];
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 3, onError: (m) => errors.push(m), normalise, listen });
    sent.length = 0;
    const orbit = client.view.orbit(1, 2);
    const { seq } = sent.at(-1)[0];
    assert.deepEqual(sent.at(-1)[0], { kind: "view.call", id: 3, seq, name: "orbit", args: [1, 2] });
    const framed = client.view.frame(7, 8);
    const frameSeq = sent.at(-1)[0].seq;
    assert.notEqual(frameSeq, seq, "every call has its own seq");
    client.receive({ kind: "view.result", id: 3, seq: frameSeq, value: true });
    client.receive({ kind: "view.result", id: 3, seq, value: undefined });
    assert.equal(await orbit, undefined);
    assert.equal(await framed, true, "each call resolves with its own seq's value");
    // A getter the host answers through view.call: navigation() resolves with its value.
    const navigation = client.view.navigation();
    assert.deepEqual(sent.at(-1)[0], { kind: "view.call", id: 3, seq: sent.at(-1)[0].seq, name: "navigation", args: [] });
    client.receive({ kind: "view.result", id: 3, seq: sent.at(-1)[0].seq, value: "fly" });
    assert.equal(await navigation, "fly");
    const failing = client.view.showCurves([], [1, 0, 0]);
    client.receive({ kind: "view.error", id: 3, seq: sent.at(-1)[0].seq, message: "curves: bad beziers" });
    await assert.rejects(failing, /curves: bad beziers/);
    assert.deepEqual(errors, [], "a call's own error rejects the call, not onError");
    client.receive({ kind: "view.error", id: 3, message: "device lost" });
    assert.deepEqual(errors, ["device lost"]);
    sent.length = 0;
    assert.equal(await client.view, client.view, "the proxy is not a thenable");
    assert.equal(sent.length, 0, "awaiting it sent nothing");
}

// 3b. input(domEvent) posts view.input with normalise's object and a fresh seq; an event
// the handler does not take posts nothing; a view.picked answering an input goes to onPick.
{
    const { worker, sent } = fakeWorker();
    const picks = [];
    const canvas = fakeCanvas(100, 100);
    const client = attachViewer({ canvas, worker, id: 4, onPick: (hit) => picks.push(hit), normalise, listen });
    sent.length = 0;
    const dom = { type: "pointerdown", pointerId: 1, pointerType: "mouse", button: 0, clientX: 15, clientY: 25, shiftKey: false, timeStamp: 7 };
    client.input(dom);
    const m = sent.at(-1)[0];
    assert.deepEqual(m, { kind: "view.input", id: 4, seq: m.seq, event: normalise(canvas, dom) });
    assert.deepEqual(m.event, { kind: "down", pointerId: 1, pointer: "mouse", button: 0, x: 10, y: 10, shift: false, alt: false, time: 7 });
    sent.length = 0;
    client.input({ type: "keydown", code: "" });
    assert.equal(sent.length, 0, "an event normalise refuses posts nothing");
    client.receive({ kind: "view.picked", id: 4, seq: m.seq, hit: { item: 1, node: 0, face: 2 } });
    assert.deepEqual(picks, [{ item: 1, node: 0, face: 2 }]);
}

// 3c. controls: true listens on the canvas itself through view.js's listen, forwarding
// every event it takes as view.input; free() removes those listeners.
{
    const { worker, sent } = fakeWorker();
    const canvas = fakeCanvas(100, 100);
    const client = attachViewer({ canvas, worker, id: 5, controls: true, normalise, listen });
    assert.ok(canvas.listeners.size > 0, "listening on the canvas");
    sent.length = 0;
    canvas.listeners.get("wheel")({ type: "wheel", deltaY: -3, deltaMode: 1, preventDefault() {} });
    assert.deepEqual(sent.at(-1)[0].event, { kind: "wheel", deltaY: -48 });
    assert.equal(sent.at(-1)[0].kind, "view.input");
    client.free();
    assert.equal(canvas.listeners.size, 0, "free() removes the canvas's listeners");
    // Without controls, nothing listens.
    const other = fakeCanvas(100, 100);
    attachViewer({ canvas: other, worker, id: 6, normalise, listen });
    assert.equal(other.listeners.size, 0);
}

// 3d. A call whose arguments postMessage cannot clone rejects with that error at once.
{
    const worker = { postMessage: (m) => { if (m.kind === "view.call") throw new Error("DataCloneError: a function"); } };
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 12, normalise, listen });
    await assert.rejects(client.view.onError(() => {}), /DataCloneError/);
}

// 4. Two picks while one is out: the first resolves with its hit, the superseded middle
// one resolves null, and only the latest is sent after the first answer.
{
    const { worker, sent } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 5 });
    sent.length = 0;
    const first = client.pick(10, 20);
    const middle = client.pick(30, 40);
    const last = client.pick(50, 60);
    assert.equal(sent.length, 1, "only the first pick is sent while one is outstanding");
    const firstSeq = sent[0][0].seq;
    assert.equal(await middle, null, "the superseded middle pick resolves null");
    client.receive({ kind: "view.picked", id: 5, seq: firstSeq, hit: { item: 1, face: 0 } });
    assert.deepEqual(await first, { item: 1, face: 0 });
    assert.equal(sent.length, 2, "the latest queued pick is sent once the first answers");
    assert.notEqual(sent[1][0].seq, firstSeq);
    assert.equal(sent[1][0].x, 50);
    assert.equal(sent[1][0].y, 60);
    client.receive({ kind: "view.picked", id: 5, seq: sent[1][0].seq, hit: null });
    assert.equal(await last, null);
}

// 5. view.error calls onError.
{
    const { worker } = fakeWorker();
    const errors = [];
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 1, onError: (m) => errors.push(m) });
    client.receive({ kind: "view.error", id: 1, message: "device lost" });
    assert.deepEqual(errors, ["device lost"]);
}

// 6. free() sends view.free.
{
    const { worker, sent } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 9 });
    sent.length = 0;
    client.free();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][0], { kind: "view.free", id: 9 });
}

// 6b. free() settles what is still out: a call in flight rejects with "the view was freed",
// the pick in flight and a queued one resolve null.
{
    const { worker } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 10, normalise, listen });
    const orbit = client.view.orbit(1, 2);
    const inFlight = client.pick(1, 2);
    const waiting = client.pick(3, 4);
    client.free();
    await assert.rejects(orbit, /the view was freed/);
    assert.equal(await inFlight, null);
    assert.equal(await waiting, null);
}

// 6c. A fire-and-forget call that then rejects (here, freed) logs no unhandled rejection;
// an awaited one still rejects.
{
    const unhandled = [];
    const guard = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", guard);
    const { worker } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 13, normalise, listen });
    client.view.orbit(1, 2); // nobody holds this promise
    const awaited = client.view.pan(3, 4);
    client.free();
    await assert.rejects(awaited, /the view was freed/);
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", guard);
    assert.deepEqual(unhandled.map((e) => e?.message), [], "a fire-and-forget call's rejection is handled");
}

// 7. client.ratio is null until view.ready, then the host's effective ratio (the
// drawingRatio it actually used, which can be lower than devicePixelRatio) -- and every
// later view.resized updates it again. pick(x, y) takes device pixels at this ratio.
{
    const { worker } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 6 });
    assert.equal(client.ratio, null, "no ratio before view.ready");
    client.receive({ kind: "view.ready", id: 6, backend: "webgpu", surfaces: "exact", maxDrawingSize: 4096, ratio: 2 });
    assert.equal(client.ratio, 2);
    client.receive({ kind: "view.resized", id: 6, width: 4000, height: 4000, ratio: 1.024 });
    assert.equal(client.ratio, 1.024, "a later view.resized updates it again");
    // A message for a different id is ignored, as every other message here is.
    client.receive({ kind: "view.resized", id: 999, width: 1, height: 1, ratio: 9 });
    assert.equal(client.ratio, 1.024, "unaffected by another id's view.resized");
}

// 8. blur, and visibilitychange to hidden, send view.call of clearKeys -- so a fly key left
// down when focus (or the whole tab) leaves does not fly forever. Every other test in
// this file ran with no globalThis.addEventListener at all (Node has none by default,
// confirmed by test 6 above sending only view.free on free()): this test patches one in
// to prove the listeners it does add do the right thing, then removes it again.
{
    const listeners = {};
    globalThis.addEventListener = (type, fn) => { (listeners[type] ??= []).push(fn); };
    globalThis.removeEventListener = (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); };
    globalThis.document = { hidden: false };
    const { worker, sent } = fakeWorker();
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 11 });
    sent.length = 0;
    const clearKeys = (m) => ({ kind: "view.call", id: 11, seq: m.seq, name: "clearKeys", args: [] });
    for (const fn of listeners.blur) fn();
    assert.deepEqual(sent.at(-1)[0], clearKeys(sent.at(-1)[0]), "blur clears the held keys");
    sent.length = 0;
    for (const fn of listeners.visibilitychange) fn();
    assert.equal(sent.length, 0, "still visible: visibilitychange alone does not clear");
    globalThis.document.hidden = true;
    for (const fn of listeners.visibilitychange) fn();
    assert.deepEqual(sent.at(-1)[0], clearKeys(sent.at(-1)[0]), "hidden: visibilitychange clears");
    client.receive({ kind: "view.error", id: 11, seq: sent.at(-1)[0].seq, message: "gone" });
    await Promise.resolve();
    client.free();
    assert.deepEqual(listeners.blur, [], "free() removes the blur listener");
    assert.deepEqual(listeners.visibilitychange, [], "free() removes the visibilitychange listener");
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    delete globalThis.document;
}

// 9. devicePixelRatio changing with no CSS resize (the window dragged to another monitor)
// is caught by the next forwarded input, not only the ResizeObserver: forward() re-checks
// the size before every view.input, so a view.resize for the new ratio posts first.
{
    globalThis.devicePixelRatio = 1;
    const { worker, sent } = fakeWorker();
    const canvas = fakeCanvas(100, 100);
    const client = attachViewer({ canvas, worker, id: 14, normalise, listen });
    sent.length = 0;
    globalThis.devicePixelRatio = 2;
    const dom = { type: "pointerdown", pointerId: 1, pointerType: "mouse", button: 0, clientX: 15, clientY: 25, shiftKey: false, timeStamp: 7 };
    client.input(dom);
    assert.equal(sent.length, 2, "the ratio change is caught before the input it came with");
    assert.deepEqual(sent[0][0], { kind: "view.resize", id: 14, width: 100, height: 100, ratio: 2 });
    assert.equal(sent[1][0].kind, "view.input");
    globalThis.devicePixelRatio = 2; // restore the module's default for any test added after this one
}

// 10. controls: true -- the canvas losing focus while a fly key is held (focus moved to
// the page's editor, so the window never blurs) sends view.call of clearKeys: the
// keyup lands elsewhere and would otherwise never reach the View. No
// globalThis.addEventListener here, so only listen's canvas blur can send it.
{
    const { worker, sent } = fakeWorker();
    const canvas = fakeCanvas(100, 100);
    const client = attachViewer({ canvas, worker, id: 15, controls: true, normalise, listen });
    canvas.listeners.get("keydown")({ type: "keydown", code: "KeyW" });
    assert.deepEqual(sent.at(-1)[0].event, { kind: "key", code: "KeyW", down: true });
    sent.length = 0;
    assert.ok(canvas.listeners.has("blur"), "controls: true listens for the canvas's blur");
    canvas.listeners.get("blur")();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][0], { kind: "view.call", id: 15, seq: sent[0][0].seq, name: "clearKeys", args: [] });
    // Answered with an error: nobody awaits it, so no unhandled rejection either.
    client.receive({ kind: "view.error", id: 15, seq: sent[0][0].seq, message: "gone" });
    await Promise.resolve();
    client.free();
    assert.ok(!canvas.listeners.has("blur"), "free() removes the canvas's blur listener");
}

// 11. view.frame reaches onFrame and client.lastFrame; another id's changes nothing; view.tapped
// reaches onTap.
{
    const { worker } = fakeWorker();
    const frames = [];
    const taps = [];
    const client = attachViewer({ canvas: fakeCanvas(300, 150), worker, id: 12, onFrame: (v) => frames.push(v), onTap: (t) => taps.push(t) });
    assert.strictEqual(client.lastFrame, null, "no frame yet");
    client.receive({ kind: "view.frame", id: 12, viewports: [{ kind: "fly" }] });
    assert.equal(frames.length, 1);
    assert.equal(client.lastFrame[0].kind, "fly");
    client.receive({ kind: "view.frame", id: 13, viewports: [{ kind: "orbit" }] });
    assert.equal(frames.length, 1, "another id's frame is ignored");
    assert.equal(client.lastFrame[0].kind, "fly");
    client.receive({ kind: "view.tapped", id: 12, seq: 1, tap: [3, 4], viewport: 0, double: false });
    assert.deepEqual(taps, [[3, 4]]);
}

// 12. The background goes in view.create; inputEvent posts the event as given and returns its
// seq; view.tapped hands onTap its seq, positional and fourth.
{
    const { worker, sent } = fakeWorker();
    const taps = [];
    const client = attachViewer({ canvas: fakeCanvas(300, 150), worker, id: 16, background: [0.1, 0.1, 0.1], onTap: (...a) => taps.push(a) });
    assert.deepEqual(sent[0][0].background, [0.1, 0.1, 0.1]);
    const other = fakeWorker();
    attachViewer({ canvas: fakeCanvas(300, 150), worker: other.worker, id: 17 });
    assert.ok(!("background" in other.sent[0][0]), "none asked for: none sent");
    const event = { kind: "key", code: "KeyW", down: true };
    const s = client.inputEvent(event);
    const message = sent.at(-1)[0];
    assert.equal(message.kind, "view.input");
    assert.strictEqual(message.event, event, "the event as given");
    assert.equal(message.seq, s);
    assert.notEqual(client.inputEvent(event), s, "each its own seq");
    client.receive({ kind: "view.tapped", id: 16, seq: 7, tap: [1, 2], viewport: 0, double: false });
    assert.deepEqual(taps, [[[1, 2], 0, false, 7]]);
}

// 12. onResized(ratio) hears each view.resized (not view.ready, not another id's), and
// maxRatio caps the device ratio the client asks for, on create and on every resize.
{
    const { worker, sent } = fakeWorker();
    const heard = [];
    const client = attachViewer({ canvas: fakeCanvas(100, 100), worker, id: 18, onResized: (r) => heard.push(r) });
    client.receive({ kind: "view.ready", id: 18, backend: "webgpu", surfaces: "exact", maxDrawingSize: 4096, ratio: 2 });
    assert.deepEqual(heard, [], "view.ready is not a resize");
    client.receive({ kind: "view.resized", id: 18, width: 100, height: 100, ratio: 1.5 });
    client.receive({ kind: "view.resized", id: 99, width: 1, height: 1, ratio: 9 });
    assert.deepEqual(heard, [1.5]);
    assert.equal(client.ratio, 1.5, "the ratio is already the new one when onResized runs");
}
{
    globalThis.devicePixelRatio = 3;
    const { worker, sent } = fakeWorker();
    const canvas = fakeCanvas(100, 100);
    const client = attachViewer({ canvas, worker, id: 19, maxRatio: 2 });
    assert.equal(sent[0][0].ratio, 2, "create asks for at most maxRatio");
    globalThis.devicePixelRatio = 1;
    client.checkSize();
    assert.equal(sent.at(-1)[0].ratio, 1, "below the cap it is the device's");
    globalThis.devicePixelRatio = 2.5;
    client.checkSize();
    assert.equal(sent.at(-1)[0].ratio, 2);
    globalThis.devicePixelRatio = 2;
}

console.log("viewer-client: ok");
