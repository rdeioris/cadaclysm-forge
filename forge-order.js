// forge-order.js
// The forge applies a command asynchronously when it reads built geometry (the worker
// answers), so order is kept here: commands one after another in the order run, and the
// user's actions behind any command or action still in flight -- as the browser itself
// queued them behind the page's old synchronous builds.
//
// Errors: when nothing is in flight, command()/act() run fn at once and a synchronous throw
// reaches the caller; when queued they return a promise and a throw or rejection reaches
// the caller as a rejection. Either way the queue goes on, and every rejection is also
// logged with console.error (a caller that handles its own may see it logged twice).
//
// Nesting: a call made synchronously inside a running fn runs inline, and an async result
// it returns is awaited by the outermost call (so an act dispatched from a replayed event
// holds the order until it is done). After an await the call context is lost, so fn is
// handed a `scope` ({ command, act }) whose calls also run inline, inside the caller -- use
// it for a command that awaits another command or act (calling the order itself from there
// would queue behind its own caller: a deadlock). Use the scope only while its fn runs:
// a handle kept past that bypasses the queue and the gate.
//
// release(): drops every command/act now running (the page gave up waiting for it), clears
// busy and lets the queue -- held events included -- go on.

export function createOrder() {
    let commands = null;   // the promise of the last command in flight, or null
    let acts = null;       // the promise of the last act in flight, or null
    let depth = 0;         // > 0 while a fn is running synchronously
    let gone = deferred(); // settled by release()
    const waiters = [];
    function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
    const settle = () => {
        if (commands || acts) return;
        for (const w of waiters.splice(0)) w();
    };
    const scope = {
        command: (fn) => call(fn),
        act: (fn) => call(fn),
    };
    let children = null;   // the async results of calls nested in the fn now running (outermost only)
    const thenable = (v) => v && typeof v.then === "function";
    function call(fn) {
        const outer = depth === 0;
        const mine = outer ? (children = []) : null;
        depth++;
        let value;
        try { value = fn(scope); } finally { depth--; if (outer) children = null; }
        if (!outer) { if (children && thenable(value)) children.push(value); return value; }
        // The outermost call answers with what its nested calls started as well.
        return mine.length ? Promise.all([value, ...mine]).then(([v]) => v) : value;
    }
    // The promise `order` waits on for a running fn: its own, or release().
    const watch = (value) => Promise.race([Promise.resolve(value), gone.promise]);
    const track = (p, which) => {
        const done = Promise.resolve(p).then(() => {}, (e) => console.error(e));
        const mine = done.finally(() => {
            if (which === "c" && commands === mine) commands = null;
            if (which === "a" && acts === mine) acts = null;
            settle();
        });
        if (which === "c") commands = mine; else acts = mine;
        return mine;
    };
    return {
        get busy() { return commands !== null || acts !== null; },
        command(fn) {
            if (depth > 0) return call(fn);
            if (!commands) {
                const value = call(fn);
                if (value && typeof value.then === "function") track(watch(value), "c");
                return value;
            }
            const run = commands.then(() => watch(call(fn)));
            track(run, "c");
            return run;
        },
        act(fn) {
            if (depth > 0) return call(fn);
            if (!commands && !acts) {
                const value = call(fn);
                if (value && typeof value.then === "function") track(watch(value), "a");
                return value;
            }
            const before = Promise.all([commands, acts]);
            const run = before.then(async () => { while (commands) await commands; return watch(call(fn)); });
            track(run, "a");
            return run;
        },
        idle() { return (commands || acts) ? new Promise((r) => waiters.push(r)) : Promise.resolve(); },
        release() { const old = gone; gone = deferred(); old.resolve(); },
    };
}

// While order.busy, the page's own controls' events are held and replayed in order.
// Key events aimed at a focusable form control (input, textarea, select, button,
// [contenteditable]) are never held: a replayed key event performs no default (no typing,
// no activation), so holding one would lose it. Page-level shortcuts stay gated.
// Task 4 (F7): the "still building ..." timeout (about 10 s) that releases the gate for a
// hung build hooks in here -- on expiry call order.release(), which replays what is held.
export const TYPES = ["click", "dblclick", "change", "input", "keydown", "keyup", "contextmenu"];
const FOCUSABLE = "input,textarea,select,button,[contenteditable]";
const replayed = new WeakSet();
export function deferWhileBusy(root, order, skip) {
    let attached = true;
    const hold = (event) => {
        if (replayed.has(event) || !order.busy || skip(event)) return;
        if ((event.type === "keydown" || event.type === "keyup") && event.target?.closest?.(FOCUSABLE)) return;
        event.stopImmediatePropagation();
        if (event.type === "click" || event.type === "keydown" || event.type === "contextmenu") event.preventDefault();
        const target = event.target?.isConnected === false ? root : (event.target ?? root);
        order.act(() => {
            if (!attached) return;
            const again = new event.constructor(event.type, event);
            replayed.add(again);
            target.dispatchEvent(again);
        });
    };
    for (const type of TYPES) root.addEventListener(type, hold, true);
    return () => { attached = false; for (const type of TYPES) root.removeEventListener(type, hold, true); };
}

