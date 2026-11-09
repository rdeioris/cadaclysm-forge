// The worker-side host: it owns a page's View instances (drawing OffscreenCanvases) and
// answers a message protocol, with no knowledge of solids, scenes or any page. Checked here
// against a fake View class and a schedule() the test steps by hand -- no wasm, no worker.
//
// Run: node test/viewer-host.mjs
import assert from "node:assert/strict";
import { createViewerHost } from "../viewer-host.js";

// A fake View: records every call, answers pick() with whatever the test set, and lets a
// test make create() throw to exercise view.failed, or hold create() open (FakeViewer.gate)
// to exercise messages that arrive before it resolves.
let created = [];
class FakeViewer {
    static async create(canvas, options) {
        if (FakeViewer.failWith) throw new Error(FakeViewer.failWith);
        if (FakeViewer.gate) await FakeViewer.gate;
        const v = new FakeViewer(canvas, options);
        created.push(v);
        return v;
    }
    constructor(canvas, options) {
        this.canvas = canvas;
        this.options = options;
        this.calls = [];
        this._onError = null;
        this.backend = "webgpu";
        this.surfaces = options.surfaces ?? "exact";
        this.maxDrawingSize = 4096;
        this._pick = null;
        this.draws = 0;
        this.flying = false;
        this.navigation = "orbit";
        this.lighting = "headlight";
        // View::is_dirty: whether an input moved anything. A test sets it; draw() clears it.
        this.needsDraw = false;
        // View::wake_in().is_some(): a resting frame (the "smooth" policy) is coming.
        this.restPending = false;
        this.inputAnswer = undefined;
    }
    resize(w, h, r) { this.calls.push(["resize", w, h, r]); }
    orbit(dx, dy) { this.calls.push(["orbit", dx, dy]); }
    pan(dx, dy) { this.calls.push(["pan", dx, dy]); }
    zoom(steps) { this.calls.push(["zoom", steps]); }
    dolly(ratio) { this.calls.push(["dolly", ratio]); }
    look(dx, dy) { this.calls.push(["look", dx, dy]); }
    key(code, down) { this.calls.push(["key", code, down]); }
    clearKeys() { this.calls.push(["clearKeys"]); }
    frame(item, node) { this.calls.push(["frame", item, node]); return true; }
    setVisible(layer, on) { this.calls.push(["setVisible", layer, on]); }
    setNodeHighlights(item, nodes, tint) { this.calls.push(["setNodeHighlights", item, nodes, tint]); }
    setSurfaces(mode) { this.calls.push(["setSurfaces", mode]); this.surfaces = mode; }
    onError(cb) { this._onError = cb; }
    draw() { this.calls.push(["draw"]); this.draws += 1; this.needsDraw = false; }
    input(e) { this.calls.push(["input", e]); return this.inputAnswer; }
    failing() { throw new Error("boom"); }
    trapping() { throw new WebAssembly.RuntimeError("x"); }
    start() { this.calls.push(["start"]); }
    stop() { this.calls.push(["stop"]); }
    free() { this.calls.push(["free"]); }
    pick(viewport, x, y) {
        this.calls.push(["pick", viewport, x, y]);
        return Promise.resolve(this._pick ?? null);
    }
}

function fakeSchedule() {
    const queue = [];
    const schedule = (fn) => queue.push(fn);
    // Runs every function queued so far (a "frame"); functions queued while running are a
    // later frame's, matching requestAnimationFrame's own one-shot semantics.
    const frame = () => { const fns = queue.splice(0, queue.length); for (const fn of fns) fn(); };
    return { schedule, frame, get pending() { return queue.length; } };
}

// The host sets width/height on the transferred canvas itself (the OffscreenCanvas's
// backing size); a plain object stands in for it.
function fakeCanvas() { return {}; }

