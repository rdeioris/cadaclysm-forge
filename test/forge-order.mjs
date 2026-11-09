import assert from "node:assert";
import { createOrder, deferWhileBusy, createUndoOrder } from "../forge-order.js";
const tick = () => new Promise((r) => setTimeout(r, 0));

// Idle: a command runs synchronously and returns its value.
{
    const o = createOrder(); const log = [];
    assert.strictEqual(o.command(() => { log.push("a"); return 1; }), 1);
    assert.deepStrictEqual(log, ["a"]);
    assert.strictEqual(o.busy, false);
}
// In flight: later commands and acts wait, in order; a rejection does not stop the queue.
{
    const o = createOrder(); const log = [];
    let release; const gate = new Promise((r) => { release = r; });
    o.command(async () => { log.push("a1"); await gate; log.push("a2"); });
    assert.strictEqual(o.busy, true);
    o.command(() => { log.push("b"); throw new Error("b fails"); });
    o.act(() => log.push("act"));
    o.command(() => log.push("c"));
    assert.deepStrictEqual(log, ["a1"]);
    release(); await o.idle();
    assert.deepStrictEqual(log, ["a1", "a2", "b", "c", "act"]);   // a queued act runs only once no command is in flight
    assert.strictEqual(o.busy, false);
}
// An async act holds later acts; a command issued inside it is not held by it.
{
    const o = createOrder(); const log = [];
    o.act(async () => { log.push("x1"); await tick(); o.command(() => log.push("cmd")); await tick(); log.push("x2"); });
    o.act(() => log.push("y"));
    await o.idle();
    assert.deepStrictEqual(log, ["x1", "cmd", "x2", "y"]);
}
// deferWhileBusy: held while busy, replayed in order, skip() passes through.
{
    const o = createOrder();
    const root = new EventTarget(); const seen = [];
    class Fake extends Event { constructor(type, init) { super(type, { bubbles: true, cancelable: true }); this.tag = init?.tag; } }
    const detach = deferWhileBusy(root, o, (e) => e.tag === "view");
    root.addEventListener("click", (e) => seen.push(e.tag));   // after the hold: Node's EventTarget has no capture phase
    let release; o.command(() => new Promise((r) => { release = r; }));
    root.dispatchEvent(new Fake("click", { tag: 1 }));
    root.dispatchEvent(new Fake("click", { tag: "view" }));
    root.dispatchEvent(new Fake("click", { tag: 2 }));
    assert.deepStrictEqual(seen, ["view"]);
    release(); await o.idle(); await tick();
    assert.deepStrictEqual(seen, ["view", 1, 2]);
    // A held contextmenu is default-prevented (no browser menu while busy).
    let release2; o.command(() => new Promise((r) => { release2 = r; }));
    const cm = new Fake("contextmenu", { tag: 3 });
    root.dispatchEvent(cm);
    assert.strictEqual(cm.defaultPrevented, true);
    release2(); await o.idle();
    detach();
}
console.log("forge-order: ok");

