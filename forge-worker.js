// The forge worker builds the bodies -- sketch-derived and made -- off the page's thread,
// so a kernel operation of seconds cannot freeze the page, and reports how far it is. It
// holds its own replica of the forge document and evaluates it in full; the page's replica
// evaluates the cheap kinds only. It also hosts the forge's View (viewer-host.js) on the
// canvas the page transfers, and shows what the page wants through the scene
// (forge-scene.js, whose work this file wires to messages).
//
// The protocol, page to worker: `{ kind: "open", text, skip }` -- the replica from a file's text
// (null: a new document), the nodes `skip` names left out (the page's crash quarantine),
// every body posted; `{ kind: "skip", nodes }` the quarantine replaced; `{ kind: "resolve",
// req, cmd }` a command needing built geometry made an op here, answered `resolved {req, op}`
// (or `error`); `{ kind: "op", op }` -- the op the page's
// forge-doc-convert.js's `command` gave (JSON text), applied as the page applied it; `{ kind:
// "preview", op }` a drag frame's op (`commandOp`), applied unrecorded in place of the last
// frame, and `{ kind: "endPreview" }` that preview taken back -- sent before the op that
// commits the drag, or alone when the drag commits nothing; `{ kind: "undo" }`,
// `{ kind: "redo" }`, `{ kind: "switch", branch }` the same on the replica, `{ kind:
// "dropRedo" }` a Cancel's undone commits left unnamed (forge-scene.js `dropRedo`); `{ kind: "pick",
// req, id, what, indices }` the references to a pick, answered `picked {req, refs}`;
// `{ kind: "export", req, format, ids, names, looks, text, tolerance }` write a file;
// `{ kind: "wanted", items }` and `{ kind: "bitmap", id, bitmap }` what to show
// (forge-items.js); and every `view.*` of viewer-client.js. Worker to page: `progress`,
// `built`, `failed` (the bodies whose node changed, after an evaluation), `forgotten {ids}`
// (bodies that left the document: the page drops their tables on this alone), `picked`,
// `opFailed` (the replica refused a change, or an evaluation failed), `exported`, `exportFailed`,
// `crashed {id?, node?, message}` (a wasm trap: the instance is poisoned, the page remakes the
// worker and quarantines `node`, the one running),
// `forge.error {message}` (the View refused a camera move) and the host's `view.*` (view.ready, view.frame, view.tapped, view.picked, ...). A `view.picked`
// hit carries `body` (the body's id) and `ghost` (a trim's dropped faces) beside `item`, `node`
// and `face`, or is `null` when the item is no body. `face` is the body's B-rep face; on a
// ghost, the face's place in the trim's `drop` (the View names the split's own face). The page's camera moves -- `forge.aim`,
// `forge.lookAway`, `forge.radius` -- and the ?test hook (`forge.test`, answered
// `forge.test.result`) are forge-cameras.js's. Messages wait for the wasm, in order.
import * as wasm from "./pkg/index.js";
import { createForgeScene, createForgeRouter, VIEW_ID } from "./forge-scene.js";
import { createViewerHost } from "./pkg/viewer-host.js";
import { createForgeCameras } from "./forge-cameras.js";

// Exported for test/worker-crash.mjs, which shims `self` and drives these directly.
export const trapped = (e) => typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;

const crashed = (e) => self.postMessage({ kind: "crashed", message: String(e?.message ?? e) });

// A trap from the scheduled draw (viewer-host's rAF `drawFrame`, outside any message's own
// try) is reported as a crash; anything else rethrows unchanged.
export function schedule(fn) {
    const draw = () => {
        try { fn(); } catch (e) {
            if (trapped(e)) crashed(e);
            else throw e;
        }
    };
    if (typeof self.requestAnimationFrame === "function") self.requestAnimationFrame(draw);
    else setTimeout(draw, 16);
}

let scene = null;
function post(message, transfer) {
    if (message.kind === "view.picked" && message.hit) {
        const owner = scene?.bodyOfItem(message.hit.item) ?? null;
        const face = owner?.faces ? owner.faces.indexOf(message.hit.face) : message.hit.face;
        message = { ...message, hit: owner ? { ...message.hit, face: face < 0 ? null : face, body: owner.body, ghost: owner.ghost } : null };
    }
    // A snap says which body it lies on (`body`, the body's id), or null: on a curve, a
    // trim's ghost, the grid -- what forge-snap.js `bodyAnswer` sorts by.
    if (message.kind === "view.snapped" && message.snap) {
        const owner = scene?.bodyOfItem(message.snap.item) ?? null;
        message = { ...message, snap: { ...message.snap, body: owner && !owner.ghost ? owner.body : null } };
    }
    self.postMessage(message, transfer);
    // The view just appeared: show the wanted list the page sent before it did.
    if (message.kind === "view.ready" && message.id === VIEW_ID) scene?.resync();
}

// A license of your own (cadaclysm.lic, as its URL or its text), or null: unlicensed, the
// module runs in full and prints a notice in the console when a STEP file is written.
// See https://cadaclysm.blitter.studio/license.
const LICENSE = null;
const ready = wasm.load(LICENSE ? { license: LICENSE } : {});
const host = createViewerHost({
    View: wasm.View, post, now: () => performance.now(), schedule,
    // A trap in any View call: the instance is poisoned, so the page is told to remake the worker.
    onTrap: (e) => crashed(e),
});
scene = createForgeScene({
    wasm, post: (m, t) => self.postMessage(m, t), host, viewId: VIEW_ID,
    // A trap in an evaluation: the page blames the body named here (the one reporting, if any).
    crashed: ({ id, node, message }) => self.postMessage({ kind: "crashed", ...(id !== null && id !== undefined ? { id } : {}), ...(node ? { node } : {}), message }),
});
// The camera moves that read and write a camera (forge-cameras.js), and the ?test hook's reads.
const cameras = createForgeCameras({
    host, viewId: VIEW_ID, post: (m) => self.postMessage(m),
    onError: (message) => self.postMessage({ kind: "forge.error", message }),
});
const route = createForgeRouter({ scene, post: (m, t) => self.postMessage(m, t), ready, host, cameras });
self.onmessage = ({ data }) => route(data);