// A promise a test resolves by hand, to hold FakeViewer.create open and send messages
// while it is still pending.
function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function harness() {
    created = [];
    const posted = [];
    const post = (message, transfer) => posted.push([message, transfer]);
    const sched = fakeSchedule();
    const host = createViewerHost({ View: FakeViewer, post, now: () => 0, schedule: sched.schedule });
    return { host, posted, sched, viewerAt: (i) => created[i] };
}

// 1. view.create creates with { surfaces, backend } and posts view.ready with the fake's
// backend/surfaces/maxDrawingSize/ratio (the effective drawingRatio it used); a throwing
// create posts view.failed with its message.
{
    const { host, posted, viewerAt } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 2, surfaces: "triangles", backend: "webgl2" });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    assert.equal(v.options.surfaces, "triangles");
    assert.equal(v.options.backend, "webgl2");
    assert.ok(!("background" in v.options), "none given: none passed");
    assert.deepEqual(posted.at(-1)[0], { kind: "view.ready", id: 1, backend: "webgpu", surfaces: "triangles", maxDrawingSize: 4096, ratio: 2 });
    assert.equal(host.views.get(1), v, "views maps id -> View");
}
{
    const { host, viewerAt } = harness();
    host.handle({ kind: "view.create", id: 3, canvas: fakeCanvas(), width: 100, height: 100, ratio: 1, background: [0.1, 0.2, 0.3] });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(viewerAt(0).options.background, [0.1, 0.2, 0.3], "view.create's background reaches View.create");
}
{
    FakeViewer.failWith = "no WebGPU or WebGL2 in this browser";
    const { host, posted } = harness();
    host.handle({ kind: "view.create", id: 2, canvas: fakeCanvas(), width: 100, height: 100, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(posted.at(-1)[0], { kind: "view.failed", id: 2, message: "no WebGPU or WebGL2 in this browser" });
    assert.equal(host.views.has(2), false);
    FakeViewer.failWith = null;
}

// 2. A call by name reaches the View and answers; the view redraws after it. Names off
// the allow-list are refused, naming the name; a throwing call becomes view.error; input
// reaches viewer.input and a pick it returns answers as view.picked; while the View is
// flying, the host keeps drawing.
{
    const { host, posted, sched } = harness();
    const step = () => sched.frame();
    const last = (list) => list.at(-1);
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    // A call by name reaches the View and answers; the view redraws after it.
    host.handle({ kind: "view.call", id: 1, seq: 5, name: "orbit", args: [3, 4] });
    assert.deepEqual(last(created).calls.at(-1), ["orbit", 3, 4]);
    assert.deepEqual(posted.at(-1)[0], { kind: "view.result", id: 1, seq: 5, value: undefined });
    step(); assert.equal(last(created).draws, 1, "a call redraws");
    // Names off the allow-list are refused, naming the name; nothing is called.
    const before = last(created).calls.length;
    for (const name of ["free", "constructor", "__proto__", "nope", "createSomething"]) {
        host.handle({ kind: "view.call", id: 1, seq: 6, name, args: [] });
        assert.equal(posted.at(-1)[0].kind, "view.error"); assert.match(posted.at(-1)[0].message, new RegExp(name.replace(/_/g, "\\_")));
    }
    assert.equal(last(created).calls.length, before, "a refused name calls nothing");
    // View methods the host keeps to itself are refused by name, each on its own: onError
    // (the host's relay), resize (view.resize's cap and backing size), start/stop (a second
    // loop), pick and input (their own messages).
    const refused = (name, args) => {
        const count = last(created).calls.length;
        host.handle({ kind: "view.call", id: 1, seq: 11, name, args });
        assert.deepEqual(posted.at(-1)[0], { kind: "view.error", id: 1, seq: 11, message: `view.call: ${name} is not a View method this bridge calls` }, `${name} is refused`);
        assert.equal(last(created).calls.length, count, `a refused ${name} reaches nothing`);
    };
    const relay = last(created)._onError;
    refused("onError", [null]);
    assert.equal(last(created)._onError, relay, "the host's error relay stays");
    refused("resize", [10, 10, 1]);
    refused("start", []);
    refused("stop", []);
    refused("pick", [0, 1, 2]);
    refused("input", [{ kind: "up" }]);
    // A throwing call becomes view.error.
    host.handle({ kind: "view.call", id: 1, seq: 7, name: "failing", args: [] });
    assert.deepEqual(posted.at(-1)[0], { kind: "view.error", id: 1, seq: 7, message: "boom" });
    // The getters a page reads through view.call (a getter is no method): navigation and
    // flying answer their value, and a read marks nothing to draw.
    step();
    {
        const v = last(created);
        const draws = v.draws;
        host.handle({ kind: "view.call", id: 1, seq: 12, name: "navigation", args: [] });
        assert.deepEqual(posted.at(-1)[0], { kind: "view.result", id: 1, seq: 12, value: "orbit" });
        v.navigation = "fly";
        host.handle({ kind: "view.call", id: 1, seq: 13, name: "navigation", args: [] });
        assert.deepEqual(posted.at(-1)[0], { kind: "view.result", id: 1, seq: 13, value: "fly" });
        host.handle({ kind: "view.call", id: 1, seq: 14, name: "flying", args: [] });
        assert.deepEqual(posted.at(-1)[0], { kind: "view.result", id: 1, seq: 14, value: false });
        v.lighting = "showroom";
        host.handle({ kind: "view.call", id: 1, seq: 15, name: "lighting", args: [] });
        assert.deepEqual(posted.at(-1)[0], { kind: "view.result", id: 1, seq: 15, value: "showroom" });
        step(); step();
        assert.equal(v.draws, draws, "a read draws nothing");
        v.navigation = "orbit";
    }
    // Input reaches viewer.input; a pick it returns answers as view.picked.
    last(created).inputAnswer = Promise.resolve({ item: 1, node: 2, face: 3 });
    host.handle({ kind: "view.input", id: 1, seq: 8, event: { kind: "up" } });
    assert.deepEqual(last(created).calls.at(-1), ["input", { kind: "up" }]);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(posted.at(-1)[0], { kind: "view.picked", id: 1, seq: 8, hit: { item: 1, node: 2, face: 3 } });
    // A rejected pick is no pick (view.picked with null), not an unhandled rejection.
    last(created).inputAnswer = Promise.reject(new Error("lost"));
    host.handle({ kind: "view.input", id: 1, seq: 10, event: { kind: "up" } });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(posted.at(-1)[0], { kind: "view.picked", id: 1, seq: 10, hit: null });
    last(created).inputAnswer = undefined;
    // While the View is flying, the host keeps drawing.
    last(created).flying = true; host.handle({ kind: "view.input", id: 1, seq: 9, event: { kind: "key" } });
    step(); step(); assert.ok(last(created).draws >= 3, "draws continue while flying");
    assert.equal(sched.pending, 1, "still flying: another frame is scheduled");
    last(created).flying = false; step();
    assert.equal(sched.pending, 0, "landed: nothing left scheduled");
}

// 2b. An input draws only when the View says it needs a draw: a hover that moved
// nothing (needsDraw false) draws nothing, one that moved the camera draws once. A pick
// settling asks for a frame too, drawn only if the View needs it (a double tap's frame).
{
    const { host, sched } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = created.at(-1);
    sched.frame();
    assert.equal(v.draws, 1, "the view draws once after it is created");
    const hover = { kind: "move", pointerId: 1, pointer: "mouse", x: 5, y: 5 };
    for (let i = 0; i < 3; i += 1) { host.handle({ kind: "view.input", id: 1, seq: 20 + i, event: hover }); sched.frame(); }
    assert.equal(v.draws, 1, "a hover that moved nothing draws nothing");
    assert.equal(sched.pending, 0);
    v.needsDraw = true;
    host.handle({ kind: "view.input", id: 1, seq: 30, event: hover });
    host.handle({ kind: "view.input", id: 1, seq: 31, event: hover });
    sched.frame();
    assert.equal(v.draws, 2, "an input that moved the camera draws, once");
    assert.equal(sched.pending, 0, "not flying: nothing scheduled after the draw");
    v.inputAnswer = Promise.resolve(null);
    host.handle({ kind: "view.input", id: 1, seq: 32, event: { kind: "up" } });
    sched.frame();
    assert.equal(v.draws, 2, "the tap itself moved nothing");
    v.needsDraw = true; // the double tap's frame, applied once the pick answers
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    sched.frame();
    assert.equal(v.draws, 3, "the pick settling draws what it framed");
}

// 3. However many calls land before a frame, the view draws once; a value a call returns
// comes back in view.result.
{
    const { host, posted, sched, viewerAt } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    v.calls = [];
    v.draws = 0;
    host.handle({ kind: "view.call", id: 1, seq: 1, name: "pan", args: [1, 2] });
    host.handle({ kind: "view.call", id: 1, seq: 2, name: "frame", args: [7, 8] });
    host.handle({ kind: "view.call", id: 1, seq: 3, name: "setNodeHighlights", args: [9, [1, 2], [1, 0, 0, 1]] });
    assert.deepEqual(posted.at(-2)[0], { kind: "view.result", id: 1, seq: 2, value: true }, "frame's boolean comes back");
    assert.equal(sched.pending, 1, "one frame scheduled for every call above");
    sched.frame();
    assert.equal(v.draws, 1, "exactly one draw");
    assert.deepEqual(v.calls.filter(([k]) => k !== "draw"), [["pan", 1, 2], ["frame", 7, 8], ["setNodeHighlights", 9, [1, 2], [1, 0, 0, 1]]]);
    assert.equal(sched.pending, 0, "not flying: nothing scheduled after the draw");
}

// 3b. A value postMessage cannot clone (a wasm object, say) still answers: view.result,
// without its value.
{
    created = [];
    const posted = [];
    const post = (message) => {
        if (message.kind === "view.result" && message.value !== undefined) throw new Error("DataCloneError");
        posted.push([message]);
    };
    const sched = fakeSchedule();
    const host = createViewerHost({ View: FakeViewer, post, now: () => 0, schedule: sched.schedule });
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    host.handle({ kind: "view.call", id: 1, seq: 4, name: "frame", args: [1, 2] });
    assert.deepEqual(posted.at(-1)[0], { kind: "view.result", id: 1, seq: 4, value: undefined });
}

// 4. view.pick posts view.picked with the same seq and the fake's hit.
{
    const { host, posted, viewerAt } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    v._pick = { item: 5, face: 2 };
    host.handle({ kind: "view.pick", id: 1, seq: 42, viewport: 0, x: 10, y: 20 });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(v.calls.find(([k]) => k === "pick"), ["pick", 0, 10, 20]);
    assert.deepEqual(posted.at(-1)[0], { kind: "view.picked", id: 1, seq: 42, hit: { item: 5, face: 2 } });
}

// 5. The View's onError callback posts view.error.
{
    const { host, posted, viewerAt } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    v._onError("device lost");
    assert.deepEqual(posted.at(-1)[0], { kind: "view.error", id: 1, message: "device lost" });
}

// 6. view.free calls the View's free() and forgets the id; later messages for it are
// ignored.
{
    const { host, sched, viewerAt } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    sched.frame(); // the create's own first draw
    host.handle({ kind: "view.free", id: 1 });
    assert.deepEqual(v.calls.at(-1), ["free"]);
    assert.equal(host.views.has(1), false);
    v.calls = [];
    host.handle({ kind: "view.call", id: 1, seq: 1, name: "orbit", args: [1, 1] });
    assert.equal(sched.pending, 0, "no frame scheduled for a freed id");
    assert.equal(v.calls.length, 0, "no calls reach the freed viewer");
}

// 7. view.create caps the ratio to the fake's maxDrawingSize (4096) and sets the
// transferred canvas's backing size to match exactly what resize() is told.
{
    const { host, viewerAt } = harness();
    const canvas = fakeCanvas();
    host.handle({ kind: "view.create", id: 1, canvas, width: 10000, height: 2000, ratio: 2 });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    const resize = v.calls.find(([k]) => k === "resize");
    const expectedRatio = Math.min(2, 4096 / 10000, 4096 / 2000); // 0.4096
    assert.equal(resize[1], 10000, "resize still gets the CSS width");
    assert.equal(resize[2], 2000, "resize still gets the CSS height");
    assert.ok(Math.abs(resize[3] - expectedRatio) < 1e-9, `ratio fits maxDrawingSize: got ${resize[3]}`);
    assert.equal(canvas.width, 4096, "the canvas's backing width is capped to maxDrawingSize");
    assert.equal(canvas.height, 819, "the canvas's backing height uses the same capped ratio");
}

// 8. A later view.resize caps its ratio the same way, updates the canvas's backing
// size again, and posts view.resized with the same effective ratio.
{
    const { host, posted, viewerAt } = harness();
    const canvas = fakeCanvas();
    host.handle({ kind: "view.create", id: 1, canvas, width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    v.calls = [];
    host.handle({ kind: "view.resize", id: 1, width: 10000, height: 2000, ratio: 2 });
    const resize = v.calls.find(([k]) => k === "resize");
    const expectedRatio = Math.min(2, 4096 / 10000, 4096 / 2000);
    assert.ok(Math.abs(resize[3] - expectedRatio) < 1e-9);
    assert.equal(canvas.width, 4096);
    assert.deepEqual(posted.at(-1)[0], { kind: "view.resized", id: 1, width: 10000, height: 2000, ratio: expectedRatio });
    assert.equal(canvas.height, 819);
}

// 9. Messages sent while view.create is still pending are not dropped: a resize folds
// into the size create() ends up using (the latest one wins), and everything else queues
// and replays in order once the View exists.
{
    const gate = deferred();
    FakeViewer.gate = gate.promise;
    const { host, posted, viewerAt } = harness();
    const canvas = fakeCanvas();
    host.handle({ kind: "view.create", id: 1, canvas, width: 300, height: 150, ratio: 1 });
    host.handle({ kind: "view.call", id: 1, seq: 1, name: "orbit", args: [3, 4] });
    host.handle({ kind: "view.resize", id: 1, width: 800, height: 600, ratio: 1 });
    host.handle({ kind: "view.input", id: 1, seq: 2, event: { kind: "wheel", deltaY: -120 } });
    assert.equal(created.length, 0, "the View has not been made yet");
    gate.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    assert.deepEqual(v.calls.map(([k]) => k), ["resize", "orbit", "input"], "the fold-in resize runs first (as part of create), then the queue in order");
    const resize = v.calls[0];
    assert.equal(resize[1], 800, "the View ends at the last width seen while pending");
    assert.equal(resize[2], 600, "the View ends at the last height seen while pending");
    assert.deepEqual(v.calls[1], ["orbit", 3, 4]);
    assert.deepEqual(v.calls[2], ["input", { kind: "wheel", deltaY: -120 }]);
    assert.deepEqual(posted.map(([m]) => m.kind), ["view.ready", "view.result"], "the replayed call answers after view.ready");
    FakeViewer.gate = null;
}

// 10. A view.free while create() is still pending frees the View the moment it exists,
// with no resize and no draw, and posts no view.ready.
{
    const gate = deferred();
    FakeViewer.gate = gate.promise;
    const { host, posted, viewerAt } = harness();
    const canvas = fakeCanvas();
    host.handle({ kind: "view.create", id: 1, canvas, width: 300, height: 150, ratio: 1 });
    host.handle({ kind: "view.free", id: 1 });
    gate.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const v = viewerAt(0);
    assert.deepEqual(v.calls, [["free"]], "freed as soon as it exists, before any resize or draw");
    assert.equal(posted.some(([m]) => m.kind === "view.ready"), false, "no view.ready for a view freed before it existed");
    assert.equal(host.views.has(1), false);
    FakeViewer.gate = null;
}

// 11. A playing timeline keeps getting frames: needsDraw true after a draw (the clock is
// still running, not just the one input that triggered it) means the host reschedules on
// its own, with nothing dirty and not flying. It stops once needsDraw goes false.
{
    const { host, sched } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = created.at(-1);
    sched.frame();
    assert.equal(v.draws, 1, "the view draws once after it is created");
    // Simulate a playing timeline: draw() no longer clears needsDraw on its own, the way a
    // real View's draw() leaves needsDraw true while `viewer.timeline.playing`.
    v.needsDraw = true;
    v.draw = function () { this.calls.push(["draw"]); this.draws += 1; };
    host.handle({ kind: "view.input", id: 1, seq: 40, event: { kind: "move", pointerId: 1, pointer: "mouse", x: 0, y: 0 } });
    sched.frame();
    assert.equal(v.draws, 2, "the input's own frame draws");
    sched.frame();
    assert.equal(v.draws, 3, "needsDraw still true: the host rescheduled itself");
    sched.frame();
    assert.equal(v.draws, 4, "and keeps going while needsDraw stays true");
    v.needsDraw = false;
    sched.frame();
    assert.equal(v.draws, 4, "needsDraw false and nothing dirty, not flying: it stops");
    assert.equal(sched.pending, 0, "nothing left scheduled");
}

// 11b. A resting frame pending (Smooth, the camera just stopped): with nothing dirty the
// host keeps scheduling frames, drawing none, until needsDraw says the rest is due -- then
// draws it -- and stops once nothing is pending.
{
    const { host, sched } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = created.at(-1);
    sched.frame();
    assert.equal(v.draws, 1, "the view draws once after it is created");
    v.restPending = true;
    host.handle({ kind: "view.input", id: 1, seq: 41, event: { kind: "move", pointerId: 1, pointer: "mouse", x: 0, y: 0 } });
    v.needsDraw = true;
    sched.frame();
    assert.equal(v.draws, 2, "the input's own frame");
    sched.frame();
    sched.frame();
    assert.equal(v.draws, 2, "waiting for the rest draws nothing");
    assert.equal(sched.pending, 1, "but keeps a frame scheduled");
    v.needsDraw = true; // the rest fell due
    v.restPending = false;
    sched.frame();
    assert.equal(v.draws, 3, "the resting frame");
    sched.frame();
    assert.equal(sched.pending, 0, "nothing pending: it stops");
}

// 11c. The rest goes away while still waited on (a paced draw consumed it, or the policy
// was turned off) without needsDraw ever going true: the early-return branch must itself
// stop rescheduling once restPending drops, not rely on the draw branch running first --
// an unconditional reschedule there (as in break (b)) would keep this scheduled forever.
{
    const { host, sched } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = created.at(-1);
    sched.frame();
    assert.equal(v.draws, 1, "the view draws once after it is created");
    v.restPending = true;
    host.handle({ kind: "view.input", id: 1, seq: 42, event: { kind: "move", pointerId: 1, pointer: "mouse", x: 0, y: 0 } });
    v.needsDraw = true;
    sched.frame();
    assert.equal(v.draws, 2, "the input's own frame");
    sched.frame();
    assert.equal(v.draws, 2, "waiting for the rest draws nothing");
    assert.equal(sched.pending, 1, "a frame stays scheduled while restPending is true");
    v.restPending = false; // the rest went away -- needsDraw never goes true
    sched.frame();
    assert.equal(v.draws, 2, "still no draw: nothing dirty, not flying, needsDraw false");
    assert.equal(sched.pending, 0, "restPending false too: it stops, not scheduled forever");
}

// 12. markDirty(id): a worker that changes its own hosted View directly (outside
// view.call) schedules that view's next draw the same way a dispatched message does -- one
// draw, however many direct changes landed before it -- and is a no-op for an id with no
// View (never created, still pending, or freed).
{
    const { host, sched } = harness();
    host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    const v = created.at(-1);
    sched.frame(); // the create's own first draw
    assert.equal(v.draws, 1);
    v.calls.push(["showScene", "direct"]); // stands in for a worker's own viewer.showScene(...) etc.
    host.markDirty(1);
    host.markDirty(1); // a second direct change before the frame still draws only once
    assert.equal(sched.pending, 1, "one frame scheduled");
    sched.frame();
    assert.equal(v.draws, 2, "exactly one draw for both direct changes");
    assert.equal(sched.pending, 0);
    // No id at all, a still-pending id, and a freed id: all quietly do nothing.
    host.markDirty(999);
    assert.equal(sched.pending, 0, "unknown id: no-op");
    host.handle({ kind: "view.free", id: 1 });
    host.markDirty(1);
    assert.equal(sched.pending, 0, "freed id: no-op");
}

// 13. onTrap: a WebAssembly.RuntimeError from any View call the host makes goes to
// onTrap(error, id), never a view.error/view.failed and never out of handle(). Without
// onTrap, the same traps behave as any error does (view.error, view.failed, a throw).
{
    const trap = () => { throw new WebAssembly.RuntimeError("x"); };
    const make = (onTrap) => {
        created = [];
        const posted = [], traps = [];
        const sched = fakeSchedule();
        const host = createViewerHost({ View: FakeViewer, post: (m) => posted.push(m), now: () => 0, schedule: sched.schedule,
            onTrap: onTrap ? (e, id) => traps.push([e.message, id]) : undefined });
        return { host, posted, traps, sched };
    };
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

    // With onTrap: every entry point.
    {
        const { host, posted, traps, sched } = make(true);
        host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
        await settle();
        const v = created.at(-1);
        posted.length = 0;
        host.handle({ kind: "view.call", id: 1, seq: 1, name: "trapping", args: [] });
        v.setSurfaces = () => Promise.reject(new WebAssembly.RuntimeError("x"));
        host.handle({ kind: "view.call", id: 1, seq: 2, name: "setSurfaces", args: ["exact"] });
        v.input = trap;
        host.handle({ kind: "view.input", id: 1, seq: 3, event: {} });
        v.input = () => Promise.reject(new WebAssembly.RuntimeError("x"));
        host.handle({ kind: "view.input", id: 1, seq: 4, event: {} });
        v.pick = trap;
        host.handle({ kind: "view.pick", id: 1, seq: 5, viewport: 0, x: 0, y: 0 });
        v.resize = trap;
        host.handle({ kind: "view.resize", id: 1, width: 10, height: 10, ratio: 1 });
        await settle();
        v.draw = trap;
        sched.frame();
        v.free = trap;
        host.handle({ kind: "view.free", id: 1 });
        assert.equal(traps.length, 8, `every trap reached onTrap: ${JSON.stringify(traps)}`);
        assert.ok(traps.every(([m, id]) => m === "x" && id === 1));
        assert.deepEqual(posted.filter((m) => m.kind === "view.error" || m.kind === "view.picked"), [], "no view.error, no view.picked for a trap");
        // A trap inside create itself.
        const saved = FakeViewer.create;
        FakeViewer.create = async () => { throw new WebAssembly.RuntimeError("x"); };
        try {
            host.handle({ kind: "view.create", id: 2, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
            await settle();
        } finally { FakeViewer.create = saved; }
        assert.deepEqual(traps.at(-1), ["x", 2]);
        assert.ok(!posted.some((m) => m.kind === "view.failed"), "no view.failed for a trapped create");
    }

    // Without onTrap: as before -- view.error, view.failed, a throw out of handle.
    {
        const { host, posted, sched } = make(false);
        host.handle({ kind: "view.create", id: 1, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
        await settle();
        const v = created.at(-1);
        host.handle({ kind: "view.call", id: 1, seq: 1, name: "trapping", args: [] });
        assert.deepEqual(posted.at(-1), { kind: "view.error", id: 1, seq: 1, message: "x" });
        v.resize = trap;
        assert.throws(() => host.handle({ kind: "view.resize", id: 1, width: 10, height: 10, ratio: 1 }), WebAssembly.RuntimeError);
        v.draw = trap;
        v.needsDraw = true;
        assert.throws(() => sched.frame(), WebAssembly.RuntimeError);
        const saved = FakeViewer.create;
        FakeViewer.create = async () => { throw new WebAssembly.RuntimeError("x"); };
        try {
            host.handle({ kind: "view.create", id: 2, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
            await settle();
        } finally { FakeViewer.create = saved; }
        assert.deepEqual(posted.at(-1), { kind: "view.failed", id: 2, message: "x" });
    }
}

// 14. Every drawn frame posts view.frame with the View's frameReport(); a frame not drawn
// (nothing changed) posts nothing; a View without frameReport posts no view.frame.
{
    class Reporting extends FakeViewer {
        static async create(canvas, options) {
            const v = new Reporting(canvas, options);
            created.push(v);
            return v;
        }
        frameReport() { return [{ rect: [0, 0, 300, 150], view: new Float32Array(16), projection: new Float32Array(16), eye: [1, 2, 3], kind: "orbit" }]; }
    }
    const posted = [];
    const sched = fakeSchedule();
    created = [];
    const host = createViewerHost({ View: Reporting, post: (m) => posted.push(m), now: () => 0, schedule: sched.schedule });
    host.handle({ kind: "view.create", id: 3, canvas: fakeCanvas(), width: 300, height: 150, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    // A resting frame pending keeps the host asking for frames after the draw, so the next
    // frame really runs drawFrame and takes its early return.
    const viewer = created.at(-1);
    viewer.restPending = true;
    sched.frame();
    const frames = posted.filter((m) => m.kind === "view.frame");
    assert.equal(frames.length, 1, "one draw, one view.frame");
    assert.equal(frames[0].id, 3);
    assert.deepEqual(frames[0].viewports[0].eye, [1, 2, 3]);
    // A frame that returns early (a resting frame pending, nothing due) draws and posts nothing.
    assert.equal(sched.pending, 1, "a frame is queued");
    sched.frame();
    assert.equal(sched.pending, 1, "the early-return path ran and kept asking for frames");
    assert.equal(viewer.draws, 1, "nothing was drawn");
    assert.equal(posted.filter((m) => m.kind === "view.frame").length, 1, "nothing drawn, nothing posted");
    viewer.restPending = false;
}
{
    const { host, posted, sched } = harness();
    host.handle({ kind: "view.create", id: 4, canvas: fakeCanvas(), width: 10, height: 10, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    sched.frame();
    assert.equal(posted.filter(([m]) => m.kind === "view.frame").length, 0, "a View without frameReport posts none");
}

// 15. A tap the View reports without picking (setPickOnTap(false)) posts view.tapped.
{
    const { host, posted } = harness();
    host.handle({ kind: "view.create", id: 5, canvas: fakeCanvas(), width: 10, height: 10, ratio: 1 });
    await Promise.resolve(); await Promise.resolve();
    created.at(-1).inputAnswer = { tap: [1, 2], viewport: 0, double: false };
    host.handle({ kind: "view.input", id: 5, seq: 11, event: { kind: "up" } });
    assert.deepEqual(posted.filter(([m]) => m.kind === "view.tapped").map(([m]) => m),
        [{ kind: "view.tapped", id: 5, seq: 11, tap: [1, 2], viewport: 0, double: false }]);
}

console.log("viewer-host: ok");