// ---- deferred acts ----
const quiet = async (f) => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };
// Nested through the scope inside an async command / act: no deadlock.
{
    const o = createOrder(); const log = [];
    await Promise.race([
        (async () => {
            o.command(async (s) => { await tick(); await s.command(() => log.push("inner-c")); log.push("outer-c"); });
            await o.idle();
            o.act(async (s) => { await tick(); await s.act(async () => { await tick(); log.push("inner-a"); }); log.push("outer-a"); });
            await o.idle();
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock")), 500)),
    ]);
    assert.deepStrictEqual(log, ["inner-c", "outer-c", "inner-a", "outer-a"]);
}
// Synchronous nesting inside a queued (not first) command also runs inline.
{
    const o = createOrder(); const log = [];
    let release; o.command(() => new Promise((r) => { release = r; }));
    const p = o.command(() => { const inner = o.command(() => { log.push("inner"); return 5; }); log.push("outer"); return inner; });
    release();
    assert.strictEqual(await Promise.race([p, new Promise((r) => setTimeout(() => r("deadlock"), 300))]), 5);
    assert.deepStrictEqual(log, ["inner", "outer"]);
}
// Synchronous nesting runs inline, inside the caller.
{
    const o = createOrder(); const log = [];
    o.command(() => { log.push("a1"); o.command(() => log.push("b")); o.act(() => log.push("c")); log.push("a2"); });
    assert.deepStrictEqual(log, ["a1", "b", "c", "a2"]);
}
// A queued command's result and rejection reach the caller; act is sync when idle, busy while async.
{
    const o = createOrder();
    let release; o.command(() => new Promise((r) => { release = r; }));
    const ok = o.command(() => 42);
    const bad = o.command(() => { throw new Error("nope"); });
    release();
    assert.strictEqual(await ok, 42);
    await quiet(() => assert.rejects(bad, /nope/));
    await o.idle();
    assert.strictEqual(o.act(() => 7), 7);
    let end; o.act(() => new Promise((r) => { end = r; }));
    assert.strictEqual(o.busy, true);
    end(); await o.idle();
    assert.strictEqual(o.busy, false);
    await o.idle();   // resolves at once when idle
}
// release(): a never-settling command is dropped, busy clears, queued work and held events go on.
{
    const o = createOrder(); const log = [];
    o.command(() => new Promise(() => {}));
    o.command(() => log.push("after"));
    o.act(() => log.push("act"));
    assert.strictEqual(o.busy, true);
    o.release();
    await o.idle();
    assert.deepStrictEqual(log, ["after", "act"]);
    assert.strictEqual(o.busy, false);
}
// Held events: default prevented (click, keydown), replayed in order after a command issued meanwhile (acts wait for commands),
// key events at a form control are not held, a replay to a removed node goes to root, detach() clears.
{
    const o = createOrder();
    const root = new EventTarget(); const seen = [];
    class Fake extends Event { constructor(type, init) { super(type, { bubbles: true, cancelable: true }); this.tag = init?.tag; this.fakeTarget = init?.fakeTarget; }
        get target() { return this.fakeTarget ?? super.target; } }
    const detach = deferWhileBusy(root, o, () => false);
    root.addEventListener("click", (e) => seen.push("click" + e.tag));
    root.addEventListener("keydown", (e) => seen.push("key" + e.tag));
    let release; o.command(() => new Promise((r) => { release = r; }));
    const c1 = new Fake("click", { tag: 1 }); root.dispatchEvent(c1);
    const k = new Fake("keydown", { tag: 2 }); root.dispatchEvent(k);
    o.command(() => seen.push("cmd"));
    const c3 = new Fake("click", { tag: 3 }); root.dispatchEvent(c3);
    assert.strictEqual(c1.defaultPrevented, true);
    assert.strictEqual(k.defaultPrevented, true);
    const field = { closest: (sel) => sel.includes("input") ? field : null };
    const typed = new Fake("keydown", { tag: "typed", fakeTarget: field }); root.dispatchEvent(typed);
    assert.strictEqual(typed.defaultPrevented, false);
    assert.deepStrictEqual(seen, ["keytyped"]);
    release(); await o.idle();
    assert.deepStrictEqual(seen, ["keytyped", "cmd", "click1", "key2", "click3"]);
    // a removed node: replayed at root
    seen.length = 0;
    let release2; o.command(() => new Promise((r) => { release2 = r; }));
    root.dispatchEvent(new Fake("click", { tag: "gone", fakeTarget: { isConnected: false, dispatchEvent() { seen.push("LOST"); } } }));
    release2(); await o.idle();
    assert.deepStrictEqual(seen, ["clickgone"]);
    // detach clears what is queued
    seen.length = 0;
    let release3; o.command(() => new Promise((r) => { release3 = r; }));
    root.dispatchEvent(new Fake("click", { tag: "late" }));
    detach();
    release3(); await o.idle();
    assert.deepStrictEqual(seen, []);
    root.dispatchEvent(new Fake("click", { tag: "free" }));
    assert.deepStrictEqual(seen, ["clickfree"]);
}
console.log("forge-order deferred acts: ok");

// ---- an async act started inside a sync act (a replayed event's handler) holds the order ----
{
    const o = createOrder(); const log = [];
    let release; const gate = new Promise((r) => { release = r; });
    // The outer fn is synchronous and starts an async act, as a replayed click's handler does.
    o.act(() => { o.act(async () => { log.push("inner1"); await gate; log.push("inner2"); }); });
    assert.strictEqual(o.busy, true, "the order stays busy while the nested async act runs");
    o.act(() => log.push("next"));
    await tick();
    assert.deepStrictEqual(log, ["inner1"]);
    release(); await o.idle();
    assert.deepStrictEqual(log, ["inner1", "inner2", "next"]);
    assert.strictEqual(o.busy, false);
}
// The same through the gate: a held click whose handler starts an async act holds the one behind it.
{
    const o = createOrder(); const root = new EventTarget(); const log = [];
    class Fake extends Event { constructor(type, init) { super(type, { bubbles: true, cancelable: true }); this.tag = init?.tag; } }
    deferWhileBusy(root, o, () => false);
    let releaseAll, releaseHandler;
    const handlerGate = new Promise((r) => { releaseHandler = r; });
    root.addEventListener("click", (e) => { if (e.tag === 1) o.act(async () => { log.push("h1"); await handlerGate; log.push("h1 done"); }); else log.push("h" + e.tag); });
    o.command(() => new Promise((r) => { releaseAll = r; }));
    root.dispatchEvent(new Fake("click", { tag: 1 }));
    root.dispatchEvent(new Fake("click", { tag: 2 }));
    releaseAll(); await tick(); await tick();
    assert.deepStrictEqual(log, ["h1"], "the second click waits for the first handler's async act");
    releaseHandler(); await o.idle(); await tick();
    assert.deepStrictEqual(log, ["h1", "h1 done", "h2"]);
}
console.log("forge-order nested acts: ok");

// The page's undo order: a document commit, an image added, another commit -- undone it goes
// commit, image, commit, and redone the other way round, each image step taken back and done
// again here, each commit left to the document. A merged image run is one step; an image
// action after an undo leaves no image redo; a commit drops the image redos.
{
    const commits = ["c0"];   // the document's line, the head its last
    let head = 0;
    const log = [];
    const order = createUndoOrder(() => commits[head]);
    const commit = (id) => { commits.length = head + 1; commits.push(id); head++; order.committed(); };
    const image = (name, key = null) => order.did({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`), key });
    const undo = () => { const w = order.undo(); if (w === "doc" && head > 0) { log.push(`undo ${commits[head]}`); head--; } return w; };
    const redo = () => { const w = order.redo(); if (w === "doc" && head < commits.length - 1) { head++; log.push(`redo ${commits[head]}`); } return w; };
    commit("A"); image("I"); commit("B");
    assert.deepStrictEqual([undo(), undo(), undo(), undo()], ["doc", "image", "doc", "doc"]);
    assert.deepStrictEqual(log, ["undo B", "undo I", "undo A"]);
    log.length = 0;
    assert.deepStrictEqual([redo(), redo(), redo()], ["doc", "image", "doc"]);
    assert.deepStrictEqual(log, ["redo A", "redo I", "redo B"]);
    // A merged run of one image's field: one step.
    log.length = 0;
    image("J1", "set:9"); image("J2", "set:9"); image("J3", "set:9");
    assert.strictEqual(undo(), "image");
    assert.deepStrictEqual(log, ["undo J1"], "the run is one step, taken back as it began");
    // An image action after an undo: the undone run's redo goes.
    log.length = 0;
    image("K");
    assert.deepStrictEqual([undo(), redo(), redo()], ["image", "image", "doc"]);
    assert.deepStrictEqual(log, ["undo K", "redo K"], "the run undone before K is not redone");
    // A commit drops the image redos.
    log.length = 0;
    image("L"); undo(); commit("C");
    assert.strictEqual(redo(), "doc");
    assert.ok(!log.includes("redo L"));
}
// One action that changed images and items (a delete of both) is one step: its image entry
// joined to the commit it made, undone and redone with it. A Cancel takes the image actions
// of its session back (`popTo`) and forgets them.
{
    const commits = ["c0"];
    let head = 0;
    const log = [];
    const order = createUndoOrder(() => commits[head]);
    const commit = (id) => { commits.length = head + 1; commits.push(id); head++; order.committed(); };
    const image = (name) => order.did({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`) });
    const step = (w, dir) => {
        if (w === "image") return;
        if (dir === "undo" && head > 0) { log.push(`undo ${commits[head]}`); head--; }
        if (dir === "redo" && head < commits.length - 1) { head++; log.push(`redo ${commits[head]}`); }
    };
    const undo = () => { const w = order.undo(); step(w, "undo"); return w; };
    const redo = () => { const w = order.redo(); step(w, "redo"); return w; };
    commit("A");
    const both = image("D");   // the images' share of a delete...
    commit("B"); order.join(both);   // ...and its commit
    assert.deepStrictEqual([undo(), undo()], ["joined", "doc"]);
    assert.deepStrictEqual(log, ["undo D", "undo B", "undo A"], "one undo takes the whole delete back");
    log.length = 0;
    assert.deepStrictEqual([redo(), redo()], ["doc", "joined"]);
    assert.deepStrictEqual(log, ["redo A", "redo D", "redo B"], "and one redo does it again");
    // A session opened at depth 1: two images in it, then Cancel.
    log.length = 0;
    const depth = order.depth(), mark = order.mark();
    image("E"); image("F");
    assert.strictEqual(order.since(mark), true);
    order.popTo(mark);
    assert.deepStrictEqual(log, ["undo F", "undo E"]);
    assert.strictEqual(order.depth(), depth);
    assert.strictEqual(order.redo(), "doc", "nothing of the session to redo");
}
// A joined step is atomic: the document steps first (`stepDoc`), and only when it moved are
// the images taken back and the entry moved. A refused step leaves everything as it was.
{
    const commits = ["c0"];
    let head = 0, refuse = false;
    const log = [];
    const order = createUndoOrder(() => commits[head]);
    const commit = (id) => { commits.length = head + 1; commits.push(id); head++; order.committed(); };
    const image = (name) => order.did({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`) });
    const stepUndo = () => { if (refuse || head === 0) return false; log.push(`undo ${commits[head]}`); head--; return true; };
    const stepRedo = () => { if (refuse || head === commits.length - 1) return false; head++; log.push(`redo ${commits[head]}`); return true; };
    commit("A");
    const both = image("D"); commit("B"); order.join(both);
    refuse = true;
    assert.strictEqual(order.undo(stepUndo), null, "a refused document undo refuses the joined step");
    assert.deepStrictEqual(log, [], "the images stay where they were");
    assert.strictEqual(order.depth(), 1, "and the entry stays");
    refuse = false;
    assert.strictEqual(order.undo(stepUndo), "joined");
    assert.deepStrictEqual(log, ["undo B", "undo D"], "the commit first, then the images");
    log.length = 0;
    refuse = true;
    assert.strictEqual(order.redo(stepRedo), null, "a refused document redo refuses the joined step");
    assert.deepStrictEqual(log, []);
    refuse = false;
    assert.strictEqual(order.redo(stepRedo), "joined");
    assert.deepStrictEqual(log, ["redo B", "redo D"]);
    assert.strictEqual(order.depth(), 1);
    // A plain document step refused: null, nothing moved.
    refuse = true;
    assert.strictEqual(order.redo(stepRedo), null);
}
// A session's Cancel (`popTo(mark)`) takes back exactly the image actions born in the
// session: those made after an undo of an image from before it too, and never an image from
// before it that the session undid and redid.
{
    const log = [];
    const order = createUndoOrder(() => "c0");
    const image = (name) => order.did({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`) });
    image("A"); image("B");
    const mark = order.mark();   // the session opens with A and B
    assert.strictEqual(order.since(mark), false);
    assert.strictEqual(order.undo(), "image");   // B, older than the session, taken back in it
    image("E"); image("F");
    log.length = 0;
    order.popTo(mark);
    assert.deepStrictEqual(log, ["undo F", "undo E"], "every image of the session is taken back");
    assert.strictEqual(order.depth(), 1);
    assert.strictEqual(order.redo(), "doc", "and forgotten, B's redo with them");
}
// A probe: B from before the session undone and redone in it, then Cancel --
// nothing of the session to take back, B kept.
{
    const log = [];
    const order = createUndoOrder(() => "c0");
    const image = (name) => order.did({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`) });
    image("A"); image("B");
    const mark = order.mark();
    order.undo(); order.redo();   // B taken back and done again inside the session
    log.length = 0;
    assert.strictEqual(order.since(mark), false, "a redo of an image from before the session is not the session's");
    order.popTo(mark);
    assert.deepStrictEqual(log, [], "Cancel takes back no image from before the session");
    assert.strictEqual(order.depth(), 2);
    // An image of the session after that redo is taken back alone.
    image("G");
    assert.strictEqual(order.since(mark), true);
    order.popTo(mark);
    assert.deepStrictEqual(log, ["undo G"]);
    assert.strictEqual(order.depth(), 2);
}
// A merged image run does not fold across a session's mark: a change of the same image and
// field made in a session opened with no commit is its own entry, which Cancel takes back.
{
    const log = [];
    const order = createUndoOrder(() => "c0");
    const step = (name) => order.did({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`), key: "set:9" });
    step("J1");
    const mark = order.mark();
    step("J2");   // the same run's key, at the same head, inside the session
    assert.strictEqual(order.depth(), 2, "the session's change is an entry of its own");
    order.popTo(mark);
    assert.deepStrictEqual(log, ["undo J2"], "Cancel takes back the session's change alone");
    // Within the session, a run still folds.
    const m2 = order.mark();
    step("K1"); step("K2");
    assert.strictEqual(order.depth(), 2);
    order.popTo(m2);
    assert.deepStrictEqual(log, ["undo J2", "undo K1"]);
}
console.log("forge-order undo order: ok");