// The page's one undo order. The reference images are the page's alone, never in the
// document, so Ctrl+Z must still undo in the order the user acted: an image action is kept
// here with the document's head (`headOf()`, its commit id) as it stood when the action was
// done. Undo takes the last image action back when the document still stands where it did
// then -- nothing was committed after it -- and otherwise says the document's own commit is
// next (`"doc"`: the caller undoes it, on both replicas). Redo mirrors it: an image action
// undone is done again once the document is back at the head it was undone at. A commit
// drops the image redos (as it leaves the document's redo tail behind).
//
//   createUndoOrder(headOf)
//     did({ undo, redo, key })   an image action done now (the entry, returned); `key` (a merged
//                                run's) folds it into the last action of the same key at the same head
//     join(entry)                the document commit just made belongs to `entry` (one action that
//                                changed images and items): one step, undone and redone together
//     committed()                a document commit: the image redos go
//     undo(stepDoc) / redo(..)   "image" (the image action taken back / done again), "joined" (that,
//                                and the document stepped too) or "doc" (the document stepped); null
//                                when `stepDoc()` refused, and then nothing moved. `stepDoc` (the
//                                document's own undo or redo on both replicas, true when it moved)
//                                runs first, so a joined step is taken back whole or not at all
//     depth()                    how many image actions are kept
//     mark()                     a session's mark: where the image actions stood when it opened
//     since(mark)                true when an image action made since the mark is kept (on top)
//     popTo(mark)                the image actions made since `mark` taken back and forgotten, with
//                                every image redo (a tool's Cancel). Each entry is stamped `born`
//                                when it is made; those born after the mark are always on top (an
//                                action drops the redos), so an image from before the session --
//                                undone, redone or left -- is never taken back by its Cancel
//     reset()                    nothing kept (a document loaded)
export function createUndoOrder(headOf) {
    const undos = [], redos = [];   // { at, undo, redo, key, joined, born }
    let serial = 0;   // the image actions made so far: each entry's `born`
    let lastMark = 0;   // `serial` at the last mark: a merged run never folds across it
    return {
        did({ undo, redo, key = null }) {
            redos.length = 0;
            const top = undos.at(-1), at = headOf();
            // A run folds into its last step only within one session: an entry from before the
            // last mark stays as it was, so the session's Cancel takes back the session's change.
            if (key !== null && top && top.key === key && top.at === at && top.joined === undefined && top.born > lastMark) { top.redo = redo; return top; }
            const entry = { at, undo, redo, key, joined: undefined, born: ++serial };
            undos.push(entry);
            return entry;
        },
        // The entry stands for the commit too: undone where the document stands after it.
        join(entry) { if (entry && undos.at(-1) === entry) entry.joined = headOf(); },
        committed() { redos.length = 0; },
        undo(stepDoc = () => true) {
            const top = undos.at(-1);
            if (!top || (top.joined ?? top.at) !== headOf()) return stepDoc() ? "doc" : null;
            if (top.joined !== undefined && !stepDoc()) return null;
            undos.pop(); top.undo(); redos.push(top);
            return top.joined === undefined ? "image" : "joined";
        },
        redo(stepDoc = () => true) {
            const top = redos.at(-1);
            if (!top || top.at !== headOf()) return stepDoc() ? "doc" : null;
            if (top.joined !== undefined && !stepDoc()) return null;
            redos.pop(); top.redo(); undos.push(top);
            return top.joined === undefined ? "image" : "joined";
        },
        depth: () => undos.length,
        mark: () => { lastMark = serial; return { serial }; },
        since: (mark) => (undos.at(-1)?.born ?? 0) > mark.serial,
        popTo(mark) {
            redos.length = 0;
            while (undos.length && undos.at(-1).born > mark.serial) undos.pop().undo();
        },
        reset() { undos.length = 0; redos.length = 0; },
    };
}
