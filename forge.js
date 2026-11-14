// The forge: a document of curves -- lines, polylines, rectangles, circles, arcs,
// ellipses and NURBS -- and of the surfaces curves make, the planar face closed ones
// bound and the sheet any curve sweeps to, along Z or about an axis, each
// sketched in the Top view, drawn exactly in four views -- and the solids made from them:
// extrusions, revolutions, sweeps, lofts, booleans, fillets, chamfers, shells and the
// primitives, each an exact B-rep built by the cadaclysm kernel.
//
// A curve's Béziers come back from the page's wasm in microseconds, and a drag wants them on
// the very next frame. Rebuilds are coalesced to one per animation frame and touch only the
// curves that changed. The document is a blacksmith document (forge-doc-*.js over the
// kernel's public exports); the bodies are built, and everything is drawn, in a worker
// (forge-worker.js), which holds a replica of it.
//
// One canvas draws everything through the wasm's `View` in that worker (WebGPU, or WebGL2
// where the browser has no WebGPU): each curve goes to it as the rational cubic Béziers the wasm
// converts it to -- the same record a solid's edges are -- and a body as its exact faces,
// all of them items the View keeps (forge-items.js), so there is nothing to redo when a
// camera moves. The canvas is split into Top / Perspective / Front / Right; a
// transparent 2D overlay of the same size draws the viewport names, the active border
// and, in the Top rect, the selected curve's handles -- through the Top camera, so a
// sketch lies in the world's XY plane at z = 0. The overlay takes every pointer event.
// The cadaclysm web package (./pkg, `npm run setup`): index.js loads the module and
// re-exports everything cadaclysm.js exports.
import { cadaclysm_blacksmith_version as version, cadaclysm_blacksmith_frame_midplane, cadaclysm_blacksmith_frame_through } from "./pkg/index.js";
// The same module instance as a namespace: what forge-constraints.js calls the kernel through.
import * as wasm from "./pkg/index.js";
// The cadaclysm the page runs on, as the status line names it: the version, and the branch,
// commit and time the package was built from (`cadaclysm_blacksmith_build`; a package older than
// that call has only its version).
let cadaclysmLine = null;
const cadaclysm = () => cadaclysmLine ??= (() => {
    if (typeof wasm.cadaclysm_blacksmith_build !== "function") return `cadaclysm ${version()}`;
    const b = JSON.parse(wasm.cadaclysm_blacksmith_build());
    return `cadaclysm ${b.version} · ${b.branch} ${b.commit} · ${b.time.replace("T", " ").replace(/Z$/, " UTC")}`;
})();
import * as forgeDoc from "./forge-doc-convert.js";
import { detectLoops, embedBeziers, closeCurve } from "./forge-doc-curves.js";
import { itemsOf, UNITS } from "./forge-doc-nodes.js";
import * as sk from "./forge-constraints.js";
import { V, Q, placeOf, LOOP_TOLERANCE, beziersOf, chainPieces, trimPieces, trimmedChains, chainCurve, roundCorner, roundPolyline, roundPolycurve, polygonPoints, worldAxis, parseEdges, closureText, isQuickKind } from "./forge-curves.js";
import { typedBytes, createWantedSender } from "./forge-wanted.js";
import { faceColoursOver } from "./forge-items.js";
import { attachViewer } from "./pkg/viewer-client.js";
import { VIEW_ID, dropRedo, itemOfNode, createQuarantine } from "./forge-scene.js";
import { cameraOf } from "./projection.js";
import { cubeFaces, cubeFaceAt, aimAt } from "./view-cube.js";
import { AXES3, RINGS3, layoutManipulator as layoutShared, drawManipulator as drawShared, hitManipulator as hitShared, manipulatorPoint as pointShared, dragDelta, segmentDistance } from "./manipulator.js";
import { createRouter } from "./forge-input.js";
import { createOrder, deferWhileBusy, createUndoOrder } from "./forge-order.js";

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const hintEl = document.getElementById("hint");
const viewsEl = document.getElementById("views");
let viewCanvas = document.getElementById("view");   // a canvas hands its drawing to a worker once: a restart makes a new one
const overlay = document.getElementById("overlay");
const degreeEl = document.getElementById("degree");
const weightEl = document.getElementById("weight");
const weightValueEl = document.getElementById("weight-value");
const closedEl = document.getElementById("closed");
const surfaceEl = document.getElementById("surface");
const extrudeEl = document.getElementById("extrude");
const heightEl = document.getElementById("height");
const taperEl = document.getElementById("taper");
const revolveEl = document.getElementById("revolve");
const sweepEl = document.getElementById("sweep");
const loftEl = document.getElementById("loft");
const joinEl = document.getElementById("join");
const cutEl = document.getElementById("cut");
const splitEl = document.getElementById("split");
const pipeEl = document.getElementById("pipe");
const intersectEl = document.getElementById("intersect");
const shellEl = document.getElementById("shell");
const thickenEl = document.getElementById("thicken");
const trimEl = document.getElementById("trim");
const filletEl = document.getElementById("fillet");
const chamferEl = document.getElementById("chamfer");
const removeEl = document.getElementById("remove");
const radiusEl = document.getElementById("radius");
const thicknessEl = document.getElementById("thickness");
const angleEl = document.getElementById("angle");
const offsetEl = document.getElementById("offset");
const lookAtEl = document.getElementById("look-at");
const addSketchEl = document.getElementById("add-sketch");
const sketchFilletEl = document.getElementById("sketch-fillet");
const tabSketchEl = document.getElementById("tab-sketch");
const tabSolidEl = document.getElementById("tab-solid");
const ribbonSketchEl = document.getElementById("ribbon-sketch");
const ribbonSolidEl = document.getElementById("ribbon-solid");
const tiltEl = document.getElementById("tilt");
const modeEl = document.getElementById("mode");
const baseEl = document.getElementById("base");
const pickHingeEl = document.getElementById("pick-hinge");
const pickPathEl = document.getElementById("pick-path");
const pickFaceEl = document.getElementById("pick-face");
const pickMidEl = document.getElementById("pick-mid"), pickPointsEl = document.getElementById("pick-points"), midOriginEl = document.getElementById("mid-origin");
const tabConstructEl = document.getElementById("tab-construct"), ribbonConstructEl = document.getElementById("ribbon-construct");
const baseField = document.getElementById("base-field"), offsetField = document.getElementById("offset-field"), tiltField = document.getElementById("tilt-field");
const listEl = document.getElementById("curves");
const propsEl = document.getElementById("props");
const dialogEl = document.getElementById("dialog");
const dialogGlyphEl = document.getElementById("dialog-glyph");
const dialogTitleEl = document.getElementById("dialog-title");
const dialogSubEl = document.getElementById("dialog-sub");
const dialogNoteEl = document.getElementById("dialog-note");
const dialogFootEl = document.getElementById("dialog-foot");
const dialogOkEl = document.getElementById("dialog-ok");
const picksEl = document.getElementById("picks");
const picksLabelEl = document.getElementById("picks-label");
const dialogCancelEl = document.getElementById("dialog-cancel");
const operationEl = document.getElementById("operation");
const lookColourEl = document.getElementById("look-colour");
const lookMaterialEl = document.getElementById("look-material");
const lookResetEl = document.getElementById("look-reset");
const lookOpacityEl = document.getElementById("look-opacity");
const radiusLabelEl = document.getElementById("radius-label");
const timelineChipsEl = document.getElementById("timeline-chips");
const timelineBackEl = document.getElementById("timeline-back");
const timelineForwardEl = document.getElementById("timeline-forward");
const timelineCountEl = document.getElementById("timeline-count");
const progressEl = document.getElementById("progress");
const progressTitleEl = document.getElementById("progress-title");
const progressWhatEl = document.getElementById("progress-what");
const progressFillEl = document.getElementById("progress-fill");
const progressTimeEl = document.getElementById("progress-time");
const saveEl = document.getElementById("save");
const stlEl = document.getElementById("stl");
const glbEl = document.getElementById("glb");
const objEl = document.getElementById("obj");
const stepEl = document.getElementById("step");
const loadEl = document.getElementById("load");
const loadFileEl = document.getElementById("load-file");
const duplicateEl = document.getElementById("duplicate");
const renameEl = document.getElementById("rename");
const deleteEl = document.getElementById("delete");
const mergeEl = document.getElementById("merge");
const explodeEl = document.getElementById("explode");
const sketchTrimEl = document.getElementById("sketch-trim");

function say(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
}
// A refused edit's reason, said after the curves it put back are built (the frame's build
// line would cover it otherwise).
function refuse(text) {
    if (curves.some((c) => c.dirty)) rebuild();
    say(text, true);
    schedule();
}

// ------------------------------------------------------------------ the document

// An ordered list of curves, each `{ id, name, kind, shape, beziers, bounds, error, dirty }`.
// `kind` is "line" (`shape = { x0, y0, x1, y1 }`, its two ends), "polyline" (`{ points,
// closed }`, the points it runs through in order), "rect" (`{ x0, y0, x1, y1 }`, two
// opposite corners in any order), "circle" (`{ cx, cy, r }`), "arc" (`{ x0, y0, xm, ym,
// x1, y1 }`, its start, a point it passes through, and its end), "ellipse" (`{ cx, cy, rx,
// ry }`, the semi-axes along x and y), "polygon" (`{ cx, cy, r, sides, angle }`, a regular
// polygon of `sides` vertices on the circle of radius `r`, the first `angle` degrees
// from x) or "nurbs" (`{ points, weights, degree, closed }`,
// the control polygon), "polycurve" (`{ pieces, closed, ends }`: other curves' definitions,
// kind and shape, merged into one curve laid end to end, whether it comes back to its start
// and otherwise its two ends -- the pieces are copies, and explode gives them back as
// curves), all in millimetres, y up in its plane. Every curve lies in one
// of the three sketch planes (`plane`: "top", "front" or "right" -- the orthographic
// view it was drawn in, see `PLANES`); its shape is in that plane's own (x, y), `sketch`
// its Béziers there as the wasm converts them, `beziers` the same carried into the world
// for the View. A polyline and a NURBS are the two kinds laid down point by point
// (`pointed`): add point, Delete and closed work on both.
//
// A body is an item of the same list -- `{ id, name, kind: "surface" | "extrusion" |
// "revolution" | "solid" | "sweep", source, pivot, transform, holes, height, axis, angle, path,
// solid, gpu, bounds, error, dirty }` -- and an
// object of its own: the curves it was made from gave it its shape once (`source`: a copy
// of each curve's definition, kind and shape, in loop order, with how many curves each
// loop has) and are nothing to it afterwards -- edit or delete them and the body stays;
// the Béziers are rebuilt from the copies whenever they are wanted, never kept. A surface is
// the planar face closed loops bound, the largest loop its boundary and the others
// holes; an extrusion is one curve, open or closed, swept `height` along Z (below the
// plane when negative) into a sheet -- a line to a rectangle, a circle to an open tube
// -- a surface too, never a solid; a solid is a *surface* swept `height` along its normal,
// caps and walls, the holes bored through; a revolution is one curve swung `angle` degrees about
// an `axis` in the sketch plane (two points, in the body's own source space, so the
// transform carries the axis with the curve); a sweep is a surface's loops carried along a
// path curve (`path`: a copy of the curve's definition, `curve`, and the plane it was drawn
// on, `plane`, whose frame is read at build time) -- the path must start on the surface's
// plane and leave square to it, which a sketch "along path" is made for. What moves any of them is its `transform`, in the sketch
// plane about its `pivot` (its centre when it was made): `{ tx, ty, angle, scale }`, a
// translation, a turn about the pivot and a uniform scale about it, set by the gizmo
// its view. Its solid is kept in the worker (its node's `cadaclysm_blacksmith_document_result_solid`);
// `gpu` is the table the worker read off it once (forge-scene.js `bodyTable`).
//
// A sketch is an item too -- `{ id, name, kind: "sketch", mode, base, offset, hinge,
// tilt, path }` -- what is made first: a sketch on a plane, the curves drawn on it
// grouped under it. Its plane is one of three (`mode`): "offset", parallel to an origin
// plane (`base`: "top", "front" or "right") and `offset` millimetres along its normal;
// "angle", hinged on a line (`hinge`, a line curve's id) and turned `tilt` degrees about
// it out of that line's own plane, its x along the hinge; "path", square across a curve
// (`path`, its id) at the curve's start -- the plane a sweep's profile is drawn on, its
// x the curve's plane's normal, its y the curve's in-plane left normal; "face", on a
// flat face of a body (`face`: `{ body, index }`, the body's id and the face's index
// among its GPU faces), read off the face's own plane record -- origin at the face's
// middle, x and y its axes, z out of the body -- so the sketch rides the body; "mid",
// midway between two planes (`mid`: two plane keys -- an origin plane's name, a
// sketch's id, or a face's `{ body, index }`), the kernel's midplane; "points", through
// three curve ends (`points`: `{ curve, end }` each, `end` 0 or 1), the kernel's
// plane_through -- the Construct tab's planes. A sketch starts
// as an offset one and its plane is edited whenever it is the active item: the toolbar
// shows its mode and the mode's own fields, the hinge or path picked by pressing "pick"
// and clicking a curve's row. A tilted sketch is seen square-on by a view told to look
// at it (a camera built on its frame). A curve's or body's `plane` is then either an
// origin plane's name or a sketch item's id; everything on a sketch follows it when its
// offset changes, and goes with it when it is deleted. The panel lists the document
// grouped by plane, the three origin planes and then each sketch, as a tree groups
// a sketch's curves. A view can be told to look at a sketch (the toolbar's "look at"):
// new curves land on it and it is what the view edits.
//
// Which curves are closed is detected, not declared: a rectangle, a circle, an ellipse
// and a polyline or NURBS with its `closed` flag have no ends (`endsOf` is null); every
// other curve has a start and an end, and is closed when they meet -- on itself, or
// through other curves end to end (`loops`, the kernel's `profile_loops`). An end handle
// dragged near another curve's end snaps onto it exactly, which is how the ends are made
// to meet. `beziers` is the curve as the wasm last converted it (a Float32Array
// of sixteen floats a Bézier, empty while there is nothing to draw), `bounds` its centre
// and radius in the sketch plane, `error` its last failure or null, and `dirty` asks the
// next frame to rebuild it. Re-assembling the scene (a selection change, a drag of some
// other curve) reads these and copies nothing out of the wasm again.
let curves = [];

// ------------------------------------------------------------------ the history
//
// The document is a blacksmith document, its forge layer in
// JavaScript (forge-doc-*.js) over the kernel's public `cadaclysm_blacksmith_*` exports: the page
// holds a replica of it (`doc`), the worker another (forge-scene.js), and both take the same
// ops in the same order, so both save the same bytes. Every change goes through `run` as a
// command; forge-doc-convert.js's `command` makes it one commit on the page's replica and
// gives back the batch op, which the worker applies as it is. A file is the document's own text, and
// undo, redo and a branch switch are the document's, sent to the worker the same. A
// command names what it makes by id; the names and counters are the document's. The
// items (`curves`) are the document's items (`itemsOf`) with the page's
// runtime fields beside them (a curve's Béziers, a body's table off the worker, errors,
// selection state): `syncItems` updates them in place after every change, so whatever
// holds an item keeps holding it.
//
// A drag or a typed field changes items in place first. While the page's items differ from
// the document's, the difference is previewed -- an `edit` command's op
// (`commandOp`) applied unrecorded on both replicas (`livePreview`) -- so a
// body follows a drag in the worker; the drag's commit ends that preview on both sides and
// commits its own command. A run of `set`s of one item's same fields (`merge`), or a typed
// field's keystrokes (`"replace"`), is held as one pending command, its fields applied
// in place and previewed, and committed when anything else touches the document
// (`flushPending`): a history is a list of what was done, not of every frame of it.
//
// A picked face or edge (a shell's open faces, a fillet's edges, a trim's dropped
// pieces, a face a sketch stands on) is asked of the worker first (`refsOf`, its replica
// evaluated), and the command carries the references, so the page never builds a body.
// The reference images are the session's, never the document's (`isImage`), yet Ctrl+Z
// undoes in the order the user acted: their actions are kept in one undo order with the
// document's commits (`undoOrder`, forge-order.js).

let doc = null;                // the page's replica, a wasm DOCUMENTS handle once the wasm is up
let baseItems = new Map();     // id -> the item as the document holds it (no preview), at the last sync
let history = [];              // the commits on the line the head is on, the root left out (`commitInfo`)
let head = 0;                  // how many of them the document stands after
let headCommit = null;         // the commit the document stands at
let resets = 0;                // how many times an undo, a redo, a rollback or a load remade the items
let pendingRun = null;         // { cmd }: a merged run's command, applied in place, not committed yet
let previewOp = null;          // the op previewed on both replicas (JSON text), or null
let previewSig = null;         // what it previews (`localEdits`, as JSON), or null
// Commands are applied one after another, in the order they were run; the user's actions
// (`act`) wait behind the commands in flight (forge-order.js).
const order = createOrder();
const undoOrder = createUndoOrder(() => headCommit);
// What a build derives or the page keeps while it runs: not part of an item as the document holds it.
const RUNTIME_KEYS = new Set(["cache", "gpu", "job", "dirty", "waiting", "version", "ghostFaces", "sig", "bounds", "beziers", "sketch", "error", "closure", "joined", "jobAt", "sigOut", "waitingSig", "rev",
                              "key", "wantKey", "docError", "local"]);
// Every id a command makes, taken now: a command queued behind an apply in flight has not
// bumped `nextId` yet, and the next tool would read the same id.
function reserve(cmd) {
    for (const id of [cmd.id, cmd.arc, ...(cmd.ids ?? []), ...(cmd.copies ?? [])]) if (typeof id === "number") bump(id);
}
// A command run: applied in its turn. The result is what `apply` returned -- undefined, or
// for a command queued behind another a promise of that. `merge`: true folds a `set` into
// the pending one of the same item and fields, "replace" replaces the pending command (the
// caller has folded it in, a typed field's run), "hold" starts a pending run of its own.
function run(cmd, merge = false) {
    reserve(cmd);
    return order.command(() => apply(cmd, merge));
}
// A user action: it runs once the commands and actions in flight are done, and holds the
// ones after it. A call made while an action runs belongs to it and runs inline (a handler
// that calls another handler, after an await too). The tap and the timeline, which the gate
// does not hold, are `userAct` -- always behind whatever is in flight.
let acting = 0;
let fresh = false;   // true while an event that is not part of the running action is handled (`entry`)
const inline = [];   // the async results of inline calls, which the outermost action waits for
function userAct(fn) {
    return order.act(async () => {
        acting++;
        const was = fresh;
        fresh = false;   // what fn calls synchronously belongs to this action
        let started;
        try { started = fn(); } finally { fresh = was; }
        try {
            const result = await started;
            while (inline.length) await Promise.all(inline.splice(0));
            return result;
        } finally { acting--; inline.length = 0; }
    });
}
function act(fn) {
    // An event the gate let through while an action runs (a key typed in a field, a pick
    // answering late) is not part of it: it is queued behind it, never run beside it.
    if (acting === 0 || fresh) return userAct(fn);
    const result = fn();
    if (result && typeof result.then === "function") inline.push(result);
    return result;
}
// A handler of an event nothing holds: what it starts waits its turn.
function entry(fn) {
    const was = fresh;
    fresh = true;
    try { return fn(); } finally { fresh = was; }
}
// A drag's (or any pointer's) commit: kept as it is now, applied in the order's turn, and
// dropped when the item it is of has gone by then, or the document was taken back meanwhile
// (an undo, a rollback: the drag is of a document that is no more).
// `at`: the `resets` count when the drag began (its press), else now.
function commitLater(cmd, items, merge = false, at = resets) {
    userAct(() => { if (resets === at && items.every((c) => byId(c.id) === c)) run(cmd, merge); });
}
function noteLater(c, keys, merge = false, at = resets) {
    const cmd = { op: "set", id: c.id };
    for (const k of keys) cmd[k] = structuredClone(c[k]);
    commitLater(cmd, [c], merge, at);
}
// `keys` of item `c`, as they are now, recorded as a command: the way a drag or a typed
// field is kept, after the item was changed in place.
function note(c, keys, merge = false) {
    const cmd = { op: "set", id: c.id };
    for (const k of keys) cmd[k] = structuredClone(c[k]);
    run(cmd, merge);
}
// Where the history stands, a pending run committed first: what a tool's session keeps to
// roll back to -- the commit count (its value: it compares and counts as a number) and the
// undo order's mark (`undoOrder.mark()`), so a Cancel takes back the image actions made in
// the session too, and none from before it.
function headNow() {
    flushPending();
    return { head, images: undoOrder.mark(), valueOf() { return this.head; } };
}
// Whether anything was done since `mark` (a commit, or an image action).
const doneSince = (mark) => head > +mark || (mark?.images !== undefined && undoOrder.since(mark.images));

// ------------------------------------------------------------------ the constraints
//
// A sketch item's curves are held by its `constraints` (forge-constraints.js):
// one solver session per sketch, kept in `models` while the sketch's
// curves and constraints are what the session was built from (`sig`), so a drag reuses it
// every pointer move and any other change builds it again. Only a sketch item carries
// constraints: curves on an origin plane or a face are free. A sketch saved before
// constraints has none (`constraints` undefined) until its first edit, which migrates its
// snapped ends to coincidences in the same undo step. The history keeps the solved
// shapes -- a drag or a typed field is one `edit` of every curve it moved, the sketch's
// `constraints` with them when they changed; a structural command (delete, merge, explode,
// snip, round, a point removed, close) carries the pruned constraints as
// `sketchConstraints`, and the curves its red records moved where they came to apply as
// `sketchEdits` -- so a replay never solves.
const models = new Map();   // sketch id -> { model, sig }
// Each sketch's revision: bumped whenever anything a diagnosis reads may have changed (a
// curve of it rebuilt, a command applied, its constraints set, its session dropped or built
// anew). What the diagnoses are keyed by, so a rebuild that changed nothing costs no
// signature of the whole sketch.
const sketchRevs = new Map();   // sketch id -> revision
const touchSketch = (id) => sketchRevs.set(id, (sketchRevs.get(id) ?? 0) + 1);
const revOf = (id) => sketchRevs.get(id) ?? 0;
// A sketch's constraint records set (`undefined`: none stored, saved before constraints),
// its revision touched. Every write of `constraints` outside a command goes through here.
function setConstraints(sketch, list) {
    if (list === undefined) delete sketch.constraints; else sketch.constraints = list;
    touchSketch(sketch.id);
}
const sketchCurves = (sketch) => curves.filter((c) => c.plane === sketch.id && isCurve(c));
const curvesMap = (list) => new Map(list.map((c) => [c.id, c]));
function modelSig(sketch, list = sketchCurves(sketch)) {
    return JSON.stringify([list.map((c) => [c.id, c.kind, c.shape]), sketch.constraints ?? []]);
}
// The sketch item curve `c` lies on, or null (an origin plane's, a face's, not a curve).
const sketchOf = (c) => { const k = isCurve(c) ? byId(c.plane) : null; return isSketch(k) ? k : null; };
// Whether the sketch has stored constraints to solve (a rectangle's or a polygon's own are
// the session's alone: with none stored, a drag is the plain one).
const constrained = (sketch) => (sketch?.constraints?.length ?? 0) > 0;
// A record as a session judged it: its kind and spots.
const recordKey = (k) => JSON.stringify([k.kind, k.refs ?? []]);
// Whether `k` (in the sketch now) is the record session `old` refused under its id: the same
// kind and spots -- or, after a structural command, the record `from(k)` it was remapped
// from, each spot kept, renamed on its own curve, or moved off a curve the command took out
// (a polycurve's end onto a piece's). Never a new record given a dropped one's id.
function sameRecord(old, k, from) {
    if (!k) return false;
    const was = old?.records?.get(k.id);
    if (was === undefined) return true;   // a session built with no record of its ids' records
    if (recordKey(k) === was) return true;
    const p = from?.(k);
    if (!p || recordKey(p) !== was || p.kind !== k.kind || (p.refs ?? []).length !== (k.refs ?? []).length) return false;
    return k.refs.every((r, i) => { const q = p.refs[i]; return r.curve === q.curve || !byId(q.curve); });
}
function dropModel(id) {
    const entry = models.get(id);
    if (!entry) return;
    sk.freeModel(wasm, entry.model);
    models.delete(id);
    touchSketch(id);   // a session built anew refuses differently
}
// A sketch's session dropped (it holds the geometry as it was), where an action goes on to
// settle at the new geometry: the records it refused as conflicts stay refused in the next
// session, built here without them and given them back as refused, so the action's
// `settleRefused` judges them with a retry's checks (written back, no curve collapsed, a
// typed value kept) and puts them back where those fail. A session built afresh would take
// any the new geometry allows on its own, unwritten and unchecked: drawn as held while the
// document breaks it, the curves moved by the next action. With none, a plain drop. The red
// records are read off `old`, the cached session unless the caller passes the one it worked
// on (a withheld polygon's write-back has dropped it already; only its records are read).
function dropKeepingRed(sketch, old = models.get(sketch.id)?.model, from = null) {
    const red = (old?.refused ?? []).filter((r) => r.id !== null && sk.isConflictRefusal(r) && sameRecord(old, sketch.constraints?.find((k) => k.id === r.id), from));
    dropModel(sketch.id);
    if (!red.length) return;
    const ids = new Set(red.map((r) => r.id)), list = sketchCurves(sketch);
    let model;
    try { model = buildSession({ ...sketch, constraints: sketch.constraints.filter((k) => !ids.has(k.id)) }, list); } catch { return; }
    model.refused.push(...red);
    for (const r of red) model.records.set(r.id, old.records?.get(r.id));
    models.set(sketch.id, { model, sig: modelSig(sketch, list) });
    touchSketch(sketch.id);
}
const freeModels = () => { for (const id of [...models.keys()]) dropModel(id); };
// A deleted sketch's session, or one with no curves left, goes.
const freeStaleModels = () => { for (const id of [...models.keys()]) { const s = byId(id); if (!isSketch(s) || !sketchCurves(s).length) dropModel(id); } };
// The records each sketch's last session refused for shrinking a curve to a point, passed to
// the next build (`buildModel`'s `collapsed`): left out and checked last, so a sketch holding
// one does not build record by record every time its session is dropped.
const collapseHints = new Map();   // sketch id -> Set of record ids
function buildSession(sketch, list) {
    const model = sk.buildModel(wasm, sketch, list, { collapsed: collapseHints.get(sketch.id) });
    model.records = new Map((sketch.constraints ?? []).map((k) => [k.id, recordKey(k)]));   // what each id was, for `dropKeepingRed`
    const ids = model.refused.filter((r) => r.collapse).map((r) => r.id);
    if (ids.length) collapseHints.set(sketch.id, new Set(ids)); else collapseHints.delete(sketch.id);
    return model;
}
function modelFor(sketch) {
    const list = sketchCurves(sketch), sig = modelSig(sketch, list);
    const cached = models.get(sketch.id);
    if (cached?.sig === sig) return cached.model;
    dropModel(sketch.id);
    const model = buildSession(sketch, list);
    models.set(sketch.id, { model, sig });
    touchSketch(sketch.id);
    return model;
}
// Whether two shapes are the same but for floating-point rounding (a through-point or a
// polygon's angle recomputed from the session's points).
function nearShape(a, b) {
    const near = (x, y) => typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) : x === y;
    for (const key of Object.keys(b)) {
        const x = a[key], y = b[key];
        if (Array.isArray(y)) {
            if (!Array.isArray(x) || x.length !== y.length) return false;
            if (!y.every((p, i) => Array.isArray(p) ? Array.isArray(x[i]) && x[i].length === p.length && p.every((v, j) => near(x[i][j], v)) : near(x[i], p))) return false;
        } else if (!near(x, y)) return false;
    }
    return true;
}
// The first edit of a sketch saved before constraints: its snapped ends made coincident
// (in place; the caller records it). True when it migrated.
function migrate(sketch) {
    if (!sketch || sketch.constraints !== undefined) return false;
    setConstraints(sketch, sk.migrateCoincidences(sketch, sketchCurves(sketch)));
    return true;
}
// The solved session's shapes written into the sketch's curves: the ids written, or an
// error -- a polygon the session folded refuses the whole write, nothing written and the
// session (whose geometry is now wrong) dropped.
function writeSolved(sketch, model) {
    const out = sk.writeBack(wasm, model, curvesMap(sketchCurves(sketch))).filter(({ id, shape }) => !nearShape(byId(id).shape, shape));
    if (model.withheld.length) {
        dropModel(sketch.id);
        return { ids: [], error: model.withheld.map((x) => `${byId(x.id)?.name ?? "a polygon"}: ${String(x.error).replace(/^polygon \d+: /, "")}`).join("; ") };
    }
    for (const { id, shape } of out) { const c = byId(id); c.shape = shape; c.dirty = true; }
    sk.rebase(wasm, model, out.map(({ id }) => byId(id)));   // written: skipped until they move again
    const entry = models.get(sketch.id);
    if (entry) entry.sig = modelSig(sketch);   // the session holds what the document now does
    return { ids: out.map((x) => x.id), error: null };
}
// `writeSolved` for a held move (a handle's or the gizmo's): a solve that shrank a curve to
// a point is refused (`collapse`, the curve `gone`), nothing written -- the kernel holds a
// collapsed curve as solved, so only the write-back can tell. The session still holds it:
// the caller puts its own shapes back, then drops it keeping the red records
// (`dropKeepingRed`).
function writeHeld(sketch, model) {
    const list = sketchCurves(sketch);
    const start = { sketch, shapes: new Map(list.map((k) => [k.id, k.shape])), kinds: new Map(list.map((k) => [k.id, k.kind])) };
    const written = writeSolved(sketch, model);
    if (written.error) return written;
    const gone = collapsed(start, written.ids);
    if (!gone) return written;
    for (const id of written.ids) { const k = byId(id); k.shape = start.shapes.get(id); k.dirty = true; }
    return { ids: [], error: collapseText(sketch, gone, null), collapse: true, gone };
}
// A value as the status line shows it: rounded, unless that reads 0 for a value that is not
// (a 1e-9 length is "1e-9", not "0").
const roundedOrStored = (v) => round(v) === 0 && v !== 0 ? Number(v.toPrecision(3)) : round(v);
// A stored constraint as the status line names it: "horizontal 3", "length 5 = 40",
// "angle 6 = 30°" (an angle stored in radians, named in degrees), a driven one marked so
// with what it measures now.
function constraintName(sketch, id) {
    const k = sketch.constraints?.find((x) => x.id === id);
    if (!k) return `constraint ${id}`;
    const value = k.value !== undefined && sk.DIMENSIONS.has(k.kind) ? ` = ${roundedOrStored(shownValue(k))}${k.kind === "angle" ? "°" : ""}${k.driving === false ? " (driven)" : ""}` : "";
    return `${k.kind.replace(/_/g, " ")} ${k.id}${value}`;
}
// Why a solve or a drag did not converge, naming what it fights.
function solveFailure(sketch, report) {
    const names = (report.ids ?? []).map((id) => constraintName(sketch, id));
    if (report.status === "conflicting") return names.length ? `the constraints conflict -- it fights ${names.join(", ")}` : "it conflicts with a rectangle's or polygon's own shape";
    return `the sketch does not solve (${report.status}${names.length ? `, near ${names.join(", ")}` : ""})`;
}
// What a drag or a typed edit starts from: the sketch's constraints as they were (before
// a migration) and its curves' shapes.
function constrainedStart(sketch) {
    const was = sketch.constraints === undefined ? undefined : structuredClone(sketch.constraints);
    const shapes = new Map(sketchCurves(sketch).map((k) => [k.id, structuredClone(k.shape)]));
    const kinds = new Map(sketchCurves(sketch).map((k) => [k.id, k.kind]));
    migrate(sketch);
    return { sketch, was, shapes, kinds, migrated: structuredClone(sketch.constraints) };
}
// The `edit` items of what changed since `start`: every curve whose shape (or kind) moved,
// and the sketch's constraints when they did.
function changedSince(start) {
    const { sketch, was, shapes, kinds } = start;
    const items = [];
    for (const k of sketchCurves(sketch)) {
        const before = shapes.get(k.id);
        if (!before) continue;
        const kind = kinds.get(k.id) !== k.kind;
        if (kind || JSON.stringify(before) !== JSON.stringify(k.shape)) items.push({ id: k.id, ...(kind ? { kind: k.kind } : {}), shape: structuredClone(k.shape) });
    }
    if (JSON.stringify(was) !== JSON.stringify(sketch.constraints)) items.push({ id: sketch.id, constraints: structuredClone(sketch.constraints) });
    return items;
}
// The first of the curves `ids` that a solve since `start` shrank to a point
// (forge-constraints' `collapsedOf`: a size below 1e-6 of the sketch's extent at `start`
// that had none so small then): the curve, or null. A tool, a dimension or a drag refuses
// it: the kernel holds a collapsed curve as solved (a horizontal and a vertical on one
// line), and an arc shrunk so is refused ever after.
function collapsed(start, ids) {
    if (!ids.length) return null;
    const now = curvesMap(sketchCurves(start.sketch));   // one index, not a search per id
    const id = sk.collapsedOf(start, (k) => now.get(k), ids);
    return id === null ? null : now.get(id);
}
// Everything back as `start` had it: a refused edit changes nothing. The session goes too,
// unless `drop` is false (the caller has put it back itself).
function restoreStart(start, drop = true) {
    const { sketch, was, shapes, kinds } = start;
    for (const k of sketchCurves(sketch)) {
        const before = shapes.get(k.id);
        if (before && (kinds.get(k.id) !== k.kind || JSON.stringify(before) !== JSON.stringify(k.shape))) { k.kind = kinds.get(k.id); k.shape = structuredClone(before); k.dirty = true; }
    }
    setConstraints(sketch, was === undefined ? undefined : structuredClone(was));
    if (drop) dropModel(sketch.id);
}
// The records a constrained sketch's session refused as conflicts (`isConflictRefusal`)
// judged again where an edit has just put its geometry (`retryRefused`): called by every
// action that moves the sketch's curves -- a handle's or the gizmo's drag let go, a typed
// value, a constraint tool, a dimension added or edited, a drawn curve's inference, a
// structural command (`runStructural`, after its prune) -- after
// its own solve and write and before it takes what changed (`changedSince`), so the action
// and what the re-judged records moved are one undo step. A dropped session is built here,
// at the new geometry. Where one now applies, the sketch is solved and written back and the
// status line says so after the build ("… now applies"). A solve that does not converge, a
// polygon withheld, a curve collapsed, or the caller's `keeps()` false (a typed value no
// longer standing) puts back this step's shapes, never the action's, and the session as it
// was before the retry (`revertRetried`): the records stay refused, red. Grey records are never tried,
// and a replay never comes here (the history keeps the solved shapes). The notice's text,
// or null where nothing now applies.
function settleRefused(sketch, keeps = null) {
    if (!constrained(sketch)) return null;
    let model;
    try { model = modelFor(sketch); } catch { return null; }
    if (!model.refused.some((r) => r.id !== null && sk.isConflictRefusal(r))) return null;
    const before = constrainedStart(sketch);
    let applied = [], failed = false;
    try {
        applied = sk.retryRefused(wasm, model, sketch);
        if (!applied.length) return null;
        const report = sk.solveModel(wasm, model);
        const written = report.status === "converged" ? writeSolved(sketch, model) : { ids: [], error: "not converged" };
        failed = !!written.error || !!collapsed(before, written.ids) || (keeps !== null && !keeps());
    } catch {
        failed = true;
    }
    if (failed) {
        const entry = models.get(sketch.id);
        if (entry?.model === model) {
            // The session put back as it was before the retry, the records refused in it
            // again: a session built afresh here would take a record the geometry now allows
            // (a typed point off the centre) and draw it as held where the document is not.
            sk.revertRetried(wasm, model);
            restoreStart(before, false);
            sk.rebase(wasm, model, sketchCurves(sketch));
            entry.sig = modelSig(sketch);
        } else restoreStart(before);
        return null;
    }
    touchSketch(sketch.id);
    const text = `${applied.map((id) => constraintName(sketch, id)).join(", ")} now ${applied.length > 1 ? "apply" : "applies"}`;
    // After a notice the same action carries (a snapped end not held), not over it.
    noticeNext(pendingNotice ? `${pendingNotice} · ${text}` : text);
    return text;
}
// A structural command (one that takes curves out, makes new ones or changes a curve's
// spots) on the sketches `planes` names: their constraints migrated before it and pruned
// on the curves it leaves (`remap` first rewriting the records, where spots were
// renumbered), carried on the command itself as `sketchConstraints` -- and the curves a
// refused record's settling moved as `sketchEdits` -- so the command is one commit, one
// undo step, and the save holds what the page shows. The prune needs the curves the command
// makes, which only the document knows: in the command's turn, its op is previewed on the
// page's replica alone (`pruneUnderPreview`), the prune worked out on those items, the
// preview ended, and the command committed once, carrying it. `mutate` changes the document
// in place first, for a command recorded from what it did (a `set`). `dropped` is told the
// records the prune took out, once the command is committed (a refused one drops nothing).
// The result is the command, or null where the document refused it (a promise of it when
// the command waits its turn).
function runStructural(cmd, planes, { remap = null, mutate = null, dropped = null } = {}) {
    const before = new Map(), migrated = new Map();
    for (const id of new Set(planes)) {
        const s = byId(id);
        if (!isSketch(s)) continue;
        before.set(s.id, s.constraints === undefined ? undefined : structuredClone(s.constraints));
        if (migrate(s)) migrated.set(s.id, structuredClone(s.constraints));
    }
    if (mutate) mutate();
    const command = typeof cmd === "function" ? cmd() : cmd;
    reserve(command);
    return order.command(() => {
        flushPending();
        const gone = pruneUnderPreview(command, before, migrated, remap);
        const out = apply(command);
        const done = (ok) => {
            if (!ok) return null;
            if (dropped) dropped(gone);
            return command;
        };
        return out && typeof out.then === "function" ? out.then(done) : done(out);
    });
}
// `command`'s document share (its image ids left out: the images are the page's) made into
// the nodes it would leave (`commandNodes`, nothing applied: the worker never sees it), and
// the page's items synced to those; then each sketch of `before` pruned on the curves it
// leaves and its refused records settled, the results put on the command
// (`sketchConstraints`, `sketchEdits`) and on the page's items in place. The records the
// prune took out are returned. A command the document refuses is not pruned: its commit
// says why.
function pruneUnderPreview(command, before, migrated, remap) {
    const gone = [];
    endPreview();   // a drag's frame: the command is made on the document as it stands
    const share = command.op === "delete" ? { ...command, ids: command.ids.filter((id) => !isImage(byId(id))) } : command;
    if (share.op === "delete" && !share.ids.length) return gone;
    let nodes;
    try { ({ nodes } = forgeDoc.commandNodes(wasm, doc, share)); } catch { return gone; }
    let failed = null;
    try {
        syncItems(itemsOf(nodes).toLit());
        // A sketch whose records were made here (`migrate`, an old file's) has none in the
        // document yet: the migrated ones are what the prune starts from.
        for (const [id, list] of migrated) { const s = byId(id); if (isSketch(s) && s.constraints === undefined) setConstraints(s, structuredClone(list)); }
        const out = [];
        for (const [id, was] of before) {
            const s = byId(id);
            if (!isSketch(s)) continue;   // deleted, curves and all
            const pre = new Map((s.constraints ?? []).map((k) => [k.id, k]));   // what each record was remapped from
            const list = remap ? remap(s.constraints ?? [], s) : s.constraints ?? [];
            const pr = sk.pruneConstraints(list, curvesMap(sketchCurves(s)));
            setConstraints(s, pr.kept);
            // The session of the sketch as it was goes, its red records kept out of the next
            // and handed back as refused (their ids survive a remap): a fresh build would take
            // one the new curves allow (a record moved onto an exploded piece's free end),
            // unwritten, and the next drag would move the piece silently.
            dropKeepingRed(s, undefined, (k) => pre.get(k.id));
            gone.push(...pr.dropped);
            if (JSON.stringify(was) !== JSON.stringify(pr.kept)) out.push({ sketch: id, constraints: structuredClone(pr.kept) });
        }
        if (out.length) command.sketchConstraints = out;
        freeStaleModels();
        pendingNotice = null;   // an earlier action's, never this one's
        // The red records judged again on the new curves (a delete may take out what they
        // fought): where one now applies, the curves the solve moved are carried on the
        // command as `sketchEdits`, so it stays one undo step and a replay never solves.
        const edits = [];
        for (const id of before.keys()) {
            const s = byId(id);
            if (!isSketch(s) || !constrained(s)) continue;
            const start = constrainedStart(s);
            if (settleRefused(s)) edits.push(...changedSince(start).filter((it) => it.id !== s.id));
        }
        if (edits.length) command.sketchEdits = edits;
    } catch (error) {
        failed = error;
    }
    // A throw midway leaves the page's items as the command made them: they are made again
    // from the document, which never took the command, and the throw goes on.
    if (failed) { afterChange(); throw failed; }
    return gone;
}
// A curve's spots after point `i` of its `n` came out (a polyline's, a NURBS's): the
// later vertices and sides one down, and a record on the point, on a side that met it,
// or on an end it was, dropped.
function remapRemovedPoint(c, i, n, closed) {
    const sides = closed ? n : n - 1;
    const touching = new Set();
    if (i < sides) touching.add(i);
    if (i > 0) touching.add(i - 1); else if (closed) touching.add(n - 1);
    const at = (a) => {
        let m = /^vertex:(\d+)$/.exec(a);
        if (m) { const j = +m[1]; return j === i ? null : `vertex:${j > i ? j - 1 : j}`; }
        m = /^side:(\d+)$/.exec(a);
        if (m) { const j = +m[1]; return touching.has(j) ? null : `side:${j > i ? j - 1 : j}`; }
        if ((a === "start" && i === 0) || (a === "end" && i === n - 1)) return null;
        return a;
    };
    return (list) => list.flatMap((k) => {
        const refs = (k.refs ?? []).map((r) => r.curve === c.id ? { ...r, at: at(r.at) } : r);
        return refs.some((r) => r.at === null) ? [] : [{ ...k, refs }];
    });
}
const bump = (id) => { nextId = Math.max(nextId, id + 1); };
// The constraint overlay's pass (`drawConstraintOverlay`) looks its curves up in one index
// made for the pass, and memoises what is shown; outside a pass both are null.
let overlayIndex = null, shownNow = null;
function byId(id) {
    if (overlayIndex) return overlayIndex.get(id);
    return curves.find((c) => c.id === id);
}
// The item `id` when it is of the kind `is` tests (an id names one item), else undefined.
const byIdAs = (id, is) => { const c = byId(id); return c && is(c) ? c : undefined; };
const blankCurve = () => ({ sketch: new Float32Array(0), beziers: new Float32Array(0), bounds: null, error: null, dirty: true, hidden: false });
const blankBody = () => ({ gpu: null, bounds: null, ghostFaces: 0, version: null, error: null, dirty: false, sig: null, hidden: false, key: null, wantKey: null, place: { offset: [0, 0, 0], turn: [0, 0, 0] } });
// The bodies' results as the worker last answered for them, by id: the table, the version,
// the key it was built under, the error. Kept apart from the items so a body taken out and
// put back (an undo, a redo) shows what it had; dropped only on the worker's `forgotten`.
const bodyResults = new Map();   // id -> { kind, key, gpu, version, bounds, closure, error, ghostFaces }
const BODY_RESULT_KEYS = ["key", "gpu", "version", "bounds", "closure", "error", "ghostFaces"];
// A body is out in the worker while the key the document gives its node (`wantKey`, off the
// page's cheap evaluation) is not the key the worker last answered under (`key`).
const bodyPending = (c) => isBody(c) && worker !== null && (c.wantKey ?? null) !== null && c.key !== c.wantKey;
// The commands that read built geometry wait for the bodies they read in the worker: the
// tools wait for theirs (`whenBuilt`) before they look at a body's table.
function waitedBodies(ids) {
    return curves.filter((c) => isBody(c) && ((ids === null ? !isMade(c) : ids.includes(c.id))
        || curves.some((k) => isSketch(k) && k.mode === "face" && k.face?.body === c.id)));
}
const unsettled = (ids) => waitedBodies(ids).some(bodyPending);
// Resolves once the bodies `ids` (null: every body that is not made) and every body with a
// sketch on one of its faces are answered for. Null when none is out, so a caller can stay
// synchronous.
const settledWaiters = [];
function whenBuilt(ids = null) {
    if (curves.some((c) => c.dirty)) rebuild();
    if (!unsettled(ids)) return null;
    return new Promise((resolve) => settledWaiters.push({ ids, resolve }));
}
// Called after every rebuild pass and every worker answer.
function wakeSettled() {
    for (let i = settledWaiters.length - 1; i >= 0; i--) {
        const w = settledWaiters[i];
        if (!unsettled(w.ids)) { settledWaiters.splice(i, 1); w.resolve(); }
    }
}
const applied = [];   // under ?test: "op:id" of each command as it is applied
// The command applied in its turn. The images are the page's alone; a merged run (its
// document share, `rest`) is held (`pendingRun`); anything else is committed. A command that
// is not merged commits the pending run first, so an image action stands after it in the
// undo order.
function apply(cmd, merge = false) {
    if (testMode) applied.push(`${cmd.op}:${cmd.id}`);
    if (!merge) flushPending();
    const rest = applyImages(cmd, merge);
    if (rest === null) { renderList(); schedule(); return undefined; }
    if (merge) {
        joinable = null;   // a merged run's images are a step of their own, the run committed later
        const p = pendingRun?.cmd;
        const folds = p && (merge === "replace" || (merge === true && p.op === "set" && rest.op === "set" && p.id === rest.id && Object.keys(p).join() === Object.keys(rest).join()));
        if (!folds) flushPending();
        pendingRun = { cmd: rest };
        applyInPlace(rest);
        renderList(); renderTimeline(); schedule();
        return undefined;
    }
    // An action that changed images and items is one undo step: its image entry joined to
    // the commit it makes (`undoOrder.join`), once that commit lands.
    const entry = rest !== cmd ? joinable : null;
    joinable = null;
    const out = commit(rest);
    const join = (ok) => { if (ok && entry) undoOrder.join(entry); return ok; };
    return out && typeof out.then === "function" ? out.then(join) : join(out);
}
let joinable = null;   // the undo entry `applyImages` just made, for the commit of the same command
// The pending run committed, if there is one. A merged run (a set of sizes, a look, a typed
// shape) never needs built geometry, so it commits here and now.
function flushPending() {
    if (!pendingRun) return;
    const { cmd } = pendingRun;
    pendingRun = null;
    commit(cmd, { here: true });
}
// One command committed on the page's replica and sent to the worker as the op it gave. A
// command the document refuses changes nothing: the items are put back as the document has
// them, and the status line says why. One that needs built geometry (a pick without its
// references, a new face plane: `commandNeedsGeometry`) is made an op on
// the worker, whose replica is evaluated (`commitResolved`): the page's replica evaluates
// the cheap kinds only, and never runs the kernel's heavy work on the page's thread. `here`:
// on the page, whatever it needs (a pending run, which never needs any). With no worker, such
// a command is refused (`commitResolved`), never evaluated on the page.
function commit(cmd, { here = false } = {}) {
    endPreview();
    let remote = false;
    if (!here) {
        try { remote = forgeDoc.commandNeedsGeometry(wasm, doc, cmd); } catch { remote = false; }   // a refusal is the command's own, below
    }
    if (remote) return commitResolved(cmd);
    let out;
    try {
        out = forgeDoc.command(wasm, doc, cmd);
    } catch (error) {
        afterChange();
        refuse(String(error?.message ?? error));
        return false;
    }
    toWorker({ kind: "op", op: forgeDoc.toJson(out.op) });
    committed(cmd);
    return true;
}
// A command made an op on the worker's replica (`resolve`), then applied on the page's as
// that op and sent back to the worker as any op is. The order holds every other command and
// action meanwhile, so both replicas stand where they stood when it was asked.
async function commitResolved(cmd) {
    const answer = await resolveOnWorker(cmd);
    if (!answer || answer.error !== undefined) {
        afterChange();
        refuse(answer ? String(answer.error) : "the forge worker is not running -- what needs a built body cannot be made");
        return false;
    }
    endPreview();   // a frame previewed while the answer was out
    try { wasm.cadaclysm_blacksmith_document_apply(doc, answer.op, undefined); }
    catch (error) { afterChange(); refuse(String(error?.message ?? error)); return false; }
    toWorker({ kind: "op", op: answer.op });
    committed(cmd);
    return true;
}
let resolveReq = 0;
const resolvesOut = new Map();   // req -> resolve
function resolveOnWorker(cmd) {
    if (!worker) return Promise.resolve(null);
    const req = ++resolveReq;
    worker.postMessage({ kind: "resolve", req, cmd });
    return new Promise((resolve) => resolvesOut.set(req, resolve));
}
// After a commit: the image redos past it go, and everything is read again. The command is
// kept with the commit it made (`lastCommitted`): the document's log names only its op, and
// A browser test can read the whole command off the page.
let lastCommitted = null;   // { at, cmd }: the last command committed, `at` the commit it made
function committed(cmd) {
    undoOrder.committed();
    afterChange();
    lastCommitted = { at: headCommit, cmd: structuredClone(cmd) };
}
// The fields of a `set` or an `edit` put on the page's items in place, as the document's
// own `set` puts them: what a pending run shows before it is committed.
function applyInPlace(cmd) {
    if (cmd.op === "edit") { editItems(cmd.items); return; }
    if (cmd.op !== "set") return;
    const c = byId(cmd.id);
    if (!c) return;
    for (const [k, v] of Object.entries(cmd)) {
        if (k === "op" || k === "id" || k === "sketchConstraints" || k === "sketchEdits") continue;
        c[k] = structuredClone(v);
    }
    if (isSketch(c)) { for (const k of curves) if (k.plane === c.id) k.dirty = true; }
    else if (!("name" in cmd && Object.keys(cmd).length === 3) && !("hidden" in cmd && Object.keys(cmd).length === 3) && !("look" in cmd && Object.keys(cmd).length === 3)) c.dirty = true;
}
// An `edit`'s items, `{ id, ...fields }`, set on their items.
function editItems(items) {
    for (const it of items) {
        const c = byId(it.id);
        if (!c) continue;
        for (const [k, v] of Object.entries(it)) if (k !== "id") c[k] = structuredClone(v);
        // A sketch's constraints build nothing: its curves' shapes come with them.
        if (Object.keys(it).some((k) => k !== "id" && k !== "hidden" && k !== "look" && k !== "constraints")) c.dirty = true;
    }
}
// The images' share of a command, applied here (they are never in the document): the
// command left for the document, or null when nothing of it is the document's. What it did
// to the images is one step of the undo order (`undoOrder`); a merged run's steps fold into
// one, and a new image action leaves the document's redo tail behind, as a commit does.
function applyImages(cmd, merge = false) {
    joinable = null;
    const ids = [cmd.id, ...(cmd.ids ?? []), ...(cmd.items ?? []).map((it) => it.id)];
    if (cmd.op !== "image" && !ids.some((id) => isImage(byId(id)))) return cmd;   // nothing of it is an image's
    const before = imageSnapshot();
    const rest = applyImagesNow(cmd);
    const after = imageSnapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
        if (dropDocRedo()) afterChange();
        const key = merge ? JSON.stringify([cmd.op, cmd.id ?? null, Object.keys(cmd)]) : null;
        joinable = undoOrder.did({ undo: () => setImages(before), redo: () => setImages(after), key });
    }
    return rest;
}
// The images as they are now, copied; and put back so.
const imageSnapshot = () => curves.filter(isImage).map((c) => structuredClone({ ...c, beziers: undefined }));
function setImages(list) {
    curves = [...curves.filter((c) => !isImage(c)), ...list.map((c) => ({ ...structuredClone(c), beziers: new Float32Array(0) }))];
    for (const c of curves) bump(c.id);
    setSelection(selection);
}
// The document's redo tail left unnamed on both replicas (`dropRedo`): true when there was one.
// A partial failure reopens the worker from the page's save, so the two never part.
function dropDocRedo() {
    try {
        if (!dropRedo(wasm, doc)) return false;
        toWorker({ kind: "dropRedo" });
        return true;
    } catch (error) {
        console.error("forge: dropRedo:", error);
        openWorkerReplica();
        return true;
    }
}
function applyImagesNow(cmd) {
    const isImageId = (id) => isImage(byId(id));
    switch (cmd.op) {
    case "image": {
        bump(cmd.id);
        const n = curves.filter(isImage).length + 1;
        curves.push({ id: cmd.id, name: `${LABELS.image} ${n}`, kind: "image", plane: cmd.plane, src: cmd.src, aspect: cmd.aspect,
                      width: cmd.width, at: [0, 0], angle: 0, opacity: 0.6, flipX: false, flipY: false,
                      beziers: new Float32Array(0), bounds: null, error: null, dirty: false, hidden: false });
        decodeImage(cmd.id, cmd.src);
        return null;
    }
    case "set":
        if (!isImageId(cmd.id)) return cmd;
        applyInPlace(cmd);
        return null;
    case "edit": {
        const mine = cmd.items.filter((it) => isImageId(it.id));
        if (!mine.length) return cmd;
        editItems(mine);
        const items = cmd.items.filter((it) => !isImageId(it.id));
        return items.length ? { ...cmd, items } : null;
    }
    case "delete": {
        const mine = new Set(cmd.ids.filter(isImageId));
        if (!mine.size) return cmd;
        curves = curves.filter((c) => !mine.has(c.id));
        const ids = cmd.ids.filter((id) => !mine.has(id));
        return ids.length ? { ...cmd, ids } : null;
    }
    case "duplicate": {
        const keep = cmd.ids.map((id) => !isImageId(id));
        if (keep.every((k) => k)) return cmd;
        cmd.ids.forEach((id, k) => {
            if (keep[k]) return;
            const c = byId(id), copyId = cmd.copies[k];
            bump(copyId);
            const copy = { ...c, id: copyId, name: `${c.name} copy`, at: c.at.slice() };
            if (imageBitmaps.has(c.id)) setImageBitmap(copyId, imageBitmaps.get(c.id));
            curves.splice(curves.indexOf(c) + 1, 0, copy);
        });
        return keep.some((k) => k) ? { ...cmd, ids: cmd.ids.filter((_, k) => keep[k]), copies: cmd.copies.filter((_, k) => keep[k]) } : null;
    }
    default: return cmd;
    }
}
// An item the document gave, as the page holds it: the runtime fields a new one starts
// with -- a body's from what the worker last answered for its id -- then the document's.
function freshItem(it) {
    const blank = isBody(it) ? blankBody() : isSketch(it) ? { beziers: new Float32Array(0), bounds: null, error: null, dirty: false } : blankCurve();
    // Only the runtime fields: a document field the item lacks is not the page's to add
    // (it would read as an edit to preview, `localEdits`).
    const c = Object.fromEntries(Object.entries(blank).filter(([k]) => RUNTIME_KEYS.has(k) && !(k in it)));
    Object.assign(c, it);
    const kept = isBody(c) ? bodyResults.get(c.id) : undefined;
    if (kept && kept.kind === c.kind) for (const k of BODY_RESULT_KEYS) if (k in kept) c[k] = kept[k];
    if (isSketch(c)) c.sig = null;
    return c;
}
// Item `c` made what the document says it is, in place: its document fields replaced, its
// runtime ones kept; a curve whose definition changed is built again.
function refreshItem(c, it) {
    const was = isCurve(c) ? JSON.stringify([c.kind, c.plane, c.shape]) : null;
    for (const k of Object.keys(c)) if (!RUNTIME_KEYS.has(k) && !(k in it)) delete c[k];
    Object.assign(c, it);
    delete c.local;   // the curve drawn, now the document's
    if (was !== null && (!isCurve(c) || JSON.stringify([c.kind, c.plane, c.shape]) !== was)) c.dirty = true;
    return c;
}
// The page's items made again from the document's (`documentItems`; `items`: those given
// instead), in place: the images, and the curve being drawn (`local`, added when it is done),
// stay.
function syncItems(items = forgeDoc.documentItems(wasm, doc).toLit()) {
    baseItems = new Map(items.map((it) => [it.id, JSON.parse(JSON.stringify(it))]));
    const old = new Map(curves.map((c) => [c.id, c]));
    const next = items.map((it) => {
        const c = old.get(it.id);
        return c && !isImage(c) && (isBody(c) === isBody(it)) ? refreshItem(c, it) : freshItem(it);
    });
    // An image on a sketch the document no longer has goes with it.
    const planes = new Set(items.filter(isSketch).map((k) => k.id));
    for (const c of curves) {
        if (baseItems.has(c.id)) continue;
        if (isImage(c) && (typeof c.plane !== "number" || planes.has(c.plane))) next.push(c);
        else if (c.local && drawing?.id === c.id) next.push(c);
    }
    curves = next;
    for (const c of curves) bump(c.id);
    for (const s of curves.filter(isSketch)) if (s.sig === null) s.sig = frameSig(s.id);
}
// The document's cheap evaluation (curves, sketches, frames; the bodies pending): each body's
// key as the document has it now (`wantKey`, what the worker's answer must carry), and each
// curve's and sketch's own error.
let progressTimer = null;
function readStatuses() {
    let statuses;
    try { statuses = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, true)); }
    catch (error) { console.error("forge: the cheap evaluation failed:", error); return; }
    const byNode = new Map(statuses.map((s) => [s.id, s]));
    const now = performance.now();
    let out = false;
    for (const c of curves) {
        if (isImage(c) || c.local) continue;
        const st = byNode.get(`i${c.id}`);
        if (isBody(c)) {
            const want = st?.key ?? null;
            if (want !== (c.wantKey ?? null)) { c.wantKey = want; c.jobAt = now; }
            out ||= bodyPending(c);
        } else {
            const error = st?.state === "error" ? st.error : null;
            if (error !== (c.docError ?? null)) { c.docError = error; if (isCurve(c)) c.dirty = true; }
            if (isSketch(c)) c.error = error;
        }
    }
    if (out && progressTimer === null) progressTimer = setTimeout(() => { progressTimer = null; renderProgress(); }, PROGRESS_AFTER_MS + 5);
    // A quarantined node whose item's key moved (an edit, an undo) is tried again.
    if (quarantine.refresh((id) => byId(id)?.wantKey ?? null)) toWorker({ kind: "skip", nodes: quarantine.nodes() });
}
// The commits on the line the head is on, root first (the root left out), and where the head
// stands among them: the timeline's chips and its count.
function syncHistory() {
    const info = JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(doc));
    const line = JSON.parse(wasm.cadaclysm_blacksmith_document_log(doc, info.branch ?? undefined)).reverse();
    const commits = line.filter((row) => row.parents.length);
    history = commits.map(commitInfo);
    head = commits.findIndex((row) => row.id === info.head) + 1;
    headCommit = info.head;
}
// A commit as the timeline reads it: the forge command it was (its message, `forge: <op>`),
// the items it made, the items whose nodes it changed, and the items it took out.
function commitInfo(row) {
    const op = /^forge: (\S+)/.exec(row.message ?? "")?.[1] ?? "";
    const top = (id) => { const m = /^i(\d+)$/.exec(id ?? ""); return m ? Number(m[1]) : null; };
    const ops = row.ops?.length === 1 && row.ops[0].op === "batch" ? row.ops[0].ops : row.ops ?? [];
    const added = [], touched = new Set(), removed = [];
    for (const o of ops) {
        if (o.op === "add") { const id = top(o.node?.id); if (id !== null) added.push(id); else if (itemOfNode(o.node?.id) !== null) touched.add(itemOfNode(o.node.id)); }
        else if (o.op === "remove") { const id = top(o.id); if (id !== null) removed.push(id); else if (itemOfNode(o.id) !== null) touched.add(itemOfNode(o.id)); }
        else if (itemOfNode(o.id) !== null) touched.add(itemOfNode(o.id));
    }
    return { id: row.id, op, added, touched: [...touched].filter((id) => !added.includes(id)), removed };
}
// After the document changed: the history, the items and the keys read again, and
// everything that shows them told. `reset` (an undo, a redo, a rollback, a switch, a load):
// a tool's mode, a pick and the sketches' sessions are of the document that was, and go.
function afterChange({ reset = false } = {}) {
    reopens = 0;   // the document changed: an evaluation that failed may not fail now
    if (reset) {
        resets++;
        freeModels();   // the sessions are of a document that is about to change under them
        selectedDim = null;   // its ids may name another record now
        pendingNotice = null;   // a drag's notice is its own: an undo's build never carries it
        if (drawing) { drawing = null; endDrawingMode(); }
        setAxisMode(null); setPicking(null); setShellMode(null); setTrimMode(null); setFilletMode(null); sketchTrim = null; sketchTrimEl.setAttribute("aria-pressed", "false");
        for (const v of VIEW_PLANE_KEYS) lookAway(v);
    }
    syncHistory();
    syncItems();
    readStatuses();
    // A view looking at a sketch that is gone looks at its origin plane again.
    for (const v of VIEW_PLANE_KEYS) if (typeof viewPlane[v] === "number" && !byIdAs(viewPlane[v], isSketch)) lookAway(v);
    freeStaleModels();
    // Any change may change what a sketch's diagnosis reads (its curves, its records).
    for (const c of curves) if (isSketch(c)) touchSketch(c.id);
    if (reset) setSelection(selection);   // what still exists of it
    renderList();
    renderTimeline();
    schedule();
    wakeSettled();
}
// The page's items where they differ from the document's (a drag in progress, a pending
// run, a typed field's in-place value): an `edit`'s items, `{ id, ...fields }`.
function localEdits() {
    const out = [];
    for (const c of curves) {
        if (c.local || isImage(c)) continue;
        const it = baseItems.get(c.id);
        if (!it) continue;
        let edit = null;
        for (const k of Object.keys(c)) {
            if (RUNTIME_KEYS.has(k) || c[k] === undefined) continue;
            if (JSON.stringify(c[k]) !== JSON.stringify(it[k])) (edit ??= { id: c.id })[k] = structuredClone(c[k]);
        }
        // A document field the page took off the item: previewed as null, the edit's unset.
        for (const k of Object.keys(it)) if (!RUNTIME_KEYS.has(k) && c[k] === undefined && it[k] !== null) (edit ??= { id: c.id })[k] = null;
        if (edit) out.push(edit);
    }
    return out;
}
// The page's items previewed on both replicas where they differ from the document's (the
// frame of a drag, a pending run): an `edit` command's op, applied unrecorded in place of
// the last frame's. Nothing differing, the preview ends. Called by every rebuild.
function livePreview() {
    if (doc === null) return;
    const items = localEdits();
    const sig = items.length ? JSON.stringify(items) : null;
    if (sig === previewSig) return;
    endPreview();
    if (sig === null) return;
    previewSig = sig;   // a refused frame is not asked again until the items move on
    let op;
    try {
        op = forgeDoc.toJson(forgeDoc.commandOp(wasm, doc, { op: "edit", items }));
        wasm.cadaclysm_blacksmith_document_preview(doc, op);
    } catch (error) {
        console.error("forge: the preview was refused:", error);
        return;
    }
    previewOp = op;
    toWorker({ kind: "preview", op });
    readStatuses();
}
// The preview ended on both replicas: before a commit, an undo or a switch, and when a drag
// ends with nothing to commit.
function endPreview() {
    previewSig = null;
    if (previewOp === null) return;
    previewOp = null;
    try { wasm.cadaclysm_blacksmith_document_end_preview(doc); } catch (error) { console.error("forge: end_preview:", error); }
    toWorker({ kind: "endPreview" });
    readStatuses();
}
// One step of the document's own history on both replicas: `undo` or `redo` (true when it
// moved). A refusal says why.
function step(kind) {
    flushPending();
    endPreview();
    let changed;
    try { changed = kind === "undo" ? wasm.cadaclysm_blacksmith_document_undo(doc) : wasm.cadaclysm_blacksmith_document_redo(doc); }
    catch (error) { say(`${kind}: ${error?.message ?? error}`, true); return false; }
    if (changed === "null") return false;
    toWorker({ kind });
    return true;
}
// The history cut back to `to` and the document made again from it: a tool's Cancel. The
// commits taken back are left unnamed (`dropRedo`), so a redo does not bring them back.
function rollbackTo(to) {
    return act(async () => {
        flushPending();
        let moved = false;
        while (head > +to && step("undo")) { moved = true; head--; }
        // The session's image actions taken back too, and forgotten, with the image redos (as
        // the document's redo tail goes below).
        if (to?.images !== undefined) { const any = undoOrder.since(to.images); undoOrder.popTo(to.images); if (any) { renderList(); schedule(); } }
        endPreview();   // a branch switch refuses while a preview is open
        dropDocRedo();
        afterChange({ reset: moved });
    });
}
// The document switched to branch `to` (a name, else a commit id) on both replicas: the
// history's own move, as an undo is. The page has no control for it yet; the ?test hook
// drives it. True when the document took it.
function switchBranch(to) {
    return act(async () => {
        flushPending();
        endPreview();   // a switch refuses while a preview is open
        // A tool session or a pick left open belongs to the line that was: dropped, as a load
        // drops it, or its Cancel would roll back by commit count on another line.
        tool = null;
        disarmSketchPick();
        try { wasm.cadaclysm_blacksmith_document_branch_switch(doc, to); }
        catch (error) { say(`switch: ${error?.message ?? error}`, true); return false; }
        toWorker({ kind: "switch", branch: to });
        afterChange({ reset: true });
        say(`switched · ${head} of ${history.length}`);
        return true;
    });
}
// Undo and redo in the order the user acted (`undoOrder`): an image action is taken back here,
// a commit by the document's own undo on both replicas. The document steps first (`step`,
// handed to the order), and the images of a joined step move only once it did: a refused
// step leaves the images and the order as they were.
function undo() {
    return act(async () => {
        flushPending();
        const which = undoOrder.undo(() => step("undo"));   // "joined": the commit, then the images
        if (which === null) return;
        if (which === "image") { renderList(); schedule(); say("undone · an image"); return; }
        if (which === "joined") { renderList(); schedule(); }
        afterChange({ reset: true });
        say(`undone · ${head} of ${history.length}`);
    });
}
function redo() {
    return act(async () => {
        flushPending();
        const which = undoOrder.redo(() => step("redo"));
        if (which === null) return;
        if (which === "image") { renderList(); schedule(); say("redone · an image"); return; }
        if (which === "joined") { renderList(); schedule(); }
        afterChange({ reset: true });
        say(`redone · ${head} of ${history.length}`);
    });
}
// The references to the faces or edges `indices` of body `id` (`what` "faces", the solid's
// B-rep faces as the View picks them, or "edges"), asked of the worker, whose replica has built it: a promise
// of the list, or of null where the worker cannot answer (the command then goes without
// them, and the document finds them itself). `id` may name a node (a trim's `i<n>_split`).
let pickReq = 0;
const picksOut = new Map();   // req -> resolve
function refsOf(id, what, indices) {
    if (!indices.length) return Promise.resolve([]);
    if (!worker) return Promise.resolve(null);
    const req = ++pickReq;
    worker.postMessage({ kind: "pick", req, id, what, indices: [...indices] });
    return new Promise((resolve) => picksOut.set(req, (data) => {
        if (data.error !== undefined) { console.warn(`forge: the pick of ${what} on ${id}: ${data.error}`); resolve(null); }
        else resolve(data.refs);
    }));
}
// The selection: curve ids in the order they were selected, the last of them the *active*
// curve -- the one the toolbar edits, whose points are picked, and that add point grows.
// Every selected curve wears the accent and shows its handles, so a tool that wants
// several curves (a surface over a loop of them) can be given them; `selected` is the
// active id, or null. Plain click in the panel selects one, ctrl/cmd-click toggles one,
// shift-click takes the range from the active row, ctrl/cmd-A takes every curve.
let selection = [];
let selected = null;
let selectedPoint = null;   // an index into the active NURBS's or polyline's points, or null
const LABELS = { held: "Body", held_profile: "Profile", image: "Image", line: "Line", polyline: "Polyline", rect: "Rectangle", circle: "Circle", arc: "Arc", ellipse: "Ellipse", polygon: "Polygon", nurbs: "NURBS", polycurve: "Polycurve", surface: "Surface", extrusion: "Extrusion", revolution: "Revolution", solid: "Solid", sweep: "Sweep", loft: "Loft", join: "Join", cut: "Cut", intersect: "Intersect", chamfer: "Chamfer", shell: "Shell", thicken: "Thicken", trim: "Trim", prism: "Solid", press: "Press Pull", refillet: "Refillet", rechamfer: "Rechamfer", remove: "Remove", fillet: "Fillet", sketch: "Sketch", face: "Face",
                 box: "Box", cylinder: "Cylinder", sphere: "Sphere", cone: "Cone", pyramid: "Pyramid", torus: "Torus", coil: "Coil", pipe: "Pipe", split: "Split" };
const GLYPHS = { image: "▧", line: "╱", polyline: "⌇", rect: "□", circle: "○", arc: "◜", ellipse: "⬭", polygon: "⬡", nurbs: "~", polycurve: "⌁", surface: "▣", extrusion: "⬢", revolution: "◍", solid: "◆", sweep: "↝", loft: "⌬", join: "◈", cut: "◩", intersect: "◪", shell: "◫", thicken: "▰", trim: "◧", prism: "◆", press: "⇕", refillet: "◡", rechamfer: "◺", remove: "⌫", fillet: "◠", sketch: "✎", face: "▱", box: "▣", cylinder: "▯", sphere: "●", cone: "▲", pyramid: "◭", torus: "◎", coil: "§", pipe: "⌒", split: "⫽" };
// A kind's icon (the sprite in forge.html), or its glyph as text where there is none.
const ICONS = new Set(["image", "snip", "line", "polyline", "rect", "circle", "arc", "ellipse", "polygon", "nurbs", "polycurve", "surface", "extrusion", "revolution", "solid", "sweep", "loft", "join", "cut", "intersect", "shell", "thicken", "trim", "prism", "fillet", "sketch", "folder", "closed", "round", "merge", "explode", "box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil", "pipe", "split"]);
function iconOf(kind, glyph = GLYPHS[kind] ?? "•") {
    if (!ICONS.has(kind)) { const span = document.createElement("span"); span.textContent = glyph; return span; }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${kind}`);
    svg.append(use);
    return svg;
}
const pointed = (c) => c?.kind === "nurbs" || c?.kind === "polyline";
const isBody = (c) => c?.kind === "surface" || c?.kind === "extrusion" || c?.kind === "revolution" || c?.kind === "solid" || c?.kind === "sweep" || c?.kind === "loft" || isMade(c);
// The bodies a join or a shell takes: closed ones (a revolution of an open curve is a
// sheet, and the kernel says so when asked).
// Another app's body in the document (a `solid.body` or `sheet.body` node, `node` its id):
// forge lists it, shows it, moves it, and takes it into its tools like a body of its own. A
// held profile (`profile.path`) is listed and kept, not drawn, and no curve a tool takes.
const isHeld = (c) => c?.kind === "held";
const isHeldProfile = (c) => c?.kind === "held_profile";
const isSolid = (c) => (isHeld(c) && !c.sheet) || c?.kind === "solid" || (c?.kind === "revolution" && c.sheet === false) || (c?.kind === "sweep" && !c.sheet) || (c?.kind === "loft" && !c.sheet) || c?.kind === "join" || c?.kind === "cut" || c?.kind === "intersect" || c?.kind === "shell" || c?.kind === "thicken" || c?.kind === "prism" || c?.kind === "press" || c?.kind === "refillet" || c?.kind === "rechamfer" || c?.kind === "remove" || c?.kind === "fillet"
    || isQuickKind(c?.kind) || c?.kind === "pipe" || c?.kind === "split";
// A body meant to be solid whose B-rep the kernel says is not closed: the browser's amber
// dot.
const notClosed = (c) => isSolid(c) && c.error === null && !!c.closure && !c.closure.closed;
// A body made of other bodies' definitions (a join, a shell), its solid built once
// and kept, and moved by the gizmo as a rigid whole.
const isMade = (c) => c?.kind === "join" || c?.kind === "cut" || c?.kind === "intersect" || c?.kind === "shell" || c?.kind === "thicken" || c?.kind === "trim" || c?.kind === "prism" || c?.kind === "press" || c?.kind === "refillet" || c?.kind === "rechamfer" || c?.kind === "remove" || c?.kind === "fillet" || c?.kind === "face"
    || isQuickKind(c?.kind) || c?.kind === "pipe" || c?.kind === "split" || isHeld(c);
// The quick solids' sizes, in the order the kernel takes them, as the dialog names them,
// and what a new one starts with; a pipe's radius and wall (zero for a rod) likewise.
const DIMS = {
    box: { labels: ["width", "depth", "height"], start: [20, 20, 20] },
    cylinder: { labels: ["radius", "height"], start: [10, 20] },
    sphere: { labels: ["radius"], start: [10] },
    cone: { labels: ["radius", "height"], start: [10, 20] },
    pyramid: { labels: ["sides", "radius", "height"], start: [4, 10, 20] },
    torus: { labels: ["radius", "tube"], start: [15, 4] },
    coil: { labels: ["radius", "wire", "pitch", "turns"], start: [15, 2, 8, 4] },
    pipe: { labels: ["radius", "wall"], start: [2, 0] },
};
// Whether the face a `face` item took is on a cylinder, a cone, a sphere or a torus -- its
// solid's patch record says (kind 1 to 4) -- so extruding it presses the solid rather than
// raising a prism.
// The radius of the round the face a `face` item took belongs to -- the kernel said, as
// its solid was drawn (`rounds`) -- or 0 where it is no round (then a press or a prism,
// as its kind).
const roundOf = (face) => face?.kind === "face" ? byId(face.parts?.[0])?.gpu?.rounds?.[face.face] ?? 0 : 0;
// The distance of the chamfer the face belongs to, read the same way, or 0.
const chamferOf = (face) => face?.kind === "face" ? byId(face.parts?.[0])?.gpu?.chamfers?.[face.face] ?? 0 : 0;
const onTurned = (face) => {
    const kind = byId(face?.parts?.[0])?.gpu?.faceKinds?.[face.face];
    return face?.kind === "face" && kind >= 1 && kind <= 4;
};
// A sheet: a body with no inside -- a surface, a curve's sweep, or a trim of one. What
// a trim cuts (a trim of a trim cuts it further).
const isSheet = (c) => c?.kind === "surface" || c?.kind === "extrusion" || (c?.kind === "revolution" && c.sheet !== false) || c?.kind === "trim" || c?.kind === "face" || (c?.kind === "sweep" && c.sheet) || (c?.kind === "loft" && c.sheet) || (isHeld(c) && c.sheet);
const isSketch = (c) => c?.kind === "sketch";
// A reference image on a plane: drawn under the sketch to trace over, no geometry, and
// not saved with the document (`documentJson` leaves it out).
const isImage = (c) => c?.kind === "image";
const isCurve = (c) => c !== null && c !== undefined && !isBody(c) && !isSketch(c) && !isImage(c) && !isHeldProfile(c);
// Whether an item shows in the views: not hidden itself, and not on a hidden sketch (a
// sketch hidden takes everything on it with it). A hidden item is still in the
// document -- it builds, its loops still close -- it is just not drawn or clicked.
// Shown: not hidden itself, nor a curve on a hidden sketch -- a body keeps its sketch's
// id as its plane, but a sketch hidden (its eye, or consumed by the body's own profile)
// takes only its curves with it -- and not the tool of a trim whose
// pieces are being picked, which would stand in front of the pieces within it.
// A consumed input is still drawn while the body that consumed it has nothing to show
// yet -- a shell or a join out in the worker, or one that failed to build at all: the
// scene keeps the solid it started from rather than going empty till the result lands.
const consumes = (b, id) => b.parts?.includes(id) || b.from === id || b.to?.from === id || (b.via?.some((v) => v.from === id) ?? false) || b.path === id || (b.loops?.flat().includes(id) ?? false);
const awaited = (c) => curves.some((b) => isBody(b) && !b.gpu && consumes(b, c.id));
const onHiddenSketch = (c) => (isCurve(c) || isImage(c)) && !!byIdAs(c.plane, isSketch)?.hidden;
const visible = (c) => (!c.hidden || awaited(c) || (filletMode && filletMode.body.tool === c.id)) && (!onHiddenSketch(c) || awaited(c)) && !(trimMode && trimMode.body.tool === c.id) && !(filletMode && filletMode.body === c);
// `visible`, memoised per curve during the constraint overlay's pass (`shownNow`).
function shownOf(c) {
    if (!shownNow) return visible(c);
    let v = shownNow.get(c);
    if (v === undefined) shownNow.set(c, v = visible(c));
    return v;
}
let nextId = 1;

const current = () => curves.find((c) => c.id === selected) ?? null;
const isSelected = (c) => selection.includes(c.id);
const selectedCurves = () => curves.filter(isSelected);

// Drawing a curve: the tool is picked in the ribbon, then the points are
// clicked in a view, the curve following the pointer between clicks -- a line's two
// ends; a rectangle's two corners; a circle's centre then a rim point; a polygon's
// centre then a vertex (its size and its turn); an ellipse's centre then a corner of
// its box; an arc's start, its end, then a point it passes through; a polyline's or a
// spline's points one after another, Enter (or a right click, or a double click)
// ending it and a click back on its first point closing it. Esc drops what was begun.
// The curve is added to the document at the first click (in the plane of the view
// clicked) and its shape recorded once, when it is done. `drawing` holds the tool in
// hand: its kind, the curve's id once begun, the stage the clicks are at.
let drawing = null;
function startDrawing(kind) {
    if (drawing?.kind === kind && drawing.id === null) { cancelDrawing(); return; }
    if (drawing) cancelDrawing();
    if (tool) commitTool();
    drawing = { kind, id: null, stage: 0, openedAt: headNow(), snaps: [] };
    // A view to draw in: the one filling the area, or the sketch plane's when that is
    // Perspective.
    if (maximized === 1) setMaximized(viewOf(sketchPlane()) ?? 0);
    for (const b of document.querySelectorAll("#ribbon-sketch button[data-kind]")) b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
    overlay.style.cursor = "crosshair";
    hintEl.textContent = drawingHint();
    renderDialog();
    overlayDirty();   // a mark hovered till now is let go (drawOverlay) without waiting for the pointer
}
function drawingHint() {
    const { kind, stage } = drawing;
    const view = drawing.id !== null ? NAMES[viewOf(byId(drawing.id).plane) ?? 0] : "a view";
    const first = { line: "the start", rect: "the first corner", circle: "the centre", polygon: "the centre", ellipse: "the centre", arc: "the start", polyline: "the first point", nurbs: "the first point" }[kind];
    if (stage === 0) return `click ${first} in ${view} · Esc cancels`;
    if (kind === "line") return "click the end · ends snap onto other ends · Esc cancels";
    if (kind === "rect") return "click the opposite corner · Esc cancels";
    if (kind === "circle") return "click a point on the rim · Esc cancels";
    if (kind === "polygon") return "click a vertex: its distance is the size, its direction the turn · sides in the dialog · Esc cancels";
    if (kind === "ellipse") return "click a corner of the box round it · Esc cancels";
    if (kind === "arc") return stage === 1 ? "click the end · then a point the arc passes through · Esc cancels" : "click a point the arc passes through · Esc cancels";
    return "click the next point · click the first point again to close · Enter, a right click or a double click ends it · Esc cancels";
}
const near = (p, q, plane) => { const size = sizeOf(viewOf(plane)); const a = sketchToLocal(plane, p, size), b = sketchToLocal(plane, q, size); return Math.hypot(a[0] - b[0], a[1] - b[1]) <= SNAP_PX; };
// The shape a click begins: everything at the point, an arc a hair off a line (three
// points in a line are no arc).
function beginShape(kind, [x, y]) {
    if (kind === "line") return { x0: x, y0: y, x1: x, y1: y };
    if (kind === "rect") return { x0: x, y0: y, x1: x, y1: y };
    if (kind === "circle") return { cx: x, cy: y, r: 0.5 };
    if (kind === "polygon") return { cx: x, cy: y, r: 0.5, sides: 6, angle: 0 };
    if (kind === "ellipse") return { cx: x, cy: y, rx: 0.5, ry: 0.5 };
    if (kind === "arc") return { x0: x, y0: y, xm: x + 0.5, ym: y + 0.05, x1: x + 1, y1: y };
    if (kind === "polyline") return { points: [[x, y], [x, y]], closed: false };
    return { points: [[x, y], [x, y]], weights: [1, 1], degree: 3, closed: false };
}
// The pointer at `w`, in the sketch plane, while a curve is being drawn: the shape
// follows it -- the part the next click will fix.
function drawMove(w) {
    const c = byId(drawing.id);
    if (!c) return;
    const s = c.shape, { kind, stage } = drawing;
    if (kind === "line" || kind === "rect") { s.x1 = w[0]; s.y1 = w[1]; }
    else if (kind === "circle") s.r = Math.max(0.5, Math.hypot(w[0] - s.cx, w[1] - s.cy));
    else if (kind === "polygon") { s.r = Math.max(0.5, Math.hypot(w[0] - s.cx, w[1] - s.cy)); if (s.r > 0.5) s.angle = Math.round(Math.atan2(w[1] - s.cy, w[0] - s.cx) * 180 / Math.PI * 10) / 10; }
    else if (kind === "ellipse") { s.rx = Math.max(0.5, Math.abs(w[0] - s.cx)); s.ry = Math.max(0.5, Math.abs(w[1] - s.cy)); }
    else if (kind === "arc") {
        if (stage === 1) {
            // The end follows; the through-point rides at the middle, a hair to one side.
            s.x1 = w[0]; s.y1 = w[1];
            const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l = Math.hypot(dx, dy) || 1;
            s.xm = (s.x0 + s.x1) / 2 - dy / l * 0.02 * l; s.ym = (s.y0 + s.y1) / 2 + dx / l * 0.02 * l;
        } else { s.xm = w[0]; s.ym = w[1]; }
    } else s.points[s.points.length - 1] = [w[0], w[1]];
    c.dirty = true;
    schedule();
}
// The spot of the curve being drawn that the next click places: "start", "end",
// "centre", "vertex:i" (a polyline's or a spline's point, named start or end when it is
// done), or null for one that is no spot (a through-point, a rim, a corner).
function placingSpot() {
    if (!drawing) return null;
    const { kind, stage } = drawing;
    if (drawing.id === null) return kind === "line" || kind === "arc" ? "start" : kind === "polyline" || kind === "nurbs" ? "vertex:0" : kind === "circle" || kind === "polygon" || kind === "ellipse" ? "centre" : null;
    if (kind === "line" || (kind === "arc" && stage === 1)) return "end";
    if (kind === "polyline" || kind === "nurbs") { const n = byId(drawing.id)?.shape.points.length ?? 0; return n ? `vertex:${n - 1}` : null; }
    return null;
}
// The spot of the curve being drawn that follows the pointer -- a begun line's end, an
// arc's end at stage 1, a polyline's or a spline's last point -- as `{ curve, spot }`, or
// null: what a drawing snap never takes (it would snap the click onto itself). The curve's
// own other end stays a target: a polyline's first point still closes it.
function pendingSpot() {
    if (!drawing || drawing.id === null) return null;
    const { kind, stage } = drawing;
    if (kind === "line" || (kind === "arc" && stage === 1) || kind === "polyline" || kind === "nurbs") return { curve: drawing.id, spot: "end" };
    return null;
}
// A click at `w` in the plane `plane`: the curve begun, or its next point fixed. `target`
// is what the click snapped onto (`snapSpot`'s), kept as a fact for inference.
async function drawClick(w, plane, target = null) {
    const { kind } = drawing;
    const placing = placingSpot();
    if (target && placing) drawing.snaps.push({ at: placing, target: { curve: target.curve, at: target.spot } });
    if (drawing.id === null) {
        // The curve is the page's alone until it is done (`local`): its `add` is committed then,
        // with its last shape, as one undo step.
        const id = nextId;
        bump(id);
        const label = LABELS[kind], taken = curves.map((c) => new RegExp(`^${label} (\\d+)$`).exec(c.name ?? "")).filter((m) => m).map((m) => +m[1]);
        curves.push({ id, name: `${label} ${Math.max(0, ...taken) + 1}`, kind, plane, shape: beginShape(kind, w), hidden: false, local: true, ...blankCurve() });
        renderList(); schedule();
        drawing.id = id; drawing.stage = 1;
        select(id);
        hintEl.textContent = drawingHint();
        renderDialog();
        return;
    }
    const c = byId(drawing.id), s = c.shape;
    drawMove(w);
    if (kind === "polyline" || kind === "nurbs") {
        // Back on the first point: closed and done. Otherwise the pending point is fixed
        // and a new one follows the pointer.
        if (s.points.length > 3 && near(w, s.points[0], plane)) { s.points.pop(); if (kind === "nurbs") s.weights.pop(); s.closed = true; finishDrawing(); return; }
        s.points.push([w[0], w[1]]);
        if (kind === "nurbs") s.weights.push(1);
        c.dirty = true; schedule();
        return;
    }
    if (kind === "arc" && drawing.stage === 1) { drawing.stage = 2; hintEl.textContent = drawingHint(); renderDialog(); return; }
    finishDrawing();
}
// Done: the pending point of a polyline or spline dropped (a spline of one point, or
// a curve never begun, is dropped whole), the shape recorded as one command.
function finishDrawing() {
    if (!drawing) return;
    const c = drawing.id !== null ? byId(drawing.id) : null;
    if (!c) { cancelDrawing(); return; }
    const { kind } = drawing;
    if ((kind === "polyline" || kind === "nurbs") && !c.shape.closed) {
        c.shape.points.pop();
        if (kind === "nurbs") c.shape.weights.pop();
        // A double click's second click fixed a point on top of the one before.
        const n = c.shape.points.length;
        if (n >= 2 && Math.hypot(c.shape.points[n - 1][0] - c.shape.points[n - 2][0], c.shape.points[n - 1][1] - c.shape.points[n - 2][1]) < 1e-9) { c.shape.points.pop(); if (kind === "nurbs") c.shape.weights.pop(); }
        if (c.shape.points.length < 2) { cancelDrawing(); return; }
    }
    const ended = drawing;
    drawing = null;
    endDrawingMode();
    c.dirty = true;
    const items = inferDrawn(c, ended.snaps);
    if (c.local) {
        // The curve's own `add` takes its last shape and what inference changed with it
        // (its constraints, curves the solve moved): the drawing is one undo step.
        const cmd = { op: "add", id: c.id, kind: c.kind, plane: c.plane, shape: structuredClone(c.shape) };
        const rest = items.filter((it) => it.id !== c.id);
        if (rest.length) cmd.items = rest;
        run(cmd);
    } else if (items.length) {
        if (!items.some((it) => it.id === c.id)) items.unshift({ id: c.id, shape: structuredClone(c.shape) });
        run({ op: "edit", items });
    } else note(c, ["shape"]);
    select(ended.id);
}
// The constraints the curve `c`, just drawn, implies on its sketch (none on an origin
// plane or a face), from what its clicks snapped onto (`snaps`, `{ at, target }`) and its
// own shape: added to the sketch's session -- one the session refuses is dropped, as
// inference never refuses a drawing -- solved and written back (a nearly level line made
// level). The `edit` items of what changed (`changedSince`), or none; a sketch saved
// before constraints is migrated with them. Nothing changes when the solve fails.
function inferDrawn(c, snaps) {
    const sketch = sketchOf(c);
    if (!sketch) return [];
    // A polyline's or a spline's points by the spots they are, now it is done: the first
    // and last of an open one its start and end; one dropped at the end, no fact.
    const n = pointed(c) ? c.shape.points.length : 0;
    const facts = [];
    for (const f of snaps ?? []) {
        let at = f.at;
        const v = /^vertex:(\d+)$/.exec(at);
        if (v) {
            const i = Number(v[1]);
            if (i >= n) continue;
            if (!c.shape.closed && (i === 0 || i === n - 1)) at = i === 0 ? "start" : "end";
        }
        facts.push({ at, target: f.target });
    }
    const start = constrainedStart(sketch);   // migrated first, so the new ids follow its
    const found = sk.inferForCurve(c, facts, curvesMap(sketchCurves(sketch)), sk.nextConstraintId(sketch));
    // Refused, `addInferred` has put the session right itself (kept, or dropped keeping
    // its red records): only the migration, if any, is undone here.
    if (!addInferred(sketch, found).ok) { restoreStart(start, false); return []; }
    return changedSince(start);
}
// Inferred records (`found`, their ids the sketch's next) added to the sketch's session one
// by one -- one already stored skipped, one the session refuses dropped, as inference never
// refuses what was drawn or dragged -- then solved and written back. `ok` false, with the
// sketch and its curves left as they were, where none stands or the solve fails
// (`unsolved`); `dropped` the fresh records the session refused, each with its
// `addConstraint` result (`got`). Then the refused records settled (`settleRefused`) unless
// `settle` is false: a drag's release settles once, itself, after its snap.
function addInferred(sketch, found, { settle = true } = {}) {
    const same = (a, b) => a.curve === b.curve && a.at === b.at;
    const stored = (k) => (sketch.constraints ?? []).some((x) => x.kind === k.kind && x.refs?.length === k.refs.length &&
        (k.refs.every((r, i) => same(r, x.refs[i])) || (k.refs.length === 2 && same(k.refs[0], x.refs[1]) && same(k.refs[1], x.refs[0]))));
    const fresh = found.filter((k) => !stored(k));
    const dropped = [];
    if (!fresh.length) return { ok: false, dropped };
    const start = constrainedStart(sketch);
    let model = null;   // read for its red records even where a withheld polygon dropped it
    try {
        model = modelFor(sketch);
        const kept = fresh.filter((k) => {
            const got = sk.addConstraint(wasm, model, k);
            if (!got.ok) dropped.push({ k, got });
            return got.ok;
        });
        if (!kept.length) return { ok: false, dropped };
        setConstraints(sketch, [...(sketch.constraints ?? []), ...kept]);
        const report = sk.solveModel(wasm, model);
        const written = report.status === "converged" ? writeSolved(sketch, model) : null;
        if (!written || written.error) { restoreStart(start, false); dropKeepingRed(sketch, model); return { ok: false, dropped, unsolved: true }; }
        // Held as solved, but a curve shrunk to a point (an end snapped onto its own
        // curve's other end through a partner): refused, nothing kept.
        const gone = collapsed(start, written.ids);
        if (gone) { restoreStart(start, false); dropKeepingRed(sketch); return { ok: false, dropped, unsolved: true, collapse: collapseText(sketch, gone, null) }; }
        if (settle) settleRefused(sketch);   // a record what was inferred lets apply, in the same step
    } catch {
        restoreStart(start, false);
        dropKeepingRed(sketch, model);
        return { ok: false, dropped, unsolved: true };
    }
    return { ok: true, dropped };
}
// A dragged end (handle `h` of `c`) let go snapped onto another curve's end (`target`,
// `snapped`'s): the coincident the snap means, added as a drawn curve's are (`addInferred`),
// in the drag's own undo step. Nothing for a curve on no sketch, or an end snapped onto
// its own curve's other end. One the sketch cannot hold is not recorded, and the status
// line says so after the release's build (`noticeNext`); the drag itself is kept.
function inferSnapped(c, h, target) {
    pendingNotice = null;   // an earlier drag's, never this one's
    const sketch = sketchOf(c);
    if (!sketch || !target || target.curve === undefined || target.curve === c.id || !isEnd(c, h)) return;
    const at = h.index === 0 ? "start" : "end";
    const a = { curve: c.id, at }, b = { curve: target.curve, at: target.spot };
    const k = { id: sk.nextConstraintId(sketch), kind: "coincident", refs: [a, b], driving: true };
    const { dropped, unsolved, collapse } = addInferred(sketch, [k], { settle: false });   // endDrag settles once, after
    const refused = dropped.find((d) => d.k === k);
    if (!refused && !unsolved) return;
    const why = refused ? refusalText(sketch, refused.got, [{ spot: a }, { spot: b }]) : collapse ?? "the sketch does not solve with it";
    noticeNext(`${c.name}: its ${at} is not held to ${byId(target.curve)?.name ?? "a curve"}'s ${target.spot}: ${why}`);
}
function cancelDrawing() {
    if (!drawing) return;
    const { openedAt, id } = drawing;
    drawing = null;
    endDrawingMode();
    // The curve begun, the page's alone, goes; anything committed since the drawing began is
    // rolled back.
    if (byId(id)?.local) { curves = curves.filter((c) => c.id !== id); renderList(); schedule(); }
    flushPending();
    if (doneSince(openedAt)) return rollbackTo(openedAt);
    renderDialog();
}
function endDrawingMode() {
    for (const b of document.querySelectorAll("#ribbon-sketch button[data-kind]")) b.setAttribute("aria-pressed", "false");
    overlay.style.cursor = "default";
    hintEl.textContent = hintFor(current()?.kind);
}

// The closed loops the selection holds, each a list of curve ids in order: a selected
// curve closed by kind is a loop of its own; a detected loop is taken whole when any
// curve of it is selected (the loop is the closed curve, whichever of its pieces was
// picked). What the surface tool builds from.
function loopsOfSelection() {
    const out = [];
    for (const c of selectedCurves()) {
        if (!isCurve(c)) continue;
        if (closedByKind(c)) { out.push([c.id]); continue; }
        const n = loopOf.get(c.id);
        if (n !== undefined && !out.includes(loops[n - 1])) out.push(loops[n - 1]);
    }
    return out;
}

// A body of the selection. A surface is one item over its closed loops, the largest
// loop its boundary and the rest holes (the wasm sorts that out); an extrusion is one
// item per selected curve, open or closed, swept the height in the toolbar. Either is
// built on the next frame and selected. The curves' definitions are copied now: from
// here on the body is its own object.
function newBody(kind, cancelAt = null) { return act(() => newBodyNow(kind, cancelAt)); }
async function newBodyNow(kind, cancelAt) {
    // A curve added or edited this very frame has not been built yet: build it now, so
    // the body takes it as it is and not as it was; a sheet picked to be raised (a trim, a
    // face) is waited for. A cancel of the session goes back to `cancelAt` when given --
    // before a face taken for an extrude, which goes with it.
    await whenBuilt(selectedCurves().filter((c) => c.kind === "trim" || c.kind === "face").map((c) => c.id));
    const at = headNow();
    if (kind === "extrusion" || kind === "revolution") {
        const made = [];
        // An extrude of one surface can be an operation on another solid -- the one
        // whose face the surface's sketch is on, or the other selected solid -- as
        // an extrude dialog offers: the dialog's operation select re-runs it.
        let extrudeOf = null, target = null, ownFace = false;
        if (kind === "extrusion") {
            const sheets = selectedCurves().filter((c) => c.kind === "surface" || c.kind === "trim" || c.kind === "face");
            // A curved face is pressed, and a chamfer's bevel cut again: neither raises a
            // prism to join or cut.
            if (sheets.length === 1 && !sweepable() && !onTurned(sheets[0]) && chamferOf(sheets[0]) <= 0) {
                extrudeOf = sheets[0];
                const sketch = curves.find((c) => c.id === extrudeOf.plane && isSketch(c));
                const onFace = sketch?.mode === "face" && sketch.face ? byId(sketch.face.body) : null;
                const ownSolid = extrudeOf.kind === "face" ? byId(extrudeOf.parts[0]) : null;
                const others = selectedCurves().filter((c) => isSolid(c) && c !== extrudeOf);
                target = isSolid(ownSolid) ? ownSolid : isSolid(onFace) ? onFace : others.length === 1 ? others[0] : null;
                ownFace = isSolid(ownSolid);
            }
        }
        // A curve extrudes to a sheet, closed or not -- a circle to an open tube;
        // a solid comes from a surface (the surface button
        // first, then extrude).
        for (const k of profilesOf(kind)) {
            const id = nextId;
            if (kind === "revolution") await run({ op: "sweep", id, kind, source: k.id, axis: axisMode.axis.map((q) => q.slice()), angle: angleOf() });
            else await run({ op: "sweep", id, kind, source: k.id, height: heightOf(), taper: taperOf() });
            made.push(id);
        }
        // A selected surface extrudes to a solid: the same source, pivot and transform,
        // so the solid starts where the surface is and goes on from there.
        if (kind === "extrusion") for (const f of selectedCurves().filter((c) => c.kind === "surface")) {
            const id = nextId;
            await run({ op: "solid", id, from: f.id, height: heightOf(), taper: taperOf() });
            made.push(id);
        }
        // Several faces of one solid (shift-clicked) are pushed together, each by its own
        // rule, as a press-pull on a selection: one Press Pull over them all.
        let together = [];
        if (kind === "extrusion") {
            const faces = selectedCurves().filter((c) => c.kind === "face");
            const src = faces.length > 1 ? byId(faces[0].parts[0]) : null;
            if (isSolid(src) && faces.every((f) => f.parts[0] === src.id)) together = faces;
        }
        if (together.length) {
            const id = nextId;
            await run({ op: "press", id, from: together.map((f) => f.id), height: heightOf() });
            made.push(id);
        }
        // A trimmed surface, or a solid's face, has no sketch to extrude from: its faces
        // are raised as they are (`extrude_faces`), a new solid beside it. A face just
        // taken is still building; its prism waits for it.
        if (kind === "extrusion") for (const t of selectedCurves().filter((c) => (c.kind === "trim" || c.kind === "face") && !together.includes(c))) {
            if (t.error !== null || (!t.gpu && t.kind !== "face")) { say(`${t.name} has not been built`, true); continue; }
            const id = nextId;
            // A curved face has no prism: it is pressed, the surface a step out.
            // A round's face is made again at a radius, as a press-pull on a fillet
            // face does; another curved face is pressed.
            const round = roundOf(t), bevel = chamferOf(t);
            if (round > 0) await run({ op: "refillet", id, from: t.id, radius: round });
            else if (bevel > 0) await run({ op: "rechamfer", id, from: t.id, radius: bevel });
            else await run({ op: onTurned(t) ? "press" : "prism", id, from: t.id, height: heightOf() });
            made.push(id);
        }
        // A selected surface in the axis's plane revolves to a solid.
        if (kind === "revolution") for (const f of selectedCurves().filter((c) => c.kind === "surface" && c.plane === axisMode.plane)) {
            const id = nextId;
            await run({ op: "revolved", id, from: f.id, axis: axisMode.axis.map((q) => q.slice()), angle: angleOf() });
            made.push(id);
        }
        if (kind === "revolution") setAxisMode(null);
        if (made.length) setSelection(made);
        if (made.length) {
            const session = openTool(at, made, kind === "revolution" ? "Revolve" : "Extrude", kind === "revolution" ? "revolution" : "solid");
            if (cancelAt !== null) session.cancelAt = cancelAt;
            if (extrudeOf && target) {
                // The operation re-run from the session's start: the solid, then the
                // boolean with the target when one is chosen.
                const from = extrudeOf.id, targetId = target.id;
                const raise = extrudeOf.kind === "surface" ? "solid" : "prism";
                session.operation = "new";
                session.rerun = async (operation) => {
                    const id = nextId;
                    await run({ op: raise, id, from, height: heightOf(), taper: taperOf() });
                    session.ids = [id];
                    if (operation === "new") { select(id); return; }
                    const cid = nextId;
                    await run({ op: operation, id: cid, parts: [targetId, id], flush: true });
                    session.ids = [...session.ids, cid];
                    select(cid);
                };
                // A face of the solid itself pushes or pulls the solid, as a face
                // extrude does: joined on when raised, cut out when pulled in, the seams
                // merged away. "new body" is still in the list for the prism alone.
                if (ownFace) {
                    session.ownFace = true;
                    await rerunAs(session, heightOf() < 0 ? "cut" : "join");
                }
                renderDialog();
            }
        }
        return;
    }
    const bounded = loopsOfSelection();
    if (!bounded.length) return;
    const id = await makeSurface(bounded);
    if (id === null) return;
    // Nothing to set: the surface is done the moment it is asked for (undo takes it
    // back), no dialog to OK -- as every tool without a number of its own.
    select(id);
}
// The surface command over `bounded` loops of curve ids, its id -- or null, said why:
// the loops must lie in one plane and every curve have something drawn.
async function makeSurface(bounded) {
    const plane = curves.find((x) => x.id === bounded[0][0]).plane;
    if (bounded.some((l) => l.some((id) => curves.find((x) => x.id === id).plane !== plane))) { say("a surface's loops must lie in one plane", true); return null; }
    for (const l of bounded) for (const id of l) {
        const k = curves.find((x) => x.id === id);
        if (!k.sketch.length) { say(`${k.name} has nothing drawn`, true); return null; }
    }
    const id = nextId;
    await run({ op: "surface", id, plane, loops: bounded.map((l) => l.slice()) });
    return id;
}

// The join: a new body, the union of the selected solids in list order -- an exact
// B-rep the kernel makes (`join_solids`). The solids stay, as a surface's curves and
// an extrusion's surface do: the join is another object, no more tied to them than
// those are. It keeps each part's whole definition (kind, source, pivot and
// transform, and its sketch's frame baked in as nine numbers, since the sketch may
// move or go), so it rebuilds from the file like any body; joins nest. It lists under
// the first part's sketch, where its gizmo lives: the union is built in the worker
// and kept there, the gizmo's move and turn a rigid move of that (`move_solid`) -- no
// scale, which a cylinder's radius has no exact recipe for.
function newJoin() {
    return act(async () => {
        const parts = curves.filter((c) => isSelected(c) && isSolid(c));
        if (parts.length < 2) return;
        await whenBuilt(parts.map((c) => c.id));
        const broken = parts.find((c) => c.error !== null || !c.gpu);
        if (broken) { say(`${broken.name} has not been built`, true); return; }
        const id = nextId;
        // `flush`: the result's coplanar faces merged and the seam edges gone, as a
        // join should come out -- a command carries the flag, so a document from before keeps
        // its seams and rebuilds as it did.
        await run({ op: "join", id, parts: parts.map((c) => c.id), flush: true });
        select(id);   // done at once: a join has nothing to set
    });
}
// A cut or an intersect: the active item is the tool, the other selected solid the
// target -- two solids, or a solid and a surface, which is first extruded by the height
// field (below its plane when negative) into a solid of its own, the tool: an
// extrude with the Cut or Intersect operation. Both parts go hidden behind the result.
function combineParts() {
    const picked = selectedCurves();
    if (picked.length !== 2) return null;
    const tool = current(), target = picked.find((c) => c !== tool);
    if (!tool || !target) return null;
    const solidOrSurface = (c) => isSolid(c) || c.kind === "surface";
    if (!isSolid(target) || !solidOrSurface(tool)) {
        // The surface may be the one clicked first: then it is still the tool.
        if (isSolid(tool) && target.kind === "surface") return { target: tool, tool: target };
        return null;
    }
    return { target, tool };
}
function newCombine(op) {
    const pair = combineParts();
    if (pair) newCombineOf(op, pair.target, pair.tool);
}
function newCombineOf(op, target, tool) {
    return act(async () => {
        await whenBuilt([target.id, tool.id]);
        for (const c of [target, tool]) if (isSolid(c) && (c.error !== null || !c.gpu)) { say(`${c.name} has not been built`, true); return; }
        const at = headNow();
        let toolId = tool.id;
        const made = [];
        if (tool.kind === "surface") {
            const height = heightOf();
            if (!height) { say("the height must be a nonzero number", true); return; }
            toolId = nextId;
            await run({ op: "solid", id: toolId, from: tool.id, height, taper: taperOf() });
            made.push(toolId);
        }
        const id = nextId;
        await run({ op, id, parts: [target.id, toolId], flush: true });
        select(id);
        // Two solids: done at once. A surface as the tool is a solid of the dialog's
        // height first, which the session keeps open to change.
        if (made.length) openTool(at, [...made, id], LABELS[op], op);
    });
}
splitEl.addEventListener("click", armSplit);
// Remove: a fillet's or a chamfer's face clicked takes it off.
removeEl.addEventListener("click", () => armSketchPick("remove"));
pipeEl.addEventListener("click", () => armSketchPick("pipe"));
for (const button of document.querySelectorAll("#ribbon-solid button[data-quick]")) button.addEventListener("click", () => newQuick(button.dataset.quick));
for (const button of document.querySelectorAll("[data-split-plane]")) button.addEventListener("click", () => { if (sketchPick?.kind === "split") splitBy(button.dataset.splitPlane); });
// Cut and intersect: the target and the tool selected (the tool active) run at once; a
// solid alone is the target, and the press arms the pick for the tool.
function pressCombine(op) {
    if (sketchPick?.kind === op) { disarmSketchPick(true); return; }
    if (combineParts()) { newCombine(op); return; }
    const solids = selectedCurves().filter(isSolid);
    if (solids.length === 1) armSketchPick(op, solids[0].id);
}
cutEl.addEventListener("click", () => pressCombine("cut"));
intersectEl.addEventListener("click", () => pressCombine("intersect"));

// The quick solids, Box, Cylinder, Sphere, Cone, Pyramid, Torus and Coil: one press puts
// one on the plane of the sketch selected (or of the curve selected, else Top), at its
// origin, its sizes in the dialog and the gizmo to move it; OK keeps it, Cancel takes it
// back. The kernel builds each (`primitive_solid`).
function quickPlane() {
    const c = current();
    if (isSketch(c)) return c.id;
    if (c && isCurve(c)) return c.plane;
    return "top";
}
function newQuick(kind) {
    return act(async () => {
        if (drawing) await cancelDrawing();
        if (sketchPick) await disarmSketchPick();
        if (tool) commitTool();
        const at = headNow(), id = nextId;
        await run({ op: "primitive", id, kind, plane: quickPlane(), dims: DIMS[kind].start.slice() });
        select(id);
        openTool(at, [id], LABELS[kind], kind);
    });
}
// A pipe along the curve picked (`SKETCH_PICKS.pipe`): a rod of the starting radius, its
// radius and wall (a tube's) in the dialog.
function newPipe(path) {
    return act(async () => {
        const at = headNow(), id = nextId;
        await run({ op: "pipe", id, path: path.id, dims: DIMS.pipe.start.slice() });
        select(id);
        openTool(at, [id], LABELS.pipe, "pipe");
    });
}
// Split Body: a solid cut in two bodies by a cutter -- a plane (Top, Front, Right, a
// sketch's, a face's, taken whole), a closed curve (a rectangle, a circle, a closed
// spline: pushed straight through the solid, the part outside it and the part inside)
// or a body (a closed one: the part outside it and the part inside; a flat sheet: its
// plane). With the solid and its cutter selected (the
// cutter active, as a cut's tool is) it splits at once; with the solid alone the press
// arms the pick for the cutter.
function splitParts() {
    const picked = selectedCurves();
    if (picked.length === 1 && isSolid(picked[0])) return { target: picked[0], cutter: null };
    if (picked.length !== 2) return null;
    const cutter = current(), target = picked.find((c) => c !== cutter);
    if (!cutter || !target || !isSolid(target) || !(isBody(cutter) || isSketch(cutter) || closedByKind(cutter))) return null;
    return { target, cutter: cutter.id };
}
function armSplit() {
    if (sketchPick?.kind === "split") { disarmSketchPick(true); return; }
    const parts = splitParts();
    if (!parts) return;
    if (sketchPick) disarmSketchPick();
    if (tool) commitTool();
    if (parts.cutter !== null) { newSplit(parts.target, parts.cutter); return; }
    sketchPick = { kind: "split", was: selection.slice(), target: parts.target.id };
    setHover(null);
    keepView = true;
    try { setSelection([parts.target.id]); } finally { keepView = false; }
    hintEl.textContent = SKETCH_PICKS.split.hint;
    overlay.style.cursor = "crosshair";
    syncToolbar();
    renderDialog();
}
// A curve clicked as the split's cutter: a closed one splits, an open one is said so.
function splitByCurve(k) {
    if (closedByKind(k)) splitBy(k.id);
    else say(`${k.name} is open -- a curve splits a solid only when it closes`, true);
}
// The split's cutter picked: a plane key or a body's (a sketch's, a closed curve's) id.
function splitBy(cutter) {
    const target = byId(sketchPick?.target);
    if (!target) return;
    if (cutter === target.id) { say(`${target.name} cannot split itself -- click one of its flat faces for its plane`, true); return; }
    if (target.error !== null) { say(`${target.name} did not build: ${target.error}`, true); return; }
    sketchPick = null;
    hoverCurve = null;
    overlay.style.cursor = drawing ? "crosshair" : "default";
    newSplit(target, cutter);
}
// A face clicked while the split picks: a flat one's whole plane, a curved one's body.
function splitAtFace(body, index) {
    if (faceFrame(body, index)) splitBy(facePlane(body.id, index));
    else splitBy(body.id);
}
// The solid need not be built yet: each side's definition builds it (in the worker).
function newSplit(target, cutter) {
    return act(async () => {
        if (target.error !== null) { say(`${target.name} did not build: ${target.error}`, true); return; }
        const at = headNow(), ids = [nextId, nextId + 1];
        await run({ op: "split", ids, target: target.id, cutter });
        setSelection(ids);
        openTool(at, ids, LABELS.split, "split");
        hintEl.textContent = hintFor("split");
        syncToolbar();
        renderDialog();
    });
}

// The shell: the active solid hollowed to walls of the thickness field, any of its
// faces left open. Pressing the button arms the pick: faces clicked in any view (the
// View's pick says which) are the ones to leave open, clicked again they
// close; Enter, or the button again, makes the shell, Esc cancels. The shell is a
// new body beside the solid, as a join is beside its parts: it keeps the solid's
// definition, the thickness and the open faces' indices (the definition is baked, so
// the indices stay good). The thickness field edits the active shell's afterwards.
let shellMode = null;   // { body, open: Set of face indices } while faces are being picked
function setShellMode(body) {
    shellMode = body ? { body, open: new Set() } : null;
    shellEl.setAttribute("aria-pressed", String(!!body));
    overlay.style.cursor = body ? "crosshair" : picking === "face" || drawing ? "crosshair" : "default";
    hintEl.textContent = body ? shellHint() : hintFor(current()?.kind);
    setHover(null);
    renderDialog();
}
function shellHint() {
    return `click faces of ${shellMode.body.name} to leave open · click again to close · OK or Enter makes the shell · Esc cancels`;
}
function newShell() {
    return act(async () => {
        if (!shellMode) return;
        const src = shellMode.body;
        if (!curves.includes(src)) { setShellMode(null); return; }
        const open = [...shellMode.open].sort((a, b) => a - b);
        setShellMode(null);
        const thickness = thicknessOf();
        if (thickness === null) { say("the thickness must be a nonzero number", true); return; }
        const id = nextId;
        bump(id);
        // The open faces' references, off the worker's solid (the page's picks are its B-rep faces).
        const faceRefs = await refsOf(src.id, "faces", open);
        await run({ op: "shell", id, source: src.id, thickness, open, ...(faceRefs ? { faceRefs } : {}) });
        select(id);
    });
}
// Thicken: a sheet -- a surface, a curve's extrusion, a face, a trim --
// made a solid of the thickness field's thickness along its normals (a negative one
// grows it the other way), a new body the sheet hides behind. Pressed with a sheet
// selected it runs; otherwise it picks one. The field edits it afterwards.
function newThicken(sheet) {
    return act(async () => {
        await whenBuilt([sheet.id]);
        if (sheet.error !== null || !sheet.gpu) { say(`${sheet.name} has not been built`, true); return; }
        const thickness = thicknessOf();
        if (thickness === null) { say("the thickness must be a nonzero number", true); return; }
        const at = headNow(), id = nextId;
        await run({ op: "thicken", id, source: sheet.id, thickness });
        select(id);
        openTool(at, [id], "Thicken", "thicken");
    });
}
thickenEl.addEventListener("click", () => {
    if (sketchPick?.kind === "thicken") { disarmSketchPick(true); return; }
    const picked = selectedCurves();
    if (picked.length === 1 && isSheet(picked[0])) newThicken(picked[0]);
    else armSketchPick("thicken");
});
const thicknessOf = () => { const t = +thicknessEl.value; return thicknessEl.value === "" || !Number.isFinite(t) || t === 0 ? null : t; };

// The trim: a sheet (a surface, a curve's sweep) cut along a solid's boundary into
// pieces, and the pieces chosen thrown away -- a surface trim. The tool is a solid,
// or a sketch curve, which cuts where its sweep along its sketch's normal meets the
// sheet. Pressing the button
// with one sheet and one tool selected makes the trim, a new body beside them like a
// join (the sheet stays, hidden, since the trim lies exactly on it; the tool stays
// as it is), whole at first, and arms the picks: a piece
// clicked in any view is dropped; a dropped piece stays as a ghost, clicked again it
// is back; Enter, Esc or the button end the picking, which the button arms again on
// a trim later. Every pick is a command of its own, so it undoes one at a time.
let trimMode = null;   // { body, at } while pieces are being picked (its tool is not drawn meanwhile); `at` where the history stood
function setTrimMode(body) {
    trimMode = body ? { body, at: headNow() } : null;
    trimEl.setAttribute("aria-pressed", String(!!body));
    overlay.style.cursor = body ? "crosshair" : shellMode || picking === "face" || drawing ? "crosshair" : "default";
    hintEl.textContent = body ? trimHint() : hintFor(current()?.kind);
    setHover(null);
    renderDialog();
    schedule();   // the ghosts show while picking
}
function trimHint() {
    return `click a piece of ${trimMode.body.name} to remove it · click a ghost to bring it back · OK, Enter or trim ends`;
}
// What can cut a sheet: a solid, or a curve with something drawn.
const isTool = (c) => isSolid(c) || (isCurve(c) && c.sketch.length > 0);

// The sketch's trim: the selected curves are cut where the other curves on
// their plane cross them (the kernel's `Profile::pieces_cut_by`, through
// `profile_piece`), the piece under the pointer lights up, and a click removes it -- a
// `trim` command, the curve replaced by what is left of it (`Profile::trim`), so each
// click is one step of the history (a `snip` command -- "trim" being the sheet's) and
// Cancel rolls them all back. The mode goes on
// over what is left, and ends on OK, Enter, Esc (cancelling) or the button again.
let sketchTrim = null;   // { ids, pieces: Map(id -> [{ beziers, world }]), hover: { id, k } | null, at, removed, rev }
let trimRevs = 0;
let curveRevs = 0;   // the curves' Béziers revisions (`rebuild`), one counter for every curve
const trimmable = (k) => isCurve(k) && drawn(k) && k.sketch.length > 0;
function setSketchTrim(on) {
    if (!on) sketchTrim = null;
    else {
        if (curves.some((c) => c.dirty)) rebuild();
        const ids = selectedCurves().filter(trimmable).map((c) => c.id);
        if (!ids.length) { say("trim takes a drawn curve -- select one first", true); return; }
        sketchTrim = { ids, pieces: new Map(), hover: null, at: headNow(), removed: 0 };
        refreshSketchTrim();
    }
    sketchTrimEl.setAttribute("aria-pressed", String(!!sketchTrim));
    overlay.style.cursor = sketchTrim || trimMode || shellMode || picking === "face" || drawing ? "crosshair" : "default";
    hintEl.textContent = sketchTrim ? sketchTrimHint() : hintFor(current()?.kind);
    renderDialog();
    schedule();
}
const sketchTrimHint = () => `click a piece of ${sketchTrim.ids.map((id) => byId(id)?.name).filter((n) => n).join(", ")} between crossings to remove it · OK, Enter or trim ends · Esc cancels`;
// The cutters of `c`: every other drawn curve shown on its plane, as Béziers laid end
// to end with how many each has.
function cuttersOf(c) {
    const others = curves.filter((k) => isCurve(k) && k !== c && k.plane === c.plane && visible(k) && k.sketch.length > 0);
    const cutters = new Float32Array(others.reduce((n, k) => n + k.sketch.length, 0));
    let at = 0;
    for (const k of others) { cutters.set(k.sketch, at); at += k.sketch.length; }
    return { cutters, perCutter: new Uint32Array(others.map((k) => k.sketch.length / 16)) };
}
// The pieces again, of the curves the mode still has: after a trim, a delete, an edit.
function refreshSketchTrim() {
    if (!sketchTrim) return;
    sketchTrim.ids = sketchTrim.ids.filter((id) => trimmable(byId(id)));
    sketchTrim.pieces.clear();
    sketchTrim.hover = null;
    sketchTrim.rev = ++trimRevs;   // the piece shown is keyed by it
    for (const id of sketchTrim.ids) {
        const c = byId(id);
        const { cutters, perCutter } = cuttersOf(c);
        try {
            const frame = frame9(c.plane);
            sketchTrim.pieces.set(id, trimPieces(c.sketch, cutters, perCutter).map((p) => ({ beziers: p.beziers, world: embedBeziers(wasm, p.beziers, frame) })));
        } catch (error) { say(`${c.name}: ${error.message || error}`, true); }
    }
    if (!sketchTrim.ids.length) setSketchTrim(false);
}
// The piece under `px` in view `i`: the nearest within `PICK_PX`, as `pickCurve` finds
// a curve; null off every piece.
function pieceUnder(i, px) {
    if (!sketchTrim) return null;
    const size = sizeOf(i), p = local(px, i), cam = camOf(i);
    let best = null, bestD = PICK_PX;
    for (const [id, pieces] of sketchTrim.pieces) pieces.forEach((piece, k) => {
        const d = bezierDistance(piece.world, p, cam, size, bestD);
        if (d < bestD) { bestD = d; best = { id, k }; }
    });
    return best;
}
// Piece `k` of curve `id` removed: the curve becomes what the kernel leaves of it,
// the mode goes on over those, and they are the selection.
function trimAway(id, k) {
    const c = byId(id);
    if (!c || !sketchTrim) return;
    const { cutters, perCutter } = cuttersOf(c);
    let chains;
    try { chains = trimmedChains(c.sketch, cutters, perCutter, k); } catch (error) { say(`${c.name}: ${error.message || error}`, true); return; }
    const items = chains.map(chainCurve);
    const ids = items.map((_, j) => nextId + j);
    runStructural({ op: "snip", id: c.id, ids, items }, [c.plane]);
    sketchTrim.removed++;
    sketchTrim.ids = sketchTrim.ids.flatMap((x) => x === id ? ids : [x]);
    keepView = true;
    try { setSelection(sketchTrim.ids.slice()); } finally { keepView = false; }
    if (curves.some((x) => x.dirty)) rebuild();   // the new curves' Béziers, before they are cut again
    refreshSketchTrim();
    if (sketchTrim) hintEl.textContent = sketchTrimHint();
    renderDialog();
    schedule();
}
sketchTrimEl.addEventListener("click", () => setSketchTrim(!sketchTrim));
function newTrim() {
    const sheet = selectedCurves().find(isSheet), tool = selectedCurves().find(isTool);
    if (!sheet || !tool || selectedCurves().length !== 2) return;
    newTrimOf(sheet, tool);
}
function newTrimOf(sheet, tool) {
    return act(async () => {
        await whenBuilt([sheet.id, tool.id].filter((id) => isBody(byId(id))));
        for (const c of [sheet, tool]) if (c.error !== null || (isBody(c) && !c.gpu)) { say(`${c.name} has not been built`, true); return; }
        const at = headNow(), id = nextId;
        await run({ op: "trim", id, sheet: sheet.id, tool: tool.id });
        select(id);
        setTrimMode(byId(id));
        openTool(at, [id], "Trim", "trim");
    });
}
// The fillet: a solid's edges rounded to the radius field. Pressing the button with
// a solid selected makes the fillet, a new body standing in for the solid (which is
// hidden), whole at first, and arms the picks: while picking, the solid itself is
// shown in the fillet's place with its edges drawn, and an edge clicked in any view
// is rounded (clicked again, not); Enter, Esc or the button end the picking, which
// the button arms again on a fillet later; the radius field edits it. Each pick is a
// command, undone one at a time. A picked edge is one of the solid's own -- the
// definition names it by its index in the solid's edge list, which the kernel keeps
// in one order for one solid.
let filletMode = null;   // { body, at } while edges are being picked; `at` where the history stood
function setFilletMode(body) {
    filletMode = body ? { body, at: headNow() } : null;
    filletEl.setAttribute("aria-pressed", String(!!body && body.style !== "chamfer"));
    chamferEl.setAttribute("aria-pressed", String(!!body && body.style === "chamfer"));
    overlay.style.cursor = body ? "crosshair" : trimMode || shellMode || picking === "face" || drawing ? "crosshair" : "default";
    hintEl.textContent = body ? filletHint() : hintFor(current()?.kind);
    setHover(null);
    renderDialog();
    schedule();
}
function filletHint() {
    const bevel = filletMode.body.style === "chamfer";
    return `click an edge of ${filletMode.body.name}'s solid to ${bevel ? "cut it back" : "round it"} · click again to leave one square · ${bevel ? "distance" : "radius"} ${filletMode.body.radius} · OK, Enter or ${bevel ? "chamfer" : "fillet"} again makes it · Esc cancels`;
}
const radiusOf = () => { const r = +radiusEl.value; return radiusEl.value === "" || !Number.isFinite(r) || r <= 0 ? null : r; };
// What the fillet button rounds among curves: two lines meeting at a corner, or one
// rectangle, polyline or polycurve (every line-line corner of it).
// Read off the shapes, not the built Béziers: the toolbar is synced when a new curve is
// selected, before its first build.
const drawn = (c) => isCurve(c) && (!pointed(c) || c.shape.points.length > 1) && !(c.kind === "polycurve" && !c.shape.pieces.length);
function filletable(picked) {
    if (!picked.length || !picked.every(drawn)) return false;
    if (picked.length === 2) return picked.every((c) => c.kind === "line") && picked[0].plane === picked[1].plane;
    return picked.length === 1 && (picked[0].kind === "rect" || picked[0].kind === "polygon" || picked[0].kind === "polycurve" || (picked[0].kind === "polyline" && picked[0].shape.points.length > 2));
}
// The sketch fillet worked out (pure, so the command's replay finds the same): for
// two lines, their trimmed ends and the arc; for one item, its shape as a polycurve.
// Null with the reason in `say` where it cannot be done.
function sketchFillet(items, radius, complain = false) {
    const fail = (why) => { if (complain) say(why, true); return null; };
    try {
        if (items.length === 2) {
            const [a, b] = items;
            const sa = a.shape, sb = b.shape;
            const ea = [[sa.x0, sa.y0], [sa.x1, sa.y1]], eb = [[sb.x0, sb.y0], [sb.x1, sb.y1]];
            const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= LOOP_TOLERANCE * 10;
            let meet = null;
            for (const i of [0, 1]) for (const j of [0, 1]) if (near(ea[i], eb[j])) meet = [i, j];
            if (!meet) return fail(`${a.name} and ${b.name} do not meet end to end`);
            const [i, j] = meet;
            const p = ea[i], far_a = ea[1 - i], far_b = eb[1 - j];
            const r = roundCorner(p, far_a, far_b, radius);
            if (!r) return fail(`the radius ${radius} does not fit the corner of ${a.name} and ${b.name}`);
            const trimmed = (i, t) => i === 0 ? { x0: t[0], y0: t[1] } : { x1: t[0], y1: t[1] };
            return { a: trimmed(i, r.t1), b: trimmed(j, r.t2), arc: { x0: r.t1[0], y0: r.t1[1], xm: r.m[0], ym: r.m[1], x1: r.t2[0], y1: r.t2[1] } };
        }
        const c = items[0], s = c.shape;
        const rounded = c.kind === "rect" ? roundPolyline([[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]], true, radius)
            : c.kind === "polygon" ? roundPolyline(polygonPoints(s), true, radius)
            : c.kind === "polyline" ? roundPolyline(s.points, s.closed, radius)
            : roundPolycurve(s.pieces, radius);
        const { beziers } = chainPieces(rounded.pieces);
        return { shape: { pieces: rounded.pieces, closed: rounded.closed, ends: rounded.closed ? [[0, 0], [0, 0]] : [[beziers[0], beziers[1]], [beziers[beziers.length - 4], beziers[beziers.length - 3]]] } };
    } catch (error) { return fail(String(error.message ?? error)); }
}
function newFillet(style = "round") {
    return act(async () => {
        if (curves.some((c) => c.dirty)) rebuild();
        const picked = selectedCurves();
        if (style === "round" && filletable(picked)) {
            const radius = radiusOf();
            if (radius === null) { say("the radius must be a positive number", true); return; }
            const rounded = sketchFillet(picked, radius, true);
            if (!rounded) return;
            const arc = picked.length === 2 ? nextId : null;
            // Two lines trimmed back to the arc: what held their corner ends together no
            // longer holds (the solver would pull the ends back over the arc), nor what sized
            // the lines; the arc's ends are held to the trimmed ends instead (they are one
            // point by construction).
            const trimmed = rounded.arc ? [[picked[0].id, "x0" in rounded.a ? "start" : "end"], [picked[1].id, "x0" in rounded.b ? "start" : "end"]] : [];
            const sized = new Set(["length", "midpoint", "equal_length"]);
            const remap = (list, sketch) => {
                if (!trimmed.length) return list;
                const kept = list.filter((k) => !(k.refs ?? []).some((r) => trimmed.some(([id, at]) => r.curve === id && (r.at === at || (r.at === "curve" && sized.has(k.kind))))));
                if (byId(arc)?.plane !== sketch.id) return kept;
                // Past every id the sketch held, the dropped ones too: a new record never takes
                // the id of one just dropped (a red one would hand its refusal on to it).
                const next = sk.nextConstraintId({ constraints: list });
                return [...kept,
                    { id: next, kind: "coincident", refs: [{ curve: arc, at: "start" }, { curve: trimmed[0][0], at: trimmed[0][1] }], driving: true },
                    { id: next + 1, kind: "coincident", refs: [{ curve: arc, at: "end" }, { curve: trimmed[1][0], at: trimmed[1][1] }], driving: true }];
            };
            await runStructural({ op: "round", ids: picked.map((c) => c.id), radius, arc }, picked.map((c) => c.plane), { remap });
            if (arc !== null) setSelection([...picked.map((c) => c.id), arc]);
            return;
        }
        const src = selectedCurves().find(isSolid);
        if (!src || selectedCurves().length !== 1) return;
        await whenBuilt([src.id]);
        if (src.error !== null || !src.gpu) { say(`${src.name} has not been built`, true); return; }
        const radius = radiusOf();
        if (radius === null) { say("the radius must be a positive number", true); return; }
        const at = headNow(), id = nextId;
        await run({ op: "fillet", id, source: src.id, radius, style });
        select(id);
        setFilletMode(byId(id));
        openTool(at, [id], style === "chamfer" ? "Chamfer" : "Fillet", "fillet");
    });
}
chamferEl.addEventListener("click", () => {
    if (filletMode) { pressedAgain(filletMode.body.edges.length > 0); return; }
    const c = current();
    if (c?.kind === "fillet" && c.style === "chamfer" && selection.length === 1) { if (c.gpu) setFilletMode(c); return; }
    newFillet("chamfer");
});
// The solid a fillet stands in for, as shown while its edges are picked: the item
// itself where it still stands, with its edge list.
const filletSource = (c) => curves.find((k) => k.id === c.tool && isBody(k)) ?? null;
// A fillet's edges in its solid's numbering, as the picks show them. A fillet from a
// document before version 3 (`edgeNumbering: 1`) named them before a spline's chords were
// one edge; its indices are taken as today's (the old numbering is not mapped: the document
// resolves the fillet by its references).
function filletEdges(c) {
    return c.edges;
}
// An edge of the solid clicked while picking: the nearest of the solid's edges to the
// click, in the view's own pixels, among those on the face clicked. The fillet's edges
// are written in today's numbering from then on.
function pickFilletEdge(c, view, px, face) {
    const src = filletSource(c);
    if (!src?.gpu?.edges) { say("the solid's edges are not built", true); return; }
    if (bodyPending(c)) { say(`${c.name} is still being built`, true); return; }
    const best = nearestEdge(src, view, px, face);
    if (best === null) return;
    const now = filletEdges(c);
    if (now === null) { say("the solid's edges are not built", true); return; }
    const edges = now.includes(best) ? now.filter((k) => k !== best) : [...now, best].sort((a, b) => a - b);
    // The edges' references, off the worker's solid, in today's numbering.
    return act(async () => {
        const edgeRefs = await refsOf(src.id, "edges", edges);
        if (byId(c.id) !== c) return;
        await run({ op: "set", id: c.id, edges, ...(edgeRefs ? { edgeRefs } : {}), ...(c.edgeNumbering === 1 ? { edgeNumbering: 3 } : {}) });
        if (filletMode) hintEl.textContent = filletHint();
        renderDialog();
    });
}
// The edge of `src` nearest the pointer at `px` in `view`, within a few pixels, among
// those on the face under it (`face`, or null for any) -- the one a click rounds, and
// the one the pointer lights up on its way.
function nearestEdge(src, view, px, face) {
    if (!src?.gpu?.edges) return null;
    const all = parseEdges(src.gpu.edges);
    const size = sizeOf(view), p = local(px, view);
    const cam = camOf(view);
    let best = null, bestD = 12;
    all.forEach((e, k) => {
        if (face !== null && !e.faces.includes(face)) return;
        for (const [a, b] of e.segments) {
            const pa = cam.worldToPx(a, size), pb = cam.worldToPx(b, size);
            if (!pa || !pb) continue;
            const d = segmentDistance(p, pa, pb);
            if (d < bestD) { bestD = d; best = k; }
        }
    });
    return best;
}

// A piece of the trim clicked while picking: `index` among the faces shown -- the
// kept ones (`ghost` false), or the ghosts (`ghost` true, in `drop`'s order).
function pickTrimPiece(c, index, ghost) {
    if (bodyPending(c)) { say(`${c.name} is still being built`, true); return; }
    let drop;
    if (ghost) drop = c.drop.filter((_, k) => k !== index);
    else {
        // The kept faces are the split's less the dropped, in order: the index among
        // them is the split's index with the dropped ones closed up.
        const all = c.gpu.faceKinds.length + c.drop.length;
        const kept = [...Array(all).keys()].filter((f) => !c.drop.includes(f));
        drop = [...c.drop, kept[index]].sort((a, b) => a - b);
    }
    // The pieces' references, off the worker's split (`i<n>_split`, before anything is dropped).
    return act(async () => {
        const faceRefs = await refsOf(`i${c.id}_split`, "faces", drop);
        if (byId(c.id) !== c) return;
        await run({ op: "set", id: c.id, drop, ...(faceRefs ? { faceRefs } : {}) });
        if (trimMode) hintEl.textContent = trimHint();
        renderDialog();
    });
}

// A curve's definition as a body keeps it: its kind and a copy of its shape, nothing of
// the curve item itself. The Béziers are rebuilt from this whenever they are wanted.
const snapshot = (k) => ({ kind: k.kind, shape: structuredClone(k.shape) });


// The selected curves a sweep takes: every one with something drawn -- for a revolve
// with the axis taken from a selected line, all but that line.
function profilesOf(kind) {
    const drawn = selectedCurves().filter((c) => isCurve(c) && c.sketch.length > 0);
    if (kind === "revolution") return drawn.filter((c) => c.plane === axisMode.plane && c.id !== axisMode.line);
    return drawn;
}
// Whether the selection has a curve to sweep.
const sweepable = () => selectedCurves().some((c) => isCurve(c) && c.sketch.length > 0);
// Whether "revolve" has anything: a curve to turn into a sheet, a surface into a solid.
const revolvable = () => sweepable() || selectedCurves().some((c) => c.kind === "surface");
// Whether "extrude" has anything: a curve to sweep to a sheet, a surface to a solid,
// or a made sheet (a trim) to raise.
const extrudable = () => sweepable() || selectedCurves().some((c) => c.kind === "surface" || c.kind === "trim" || c.kind === "face");

// The sweep tool: the selected surfaces (to solids) and curves (to sheets) swept along
// a path curve. One drawn on an "along path" sketch sweeps along that sketch's own path
// at once; any other waits for the path to be clicked in the list (`sweepMode`, the
// profiles' ids), Esc or the button again cancelling. The body is its own object: the
// profile and the path curve are copied into it (`swept`).
// The loft: two surfaces (to a solid) or two curves (to a sheet), each on its own
// plane, ruled straight across between matching sides -- the first selected is the
// body's source, the active one the far end.
function loftPair() {
    const picked = selectedCurves();
    if (picked.length !== 2) return null;
    const to = current(), from = picked.find((c) => c !== to);
    if (!to || !from) return null;
    if (from.kind === "surface" && to.kind === "surface") return { from, to };
    if (drawn(from) && drawn(to)) return { from, to };
    return null;
}
function newLoft() {
    const pair = loftPair();
    if (pair) newLoftOf(pair.from, pair.to);
    else armSketchPick("loft");
}
// `via`: the profiles between, in order -- a loft through them all.
function newLoftOf(from, to, via = []) {
    return act(async () => {
        if (curves.some((c) => c.dirty)) rebuild();
        const id = nextId;
        await run({ op: "lofted", id, from: from.id, to: to.id, ...(via.length ? { via: via.map((c) => c.id) } : {}) });
        select(id);   // done at once: a loft has nothing to set
    });
}
loftEl.addEventListener("click", () => { if (sketchPick?.kind === "loft") pressedAgain(pickReady("loft")); else newLoft(); });
// What the sweep tool takes as a profile: a surface, or a curve with something drawn.
const sweepProfile = (c) => c?.kind === "surface" || drawn(c);
let sweepMode = null;
function setSweepMode(mode) {
    sweepMode = mode;
    sweepEl.setAttribute("aria-pressed", String(mode !== null));
    hintEl.textContent = mode ? "click the path curve in a view or the list -- it must start on the profile's plane, square to it · Esc to cancel" : hintFor(current()?.kind);
    renderDialog();
}
function newSweep() {
    return act(async () => {
        if (sweepMode) { setSweepMode(null); return; }
        if (curves.some((c) => c.dirty)) rebuild();
        const profiles = selectedCurves().filter(sweepProfile);
        if (!profiles.length) return;
        const at = headNow();
        const made = [], rest = [];
        for (const f of profiles) {
            const sketch = curves.find((c) => c.id === f.plane && isSketch(c));
            const path = sketch?.mode === "path" ? curves.find((c) => c.id === sketch.path && isCurve(c)) : null;
            if (path) { const id = nextId; await run({ op: "swept", id, from: f.id, path: path.id }); made.push(id); } else rest.push(f.id);
        }
        if (made.length) setSelection(made);
        if (rest.length) setSweepMode({ from: rest });
        openTool(at, made.length ? made : rest, "Sweep", "sweep");
    });
}
function pickSweepPath(id) {
    return act(async () => {
        const k = curves.find((c) => c.id === id);
        if (!drawn(k)) { say("a path must be a curve with something drawn", true); return; }
        const made = [];
        for (const from of sweepMode.from) { if (from === id) continue; const nid = nextId; await run({ op: "swept", id: nid, from, path: id }); made.push(nid); }
        setSweepMode(null);
        if (tool) tool.ids = made;   // the session goes on: the sweeps are what it made
        if (made.length) setSelection(made);
    });
}

// The revolve tool's axis, while the tool is armed: `{ axis: [[x, y], [x, y]], plane,
// line }`, the axis in the sketch plane `plane` (the selected curves' -- a revolve takes
// curves of one view) with a handle at either end, `line` the id of the selected line it
// was read from (then not a profile) or null. Armed by the revolve
// button: with a selected line beside other curves the axis is that line and the
// revolve happens at once; otherwise the axis appears upright along the left of the
// selection's box, its handles dragged (and snapped onto curve ends) where wanted, and
// the button, or Enter, commits, Esc cancels.
let axisMode = null;
function setAxisMode(mode) {
    axisMode = mode;
    revolveEl.setAttribute("aria-pressed", String(mode !== null));
    hintEl.textContent = mode
        ? `drag the axis's ends in ${NAMES[viewOf(mode.plane) ?? 0]} (they snap onto curve ends) · revolve or Enter to sweep · Esc to cancel`
        : hintFor(current()?.kind);
    renderDialog();
}
function armRevolve() {
    if (axisMode) return newBody("revolution");
    if (curves.some((c) => c.dirty)) rebuild();
    const at = headNow();
    const all = selectedCurves().filter((c) => (isCurve(c) && c.sketch.length > 0) || c.kind === "surface");
    if (!all.length) return;
    // The plane: the active view's when it is one of the sketches', else the first
    // selected curve's or surface's; only what is in that plane takes part.
    const plane = all.some((c) => c.plane === sketchPlane()) ? sketchPlane() : all[0].plane;
    const drawn = all.filter((c) => c.plane === plane);
    const lines = drawn.filter((c) => c.kind === "line");
    if (lines.length === 1 && drawn.length > 1) {
        const s = lines[0].shape;
        axisMode = { axis: [[s.x0, s.y0], [s.x1, s.y1]], plane, line: lines[0].id };
        return newBody("revolution");
    }
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    // A surface's extent is its loops' curves'.
    const outlined = drawn.flatMap((c) => c.kind === "surface" ? (c.loops ?? []).flat().map(byId).filter((k) => k?.sketch) : [c]);
    for (const c of outlined) for (let i = 0; i < c.sketch.length; i += 4) {
        lo = [Math.min(lo[0], c.sketch[i]), Math.min(lo[1], c.sketch[i + 1])]; hi = [Math.max(hi[0], c.sketch[i]), Math.max(hi[1], c.sketch[i + 1])];
    }
    const pad = Math.max(5, (hi[1] - lo[1]) * 0.25);
    setAxisMode({ axis: [[lo[0], lo[1] - pad], [lo[0], hi[1] + pad]], plane, line: null });
    openTool(at, drawn.map((c) => c.id), "Revolve", "revolution");
}

// The angle field in degrees, or a full turn while it is mid-edit or out of range.
function angleOf() {
    const a = +angleEl.value;
    return angleEl.value !== "" && Number.isFinite(a) && a > 0 && a <= 360 ? a : 360;
}

// A world point into the body's source space, for dragging an axis end (the inverse
// of forge-curves.js's `mapPoint`).
function unmapPoint(c, w) {
    const { tx, ty, angle, scale } = c.transform, [px, py] = c.pivot;
    const cos = Math.cos(-angle) / scale, sin = Math.sin(-angle) / scale, x = w[0] - px - tx, y = w[1] - py - ty;
    return [px + cos * x - sin * y, py + sin * x + cos * y];
}

// A new sketch: on a plane parallel to the active view's, twenty millimetres along its
// normal from it (from the sketch's own offset, when the view is looking at an offset
// sketch already), selected so its plane can be edited in the toolbar. In another
// `mode` (the Construct tab's planes) it asks for what that mode is placed by.
const PICK_OF_MODE = { angle: "hinge", path: "path", face: "face", mid: "planes", points: "points" };
function newSketch(mode = "offset") {
    return act(async () => {
        const from = planeInfo(sketchPlane());
        // Born with constraints (none yet): only a sketch saved before them is migrated.
        const id = nextId;
        await run({ op: "sketch", id, mode, base: from.base ?? "top", offset: (from.base ? from.offset : 0) + 20, hinge: null, tilt: 30, path: null, face: null, mid: null, points: null, constraints: [] });
        select(id);
        if (PICK_OF_MODE[mode]) setPicking(PICK_OF_MODE[mode]);
    });
}
// The active sketch's plane was redefined (its mode, base, hinge or path): whatever
// looked at it looks again, with the camera the new plane wants (an offset sketch is
// seen from its base's view, a tilted one gets its own), and everything on it rebuilds
// through the rebuild's frame check.
function replaneSketch(sketch) {
    const looked = VIEW_PLANE_KEYS.some((k) => viewPlane[k] === sketch.id);
    for (const k of VIEW_PLANE_KEYS) if (viewPlane[k] === sketch.id) lookAway(k);
    if (looked || sketch.mode !== "offset") lookAt(sketch, VIEW_PLANE_KEYS.includes(active) ? active : 0);
    renderList();
    syncToolbar();
    schedule();
}
// The pick: "pick hinge" or "pick path" pressed, the next curve row clicked becomes the
// active sketch's hinge (a line) or path (any curve); "pick face" pressed, the next face
// clicked in any view (the View's pick says which) becomes its face; Esc, or
// the button again, ends it.
let picking = null;
// A midplane's planes or a 3-point plane's points picked so far: the sketch takes them
// once there are enough.
let pickedSoFar = [];
const facePicking = () => picking === "face" || picking === "planes";
function setPicking(what) {
    picking = what;
    pickedSoFar = [];
    pickHingeEl.setAttribute("aria-pressed", String(what === "hinge"));
    pickPathEl.setAttribute("aria-pressed", String(what === "path"));
    pickFaceEl.setAttribute("aria-pressed", String(what === "face"));
    pickMidEl.setAttribute("aria-pressed", String(what === "planes"));
    pickPointsEl.setAttribute("aria-pressed", String(what === "points"));
    overlay.style.cursor = what === "face" || what === "planes" || what === "points" ? "crosshair" : drawing ? "crosshair" : "default";
    if (!facePicking()) setHover(null);
    pickingHint();
    renderDialog();
}
function pickingHint() {
    const what = picking;
    hintEl.textContent = !what ? hintFor(current()?.kind)
        : what === "face" ? "click a flat face of a body in any view to put the sketch on it · Esc to cancel"
        : what === "planes" ? `click ${pickedSoFar.length ? "the second plane" : "two planes"} -- sketches in the list, flat faces in any view, or Top, Front or Right in the dialog -- for the plane midway between · Esc to cancel`
        : what === "points" ? `click ${["three curve ends", "two more curve ends", "one more curve end"][pickedSoFar.length]} in any view -- the plane's origin, then towards its x, then one it leans to · Esc to cancel`
        : `click a ${what === "hinge" ? "line" : "curve"} in the list to make it the sketch's ${what} · Esc to cancel`;
}
// A plane for the midplane picked (a plane key or a face): with two, the sketch is
// midway between them.
function pickMidInto(sketch, ref) {
    const key = (r) => typeof r === "object" ? `face:${r.body}:${r.index}` : String(r);
    if (pickedSoFar.some((r) => key(r) === key(ref))) { say("that plane is picked already -- pick another", true); return; }
    pickedSoFar.push(ref);
    if (pickedSoFar.length < 2) { pickingHint(); return; }
    const mid = pickedSoFar.slice();
    setPicking(null);
    // A face among the two: its reference off the worker's solid, the other plane's null.
    return act(async () => {
        const refs = await Promise.all(mid.map((r) => typeof r === "object" ? refsOf(r.body, "faces", [r.index]) : Promise.resolve([null])));
        if (byId(sketch.id) !== sketch) return;
        const faceRefs = refs.every((r) => r) ? refs.map((r) => r[0]) : null;
        await run({ op: "set", id: sketch.id, mid, mode: "mid", ...(faceRefs && mid.some((r) => typeof r === "object") ? { faceRefs } : {}) });
        replaneSketch(sketch);
        if (planeInfo(sketch.id).broken) say("no plane midway between those two", true);
    });
}
// A curve end for the 3-point plane picked: with three, the sketch is through them.
function pickPointInto(sketch, end) {
    const k = byId(end.curve);
    if (k?.plane === sketch.id) { say("a point cannot lie on the sketch it places", true); return; }
    if (pickedSoFar.some((e) => e.curve === end.curve && e.end === end.end)) { say("that end is picked already", true); return; }
    pickedSoFar.push(end);
    if (pickedSoFar.length < 3) { pickingHint(); schedule(); return; }
    run({ op: "set", id: sketch.id, points: pickedSoFar.slice(), mode: "points" });
    setPicking(null);
    replaneSketch(sketch);
    if (planeInfo(sketch.id).broken) say("those three points lie on one line -- no plane through them", true);
}
// The curve end nearest the click in view `i`, within the snap distance: `{ curve, end }`.
function pickEnd(i, px) {
    const size = sizeOf(i), p = local(px, i), cam = camOf(i);
    let best = null, bestD = SNAP_PX;
    for (const c of curves) {
        if (!isCurve(c) || !visible(c)) continue;
        const ends = endsOf(c);
        if (!ends) continue;
        ends.forEach((q, end) => {
            const at = cam.worldToPx(embed3(c.plane, q), size);
            if (!at) return;
            const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
            if (d < bestD) { bestD = d; best = { curve: c.id, end }; }
        });
    }
    return best;
}
// A face was clicked while picking: the sketch goes on it, if it is flat (or, for a
// midplane, it is one of the two planes).
function pickFaceInto(sketch, body, index) {
    if (body.gpu.faceKinds[index] !== 0) { say("not a flat face -- a sketch needs a plane", true); return; }
    if (picking === "planes") { pickMidInto(sketch, { body: body.id, index }); return; }
    setPicking(null);
    // The face's reference off the worker's solid.
    return act(async () => {
        const faceRefs = await refsOf(body.id, "faces", [index]);
        if (byId(sketch.id) !== sketch) return;
        await run({ op: "set", id: sketch.id, face: { body: body.id, index }, mode: "face", ...(faceRefs ? { faceRefs } : {}) });
        replaneSketch(sketch);
    });
}
function pickInto(sketch, id) {
    const k = curves.find((c) => c.id === id);
    if (picking === "planes") {
        if (!isSketch(k)) { say("a midplane is between planes -- click a sketch, a flat face in a view, or Top, Front or Right in the dialog", true); return false; }
        if (k.id === sketch.id) { say("a midplane cannot be between itself and another", true); return false; }
        pickMidInto(sketch, k.id);
        return true;
    }
    if (picking === "points") { say("click a curve's end in a view", true); return false; }
    if (picking === "hinge") {
        if (k?.kind !== "line") { say("a hinge must be a line", true); return false; }
        if (k.plane === sketch.id) { say("a hinge cannot lie on the sketch it hinges", true); return false; }
        run({ op: "set", id: sketch.id, hinge: id, mode: "angle" });
    } else {
        if (!isCurve(k) || !k.sketch.length) { say("a path must be a curve with something drawn", true); return false; }
        if (k.plane === sketch.id) { say("a path cannot lie on the sketch it places", true); return false; }
        run({ op: "set", id: sketch.id, path: id, mode: "path" });
    }
    setPicking(null);
    replaneSketch(sketch);
    return true;
}
// What the pointer is over while faces, pieces or edges are being picked: the face
// (`body`, `index`, a trim's `ghost`) the View's pick finds under it, and
// for a fillet the edge nearest it on that face -- lit up in the views so the pick
// reads before the click, as a pre-selection. One pick pass is out at a
// time; the pointer's latest place is asked when it lands.
let hover = null;        // { body, index, ghost, edge } or null
let hoverAsk = null;     // the pointer's [view, px] waiting for the pass, while one is out
let hoverOut = false;
const pickingFaces = () => !!(shellMode || trimMode || filletMode || (facePicking() && isSketch(current())) || (sketchPick && SKETCH_PICKS[sketchPick.kind].faces));
function setHover(next) {
    const same = (a, b) => a === b || (a && b && a.body === b.body && a.index === b.index && !!a.ghost === !!b.ghost && a.edge === b.edge);
    if (same(hover, next)) return;
    hover = next;
    schedule();
}
function hoverAt(view, px) {
    if (hoverOut) { hoverAsk = [view, px]; return; }
    hoverOut = true;
    pickBody(view, px).then((hit) => {
        hoverOut = false;
        if (!pickingFaces()) { setHover(null); return; }
        let next = null;
        if (filletMode) {
            const src = filletSource(filletMode.body);
            const edge = src ? nearestEdge(src, view, px, hit?.body === src ? hit.index : null) : null;
            next = edge !== null ? { body: src, index: null, edge } : null;
        } else if (shellMode) {
            next = hit && hit.body === shellMode.body ? { body: hit.body, index: hit.index } : null;
        } else if (trimMode) {
            next = hit && hit.body === trimMode.body ? { body: hit.body, index: hit.index, ghost: !!hit.ghost } : null;
        } else if (hit) next = { body: hit.body, index: hit.index };
        setHover(next);
        if (hoverAsk) { const [v, p] = hoverAsk; hoverAsk = null; hoverAt(v, p); }
    }).catch(() => { hoverOut = false; });
}
// A face's colour lit for a pick: the body's own (linear RGB) pulled towards the accent,
// harder for one picked than one merely under the pointer. The face keeps its body's
// material and opacity: the View colours a face, it does not re-shade it.
function litFace(base, amount) {
    const accent = linear(ACCENT);
    return [base[0] + (accent[0] - base[0]) * amount, base[1] + (accent[1] - base[1]) * amount, base[2] + (accent[2] - base[2]) * amount];
}
// The per-face colours of `c` as shown now: the shell's open faces, the face under the
// pointer -- or nothing, for a body with no face to light. Only faces the body (or its
// ghost) has now: a hover or an open face left over from before a rebuild can name one
// past its end, which the View's `setFaceColours` refuses.
function faceColoursOf(c, base, ghost = false) {
    const colours = {};
    const n = ghost ? c.ghostFaces : c.gpu?.faceKinds ? c.gpu.faceKinds.length : 0;
    if (shellMode && shellMode.body === c && !ghost) for (const k of shellMode.open) if (k < n) colours[k] = litFace(base, 0.75);
    if (hover && hover.body === c && hover.index !== null && hover.index < n && !!hover.ghost === ghost) colours[hover.index] = litFace(base, colours[hover.index] ? 1 : 0.45);
    return Object.keys(colours).length ? colours : undefined;
}
// The bodies whose ghosts are shown: the trim being picked, while it has any.
const ghosted = () => curves.filter((c) => trimMode?.body === c && c.ghostFaces > 0 && visible(c));
// A view looks at the sketch, or back at its origin plane: for an offset sketch the view
// its base is seen in (the same camera, nothing to turn); for a tilted one the view
// asked for (`v`, the active orthographic view), which gets a camera built on the
// sketch's frame, and its origin camera and grid back when it looks away.
const VIEW_PLANE_KEYS = [0, 2, 3];
const ORIGIN_OF_VIEW = { 0: "top", 2: "front", 3: "right" };
function lookAt(sketch, v = null) {
    const info = planeInfo(sketch.id);
    const view = info.base ? info.view : (v ?? (VIEW_PLANE_KEYS.includes(active) ? active : 0));
    const was = VIEW_PLANE_KEYS.find((k) => viewPlane[k] === sketch.id);
    // Whatever view looked at this sketch looks at its origin plane again; when none
    // did, `view` looks at it now.
    for (const k of VIEW_PLANE_KEYS) if (viewPlane[k] === sketch.id) lookAway(k);
    if (was === undefined) {
        if (viewPlane[view] !== ORIGIN_OF_VIEW[view]) lookAway(view);
        viewPlane[view] = sketch.id;
        if (!info.base) aimCamera(view);
    }
    syncToolbar();
    schedule();
}
// The camera the view had before it looked at a tilted sketch is kept by the worker, which
// gives it back (forge-cameras.js): the page reads no camera, so a gesture applied meanwhile
// cannot be lost to a write that began from an older read.
function lookAway(view) {
    viewPlane[view] = ORIGIN_OF_VIEW[view];
    grids[view] = ORIGIN_OF_VIEW[view];
    if (!viewReady) return;
    toWorker({ kind: "forge.lookAway", view, radius, grid: grids[view] });
}
// A View call that may refuse (a value it will not take: a camera, a pivot, a radius): the
// refusal is said on the status line and the call answers null, so it cannot abort the redraw,
// the rebuild or the viewport setup it is part of. Across the worker a call answers a promise,
// whose refusal is said when it comes; a call that throws at once is said at once.
// A refusal that comes after a restart freed the client it was asked of ("the view was freed")
// is the restart's, not the call's, and says nothing: the status line keeps "rebuilding".
function viewerCall(f) {
    const asked = client;
    const said = (e) => { if (client === asked) say(String(e?.message ?? e), true); return null; };
    try {
        const result = f();
        return result && typeof result.then === "function" ? result.then((v) => v, said) : result;
    } catch (e) { return said(e); }
}
// The camera of view `view`, looking square at the tilted sketch it shows, framed as the
// camera it replaces was (its centre carried onto the new plane through the origin, its
// height kept); the grid is the origin plane's and would lie askew, so it goes. The worker
// keeps the camera it replaces the first time, so looking away gives it back as it was.
function aimCamera(view) {
    grids[view] = null;
    if (!viewReady) return;   // `setupViewports` aims it once the View exists
    const { frame } = planeInfo(viewPlane[view]);
    toWorker({ kind: "forge.aim", view, basis: { view: V.mul(frame.z, -1), right: frame.x, up: frame.y } });
}

// The toolbar's height, or twenty while the field is mid-edit (empty, a lone minus) or
// says zero, which is no extrusion.
function heightOf() {
    const h = +heightEl.value;
    return heightEl.value !== "" && Number.isFinite(h) && h !== 0 ? h : 20;
}
// The draft angle for a solid, degrees: the walls lean out by it as they rise (in
// when negative); nothing when the field is empty or nonsense.
function taperOf() {
    const t = +taperEl.value;
    return taperEl.value !== "" && Number.isFinite(t) && Math.abs(t) < 90 ? t : 0;
}

// The surface's pivot as it is now: where its transform has taken it.
const pivotOf = (c) => [c.pivot[0] + c.transform.tx, c.pivot[1] + c.transform.ty];

// Every selected item is copied, each copy after its original, in the same place and
// on the same sketch -- exactly where its original is, to be moved from there -- and
// the copies become the selection. A body's copy has the same source, pivot and
// transform; a sketch's the same plane.
function duplicateCurve() {
    const ids = selectedCurves().map((c) => c.id);
    if (!ids.length) return;
    const copies = ids.map((_, k) => nextId + k);
    run({ op: "duplicate", ids, copies });
    setSelection(copies);
}

// Deleting every selected curve selects the row after the last of them, or the one
// before it, or none. A status line about a deleted curve -- its error, or the last
// build's news when it was the last curve -- is stale now, and goes.
// The selected curves merged into one polycurve: two or more, on one plane, each with
// something drawn and none closed on its own, meeting end to end (`chainPieces` says
// which does not). The originals go; undo brings them back.
function mergeCurves() {
    if (curves.some((c) => c.dirty)) rebuild();
    const picked = selectedCurves().filter(isCurve);
    if (picked.length < 2) return;
    if (picked.some((c) => c.plane !== picked[0].plane)) { say("curves merge on one plane", true); return; }
    for (const c of picked) {
        if (!c.sketch.length) { say(`${c.name} has nothing drawn`, true); return; }
        if (closedByKind(c)) { say(`${c.name} is closed on its own -- nothing to join it to`, true); return; }
    }
    const pieces = picked.map(snapshot);
    let chained;
    try { chained = chainPieces(pieces); } catch (error) { say(String(error.message ?? error), true); return; }
    const id = nextId;
    const b = chained.beziers;
    // The run's ends are Float32: the picked curves' own exact ends stand in for them, so a
    // record moved onto the polycurve's end holds its partner where it was.
    const rawEnds = [[b[0], b[1]], [b[b.length - 4], b[b.length - 3]]];
    const ends = chained.closed ? rawEnds : sk.mergedEnds(picked, rawEnds);
    // Taken now: the records are remapped once the command has run, the picked curves gone.
    const was = picked.map(curveSnapshot);
    // The records on the picked curves that are not moved onto the polycurve's ends go, and
    // the status line (carried past the build) says how many: every one for a closed loop,
    // which has no ends; for an open one, all but the joints' coincidents (a start or end of
    // one picked curve held to one of another's, lying at the same point: the merge itself
    // holds them) -- a picked line's own horizontal, say, or an arc's centre held to a joint.
    // Only records on the picked curves count, never a stale one elsewhere the prune took.
    const mine = new Map(was.map((c) => [c.id, spotPositions(c)]));
    const end = (r) => (r.at === "start" || r.at === "end" ? mine.get(r.curve)?.[r.at] : undefined);
    const joint = (k) => {
        if (k.kind !== "coincident" || k.refs?.length !== 2 || k.refs[0].curve === k.refs[1].curve) return false;
        const a = end(k.refs[0]), b = end(k.refs[1]);
        return !!a && !!b && a[0] === b[0] && a[1] === b[1];
    };
    const told = (gone) => {
        const lost = gone.filter((k) => (k.refs ?? []).some((r) => mine.has(r.curve)) && (chained.closed || !joint(k)));
        if (!lost.length) return;
        const n = lost.length, s = n === 1 ? "" : "s";
        noticeNext(chained.closed ? `${n} constraint${s} on the merged curves removed: a closed polycurve has no ends to hold ${n === 1 ? "it" : "them"}`
                                  : `${n} constraint${s} on the merged curves removed: a polycurve keeps only those on its ends`);
    };
    runStructural({ op: "merge", id, plane: picked[0].plane, pieces, closed: chained.closed, ends, ids: picked.map((c) => c.id) }, [picked[0].plane],
                  chained.closed ? { dropped: told } : { remap: (list) => sk.remapMerged(list, was, id, ends), dropped: told });
    select(id);
}
const curveSnapshot = (c) => ({ id: c.id, kind: c.kind, shape: structuredClone(c.shape) });
// A polycurve exploded: its pieces back as curves, selected. The records on its ends move
// to the pieces' ends there.
function explodeCurve(c = current()) {
    if (c?.kind !== "polycurve") return;
    const ids = c.shape.pieces.map((_, k) => nextId + k);
    const was = curveSnapshot(c);
    const pieces = c.shape.pieces.map((p, k) => ({ id: ids[k], kind: p.kind, shape: structuredClone(p.shape) }));
    runStructural({ op: "explode", id: c.id, ids }, [c.plane], { remap: (list) => sk.remapExploded(list, was, pieces) });
    setSelection(ids);
}
function deleteCurve() {
    // A sketch takes what is on it along.
    const doomed = new Set(selection);
    for (const c of curves) if (isSketch(c) && doomed.has(c.id)) for (const k of curves) if (k.plane === c.id) doomed.add(k.id);
    const gone = curves.filter((c) => doomed.has(c.id));
    if (!gone.length) return;
    const last = curves.indexOf(gone[gone.length - 1]);
    const after = curves.slice(last + 1).find((c) => !doomed.has(c.id));
    const before = curves.slice(0, last).reverse().find((c) => !doomed.has(c.id));
    if (shellMode && doomed.has(shellMode.body.id)) setShellMode(null);
    if (trimMode && doomed.has(trimMode.body.id)) setTrimMode(null);
    if (sketchTrim && sketchTrim.ids.some((id) => doomed.has(id))) setSketchTrim(false);
    if (filletMode && doomed.has(filletMode.body.id)) setFilletMode(null);
    runStructural({ op: "delete", ids: [...selection] }, gone.filter(isCurve).map((c) => c.plane));   // a view looking at a deleted sketch looks at its origin plane again
    select(after?.id ?? before?.id ?? null);
    if (!curves.length) say("add a curve from the panel");
    else if (gone.some((c) => c.id === statusCurve)) say("");
}

function renameCurve(id, name) {
    const c = curves.find((k) => k.id === id);
    const trimmed = name.trim();
    if (c && trimmed && trimmed !== c.name) run({ op: "set", id, name: trimmed });
    else renderList();
}

// Selecting changes what the toolbar edits and which curves wear the accent: the toolbar
// is re-read from the active curve and the scene re-assembled on the next frame (no
// rebuild -- nothing about the curves changed). `select` makes one curve the whole
// selection; `setSelection` takes a list, its last the active one.
function setSelection(ids) {
    // A tool in progress is done with when something else is selected;
    // so is a curve being drawn.
    if (drawing && !(drawing.id !== null && ids.length === 1 && ids[0] === drawing.id)) { if (drawing.id !== null) finishDrawing(); else cancelDrawing(); }
    if (tool && !ids.every((id) => tool.ids.includes(id))) commitTool();
    selection = ids.filter((id) => curves.some((c) => c.id === id));
    selected = selection.length ? selection[selection.length - 1] : null;
    selectedPoint = null;
    if (selectedDim && !(selection.length === 1 && selected === selectedDim.sketch)) selectedDim = null;
    // A pick in progress belongs to the sketch that was active, and the shell's face
    // pick to its solid: selecting something else ends it, so an armed pick left
    // behind never swallows the clicks meant for the new selection.
    if (picking && !isSketch(current())) setPicking(null);
    if (shellMode && !(selection.length === 1 && selected === shellMode.body.id)) setShellMode(null);
    if (sketchTrim && !selection.some((id) => sketchTrim.ids.includes(id))) setSketchTrim(false);
    if (trimMode && !(selection.length === 1 && selected === trimMode.body.id)) setTrimMode(null);
    if (filletMode && !(selection.length === 1 && selected === filletMode.body.id)) setFilletMode(null);
    showPlaneOf(current());
    syncToolbar();
    renderList();
    syncPivot();
    schedule();
}
function select(id) { setSelection(id === null ? [] : [id]); }
// The view that edits `c` shows its plane: a Top body's handles live in the Top view,
// and if that view has been turned to look at a face, it turns back; a body on a
// tilted sketch no view looks at gets a view pointed at that sketch. Selecting is
// asking to work on the thing, and the view it is worked in has to be there.
function showPlaneOf(c) {
    if (!c || isSketch(c)) return;
    if (viewOf(c.plane) === null) {
        const info = planeInfo(c.plane);
        if (info.base) lookAway(PLANES[info.base].view);
        else { const sketch = curves.find((k) => k.id === c.plane && isSketch(k)); if (sketch) lookAt(sketch); }
    }
    // A curve is edited in its plane's view: with one view filling the area, that view
    // takes over (a "look at" on entering a sketch); a body stays in whichever.
    const v = viewOf(c.plane);
    if (isCurve(c) && !keepView && maximized !== null && v !== null && maximized !== v) setMaximized(v);
}
// Toggle one curve in and out of the selection; the one toggled in becomes active.
function toggleSelected(id) {
    setSelection(selection.includes(id) ? selection.filter((k) => k !== id) : [...selection, id]);
}
// The rows from the active one to `id`, in panel order, the clicked one active.
function selectRange(id) {
    const from = curves.findIndex((c) => c.id === selected), to = curves.findIndex((c) => c.id === id);
    if (from < 0) { select(id); return; }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const range = curves.slice(lo, hi + 1).map((c) => c.id);
    if (from > to) range.reverse();
    setSelection(range);
}

// The rows are rebuilt from the list whole -- a handful of curves, never more than a
// panel's worth, and a diff would be more code than it saves. A row being renamed keeps
// its input: `renderList` is not called while one is open.
let renaming = null;   // the id of the curve whose row holds a text input, or null
const folded = new Set();   // the browser's folded groups, by key
const chainSeen = new Set();   // bodies whose chain has been folded once, so a reopened one stays open
function renderList() {
    if (renaming !== null) return;
    // A tree, the browser: Bodies, then Sketches -- the three origin planes (only
    // when something is drawn on them) and each sketch item -- with the curves under
    // their plane. Every row: guide lines for its depth, a fold arrow where it has
    // children, an eye, its icon and its name; a folder's eye hides and shows all under
    // it. Every group folds (`folded`, by its key); a folded group with the active item
    // in it opens.
    const eyeOf = (hidden, ids) => {
        const eye = document.createElement("span");
        eye.className = `eye${hidden ? " off" : ""}`;
        eye.title = hidden ? "show" : "hide";
        eye.dataset.eye = ids.join(",");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", hidden ? "#i-eye-off" : "#i-eye");
        svg.append(use); eye.append(svg);
        return eye;
    };
    const foldOf = (key, count) => {
        const fold = document.createElement("span");
        fold.className = `fold${count ? "" : " none"}`;
        fold.textContent = folded.has(key) ? "▶" : "▼";
        fold.dataset.fold = key;
        return fold;
    };
    const guides = (depth) => Array.from({ length: depth }, () => { const g = document.createElement("span"); g.className = "guide"; return g; });
    // An item's row: a curve, a body, or a sketch (a folder of its curves, `key`).
    const row = (c, depth, key = null, count = 0) => {
        const li = document.createElement("li");
        li.dataset.id = c.id;
        li.classList.toggle("selected", isSelected(c));
        li.classList.toggle("active", c.id === selected);
        li.classList.toggle("error", c.error !== null);
        li.classList.toggle("open", notClosed(c));
        li.classList.toggle("hidden", !!c.hidden);
        li.title = c.error ?? (isBody(c) ? closureText(c.closure) : "");
        const glyph = document.createElement("span"); glyph.className = "glyph"; glyph.append(iconOf(c.kind));
        const name = document.createElement("span"); name.className = "name"; name.textContent = c.name;
        const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = [isSketch(c) ? dofText(c) : "", tagOf(c), key !== null && count && !isBody(c) ? count : ""].filter((t) => t !== "").join(" · ");
        tag.title = tag.textContent;   // the column cuts a long one short
        const dot = document.createElement("span"); dot.className = "dot";
        li.append(...guides(depth), foldOf(key ?? "", key !== null ? count : 0), eyeOf(!!c.hidden, [c.id]), glyph, name, tag, dot);
        return li;
    };
    // A folder's row: Bodies, Sketches, an origin plane -- its eye is its items'.
    const folder = (key, text, depth, items) => {
        const li = document.createElement("li");
        li.className = `header${depth === 0 ? " top" : ""}`;
        const glyph = document.createElement("span"); glyph.className = "glyph folder"; glyph.append(iconOf("folder"));
        const name = document.createElement("span"); name.className = "name"; name.textContent = text;
        const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = items.length ? String(items.length) : "";
        const hidden = items.length > 0 && items.every((c) => c.hidden);
        li.classList.toggle("hidden", hidden);
        li.append(...guides(depth), foldOf(key, items.length), eyeOf(hidden, items.map((c) => c.id)), glyph, name, tag);
        return li;
    };
    const rows = [];
    const bodies = curves.filter(isBody);
    const curvesOn = (key) => curves.filter((c) => (isCurve(c) || isImage(c)) && c.plane === key);
    // A body consumed by a feature (a join's part, the surface a solid was extruded
    // from, the solid a shell hollowed) nests under it, folded unless opened -- the
    // chain of features that made the body, as a timeline tells it. A selected
    // body opens the chains above it.
    // A face taken off a solid leaves the solid as it is: it consumes nothing, and a
    // chain built on it starts at the face, not at the solid the face came from.
    const consumerOf = (id) => bodies.find((b) => b.kind !== "face" && (b.parts?.includes(id) || b.from === id || b.to?.from === id || b.via?.some((v) => v.from === id))) ?? null;
    const inputsOf = (b) => b.kind === "face" ? [] : [...(b.parts ?? []), ...(b.from !== undefined ? [b.from] : []), ...(b.to?.from !== undefined ? [b.to.from] : []), ...(b.via ?? []).filter((v) => v.from !== undefined).map((v) => v.from)].map(byId).filter((c) => c && isBody(c));
    for (const c of curves) if (isSelected(c)) {
        if (isBody(c)) { folded.delete("bodies"); for (let up = consumerOf(c.id); up; up = consumerOf(up.id)) folded.delete(`chain:${up.id}`); }
        else { folded.delete("sketches"); folded.delete(`plane:${c.plane}`); }
    }
    // Bodies: one row per chain -- the tip, under the name of the body
    // the chain started as (the first input followed down: a solid over its surface,
    // a cut's target, a trim's sheet), the consumed features reachable through the
    // timeline. The row is selected when anything in its chain is, and its eye is
    // the tip's.
    const rootOf = (b) => {
        if (b.kind === "split") return b;   // two bodies of one solid: each its own name
        const inputs = inputsOf(b);
        if (!inputs.length) return b;
        if ((inputs[0].kind === "surface" || inputs[0].kind === "face") && b.kind !== "trim") return b;
        return rootOf(inputs[0]);
    };
    const members = (b) => [b, ...inputsOf(b).flatMap(members)];
    const tips = bodies.filter((b) => !consumerOf(b.id));
    rows.push(folder("bodies", "Bodies", 0, tips));
    if (!folded.has("bodies")) for (const b of tips) {
        const root = rootOf(b), li = row(b, 1);
        li.dataset.root = root.id;
        li.querySelector(".name").textContent = root.name;
        const chain = members(b);
        li.classList.toggle("selected", chain.some(isSelected));
        li.classList.toggle("active", chain.some((c) => c.id === selected));
        li.classList.toggle("error", chain.some((c) => c.error !== null));
        // The chain's errors, or its names and whether the tip -- the body it is -- is closed.
        li.title = chain.map((c) => c.error).filter((e) => e).join("; ") || chain.map((c) => c.name).join(" ◂ ") + (b.closure ? ` · ${closureText(b.closure)}` : "");
        rows.push(li);
    }
    const planes = [...["top", "front", "right"].filter((key) => curvesOn(key).length).map((key) => ({ key, name: PLANES[key].name, item: null })),
                    ...curves.filter(isSketch).map((sk) => ({ key: sk.id, name: sk.name, item: sk }))];
    const allOnPlanes = planes.flatMap(({ key, item }) => [...(item ? [item] : []), ...curvesOn(key)]);
    rows.push(folder("sketches", "Sketches", 0, allOnPlanes));
    if (!folded.has("sketches")) for (const { key, name, item } of planes) {
        const under = curvesOn(key);
        rows.push(item ? row(item, 1, `plane:${key}`, under.length) : folder(`plane:${key}`, name, 1, under));
        if (!folded.has(`plane:${key}`)) rows.push(...under.map((c) => row(c, 2)));
    }
    listEl.replaceChildren(...rows);
    const some = selected !== null;
    duplicateEl.disabled = !some; renameEl.disabled = !some; deleteEl.disabled = !some;
    syncDeleteButton();
}
// With a constraint or a dimension selected, the panel's delete takes it -- never its sketch.
function syncDeleteButton() {
    const chosen = selectedDimension();
    deleteEl.textContent = chosen ? "delete constraint" : "delete";
    deleteEl.title = chosen ? `delete ${constraintName(chosen.sketch, chosen.k.id)}, not its sketch` : "";
}

// The row's name becomes a text input: Enter commits, Escape cancels, and leaving the
// field commits too -- a click elsewhere is not a way of saying "forget it".
function startRename(id) {
    // A body's row carries the name of the body its chain started as: that is what is
    // renamed, whichever feature of the chain is selected.
    const li = listEl.querySelector(`li[data-id="${id}"]`) ?? listEl.querySelector("li.active");
    if (li?.dataset.root) id = +li.dataset.root;
    const c = curves.find((k) => k.id === id);
    if (!li || !c || renaming !== null) return;
    renaming = id;
    const input = document.createElement("input");
    input.className = "name";
    input.value = c.name;
    li.querySelector(".name").replaceWith(input);
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true; renaming = null;
        renameCurve(id, commit ? input.value : c.name);
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
        e.stopPropagation();   // Escape must not end the add mode, Delete must not delete a point
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
}

listEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("fold")) {
        const key = e.target.dataset.fold;
        if (folded.has(key)) folded.delete(key); else folded.add(key);
        renderList();
        return;
    }
    const eye = e.target.closest(".eye");
    if (eye) {
        // Hidden when any of them is shown, shown when all are hidden.
        const items = eye.dataset.eye.split(",").map((s) => byId(+s)).filter((c) => c);
        if (!items.length) return;
        const hidden = !items.every((c) => c.hidden);
        if (items.length === 1) run({ op: "set", id: items[0].id, hidden });
        else run({ op: "edit", items: items.map((c) => ({ id: c.id, hidden })) });
        return;
    }
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const id = +li.dataset.id;
    if (sweepMode) { pickSweepPath(id); return; }
    if (picking && picking !== "face" && isSketch(current())) { pickInto(current(), id); return; }
    if (sketchPick?.kind === "split") { const k = byId(id); if (k && (isBody(k) || isSketch(k))) splitBy(k.id); else if (isCurve(k)) splitByCurve(k); return; }
    if (sketchPick?.spots) { const k = byId(id); if (isCurve(k)) takeWholeCurve(k); return; }
    if (sketchPick) { const k = byId(id); if (k && (isCurve(k) || (SKETCH_PICKS[sketchPick.kind].bodies && isBody(k)))) pickCurveInto(k); return; }
    if (e.shiftKey) selectRange(id);
    else if (e.ctrlKey || e.metaKey) toggleSelected(id);
    else if (id !== selected || selection.length !== 1) select(id);
});
listEl.addEventListener("dblclick", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) startRename(+li.dataset.id);
});
for (const button of document.querySelectorAll("#ribbon-sketch button[data-kind]")) {
    button.addEventListener("click", () => startDrawing(button.dataset.kind));
}
duplicateEl.addEventListener("click", duplicateCurve);
mergeEl.addEventListener("click", () => armSketchPick("merge"));
explodeEl.addEventListener("click", () => armSketchPick("explode"));
surfaceEl.addEventListener("click", () => armSketchPick("surface"));
closedEl.addEventListener("click", () => armSketchPick("close"));
extrudeEl.addEventListener("click", () => armSketchPick("extrusion"));
revolveEl.addEventListener("click", () => { if (axisMode) armRevolve(); else armSketchPick("revolution"); });
sweepEl.addEventListener("click", () => { if (sweepMode) newSweep(); else armSketchPick("sweep"); });
addSketchEl.addEventListener("click", () => newSketch());
document.getElementById("add-sketch-solid").addEventListener("click", () => newSketch());
for (const b of document.querySelectorAll("[data-plane-mode]")) b.addEventListener("click", () => newSketch(b.dataset.planeMode));
// The toolbar's tabs: Sketch for the curves and the sketch planes, Solid for the
// bodies. The tab follows the selection (`syncToolbar`) unless one was chosen by hand
// since -- a click on a tab holds it until the next selection.
let tab = "sketch";
function showTab(which) {
    tab = which;
    tabSketchEl.setAttribute("aria-selected", String(which === "sketch"));
    tabSolidEl.setAttribute("aria-selected", String(which === "solid"));
    tabConstructEl.setAttribute("aria-selected", String(which === "construct"));
    ribbonSketchEl.classList.toggle("open", which === "sketch");
    ribbonSolidEl.classList.toggle("open", which === "solid");
    ribbonConstructEl.classList.toggle("open", which === "construct");
}
tabSketchEl.addEventListener("click", () => showTab("sketch"));
tabSolidEl.addEventListener("click", () => showTab("solid"));
tabConstructEl.addEventListener("click", () => showTab("construct"));
// Finish sketch: over to the bodies, the selection dropped.
sketchFilletEl.addEventListener("click", () => armSketchPick("fillet"));
pickHingeEl.addEventListener("click", () => setPicking(picking === "hinge" ? null : "hinge"));
pickPathEl.addEventListener("click", () => setPicking(picking === "path" ? null : "path"));
pickFaceEl.addEventListener("click", () => setPicking(picking === "face" ? null : "face"));
pickMidEl.addEventListener("click", () => setPicking(picking === "planes" ? null : "planes"));
pickPointsEl.addEventListener("click", () => setPicking(picking === "points" ? null : "points"));
for (const b of midOriginEl.querySelectorAll("[data-mid-plane]")) b.addEventListener("click", () => {
    const c = current();
    if (!isSketch(c)) return;
    if (picking !== "planes") setPicking("planes");
    pickMidInto(c, b.dataset.midPlane);
});
modeEl.addEventListener("change", () => {
    const c = current();
    if (!isSketch(c)) return;
    run({ op: "set", id: c.id, mode: modeEl.value });
    // A mode with nothing picked yet asks for it.
    if (c.mode === "angle" && c.hinge === null) setPicking("hinge");
    else if (c.mode === "path" && c.path === null) setPicking("path");
    else if (c.mode === "face" && c.face === null) setPicking("face");
    else if (c.mode === "mid" && !c.mid) setPicking("planes");
    else if (c.mode === "points" && !c.points) setPicking("points");
    replaneSketch(c);
});
baseEl.addEventListener("change", () => {
    const c = current();
    if (!isSketch(c) || c.mode !== "offset") return;
    run({ op: "set", id: c.id, base: baseEl.value });
    replaneSketch(c);
});
tiltEl.addEventListener("input", () => {
    const c = current();
    if (!isSketch(c) || c.mode !== "angle") return;
    const t = +tiltEl.value;
    if (tiltEl.value === "" || !Number.isFinite(t)) return;
    run({ op: "set", id: c.id, tilt: t }, true);   // the rebuild sees the frame change and moves everything on the sketch
});
lookAtEl.addEventListener("click", () => { const c = current(); if (isSketch(c)) lookAt(c); });
offsetEl.addEventListener("input", () => {
    const c = current();
    if (!isSketch(c)) return;
    const o = +offsetEl.value;
    if (offsetEl.value === "" || !Number.isFinite(o)) return;
    run({ op: "set", id: c.id, offset: o }, true);
});
angleEl.addEventListener("input", () => {
    const c = current();
    if (c?.kind !== "revolution") return;
    const a = +angleEl.value;
    if (angleEl.value === "" || !Number.isFinite(a) || a <= 0 || a > 360) return;
    run({ op: "set", id: c.id, angle: a }, true);
    renderList();
});
// The height field is the active extrusion's while one is active (a change rebuilds
// it), and otherwise the height the next extrusion gets.
heightEl.addEventListener("input", () => {
    const c = dialogItem();
    if (c?.kind !== "extrusion" && c?.kind !== "solid" && c?.kind !== "prism" && c?.kind !== "press") return;
    const h = +heightEl.value;
    if (heightEl.value === "" || !Number.isFinite(h) || h === 0) return;
    // A solid's own face pulled in past zero cuts, and pushed back out joins, as a
    // face extrude switches: the session re-run at the new distance.
    const want = h < 0 ? "cut" : "join";
    if (tool?.ownFace && tool.rerun && (tool.operation === "join" || tool.operation === "cut") && tool.operation !== want) {
        rerunAs(tool, want);
        renderDialog();
        return;
    }
    run({ op: "set", id: c.id, height: h }, true);
    renderList();   // the row's tag says the height
});
taperEl.addEventListener("input", () => {
    const c = dialogItem();
    if (c?.kind !== "solid" && c?.kind !== "extrusion") return;
    const t = +taperEl.value;
    if (taperEl.value === "" || !Number.isFinite(t) || Math.abs(t) >= 90) return;
    run({ op: "set", id: c.id, taper: t }, true);
    renderList();
});
// Join: two or more solids selected join at once; one arms the pick for the rest.
joinEl.addEventListener("click", () => {
    if (sketchPick?.kind === "join") { pressedAgain(pickReady("join")); return; }
    if (selectedCurves().filter(isSolid).length >= 2) newJoin();
    else armSketchPick("join");
});
filletEl.addEventListener("click", () => {
    if (filletMode) { pressedAgain(filletMode.body.edges.length > 0); return; }
    const c = current();
    if (c?.kind === "fillet" && selection.length === 1) { if (c.gpu) setFilletMode(c); return; }
    newFillet();
});
radiusEl.addEventListener("input", () => {
    const c = current();
    if (c?.kind !== "fillet" && c?.kind !== "refillet" && c?.kind !== "rechamfer") return;
    const r = radiusOf();
    if (r === null) return;
    run({ op: "set", id: c.id, radius: r }, true);
    if (filletMode) hintEl.textContent = filletHint();
    renderDialog();
});
trimEl.addEventListener("click", () => {
    if (sketchPick?.kind === "trim") { disarmSketchPick(true); return; }
    if (trimMode) { setTrimMode(null); return; }
    const c = current();
    if (c?.kind === "trim" && selection.length === 1) { if (c.gpu) setTrimMode(c); return; }
    // A sheet and its tool selected trim at once; either alone arms the pick for the other.
    const picked = selectedCurves();
    if (picked.length === 2) { newTrim(); return; }
    if (picked.length === 1 && (isSheet(picked[0]) || isTool(picked[0]))) armSketchPick("trim", picked[0].id);
});
shellEl.addEventListener("click", () => act(async () => {
    if (shellMode) { await newShell(); return; }
    const solids = selectedCurves().filter(isSolid);
    if (solids.length !== 1) return;
    await whenBuilt([solids[0].id]);
    if (solids[0].error !== null || !solids[0].gpu) { say(`${solids[0].name} has not been built`, true); return; }
    const at = headNow();
    setShellMode(solids[0]);
    openTool(at, [solids[0].id], "Shell", "shell");
}));
// The thickness field is the active shell's while one is active (a change hollows it
// again), and otherwise the thickness the next shell gets.
thicknessEl.addEventListener("input", () => {
    const c = current();
    if (c?.kind !== "shell" && c?.kind !== "thicken") return;
    const t = thicknessOf();
    if (t === null) return;
    run({ op: "set", id: c.id, thickness: t }, true);
});
renameEl.addEventListener("click", () => { if (selected !== null) startRename(selected); });
deleteEl.addEventListener("click", () => { const chosen = selectedDimension(); if (chosen) deleteConstraint(chosen.sketch.id, chosen.k.id); else deleteCurve(); });

// The weight slider is logarithmic, 0.1 .. 10.
const weightOf = (s) => 0.1 * Math.pow(100, s);
const sliderOfWeight = (w) => Math.log(w / 0.1) / Math.log(100);

// The toolbar follows the selection: add point / closed for a polyline or a NURBS, degree
// for a NURBS only, the weight for its selected control point only.
function syncToolbar() {
    renderProps();
    const c = current();
    // A sketch made on the Construct tab keeps it open while its plane is placed.
    if (c) showTab(isBody(c) ? "solid" : isSketch(c) && tab === "construct" ? "construct" : "sketch");
    const nurbs = c?.kind === "nurbs", points = pointed(c);
    degreeEl.disabled = !nurbs;
    if (nurbs) degreeEl.value = c.shape.degree;
    closedEl.setAttribute("aria-pressed", String(sketchPick?.kind === "close"));
    surfaceEl.setAttribute("aria-pressed", String(sketchPick?.kind === "surface"));
    mergeEl.setAttribute("aria-pressed", String(sketchPick?.kind === "merge"));
    explodeEl.setAttribute("aria-pressed", String(sketchPick?.kind === "explode"));
    for (const b of constrainEls) b.setAttribute("aria-pressed", String(sketchPick?.kind === b.dataset.constrain));
    syncModifyButtons();
    extrudeEl.setAttribute("aria-pressed", String(sketchPick?.kind === "extrusion"));
    if (!axisMode) revolveEl.setAttribute("aria-pressed", String(sketchPick?.kind === "revolution"));
    if (!sweepMode) sweepEl.setAttribute("aria-pressed", String(sketchPick?.kind === "sweep"));
    syncSolidButtons();
    stlEl.disabled = glbEl.disabled = objEl.disabled = stepEl.disabled = !curves.some((c) => isSolid(c) && c.gpu && c.error === null);
    splitEl.disabled = sketchPick?.kind !== "split" && splitParts() === null;
    splitEl.setAttribute("aria-pressed", String(sketchPick?.kind === "split"));
    pipeEl.setAttribute("aria-pressed", String(sketchPick?.kind === "pipe"));
    thickenEl.setAttribute("aria-pressed", String(sketchPick?.kind === "thicken"));
    thickenEl.disabled = sketchPick?.kind !== "thicken" && !selectedCurves().some(isSheet);
    shellEl.disabled = !shellMode && selectedCurves().filter(isSolid).length !== 1;
    filletEl.disabled = !filletMode && !(c?.kind === "fillet" && selection.length === 1) && !(selectedCurves().length === 1 && isSolid(c));
    sketchFilletEl.setAttribute("aria-pressed", String(sketchPick?.kind === "fillet"));
    chamferEl.disabled = !filletMode && !(c?.kind === "fillet" && c.style === "chamfer" && selection.length === 1) && !(selectedCurves().length === 1 && isSolid(c));
    if (c?.kind === "fillet" || c?.kind === "refillet" || c?.kind === "rechamfer") radiusEl.value = c.radius;
    radiusLabelEl.textContent = (c?.kind === "fillet" && c.style === "chamfer") || c?.kind === "rechamfer" ? "distance" : "radius";
    removeEl.setAttribute("aria-pressed", String(sketchPick?.kind === "remove"));
    removeEl.disabled = sketchPick?.kind !== "remove" && !selectedCurves().some((k) => isSolid(k) && k.gpu && visible(k));
    trimEl.disabled = !trimMode && sketchPick?.kind !== "trim" && !(c?.kind === "trim" && selection.length === 1)
        && !(selectedCurves().length === 2 && selectedCurves().some(isSheet) && selectedCurves().some(isTool))
        && !(selectedCurves().length === 1 && (isSheet(selectedCurves()[0]) || isTool(selectedCurves()[0])));
    if (c?.kind === "shell" || c?.kind === "thicken") thicknessEl.value = c.thickness;
    const d = dialogItem();
    if (d?.kind === "extrusion" || d?.kind === "solid" || d?.kind === "prism" || d?.kind === "press") heightEl.value = d.height;
    if (d?.kind === "solid" || d?.kind === "extrusion") taperEl.value = d.taper ?? 0;
    if (c?.kind === "revolution") angleEl.value = c.angle;
    // The sketch tools' fields are its mode's.
    if (isSketch(c)) {
        modeEl.value = c.mode; baseEl.value = c.base; offsetEl.value = c.offset; tiltEl.value = c.tilt;
        baseField.hidden = offsetField.hidden = c.mode !== "offset";
        pickHingeEl.hidden = tiltField.hidden = c.mode !== "angle";
        pickPathEl.hidden = c.mode !== "path";
        pickFaceEl.hidden = c.mode !== "face";
        pickMidEl.hidden = midOriginEl.hidden = c.mode !== "mid";
        pickPointsEl.hidden = c.mode !== "points";
        lookAtEl.setAttribute("aria-pressed", String(VIEW_PLANE_KEYS.some((k) => viewPlane[k] === c.id)));
    } else if (picking) setPicking(null);
    weightEl.disabled = !(nurbs && selectedPoint !== null);
    if (nurbs && selectedPoint !== null) {
        weightEl.value = sliderOfWeight(c.shape.weights[selectedPoint]);
        weightValueEl.textContent = c.shape.weights[selectedPoint].toFixed(2);
    } else {
        weightValueEl.textContent = "";
    }
    if (!drawing && !picking && !sketchPick && !sweepMode && !axisMode) hintEl.textContent = hintFor(c?.kind);   // a pick in progress keeps its own hint
}

function selectPoint(i) {
    selectedPoint = i;
    syncToolbar();
}

// ------------------------------------------------------------------ the properties

// The active item's numbers, typed as well as dragged: a strip under the toolbar with a
// field per number of its shape -- a line's or rectangle's two corners, a circle's centre
// and radius, an arc's three points, an ellipse's centre and semi-axes, the selected
// point of a polyline or NURBS (and its index), a body's move, turn and scale. Each
// field reads and writes the document directly; typing rebuilds like a drag does. The
// strip is rebuilt when what it shows changes and its values refreshed after every
// build, the field being typed in left alone.
function fieldsOf(c) {
    if (!c) return [];
    const s = c.shape, n = (k) => ({ label: k, get: () => s[k], set: (v) => { s[k] = v; } });
    if (c.kind === "polycurve") return [];
    if (c.kind === "line" || c.kind === "rect") return [n("x0"), n("y0"), n("x1"), n("y1")];
    if (c.kind === "circle") return [n("cx"), n("cy"), { label: "r", get: () => s.r, set: (v) => { s.r = Math.max(0.5, v); } }];
    if (c.kind === "arc") return [n("x0"), n("y0"), n("xm"), n("ym"), n("x1"), n("y1")];
    if (c.kind === "ellipse") return [n("cx"), n("cy"), { label: "rx", get: () => s.rx, set: (v) => { s.rx = Math.max(0.5, v); } }, { label: "ry", get: () => s.ry, set: (v) => { s.ry = Math.max(0.5, v); } }];
    if (c.kind === "polygon") return [n("cx"), n("cy"), { label: "r", get: () => s.r, set: (v) => { s.r = Math.max(0.5, v); } },
                                      { label: "sides", get: () => s.sides, set: (v) => { s.sides = Math.max(3, Math.min(64, Math.round(v))); } }, n("angle")];
    if (pointed(c)) {
        if (selectedPoint === null || selectedPoint >= s.points.length) return [];
        const p = s.points[selectedPoint];
        return [{ label: "x", get: () => p[0], set: (v) => { p[0] = v; } }, { label: "y", get: () => p[1], set: (v) => { p[1] = v; } }];
    }
    if (isImage(c)) return [];
    if (isBody(c)) {
        const t = c.transform;
        const dims = (DIMS[c.kind]?.labels ?? []).map((label, k) => ({ label, get: () => c.dims[k],
            set: (v) => { c.dims[k] = label === "sides" ? Math.max(3, Math.min(64, Math.round(v))) : Math.max(label === "wall" ? 0 : 0.01, v); } }));
        return [
            ...dims,
            // One place in the world: where the body's pivot is along X, Y, Z
            // -- its plane's point (moved in the plane by an older document's in-plane
            // transform, which nothing edits any more) plus the world offset, which is
            // what a typed value sets -- and its turns about the world axes.
            ...["X", "Y", "Z"].map((a, i) => ({ label: a, get: () => embed3(c.plane, pivotOf(c))[i] + placeOf(c).offset[i],
                                                set: (v) => { c.place = placeOf(c); c.place.offset[i] = v - embed3(c.plane, pivotOf(c))[i]; } })),
            ...["X", "Y", "Z"].map((a, i) => ({ label: `turn ${a}°`, get: () => placeOf(c).turn[i], set: (v) => { c.place = placeOf(c); c.place.turn[i] = v; } })),
            ...(isMade(c) ? [] : [{ label: "scale", get: () => t.scale, set: (v) => { t.scale = Math.max(0.05, v); } }]),
        ];
    }
    return [];
}
let propsKey;   // undefined until the rows are first built, so an empty first key still builds them
function renderProps() {
    const c = current();
    const fields = fieldsOf(c);
    const dim = selectedDimension();
    const key = c ? `${c.id}|${c.kind}|${pointed(c) ? selectedPoint : ""}${dim ? `|dimension ${dim.k.id} ${dim.k.kind} ${dim.k.driving !== false}` : ""}` : null;
    if (key !== propsKey) {
        propsKey = key;
        propsEl.replaceChildren(...fields.map((f, i) => {
            const label = document.createElement("label");
            label.className = "row";
            const input = document.createElement("input");
            input.type = "number"; input.step = "any"; input.dataset.field = i;
            input.value = round(f.get());
            input.addEventListener("input", () => {
                const v = +input.value;
                if (input.value === "" || !Number.isFinite(v)) return;
                const sketch = sketchOf(current());
                if (sketch) {
                    // Refused (held by a constraint, or no solve): the field keeps what is being
                    // typed, marked invalid, until Enter or blur shows what stands.
                    if (!typedHeld(current(), sketch, () => fieldsOf(current())[i]?.set(v), () => fieldsOf(current())[i]?.get(), fieldsOf(current())[i]?.label)) input.setAttribute("aria-invalid", "true");
                    else input.removeAttribute("aria-invalid");
                    return;
                }
                fieldsOf(current())[i]?.set(v);
                const k = current();
                if (k) note(k, isBody(k) ? ["transform", "place", ...(k.dims ? ["dims"] : [])] : ["shape"], true);
            });
            input.addEventListener("change", () => {
                if (input.getAttribute("aria-invalid") !== "true") return;
                input.removeAttribute("aria-invalid");
                const g = fieldsOf(current())[i];
                if (g) input.value = round(g.get());
            });
            label.append(f.label, input);
            return label;
        }), ...(dim ? dimensionRows(dim.sketch, dim.k) : []));
        renderDialog();
        return;
    }
    for (const input of propsEl.querySelectorAll("input")) {
        if (input === document.activeElement) continue;
        if (input.dataset.dim === "value") { const v = round(shownValue(dim.k)); if (input.value !== String(v)) input.value = v; continue; }
        const v = round(fields[+input.dataset.field].get());
        if (input.value !== String(v)) input.value = v;
    }
    renderDialog();
}
const round = (v) => Math.round(v * 1000) / 1000;
// A typed field of a curve on a sketch: the value set, the sketch solved around it when it
// is constrained, and one `edit` of every curve that moved (and the constraints a migration
// gave the sketch) -- the run of keystrokes in one field one command, as `note`'s merge
// makes it for a plain curve. What does not solve changes nothing and says why.
let typedRun = null;   // { cmd, id }: the last typed edit's command and its curve
// A curve's point spots where its shape puts them, and the rest of the shape (what no spot
// carries: a rim, a through-point, a polygon's size and turn, a NURBS's weights).
function spotsAndRest(kind, s) {
    const { x0, y0, x1, y1, xm, ym, cx, cy, r, rx, ry, sides, angle, points, closed, weights, degree } = s;
    switch (kind) {
    case "line": return [{ start: [x0, y0], end: [x1, y1] }, []];
    case "arc": return [{ start: [x0, y0], end: [x1, y1] }, [xm, ym]];
    case "rect": return [{ "corner:0": [x0, y0], "corner:2": [x1, y1] }, []];
    case "circle": return [{ centre: [cx, cy] }, [r]];
    case "ellipse": return [{ centre: [cx, cy] }, [rx, ry]];
    case "polygon": return [{ centre: [cx, cy] }, [r, sides, angle]];
    case "polyline": case "nurbs": return [Object.fromEntries(points.map((p, i) => [`vertex:${i}`, p])), [points.length, closed, weights, degree]];
    default: return null;
    }
}
// The spots of `c` a typed value moved since `was`, as drag moves, or null when it changed
// anything else.
function spotMoves(c, was) {
    const a = spotsAndRest(c.kind, was), b = spotsAndRest(c.kind, c.shape);
    if (!a || !b || JSON.stringify(a[1]) !== JSON.stringify(b[1])) return null;
    const moves = [];
    for (const [at, p] of Object.entries(b[0])) if (p[0] !== a[0][at]?.[0] || p[1] !== a[0][at]?.[1]) moves.push({ curve: c.id, at, x: p[0], y: p[1] });
    // A rectangle's two corners go together: one typed edge moves both of its corners.
    if (c.kind === "rect" && moves.length) return ["corner:0", "corner:2"].map((at) => ({ curve: c.id, at, x: b[0][at][0], y: b[0][at][1] }));
    return moves.length ? moves : null;
}
function typedHeld(c, sketch, set, get = null, label = null) {
    const start = constrainedStart(sketch);
    const held = constrained(sketch);
    let before = null;
    try { before = held ? modelFor(sketch) : null; } catch { before = null; }   // the session before the value
    const was = structuredClone(c.shape);
    set();
    const typed = get ? get() : null;   // as the field took it (clamped, rounded)
    c.dirty = true;
    // A sides count typed changes the polygon's spots.
    if (sketch.constraints) setConstraints(sketch, sk.pruneConstraints(sketch.constraints, curvesMap(sketchCurves(sketch))).kept);
    if (held) {
        let error = null;
        try {
            error = solveTyped(c, was, sketch, before, label);
        } catch (e) { error = String(e?.message ?? e); }
        // Solved, but the value typed is not the value that stands: a constraint holds it.
        if (!error && get && typeof typed === "number") {
            let now = get();
            if (label === "angle") now = typed + ((((now - typed) % 360) + 540) % 360 - 180);   // a turn written back in [0, 360)
            if (!(Math.abs(now - typed) <= 1e-9 * Math.max(1, Math.abs(typed)))) error = `${label ?? "the value"} is held by ${holdersOf(sketch, c)}`;
        }
        // The value, or the solve around it, shrank a curve to a point: the kernel would hold
        // it as solved, and the next drag would carry it on collapsed.
        if (!error) {
            const gone = collapsed(start, sketchCurves(sketch).map((k) => k.id));
            if (gone) error = collapseText(sketch, gone, null);
        }
        if (error) { restoreStart(start); refuse(`${c.name}: ${error}`); return false; }
    }
    // A typed through-point can flip the arc's bulge, which a session built on the arc as
    // it was would keep on the complementary arc: the next use builds from the document.
    if (c.kind === "arc" && (label === "xm" || label === "ym")) dropKeepingRed(sketch);
    // A record the value lets apply, in its step -- never one that would move the value
    // typed (held exactly, by the same test as above): that one stays refused.
    if (held) settleRefused(sketch, () => {
        if (!get || typeof typed !== "number" || !byId(c.id)) return true;
        let now = get();
        if (label === "angle") now = typed + ((((now - typed) % 360) + 540) % 360 - 180);
        return Math.abs(now - typed) <= 1e-9 * Math.max(1, Math.abs(typed));
    });
    const items = changedSince(start);
    if (!items.length) { schedule(); return true; }
    const last = pendingRun?.cmd;
    if (typedRun && last === typedRun.cmd && typedRun.id === c.id) {
        // The same field typed on: the curves this keystroke moved over the last one's.
        const merged = new Map(last.items.map((it) => [it.id, { ...it }]));
        for (const it of items) merged.set(it.id, { ...(merged.get(it.id) ?? {}), ...it });
        const cmd = { op: "edit", items: [...merged.values()] };
        run(cmd, "replace");
        typedRun = { cmd, id: c.id };
    } else {
        // Held as the pending run (`apply`), so the next keystroke in the field folds into it.
        const cmd = { op: "edit", items };
        run(cmd, "hold");
        typedRun = { cmd, id: c.id };
    }
    return true;
}
// A typed value on a held sketch solved with the value itself held where it can be: a
// typed point (an end, a corner, a centre, a vertex) dragged there; a circle's radius held
// by a throwaway driving radius while the rest solves; a polygon's size or turn as its
// first vertex dragged to where the value puts it, the centre held; an arc's through-point
// as its centre dragged to the new three points' circumcentre, the ends held (and the
// through-point kept as typed, it being on that circle). An ellipse's semi-axes are not in
// the session: set, nothing solved. Anything else (a sides count, a NURBS's weights or
// degree) is set and the sketch solved around it. `before` is the session as it was before
// the value; the error, or null. `typedHeld` checks the value stands after.
const TYPED_RADIUS = -1;   // the throwaway constraint's doc id
function solveTyped(c, was, sketch, before, label) {
    const has = (at) => before?.entity.has(`${c.id}:${at}`);
    const drag = (moves) => {
        const report = sk.dragModel(wasm, before, moves);
        return report.status === "converged" ? writeSolved(sketch, before).error : solveFailure(sketch, report);
    };
    const moves = before && spotMoves(c, was);
    if (moves && moves.every((m) => before.entity.has(`${m.curve}:${m.at}`))) return drag(moves);
    const s = c.shape;
    if (c.kind === "ellipse" && (label === "rx" || label === "ry")) return null;
    if (c.kind === "circle" && label === "r" && has("curve")) {
        const added = sk.addConstraint(wasm, before, { id: TYPED_RADIUS, kind: "radius", refs: [{ curve: c.id, at: "curve" }], value: s.r, driving: true });
        if (!added.ok) return `r is held by ${added.with.length ? added.with.map((id) => constraintName(sketch, id)).join(", ") : "the sketch's constraints"}`;
        try {
            const report = sk.solveModel(wasm, before);
            return report.status === "converged" ? writeSolved(sketch, before).error : solveFailure(sketch, report);
        } finally { if (models.get(sketch.id)?.model === before) sk.removeConstraint(wasm, before, TYPED_RADIUS); }
    }
    if (c.kind === "polygon" && (label === "r" || label === "angle") && has("centre") && has("vertex:0")) {
        const v = polygonPoints(s)[0];
        return drag([{ curve: c.id, at: "centre", x: s.cx, y: s.cy }, { curve: c.id, at: "vertex:0", x: v[0], y: v[1] }]);
    }
    if (c.kind === "arc" && (label === "xm" || label === "ym") && has("centre") && has("start") && has("end")) {
        const o = circumcentreOf([s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]);
        if (!o) return "the arc's three points are in a line";
        const xm = s.xm, ym = s.ym;
        const error = drag([{ curve: c.id, at: "start", x: s.x0, y: s.y0 }, { curve: c.id, at: "end", x: s.x1, y: s.y1 }, { curve: c.id, at: "centre", x: o[0], y: o[1] }]);
        if (error) return error;
        // The write-back puts the through-point at the arc's mid-angle; the typed one is
        // kept where it lies on the solved circle (the same arc).
        const pt = (at) => Array.from(wasm.cadaclysm_blacksmith_sketch_point(before.h, before.entity.get(`${c.id}:${at}`)));
        const centre = pt("centre"), start = pt("start"), r = Math.hypot(start[0] - centre[0], start[1] - centre[1]);
        if (!(Math.abs(Math.hypot(xm - centre[0], ym - centre[1]) - r) <= 1e-9 * Math.max(1, r))) return `the through-point is held by ${holdersOf(sketch, c)}`;
        c.shape = { ...c.shape, xm, ym };
        c.dirty = true;
        return null;   // the session is dropped after (`typedHeld`)
    }
    const model = modelFor(sketch);
    const report = sk.solveModel(wasm, model);
    return report.status === "converged" ? writeSolved(sketch, model).error : solveFailure(sketch, report);
}
// The circumcentre of three points, or null when they are in a line.
function circumcentreOf([ax, ay], [bx, by], [cx, cy]) {
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (!(Math.abs(d) > 1e-12)) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    return [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
}
// The stored constraints that bind curve `c`, named, or the sketch's as a whole.
function holdersOf(sketch, c) {
    const names = holderNames(sketch, c);
    return names.length ? names.join(", ") : "the sketch's constraints";
}
// The names of the stored constraints that bind curve `c`, but `skip` (a doc id).
const holderNames = (sketch, c, skip = null) => (sketch.constraints ?? []).filter((k) => k.id !== skip && (k.refs ?? []).some((r) => r.curve === c.id)).map((k) => constraintName(sketch, k.id));
// Why a solve that shrank curve `gone` is refused: what else holds it, the constraint
// refused (`skip`) left out.
function collapseText(sketch, gone, skip) {
    const names = holderNames(sketch, gone, skip);
    const name = sk.curveName(gone);
    return `it would shrink ${name} to a point — ${names.length ? `the constraints on it: ${names.join(", ")}` : `${name} has no stored constraints`}`;
}

// ------------------------------------------------------------------ the dialog and the tools

// A tool in progress -- extrude pressed, a shell's faces being picked -- is a session:
// `openedAt` where the history stood when it began, `ids` what it has made (or, while
// it is still arming, what it works on), so that Cancel rolls the document back to
// before it (`cancelAt`: `openedAt`, or earlier still -- before the face an extrude
// took for its profile) and OK keeps it. Selecting anything else commits it; Enter
// is OK and Esc is Cancel. An extrude of a surface with a target (`rerun`) offers the
// operation -- new body, join, cut, intersect -- re-run from the session's start.
let tool = null;
// The item the dialog's extrude rows edit: the session's solid while an extrude is
// being cut into (or joined to) a target -- the selection is then the boolean -- and
// otherwise the active item.
const dialogItem = () => (tool?.rerun ? byId(tool.ids[0]) : null) ?? current();
function openTool(openedAt, ids, title, glyph) {
    tool = { openedAt, cancelAt: openedAt, ids: ids.slice(), title, glyph, rerun: null, operation: null, was: selection.slice() };
    // A body is looked at in Perspective: a sketch view filling the area gives way
    // (a surface stays in its sketch's view, being flat there; a revolve too, its axis
    // being placed in that view).
    if (maximized !== null && maximized !== 1 && title !== "Surface" && title !== "Revolve" && !(title === "Sweep" && sweepMode)) { setMaximized(1); rebuild(); frameAll(); }
    renderDialog();
    return tool;
}
function commitTool() {
    if (!tool) return;
    tool = null;
    if (shellMode) newShell();
    else if (axisMode) newBody("revolution");
    if (sweepMode) setSweepMode(null);
    if (trimMode) setTrimMode(null);
    if (filletMode) setFilletMode(null);
    renderDialog();
}
function cancelTool() {
    if (!tool) return;
    const { cancelAt, was } = tool;
    tool = null;
    if (axisMode) setAxisMode(null);
    if (shellMode) setShellMode(null);
    if (sweepMode) setSweepMode(null);
    if (trimMode) setTrimMode(null);
    if (filletMode) setFilletMode(null);
    return act(async () => {
        flushPending();
        if (doneSince(cancelAt)) { await rollbackTo(cancelAt); say(`cancelled · ${head} of ${history.length}`); }
        setSelection(was);   // what was selected before the tool began, as far as it still exists
        renderDialog();
    });
}
dialogEl.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== "Escape") e.stopPropagation(); });
dialogOkEl.addEventListener("click", confirmPicks);
dialogCancelEl.addEventListener("click", cancelPicks);
// The look: the colour and the material, on the active body (every selected body,
// when several are).
function setLook(fields) {
    const targets = selectedCurves().filter(isBody);
    if (!targets.length) return;
    if (targets.length === 1) run({ op: "set", id: targets[0].id, look: { ...lookOf(targets[0]), ...fields } }, true);
    else run({ op: "edit", items: targets.map((c) => ({ id: c.id, look: { ...lookOf(c), ...fields } })) });
}
lookColourEl.addEventListener("input", () => setLook({ colour: lookColourEl.value }));
lookMaterialEl.addEventListener("change", () => setLook({ material: lookMaterialEl.value }));
lookOpacityEl.addEventListener("input", () => setLook({ opacity: +lookOpacityEl.value }));
lookResetEl.addEventListener("click", () => {
    const targets = selectedCurves().filter(isBody);
    if (!targets.length) return;
    if (targets.length === 1) run({ op: "set", id: targets[0].id, look: null });
    else run({ op: "edit", items: targets.map((c) => ({ id: c.id, look: null })) });
});
// The extrude session re-run from its start as `operation`: rolled back to where it
// opened, then the solid and the boolean with the target again.
function rerunAs(session, operation) {
    return act(async () => {
        tool = null;                       // the rollback's replay must not commit the session
        await rollbackTo(session.openedAt);
        tool = session; session.operation = operation;
        await session.rerun(operation);
    });
}
operationEl.addEventListener("change", () => act(async () => {
    if (!tool?.rerun) return;
    await rerunAs(tool, operationEl.value);
    renderDialog();
}));

// The dialog: the active item's name and fields, the tool's choices and its note (the
// hint for the pick in progress, or the item's error), OK / Cancel while a tool is in
// progress. Rows show for the kinds in context (`data-for`): the active item's, plus
// the states that add rows -- a NURBS's selected point, an armed revolve's angle, a
// shell being picked, an extrude with an operation to choose.
function renderDialog() {
    const c = current();
    const modeOn = !!(shellMode || trimMode || sketchTrim || filletMode || sweepMode || axisMode || picking || drawing || sketchPick);
    if (!c && !tool && !modeOn) { dialogEl.hidden = true; return; }
    dialogEl.hidden = false;
    const kinds = new Set();
    // While a sketch tool picks its curves the dialog is the tool's alone: the picked
    // curves' own numbers and handles come back when it is done.
    if (c && !sketchPick && !sketchTrim) kinds.add(c.kind);
    if (c && isBody(c) && !sketchPick) {
        kinds.add("body");
        const look = lookOf(c);
        if (document.activeElement !== lookColourEl) lookColourEl.value = look.colour;
        lookMaterialEl.value = look.material;
        if (look.material === "glass") { kinds.add("glass"); if (document.activeElement !== lookOpacityEl) lookOpacityEl.value = look.opacity ?? 0.35; }
    }
    const d = dialogItem();
    if (d && d !== c && !sketchPick && !sketchTrim) kinds.add(d.kind);
    if (c?.kind === "nurbs" && selectedPoint !== null && !sketchPick && !sketchTrim) kinds.add("nurbs-point");
    if (axisMode) kinds.add("axis");
    if (shellMode) kinds.add("shellmode");
    if (shellMode || filletMode || trimMode || sketchTrim || sketchPick) { kinds.add("picks"); renderPicks(); }
    if (sketchPick?.kind === "fillet") kinds.add("fillet");
    if (sketchPick?.kind === "split") kinds.add("split-pick");
    if (tool?.rerun) kinds.add("operation");
    // The separator before the item's own numbers, when a tool's rows come first.
    if (propsEl.children.length && !sketchPick && !sketchTrim && [...dialogEl.querySelectorAll("[data-for]")].some((row) => row.dataset.for !== "props" && row.dataset.for.split(" ").some((k) => kinds.has(k)))) kinds.add("props");
    propsEl.style.display = sketchPick || sketchTrim ? "none" : "contents";
    for (const row of dialogEl.querySelectorAll("[data-for]")) {
        const wanted = row.dataset.for.split(" ").some((k) => kinds.has(k));
        if (row.id === "sketch-tools") row.style.display = wanted ? "contents" : "none";
        else row.hidden = !wanted;
    }
    if (tool?.rerun) operationEl.value = tool.operation ?? "new";
    if (c && isImage(c)) {
        for (const [el, v] of [[imageWidthEl, c.width], [imageXEl, c.at[0]], [imageYEl, c.at[1]], [imageAngleEl, c.angle], [imageOpacityEl, c.opacity]]) {
            if (el !== document.activeElement && el.value !== String(round(v))) el.value = round(v);
        }
        imageFlipXEl.setAttribute("aria-pressed", String(!!c.flipX));
        imageFlipYEl.setAttribute("aria-pressed", String(!!c.flipY));
    }
    dialogGlyphEl.replaceChildren(sketchPick ? iconOf(SKETCH_PICKS[sketchPick.kind].glyph) : sketchTrim ? iconOf("snip") : tool ? iconOf(tool.glyph) : c ? iconOf(c.kind) : drawing ? iconOf(drawing.kind) : "");
    dialogTitleEl.textContent = sketchPick ? SKETCH_PICKS[sketchPick.kind].title : sketchTrim ? "Trim" : tool ? tool.title : c ? c.name : drawing ? LABELS[drawing.kind] : "";
    // The subtitle: the tool's item, a point's index -- and a curve's or a body's plane.
    dialogSubEl.textContent = tool && c ? c.name : pointed(c) && selectedPoint !== null ? `point ${selectedPoint + 1} of ${c.shape.points.length} · on ${planeInfo(c.plane).name}` : c && !isSketch(c) ? `on ${planeInfo(c.plane).name}` : "";
    const note = modeOn ? hintEl.textContent : c?.error ?? "";
    dialogNoteEl.textContent = note;
    dialogNoteEl.classList.toggle("error", !modeOn && !!c?.error);
    dialogFootEl.hidden = !tool && !(shellMode || filletMode || trimMode || sketchTrim || sketchPick);
}
// The picks so far, in the dialog: the shell's open faces, the fillet's edges, the
// trim's pieces removed -- by number, as the views count them.
function renderPicks() {
    const list = (what, ns) => ns.length ? `${ns.length} ${what}${ns.length === 1 ? "" : "s"}: ${ns.map((n) => n + 1).join(", ")}` : `no ${what} yet`;
    if (sketchPick?.kind === "split") {
        picksLabelEl.textContent = "splitting";
        picksEl.textContent = byId(sketchPick.target)?.name ?? "";
        return;
    }
    if (sketchPick?.spots) {
        const next = CONSTRAINT_TOOLS[sketchPick.kind].next(sketchPick.spots);
        picksLabelEl.textContent = "picked";
        picksEl.textContent = `${sketchPick.spots.length ? sketchPick.spots.map((q) => q.label).join(", ") : "nothing yet"}${next ? ` · next: ${needText(next)}` : ""}`;
        return;
    }
    if (sketchPick?.fixed != null) {
        const f = byId(sketchPick.fixed), picked = selectedCurves().filter((c) => pickAccepts(sketchPick.kind, [], c));
        picksLabelEl.textContent = { cut: "cutting", intersect: "intersecting", trim: isSheet(f) ? "trimming" : "trimming by" }[sketchPick.kind] ?? "with";
        picksEl.textContent = `${f?.name ?? ""} · ${picked.length ? picked.map((c) => c.name).join(", ") : `no ${sketchPick.kind === "trim" ? (isSheet(f) ? "tool" : "sheet") : SKETCH_PICKS[sketchPick.kind].noun} yet`}`;
        return;
    }
    if (sketchPick) {
        const picked = selectedCurves().filter((c) => pickAccepts(sketchPick.kind, [], c));
        picksLabelEl.textContent = "picked";
        picksEl.textContent = picked.length ? `${picked.length} ${SKETCH_PICKS[sketchPick.kind].noun}${picked.length === 1 ? "" : "s"}: ${picked.map((c) => c.name).join(", ")}` : `no ${SKETCH_PICKS[sketchPick.kind].noun} yet`;
        return;
    }
    if (shellMode) { picksLabelEl.textContent = "open"; picksEl.textContent = list("face", [...shellMode.open].sort((a, b) => a - b)); }
    else if (filletMode) { picksLabelEl.textContent = filletMode.body.style === "chamfer" ? "cut back" : "rounded"; picksEl.textContent = list("edge", filletMode.body.edges); }
    else if (trimMode) { picksLabelEl.textContent = "removed"; picksEl.textContent = list("piece", trimMode.body.drop); }
    else if (sketchTrim) { picksLabelEl.textContent = "removed"; picksEl.textContent = sketchTrim.removed ? `${sketchTrim.removed} piece${sketchTrim.removed === 1 ? "" : "s"}` : "no piece yet"; }
}
// OK and Cancel: a tool's session commits or rolls back; a pick armed on a body that
// already stands (a fillet's edges revisited) ends, or rolls its picks back to where
// the history stood when it was armed.
function confirmPicks() {
    if (sketchPick) { runSketchPick(); return; }
    if (tool) { commitTool(); return; }
    if (shellMode) newShell();
    if (trimMode) setTrimMode(null);
    if (sketchTrim) setSketchTrim(false);
    if (filletMode) setFilletMode(null);
    renderDialog();
}
function cancelPicks() {
    if (sketchPick) { disarmSketchPick(true); return; }
    if (tool) { cancelTool(); return; }
    const at = trimMode?.at ?? sketchTrim?.at ?? filletMode?.at ?? null;
    if (shellMode) setShellMode(null);
    if (trimMode) setTrimMode(null);
    if (sketchTrim) setSketchTrim(false);
    if (filletMode) setFilletMode(null);
    flushPending();
    if (at !== null && doneSince(at)) return act(async () => { await rollbackTo(at); say(`cancelled · ${head} of ${history.length}`); renderDialog(); });
    renderDialog();
}

// ------------------------------------------------------------------ the timeline

// The history as a timeline: a chip per feature -- a sketch (with every curve
// drawn on it, and their edits), a body -- in command order, the marker where the
// document stands (`head`), the chips past it rolled back and dimmed. A click selects
// the feature's item; the marker is dragged along the chips (the document replays to
// there, as undo and redo do); the arrows step it.
function timelineChips() {
    const chips = [];
    const bySketch = new Map();   // a plane key -> the chip its curves belong to
    const chipOf = (ids) => chips.find((ch) => ids.some((id) => ch.ids.includes(id)));
    for (let i = 0; i < history.length; i++) {
        const { op, added, touched, removed } = history[i];
        let chip = null;
        switch (op) {
        case "sketch":
            chip = { at: i, ids: added.slice(), glyph: GLYPHS.sketch, kind: "sketch" };
            if (added.length) bySketch.set(added[0], chip);
            break;
        case "add": case "merge": {
            const plane = byId(added[0])?.plane;
            const own = plane !== undefined ? bySketch.get(plane) : undefined;
            if (own) { own.ids.push(...added); own.end = i; }
            else { chip = { at: i, ids: added.slice(), glyph: GLYPHS.sketch, kind: "sketch", plane }; if (plane !== undefined) bySketch.set(plane, chip); }
            break;
        }
        case "round": case "explode": case "snip": {
            const ch = chipOf([...touched, ...removed]);
            if (ch) { ch.end = i; ch.ids.push(...added); }
            break;
        }
        case "delete":
            chip = { at: i, ids: [], glyph: "✕", kind: "delete", label: `delete ${removed.length} item${removed.length === 1 ? "" : "s"}` };
            break;
        case "duplicate":
            chip = { at: i, ids: added.slice(), glyph: "⧉", kind: "duplicate" };
            break;
        case "split":
            chip = { at: i, ids: added.slice(), glyph: GLYPHS.split, kind: "split" };
            break;
        case "state":
            chip = { at: i, ids: added.slice(), glyph: "▤", kind: "state", label: "a version-1 file" };
            break;
        default: {
            // A command that made an item is a feature of its own; one that only changed some
            // (a set, an edit) belongs to the chip of what it changed.
            if (!added.length) { const ch = chipOf(touched); if (ch) ch.end = i; break; }
            const kind = byId(added[0])?.kind ?? op;
            chip = { at: i, ids: added.slice(), glyph: GLYPHS[kind] ?? "•", kind };
        }
        }
        if (chip) { chip.end = i; chips.push(chip); }
    }
    return chips;
}
let timelineDrag = false;
function renderTimeline() {
    const chips = timelineChips();
    const nodes = [];
    let placed = false;
    const marker = document.createElement("span"); marker.className = "marker"; marker.title = `${head} of ${history.length}`;
    for (const chip of chips) {
        if (!placed && head <= chip.at) { nodes.push(marker); placed = true; }
        const el = document.createElement("span");
        el.className = "chip";
        el.dataset.at = chip.at; el.dataset.end = chip.end;
        const item = chip.ids.map(byId).find((c) => c);
        const name = item ? (chip.kind === "sketch" && chip.plane ? `${PLANES[chip.plane]?.name ?? chip.plane} sketch` : item.name) : chip.label ?? LABELS[chip.kind] ?? chip.kind;
        el.replaceChildren(iconOf(chip.kind, chip.glyph));
        el.title = `${name} · ${chip.at + 1}${chip.end > chip.at ? `–${chip.end + 1}` : ""}`;
        el.classList.toggle("rolled", head <= chip.at);
        el.classList.toggle("selected", chip.ids.some((id) => selection.includes(id)));
        el.classList.toggle("error", chip.ids.map(byId).some((c) => c && c.error !== null));
        el.addEventListener("click", () => {
            const present = chip.ids.filter((id) => byId(id));
            if (present.length) setSelection(chip.kind === "sketch" ? present.slice(0, 1) : present);
        });
        nodes.push(el);
    }
    if (!placed) nodes.push(marker);
    // The drag is the window's: the marker is made anew at every replay.
    marker.addEventListener("pointerdown", (e) => { timelineDrag = true; e.preventDefault(); });
    timelineChipsEl.replaceChildren(...nodes);
    timelineBackEl.disabled = head === 0;
    timelineForwardEl.disabled = head === history.length;
    timelineCountEl.textContent = history.length ? `${head} of ${history.length}` : "";
}
// The marker dragged: the document stands at the boundary nearest the pointer --
// before the first chip, or after any chip and the edits that belong to it.
function timelineDragTo(x) {
    let best = 0, bestD = Infinity;
    const chips = [...timelineChipsEl.querySelectorAll(".chip")];
    if (chips.length) { const r = chips[0].getBoundingClientRect(); bestD = Math.abs(x - r.left); }
    for (const el of chips) {
        const d = Math.abs(x - el.getBoundingClientRect().right);
        if (d < bestD) { bestD = d; best = +el.dataset.end + 1; }
    }
    timelineGo(best);
}
// The marker's place wanted: one drag is one chain of replays at most, each to the latest
// place asked for, queued behind whatever is in flight (the pointer events are not held).
let timelineWanted = null, timelineGoing = false;
function timelineGo(to) {
    if (to === head && timelineWanted === null) return;
    timelineWanted = to;
    if (timelineGoing) return;
    timelineGoing = true;
    userAct(async () => {
        try {
            while (timelineWanted !== null) {
                const want = timelineWanted;
                timelineWanted = null;
                flushPending();
                if (want === head) continue;
                let moved = false;
                while (head > want && step("undo")) { head--; moved = true; }
                while (head < want && step("redo")) { head++; moved = true; }
                if (moved) afterChange({ reset: true });
                say(`at ${head} of ${history.length}`);
            }
        } finally { timelineGoing = false; }
    });
}
addEventListener("pointermove", (e) => { if (timelineDrag) timelineDragTo(e.clientX); });
addEventListener("pointerup", (e) => { if (timelineDrag) { timelineDragTo(e.clientX); timelineDrag = false; } });
timelineBackEl.addEventListener("click", undo);
timelineForwardEl.addEventListener("click", redo);

function removePoint(i) {
    const c = current();
    if (!pointed(c)) return;
    const n = c.shape.points.length, closed = !!c.shape.closed;
    // The later points' constraints follow them down one; the point's own go with it.
    runStructural(() => ({ op: "set", id: c.id, shape: structuredClone(c.shape) }), [c.plane], {
        remap: remapRemovedPoint(c, i, n, closed),
        mutate: () => { c.shape.points.splice(i, 1); if (c.kind === "nurbs") c.shape.weights.splice(i, 1); },
    });
    selectPoint(null);
}

// ------------------------------------------------------------------ the four views

// The order and cameras: Top, Perspective, Front, Right -- `View`'s own, one per viewport,
// set once the View exists (`setupViewports`) and moved by it: an orthographic camera
// on each origin plane, drawn over its grid, and the free-fly one the reader page uses for
// Perspective. The page keeps none of them; it reads each frame's matrices back
// (`lastReport`, through `camOf`) for its overlay and its hit tests.
const NAMES = ["Top", "Perspective", "Front", "Right"];
const START_CAMERAS = [{ kind: "ortho", basis: "top" }, { kind: "fly" }, { kind: "ortho", basis: "front" }, { kind: "ortho", basis: "right" }];
// The last drawn frame's cameras (the worker's `view.frame`, `client.lastFrame`), null until the first frame.
let lastReport = null;
const camOf = (i) => cameraOf(lastReport?.[i]);
// The perspective view stands on the Top plane's grid.
const grids = ["top", "top", "front", "right"];
// The three sketch planes, one per orthographic view: a curve drawn in a view lies in
// its plane, its sketch (x, y) along the plane's `right` and `up` -- the same basis the
// view's camera reads pixels by, so a point picked in the view is a sketch point with no
// projection to speak of. `index` is what the wasm's builders take (`plane_frame`).
const PLANES = {
    top:   { view: 0, index: 0, name: "Top", right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1] },
    front: { view: 2, index: 1, name: "Front", right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0] },
    right: { view: 3, index: 2, name: "Right", right: [0, 1, 0], up: [0, 0, 1], normal: [1, 0, 0] },
};
// A plane key -- an origin plane's name, or a sketch's id -- resolved to `{ name, frame,
// base, offset, view }`: `frame` its `{ origin, x, y, z }` in the world; `base` the
// origin plane it is parallel to (an offset sketch's, null for a tilted one) with its
// `offset`; `view` the orthographic view that sees it square-on -- the base's, or the
// view looking at a tilted sketch, or null when none does (then it has no handles to
// draw until one is told to look at it). A sketch whose hinge or path is gone falls
// back to Top, and says so in its tag (`broken`).
// The view that shows the origin plane `base` right now: its own view, unless that
// view has been turned to look at a tilted sketch -- an offset sketch of the same base
// keeps the camera, so it still counts. A body on Top has its gizmo where the Top
// camera is, and nowhere while that camera looks at a face instead.
function viewShowing(base) {
    const view = PLANES[base].view;
    const at = viewPlane[view];
    if (at === base) return view;
    const sketch = curves.find((c) => c.id === at && isSketch(c));
    return sketch?.mode === "offset" && sketch.base === base ? view : null;
}
// The plane of face `index` (its B-rep index) of `body`, as a sketch on it (and a body
// raised from it) takes it: the frame the document's `frame.on_face` gives the face (the
// worker's table, `frames`) -- origin in the middle of the face, x and y the plane's own, z
// out of the body. Null while the body has no faces to read (not built yet), the face is
// not there, or is not a plane any more.
function faceFrame(body, index) {
    const frames = body?.gpu?.frames;
    if (!frames || !((index + 1) * 12 <= frames.length) || body.gpu.faceKinds[index] !== 0) return null;
    const f = frames.subarray(index * 12, (index + 1) * 12);
    if (!f.every(Number.isFinite)) return null;
    const x = V.unit([f[3], f[4], f[5]]), y = V.unit([f[6], f[7], f[8]]);
    if (!x || !y) return null;
    return { origin: [f[0], f[1], f[2]], x, y, z: V.cross(x, y) };
}
// A body raised from a face of a solid lives on that face's plane: the key
// `face:<solid id>:<face index>`, its frame `faceFrame`'s, so the body's pivot and its
// in-plane transform are on the face and not on the solid's own sketch plane.
const facePlane = (bodyId, index) => `face:${bodyId}:${index}`;
const isFacePlane = (key) => typeof key === "string" && key.startsWith("face:");
function planeInfo(key) {
    if (isFacePlane(key)) {
        const [, bodyId, index] = key.split(":");
        const body = byIdAs(+bodyId, isBody);
        const name = body ? `${body.name} · face ${+index + 1}` : "a face gone";
        const frame = body ? faceFrame(body, +index) : null;
        if (!frame) return { ...planeInfo("top"), name, view: null, broken: true };
        return { name, frame, base: null, offset: 0, view: null };
    }
    if (typeof key === "string") {
        const { right, up, normal, name } = PLANES[key];
        return { name, frame: { origin: [0, 0, 0], x: right, y: up, z: normal }, base: key, offset: 0, view: viewShowing(key) };
    }
    const item = byIdAs(key, isSketch);
    if (!item) return { ...planeInfo("top"), name: "?" };
    const looking = VIEW_PLANE_KEYS.find((k) => viewPlane[k] === key) ?? null;
    if (item.mode === "offset") {
        const { right, up, normal } = PLANES[item.base];
        return { name: item.name, frame: { origin: V.mul(normal, item.offset), x: right, y: up, z: normal }, base: item.base, offset: item.offset, view: viewShowing(item.base) };
    }
    const broken = { ...planeInfo("top"), name: item.name, view: looking, broken: true };
    if (item.mode === "face") {
        const body = item.face && byIdAs(item.face.body, isBody);
        const frame = body ? faceFrame(body, item.face.index) : null;
        if (!frame) return broken;
        return { name: item.name, frame, base: null, offset: 0, view: looking };
    }
    if (item.mode === "mid" || item.mode === "points") {
        // The kernel's construction planes, over the planes or points they are placed by --
        // each resolved here, so a plane moved (or a curve end dragged) moves this one. A
        // chain of planes on planes that comes back round is broken, not endless.
        if (planeDepth > 16) return broken;
        planeDepth++;
        try {
            const frame = item.mode === "mid" ? midFrame(item) : pointsFrame(item);
            return frame ? { name: item.name, frame, base: null, offset: 0, view: looking } : broken;
        } finally { planeDepth--; }
    }
    const ref = curves.find((c) => c.id === (item.mode === "angle" ? item.hinge : item.path) && isCurve(c));
    if (!ref) return broken;
    const F = planeInfo(ref.plane).frame;
    const at = (q) => V.add(F.origin, V.add(V.mul(F.x, q[0]), V.mul(F.y, q[1])));
    if (item.mode === "angle") {
        const s = ref.shape;
        const x = V.unit(V.sub(at([s.x1, s.y1]), at([s.x0, s.y0])));
        if (!x) return broken;
        const p = V.cross(F.z, x), t = item.tilt * Math.PI / 180;
        const y = V.add(V.mul(p, Math.cos(t)), V.mul(F.z, Math.sin(t)));
        return { name: item.name, frame: { origin: at([s.x0, s.y0]), x, y, z: V.cross(x, y) }, base: null, offset: 0, view: looking };
    }
    const b = ref.sketch;
    if (b.length < 16) return broken;
    let d = [b[4] - b[0], b[5] - b[1]];
    if (Math.hypot(d[0], d[1]) < 1e-9) d = [b[12] - b[0], b[13] - b[1]];
    const z = V.unit(V.add(V.mul(F.x, d[0]), V.mul(F.y, d[1])));
    if (!z) return broken;
    const x = F.z, y = V.cross(z, x);
    return { name: item.name, frame: { origin: at([b[0], b[1]]), x, y, z }, base: null, offset: 0, view: looking };
}
let planeDepth = 0;
const frame12 = (f) => new Float64Array([...f.origin, ...f.x, ...f.y, ...f.z]);
const frameOf12 = (v) => ({ origin: [v[0], v[1], v[2]], x: [v[3], v[4], v[5]], y: [v[6], v[7], v[8]], z: [v[9], v[10], v[11]] });
// A midplane's frame: its two planes' (an origin plane, a sketch, a body's flat face),
// the kernel's plane between; null where either is gone.
function midFrame(item) {
    if (!item.mid || item.mid.length !== 2) return null;
    const frames = item.mid.map((r) => {
        if (typeof r === "object") { const body = byIdAs(r.body, isBody); return body ? faceFrame(body, r.index) : null; }
        if (r === item.id) return null;
        const info = planeInfo(r);
        return info.broken || info.name === "?" ? null : info.frame;
    });
    if (frames.some((f) => !f)) return null;
    try { return frameOf12(cadaclysm_blacksmith_frame_midplane(frame12(frames[0]), frame12(frames[1]))); } catch { return null; }
}
// A 3-point plane's frame: through its three curve ends, as they are in the world now.
function pointsFrame(item) {
    if (!item.points || item.points.length !== 3) return null;
    const at = item.points.map(({ curve, end }) => {
        const c = byIdAs(curve, isCurve);
        const ends = c && c.plane !== item.id ? endsOf(c) : null;
        return ends ? embed3(c.plane, ends[end]) : null;
    });
    if (at.some((p) => !p)) return null;
    try { return frameOf12(cadaclysm_blacksmith_frame_through(...at.map((p) => new Float64Array(p)))); } catch { return null; }
}
// A sketch's frame as a signature, to notice it moved (its offset, tilt, hinge or path).
const frameSig = (key) => JSON.stringify(planeInfo(key).frame);
// The frame as the wasm takes it: origin, x, y.
const frame9 = (key) => { const { origin, x, y } = planeInfo(key).frame; return new Float64Array([...origin, ...x, ...y]); };
// What each orthographic view looks at: its origin plane, or a sketch.
const viewPlane = { 0: "top", 2: "front", 3: "right" };
const viewOf = (plane) => planeInfo(plane).view;
// The plane a new curve goes into: what the active view looks at, or what Top looks at
// while Perspective is active.
const sketchPlane = () => viewPlane[active] ?? viewPlane[0];
// A sketch point into the world, and a world point on the plane back into the sketch.
const embed3 = (plane, [x, y]) => { const { origin, x: X, y: Y } = planeInfo(plane).frame; return V.add(origin, V.add(V.mul(X, x), V.mul(Y, y))); };
const flatten2 = (plane, w) => { const { origin, x: X, y: Y } = planeInfo(plane).frame; const d = V.sub(w, origin); return [V.dot(d, X), V.dot(d, Y)]; };
let active = 1;          // the viewport last clicked: gets the highlighted border and, for a new sketch, its plane
let maximized = 1;       // a viewport index while one fills the whole area (Perspective at first), null for the grid
// One view filling the area, or the grid: the view bar's buttons and a double-click on
// a view's name. A view shown whole is the active one.
function setMaximized(i) {
    maximized = i;
    if (i !== null) active = i;
    for (const b of document.querySelectorAll("#viewbar button")) b.setAttribute("aria-pressed", String(b.dataset.view === (i === null ? "quad" : String(i))));
    pushViewports();
    schedule();
}
for (const b of document.querySelectorAll("#viewbar button")) b.addEventListener("click", () => setMaximized(b.dataset.view === "quad" ? null : +b.dataset.view));
const GUTTER = 2;
// The site's palette: the accent is the discharge blue, the greys graphite.
const ACTIVE_COLOUR = "#5F5E5A", NAME_COLOUR = "#B4B2A9", GUTTER_COLOUR = "#3A3937", ACCENT = "#378ADD";
const OUTLINE_COLOUR = "#8E8C85", HANDLE_COLOUR = "#F1EFE8";
const NAME_FONT = "13px system-ui, sans-serif";

// Viewport rects `[x, y, w, h]` in CSS pixels; the View gets them in device pixels.
// A maximized layout gives the others an empty rect, so `viewportAt` never finds them.
function layout() {
    const W = viewsEl.clientWidth, H = viewsEl.clientHeight;
    if (maximized !== null) return NAMES.map((_, i) => i === maximized ? [0, 0, W, H] : [0, 0, 0, 0]);
    const w = (W - GUTTER) / 2, h = (H - GUTTER) / 2;
    return [[0, 0, w, h], [w + GUTTER, 0, w, h], [0, h + GUTTER, w, h], [w + GUTTER, h + GUTTER, w, h]];
}
// The panes as the View takes them: device-pixel rects. A maximized layout's hidden
// panes are empty rects, kept in the list so a viewport's index stays its pane's (for
// `pick`, and so a hidden pane keeps its camera).
function deviceRects() {
    const dpr = drawRatio();
    return layout().map((r) => r.map((v) => Math.max(0, Math.round(v * dpr))));
}
// The four cameras and grids, once, when the View exists; a view already looking at a
// tilted sketch (a document opened before) is turned to it.
function setupViewports() {
    viewerCall(() => viewer.setViewports(deviceRects().map((rect, i) => ({ rect, camera: START_CAMERAS[i], ...(grids[i] ? { grid: grids[i] } : {}) }))));
    for (const v of VIEW_PLANE_KEYS) if (viewPlane[v] !== ORIGIN_OF_VIEW[v] && !planeInfo(viewPlane[v]).base) aimCamera(v);
    syncPivot();
}
// The panes moved (a resize, the grid or one view maximized): rects only, cameras untouched.
// The viewports' depth range follows the document's radius, so a large document is not
// clipped until F: each camera keeps its pose and takes the new radius.
let cameraRadius = null;
// The View has no radius setter, and a camera the user moved by gestures is not the page's
// to rebuild, so the worker keeps each camera's pose and takes the new radius in one call.
function followRadius() {
    if (!viewReady || radius === cameraRadius) return;
    cameraRadius = radius;
    toWorker({ kind: "forge.radius", value: radius });
}
// A refusal (a rect the View will not take) is said on the status line, once while it persists.
let lastRefusal = null;
function pushViewports() {
    if (!viewReady) return;
    viewer.setViewportRects(deviceRects()).then(() => { lastRefusal = null; }, (error) => {
        const message = String(error && error.message ? error.message : error);
        if (message !== lastRefusal) { lastRefusal = message; say(message, true); }
    });
}
// Every view's camera placed to show the whole document, as F does.
function frameAll() {
    if (!viewReady) return;
    for (let i = 0; i < NAMES.length; i++) viewerCall(() => viewer.frameSphere(i, centre, radius));
}
// What Alt and the view cube orbit about: the selection's middle, or everything's.
function syncPivot() {
    if (viewReady) viewerCall(() => viewer.setPivot(1, orbitCentre()));
}
function viewportAt(px) { return layout().findIndex(([x, y, w, h]) => px[0] >= x && px[0] < x + w && px[1] >= y && px[1] < y + h); }
function local(px, i) { const [x, y] = layout()[i]; return [px[0] - x, px[1] - y]; }
function sizeOf(i) { const [, , w, h] = layout()[i]; return [w, h]; }
// The viewport whose name label holds `px`, or -1: a label is the text drawn at
// `(x + 8, y + 16)` with 4 px of margin around it, measured in the overlay's font.
function nameAt(px) {
    ctx.font = NAME_FONT;
    return layout().findIndex(([x, y, w, h], i) => {
        if (w <= 0 || h <= 0) return false;
        const lw = 8 + ctx.measureText(NAMES[i]).width + 8;
        return px[0] >= x + 4 && px[0] < x + 4 + lw && px[1] >= y + 2 && px[1] < y + 24;
    });
}

// ------------------------------------------------------------------ the overlay

const ctx = overlay.getContext("2d");

// The overlay's backing store follows its CSS size at the ratio the View's canvas is
// drawn at (`drawRatio`), so the two canvases agree on what a pixel is; drawing is in CSS
// pixels.
function fitOverlay() {
    const dpr = drawRatio();
    const w = Math.max(Math.round(overlay.clientWidth * dpr), 1), h = Math.max(Math.round(overlay.clientHeight * dpr), 1);
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// A sketch point (x, y) in `plane` to overlay pixels through its view's camera, `rect`
// that view's; and the same in pixels local to the view of `size`; and a local pixel
// back to a sketch point.
function sketchToPx(plane, p, rect) {
    const [sx, sy] = camOf(viewOf(plane)).worldToPx(embed3(plane, p), [rect[2], rect[3]]);
    return [rect[0] + sx, rect[1] + sy];
}
const sketchToLocal = (plane, p, size) => camOf(viewOf(plane)).worldToPx(embed3(plane, p), size);
const pxToSketch = (plane, p, size) => flatten2(plane, camOf(viewOf(plane)).pxToWorld(p, size));

// The handles of a curve, in sketch units, in the order `hit` reports them: a rectangle's
// four corners (0: x0 y0, 1: x1 y0, 2: x1 y1, 3: x0 y1 -- so corner k and corner k + 2 are
// opposite), a circle's centre then its rim point at angle 0, an arc's start, through-point
// and end, an ellipse's centre then the ends of its x and y semi-axes, a line's two ends,
// a polyline's or a NURBS's points.
function handlesOf(c) {
    const s = c.shape;
    if (isBody(c) || isSketch(c) || isImage(c) || c.kind === "polycurve") return [];
    if (c.kind === "line") return [[s.x0, s.y0], [s.x1, s.y1]];
    if (c.kind === "arc") return [[s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]];
    if (c.kind === "rect") return [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]];
    if (c.kind === "circle") return [[s.cx, s.cy], [s.cx + s.r, s.cy]];
    if (c.kind === "ellipse") return [[s.cx, s.cy], [s.cx + s.rx, s.cy], [s.cx, s.cy + s.ry]];
    if (c.kind === "polygon") return [[s.cx, s.cy], polygonPoints(s)[0]];
    return s.points;
}

// Each view's name in its corner, and a one-pixel border inside the active one.
function drawNames(rects) {
    ctx.font = NAME_FONT;
    ctx.textBaseline = "alphabetic";
    rects.forEach(([x, y, w, h], i) => {
        if (w <= 0 || h <= 0) return;
        ctx.fillStyle = NAME_COLOUR;
        const looking = viewPlane[i];
        ctx.fillText(typeof looking === "number" ? `${NAMES[i]} · ${planeInfo(looking).name}` : NAMES[i], x + 8, y + 16);
        if (i === active) {
            ctx.strokeStyle = ACTIVE_COLOUR;
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }
    });
}

function drawOverlay() {
    fitOverlay();
    const W = overlay.clientWidth, H = overlay.clientHeight;
    ctx.clearRect(0, 0, W, H);
    const rects = layout();

    // The gutters between the views, in the toolbar's border grey.
    if (maximized === null) {
        const [, , w, h] = rects[0];
        ctx.fillStyle = GUTTER_COLOUR;
        ctx.fillRect(w, 0, GUTTER, H);
        ctx.fillRect(0, h, W, GUTTER);
    }

    // Before the View has drawn a frame there is no camera to project through: the
    // names and borders alone, as the page shows while it loads.
    if (lastReport === null) { drawNames(rects); return; }

    // A fillet's picks: its solid's edges in every view, the rounded ones in the accent.
    if (filletMode) {
        const src = filletSource(filletMode.body);
        if (src?.gpu?.edges && visible(src)) {
            const all = parseEdges(src.gpu.edges);
            for (let v = 0; v < rects.length; v++) {
                const top = rects[v];
                if (top[2] <= 0 || top[3] <= 0) continue;
                ctx.save();
                ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
                const size = [top[2], top[3]];
                all.forEach((e, k) => {
                    const picked = (filletEdges(filletMode.body) ?? []).includes(k);
                    const lit = hover?.body === src && hover.edge === k;
                    ctx.strokeStyle = picked ? ACCENT : lit ? HOVER_EDGE : HANDLE_COLOUR;
                    ctx.lineWidth = picked ? (lit ? 4 : 3) : lit ? 3 : 1;
                    ctx.beginPath();
                    for (const [a, b] of e.segments) {
                        const pa = camOf(v).worldToPx(a, size), pb = camOf(v).worldToPx(b, size);
                        if (!pa || !pb) continue;
                        ctx.moveTo(top[0] + pa[0], top[1] + pa[1]); ctx.lineTo(top[0] + pb[0], top[1] + pb[1]);
                    }
                    ctx.stroke();
                });
                ctx.restore();
            }
        }
    }
    // Every selected item's handles, each clipped to the rect of the view its plane is
    // seen in, the active one's drawn last so they sit on top -- the curves themselves
    // are the View's, the selected ones in the accent. For a NURBS the control
    // polygon dashed (closed when the curve is); for it and a polyline the points, the
    // first ringed, the active curve's selected point filled in the highlight.
    {
        const active = current();
        const inView = (plane, draw) => {
            const view = viewOf(plane);
            if (view === null) return;
            const top = rects[view];
            if (top[2] <= 0 || top[3] <= 0) return;
            ctx.save();
            ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
            ctx.lineWidth = 1;
            draw(top);
            ctx.restore();
        };
        const topToPx = (p, top) => sketchToPx(drawnPlane, p, top);
        let drawnPlane = "top";
        for (const c of (sketchPick ? [] : [...selectedCurves().filter((c) => c !== active), ...(active ? [active] : [])]).filter((c) => !isSketch(c) && visible(c))) inView(c.plane, (top) => {
            drawnPlane = c.plane;
            // A selected image: its frame, no handles (the dialog sizes and places it).
            if (isImage(c)) {
                ctx.strokeStyle = c === active ? ACCENT : HANDLE_COLOUR; ctx.lineWidth = 1;
                ctx.beginPath();
                imageQuad(c).forEach((p, i) => { const [sx, sy] = topToPx(p, top); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
                ctx.closePath(); ctx.stroke();
                return;
            }
            if (c.kind === "nurbs" && c.shape.points.length > 1) {
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = ACTIVE_COLOUR;
                ctx.beginPath();
                c.shape.points.forEach((p, i) => { const [sx, sy] = topToPx(p, top); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
                if (c.shape.closed) ctx.closePath();
                ctx.stroke();
                ctx.setLineDash([]);
            }
            handlesOf(c).forEach((p, i) => {
                const [sx, sy] = topToPx(p, top);
                ctx.beginPath();
                ctx.arc(sx, sy, 5, 0, Math.PI * 2);
                ctx.fillStyle = c === active && pointed(c) && i === selectedPoint ? ACCENT : HANDLE_COLOUR;
                ctx.fill();
                if (pointed(c) && i === 0) { ctx.strokeStyle = ACCENT; ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.stroke(); }
            });
            // A revolution's axis, dashed, with a handle at either end.
            if (c.kind === "revolution" && c.axis) drawAxis(c.plane, worldAxis(c), top, c === active ? ACCENT : ACTIVE_COLOUR);
        });
        // The manipulator of what is active, in every view it can be worked in.
        if (!drawing && !sketchPick) for (let v = 0; v < 4; v++) {
            if (rects[v][2] <= 0 || rects[v][3] <= 0) continue;
            const m = manipulatorOf(v);
            if (m) drawManipulator(m, v, rects[v]);
        }
        // The revolve tool's axis while it is armed.
        if (axisMode) inView(axisMode.plane, (top) => drawAxis(axisMode.plane, axisMode.axis, top, ACCENT));
        // The snap: a ring round the end the drag has landed on.
        if (snapped) inView(snapped.plane, (top) => {
            const [sx, sy] = sketchToPx(snapped.plane, snapped.at, top);
            ctx.strokeStyle = HANDLE_COLOUR; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 1;
        });
        // A constraint tool's picked points, filled in the accent, and the point its next
        // click would take, ringed.
        if (sketchPick?.spots) {
            const pointOf = (spot) => { const c = byId(spot.curve); const q = c && pointSpotsOf(c).find((x) => x.at === spot.at); return q ? { plane: c.plane, p: q.p } : null; };
            for (const q of sketchPick.spots) {
                const at = q.type === "point" ? pointOf(q.spot) : null;
                if (at) inView(at.plane, (top) => { const [sx, sy] = sketchToPx(at.plane, at.p, top); ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill(); });
            }
            const lit = hoverSpot ? pointOf(hoverSpot) : null;
            if (lit) inView(lit.plane, (top) => { const [sx, sy] = sketchToPx(lit.plane, lit.p, top); ctx.strokeStyle = HOVER_EDGE; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; });
        }
    }

    if (showMeasures) drawMeasures(rects);
    // A mark hovered when a tool, a pick or a drawing was armed is let go (its curves unlit).
    if (hoverConstraint && !constraintHoverable()) hoverConstraintAt(null);
    drawConstraintOverlay(rects);

    // The sketches' planes, each drawn as a dashed square (80 mm, about its origin) in
    // every orthographic view but the one looking at it -- edge-on it is a line, tilted
    // a parallelogram -- the selected ones in the accent. (In Perspective, nothing yet.)
    for (const sketch of curves.filter(isSketch)) {
        const info = planeInfo(sketch.id);
        for (const v of VIEW_PLANE_KEYS) {
            if (viewPlane[v] === sketch.id) continue;
            const [x, y, w, h] = rects[v];
            if (w <= 0 || h <= 0) continue;
            const cam = camOf(v), size = [w, h];
            const corners = [[-40, -40], [40, -40], [40, 40], [-40, 40]].map((q) => cam.worldToPx(embed3(sketch.id, q), size));
            ctx.save();
            ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
            ctx.setLineDash([8, 4]); ctx.lineWidth = 1;
            ctx.strokeStyle = isSelected(sketch) ? ACCENT : ACTIVE_COLOUR;
            ctx.beginPath();
            corners.forEach(([px, py], i) => { if (i === 0) ctx.moveTo(x + px, y + py); else ctx.lineTo(x + px, y + py); });
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }
    }

    // The view cube in Perspective's corner.
    drawViewCube(rects[1]);

    drawNames(rects);
}

// The handle under `p` (pixels local to the Top rect of `size`) of any selected curve --
// the active one's first, then the others' -- within 9 px, the last drawn first, as
// `{ curve, handle }`; `handle` is `{ kind: "end", index }` for a line, `{ kind: "corner",
// index }` for a rectangle, `{ kind: "centre" }` or `{ kind: "radius" }` for a circle,
// `{ kind: "end", index }` (0 the start, 2 the end) or `{ kind: "through" }` for an arc,
// `{ kind: "centre" | "rx" | "ry" }` for an ellipse, `{ kind: "point", index }` for a
// polyline or a NURBS. Null when none. A conic's centre and rim coincide when it is
// small on screen; the rim wins then (drawn last), since a curve that small wants
// growing more than moving.
// The measures, the sketch dimensions: every visible curve's own sizes drawn in the
// view that looks at its plane -- a line's length, a rectangle's width and height, a
// circle's radius, an arc's radius and angle, an ellipse's two semi-axes, a polyline's or
// polycurve's pieces and total, a NURBS's length along it -- as dimension lines with
// arrowheads and extension lines, and every visible body's overall size as width x depth
// x height in each orthographic view and on a corner in Perspective. The selected ones in
// the accent. All in millimetres, two decimals at most.
const MEASURE_FONT = "11px system-ui, sans-serif";
const MEASURE_COLOUR = "#CFCDC5";
const fmt = (v) => (Math.round(v * 100) / 100).toString();
const TAU = 2 * Math.PI;
// The measures' and the dimensions' drawing, in overlay pixels (the font and alignment set
// by the caller): a label with a dark box behind it, so it reads over the geometry -- its
// box returned, `[x, y, w, h]`, for a click to hit.
function measureLabel(text, x, y, colour) {
    const w = ctx.measureText(text).width + 6;
    ctx.fillStyle = "rgba(33, 35, 40, 0.85)";
    ctx.fillRect(x - w / 2, y - 8, w, 16);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
    return [x - w / 2, y - 8, w, 16];
}
function measureArrow(x, y, dx, dy) {
    const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - ux * 8 - uy * 3, y - uy * 8 + ux * 3);
    ctx.lineTo(x - ux * 8 + uy * 3, y - uy * 8 - ux * 3);
    ctx.closePath();
    ctx.fill();
}
// A linear dimension between the pixel points `a` and `b`, its line offset to the side
// away from `away` (a pixel point the shape is on): extension lines, the dimension line
// with an arrowhead at each end, the label past it (its box returned; null where `a` and
// `b` are one point and nothing is drawn).
function measureDimension(a, b, text, away, colour, offset = 18) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (l < 1e-6) return null;
    let nx = -dy / l, ny = dx / l;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if ((mx - away[0]) * nx + (my - away[1]) * ny < 0) { nx = -nx; ny = -ny; }
    const a2 = [a[0] + nx * offset, a[1] + ny * offset], b2 = [b[0] + nx * offset, b[1] + ny * offset];
    ctx.strokeStyle = colour; ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(a[0] + nx * 3, a[1] + ny * 3); ctx.lineTo(a2[0] + nx * 4, a2[1] + ny * 4);
    ctx.moveTo(b[0] + nx * 3, b[1] + ny * 3); ctx.lineTo(b2[0] + nx * 4, b2[1] + ny * 4);
    ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]);
    ctx.stroke();
    if (l > 20) { measureArrow(a2[0], a2[1], -dx, -dy); measureArrow(b2[0], b2[1], dx, dy); }
    return measureLabel(text, mx + nx * (offset + 10), my + ny * (offset + 10), colour);
}
// A radius: a leader from the centre to the rim with an arrowhead at the rim.
function measureRadius(centre, rim, text, colour) {
    ctx.strokeStyle = colour; ctx.fillStyle = colour;
    ctx.beginPath(); ctx.moveTo(centre[0], centre[1]); ctx.lineTo(rim[0], rim[1]); ctx.stroke();
    measureArrow(rim[0], rim[1], rim[0] - centre[0], rim[1] - centre[1]);
    return measureLabel(text, (centre[0] + rim[0]) / 2, (centre[1] + rim[1]) / 2 - 10, colour);
}
function drawMeasures(rects) {
    ctx.save();
    ctx.font = MEASURE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    const label = measureLabel, arrow = measureArrow, dimension = measureDimension, radius = measureRadius;
    // The length of a run of the page's Béziers (sixteen floats each), by chords.
    const bezierLength = (b) => {
        let total = 0;
        for (let k = 0; k + 16 <= b.length; k += 16) {
            const p = (t) => { const s = 1 - t, w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]; let x = 0, y = 0, d = 0; for (let i = 0; i < 4; i++) { const ww = w[i] * b[k + 4 * i + 3]; x += ww * b[k + 4 * i]; y += ww * b[k + 4 * i + 1]; d += ww; } return [x / d, y / d]; };
            let prev = p(0);
            for (let i = 1; i <= 16; i++) { const q = p(i / 16); total += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
        }
        return total;
    };
    for (const c of curves) {
        if (!visible(c) || isSketch(c)) continue;
        const colour = isSelected(c) ? ACCENT : MEASURE_COLOUR;
        if (isCurve(c)) {
            const view = viewOf(c.plane);
            if (view === null) continue;
            const top = rects[view];
            if (top[2] <= 0 || top[3] <= 0) continue;
            ctx.save();
            ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
            const px = (p) => sketchToPx(c.plane, p, top);
            const s = c.shape;
            const hs = handlesOf(c);
            const centre = hs.length ? px(hs.reduce((m, p) => [m[0] + p[0] / hs.length, m[1] + p[1] / hs.length], [0, 0])) : [0, 0];
            if (c.kind === "line") {
                dimension(px([s.x0, s.y0]), px([s.x1, s.y1]), fmt(Math.hypot(s.x1 - s.x0, s.y1 - s.y0)), centre, colour);
            } else if (c.kind === "rect") {
                const lo = [Math.min(s.x0, s.x1), Math.min(s.y0, s.y1)], hi = [Math.max(s.x0, s.x1), Math.max(s.y0, s.y1)];
                dimension(px([lo[0], lo[1]]), px([hi[0], lo[1]]), fmt(hi[0] - lo[0]), centre, colour);
                dimension(px([hi[0], lo[1]]), px([hi[0], hi[1]]), fmt(hi[1] - lo[1]), centre, colour);
            } else if (c.kind === "circle") {
                radius(px([s.cx, s.cy]), px([s.cx + s.r * Math.SQRT1_2, s.cy + s.r * Math.SQRT1_2]), `R${fmt(s.r)}`, colour);
            } else if (c.kind === "arc") {
                // The circle through the three points: its centre by the circumcentre.
                const [ax, ay, bx, by, cx, cy] = [s.x0, s.y0, s.xm, s.ym, s.x1, s.y1];
                const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
                if (Math.abs(d) > 1e-9) {
                    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
                    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
                    const r = Math.hypot(ax - ux, ay - uy);
                    radius(px([ux, uy]), px([bx, by]), `R${fmt(r)}`, colour);
                    // The included angle: from the start to the end, the way round the middle lies.
                    const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
                    const ccw = ((am - a0 + TAU) % TAU) < ((a1 - a0 + TAU) % TAU);
                    const sweep = ccw ? (a1 - a0 + TAU) % TAU : (a0 - a1 + TAU) % TAU;
                    const at = px([ux, uy]);
                    label(`${fmt(sweep * 180 / Math.PI)}°`, at[0], at[1] + 12, colour);
                }
            } else if (c.kind === "polygon") {
                const [p0, p1] = polygonPoints(s);
                radius(px([s.cx, s.cy]), px(p0), `R${fmt(s.r)}`, colour);
                dimension(px(p0), px(p1), fmt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])), centre, colour, 14);
            } else if (c.kind === "ellipse") {
                const o = px([s.cx, s.cy]);
                dimension(o, px([s.cx + s.rx, s.cy]), fmt(s.rx), px([s.cx, s.cy - s.ry]), colour, 12);
                dimension(o, px([s.cx, s.cy + s.ry]), fmt(s.ry), px([s.cx - s.rx, s.cy]), colour, 12);
            } else if (c.kind === "polyline") {
                const pts = s.points;
                let total = 0;
                const n = s.closed && pts.length > 2 ? pts.length : pts.length - 1;
                for (let i = 0; i < n; i++) {
                    const a = pts[i], b = pts[(i + 1) % pts.length];
                    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
                    total += l;
                    dimension(px(a), px(b), fmt(l), centre, colour, 14);
                }
                if (n > 1 && pts.length) { const e = px(pts[pts.length - 1]); label(`Σ ${fmt(total)}`, e[0], e[1] - 16, colour); }
            } else if ((c.kind === "nurbs" || c.kind === "polycurve") && c.sketch.length >= 16) {
                const b = c.sketch;
                const e = px([b[b.length - 4], b[b.length - 3]]);
                label(`L ${fmt(bezierLength(b))}`, e[0], e[1] - 16, colour);
            }
            ctx.restore();
        } else if (isBody(c) && c.gpu?.box) {
            // The body's box in the world, off its edges' control points: the worker's table
            // has it, as the body was built.
            const { lo, hi } = c.gpu.box;
            const corners = [];
            for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
            const sizes = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
            for (const v of VIEW_PLANE_KEYS) {
                const top = rects[v];
                if (top[2] <= 0 || top[3] <= 0) continue;
                // The extent along the view's own right and up: which world sizes those are.
                const { x: rightAxis, y: upAxis } = planeInfo(viewPlane[v]).frame;
                const along = (axis) => { let lo2 = Infinity, hi2 = -Infinity; for (const q of corners) { const d = V.dot(q, axis); lo2 = Math.min(lo2, d); hi2 = Math.max(hi2, d); } return hi2 - lo2; };
                const size = [top[2], top[3]];
                const pts = corners.map((q) => camOf(v).worldToPx(q, size)).filter(Boolean).map(([x, y]) => [top[0] + x, top[1] + y]);
                if (pts.length < 8) continue;
                const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
                const l = Math.min(...xs), r = Math.max(...xs), t = Math.min(...ys), bt = Math.max(...ys);
                ctx.save();
                ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
                const mid = [(l + r) / 2, (t + bt) / 2];
                dimension([l, bt], [r, bt], fmt(along(rightAxis)), mid, colour, 14);
                dimension([r, bt], [r, t], fmt(along(upAxis)), mid, colour, 14);
                ctx.restore();
            }
            // Perspective: the three sizes on the box's top far corner.
            const top = rects[1];
            if (top[2] > 0 && top[3] > 0) {
                const at = camOf(1).worldToPx([hi[0], hi[1], hi[2]], [top[2], top[3]]);
                if (at) {
                    ctx.save();
                    ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
                    // A sheet's flat way is left out: "40 × 30", not "40 × 30 × 0".
                    label(sizes.filter((v) => v > 1e-6).map(fmt).join(" × "), top[0] + at[0] + 40, top[1] + at[1] - 12, colour);
                    ctx.restore();
                }
            }
        }
    }
    ctx.restore();
}

// An axis on the overlay: a dashed line between its two ends, extended past them a
// little so it reads as an axis and not a segment, and a disc at each end.
function drawAxis(plane, axis, top, colour) {
    const [a, b] = axis.map((q) => sketchToPx(plane, q, top));
    const d = [b[0] - a[0], b[1] - a[1]], len = Math.hypot(d[0], d[1]) || 1, u = [d[0] / len * 30, d[1] / len * 30];
    ctx.save();
    ctx.setLineDash([6, 4]); ctx.strokeStyle = colour; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a[0] - u[0], a[1] - u[1]); ctx.lineTo(b[0] + u[0], b[1] + u[1]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = HANDLE_COLOUR;
    for (const [x, y] of [a, b]) { ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
}

// A body's pivot in the world: its in-plane pivot, moved by its transform, on its
// plane, then slid by its place (the turn is about it and moves it nowhere).
const worldPivot = (c) => V.add(embed3(c.plane, pivotOf(c)), placeOf(c).offset);

// The manipulator, one style in every view: at the pivot of what is
// selected, an arrow along each axis that slides it, a ring about each that turns it,
// the centre disc that slides it in the plane facing the camera, and a square beside
// the centre that scales it. What the axes are depends on the subject and the view:
//  - a body, in every view: the world's X, Y, Z and the rings about them -- its place
//    in the world (offset, turn), the one position the dialog shows; the scale its own;
//  - the selected curves of one plane (the active curve's): the plane's x and y and the
//    ring about its normal -- the curves moved, turned and scaled as a block, their
//    shapes rewritten (a rectangle turned becomes a polyline, an ellipse does not turn).
// Sized on screen at any distance, an arrow or a ring seen edge-on in a view left out of it:
// the layout, the drawing, the hit test and the drag's maths are manipulator.js's, shared
// with other cadaclysm pages; what the subject is and what a drag does to it are the forge's.
function manipulatorOf(view) {
    const c = current();
    if (!c || isSketch(c) || !visible(c) || sketchTrim) return null;   // a trim's clicks are for its pieces
    if (isBody(c)) return { subject: "place", body: c, pivot: worldPivot(c), axes: AXES3, rings: RINGS3, scale: !isMade(c) };
    const items = selectedCurves().filter((k) => isCurve(k) && k.plane === c.plane && visible(k) && drawn(k));
    if (!items.length) return null;
    // The block's pivot: the middle of its curves' handles' box, in the sketch plane.
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const k of items) for (const q of curvePoints(k)) { lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])]; hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])]; }
    if (!Number.isFinite(lo[0])) return null;
    const pivot2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    const F = planeInfo(c.plane).frame;
    return { subject: "curves", items, plane: c.plane, pivot2, pivot: embed3(c.plane, pivot2), axes: [{ a: F.x, name: "X" }, { a: F.y, name: "Y" }], rings: [{ n: F.z, name: "Z" }], scale: true };
}
// A curve's points in its plane, for a box round it: its handles, or a polycurve's
// Bézier control points.
const curvePoints = (k) => k.kind === "polycurve" ? Array.from({ length: k.sketch.length / 4 }, (_, i) => [k.sketch[4 * i], k.sketch[4 * i + 1]]) : handlesOf(k);
// View `view`'s camera as the manipulator reads it: the Perspective view's points must lie
// ahead of the eye.
function manipulatorCamera(view) {
    const cam = camOf(view);
    return { worldToPx: cam.worldToPx, ray: cam.ray, look: view === 1 ? cam.forward() : cam.basis.view, ahead: view === 1 };
}
// The manipulator laid out in view `view`'s pixels: the arrows' tips and the rings'
// sampled points, those seen edge-on dropped.
const layoutManipulator = (m, view, size) => layoutShared(m, manipulatorCamera(view), size);
function drawManipulator(m, view, [x, y, w, h]) {
    const hot = (kind, name) => drag?.handle?.gizmo && drag.handle.kind === kind && drag.handle.name === name;
    drawShared(ctx, layoutManipulator(m, view, [w, h]), [x, y, w, h], { hot, colours: { accent: ACCENT, handle: HANDLE_COLOUR, stem: ACTIVE_COLOUR } });
}
// The manipulator's handle under pixel `p` of view `view`, or null. The handle carries what
// its drag needs: the subject, the pivot, the axis or the ring's normal.
function hitManipulator(view, p, size) {
    const m = manipulatorOf(view);
    if (!m) return null;
    const hit = hitShared(layoutManipulator(m, view, size), p);
    return hit ? { gizmo: true, ...hit, m, view } : null;
}
// The world point a manipulator drag reads at pixel `p`.
const manipulatorPoint = (h, p, size) => pointShared({ kind: h.kind, axis: h.axis, pivot: h.m.pivot }, manipulatorCamera(h.view), p, size);
// The drag begun: what the subject was, to work every move from.
function beginManipulator(h, p, size) {
    const { m } = h;
    h.fromPx = p;
    h.at = resets;   // a commit after an undo (the document taken back meanwhile) is dropped
    h.from = h.kind === "scale" ? null : manipulatorPoint(h, p, size);
    if (m.subject === "curves") {
        h.was = m.items.map((k) => ({ id: k.id, kind: k.kind, shape: structuredClone(k.shape) }));
    } else h.was = { ...structuredClone(placeOf(m.body)), ...m.body.transform };
}
// A move of the drag: the delta since it began -- a slide (world), a turn (radians
// about the ring's normal) or a scale (the pointer's distance from the centre on
// screen, as a ratio) -- applied to the subject afresh from what it was.
function moveManipulator(h, p, size) {
    const { m } = h;
    const delta = dragDelta({ ...h, pivot: m.pivot }, manipulatorCamera(h.view), p, size);
    if (!delta) return;
    const { slide, turn, scale } = delta;
    if (m.subject === "place") {
        const c = m.body;
        c.place = placeOf(c);
        if (slide) c.place.offset = V.add(h.was.offset, slide);
        else if (h.kind === "rotate") c.place.turn = Q.toEuler(Q.mul(Q.fromAxisAngle(h.axis, turn), Q.fromEuler(h.was.turn)));
        else c.transform.scale = Math.max(0.05, h.was.scale * scale);
        c.dirty = true;
    } else {
        // The curves as a block: every shape mapped about the pivot -- turned by the
        // angle, scaled, then slid in the plane.
        const F = planeInfo(m.plane).frame;
        const d = slide ? [V.dot(slide, F.x), V.dot(slide, F.y)] : [0, 0];
        const cos = Math.cos(turn) * scale, sin = Math.sin(turn) * scale, [px, py] = m.pivot2;
        const map = ([x, y]) => [px + d[0] + cos * (x - px) - sin * (y - py), py + d[1] + sin * (x - px) + cos * (y - py)];
        // On a sketch: what the block starts from, its constraints migrated (first move only,
        // so a click that never drags changes nothing).
        if (h.held === undefined) { const sketch = byId(m.plane); h.held = isSketch(sketch) ? constrainedStart(sketch) : null; }
        if (h.held && constrained(h.held.sketch)) { blockHeld(h, map, turn, scale); schedule(); return; }
        for (const was of h.was) {
            const c = byId(was.id);
            if (!c) continue;
            const out = mappedShape(was.kind, was.shape, map, turn, scale);
            c.kind = out.kind; c.shape = out.shape; c.dirty = true;
        }
    }
    schedule();
}
// The drag done: one command for what it changed.
function endManipulator(h) {
    const { m } = h;
    if (m.subject === "curves" && h.held) {
        // On a sketch: one edit of every curve the block moved (and those held to it), a
        // kind it changed, and the constraints migrated or pruned on the way.
        if (h.stale) dropKeepingRed(h.held.sketch);   // it holds a refused curve as it was
        settleRefused(h.held.sketch);   // a record the move lets apply, in its step
        const items = changedSince(h.held);
        // Kept as it is now, applied in the order's turn (`commitLater`), as a drag's commit is.
        if (items.length) commitLater({ op: "edit", items }, items.map((it) => byId(it.id)).filter((k) => k), false, h.at ?? resets);
    } else if (m.subject === "curves") {
        const items = h.was.map(({ id }) => byId(id)).filter((c) => c).map((c) => ({ id: c.id, kind: c.kind, shape: structuredClone(c.shape) }));
        if (items.length) commitLater({ op: "edit", items }, h.was.map(({ id }) => byId(id)).filter((c) => c), false, h.at ?? resets);
    } else noteLater(m.body, [h.kind === "scale" ? "transform" : "place"], false, h.at ?? resets);
}
// The block on a constrained sketch: every curve of it mapped as the plain move maps it,
// then the sketch solved as one drag of all their point spots to where the map put them
// (the curves held to the block follow it), on the session the last move left (warm, so
// a gizmo drag builds none): a scaled circle's radius held by a throwaway driving radius,
// a polycurve's fixed ends placed, an ellipse's axes set (not in the session). A move
// that changes a kind -- a turned rectangle becomes a polyline, its rectangle's spots
// pruned from the constraints, and stays one for the rest of the drag -- builds the
// session from the mapped shapes, once. What does not converge, or folds a polygon,
// leaves the block where the last move left it and says why.
function blockHeld(h, map, turn, scale) {
    const { sketch, migrated } = h.held;
    const list = sketchCurves(sketch);
    const snapshot = { kinds: new Map(list.map((k) => [k.id, k.kind])), shapes: new Map(list.map((k) => [k.id, structuredClone(k.shape)])), constraints: structuredClone(sketch.constraints) };
    const block = [];
    for (const was of h.was) {
        const c = byId(was.id);
        if (!c) continue;
        let out = mappedShape(was.kind, was.shape, map, turn, scale);
        // A rectangle turned once stays the polyline it became for the rest of the drag
        // (turned back square, it would build the session again).
        if (out.kind === "rect" && c.kind === "polyline") { const s = out.shape; out = { kind: "polyline", shape: { points: [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]], closed: true } }; }
        block.push({ c, wasKind: was.kind, out });
    }
    const mapped = new Map(block.map(({ c, out }) => [c.id, { ...c, kind: out.kind, shape: out.shape }]));
    const constraints = block.some(({ wasKind, out }) => out.kind !== wasKind)
        ? sk.pruneConstraints(migrated, curvesMap(list.map((k) => mapped.get(k.id) ?? k))).kept : migrated;
    const warm = block.every(({ c, out }) => c.kind === out.kind) && JSON.stringify(constraints) === JSON.stringify(sketch.constraints);
    let error = null, touched = !warm, collapse = false, held = null, geo = null;
    const temps = [];
    try {
        let model;
        if (warm) {
            model = held = modelFor(sketch);   // before anything moves: the cached session
            geo = heldState(model);   // put back where the move is refused
            for (const { c, out } of block) {
                // A curve the session refused when built: moved as mapped, unsolved, the
                // session built again once the drag is let go (`h.stale`).
                if (!model.parts.has(c.id)) { c.kind = out.kind; c.shape = out.shape; c.dirty = true; h.stale = true; }
                else if (c.kind === "ellipse") { c.shape = { ...c.shape, rx: out.shape.rx, ry: out.shape.ry }; c.dirty = true; }
                else if (c.kind === "polycurve") {
                    c.shape = out.shape; c.dirty = true;
                    if (!out.shape.closed && model.entity.has(`${c.id}:start`)) { touched = true; out.shape.ends.forEach((p, i) => sk.placeSpot(wasm, model, c.id, i ? "end" : "start", p[0], p[1])); }
                } else if (c.kind === "circle" && out.shape.r !== c.shape.r && model.entity.has(`${c.id}:curve`)) {
                    const id = TYPED_RADIUS - 1 - temps.length;
                    touched = true;   // an add solves: the session moves even where the drag will not
                    if (sk.addConstraint(wasm, model, { id, kind: "radius", refs: [{ curve: c.id, at: "curve" }], value: out.shape.r, driving: true }).ok) temps.push(id);
                }
            }
        } else {
            for (const { c, out } of block) { c.kind = out.kind; c.shape = out.shape; c.dirty = true; }
            setConstraints(sketch, structuredClone(constraints));
            model = modelFor(sketch);
        }
        const pins = block.flatMap(({ c, out }) => Object.entries(spotPositions({ kind: out.kind, shape: out.shape })).filter(([at]) => model.entity.has(`${c.id}:${at}`)).map(([at, p]) => ({ curve: c.id, at, x: p[0], y: p[1] })));
        let report;
        try { report = pins.length ? sk.dragModel(wasm, model, pins) : sk.solveModel(wasm, model); }
        finally { for (const id of temps) sk.removeConstraint(wasm, model, id); }
        if (report.status === "converged") ({ error = null, collapse = false } = writeHeld(sketch, model));
        else error = solveFailure(sketch, report);
        if (!error) keepModel(sketch, model);
    } catch (e) { error = String(e?.message ?? e); }
    if (!error) return;
    for (const k of sketchCurves(sketch)) {
        if (!snapshot.shapes.has(k.id)) continue;
        k.kind = snapshot.kinds.get(k.id); k.shape = snapshot.shapes.get(k.id); k.dirty = true;
    }
    setConstraints(sketch, snapshot.constraints);
    // The warm session put back as this move found it (a shrunk curve, a placed polycurve
    // end, a held radius's solve undone) and kept: no build on the next move. One built for
    // this move (a rectangle turned) goes, keeping its red records where it shrank a curve.
    const kept = !!geo && (collapse || touched) && restoreHeld(sketch, held, geo);
    if (!kept && collapse) dropKeepingRed(sketch);
    else if (!kept && touched) dropModel(sketch.id);   // else the drag that did not converge left the session as it was
    refuse(`the block does not move there: ${error}`);
}
// Where a curve's point spots are by its shape (`spotsOf` names; a polycurve's ends are
// fixed in the session and left out).
function spotPositions(c) {
    const s = c.shape, out = {};
    switch (c.kind) {
    case "line": out.start = [s.x0, s.y0]; out.end = [s.x1, s.y1]; break;
    case "arc": {
        out.start = [s.x0, s.y0]; out.end = [s.x1, s.y1];
        const o = circumcentreOf([s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]);
        if (o) out.centre = o;
        break;
    }
    case "circle": case "ellipse": out.centre = [s.cx, s.cy]; break;
    case "rect": [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]].forEach((p, i) => { out[`corner:${i}`] = p; }); break;
    case "polygon": out.centre = [s.cx, s.cy]; polygonPoints(s).forEach((p, i) => { out[`vertex:${i}`] = p; }); break;
    case "polyline": case "nurbs": s.points.forEach((p, i) => { out[`vertex:${i}`] = p; }); break;
    default: break;
    }
    return out;
}
// A shape under the map `map` of its plane (a turn by `turn`, a scale by `scale`, a
// slide): its points mapped; a circle's centre with its radius scaled; an ellipse's
// centre, its semi-axes scaled (it stays with the axes -- it cannot turn); a polygon's
// centre, its radius and its angle; a rectangle's corners while it stays square to the
// axes, else it becomes a polyline of its corners; a polycurve piece by piece.
function mappedShape(kind, shape, map, turn, scale) {
    const s = structuredClone(shape);
    if (kind === "line") { [s.x0, s.y0] = map([s.x0, s.y0]); [s.x1, s.y1] = map([s.x1, s.y1]); return { kind, shape: s }; }
    if (kind === "arc") { [s.x0, s.y0] = map([s.x0, s.y0]); [s.xm, s.ym] = map([s.xm, s.ym]); [s.x1, s.y1] = map([s.x1, s.y1]); return { kind, shape: s }; }
    if (kind === "circle") { [s.cx, s.cy] = map([s.cx, s.cy]); s.r = Math.max(0.5, s.r * scale); return { kind, shape: s }; }
    if (kind === "ellipse") { [s.cx, s.cy] = map([s.cx, s.cy]); s.rx = Math.max(0.5, s.rx * scale); s.ry = Math.max(0.5, s.ry * scale); return { kind, shape: s }; }
    if (kind === "polygon") { [s.cx, s.cy] = map([s.cx, s.cy]); s.r = Math.max(0.5, s.r * scale); s.angle = Math.round((s.angle + turn * 180 / Math.PI) * 10) / 10; return { kind, shape: s }; }
    if (kind === "rect") {
        const corners = [[s.x0, s.y0], [s.x1, s.y0], [s.x1, s.y1], [s.x0, s.y1]].map(map);
        if (Math.abs(Math.sin(turn)) < 1e-9) return { kind, shape: { x0: corners[0][0], y0: corners[0][1], x1: corners[2][0], y1: corners[2][1] } };
        return { kind: "polyline", shape: { points: corners, closed: true } };
    }
    if (kind === "polyline" || kind === "nurbs") { s.points = s.points.map(map); return { kind, shape: s }; }
    if (kind === "polycurve") {
        s.pieces = s.pieces.map((piece) => mappedShape(piece.kind, piece.shape, map, turn, scale));
        s.ends = s.ends.map(map);
        return { kind, shape: s };
    }
    return { kind, shape: s };
}

// What is under pixel `p` of view `view`: every selected item whose plane that view
// shows (the same rule the overlay draws by), each read in its own plane.
function hit(p, size, view) {
    const near = (plane, q) => { const [sx, sy] = sketchToLocal(plane, q, size); return Math.hypot(sx - p[0], sy - p[1]) <= 9; };
    if (axisMode && viewOf(axisMode.plane) === view) {
        for (let i = 0; i < 2; i++) if (near(axisMode.plane, axisMode.axis[i])) return { curve: null, handle: { kind: "axis", index: i } };
    }
    const active = current();
    for (const c of [...(active ? [active] : []), ...selectedCurves().filter((c) => c !== active)]) {
        if (isSketch(c) || !visible(c)) continue;
        if (viewOf(c.plane) !== view) continue;
        if (isBody(c)) {
            // A revolution's axis ends; the gizmo is the manipulator's, tried before this.
            if (c.kind === "revolution" && c.axis) {
                const axis = worldAxis(c);
                for (let i = 0; i < 2; i++) if (near(c.plane, axis[i])) return { curve: c, handle: { kind: "axis", index: i } };
            }
            continue;
        }
        const handles = handlesOf(c);
        for (let i = handles.length - 1; i >= 0; i--) {
            const [sx, sy] = sketchToLocal(c.plane, handles[i], size);
            if (Math.hypot(sx - p[0], sy - p[1]) > 9) continue;
            let handle;
            if (c.kind === "line") handle = { kind: "end", index: i };
            else if (c.kind === "rect") handle = { kind: "corner", index: i };
            else if (c.kind === "circle") handle = { kind: i === 0 ? "centre" : "radius" };
            else if (c.kind === "arc") handle = i === 1 ? { kind: "through" } : { kind: "end", index: i };
            else if (c.kind === "ellipse") handle = { kind: ["centre", "rx", "ry"][i] };
            else if (c.kind === "polygon") handle = { kind: i === 0 ? "centre" : "vertex" };
            else handle = { kind: "point", index: i };
            return { curve: c, handle };
        }
    }
    return null;
}

// Move handle `h` of curve `c` to the sketch point `w`. A line's or an arc's end
// and an arc's through-point move alone; a corner moves alone, its opposite fixed (the two
// others follow, being the rectangle's other two x/y pairs); the centre carries a circle
// or an ellipse; the rim sets a radius, an axis end its semi-axis (the distance along
// that axis, so the ellipse stays axis-aligned) -- a radius never below half a millimetre,
// so a drag through the centre cannot leave a conic of no size. An end -- a line's, an
// arc's, the first or last point of an open polyline or NURBS -- snaps onto another
// curve's end (or its own curve's other end) within `SNAP_PX` on screen, taking that
// end's coordinates exactly, so that the two are one corner to the loop detection.
const SNAP_PX = 10;
// The sketch point the dragged end is snapped onto, for the overlay's ring: `{ plane, at }`,
// and for a curve's end also `curve` and `spot`, the end it is on (what a drag let go there
// records as a coincident, `inferSnapped`).
let snapped = null;
function moveHandle(c, h, w) {
    if (h.kind === "axis") {
        // An axis end snaps onto curve ends as a curve's own end does.
        snapped = null;
        const plane = c === null ? axisMode.plane : c.plane;
        const target = snapPoint(w, plane);
        if (target) { w = target; snapped = { plane, at: target }; }
        if (c === null) { axisMode.axis[h.index] = [w[0], w[1]]; return; }
        c.axis[h.index] = unmapPoint(c, w);
        c.dirty = true;
        schedule();
        return;
    }
    snapped = null;
    const sketch = sketchOf(c);
    const held = constrained(sketch);
    if (isEnd(c, h)) {
        // A held end drags its coincident partners along: their ends, under it, are no target.
        const target = snapTarget(c, h, w, held ? handlesOf(c)[h.index] : null);
        if (target) { w = target.at; snapped = { plane: c.plane, ...target }; }
    }
    if (held) { dragHeld(c, h, w, sketch); return; }
    setHandle(c, h, w);
    c.dirty = true;
    schedule();
}
// The handle of a curve on a constrained sketch as the session's spot, or null where it
// is none (an arc's through-point, a circle's rim, an ellipse's axis ends) -- or where
// the plain edit is the handle's meaning: a polygon's vertex handle sizes and turns it
// about its centre, which a solver drag of `vertex:0` would move instead.
function spotOfHandle(h) {
    switch (h.kind) {
    case "end": return h.index === 0 ? "start" : "end";
    case "corner": return `corner:${h.index}`;
    case "centre": return "centre";
    case "point": return `vertex:${h.index}`;
    default: return null;
    }
}
// A handle dragged on a constrained sketch, driving the session the last move left (warm:
// `modelFor` finds it cached, as every write keeps its signature the document's, so a drag
// builds none). A spot the session holds is dragged by the solver,
// everything held to it following. The handles that are no spot are held as a typed value
// is (`solveTyped`): a circle's rim by a throwaway driving radius; a polygon's vertex
// handle (its size and turn) as vertex 0 dragged where the plain edit puts it, the centre
// held; an arc's through-point as its centre dragged to the new three points'
// circumcentre, the ends held, the through-point then put on the solved circle under the
// pointer, where that keeps the arc the session holds (else at the mid-angle). An ellipse's
// axis ends are not in the session: set, nothing solved; nor is a curve the session
// refused when it was built: moved as it is, the session built again once the drag is let
// go (`h.stale`). Only a through-point dragged across the arc's chord (the arc flips,
// which the session's arc cannot follow) builds a session from the moved shape; once one
// flip has gone through (`h.rebuilt`), a second crossing in the same drag is refused. What
// does not converge (or folds a polygon, or a held radius) leaves every shape as it was
// this move and says why.
let heldHint = false;   // the hint says why the last held move did not go
function dragHeld(c, h, w, sketch) {
    const at = spotOfHandle(h);
    const was = structuredClone(c.shape);
    let model = null, report, cold = false, through = null, geo = null;
    try {
        model = modelFor(sketch);
        geo = heldState(model);   // put back if the move would shrink a curve to a point
        const has = (spot) => model.entity.has(`${c.id}:${spot}`);
        const s = c.shape;
        if (at !== null && has(at)) {
            const moves = [{ curve: c.id, at, x: w[0], y: w[1] }];
            // A corner moves with its opposite held where it is, as the plain drag has it.
            if (h.kind === "corner") { const k = (h.index + 2) % 4, p = handlesOf(c)[k]; moves.push({ curve: c.id, at: `corner:${k}`, x: p[0], y: p[1] }); }
            report = sk.dragModel(wasm, model, moves);
        } else if (h.kind === "rx" || h.kind === "ry") {
            setHandle(c, h, w);
            report = { status: "converged", ids: [] };
        } else if (h.kind === "radius" && has("curve")) {
            const r = Math.max(0.5, Math.hypot(w[0] - s.cx, w[1] - s.cy));
            const added = sk.addConstraint(wasm, model, { id: TYPED_RADIUS, kind: "radius", refs: [{ curve: c.id, at: "curve" }], value: r, driving: true });
            if (added.ok) { sk.removeConstraint(wasm, model, TYPED_RADIUS); report = { status: "converged", ids: [] }; }
            else report = { status: "conflicting", ids: [], error: `r is held by ${added.with.length ? added.with.map((id) => constraintName(sketch, id)).join(", ") : "the sketch's constraints"}` };
        } else if (h.kind === "vertex" && has("centre") && has("vertex:0")) {
            const next = { shape: structuredClone(s) };
            setHandle(next, h, w);
            const v = polygonPoints(next.shape)[0];
            report = sk.dragModel(wasm, model, [{ curve: c.id, at: "centre", x: s.cx, y: s.cy }, { curve: c.id, at: "vertex:0", x: v[0], y: v[1] }]);
        } else if (h.kind === "through" && has("centre") && has("start") && has("end") && arcReversed(s.x0, s.y0, w, s.x1, s.y1) === model.parts.get(c.id)?.reversed) {
            const o = circumcentreOf([s.x0, s.y0], w, [s.x1, s.y1]);
            if (!o) report = { status: "diverged", ids: [], error: "the arc's three points are in a line" };
            else {
                report = sk.dragModel(wasm, model, [{ curve: c.id, at: "start", x: s.x0, y: s.y0 }, { curve: c.id, at: "end", x: s.x1, y: s.y1 }, { curve: c.id, at: "centre", x: o[0], y: o[1] }]);
                through = w;
            }
        } else if (!model.parts.has(c.id)) {
            setHandle(c, h, w);
            h.stale = true;
            report = { status: "converged", ids: [] };
        } else if (!h.rebuilt) {
            cold = true;
            setHandle(c, h, w);
            model = modelFor(sketch);   // built again from the moved shape
            report = sk.solveModel(wasm, model);
        } else report = { status: "diverged", ids: [], error: "the arc flips over its chord once a drag -- let go and drag again" };
    } catch (error) {
        report = { status: "diverged", ids: [], error: String(error?.message ?? error) };
    }
    // A warm session refusing a move is as it was (a drag or an add that does not converge
    // changes nothing); one built from the moved shape is not the document's.
    const undo = () => { c.shape = was; c.dirty = true; if (cold) dropModel(sketch.id); };
    if (report.status !== "converged") {
        undo();
        hintEl.textContent = `${c.name}: ${report.error ?? solveFailure(sketch, report)}`;
        heldHint = true;
        schedule();
        return;
    }
    const { error, collapse, gone } = writeHeld(sketch, model);
    if (collapse) {
        c.shape = was; c.dirty = true;
        if (cold || !restoreHeld(sketch, model, geo)) dropKeepingRed(sketch);   // one built from the moved shape is not the document's
        hintEl.textContent = gone === c ? error : `${c.name}: ${error}`;
        heldHint = true;
        schedule();
        return;
    }
    if (error) { undo(); refuse(error); }
    else {
        if (through) {
            // The through-point under the pointer, on the solved circle -- where that is on the
            // arc the session holds: a centre held off the circumcentre can put the pointer's
            // radial projection on the complementary arc (the pointer between the centre and
            // the chord, or past an end), which would turn the document's arc against the
            // session's. There the write-back's mid-angle point stands.
            const pt = (spot) => Array.from(wasm.cadaclysm_blacksmith_sketch_point(model.h, model.entity.get(`${c.id}:${spot}`)));
            const o = pt("centre"), a = pt("start"), r = Math.hypot(a[0] - o[0], a[1] - o[1]), d = Math.hypot(through[0] - o[0], through[1] - o[1]);
            const s = c.shape, m = d > 0 ? [o[0] + r * (through[0] - o[0]) / d, o[1] + r * (through[1] - o[1]) / d] : null;
            if (m && arcReversed(s.x0, s.y0, m, s.x1, s.y1) === model.parts.get(c.id)?.reversed) c.shape = { ...s, xm: m[0], ym: m[1] };
        }
        if (cold) h.rebuilt = true;   // the arc did flip: once a drag
        sk.rebase(wasm, model, [c]);
        keepModel(sketch, model);   // a shape set outside the solve (an axis, a through-point) kept the session's
        if (heldHint) { heldHint = false; hintEl.textContent = hintFor(c.kind); }
    }
    c.dirty = true;
    schedule();
}
// Whether the 3-point arc from (x0, y0) through `m` to (x1, y1) runs clockwise: how the
// session adds it (end to start, flagged reversed).
const arcReversed = (x0, y0, m, x1, y1) => !((m[0] - x0) * (y1 - m[1]) - (m[1] - y0) * (x1 - m[0]) > 0);
// The cached session of `sketch` marked as holding the document as it now stands, where it
// is `model`: after a shape the session does not hold was set (an ellipse's axis, an
// arc's through-point on its circle), so the next pointer move finds it warm.
function keepModel(sketch, model) {
    const entry = models.get(sketch.id);
    if (entry?.model === model) entry.sig = modelSig(sketch);
}
// A held move refused on the warm session `model` (a curve it would shrink to a point, a
// block that does not go), the curves already put back: the session's geometry and bases
// put back as `geo` (`heldState`, read before the move) and taken as the document's again, so the
// next pointer move finds it warm -- no build per refused move, its red records kept.
// False, nothing done, where `model` is no longer the cached session (a withheld polygon
// dropped it).
// What `restoreHeld` puts back: the session's geometry and its curves' write-back bases
// (each as the last write left it, never reset to the readings of the moment).
const heldState = (model) => ({ points: sk.geometryOf(wasm, model), base: new Map(model.base) });
function restoreHeld(sketch, model, geo) {
    if (models.get(sketch.id)?.model !== model) return false;
    sk.setGeometry(wasm, model, geo.points);
    model.base.clear();
    for (const [id, b] of geo.base) model.base.set(id, b);
    keepModel(sketch, model);
    return true;
}
// Handle `h` of `c` moved to `w`, the shape alone.
function setHandle(c, h, w) {
    const s = c.shape;
    if (h.kind === "end") {
        if (h.index === 0) { s.x0 = w[0]; s.y0 = w[1]; } else { s.x1 = w[0]; s.y1 = w[1]; }
    } else if (h.kind === "through") {
        s.xm = w[0]; s.ym = w[1];
    } else if (h.kind === "corner") {
        if (h.index === 0 || h.index === 3) s.x0 = w[0]; else s.x1 = w[0];
        if (h.index === 0 || h.index === 1) s.y0 = w[1]; else s.y1 = w[1];
    } else if (h.kind === "centre") {
        s.cx = w[0]; s.cy = w[1];
    } else if (h.kind === "radius") {
        s.r = Math.max(0.5, Math.hypot(w[0] - s.cx, w[1] - s.cy));
    } else if (h.kind === "rx") {
        s.rx = Math.max(0.5, Math.abs(w[0] - s.cx));
    } else if (h.kind === "ry") {
        s.ry = Math.max(0.5, Math.abs(w[1] - s.cy));
    } else if (h.kind === "vertex") {
        // The first vertex: the polygon's size and its turn, together.
        s.r = Math.max(0.5, Math.hypot(w[0] - s.cx, w[1] - s.cy));
        if (s.r > 0.5) s.angle = Math.round(Math.atan2(w[1] - s.cy, w[0] - s.cx) * 180 / Math.PI * 10) / 10;
    } else {
        s.points[h.index] = [w[0], w[1]];
    }
}

// The two ends of an open curve, `[start, end]` in sketch units, or null for a curve
// with none: one closed by kind or by its flag, or a polyline or NURBS of a single point
// (nothing to join yet).
function endsOf(c) {
    const s = c.shape;
    if (isBody(c) || isSketch(c)) return null;
    if (c.kind === "line" || c.kind === "arc") return [[s.x0, s.y0], [s.x1, s.y1]];
    if (pointed(c) && !s.closed && s.points.length > 1) return [s.points[0], s.points[s.points.length - 1]];
    if (c.kind === "polycurve" && !s.closed) return s.ends.map((p) => p.slice());
    return null;
}

// Whether handle `h` of curve `c` is one of its ends.
function isEnd(c, h) {
    if (h.kind === "end") return true;
    if (h.kind === "point") return pointed(c) && !c.shape.closed && (h.index === 0 || h.index === c.shape.points.length - 1);
    return false;
}

// The end of some other curve -- or the other end of this one, when it has more than
// two points to make a loop of -- within `SNAP_PX` of the sketch point `w` in the Top
// view; the nearest when several. Null when none.
// The nearest curve end within `SNAP_PX` of `w`, any curve's, or null: what an axis end
// snaps onto. `skip` as `snapSpot`'s.
const snapPoint = (w, plane, skip = null) => snapSpot(w, plane, false, skip)?.at ?? null;
// The same as `{ at, curve, spot }`: the point, the curve snapped onto and which of its
// spots ("start", "end"; with `centres`, also a circle's, an arc's, a polygon's or an
// ellipse's "centre" -- what a centre being placed snaps onto). What drawing records, so
// the constraints the snap means can be inferred when the curve is done. `skip`
// (`{ curve, spot }`) is a spot never snapped onto: the point of a curve being drawn
// that follows the pointer (`pendingSpot`).
function snapSpot(w, plane, centres = false, skip = null) {
    if (viewOf(plane) === null) return null;
    const size = sizeOf(viewOf(plane));
    const [wx, wy] = sketchToLocal(plane, w, size);
    let best = null, bestD = SNAP_PX;
    const consider = (other, spot, q) => {
        if (skip && other.id === skip.curve && spot === skip.spot) return;
        const [px, py] = sketchToLocal(plane, q, size);
        const d = Math.hypot(px - wx, py - wy);
        if (d < bestD) { bestD = d; best = { at: [q[0], q[1]], curve: other.id, spot }; }
    };
    for (const other of curves) {
        if (other.plane !== plane) continue;
        const ends = endsOf(other);
        if (ends) { consider(other, "start", ends[0]); consider(other, "end", ends[1]); }
        if (!centres) continue;
        const s = other.shape;
        if (other.kind === "circle" || other.kind === "polygon" || other.kind === "ellipse") consider(other, "centre", [s.cx, s.cy]);
        else if (other.kind === "arc") { const o = circumcentreOf([s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]); if (o) consider(other, "centre", o); }
    }
    return best;
}

// The end (`{ at, curve, spot }`: the point, its curve, "start" or "end") that the end
// handle `h` of `c` dragged to `w` snaps onto, as `snapSpot` finds one -- `skip` the point
// the dragged end is at (its held partners lie there) -- or null.
function snapTarget(c, h, w, skip = null) {
    if (viewOf(c.plane) === null) return null;
    const size = sizeOf(viewOf(c.plane));
    const [wx, wy] = sketchToLocal(c.plane, w, size);
    let best = null, bestD = SNAP_PX;
    const consider = (p, other, spot) => {
        // Where the dragged end is now (the solver's coincident partners, to its last digits).
        if (skip && Math.hypot(p[0] - skip[0], p[1] - skip[1]) <= 1e-6 * Math.max(1, Math.hypot(skip[0], skip[1]))) return;
        const [px, py] = sketchToLocal(c.plane, p, size);
        const d = Math.hypot(px - wx, py - wy);
        if (d < bestD) { bestD = d; best = { at: [p[0], p[1]], curve: other.id, spot }; }
    };
    for (const other of curves) {
        if (other.plane !== c.plane) continue;
        const ends = endsOf(other);
        if (!ends) continue;
        if (other !== c) { consider(ends[0], other, "start"); consider(ends[1], other, "end"); continue; }
        if (pointed(c) && c.shape.points.length > 2) consider(h.index === 0 ? ends[1] : ends[0], c, h.index === 0 ? "end" : "start");
    }
    return best;
}

// ------------------------------------------------------------------ the mouse

// The mouse mapping, the other viewers' (`View`'s gesture handler, which the
// reader page and the desktop viewer use too): the left button turns the camera, with Alt
// it orbits what is selected, the right button pans, and the wheel dollies or zooms. A
// press in any view makes it the active one. The page claims the presses it handles
// itself -- a handle, the gizmo, the view cube, a name, a curve being drawn -- and hands
// every other to the view (`forge-input.js`); a press the view hands back as a tap does
// what it would have done where it landed (`pressAt`).
let drag = null;   // { kind: "handle", handle, ... } | { kind: "cube", last: [x, y], cube }

function hintFor(kind) {
    const rest = " · left-drag: turn · shift-drag or right-drag: pan · alt-drag: orbit the selection · wheel: zoom · WASD: fly in Perspective · ctrl / shift-click the list to select several";
    if (kind === "line") return "left: drag an end in its view · ends snap onto other ends · the gizmo moves, turns and scales the selected curves as a block" + rest;
    if (kind === "polyline") return "left: select and drag a point in its view · close joins the ends" + rest;
    if (kind === "rect") return "left: drag a corner to resize in its view · the gizmo moves and scales it (turned, it becomes a polyline)" + rest;
    if (kind === "circle") return "left: drag the centre to move, the rim handle to size, in its view" + rest;
    if (kind === "arc") return "left: drag an end or the through-point in its view · ends snap onto other ends" + rest;
    if (kind === "ellipse") return "left: drag the centre to move, an axis handle to size that axis, in its view" + rest;
    if (kind === "polygon") return "left: drag the centre to move, the vertex handle to size and turn, in its view · sides in the strip" + rest;
    if (kind === "nurbs") return "left: select and drag a point in its view · close joins the ends · degree and the point's weight in the dialog" + rest;
    if (kind === "polycurve") return "one curve of its pieces, for a path or a profile · close joins its ends with a line · explode gives the pieces back to edit, merge joins them again" + rest;
    if (kind === "surface" || kind === "extrusion" || kind === "solid" || kind === "sweep" || kind === "loft") return "left: the gizmo's arrows slide it, the rings turn it, the square scales it -- along and about the world X, Y, Z in every view; X, Y, Z in the dialog are its place" + rest;
    if (kind === "revolution") return "left: the gizmo's arrows slide it along X, Y, Z, the rings turn it · drag the axis's ends in its sketch's view to re-aim it" + rest;
    if (kind === "join" || kind === "cut" || kind === "intersect" || kind === "shell" || kind === "thicken" || kind === "prism" || kind === "split") return "left: the gizmo's arrows slide it along X, Y, Z and the rings turn it" + rest;
    if (isQuickKind(kind) || kind === "pipe") return "its sizes in the dialog · left: the gizmo's arrows slide it, the rings turn it" + rest;
    if (kind === "trim") return "left: the gizmo's arrows slide it along X, Y, Z and the rings turn it · trim picks the pieces again" + rest;
    if (kind === "fillet") return "left: the gizmo's arrows slide it along X, Y, Z and the rings turn it · fillet picks the edges again" + rest;
    if (kind === "sketch") return "the dialog sets its plane: offset from an origin plane, at an angle to a line, across a curve, on a face, midway between two planes or through three points · look at points a view at it" + rest;
    return "pick a curve tool in the ribbon and click its points in a view" + rest;
}


overlay.addEventListener("pointerdown", (e) => {
    const px = [e.offsetX, e.offsetY];
    const i = viewportAt(px);
    if (i < 0 || lastReport === null) return;
    active = i;
    overlay.setPointerCapture(e.pointerId);
    // A curve being drawn takes the click: its next point, in the view's plane (the
    // curve's own, once begun), snapped onto curve ends; a right click ends a polyline.
    if (drawing && i !== 1 && nameAt(px) < 0 && !onViewCube(px)) {
        if (e.button === 2) { userAct(() => finishDrawing()); return; }
        if (e.button !== 0) return;
        const plane = drawing.id !== null ? byId(drawing.id)?.plane : viewPlane[i];
        if (plane === undefined || viewOf(plane) !== i) return;   // begun in another view: that one's plane
        let w = pxToSketch(plane, local(px, i), sizeOf(i));
        // A centre being placed snaps onto other centres too.
        const target = snapSpot(w, plane, placingSpot() === "centre", pendingSpot());
        if (target) w = target.at;
        userAct(() => drawClick(w, plane, target));
        return;
    }
    // A press on the view cube is the page's: a click on a face aims the camera square at
    // it, a drag orbits about the selection.
    if (i === 1 && e.button === 0 && onViewCube(px)) {
        const face = viewCubeFaceAt(px);
        syncPivot();
        drag = { kind: "cube", last: px, cube: face?.label ?? null };
        return;
    }
    // Everything else is the view's gesture, read by the camera under it: the left button
    // looks in Perspective and pans an orthographic view, Alt and the left button orbit the
    // selection in Perspective, the right button pans. The page keeps what is its own: the
    // middle button (nothing), and a left press on a view's name (it only activates) or on
    // a handle (dragged from here). A left press the view keeps comes back, if it never
    // became a drag, as a tap: the page's click, `pressAt`.
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
    const orbiting = i === 1 && e.altKey && e.button === 0;
    if (e.button === 0 && !orbiting) {
        if (nameAt(px) >= 0) return;                           // a name only activates: its double-click maximizes
        if (handleUnderPress(i, px)) return;
    }
    if (orbiting) syncPivot();
    // Shift and the left button add a face to a pick of several (extrude's "shift-click
    // faces to push several"): the view pans on the drag as everywhere, but the View
    // never taps a Shift press, so the router makes the click if it never became a drag.
    // A constraint tool's Shift-click is a click too: Shift picks a dimension's variant
    // (horizontal or vertical distance, diameter).
    const shiftTap = e.shiftKey && e.button === 0 && !orbiting && e.pointerType === "mouse" && !!sketchPick && (!!sketchPick.spots || !!SKETCH_PICKS[sketchPick.kind]?.faces);
    router.forward(e, i, px, { shiftTap });
});

// The handle a press lands on, dragged from here: the gizmo of the selected body, or a
// point, end or rim handle of the selected curve in an orthographic view. `true` where one
// was found and the drag begun. None of this is offered while a tool is picking -- the
// press belongs to the pick -- nor while a curve is being drawn.
function handleUnderPress(i, px) {
    const c = current();
    const facePick = facePicking() && isSketch(c);
    const picking_ = !!(sketchPick || sweepMode || sketchTrim || (picking === "points" && isSketch(c)));
    const modal = !!(shellMode || trimMode || filletMode || facePick || picking_);
    if (modal || drawing) return false;
    if (c) {
        const size = sizeOf(i), p = local(px, i);
        const handle = hitManipulator(i, p, size);
        if (handle) {
            beginManipulator(handle, p, size);
            // A gizmo sits at its body's pivot, which can lie over another body (one
            // extruded off a face stands on its solid): a click there that never
            // becomes a drag selects what is under it.
            drag = { kind: "handle", curve: c, handle, view: i, from: px, moved: false, under: pickBody(i, px), at: resets };
            pendingNotice = null;   // a notice is its own drag's: never carried onto this one's build
            schedule();
            return true;
        }
    }
    if (i !== 1 && (c || axisMode)) {
        const p = local(px, i), size = sizeOf(i);
        const found = hit(p, size, i);
        if (found !== null) {
            // A handle of another selected curve makes that curve the active one, the
            // selection otherwise as it was. The armed axis belongs to no curve.
            if (found.curve !== null && found.curve !== c) { selected = found.curve.id; selectedPoint = null; syncToolbar(); renderList(); }
            if (found.handle.kind === "point") selectPoint(found.handle.index);
            drag = { kind: "handle", curve: found.curve, handle: found.handle, view: i, at: resets };
            pendingNotice = null;   // a notice is its own drag's: never carried onto this one's build
            return true;
        }
    }
    return false;
}

// What a press does where it lands, once it is known not to be a turn: a tool's pick, a
// selection, a point dropped. Run from `endDrag` when the button comes up where it went
// down.
function pressAt(i, px, e) {
    if (sketchPick?.spots) { sketchPick.shift = e.shiftKey; pickSpotAt(i, px); return; }
    if (sketchPick?.kind === "split") {
        const hitCurve = pickCurve(i, px);
        if (hitCurve) { splitByCurve(hitCurve); return; }
        pickThen(i, px, undefined, (hit) => { if (hit && sketchPick?.kind === "split") splitAtFace(hit.body, hit.index); });
        return;
    }
    if (sketchPick?.kind === "remove") {
        // The face is one of the selected solid's: the tool was lit by that selection.
        pickThen(i, px, undefined, (hit) => {
            if (!hit || sketchPick?.kind !== "remove") return;
            if (!sketchPick.was.includes(hit.body.id)) { say(`remove takes a face of the selected solid, not of ${hit.body.name}`, true); return; }
            removeAtFace(hit.body, hit.index);
        });
        return;
    }
    if (sketchPick) {
        const hitCurve = pickCurve(i, px);
        if (hitCurve) { pickCurveInto(hitCurve); return; }
        // No curve: a body's face, for a tool that takes bodies -- extrude takes a
        // face of a solid or a sheet as it is, sweep and extrude a surface, a trim or a
        // face already taken (a sheet body of one face) whole.
        const { kind } = sketchPick;
        pickThen(i, px, undefined, (hit) => {
            if (!hit || !sketchPick || sketchPick.kind !== kind) return;
            // A face already taken for a push of several: clicked again without shift, the
            // faces are pushed.
            if (hit.body.kind === "face" && sketchPick.faces?.includes(hit.body.id)) { if (!e.shiftKey) runSketchPick(); return; }
            if (SKETCH_PICKS[kind].bodies || hit.body.kind === "surface" || hit.body.kind === "trim" || hit.body.kind === "face") { pickCurveInto(hit.body); return; }
            if (SKETCH_PICKS[kind].faces) pickSolidFace(hit.body, hit.index, e.shiftKey);
        });
        return;
    }
    // A 3-point plane's points: the curve end nearest the click.
    if (picking === "points" && isSketch(current())) {
        const end = pickEnd(i, px);
        if (end) pickPointInto(current(), end); else say("no curve end there -- click nearer one", true);
        return;
    }
    if (sweepMode) {
        const hitCurve = pickCurve(i, px);
        if (hitCurve) pickSweepPath(hitCurve.id);
        return;
    }
    // A constraint's mark or a dimension's label under the click selects the constraint.
    if (!sketchTrim && !shellMode && !trimMode && !filletMode && !axisMode && !facePicking()) {
        const dim = constraintAt(px);
        if (dim) { selectDimension(dim); return; }
    }
    // A face under the click: while picking one, it becomes the sketch's; otherwise, in
    // Perspective, or in an orthographic view where no handle is hit, the click selects
    // the body it belongs to (with ctrl, toggles it), which the list also does.
    if (sketchTrim) {
        if (e.button === 0 && nameAt(px) < 0) { const h = pieceUnder(i, px); if (h) trimAway(h.id, h.k); }
        return;
    }
    const c = current();
    const facePick = facePicking() && isSketch(c);
    if (!shellMode && !trimMode && !filletMode && !facePick && (i === 1 || (!c && !axisMode))) { selectAt(i, px, e, !axisMode); return; }
    if (shellMode || trimMode || filletMode || facePick) {
        pickThen(i, px, e, (hitBody) => {
            if (filletMode) {
                const src = filletSource(filletMode.body);
                if (src && hitBody?.body === src) pickFilletEdge(filletMode.body, i, px, hitBody.index);
                else if (src) pickFilletEdge(filletMode.body, i, px, null);
                return;
            }
            if (trimMode) {
                if (hitBody && hitBody.body === trimMode.body) pickTrimPiece(hitBody.body, hitBody.index, !!hitBody.ghost);
                return;
            }
            if (shellMode) {
                if (hitBody && hitBody.body === shellMode.body) {
                    if (shellMode.open.has(hitBody.index)) shellMode.open.delete(hitBody.index); else shellMode.open.add(hitBody.index);
                    hintEl.textContent = shellHint();
                    renderDialog();
                }
                return;
            }
            if (facePick && hitBody) pickFaceInto(c, hitBody.body, hitBody.index);
        });
        return;
    }
    // No handle under the press (`handleUnderPress` had its chance): a curve under it, or a body's face, selects it (with
    // ctrl, toggles it), as in Perspective; empty space clears the selection -- unless
    // a curve is being edited (its point is dropped instead, below).
    if (!axisMode) selectAt(i, px, e, !(c && isCurve(c)));
    if (!c) return;
    // Empty space deselects the point; the curve stays selected.
    if (pointed(c)) selectPoint(null);
}
overlay.addEventListener("pointerleave", () => { setHover(null); hoverSpot = null; hoverConstraintAt(null); if (hoverCurve) { hoverCurve = null; schedule(); } });
overlay.addEventListener("pointermove", (e) => {
    if (lastReport === null) return;
    overlayDirty();   // what the page alone draws (a cursor, a snap, a hover) rides no frame of the View's
    if (router !== null && router.move(e)) return;   // the view's drag
    if (!drag && drawing?.id !== null && drawing) {
        // The curve being drawn follows the pointer in its view; snapped as a click would be.
        const c = byId(drawing.id);
        const px = [e.offsetX, e.offsetY], i = viewportAt(px);
        if (c && i === viewOf(c.plane)) {
            let w = pxToSketch(c.plane, local(px, i), sizeOf(i));
            const target = snapPoint(w, c.plane, pendingSpot());
            snapped = target ? { plane: c.plane, at: target } : null;
            if (target) w = target;
            drawMove(w);
        }
        return;
    }
    if (!drag) {
        // The cube face under the pointer lights up.
        const was = viewCubeHover;
        viewCubeHover = viewportAt([e.offsetX, e.offsetY]) === 1 ? viewCubeFaceAt([e.offsetX, e.offsetY])?.label ?? null : null;
        if (was !== viewCubeHover) schedule();
        // So does the face, piece or edge a pick would take, and the curve.
        if (pickingFaces()) { const px = [e.offsetX, e.offsetY], i = viewportAt(px); if (i >= 0) hoverAt(i, px); else setHover(null); }
        if (sketchTrim) {
            const px = [e.offsetX, e.offsetY], i = viewportAt(px);
            const h = i >= 0 ? pieceUnder(i, px) : null;
            if ((h?.id ?? null) !== (sketchTrim.hover?.id ?? null) || (h?.k ?? null) !== (sketchTrim.hover?.k ?? null)) { sketchTrim.hover = h; schedule(); }
        }
        if (sketchPick?.spots) {
            // A constraint tool: the curve its click would take lights up, and the point.
            const px = [e.offsetX, e.offsetY], i = viewportAt(px);
            const types = CONSTRAINT_TOOLS[sketchPick.kind].next(sketchPick.spots) ?? [];
            const h = i >= 0 ? spotAt(i, px, types, sketchPick.sketch) : null;
            const spot = h?.type === "point" ? { curve: h.c.id, at: h.at } : null;
            if ((h?.c ?? null) !== hoverCurve || JSON.stringify(spot) !== JSON.stringify(hoverSpot)) { hoverCurve = h?.c ?? null; hoverSpot = spot; schedule(); }
        } else if (sketchPick) {
            const px = [e.offsetX, e.offsetY], i = viewportAt(px);
            const h = i >= 0 ? pickCurve(i, px) : null;
            if (h !== hoverCurve) { hoverCurve = h; schedule(); }
        }
        // A mark or a label under the pointer -- none while something armed takes it.
        if (constraintHoverable() || hoverConstraint) hoverConstraintAt([e.offsetX, e.offsetY]);
        return;
    }
    const px = [e.offsetX, e.offsetY];
    if (drag.kind === "handle" && drag.handle.gizmo) {
        if (!drag.moved && Math.hypot(px[0] - drag.from[0], px[1] - drag.from[1]) > 3) drag.moved = true;
        if (drag.moved) moveManipulator(drag.handle, local(px, drag.view), sizeOf(drag.view));
    } else if (drag.kind === "handle") {
        const plane = drag.curve ? drag.curve.plane : axisMode ? axisMode.plane : viewPlane[drag.view];
        // A curve on a sketch: what the drag starts from (and the sketch migrated, if it
        // was saved before constraints), for `endDrag`'s one edit.
        if (!("held" in drag)) { const sketch = sketchOf(drag.curve); drag.held = sketch ? constrainedStart(sketch) : null; }
        moveHandle(drag.curve, drag.handle, pxToSketch(plane, local(px, drag.view), sizeOf(drag.view)));
    } else if (drag.kind === "cube") {
        if (drag.cube && Math.hypot(px[0] - drag.last[0], px[1] - drag.last[1]) > 3) drag.cube = null;   // a drag, not a click on a face
        if (!drag.cube) { const r = drawRatio(); viewerCall(() => viewer.orbit((px[0] - drag.last[0]) * r, (px[1] - drag.last[1]) * r, 1)); drag.last = px; }
    }
});
// The view cube (view-cube.js): a cube in the world's axes
// seen as the Perspective camera sees it, drawn at the bottom right of that view with its
// faces named; a face clicked aims the camera square at it (about what an orbit turns about),
// a drag on it orbits. `viewCube` keeps where it was drawn and its faces' screen polygons for
// the hit test.
let viewCube = null;
function drawViewCube([x, y, w, h]) {
    viewCube = null;
    if (w < 160 || h < 160) return;
    // The panes can change (a view maximized, the grid back) before a frame reports the
    // camera of the pane now shown: no cube until it does.
    const cam = camOf(1);
    if (!cam) return;
    const cx = x + w - 52, cy = y + h - 52;
    const faces = cubeFaces(cam.forward(), [cx, cy], 22);
    ctx.save();
    ctx.lineJoin = "round";
    for (const face of faces) {
        ctx.beginPath();
        face.corners.forEach((p, k) => k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        ctx.closePath();
        const hover = viewCubeHover === face.label;
        ctx.fillStyle = hover ? "rgba(55, 138, 221, .6)" : `rgba(130, 128, 122, ${0.25 + 0.4 * face.facing})`;
        ctx.fill();
        ctx.strokeStyle = "#F1EFE8"; ctx.lineWidth = 1;
        ctx.stroke();
        if (face.facing > 0.3) {
            const c = face.corners.reduce((m, p) => [m[0] + p[0] / 4, m[1] + p[1] / 4], [0, 0]);
            ctx.fillStyle = hover ? "#1C1B1A" : "#F1EFE8";
            ctx.font = `${Math.round(6 + 4 * face.facing)}px system-ui, sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(face.label, c[0], c[1]);
        }
    }
    ctx.restore();
    viewCube = { faces, box: [cx - 40, cy - 40, 80, 80] };
}
let viewCubeHover = null;
// The cube face under `px`, or null.
const viewCubeFaceAt = (px) => (viewCube ? cubeFaceAt(viewCube.faces, px) : null);
const onViewCube = (px) => viewCube !== null && px[0] >= viewCube.box[0] && px[0] < viewCube.box[0] + viewCube.box[2] && px[1] >= viewCube.box[1] && px[1] < viewCube.box[1] + viewCube.box[3];
// The point an orbit turns about: the middle of the selected items' bounds, or of
// everything shown when nothing is selected (or the selection has nothing built).
let sceneCentre = [0, 0, 0];
function orbitCentre() {
    const picked = selectedCurves().filter((c) => c.bounds !== null && visible(c));
    if (!picked.length) return sceneCentre;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { bounds: b } of picked) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.centre[k] - b.radius); hi[k] = Math.max(hi[k], b.centre[k] + b.radius); }
    return lo.map((v, k) => (v + hi[k]) / 2);
}
// The curve under `px` in view `i`, or null: every shown curve's Béziers sampled and
// projected by the view's camera, the nearest within a few pixels -- so a curve is
// selected by a click in any view, Perspective included, as a body is by its face.
const PICK_PX = 6;
// The sketch's modify tools -- close, fillet, merge, explode, surface -- work on the
// selection: a button is enabled while the selection holds something its tool takes
// (`syncModifyButtons`), and pressing it runs the tool on what is selected when that
// is enough (one curve for close and explode, two lines meeting at a corner or one
// shape for fillet, closed curves or a loop for surface). Where it is not -- merge's
// second curve, more curves for a surface -- the press arms a pick: the rest are
// clicked in the views (or on the list), the pick shows in the dialog, and the tool
// runs when the pick is complete or on OK. The pick is the selection meanwhile, so the
// picked curves wear the accent. Esc, or the button again, puts the tool down. The
// solid tools (extrude, revolve, sweep) pick the same way, from nothing.
let sketchPick = null;   // { kind, was: the selection before }
let hoverCurve = null;  // the curve under the pointer while a pick is armed
const SKETCH_PICKS = {
    close: { title: "Close", glyph: "closed", hint: "click a polyline, spline or polycurve to close it -- or to open one that is closed · Esc cancels", noun: "curve", many: false },
    explode: { title: "Explode", glyph: "explode", hint: "click a polycurve to break it into its pieces · Esc cancels", noun: "polycurve", many: false },
    fillet: { title: "Fillet", glyph: "round", hint: "click two lines meeting at a corner, or a rectangle, polygon, polyline or polycurve to round its corners · the radius is in the dialog · Esc cancels", noun: "curve", many: false },
    merge: { title: "Merge", glyph: "merge", hint: "click the curves to join end to end, in any order · click one again to leave it out · OK or Enter merges · Esc cancels", noun: "curve", many: true },
    surface: { title: "Surface", glyph: "surface", hint: "click closed curves, or curves that close a loop together, to make a surface of them · OK or Enter · Esc cancels", noun: "curve", many: true },
    // The solid tools: their profile picked the same way -- a curve (to a sheet), a
    // surface (to a solid), for extrude a face of a solid too (raised, to join to it or
    // cut from it) -- and the tool goes on as it did from a selection: extrude's
    // distance and taper in the dialog, revolve's axis to place, sweep's path to click.
    extrusion: { title: "Extrude", glyph: "solid", hint: "click a curve, a surface or a face of a solid or a sheet to extrude · shift-click faces of a solid to push several · Esc cancels", noun: "profile", many: false, faces: true },
    remove: { title: "Remove", glyph: "fillet", hint: "click a fillet's or a chamfer's face to take it off -- its edges sharp again · Esc cancels", noun: "face", many: false },
    revolution: { title: "Revolve", glyph: "revolution", hint: "click the curve or surface to revolve · Esc cancels", noun: "profile", many: false },
    sweep: { title: "Sweep", glyph: "sweep", hint: "click the curve or surface to sweep · then the path · Esc cancels", noun: "profile", many: false },
    // A pipe's path, picked as a sweep's profile is; a split's cutter, see `armSplit`.
    pipe: { title: "Pipe", glyph: "pipe", hint: "click the curve the pipe runs along · its radius and wall in the dialog · Esc cancels", noun: "path", many: false },
    // The Solid tab's tools that pick bodies (`bodies`: a body clicked in a view is taken
    // whole, and the list's bodies count): join's solids; cut's and intersect's tool, the
    // solid selected when the tool was pressed held as the target (`fixed`); trim's sheet
    // or tool, whichever was not selected; loft's two profiles, in the order clicked.
    join: { title: "Join", glyph: "join", hint: "click the solids to join, in the views or the list · OK or Enter joins · Esc cancels", noun: "solid", many: true, bodies: true },
    cut: { title: "Cut", glyph: "cut", hint: (f) => `click what to cut out of ${f?.name ?? "the solid"}: a solid, or a surface (extruded by the distance) · Esc cancels`, noun: "tool", many: false, bodies: true },
    intersect: { title: "Intersect", glyph: "intersect", hint: (f) => `click what to intersect ${f?.name ?? "the solid"} with: a solid, or a surface (extruded by the distance) · Esc cancels`, noun: "tool", many: false, bodies: true },
    trim: { title: "Trim", glyph: "trim", hint: (f) => isSheet(f) ? `click what trims ${f.name}: a solid or a curve · Esc cancels` : `click the sheet ${f?.name ?? "the tool"} trims · Esc cancels`, noun: "sheet or tool", many: false, bodies: true },
    thicken: { title: "Thicken", glyph: "thicken", hint: "click the sheet to thicken -- a surface, a curve's extrusion, a face or a trim · its thickness in the dialog (negative for the other side) · Esc cancels", noun: "sheet", many: false, bodies: true },
    loft: { title: "Loft", glyph: "loft", hint: "click the profiles to loft through, in order -- surfaces (a solid) or curves (a sheet), each on its own plane; two rule straight, more run smooth through them all · OK or Enter lofts · Esc cancels", noun: "profile", many: true, bodies: true },
    split: { title: "Split", glyph: "split", hint: "click a face to split along its whole plane (a curved face: its body), a closed curve to split by it pushed straight through, or a body or a sketch in the list -- or Top, Front, Right below · Esc cancels", noun: "tool", many: false, faces: true },
};
// Whether `k` can join the pick `ids` of the tool `kind`.
function pickAccepts(kind, ids, k) {
    if (!k || isSketch(k)) return false;
    if (!isCurve(k) && kind !== "extrusion" && kind !== "sweep" && kind !== "revolution" && !SKETCH_PICKS[kind]?.bodies) return false;
    const picked = ids.map(byId).filter((c) => c);
    switch (kind) {
        case "close": return pointed(k) || k.kind === "polycurve";
        case "explode": return k.kind === "polycurve";
        case "fillet": return drawn(k) && (k.kind === "line" ? picked.every((c) => c.kind === "line" && c.plane === k.plane) && picked.length < 2 : filletable([k]) && picked.length === 0);
        case "merge": return k.sketch.length > 0 && !closedByKind(k) && picked.every((c) => c.plane === k.plane);
        case "surface": return isClosed(k);
        case "extrusion": return drawn(k) || k.kind === "surface" || k.kind === "trim" || k.kind === "face";
        case "revolution": return (isCurve(k) && k.sketch.length > 0) || k.kind === "surface";
        case "sweep": return sweepProfile(k);
        case "pipe": return drawn(k);
        case "join": return isSolid(k);
        case "thicken": return isSheet(k);
        case "cut": case "intersect": return (isSolid(k) || k.kind === "surface") && k.id !== sketchPick?.fixed;
        case "trim": {
            const f = byId(sketchPick?.fixed);
            if (!f || k.id === f.id) return false;
            return isSheet(f) ? isTool(k) : isSheet(k);
        }
        case "loft": {
            const profile = (c) => drawn(c) || c.kind === "surface";
            if (!profile(k)) return false;
            if (!picked.length) return true;
            // Each like the first: surfaces, or curves.
            return !picked.some((c) => c.id === k.id) && (picked[0].kind === "surface") === (k.kind === "surface");
        }
        default: return false;
    }
}
// `arming`: the tool was just pressed over what was selected already. A tool that
// takes as many curves as wanted (surface, merge, join) runs at once then, when the
// selection is enough for it -- pressing the button over a closed curve is the
// surface, no OK to click -- and waits for OK only while its curves are being
// clicked one by one.
function pickComplete(kind, ids, arming = false) {
    const picked = ids.map(byId).filter((c) => c);
    if (kind === "cut" || kind === "intersect" || kind === "trim" || kind === "thicken") return picked.filter((c) => pickAccepts(kind, [], c)).length >= 1;
    if (arming && kind === "surface") return loopsOfSelection().length > 0;
    if (arming && kind === "merge") return picked.filter((c) => pickAccepts(kind, [], c)).length >= 2;
    if (arming && kind === "join") return picked.filter(isSolid).length >= 2;

    return kind === "close" || kind === "explode" || kind === "extrusion" || kind === "revolution" || kind === "sweep" || kind === "pipe" ? picked.length >= 1 : kind === "fillet" ? filletable(picked) : false;
}
// `fixed`: an item the tool already has and keeps -- the solid a cut is made in, the
// sheet or tool a trim started from -- shown selected beside the pick, never picked.
function armSketchPick(kind, fixed = null) {
    if (sketchPick?.kind === kind) { pressedAgain(pickReady(kind)); return; }
    if (sketchPick) disarmSketchPick();
    if (curves.some((c) => c.dirty)) rebuild();
    const was = selection.slice();
    sketchPick = { kind, was, fixed };
    // What is selected already counts, as far as the tool takes it.
    const ids = [];
    for (const c of selectedCurves()) if (pickAccepts(kind, ids, c)) ids.push(c.id);
    setHover(null);
    keepView = true;
    try { setSelection(fixed !== null ? [fixed, ...ids] : ids); } finally { keepView = false; }
    const hint = SKETCH_PICKS[kind].hint;
    hintEl.textContent = typeof hint === "function" ? hint(byId(fixed)) : hint;
    overlay.style.cursor = "crosshair";
    syncToolbar();
    renderDialog();
    if (pickComplete(kind, selection, true)) runSketchPick();
}
// Whether the pick in progress has what its tool needs to make something: the tools of
// one pick make it as it is clicked, so only those of several are ever ready here.
function pickReady(kind) {
    const picked = selectedCurves().filter((c) => pickAccepts(kind, [], c));
    if (kind === "join" || kind === "loft" || kind === "merge") return picked.length >= 2;
    if (kind === "surface") return loopsOfSelection().length > 0;
    return false;
}
// A tool's button pressed again while the tool is working: its OK where it has what it
// needs to make something, its Cancel where not -- one rule for every tool's button
// (a fillet with no edge picked left an empty fillet behind).
function pressedAgain(ready) {
    if (ready) confirmPicks();
    else cancelPicks();
}
function disarmSketchPick(restore = false) {
    if (!sketchPick) return;
    const { was, faceAt } = sketchPick;
    const taken = sketchPick.faces?.length > 0;
    sketchPick = null;
    hoverCurve = null;
    hoverSpot = null;
    const finish = () => {
        overlay.style.cursor = drawing || picking === "face" ? "crosshair" : "default";
        if (restore) { keepView = true; try { setSelection(was.filter((id) => byId(id))); } finally { keepView = false; } }
        hintEl.textContent = hintFor(current()?.kind);
        syncToolbar();
        renderDialog();
        schedule();
    };
    // Faces shift-clicked and the pick cancelled: the faces taken go with it.
    if (restore && taken && faceAt != null) return rollbackTo(faceAt).then(finish);
    finish();
}
// A curve clicked while a pick is armed: added (a second click takes it out again),
// or, for a tool of one, put in the place of what was there.
function pickCurveInto(k) {
    if (!sketchPick) return;
    const { kind } = sketchPick;
    const { many } = SKETCH_PICKS[kind];
    let ids = selection.filter((id) => pickAccepts(kind, [], byId(id)));
    if (ids.includes(k.id)) ids = ids.filter((id) => id !== k.id);
    else if (!many && kind !== "fillet") ids = pickAccepts(kind, [], k) ? [k.id] : ids;
    else if (pickAccepts(kind, ids, k)) ids = [...ids, k.id];
    else { say(kind === "fillet" ? `fillet takes two lines meeting at a corner, or one rectangle, polygon, polyline or polycurve -- not ${k.name}` : kind === "merge" ? `${k.name} cannot be merged: it must be drawn, open, and on the same plane` : kind === "surface" ? `${k.name} is not closed` : kind === "extrusion" ? `extrude takes a curve, a surface or a face of a body, not ${k.name}` : `${SKETCH_PICKS[kind].title.toLowerCase()} takes a ${SKETCH_PICKS[kind].noun}, not ${k.name}`, true); return; }
    const fixed = sketchPick.fixed ?? null;
    keepView = true;
    try { setSelection(fixed !== null ? [fixed, ...ids] : ids); } finally { keepView = false; }
    renderDialog();
    if (pickComplete(kind, ids)) runSketchPick();
}
// A face of a body clicked while extrude picks: taken as a sheet of its own (a
// `face` command) and extruded from there -- a solid it is on is the operation's
// target, so the dialog offers join and cut; a face of a sheet (a curve's extrusion,
// say) raises a new solid of its own.
// Shift held (`adding`), the face is taken and the pick stays armed for more: the faces
// of one solid are pushed together when the last is clicked without shift, or on Enter.
function pickSolidFace(body, index, adding = false) {
    return act(async () => {
        if (!sketchPick || !SKETCH_PICKS[sketchPick.kind].faces) return;
        if (!isBody(body)) { say(`extrude takes a face of a body, not ${body.name}`, true); return; }
        await whenBuilt([body.id]);
        if (!sketchPick) return;
        if (body.error !== null || !body.gpu) { say(`${body.name} has not been built`, true); return; }
        const curved = body.gpu.faceKinds[index] !== 0;
        // A curved face is pressed (`push_pull_solid`), which grows the solid it is on; a
        // sheet has nothing to grow, and pressing its wall only moves the wall -- an open
        // band, not a solid. Thickening a curved sheet is not in the kernel yet.
        if (curved && !isSolid(body)) { say(`a curved face of a sheet cannot be extruded -- ${body.name}'s flat faces can, or thicken ${body.name} into a solid`, true); return; }
        const id = nextId;
        bump(id);
        sketchPick.faceAt ??= headNow();   // the extrude's session opens before the faces, which a cancel undoes with it
        const faceRefs = await refsOf(body.id, "faces", [index]);
        await run({ op: "face", id, from: body.id, face: index, ...(curved ? { curved: true } : {}), ...(faceRefs ? { faceRefs } : {}) });
        if (!sketchPick) return;
        sketchPick.faces = [...(sketchPick.faces ?? []), id];
        keepView = true;
        try { setSelection(sketchPick.faces); } finally { keepView = false; }
        renderDialog();
        if (adding) { hintEl.textContent = `${sketchPick.faces.length} face${sketchPick.faces.length === 1 ? "" : "s"} taken · shift-click more · click the last without shift, or Enter, to extrude · Esc cancels`; return; }
        await runSketchPick();
    });
}
// A face clicked while remove is armed: the round or the chamfer it belongs to taken off,
// as a `face` item and a `remove` over it, the edges sharp again.
function removeAtFace(body, index) {
    return act(async () => {
        const round = body.gpu?.rounds?.[index] ?? 0, bevel = body.gpu?.chamfers?.[index] ?? 0;
        if (!isSolid(body) || (round <= 0 && bevel <= 0)) { say("remove takes a fillet's or a chamfer's face -- click one of its rounds or bevels", true); return; }
        const faceId = nextId;
        bump(faceId);
        const faceRefs = await refsOf(body.id, "faces", [index]);
        await run({ op: "face", id: faceId, from: body.id, face: index, ...(body.gpu.faceKinds[index] !== 0 ? { curved: true } : {}), ...(faceRefs ? { faceRefs } : {}) });
        const id = nextId;
        await run({ op: "remove", id, from: faceId, what: round > 0 ? "round" : "chamfer" });
        disarmSketchPick();
        select(id);
    });
}
// The tool run on its pick, and put down.
function runSketchPick() {
    if (!sketchPick) return;
    const { kind } = sketchPick;
    if (sketchPick.spots) {
        const next = CONSTRAINT_TOOLS[kind].next(sketchPick.spots);
        if (next && !CONSTRAINT_TOOLS[kind].ready?.(sketchPick.spots)) say(`${kind} takes ${needText(next)} next -- click it in a view`, true); else runConstraintTool();
        return;
    }
    const picked = selectedCurves().filter((c) => pickAccepts(kind, [], c));
    switch (kind) {
        case "close": if (picked.length === 1) toggleClosed(picked[0]); break;
        case "explode": if (picked.length === 1) explodeCurve(picked[0]); break;
        case "fillet": newFillet("round"); break;
        case "merge": if (picked.length < 2) { say("merge takes two or more curves -- click them in the views or the list", true); return; } mergeCurves(); break;
        case "surface": if (loopsOfSelection().length === 0) { say("surface takes a closed curve, or curves closing a loop -- click them in the views or the list", true); return; } newBody("surface"); break;
        case "extrusion": { if (!extrudable()) { say("extrude takes a curve, a surface or a face of a body -- click one in the views or the list", true); return; } const { faceAt } = sketchPick; sketchPick = null; newBody("extrusion", faceAt ?? null); break; }
        case "revolution": if (!revolvable()) { say("revolve takes a curve or a surface -- click one in the views or the list", true); return; } sketchPick = null; armRevolve(); break;
        case "sweep": if (!selectedCurves().some(sweepProfile)) { say("sweep takes a curve or a surface -- click one in the views or the list", true); return; } sketchPick = null; newSweep(); break;
        case "pipe": if (picked.length !== 1) { say("pipe takes a curve to run along -- click one in the views or the list", true); return; } sketchPick = null; newPipe(picked[0]); break;
        case "split": say("split takes a tool: click a face, or a body or a sketch in the list, or Top, Front or Right in the dialog", true); return;
        case "thicken": if (picked.length !== 1) { say("thicken takes a sheet -- click one in the views or the list", true); return; } sketchPick = null; newThicken(picked[0]); break;
        case "join": if (picked.length < 2) { say("join takes two or more solids -- click them in the views or the list", true); return; } sketchPick = null; newJoin(); break;
        case "cut": case "intersect": {
            const target = byId(sketchPick.fixed);
            if (!target || picked.length !== 1) { say(`${kind} takes a tool -- click a solid or a surface in the views or the list`, true); return; }
            sketchPick = null;
            newCombineOf(kind, target, picked[0]);
            break;
        }
        case "trim": {
            const f = byId(sketchPick.fixed);
            if (!f || picked.length !== 1) { say("trim takes a sheet and what trims it -- click the other in the views or the list", true); return; }
            sketchPick = null;
            const [sheet, tool] = isSheet(f) ? [f, picked[0]] : [picked[0], f];
            newTrimOf(sheet, tool);
            break;
        }
        case "loft": {
            // In the order clicked: the first is where the loft starts.
            const ordered = selection.map(byId).filter((c) => c && pickAccepts(kind, [], c));
            if (ordered.length < 2) { say("loft takes two profiles or more -- surfaces or curves", true); return; }
            sketchPick = null;
            newLoftOf(ordered[0], ordered[ordered.length - 1], ordered.slice(1, -1));
            break;
        }
        default: break;
    }
    sketchPick = null;
    hoverCurve = null;
    // A tool that goes on picking (a sweep's path, a revolve's axis) keeps its cursor
    // and its hint.
    if (!sweepMode && !axisMode && !trimMode) {
        overlay.style.cursor = drawing || picking === "face" ? "crosshair" : "default";
        hintEl.textContent = hintFor(current()?.kind);
    }
    syncToolbar();
    renderDialog();
    schedule();
}

// The constraint tools, the ribbon's "constrain" group. A tool picks spots of ONE sketch's
// curves -- a point (an end, a corner, a vertex, a centre) within `SNAP_PX`, else the
// curve under the pointer (a line or one side of a rectangle, polygon or polyline, an arc,
// a circle, a spline) -- in any view, every shown curve of the sketch taken, selected or
// not. Each tool says what its next pick may be (`next`, null once it has them all: the
// types "point", "line", "round" for an arc or a circle, "curve" for a spline) and makes
// one stored constraint of its picks (`make`), added to the sketch's session as soon as
// they are complete: the constraint and every curve the solve moved are one `edit`; one
// the session refuses changes nothing and says what it fights. Only a sketch's curves
// carry constraints. The pick rides on `sketchPick` (`spots`, the picks so far; `sketch`,
// theirs) as the modify tools' do: the curves picked wear the accent, Esc or the button
// again puts the tool down, and what was selected when it was pressed counts as its first
// picks, as far as whole curves go.
const TWO = (p) => p.length < 2;
const CONSTRAINT_TOOLS = {
    coincident: {
        title: "Coincident", hint: "click two points to join them -- or a point and a line, an arc or a circle to hold the point on it",
        next: (p) => p.length === 0 ? ["point", "line", "round"] : p.length === 1 ? (p[0].type === "point" ? ["point", "line", "round"] : ["point"]) : null,
        make: (p) => {
            const [point, other] = p[0].type === "point" ? p : [p[1], p[0]];
            return { kind: other.type === "point" ? "coincident" : other.type === "line" ? "point_on_line" : "point_on_circle", refs: [point.spot, other.spot] };
        },
    },
    horizontal: {
        title: "Horizontal", hint: "click a line to level it -- or two points to put at one height",
        next: (p) => p.length === 0 ? ["line", "point"] : p[0].type === "line" || p.length === 2 ? null : ["point"],
        make: (p) => ({ kind: "horizontal", refs: p[0].type === "line" ? lineEnds(p[0].spot) : [p[0].spot, p[1].spot] }),
    },
    vertical: {
        title: "Vertical", hint: "click a line to stand it upright -- or two points to put one above the other",
        next: (p) => p.length === 0 ? ["line", "point"] : p[0].type === "line" || p.length === 2 ? null : ["point"],
        make: (p) => ({ kind: "vertical", refs: p[0].type === "line" ? lineEnds(p[0].spot) : [p[0].spot, p[1].spot] }),
    },
    parallel: { title: "Parallel", hint: "click two lines to hold parallel", next: (p) => TWO(p) ? ["line"] : null, make: (p) => ({ kind: "parallel", refs: [p[0].spot, p[1].spot] }) },
    perpendicular: { title: "Perpendicular", hint: "click two lines to hold square to each other", next: (p) => TWO(p) ? ["line"] : null, make: (p) => ({ kind: "perpendicular", refs: [p[0].spot, p[1].spot] }) },
    tangent: {
        title: "Tangent", hint: "click a line and an arc or a circle -- or two arcs or circles -- to hold tangent",
        next: (p) => p.length === 0 ? ["line", "round"] : p.length === 1 ? (p[0].type === "line" ? ["round"] : ["line", "round"]) : null,
        make: (p) => ({ kind: "tangent", refs: (p[1].type === "line" ? [p[1], p[0]] : p).map((q) => q.spot) }),
    },
    concentric: { title: "Concentric", hint: "click two arcs or circles to give one centre", next: (p) => TWO(p) ? ["round"] : null, make: (p) => ({ kind: "concentric", refs: [p[0].spot, p[1].spot] }) },
    equal: {
        title: "Equal", hint: "click two lines to hold at one length -- or two arcs or circles at one radius",
        next: (p) => p.length === 0 ? ["line", "round"] : p.length === 1 ? [p[0].type] : null,
        make: (p) => ({ kind: p[0].type === "line" ? "equal_length" : "equal_radius", refs: [p[0].spot, p[1].spot] }),
    },
    midpoint: {
        title: "Midpoint", hint: "click a point and a line to hold the point at the line's middle",
        next: (p) => p.length === 0 ? ["point", "line"] : p.length === 1 ? [p[0].type === "point" ? "line" : "point"] : null,
        make: (p) => ({ kind: "midpoint", refs: (p[0].type === "point" ? p : [p[1], p[0]]).map((q) => q.spot) }),
    },
    symmetric: {
        title: "Symmetric", hint: "click two points, then the line to mirror them about",
        next: (p) => p.length < 2 ? ["point"] : p.length === 2 ? ["line"] : null,
        make: (p) => ({ kind: "symmetric", refs: p.map((q) => q.spot) }),
    },
    fix: { title: "Fix", hint: "click a point or a curve to hold where it is", next: (p) => p.length === 0 ? ["point", "line", "round", "curve"] : null, make: (p) => ({ kind: "fix", refs: [p[0].spot] }) },
    // One smart tool for every dimension, its kind decided by the picks: a line
    // alone is its length and an arc or a circle alone its radius (shift: diameter), each
    // made by Enter or OK since a second pick may follow (`ready`); two points their
    // distance (shift: across or up, whichever is the larger); a point and a line the
    // point's distance from it; two lines their angle, or their distance apart when they
    // are parallel; an arc or a circle and a line, or two of them, rim to line or to rim.
    dimension: {
        title: "Dimension", hint: "click a line or a circle and press Enter -- or two points, a point and a line, two lines, a circle and a line, or two circles · shift: across or up, or a diameter",
        next: (p) => p.length === 0 ? ["point", "line", "round"] : p.length === 1 ? { point: ["point", "line"], line: ["point", "line", "round"], round: ["line", "round"] }[p[0].type] : null,
        ready: (p) => p.length === 1 && (p[0].type === "line" || p[0].type === "round"),

        done: (p) => p[0].type === "line" ? "Enter makes its length" : "Enter makes its radius (shift+Enter: its diameter)",
        make: (p, shift) => dimensionOf(p, shift),
    },
};
for (const [kind, t] of Object.entries(CONSTRAINT_TOOLS)) {
    SKETCH_PICKS[kind] = { title: t.title, glyph: `c-${kind}`, hint: t.hint, noun: "pick", many: true, spots: true };
    ICONS.add(`c-${kind}`);
}
const constrainEls = [...document.querySelectorAll("#ribbon-sketch [data-constrain]")];
for (const b of constrainEls) b.addEventListener("click", () => armConstraint(b.dataset.constrain));
let hoverSpot = null;   // { plane, at } -- the point a constraint tool's click would take
const PICK_TYPES = { point: "a point (an end, a corner, a vertex or a centre)", line: "a line", round: "an arc or a circle", curve: "a spline" };
const needText = (types) => types.map((t) => PICK_TYPES[t]).join(" or ");
// The point spots of curve `c` (`{ at, p }`, `p` in its sketch's units): what a constraint
// tool's click takes within `SNAP_PX`. An open polyline's or spline's first and last
// points are its start and end, as drawing names them.
function pointSpotsOf(c) {
    const s = c.shape, out = [];
    const add = (at, p) => { if (p) out.push({ at, p }); };
    switch (c.kind) {
    case "line": add("start", [s.x0, s.y0]); add("end", [s.x1, s.y1]); break;
    case "arc": add("start", [s.x0, s.y0]); add("end", [s.x1, s.y1]); add("centre", circumcentreOf([s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1])); break;
    case "circle": case "ellipse": add("centre", [s.cx, s.cy]); break;
    case "rect": handlesOf(c).forEach((p, i) => add(`corner:${i}`, p)); break;
    case "polygon": add("centre", [s.cx, s.cy]); polygonPoints(s).forEach((p, i) => add(`vertex:${i}`, p)); break;
    case "polyline": case "nurbs": {
        const n = s.points.length;
        s.points.forEach((p, i) => add(!s.closed && i === 0 ? "start" : !s.closed && i === n - 1 ? "end" : `vertex:${i}`, p));
        break;
    }
    case "polycurve": if (!s.closed && s.ends) { add("start", s.ends[0]); add("end", s.ends[1]); } break;
    default: break;
    }
    return out;
}
// What a whole curve is as a pick: a line, a round (an arc, a circle), an open spline;
// null for the others, whose sides or points are picked instead.
const wholeType = (c) => c.kind === "line" ? "line" : c.kind === "arc" || c.kind === "circle" ? "round" : c.kind === "nurbs" && !c.shape.closed ? "curve" : null;
// The corners of a rectangle, polygon or polyline, in order, as its sides join them.
const cornersOf = (c) => c.kind === "rect" ? handlesOf(c) : c.kind === "polygon" ? polygonPoints(c.shape) : c.shape.points;
// The curve `c` clicked away from its points: the whole curve, or the side nearest the
// click (`near(a, b)`, the pixel distance to the segment between two sketch points).
function edgeSpotOf(c, near) {
    const type = wholeType(c);
    if (type) return { at: "curve", type };
    if (c.kind !== "rect" && c.kind !== "polygon" && c.kind !== "polyline") return null;
    const v = cornersOf(c), n = v.length, closed = c.kind !== "polyline" || c.shape.closed;
    let best = null, bestD = Infinity;
    for (let k = 0; k < (closed ? n : n - 1); k++) { const d = near(v[k], v[(k + 1) % n]); if (d < bestD) { bestD = d; best = k; } }
    return best === null ? null : { at: `side:${best}`, type: "line" };
}
// A line pick's two end spots: a line's start and end, a side's two corners -- an open
// polyline's first and last points by the names `pointSpotsOf` gives them, so one point
// has one name.
function lineEnds(spot) {
    const c = byId(spot.curve);
    if (spot.at === "curve") return [{ curve: c.id, at: "start" }, { curve: c.id, at: "end" }];
    const k = +spot.at.slice(5), n = cornersOf(c).length, open = c.kind === "polyline" && !c.shape.closed;
    const name = (i) => c.kind === "rect" ? `corner:${i}` : open && i === 0 ? "start" : open && i === n - 1 ? "end" : `vertex:${i}`;
    return [{ curve: c.id, at: name(k) }, { curve: c.id, at: name((k + 1) % n) }];
}
const spotLabel = (c, at) => at === "curve" ? c.name : `${c.name} ${at.replace(/^(\w+):(\d+)$/, (_, w, i) => `${w} ${+i + 1}`)}`;
// The spot under `px` in view `i` that a pick of `types` could take, on the curves of the
// sketch `only` (any shown curve when null): `{ c, at, type }` -- the nearest point within
// `SNAP_PX` where a point is wanted, else the curve within `PICK_PX` (`at` and `type` null
// where it has nothing to take there) -- or null.
function spotAt(i, px, types, only = null) {
    const size = sizeOf(i), p = local(px, i), cam = camOf(i);
    const toPx = (c, q) => cam.worldToPx(embed3(c.plane, q), size);
    const shown = curves.filter((c) => isCurve(c) && visible(c) && (only === null || c.plane === only));
    if (types.includes("point")) {
        let best = null, bestD = SNAP_PX;
        for (const c of shown) for (const { at, p: q } of pointSpotsOf(c)) {
            const a = toPx(c, q);
            const d = a ? Math.hypot(a[0] - p[0], a[1] - p[1]) : Infinity;
            if (d < bestD) { bestD = d; best = { c, at, type: "point" }; }
        }
        if (best) return best;
    }
    let hit = null, hitD = PICK_PX;
    for (const c of shown) {
        if (!c.beziers.length) continue;
        const d = bezierDistance(c.beziers, p, cam, size, hitD);
        if (d < hitD) { hitD = d; hit = c; }
    }
    if (!hit) return null;
    const edge = edgeSpotOf(hit, (a, b) => { const pa = toPx(hit, a), pb = toPx(hit, b); return pa && pb ? segmentDistance(p, pa, pb) : Infinity; });
    return { c: hit, at: edge?.at ?? null, type: edge?.type ?? null };
}
// A constraint tool pressed: armed, what is selected taken as its first picks (whole
// lines, arcs, circles and splines of one sketch), and run at once when that is all it
// needs. Pressed again, it is put down.
function armConstraint(kind) {
    if (sketchPick?.kind === kind) { disarmSketchPick(true); return; }
    // Another constraint tool mid-pick: its half-made picks go, the selection it began
    // from comes back (and counts for this one as it would have).
    if (sketchPick) disarmSketchPick(!!sketchPick.spots);
    if (curves.some((c) => c.dirty)) rebuild();
    const t = CONSTRAINT_TOOLS[kind];
    sketchPick = { kind, was: selection.slice(), fixed: null, spots: [], sketch: null, note: "" };
    const off = [];
    for (const c of selection.map(byId)) {
        if (!isCurve(c)) continue;
        const sketch = sketchOf(c);
        if (!sketch) { off.push(c); continue; }
        const types = t.next(sketchPick.spots), type = wholeType(c);
        if (!types) break;
        if (!type || !types.includes(type) || (sketchPick.sketch !== null && sketch.id !== sketchPick.sketch)) continue;
        sketchPick.spots.push({ spot: { curve: c.id, at: "curve" }, type, label: c.name });
        sketchPick.sketch = sketch.id;
    }
    // Curves on an origin plane or a face hold no constraints: the hint says so.
    if (off.length) sketchPick.note = `${off.map((c) => c.name).join(", ")} ${off.length === 1 ? "is" : "are"} on ${planeInfo(off[0].plane).name}, not on a sketch -- only a sketch's curves take constraints · `;
    setHover(null);
    overlay.style.cursor = "crosshair";
    refreshSpotPick();
    // Done at once when the selection was all it needs -- or, for a dimension, a lone line
    // or circle selected (its length or radius, as Enter would make it).
    const all = sketchPick.spots.length === selection.length;
    if (t.next(sketchPick.spots) === null || (all && t.ready?.(sketchPick.spots))) runConstraintTool();
}
// The pick so far shown: its curves selected, the hint naming what comes next.
function refreshSpotPick() {
    const { kind, spots, note } = sketchPick;
    const next = CONSTRAINT_TOOLS[kind].next(spots);
    keepView = true;
    try { setSelection([...new Set(spots.map((q) => q.spot.curve))]); } finally { keepView = false; }
    const t = CONSTRAINT_TOOLS[kind], done = t.ready?.(spots) ? ` · ${t.done(spots)}` : "";

    hintEl.textContent = `${note}${t.hint}${next && spots.length ? ` · next: ${needText(next)}` : ""}${done} · click a pick again to take it out · Esc cancels`;
    syncToolbar();
    renderDialog();
    schedule();
}
// A click in view `i` while a constraint tool picks.
function pickSpotAt(i, px) {
    const { kind, spots, sketch } = sketchPick;
    const types = CONSTRAINT_TOOLS[kind].next(spots) ?? [];
    // A pick already made is taken out again by a click on it, whatever comes next.
    const hit = spotAt(i, px, [...new Set([...types, ...spots.map((q) => q.type)])], sketch) ?? (sketch !== null ? spotAt(i, px, types) : null);
    if (!hit) { say(`${kind}: nothing to pick there -- click ${needText(types)}`, true); return; }
    takeSpot(hit.c, hit.at, hit.type);
}
// A whole curve clicked in the list while a constraint tool picks.
function takeWholeCurve(c) {
    const type = wholeType(c);
    if (!type) { say(`${sketchPick.kind}: click ${c.name}'s side or point in a view`, true); return; }
    takeSpot(c, "curve", type);
}
function takeSpot(c, at, type) {
    const { kind, spots } = sketchPick;
    const t = CONSTRAINT_TOOLS[kind];
    const sketch = sketchOf(c);
    if (!sketch) { say(`${kind}: ${c.name} is on ${planeInfo(c.plane).name}, not on a sketch -- only a sketch's curves take constraints`, true); return; }
    if (sketchPick.sketch !== null && sketch.id !== sketchPick.sketch) { say(`${kind}: ${c.name} is on ${sketch.name} -- the picks so far are on ${byId(sketchPick.sketch)?.name ?? "another sketch"}`, true); return; }
    const was = spots.findIndex((q) => q.spot.curve === c.id && q.spot.at === at);
    if (was >= 0) {
        spots.splice(was, 1);
        if (!spots.length) sketchPick.sketch = null;
        refreshSpotPick();
        return;
    }
    const types = t.next(spots) ?? [];
    if (!type || !types.includes(type)) { say(`${kind} takes ${needText(types)} here, not ${at === null ? c.name : spotLabel(c, at)}`, true); return; }
    // A polycurve is reference only: its ends are fixed already.
    if (kind === "fix" && c.kind === "polycurve") { say(`fix: ${spotLabel(c, at)} is already fixed -- a polycurve's ends never move`, true); return; }
    spots.push({ spot: { curve: c.id, at }, type, label: spotLabel(c, at) });
    sketchPick.sketch = sketch.id;
    say(`${kind}: ${spots.map((q) => q.label).join(", ")}`);
    refreshSpotPick();
    if (t.next(spots) === null) runConstraintTool();
}
// What a refused constraint fights, by name ("horizontal 3", "length 5 = 40"). Where the
// kernel names none -- it names no fix, nor a rectangle's or a polygon's own constraints --
// only what is involved is blamed: the `fix` records on the picked curves; a picked
// polycurve's ends (held by fixes of its own); a picked rectangle's or polygon's own
// shape; else the constraints holding the picked curves, unnamed.
function conflictNames(sketch, ids, picks) {
    if (ids.length) return ids.map((id) => constraintName(sketch, id)).join(", ");
    const picked = [...new Set(picks.map((q) => q.spot.curve))].map(byId).filter((c) => c);
    const fixes = (sketch.constraints ?? []).filter((k) => k.kind === "fix" && (k.refs ?? []).some((r) => picked.some((c) => c.id === r.curve)));
    if (fixes.length) return fixes.map((k) => constraintName(sketch, k.id)).join(", ");
    const ends = picks.map((q) => byId(q.spot.curve)).find((c, i) => c?.kind === "polycurve" && (picks[i].spot.at === "start" || picks[i].spot.at === "end"));
    if (ends) return `${ends.name}'s fixed ends`;
    const own = picked.find((c) => c.kind === "rect" || c.kind === "polygon");
    if (own) return `${own.name}'s own shape`;
    return `the constraints holding ${picked.map((c) => c.name).join(", ")}`;
}
// Why the session refused the tool's constraint, without the call's name and the kernel's
// own constraint numbers (the doc's are named instead): an over-constrained one with what
// it fights, one that would not solve with the constraints furthest from holding (as
// `solveFailure` words it), anything else (a spot gone, a wrong kind) as the kernel says.
function refusalText(sketch, got, picks) {
    const raw = String(got.error).replace(/^sketch_\w+: /, "");
    const plain = raw.replace(/: conflicts with \[[^\]]*\]/g, "").replace(/;? worst: \[[^\]]*\]/g, "");
    if (/over-constrained/.test(raw)) return `${plain} — it conflicts with ${conflictNames(sketch, got.with ?? [], picks)}`;
    if (/did not converge/.test(raw)) {
        const names = (got.with ?? []).map((id) => constraintName(sketch, id));
        return `the sketch does not solve${names.length ? ` near ${names.join(", ")}` : ""}`;
    }
    return plain;
}
// The tool's picks made into its constraint, on their sketch: added, solved and written
// back as one `edit` -- or refused, nothing changed and the status line saying why.
function runConstraintTool() {
    const { kind, spots, sketch: sid, shift } = sketchPick;
    const made = CONSTRAINT_TOOLS[kind].make(spots, !!shift);
    disarmSketchPick(true);
    const sketch = byId(sid);
    if (!isSketch(sketch)) return;
    if (sk.DIMENSIONS.has(made.kind)) { addDimension(sketch, made, spots); return; }
    const start = constrainedStart(sketch);   // migrated first: the new id follows its
    const k = { id: sk.nextConstraintId(sketch), ...made };
    let failure = null;
    try {
        const model = modelFor(sketch);
        const got = sk.addConstraint(wasm, model, k);
        if (!got.ok) failure = refusalText(sketch, got, spots);
        else {
            setConstraints(sketch, [...(sketch.constraints ?? []), k]);
            const report = sk.solveModel(wasm, model);
            failure = report.status !== "converged" ? solveFailure(sketch, report) : writeSolved(sketch, model).error;
        }
    } catch (error) {
        failure = String(error?.message ?? error);
    }
    let items = failure ? [] : changedSince(start);
    if (!failure) {
        // Held as solved, but a curve shrunk to a point: refused all the same -- checked
        // before any red record is tried on the shrunk curves.
        const gone = collapsed(start, items.filter((it) => "shape" in it).map((it) => it.id));
        if (gone) failure = collapseText(sketch, gone, k.id);
        else if (settleRefused(sketch)) items = changedSince(start);   // a record the tool's solve lets apply, in its step
    }
    if (failure) { pendingNotice = null; restoreStart(start); refuse(`${kind}: ${failure}`); return; }
    run({ op: "edit", items });
    renderList();
    schedule();
}
// The dimensions: each sketch's stored dimensions drawn in the view that looks at it, as
// the measures draw theirs -- a length, a distance (across or up, from a point to a line,
// between parallel lines, from a circle's rim to a line or to another rim) as a dimension
// line, a radius as a leader, a diameter across, an angle as an arc between its lines --
// with the value it holds, or a driven one's (what it measures now) in parentheses; an
// angle in degrees (stored in radians). A click on a label selects the dimension (the
// dialog then edits its value and makes it driving or driven), a double-click types its
// value over the label.
const DIMENSION_COLOUR = "#E2DFD6", DRIVEN_COLOUR = "#8E8C85";   // not the handles' colour
let dimensionRects = [];   // { sketch, id, rect }: each label drawn, its box in overlay pixels
let selectedDim = null;    // { sketch, id }: the dimension the dialog shows
const P2 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    add: (a, b, t = 1) => [a[0] + b[0] * t, a[1] + b[1] * t],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1],
    cross: (a, b) => a[0] * b[1] - a[1] * b[0],
    dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),
    mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
};
// How far the point `p` lies from the line through `l`, signed: positive to the left of
// its direction (the kernel's `signed_distance`); and the side a sensed dimension holds
// (+1 or -1; an unresolved one the side `s` is on, as the kernel resolves it).
function signedFrom(l, p) {
    const d = P2.sub(l[1], l[0]), n = Math.hypot(...d);
    return n > 0 ? P2.cross(d, P2.sub(p, l[0])) / n : 0;
}
const sideOf = (k, s) => k.sense === "negative" ? -1 : k.sense === "positive" ? 1 : s < 0 ? -1 : 1;
// Where the point `p` falls on the line through `l` (two points).
function footOn(l, p) {
    const d = P2.sub(l[1], l[0]), l2 = P2.dot(d, d);
    return P2.add(l[0], d, l2 > 0 ? P2.dot(P2.sub(p, l[0]), d) / l2 : 0);
}
// A spot's point where the document has it; a line pick's two ends; an arc's or a
// circle's centre `o`, radius `r` and, for an arc, its through-point `at`. Null where the
// curve or the spot is gone.
function spotXY(spot) {
    const c = byId(spot.curve);
    return c && isCurve(c) ? pointSpotsOf(c).find((x) => x.at === spot.at)?.p ?? null : null;
}
function lineXY(spot) {
    const c = byId(spot.curve);
    if (!c || !isCurve(c) || (spot.at === "curve" && c.kind !== "line")) return null;
    const ends = lineEnds(spot).map(spotXY);
    return ends.every(Boolean) ? ends : null;
}
function roundXY(spot) {
    const c = byId(spot.curve), s = c?.shape;
    if (c?.kind === "circle") return { o: [s.cx, s.cy], r: s.r, at: null };
    if (c?.kind !== "arc") return null;
    const o = circumcentreOf([s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]);
    return o ? { o, r: Math.hypot(s.x0 - o[0], s.y0 - o[1]), at: [s.xm, s.ym] } : null;
}
// The dimension tool's picks as a record's kind and refs (see `CONSTRAINT_TOOLS.dimension`).
function dimensionOf(p, shift) {
    const [a, b] = p;
    if (!b) return a.type === "line" ? { kind: "length", refs: [a.spot] } : { kind: shift ? "diameter" : "radius", refs: [a.spot] };
    const of = (type) => p.find((q) => q.type === type);
    if (a.type === b.type && a.type === "point") {
        if (!shift) return { kind: "distance", refs: [a.spot, b.spot] };
        const pa = spotXY(a.spot), pb = spotXY(b.spot);
        const across = !pa || !pb || Math.abs(pb[0] - pa[0]) >= Math.abs(pb[1] - pa[1]);
        return { kind: across ? "horizontal_distance" : "vertical_distance", refs: [a.spot, b.spot] };
    }
    if (a.type === b.type && a.type === "line") {
        const la = lineXY(a.spot), lb = lineXY(b.spot);
        const da = la && P2.sub(la[1], la[0]), db = lb && P2.sub(lb[1], lb[0]);
        const sin = da && db ? Math.abs(P2.cross(da, db)) / (Math.hypot(...da) * Math.hypot(...db)) : NaN;
        return { kind: sin <= 1e-9 ? "line_distance" : "angle", refs: [a.spot, b.spot] };
    }
    if (a.type === b.type) return { kind: "circle_distance", refs: [a.spot, b.spot] };
    if (of("point")) return { kind: "point_line_distance", refs: [of("point").spot, of("line").spot] };
    return { kind: "circle_line_distance", refs: [of("round").spot, of("line").spot] };
}
// What a dimension looks like on its sketch, in sketch units, and what it measures there
// now (`now`, the kernel's sense: an across or up distance from its first point to its
// second, an angle from its first line's direction to its second's), or null where a
// spot it binds is gone.
function dimensionShape(k) {
    const [r0, r1] = k.refs ?? [];
    switch (k.kind) {
    case "length": { const l = r0 && lineXY(r0); return l && { type: "linear", a: l[0], b: l[1], now: P2.dist(l[0], l[1]) }; }
    case "distance": { const a = spotXY(r0), b = spotXY(r1); return a && b && { type: "linear", a, b, now: P2.dist(a, b) }; }
    case "horizontal_distance": {
        const a = spotXY(r0), b = spotXY(r1);
        if (!a || !b) return null;
        const y = Math.max(a[1], b[1]);
        return { type: "linear", a: [a[0], y], b: [b[0], y], away: [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 1], now: b[0] - a[0] };
    }
    case "vertical_distance": {
        const a = spotXY(r0), b = spotXY(r1);
        if (!a || !b) return null;
        const x = Math.max(a[0], b[0]);
        return { type: "linear", a: [x, a[1]], b: [x, b[1]], away: [Math.min(a[0], b[0]) - 1, (a[1] + b[1]) / 2], now: b[1] - a[1] };
    }
    case "point_line_distance": {
        const p = spotXY(r0), l = lineXY(r1);
        if (!p || !l) return null;
        const s = signedFrom(l, p);
        return { type: "linear", a: p, b: footOn(l, p), now: sideOf(k, s) * s };
    }
    case "line_distance": {
        // The kernel's: line B's start from line A.
        const la = lineXY(r0), lb = lineXY(r1);
        if (!la || !lb) return null;
        const s = signedFrom(la, lb[0]);
        return { type: "linear", a: lb[0], b: footOn(la, lb[0]), now: sideOf(k, s) * s };
    }
    case "circle_line_distance": {
        const c = roundXY(r0), l = lineXY(r1);
        if (!c || !l) return null;
        const f = footOn(l, c.o), d = P2.dist(c.o, f), along = P2.sub(l[1], l[0]);
        const u = d > 0 ? [(f[0] - c.o[0]) / d, (f[1] - c.o[1]) / d] : [-along[1] / (Math.hypot(...along) || 1), along[0] / (Math.hypot(...along) || 1)];
        const s = signedFrom(l, c.o);
        return { type: "linear", a: P2.add(c.o, u, c.r), b: f, now: sideOf(k, s) * s - c.r };
    }
    case "circle_distance": {
        const c1 = roundXY(r0), c2 = roundXY(r1);
        if (!c1 || !c2) return null;
        const d = P2.dist(c1.o, c2.o), u = d > 0 ? [(c2.o[0] - c1.o[0]) / d, (c2.o[1] - c1.o[1]) / d] : [1, 0];
        return { type: "linear", a: P2.add(c1.o, u, c1.r), b: P2.add(c2.o, u, -c2.r), now: d - c1.r - c2.r };
    }
    case "radius": case "diameter": {
        const c = roundXY(r0);
        if (!c) return null;
        // Across from where the measures put theirs: a circle's at -45°, an arc's at its middle.
        const toward = c.at ? P2.sub(c.at, c.o) : [1, -1], l = Math.hypot(...toward) || 1;
        return { type: k.kind, o: c.o, u: [toward[0] / l, toward[1] / l], r: c.r, now: k.kind === "radius" ? c.r : 2 * c.r };
    }
    case "angle": {
        const la = lineXY(r0), lb = lineXY(r1);
        if (!la || !lb) return null;
        const da = P2.sub(la[1], la[0]), db = P2.sub(lb[1], lb[0]), den = P2.cross(da, db);
        // Where the two lines (extended) meet; parallel ones at the middle between them.
        const v = Math.abs(den) > 1e-12 ? P2.add(la[0], da, P2.cross(P2.sub(lb[0], la[0]), db) / den) : P2.mid(P2.mid(...la), P2.mid(...lb));
        return { type: "angle", la, lb, v, now: Math.atan2(den, P2.dot(da, db)) };
    }
    default: return null;
    }
}
// A dimension's value as its label shows it: an angle in degrees, a radius with R, a
// diameter with ⌀, a driven one in parentheses (`v` what it measures now).
function dimensionText(k, v) {
    const n = k.kind === "angle" ? `${fmt(v * 180 / Math.PI)}°` : k.kind === "radius" ? `R${fmt(v)}` : k.kind === "diameter" ? `⌀${fmt(v)}` : fmt(v);
    return k.driving === false ? `(${n})` : n;
}
// The value a dimension shows and is typed in: what it holds (a driven one: what it
// measures now), an angle in degrees.
function shownValue(k) {
    const v = k.driving === false ? dimensionShape(k)?.now ?? k.value : k.value;
    return k.kind === "angle" ? v * 180 / Math.PI : v;
}
function drawDimensionShape(g, text, px, colour) {
    if (g.type === "linear") {
        const a = px(g.a), b = px(g.b), away = px(g.away ?? P2.mid(g.a, g.b));
        return measureDimension(a, b, text, away, colour, 34) ?? measureLabel(text, a[0], a[1] - 18, colour);
    }
    if (g.type === "radius") return measureRadius(px(g.o), px(P2.add(g.o, g.u, g.r)), text, colour);
    if (g.type === "diameter") {
        const p = px(P2.add(g.o, g.u, -g.r)), q = px(P2.add(g.o, g.u, g.r)), o = px(g.o);
        ctx.strokeStyle = colour; ctx.fillStyle = colour;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        measureArrow(q[0], q[1], q[0] - p[0], q[1] - p[1]);
        measureArrow(p[0], p[1], p[0] - q[0], p[1] - q[1]);
        return measureLabel(text, o[0], o[1] - 10, colour);
    }
    // An angle: an arc about where the lines meet, from the one to the other the short way,
    // reaching the nearer line's middle (30 px at least), the label past its middle.
    const v = px(g.v), R = Math.max(30, Math.min(P2.dist(v, px(P2.mid(...g.la))), P2.dist(v, px(P2.mid(...g.lb)))));
    const ray = (l) => { const far = P2.dist(l[0], g.v) > P2.dist(l[1], g.v) ? l[0] : l[1], d = P2.sub(px(far), v), n = Math.hypot(...d); return n > 1e-6 ? [d[0] / n, d[1] / n] : null; };
    const ua = ray(g.la), ub = ray(g.lb);
    if (!ua || !ub) return measureLabel(text, v[0], v[1] - 14, colour);
    const a0 = Math.atan2(ua[1], ua[0]);
    let sweep = Math.atan2(ub[1], ub[0]) - a0;
    sweep = ((sweep + 3 * Math.PI) % TAU) - Math.PI;
    ctx.strokeStyle = colour;
    ctx.beginPath(); ctx.arc(v[0], v[1], R, a0, a0 + sweep, sweep < 0); ctx.stroke();
    const half = a0 + sweep / 2;
    return measureLabel(text, v[0] + Math.cos(half) * (R + 16), v[1] + Math.sin(half) * (R + 16), colour);
}
// The sketches' dimensions and glyphs, one pass: every curve looked up through one index
// made for it (`byId`), and whether each is shown asked once (`shownOf`) -- a big sketch's
// hundreds of marks otherwise scan the document per spot. Nothing the two call mutates
// `curves` (they read shapes, planes and cameras, and draw), so the index holds throughout.
function drawConstraintOverlay(rects) {
    overlayIndex = curvesMap(curves); shownNow = new Map();
    try {
        drawDimensions(rects);
        drawGlyphs(rects);
    } finally {
        overlayIndex = null; shownNow = null;
    }
}
function drawDimensions(rects) {
    dimensionRects = [];
    ctx.save();
    ctx.font = MEASURE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const sketch of curves.filter(isSketch)) {
        const dims = (sketch.constraints ?? []).filter((k) => sk.DIMENSIONS.has(k.kind));
        const view = dims.length ? viewOf(sketch.id) : null;
        if (view === null || view === undefined) continue;
        const top = rects[view];
        if (top[2] <= 0 || top[3] <= 0) continue;
        ctx.save();
        ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
        const px = (p) => sketchToPx(sketch.id, p, top);
        const conflicts = conflictsOf(sketch.id), unapplied = notAppliedOf(sketch.id);
        for (const k of dims) {
            if ((k.refs ?? []).some((r) => { const c = byId(r.curve); return !c || !shownOf(c); })) continue;
            const g = dimensionShape(k);
            if (!g) continue;
            const chosen = selectedDim?.sketch === sketch.id && selectedDim.id === k.id;
            const hovered = liveHover()?.sketch === sketch.id && hoverConstraint.id === k.id;
            const colour = chosen ? ACCENT : hovered ? HOVER_EDGE : conflicts.has(k.id) ? CONFLICT_COLOUR : unapplied.has(k.id) ? NOT_APPLIED_COLOUR
                : k.driving === false ? DRIVEN_COLOUR : DIMENSION_COLOUR;
            const rect = drawDimensionShape(g, dimensionText(k, k.driving === false ? g.now : k.value ?? g.now), px, colour);
            if (rect) dimensionRects.push({ sketch: sketch.id, id: k.id, rect });
        }
        ctx.restore();
    }
    ctx.restore();
}
// The dimension label under the overlay pixel `p` (the last drawn on top), or null.
function dimensionAt(p) {
    for (let i = dimensionRects.length - 1; i >= 0; i--) {
        const [x, y, w, h] = dimensionRects[i].rect;
        if (p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h) return dimensionRects[i];
    }
    return null;
}
// The selected dimension's sketch and record, while its sketch is the one selected.
function selectedDimension() {
    if (!selectedDim) return null;
    const sketch = byId(selectedDim.sketch), k = sketch?.constraints?.find((x) => x.id === selectedDim.id);
    if (!k || current() !== sketch) { selectedDim = null; return null; }
    return { sketch, k };
}
function selectDimension(hit) {
    keepView = true;
    try { select(hit.sketch); } finally { keepView = false; }
    selectedDim = { sketch: hit.sketch, id: hit.id };
    syncDeleteButton();
    dofSaid = dofLine();   // the constraint's name stays: the sketch's line is not said over it
    say(constraintStatus(byId(hit.sketch), hit.id));
    renderProps();
    schedule();
}
// The glyphs: each sketch's stored geometric constraints drawn as small marks by the spots
// they bind, in the view that looks at the sketch (its dimensions have their labels) -- a
// coincidence a dot, a horizontal or a vertical a short bar, parallel "//", perpendicular
// "⊥", tangent "T" (at an end: with a dot), concentric two rings, equal "=", a midpoint a
// tick across a bar, symmetric "⇆", a fix a pin, a point on a line or a circle a dot on a
// ring, collinear a long bar with two dots. Marks that meet at one spot stack side by side.
// A rectangle's and a polygon's own constraints are not stored: they have no marks. The
// pointer over a mark (or a dimension's label) lights the constraint's points and curves;
// a click selects it as a label's does; Delete removes the selected one -- one undo step,
// and nothing moves. A constraint the sketch cannot hold (a conflicting one, or one a
// loaded file carries that its session refused) is marked red.
const GLYPH_COLOUR = "#CFCDC5", CONFLICT_COLOUR = "#FF5A5A";
let glyphRects = [];          // { sketch, id, rect }: each mark drawn, its box in overlay pixels
let hoverConstraint = null;   // { sketch, id }: the mark or label under the pointer
// Where a spot is drawn, in sketch units: a point spot's point, a side's middle, a whole
// curve's middle (along its spans). Null where it is gone.
function spotAnchor(spot) {
    const c = byId(spot?.curve);
    if (!c || !isCurve(c)) return null;
    if (spot.at === "curve") return curveMiddle(c);
    if (spot.at.startsWith("side:")) {
        const v = cornersOf(c), n = v.length, i = +spot.at.slice(5);
        return v[i] && v[(i + 1) % n] ? P2.mid(v[i], v[(i + 1) % n]) : null;
    }
    return spotXY(spot);
}
function curveMiddle(c) {
    const b = c.sketch, n = b ? b.length / 16 : 0;
    if (!n) return null;
    const [k, t] = n % 2 ? [(n - 1) / 2, 0.5] : [n / 2, 0];
    const s = 1 - t, w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
    let x = 0, y = 0, d = 0;
    for (let i = 0; i < 4; i++) { const ww = w[i] * b[k * 16 + 4 * i + 3]; x += ww * b[k * 16 + 4 * i]; y += ww * b[k * 16 + 4 * i + 1]; d += ww; }
    return d ? [x / d, y / d] : null;
}
// Where constraint `k`'s marks go (sketch units): one by the point a point-on-something
// holds (or the joint a coincidence makes), the middle of the side two points of one curve
// make level or upright, else one by each spot it binds (a symmetry's two points).
function glyphPlaces(k) {
    const refs = k.refs ?? [];
    switch (k.kind) {
    case "coincident": case "point_on_line": case "point_on_circle": case "midpoint": return [spotAnchor(refs[0])];
    case "horizontal": case "vertical": {
        if (refs.length === 2 && refs[0].curve === refs[1].curve) { const a = spotAnchor(refs[0]), b = spotAnchor(refs[1]); return [a && b && P2.mid(a, b)]; }
        return refs.map(spotAnchor);
    }
    case "symmetric": return refs.slice(0, 2).map(spotAnchor);
    default: return refs.map(spotAnchor);
    }
}
// One mark, centred on the overlay pixel (x, y), on a dark box.
function drawGlyph(kind, x, y, colour) {
    ctx.fillStyle = "rgba(33, 35, 40, 0.85)";
    ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 1.5;
    const line = (a, b, c, d) => { ctx.beginPath(); ctx.moveTo(x + a, y + b); ctx.lineTo(x + c, y + d); ctx.stroke(); };
    const ring = (r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); };
    const dot = (dx, dy, r) => { ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, TAU); ctx.fill(); };
    switch (kind) {
    case "coincident": dot(0, 0, 3); break;
    case "horizontal": ctx.lineWidth = 2; line(-4.5, 0, 4.5, 0); break;
    case "vertical": ctx.lineWidth = 2; line(0, -4.5, 0, 4.5); break;
    case "parallel": line(-4.5, 4.5, -0.5, -4.5); line(0.5, 4.5, 4.5, -4.5); break;
    case "perpendicular": line(-4.5, 4, 4.5, 4); line(0, 4, 0, -4.5); break;
    case "tangent": line(-4.5, -4, 4.5, -4); line(0, -4, 0, 4.5); break;
    case "tangent_at_end": line(-4.5, -4, 4.5, -4); line(0, -4, 0, 2); dot(0, 4.5, 1.5); break;
    case "concentric": ctx.lineWidth = 1.2; ring(2); ring(5); break;
    case "equal_length": case "equal_radius": line(-4.5, -2, 4.5, -2); line(-4.5, 2, 4.5, 2); break;
    case "midpoint": line(-5, 0, 5, 0); line(-1.5, 3.5, 1.5, -3.5); break;
    case "symmetric": line(-5, -2, 5, -2); line(5, -2, 2.5, -4.5); line(-5, 2, 5, 2); line(-5, 2, -2.5, 4.5); break;
    case "fix": dot(0, -2.5, 2.5); line(0, -1, 0, 5.5); break;
    case "point_on_line": case "point_on_circle": ctx.lineWidth = 1.2; ring(4); dot(0, -4, 1.8); break;
    case "collinear": ctx.lineWidth = 1; line(-5.5, 0, 5.5, 0); dot(-3, 0, 1.4); dot(3, 0, 1.4); break;
    default: dot(0, 0, 1.5); break;
    }
}
// The constraint ids a sketch cannot hold, from its last diagnosis.
const conflictsOf = (sketchId) => new Set(diagnoses.get(sketchId)?.conflicting ?? []);
const notAppliedOf = (sketchId) => diagnoses.get(sketchId)?.notApplied ?? new Set();
const NOT_APPLIED_COLOUR = "#76746E";   // a record the session could not take for a reason not a conflict
// A constraint's name with why it is not held, where it is not: "horizontal 3: not
// applied — over-constrained — it conflicts with ...", "fix 4: not applied — unknown ...".
function constraintStatus(sketch, id) {
    const name = constraintName(sketch, id), why = diagnoses.get(sketch.id)?.reasons?.get(id);
    return why ? `${name}: ${why.applied ? "" : "not applied — "}${why.text}` : name;
}
// The hovered constraint, while nothing armed takes the pointer (a tool, a pick, a drawing).
const constraintHoverable = () => !drawing && !sketchPick && !sketchTrim && !shellMode && !trimMode && !filletMode && !axisMode && !facePicking();
const liveHover = () => constraintHoverable() ? hoverConstraint : null;
function drawGlyphs(rects) {
    glyphRects = [];
    ctx.save();
    for (const sketch of curves.filter(isSketch)) {
        const marks = (sketch.constraints ?? []).filter((k) => !sk.DIMENSIONS.has(k.kind));
        const lit = [liveHover(), selectedDim].filter((h) => h?.sketch === sketch.id);
        if (!marks.length && !lit.length) continue;
        const view = viewOf(sketch.id);
        if (view === null || view === undefined) continue;
        const top = rects[view];
        if (top[2] <= 0 || top[3] <= 0) continue;
        ctx.save();
        ctx.beginPath(); ctx.rect(top[0], top[1], top[2], top[3]); ctx.clip();
        const px = (p) => sketchToPx(sketch.id, p, top);
        const shown = (k) => !(k.refs ?? []).some((r) => { const c = byId(r.curve); return !c || !shownOf(c); });
        // The hovered and the selected constraint's points, ringed.
        for (const h of lit) {
            const k = sketch.constraints?.find((x) => x.id === h.id);
            if (!k || !shown(k)) continue;
            ctx.strokeStyle = h === selectedDim ? ACCENT : HOVER_EDGE; ctx.lineWidth = 2;
            for (const r of k.refs ?? []) {
                if (r.at === "curve" || r.at.startsWith("side:")) continue;
                const p = spotXY(r);
                if (!p) continue;
                const [sx, sy] = px(p);
                ctx.beginPath(); ctx.arc(sx, sy, 7, 0, TAU); ctx.stroke();
            }
        }
        const conflicts = conflictsOf(sketch.id), unapplied = notAppliedOf(sketch.id);
        // Every mark by its spot's pixel, in drawing order; then stacked side by side, never
        // one on another (`stackMarks`); then drawn.
        const todo = [];
        for (const k of marks) {
            if (!shown(k)) continue;
            const chosen = selectedDim?.sketch === sketch.id && selectedDim.id === k.id;
            const hovered = liveHover()?.sketch === sketch.id && hoverConstraint.id === k.id;
            const colour = chosen ? ACCENT : hovered ? HOVER_EDGE : conflicts.has(k.id) ? CONFLICT_COLOUR : unapplied.has(k.id) ? NOT_APPLIED_COLOUR : GLYPH_COLOUR;
            for (const at of glyphPlaces(k)) if (at) todo.push({ k, p: px(at), struck: unapplied.has(k.id) && !chosen && !hovered, colour });
        }
        const placed = sk.stackMarks(todo.map((m) => m.p));
        todo.forEach(({ k, struck, colour }, i) => {
            const [x, y] = placed[i];
            drawGlyph(k.kind, x, y, colour);
            if (struck) {   // not applied: struck through
                ctx.strokeStyle = NOT_APPLIED_COLOUR; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x - 6, y + 6); ctx.lineTo(x + 6, y - 6); ctx.stroke();
            }
            glyphRects.push({ sketch: sketch.id, id: k.id, rect: [x - 7, y - 7, 14, 14] });
        });
        ctx.restore();
    }
    ctx.restore();
}
// The constraint under the overlay pixel `p` -- a mark, else a dimension's label -- or null.
function constraintAt(p) {
    for (let i = glyphRects.length - 1; i >= 0; i--) {
        const [x, y, w, h] = glyphRects[i].rect;
        if (p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h) return glyphRects[i];
    }
    return dimensionAt(p);
}
// The curves the hovered constraint binds, lit as a hovered curve is.
function hoverConstraintCurves() {
    const h = liveHover();
    const k = h && byId(h.sketch)?.constraints?.find((x) => x.id === h.id);
    return new Set((k?.refs ?? []).map((r) => r.curve));
}
// The pointer over a mark or a label: lit, the curves it binds with it.
let hoverHint = false;   // the hint names the hovered constraint
function hoverConstraintAt(px) {
    const h = px && constraintHoverable() ? constraintAt(px) : null;
    const next = h ? { sketch: h.sketch, id: h.id } : null;
    if (next?.sketch === hoverConstraint?.sketch && next?.id === hoverConstraint?.id) return;
    hoverConstraint = next;
    if (next) { hintEl.textContent = `${constraintStatus(byId(next.sketch), next.id)} · click selects it, Delete removes it`; hoverHint = true; }
    else if (hoverHint) { hoverHint = false; if (constraintHoverable()) hintEl.textContent = hintFor(current()?.kind); }
    schedule();
}
// The selected constraint (a mark's or a dimension's) taken out of its sketch. The sketch's
// session goes: one is built from the records left, so a record the old one refused for
// fighting the deleted constraint is judged again. Where none of those now applies, the
// delete is one `edit` of the sketch's constraints alone: nothing solved, nothing moved,
// nothing built again (a `set` of a sketch marks its every curve to build). Where some
// do, the sketch is solved at once and the delete is one `edit` of its constraints and every
// curve the solve moved -- one undo step; a solve that does not converge (or withholds, or
// collapses a curve) leaves the delete alone, nothing moved, and says so.
function deleteConstraint(sketchId, id) {
    const sketch = byId(sketchId);
    if (!isSketch(sketch) || !sketch.constraints?.some((x) => x.id === id)) return;
    const name = constraintName(sketch, id);
    // What the session as it stands refuses (built for the purpose where none is cached).
    let blocked = [];
    try { blocked = modelFor(sketch).refused.map((r) => r.id).filter((x) => x !== null && x !== id); } catch { blocked = []; }
    const start = constrainedStart(sketch);
    dropModel(sketch.id);
    const constraints = sketch.constraints.filter((x) => x.id !== id);
    setConstraints(sketch, structuredClone(constraints));
    let unblocked = [], failure = null, items = null;
    try {
        const model = modelFor(sketch);
        unblocked = blocked.filter((k) => model.kernelOf.has(k));
        if (unblocked.length) {
            const report = sk.solveModel(wasm, model);
            failure = report.status !== "converged" ? "not converged" : writeSolved(sketch, model).error;
            if (!failure) {
                items = changedSince(start);
                if (collapsed(start, items.filter((it) => "shape" in it).map((it) => it.id))) failure = "collapsed";
            }
        }
    } catch (error) {
        failure = String(error?.message ?? error);
    }
    const names = unblocked.map((k) => constraintName(sketch, k)).join(", ");
    if (unblocked.length && !failure) run({ op: "edit", items });
    else {
        // The shapes as they were (a failed solve may have written some), the delete alone.
        restoreStart(start);
        setConstraints(sketch, structuredClone(constraints));
        run({ op: "edit", items: [{ id: sketch.id, constraints }] });
    }
    if (hoverConstraint?.sketch === sketch.id && hoverConstraint.id === id) hoverConstraint = null;
    // Nothing is left selected: a second Delete (or the button again) never takes the sketch.
    selectedDim = null;
    setSelection([]);
    renderProps();
    if (curves.some((c) => c.dirty)) rebuild();
    say(!unblocked.length ? `deleted ${name}` : failure ? `deleted ${name} — ${names} now ${unblocked.length > 1 ? "apply" : "applies"} but the sketch does not solve` : `deleted ${name} — ${names} now ${unblocked.length > 1 ? "apply" : "applies"}`, !!(unblocked.length && failure));
    dofSaid = dofLine();   // the deletion's line stays until the next build
    schedule();
}

// Each constrained sketch's degrees of freedom (forge-constraints' `diagnoseModel`): how
// many are left, its state, the curves still free to move, the constraints it cannot hold
// (the diagnosis's conflicting ones, and any its session refused when built). Diagnosed
// when the sketch's curves or constraints change -- after a rebuild, never per pointer move
// -- and never during a handle's drag, whose session the drag holds, nor while a curve is
// being drawn (its every pointer move a new shape): diagnosed once either ends.
// A record the session refused when built is not applied: refused as over-constrained (or
// not solving) it is a conflict -- red, and the sketch is over-constrained; refused for
// anything else (an unknown kind or end, a spot it binds gone) it is drawn in a neutral
// grey, struck through, and the sketch's state is the rest's. `reasons` keeps each one's
// why, for its selection and its hover; an accepted one the diagnosis finds conflicting
// is red too.
// Each entry is keyed by its sketch's revision (`revOf`) when it was made: a sketch whose
// revision has not moved since is not diagnosed again.
const diagnoses = new Map();   // sketch id -> { rev, free, state, freeCurves, conflicting, notApplied, reasons }
function refreshDiagnoses() {
    if (drag?.kind === "handle" || (drawing && drawing.id !== null)) return;
    for (const id of [...diagnoses.keys()]) if (!constrained(byId(id))) diagnoses.delete(id);
    for (const sketch of curves.filter(isSketch)) {
        if (!constrained(sketch)) continue;
        if (diagnoses.get(sketch.id)?.rev === revOf(sketch.id)) continue;
        let entry;
        try {
            const model = modelFor(sketch);
            // Read after the build, which touches the sketch: the earlier value would
            // never match again, and the sketch would be diagnosed every frame.
            const rev = revOf(sketch.id);
            const d = sk.diagnoseModel(wasm, model);
            const reasons = new Map(), notApplied = new Set(), conflicting = new Set(d.conflicting);
            for (const id of d.conflicting) reasons.set(id, { conflict: true, applied: true, text: "it conflicts with the sketch's other constraints" });
            for (const r of model.refused) {
                if (r.id === null) continue;
                const raw = String(r.error).replace(/^sketch_\w+: /, "");
                const conflict = sk.isConflictRefusal(r);
                const text = r.collapse ? `it would shrink ${sk.curveName(byId(r.curve))} to a point` : conflict ? (/over-constrained/.test(raw) ? "over-constrained — it conflicts with the sketch's other constraints" : "the sketch does not solve with it")
                    : raw.replace(/^constraint \d+: /, "");
                reasons.set(r.id, { conflict, applied: false, text });
                if (conflict) conflicting.add(r.id); else notApplied.add(r.id);
            }
            for (const id of model.stale) { reasons.set(id, { conflict: false, applied: false, text: "a spot it binds is gone" }); notApplied.add(id); }
            entry = { rev, free: d.free, state: conflicting.size ? "over" : d.state, freeCurves: d.freeCurves, conflicting: [...conflicting], notApplied, reasons };
        } catch (error) {
            entry = { rev: revOf(sketch.id), error: String(error?.message ?? error), freeCurves: new Set(), conflicting: [], notApplied: new Set(), reasons: new Map() };
        }
        diagnoses.set(sketch.id, entry);
    }
}
// What a constrained sketch's row and the status line say of it: "over-constrained",
// "N free" or "fully defined" ("" for a sketch with no stored constraints).
function dofText(sketch) {
    const d = constrained(sketch) ? diagnoses.get(sketch.id) : null;
    if (!d || d.error) return "";
    return d.state === "over" ? "over-constrained" : d.free > 0 ? `${d.free} free` : "fully defined";
}
// The sketch being worked in -- the selected one, or the selected curve's -- and its line.
const activeSketch = () => { const c = current(); return isSketch(c) ? c : c ? sketchOf(c) : null; };
function dofLine() {
    const s = activeSketch(), t = s ? dofText(s) : "";
    return t ? `${s.name}: ${t}` : "";
}
let dofSaid = "";   // the active sketch's line as the status line last said it
// A notice carried past the next build (a drag's release rebuilds the curves it moved, and
// that build's line would cover it at once): said now, and again after the build line.
// Not an error: what it is said of went through.
let pendingNotice = null;
function noticeNext(text) {
    pendingNotice = text;
    say(text);
    dofSaid = dofLine();
}
// After a rebuild: the build line with the active sketch's line and a carried notice after
// it; with nothing built, its line alone when it changed (another sketch active, or its
// freedom changed) -- never over a refusal's reason, which stays until the next build.
function sayDof(builtText) {
    const line = dofLine();
    if (builtText !== null) { say([builtText, line, pendingNotice].filter(Boolean).join(" · ")); pendingNotice = null; }
    else if (line && line !== dofSaid && !statusEl.classList.contains("error")) say(line);
    dofSaid = line;
}
// The selected dimension's rows in the dialog: its value (an angle's in degrees; a driven
// one's shown, not typed) and a driving / driven toggle.
function dimensionRows(sketch, k) {
    const head = document.createElement("div");
    head.className = "row wide";
    head.textContent = `${k.kind.replace(/_/g, " ")} ${k.id}`;
    if (!sk.DIMENSIONS.has(k.kind)) { head.title = "Delete removes it"; return [head]; }
    const row = document.createElement("label");
    row.className = "row";
    const input = document.createElement("input");
    input.type = "number"; input.step = "any"; input.dataset.dim = "value";
    input.value = round(shownValue(k));
    input.disabled = k.driving === false;
    const fresh = () => sketch.constraints?.find((x) => x.id === k.id);
    input.addEventListener("change", () => {
        const v = +input.value, now = fresh();
        if (!now) return;
        if (input.value === "" || !Number.isFinite(v) || !setDimensionValue(sketch.id, k.id, v)) input.value = round(shownValue(fresh() ?? now));
    });
    row.append(k.kind === "angle" ? "angle°" : "value", input);
    const toggle = document.createElement("div");
    toggle.className = "row buttons";
    for (const [text, driving] of [["driving", true], ["driven", false]]) {
        const b = document.createElement("button");
        b.textContent = text; b.dataset.dim = text;
        b.setAttribute("aria-pressed", String((k.driving !== false) === driving));
        b.title = driving ? "the dimension sets the geometry" : "the dimension only reports the geometry";
        b.addEventListener("click", () => { const now = fresh(); if (now && (now.driving !== false) !== driving) setDimensionDriving(sketch.id, k.id, driving); });
        toggle.append(b);
    }
    return [head, row, toggle];
}
// Why a dimension of `kind` cannot hold the value `v` its geometry measures now (the
// kernel's own value checks, which it applies on every build), or null where it can: a
// record stored with such a value would be refused by every later session.
function unholdable(kind, v) {
    if (!Number.isFinite(v)) return "it measures nothing there";
    if (kind === "distance" && !(v > 0)) return "the points coincide — use coincident";
    if ((kind === "radius" || kind === "diameter") && !(v > 0)) return "the circle has no size";
    if (kind === "circle_line_distance" && v < 0) return "the circle crosses the line — a distance cannot be negative";
    if ((kind === "length" || kind === "point_line_distance" || kind === "line_distance") && v < 0) return "a distance cannot be negative";
    return null;
}
// The dimensions that hold a point, a line or a circle on one side of a line (`sense`):
// the kernel resolves "auto" to the side the geometry is on when it is added, and the
// record keeps that side (`keepSense`), so a later session holds the same one.
const SENSED = new Set(["point_line_distance", "line_distance", "circle_line_distance"]);
const SENSE_NAMES = ["auto", "positive", "negative"];
function keepSense(model, k) {
    if (SENSED.has(k.kind)) k.sense = SENSE_NAMES[wasm.cadaclysm_blacksmith_sketch_constraint_sense(model.h, model.kernelOf.get(k.id))] ?? "auto";
}
// A new dimension's kinds whose value has a sign: their refs are ordered when it is made so
// it measures positive, and the value typed later means what the label shows.
const SIGNED = new Set(["horizontal_distance", "vertical_distance", "angle"]);
// Makes `k` (in `model`, on `sketch`) driving -- it takes what it measures, nothing moves --
// unless that would over-constrain the sketch: refused by the session, or held as solved
// only because the rest already fixes what it measures (redundant). Null where it drives,
// else why not (it is left driven).
function drive(sketch, model, k, picks) {
    // A driven one held to a side its geometry has since crossed: its side re-resolved to
    // where the geometry is now (it would take a negative value, which no side holds).
    if (SENSED.has(k.kind) && sk.measure(wasm, model, k.id) < 0) {
        const was = k.sense;
        sk.removeConstraint(wasm, model, k.id);
        k.sense = "auto";
        const back = sk.addConstraint(wasm, model, k);
        if (!back.ok) { k.sense = was; sk.addConstraint(wasm, model, k); return `driving it is refused: ${refusalText(sketch, back, picks)}`; }
        keepSense(model, k);
    }
    const got = sk.setDriving(wasm, model, k.id, true);
    if (!got.ok) return `driving it is refused: ${refusalText(sketch, got, picks)}`;
    const d = sk.diagnoseModel(wasm, model);
    if (d.redundant.includes(k.id) || d.conflicting.includes(k.id)) {
        sk.setDriving(wasm, model, k.id, false);
        // What determines it: the stored constraints on the curves it binds (never the
        // sketch's other ones), else a rectangle's, polygon's or polycurve's own shape.
        const bound = [...new Set((k.refs ?? []).map((r) => r.curve))].map(byId).filter(Boolean);
        const names = [...new Set(bound.flatMap((c) => holderNames(sketch, c, k.id)))];
        const own = bound.filter((c) => c.kind === "rect" || c.kind === "polygon" || c.kind === "polycurve").map((c) => `${c.name}'s own shape`);
        return `${k.kind.replace(/_/g, " ")} ${k.id} is already determined by ${[...names, ...own].join(", ") || bound.map((c) => c.name).join(", ")}`;
    }
    // In place, untouched (no `touchSketch`): every caller commits it with `run({ op: "edit" })`,
    // or restores the start (which touches), and applying a command touches every sketch.
    k.driving = true;
    k.value = sk.measure(wasm, model, k.id);
    return null;
}
// The dimension tool's record added: driven first (a driven dimension holds nothing, so
// it never conflicts), its value what it measures, then made driving where the sketch
// takes it -- so adding it never moves anything -- else left driven and the status line
// says why. The record and anything the solve touched are one `edit`.
function addDimension(sketch, made, picks) {
    const start = constrainedStart(sketch);
    const k = { id: sk.nextConstraintId(sketch), ...made, value: 1, driving: false };
    let failure = null, note = null;
    try {
        const model = modelFor(sketch);
        let got = sk.addConstraint(wasm, model, k);
        if (got.ok && SIGNED.has(k.kind) && sk.measure(wasm, model, k.id) < 0) {
            sk.removeConstraint(wasm, model, k.id);
            k.refs = [k.refs[1], k.refs[0]];
            got = sk.addConstraint(wasm, model, k);
        }
        if (got.ok) keepSense(model, k);
        const why = got.ok ? unholdable(k.kind, sk.measure(wasm, model, k.id)) : null;
        if (!got.ok) failure = refusalText(sketch, got, picks);
        else if (why) failure = `${k.kind.replace(/_/g, " ")}: ${why}`;
        else {
            k.value = sk.measure(wasm, model, k.id);   // in place: setConstraints just below touches
            setConstraints(sketch, [...(sketch.constraints ?? []), k]);
            note = drive(sketch, model, k, picks);
            const report = sk.solveModel(wasm, model);
            failure = report.status !== "converged" ? solveFailure(sketch, report) : writeSolved(sketch, model).error;
        }
    } catch (error) {
        failure = String(error?.message ?? error);
    }
    let items = failure ? [] : changedSince(start), settled = null;
    if (!failure) {
        const gone = collapsed(start, items.filter((it) => "shape" in it).map((it) => it.id));
        if (gone) failure = collapseText(sketch, gone, k.id);
        else if ((settled = settleRefused(sketch))) items = changedSince(start);   // a record the dimension lets apply, in its step
    }
    if (failure) { pendingNotice = null; restoreStart(start); refuse(`dimension: ${failure}`); return; }
    run({ op: "edit", items });
    renderList();
    if (curves.some((c) => c.dirty)) rebuild();
    // Said here, after the build: the line below would cover the notice the build carried.
    pendingNotice = null;
    say([note ? `dimension: ${constraintName(sketch, k.id)} added as driven: ${note}` : `dimension: ${constraintName(sketch, k.id)}`, settled].filter(Boolean).join(" · "));
    schedule();
}
// A dimension changed through the session -- its value (`{ value }`, an angle's in
// radians) or whether it drives (`{ driving }`) -- solved, and the dimension with every
// curve that moved one `edit`. Refused (no solve, a curve collapsed, a driving one that
// would over-constrain), nothing changes and the status line says why. True where it took.
function editDimension(sketchId, id, change) {
    const sketch = byId(sketchId);
    if (!isSketch(sketch) || !sketch.constraints?.some((x) => x.id === id)) return false;
    const name = constraintName(sketch, id);
    const start = constrainedStart(sketch);
    const k = sketch.constraints.find((x) => x.id === id);
    const picks = (k.refs ?? []).map((spot) => ({ spot }));
    let failure = null;
    // `k` is written in place below, untouched: the edit run (or the restore) touches the sketch.
    try {
        const model = modelFor(sketch);
        if (change.value !== undefined) {
            const got = sk.setValue(wasm, model, id, change.value);
            if (!got.ok) failure = refusalText(sketch, got, picks);
            else if (got.report.status !== "converged") failure = solveFailure(sketch, got.report);
            else { k.value = change.value; failure = writeSolved(sketch, model).error; }
        } else if (change.driving) {
            failure = drive(sketch, model, k, picks) ?? writeSolved(sketch, model).error;
        } else {
            const got = sk.setDriving(wasm, model, id, false);
            if (!got.ok) failure = refusalText(sketch, got, picks);
            else {
                k.driving = false;
                const v = sk.measure(wasm, model, id);
                if (!unholdable(k.kind, v)) k.value = v;   // else the value it held: one the kernel loads
                failure = writeSolved(sketch, model).error;
            }
        }
    } catch (error) {
        failure = String(error?.message ?? error);
    }
    let items = failure ? [] : changedSince(start);
    if (!failure) {
        const gone = collapsed(start, items.filter((it) => "shape" in it).map((it) => it.id));
        if (gone) failure = collapseText(sketch, gone, id);
        else if (settleRefused(sketch)) items = changedSince(start);   // a record the new value lets apply, in its step
    }
    if (failure) { pendingNotice = null; restoreStart(start); refuse(`${name}: ${failure}`); renderProps(); return false; }
    if (items.length) run({ op: "edit", items });
    renderList();
    renderProps();
    schedule();
    return true;
}
// A value typed for a dimension (an angle's in degrees). A driven one is not typed: it
// reports the geometry.
function setDimensionValue(sketchId, id, typed) {
    const sketch = byId(sketchId), k = sketch?.constraints?.find((x) => x.id === id);
    if (!k) return false;
    if (k.driving === false) { say(`${constraintName(sketch, id)} is driven -- it reports the geometry; make it driving to set it`, true); return false; }
    // An angle typed in degrees, taken in (-180, 180].
    const deg = k.kind === "angle" ? (((typed % 360) + 360) % 360 > 180 ? ((typed % 360) + 360) % 360 - 360 : ((typed % 360) + 360) % 360) : typed;
    return editDimension(sketchId, id, { value: k.kind === "angle" ? deg * Math.PI / 180 : typed });
}
function setDimensionDriving(sketchId, id, driving) {
    return editDimension(sketchId, id, { driving });
}
// The value typed over a dimension's label, on a double-click: Enter sets it, Esc or a
// click away leaves it as it was.
let dimEditor = null;   // { el, sketch, id }
function openDimensionEditor(hit) {
    closeDimensionEditor();
    const sketch = byId(hit.sketch), k = sketch?.constraints?.find((x) => x.id === hit.id);
    if (!k) return;
    if (k.driving === false) { say(`${constraintName(sketch, k.id)} is driven -- it reports the geometry; make it driving (in the dialog) to type its value`, true); return; }
    const el = document.createElement("input");
    el.type = "number"; el.step = "any"; el.className = "dim-edit";
    el.value = round(shownValue(k));
    const [x, y, w] = hit.rect;
    el.style.left = `${Math.round(x + w / 2 - 38)}px`;
    el.style.top = `${Math.round(y - 1)}px`;
    overlay.parentElement.append(el);
    dimEditor = { el, sketch: hit.sketch, id: hit.id };
    el.addEventListener("keydown", (e) => {
        e.stopPropagation();   // the page's keys (WASD, Delete, Enter, Esc) are not this field's
        if (e.key === "Escape") { e.preventDefault(); closeDimensionEditor(); return; }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const ed = dimEditor, v = +el.value, blank = el.value === "";
        closeDimensionEditor();
        if (blank || !Number.isFinite(v)) { say("a dimension takes a number", true); return; }
        setDimensionValue(ed.sketch, ed.id, v);
    });
    el.addEventListener("blur", () => { if (dimEditor?.el === el) closeDimensionEditor(); });
    el.focus();
    el.select();
}
function closeDimensionEditor() {
    const ed = dimEditor;
    dimEditor = null;
    ed?.el.remove();
}
function pickCurve(i, px) {
    const size = sizeOf(i), p = local(px, i), cam = camOf(i);
    let best = null, bestD = PICK_PX;
    for (const c of curves) {
        if (!isCurve(c) || !visible(c) || !c.beziers.length) continue;
        const d = bezierDistance(c.beziers, p, cam, size, bestD);
        if (d < bestD) { bestD = d; best = c; }
    }
    return best;
}
// How far the pixel `p` (local to a view of `size`, seen by `cam`) is from the world
// Béziers `b`, each walked as twelve chords -- or `limit` where it is no nearer.
function bezierDistance(b, p, cam, size, limit) {
    let bestD = limit;
    for (let s = 0; s < b.length; s += 16) {
        let last = null;
        for (let k = 0; k <= 12; k++) {
            const t = k / 12, u = 1 - t;
            const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
            let x = 0, y = 0, z = 0, d = 0;
            for (let j = 0; j < 4; j++) { const q = s + 4 * j, wj = w[j] * b[q + 3]; x += wj * b[q]; y += wj * b[q + 1]; z += wj * b[q + 2]; d += wj; }
            const at = cam.worldToPx([x / d, y / d, z / d], size);
            if (at && last) bestD = Math.min(bestD, segmentDistance(p, last, at));
            last = at;
        }
    }
    return bestD;
}
// A click that selects: the curve under it first, else the body whose face is under
// it (with ctrl, toggled); empty space clears the selection when `clear` says so.
function selectAt(i, px, e, clear) {
    // Selected where it was clicked, the view stays: only the browser's and the
    // timeline's selections look at a curve's plane.
    const pick = (id) => { keepView = true; try { if (e.ctrlKey || e.metaKey) toggleSelected(id); else select(id); } finally { keepView = false; } };
    const hitCurve = pickCurve(i, px);
    if (hitCurve) { pick(hitCurve.id); return; }
    pickThen(i, px, e, (hitBody) => {
        if (!hitBody) { if (!(e.ctrlKey || e.metaKey) && clear) setSelection([]); return; }
        pick(hitBody.body.id);
    });
}
let keepView = false;
// The body face under `px` (the overlay's CSS pixels) in view `i`, or null: the View's
// pick, which takes device pixels from the viewport's own top left and answers with the
// item and its face, numbered as the body's `gpu` numbers them.
// A pick answered: what follows is an action of its own, behind whatever is in flight by then.
function pickThen(i, px, e, f) {
    return pickRaw(i, px).then((hit) => (hit === STALE_PICK ? null : userAct(() => f(hit))));
}
// A pick that a restart cut off (the client freed under it, or no view yet) answers this and
// not null: null is empty space, which a click reads as "clear the selection".
const STALE_PICK = Symbol("stale pick");
// The worker answers a pick with the body's id (and a trim's `ghost`) beside the item: a hit on
// anything that is no body (the grid, an image, a handle) comes back as no hit. The client keeps
// one pick out and one queued, the latest replacing the queued; so the page sends them one at a
// time, in the order asked, and a click's pick is never the queued one a hover's replaces.
let pickTail = Promise.resolve();
function pickRaw(i, px) {
    const asked = pickTail.then(() => pickOnce(i, px));
    pickTail = asked.catch(() => {});
    return asked;
}
// For the callers that read a cut-off pick as no hit (hover, a handle's gizmo test, the test hook).
function pickBody(i, px) {
    return pickRaw(i, px).then((hit) => (hit === STALE_PICK ? null : hit));
}
async function pickOnce(i, px) {
    const asked = client;
    if (!asked || !lastReport) return STALE_PICK;
    const [x, y] = local(px, i);
    const hit = await asked.pick(x * asked.ratio, y * asked.ratio, i);
    if (client !== asked) return STALE_PICK;   // free() resolved it null
    if (!hit || hit.body === undefined) return null;
    const body = byId(hit.body);
    if (!body || !isBody(body)) return null;   // the document changed while the pick was out
    return hit.ghost ? { body, index: hit.face, ghost: true } : { body, index: hit.face };
}

// `pointercancel` is the browser taking the pointer away mid-drag (a touch turned into
// a scroll, a pen lifted out of range); without it the next move would keep dragging.
const endDrag = (e) => {
    // A press the view had: its gesture ends there (and a tap has run the page's click).
    if (router !== null && (e.type === "pointerup" ? router.up(e) : router.cancel(e))) {
        if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
        return;
    }
    // A click on a view cube face (no drag) aims the camera square at it.
    if (drag?.kind === "cube" && drag.cube && e.type === "pointerup") {
        const dir = aimAt(drag.cube);
        if (dir) { viewerCall(() => viewer.aim(1, dir, [0, 0, 1])); schedule(); }
    }
    // A handle's drag is one command, of what it changed: a body's transform, a
    // revolution's axis, a curve's shape (a point added on the way down included).
    if (drag?.kind === "handle" && drag.handle.gizmo && !drag.moved && drag.under) {
        // A click on the gizmo, not a drag: whatever body lies under it is selected
        // (the gizmo's own body stays selected when it is that body, or nothing is).
        const own = drag.curve;
        drag.under.then((hit) => { if (hit && hit.body !== own) { keepView = true; try { select(hit.body.id); } finally { keepView = false; } } });
    } else if (drag?.kind === "handle" && drag.handle.gizmo) endManipulator(drag.handle);
    else if (drag?.kind === "handle" && drag.curve && drag.held) {
        // On a sketch: one edit of every curve the drag moved, and the constraints a
        // migration gave it and the coincident an end let go on another end means.
        if (drag.handle.stale) dropKeepingRed(drag.held.sketch);   // it holds a curve as it was before the drag
        inferSnapped(drag.curve, drag.handle, snapped);
        settleRefused(drag.held.sketch);   // a record the drag (or its snap) lets apply, in its step: once
        const items = changedSince(drag.held);
        if (!items.length) pendingNotice = null;   // nothing committed, so no build follows to carry it: said once
        // Kept as it is now, applied in the order's turn (`commitLater`), as a drag's commit is.
        if (items.length) commitLater({ op: "edit", items }, items.map((it) => byId(it.id)).filter((k) => k), false, drag.at ?? resets);
    } else if (drag?.kind === "handle" && drag.curve) {
        const c = drag.curve;
        noteLater(c, [isBody(c) ? (drag.handle.kind === "axis" ? "axis" : "transform") : "shape"], false, drag.at ?? resets);
    }
    drag = null; snapped = null;
    if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    schedule();   // a drag's sketch diagnosed again (never during it)
};
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);
// The pointer taken from the overlay (capture released by the browser): the same as a cancel.
overlay.addEventListener("lostpointercapture", (e) => { if (router !== null && router.holds(e.pointerId)) endDrag({ type: "pointercancel", pointerId: e.pointerId }); });
// The browser's menu fires where the right button is RELEASED, so a right-drag (a pan, a
// look) that ends off the overlay would open it: suppressed page-wide, except over a text field.
document.addEventListener("contextmenu", (e) => { if (!e.target.closest("input, textarea, [contenteditable]")) e.preventDefault(); });
overlay.addEventListener("wheel", (e) => {
    e.preventDefault();
    const px = [e.offsetX, e.offsetY], i = viewportAt(px);
    if (i < 0 || lastReport === null) return;
    // Scroll up is in, a notch per event whatever its size: a dolly towards the framed
    // centre in Perspective, a zoom about the cursor in the orthographic views (`View`'s
    // `zoom_at`, read by the camera's kind).
    const steps = -Math.sign(e.deltaY);
    if (steps === 0) return;
    const r = drawRatio(), [x, y] = local(px, i);
    viewerCall(() => viewer.zoomAt(i, x * r, y * r, steps));
}, { passive: false });
// Double-clicking a viewport's name maximizes it, and again restores the grid -- the
// name only, so a double-click in the Top view's space sketches as two clicks do.
overlay.addEventListener("dblclick", (e) => {
    if (drawing) { finishDrawing(); return; }
    // A dimension's label: its value typed over it.
    const dim = sketchPick ? null : dimensionAt([e.offsetX, e.offsetY]);
    if (dim) { openDimensionEditor(dim); return; }
    const i = nameAt([e.offsetX, e.offsetY]);
    if (i < 0) return;
    setMaximized(maximized === null ? i : null);
});

// ------------------------------------------------------------------ the keyboard

const MOVE_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
// Only keys typed at the page itself fly the camera, frame or delete: typing "20" into the
// height field must not fly it (and its `e` is a valid exponent in a number input), and a
// Backspace there edits the number. Escape is taken from anywhere -- the add button keeps
// the focus after its click, and Esc must still end the mode. A release is taken from
// anywhere, since letting go of a key is never the wrong thing to do. Delete removes the
// selected control point only: a curve is deleted from the panel, where the row that is
// about to go is in view.
addEventListener("keydown", (e) => { entry(() => onKeydown(e)); overlayDirty(); });
function onKeydown(e) {
    if (e.key === "Alt") e.preventDefault();   // held for an orbit; on its own it would take the browser's menu
    if (e.key === "Escape") { if (drawing) { cancelDrawing(); return; } if (sketchPick) { disarmSketchPick(true); return; } if (tool) { cancelTool(); return; } if (axisMode) setAxisMode(null); if (picking) setPicking(null); if (sweepMode) setSweepMode(null); if (shellMode) setShellMode(null); if (trimMode) setTrimMode(null); if (sketchTrim) { cancelPicks(); return; } if (filletMode) setFilletMode(null); return; }
    const inDialog = e.target instanceof HTMLElement && e.target.closest("#dialog");
    if (e.key === "Enter" && drawing && !inDialog) { e.preventDefault(); finishDrawing(); return; }
    if (e.key === "Enter" && tool && (e.target === document.body || inDialog || e.target instanceof HTMLButtonElement)) { e.preventDefault(); commitTool(); return; }
    if (e.key === "Enter" && axisMode && e.target === document.body) { newBody("revolution"); return; }
    // Enter from anywhere but a field -- the shell button itself has the focus after
    // arming, and its own activation on Enter is stopped, or it would arm again.
    if (e.key === "Enter" && sketchPick && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); if (sketchPick.spots) sketchPick.shift = e.shiftKey; runSketchPick(); return; }
    if (e.key === "Enter" && shellMode && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); newShell(); return; }
    if (e.key === "Enter" && sketchTrim && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); setSketchTrim(false); return; }
    if (e.key === "Enter" && trimMode && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); setTrimMode(null); return; }
    if (e.key === "Enter" && filletMode && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); setFilletMode(null); return; }
    if (e.target !== document.body) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selectedPoint !== null) {
        e.preventDefault();
        removePoint(selectedPoint);
        return;   // the point only: with none selected now, the shortcuts below would delete the curve
    }
    // The selected constraint (a mark's or a dimension's), not its sketch.
    if ((e.key === "Delete" || e.key === "Backspace") && selectedPoint === null && !e.repeat) {
        const chosen = selectedDimension();
        if (chosen) { e.preventDefault(); deleteConstraint(chosen.sketch.id, chosen.k.id); return; }
    }
    if (e.code === "KeyA" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSelection(curves.map((c) => c.id)); return; }
    // Letter shortcuts where they do not fly the camera (WASD, Q, E do): L line, R
    // rectangle, C circle, P polygon, J join, T trim, H chamfer, Delete the selection
    // -- none with a modifier, and only where the button would work.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        const press = (el) => { if (el && !el.disabled) { el.click(); e.preventDefault(); } };
        if (e.code === "KeyL") return press(document.querySelector("#ribbon-sketch [data-kind=line]"));
        if (e.code === "KeyR") return press(document.querySelector("#ribbon-sketch [data-kind=rect]"));
        if (e.code === "KeyC") return press(document.querySelector("#ribbon-sketch [data-kind=circle]"));
        if (e.code === "KeyP") return press(document.querySelector("#ribbon-sketch [data-kind=polygon]"));
        if (e.code === "KeyJ") return press(joinEl);
        if (e.code === "KeyT") return press(trimEl);
        if (e.code === "KeyH") return press(chamferEl);
        if (e.key === "Delete" && selectedPoint === null && selected !== null) return press(deleteEl);
    }
    // A shortcut's letter (ctrl/cmd-S saves; ctrl/cmd-D, -W, -Q, -E are the browser's) flies
    // nothing: its keyup may never come here (a save's picker takes the focus, a synthetic
    // press has none), and the View would then fly, and draw, every frame from then on.
    if (MOVE_CODES.has(e.code) && !e.ctrlKey && !e.metaKey) client?.inputEvent({ kind: "key", code: e.code, down: true });
    if (e.code === "KeyF" && !e.repeat) frameAll();
}
addEventListener("keyup", (e) => { if (MOVE_CODES.has(e.code)) client?.inputEvent({ kind: "key", code: e.code, down: false }); }, true);
// A key held when focus leaves never gets its keyup here; `blur` covers the window losing
// focus, `visibilitychange` a tab switch, which does not always fire `blur`. (`View` has no
// stale-key rule of its own, unlike the page camera's old 1.5 s: these two are the whole guard.)
addEventListener("blur", () => viewer?.clearKeys());
document.addEventListener("visibilitychange", () => {
    if (document.hidden) viewer?.clearKeys();
});

// ------------------------------------------------------------------ the toolbar

degreeEl.addEventListener("change", () => {
    const c = current();
    if (c?.kind !== "nurbs") return;
    // On a sketch the curve's new shape is solved around (a tangent to it, say), its
    // partners recorded in the same step.
    const sketch = sketchOf(c);
    if (sketch) { if (!typedHeld(c, sketch, () => { c.shape.degree = +degreeEl.value; })) degreeEl.value = c.shape.degree; return; }
    c.shape.degree = +degreeEl.value;
    note(c, ["shape"]);
});
// Close joins the curve's last point back to its first -- a polyline by a segment, a
// NURBS smoothly (a periodic spline), a polycurve by a line between its ends (or by
// nothing, where they already meet); pressed again it opens there (the polycurve
// losing that closing line).
// One `set` of the shape; closing or opening changes the curve's spots (an open one's
// start and end, a closing side), so its sketch's constraints are renamed and pruned with
// it: a polyline's or a NURBS's start and end are its first and last vertex once closed
// (`remapClosing`), and those vertices its start and end again once opened.
function toggleClosed(c) {
    if (c?.kind !== "polycurve" && !pointed(c)) return;
    runStructural(() => ({ op: "set", id: c.id, shape: structuredClone(c.shape) }), [c.plane], {
        remap: pointed(c) ? remapClosing(c, !c.shape.closed) : null,
        mutate: () => toggleClosedShape(c),
    });
}
// A polyline's or a NURBS's spots renamed as it closes (`closing`) or opens: an open one's
// `start` and `end` are `vertex:0` and `vertex:n-1` of the closed one, and back.
function remapClosing(c, closing) {
    const n = c.shape.points.length;
    const to = closing ? { start: "vertex:0", end: `vertex:${n - 1}` } : { "vertex:0": "start", [`vertex:${n - 1}`]: "end" };
    return (list) => list.map((k) => ({ ...k, refs: (k.refs ?? []).map((r) => r.curve === c.id && Object.hasOwn(to, r.at) ? { ...r, at: to[r.at] } : r) }));
}
function toggleClosedShape(c) {
    if (c?.kind === "polycurve") {
        const s = c.shape;
        if (!s.closed) {
            // The kernel's close (`Profile::close_loop`, through forge-doc-curves.js's `closeCurve`): the
            // straight side from the chain's end back to its start, or none where the ends
            // meet within the sketch's tolerance. Pieces that do not chain close as their
            // ends say, and the build names what is wrong with them.
            let side = null;
            try { side = closeCurve(wasm, chainPieces(s.pieces).beziers, LOOP_TOLERANCE); } catch { side = null; }
            if (side === null) {
                const [a, b] = s.ends;
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) > LOOP_TOLERANCE) side = [b[0], b[1], a[0], a[1]];
            }
            if (side?.length === 4) s.pieces.push({ kind: "line", shape: { x0: side[0], y0: side[1], x1: side[2], y1: side[3] } });
            s.closed = true; s.ends = [[0, 0], [0, 0]];
        } else {
            const last = s.pieces[s.pieces.length - 1];
            if (s.pieces.length > 1 && last.kind === "line") s.pieces.pop();
            try {
                const { beziers } = chainPieces(s.pieces);
                s.ends = [[beziers[0], beziers[1]], [beziers[beziers.length - 4], beziers[beziers.length - 3]]];
            } catch { /* the pieces stay as they are; the build says what is wrong */ }
            s.closed = false;
        }
        return;
    }
    c.shape.closed = !c.shape.closed;
}
weightEl.addEventListener("input", () => {
    const c = current();
    if (c?.kind !== "nurbs" || selectedPoint === null) return;
    const sketch = sketchOf(c), i = selectedPoint;
    if (sketch) {
        // Refused: the slider goes back to the weight that stands.
        if (!typedHeld(c, sketch, () => { c.shape.weights[i] = weightOf(+weightEl.value); })) weightEl.value = sliderOfWeight(c.shape.weights[i]);
        weightValueEl.textContent = c.shape.weights[i].toFixed(2);
        return;
    }
    c.shape.weights[selectedPoint] = weightOf(+weightEl.value);
    weightValueEl.textContent = c.shape.weights[selectedPoint].toFixed(2);
    note(c, ["shape"], true);
});
// The two layers: the surfaces are the View's "surfaces", the curves its "edges" and
// "curves" (a body's edges; the sketch's curves, previews and isocurves). A checkbox
// drives `viewer.setVisible` directly, as the reader page's do; a View made again after a
// restart is told their state (`afterViewReady`).
const LAYERS = { mesh: ["surfaces"], edges: ["edges", "curves"] };
function syncLayers() {
    for (const [kind, layers] of Object.entries(LAYERS)) {
        const checkbox = document.getElementById(`layer-${kind}`);
        for (const layer of layers) viewerCall(() => viewer.setVisible(layer, checkbox.checked));
    }
}
for (const kind of Object.keys(LAYERS)) {
    document.getElementById(`layer-${kind}`).addEventListener("change", () => { if (viewReady) syncLayers(); });
}
// The measures and the isocurves: display settings, not part of the document,
// remembered per browser, as whether a sketch shows its
// dimensions. The isocurves (a curved face's isoparametric lines, the wireframe)
// are curve items of the View's, so `show` shows them or leaves them out.
const measuresEl = document.getElementById("layer-measures");
let showMeasures = false;
try { showMeasures = localStorage.getItem("forge.measures") === "on"; } catch { /* no storage: off */ }
measuresEl.checked = showMeasures;
measuresEl.addEventListener("change", () => {
    showMeasures = measuresEl.checked;
    try { localStorage.setItem("forge.measures", showMeasures ? "on" : "off"); } catch { /* not remembered */ }
    schedule();
});
const isocurvesEl = document.getElementById("layer-isocurves");
let showIsocurves = false;
try { showIsocurves = localStorage.getItem("forge.isocurves") === "on"; } catch { /* no storage: off */ }
isocurvesEl.checked = showIsocurves;
isocurvesEl.addEventListener("change", () => {
    showIsocurves = isocurvesEl.checked;
    try { localStorage.setItem("forge.isocurves", showIsocurves ? "on" : "off"); } catch { /* not remembered */ }
    // Made by the worker only while shown (the wanted list names them).
    schedule();
});

// The reference images: the View has no layer for them, so `show` leaves them out
// while this is unchecked.
const imagesLayerEl = document.getElementById("layer-images");
imagesLayerEl.addEventListener("change", () => schedule());

// The lighting: a display setting like the measures, not part of the document, remembered per
// browser. It reaches the View (in the worker) as `setLighting`, and a View made again after
// a restart is told it (`afterViewReady`). The View lights only parts in its default material,
// so under studio and the showroom a body with no look of its own is shown in that material
// (`bodyColour`); a body given a look keeps its material's own lamps under every lighting.
const LIGHTINGS = new Set(["headlight", "studio", "showroom"]);
const lightingEl = document.getElementById("lighting");
let lighting = "headlight";
try { const kept = localStorage.getItem("forge.lighting"); if (LIGHTINGS.has(kept)) lighting = kept; } catch { /* no storage: the headlight */ }
lightingEl.value = lighting;
function syncLighting() {
    viewerCall(() => viewer.setLighting(lighting));
}
lightingEl.addEventListener("change", () => {
    lighting = LIGHTINGS.has(lightingEl.value) ? lightingEl.value : "headlight";
    try { localStorage.setItem("forge.lighting", lighting); } catch { /* not remembered */ }
    if (viewReady) syncLighting();
    schedule();   // the bodies with no look of their own change material
});

// ------------------------------------------------------------------ reference images

// A picture on a plane to trace over -- a canvas: placed on the sketch plane
// the active view looks at, its centre at the plane's origin, 100 wide, and then
// sized, moved, turned and faded in the dialog. The bitmap is decoded once per item
// and kept by id (`imageBitmaps`), the data URL in the command so undo and redo bring
// the image back; nothing of it is saved with the document.
const imageBitmaps = new Map();
const imageGens = new Map();   // image id -> how many bitmaps it has had: a re-decoded one is a new dependency
// An image's pixels, kept here and posted to the worker, which draws them (a clone, transferred:
// the page keeps its own for a restart).
function setImageBitmap(id, bitmap) {
    imageBitmaps.set(id, bitmap);
    imageGens.set(id, (imageGens.get(id) ?? 0) + 1);
    postBitmap(id, bitmap);
}
function postBitmap(id, bitmap) {
    const w = worker;
    createImageBitmap(bitmap).then((clone) => {
        if (w !== worker || worker === null) { clone.close(); return; }   // the worker it was for is gone: a restart posts them again
        worker.postMessage({ kind: "bitmap", id, bitmap: clone }, [clone]);
    }, () => {});
}
const imageAddEl = document.getElementById("image-add"), imageFileEl = document.getElementById("image-file");
const imageWidthEl = document.getElementById("image-width"), imageXEl = document.getElementById("image-x"), imageYEl = document.getElementById("image-y");
const imageAngleEl = document.getElementById("image-angle"), imageOpacityEl = document.getElementById("image-opacity");
const imageFlipXEl = document.getElementById("image-flip-x"), imageFlipYEl = document.getElementById("image-flip-y");
imageAddEl.addEventListener("click", () => { imageFileEl.value = ""; imageFileEl.click(); });
imageFileEl.addEventListener("change", async () => {
    const file = imageFileEl.files?.[0];
    if (!file) return;
    let src, bitmap;
    try {
        src = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
        bitmap = await createImageBitmap(file);
    } catch (error) { say(`${file.name}: ${error.message ?? error}`, true); return; }
    const id = nextId;
    setImageBitmap(id, bitmap);
    run({ op: "image", id, plane: sketchPlane(), src, width: 100, aspect: bitmap.width / Math.max(1, bitmap.height) });
    select(id);
    say(`${file.name} placed on ${planeInfo(sketchPlane()).name} -- its size, place and opacity in the dialog`);
});
// The bitmap of an image command applied (a document replayed after undo), decoded from
// its data URL when it is not held already; drawn when it arrives.
function decodeImage(id, src) {
    if (imageBitmaps.has(id)) return;
    fetch(src).then((r) => r.blob()).then(createImageBitmap).then((bitmap) => { setImageBitmap(id, bitmap); schedule(); }).catch(() => {});
}
// The image's four corners in the world, round the quad from its top-left as the
// picture is read: on its plane, about its place, turned by its angle.
function imageQuad(c) {
    const w = c.width / 2, h = c.width / c.aspect / 2;
    const a = c.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    return [[-w, h], [w, h], [w, -h], [-w, -h]].map(([u, v]) => [c.at[0] + u * ca - v * sa, c.at[1] + u * sa + v * ca]);
}
function imageCorners(c) {
    const { origin, x: X, y: Y } = planeInfo(c.plane).frame;
    const out = new Float32Array(12);
    imageQuad(c).forEach(([px, py], k) => out.set(V.add(origin, V.add(V.mul(X, px), V.mul(Y, py))), k * 3));
    return out;
}
function imageBounds(c) {
    const corners = imageCorners(c);
    const centre = [0, 1, 2].map((k) => (corners[k] + corners[6 + k]) / 2);
    return { centre, radius: Math.hypot(corners[0] - centre[0], corners[1] - centre[1], corners[2] - centre[2]) };
}
const imageField = (key, read) => (el) => {
    const c = current();
    if (!c || !isImage(c)) return;
    const v = read(el);
    if (v === null) return;
    if (key === "at") c.at = v; else c[key] = v;
    note(c, [key], true);
};
const number = (el) => { const v = +el.value; return el.value === "" || !Number.isFinite(v) ? null : v; };
imageWidthEl.addEventListener("input", () => imageField("width", (el) => { const v = number(el); return v === null || v <= 0 ? null : v; })(imageWidthEl));
imageXEl.addEventListener("input", () => imageField("at", (el) => { const v = number(el); return v === null ? null : [v, current().at[1]]; })(imageXEl));
imageYEl.addEventListener("input", () => imageField("at", (el) => { const v = number(el); return v === null ? null : [current().at[0], v]; })(imageYEl));
imageAngleEl.addEventListener("input", () => imageField("angle", number)(imageAngleEl));
imageOpacityEl.addEventListener("input", () => imageField("opacity", number)(imageOpacityEl));
imageFlipXEl.addEventListener("click", () => { const c = current(); if (c && isImage(c)) run({ op: "set", id: c.id, flipX: !c.flipX }); });
imageFlipYEl.addEventListener("click", () => { const c = current(); if (c && isImage(c)) run({ op: "set", id: c.id, flipY: !c.flipY }); });

// ------------------------------------------------------------------ the build

// The View lives in the worker, on the canvas the page hands over (viewer-client.js). `client`
// is made when the worker starts, `viewer` is its View by proxy (every call a message, its
// answer a promise), and `viewReady` is set once the worker has made the View and the page
// has set it up (`afterViewReady`): until then no camera or viewport call is sent, since a
// viewport call before the viewports are set would be refused. Every handler registered above
// can fire before then -- a click in a view, a key, a blur -- so the ones that touch the view
// check `viewReady`, and a rebuild waits.
let client = null;
let viewer = null;
let viewReady = false;
let viewBackend = null;   // "webgpu" or "webgl2", as the worker's View reports it
let router = null;   // the pointer's presses the view has (forge-input.js), once the client exists
const MAX_RATIO = 2;   // the forge draws at the device's ratio, at most this
// The one ratio every CSS pixel becomes a device pixel by -- the canvas's backing store, the
// viewports' rects, the picks and the overlay: the host's, the device's capped at MAX_RATIO and
// lowered so the canvas fits the device's largest texture. A change is a `view.resized`.
function drawRatio() { return client?.ratio ?? 1; }
// The overlay redrawn on the next animation frame, however many ask: for what the page alone
// changes (a hover, a snap, a handle drag), which rides no frame of the View's.
let overlayQueued = false;
function overlayDirty() {
    if (overlayQueued) return;
    overlayQueued = true;
    requestAnimationFrame(() => { overlayQueued = false; drawOverlay(); });
}
// A message to the worker, if there is one.
function toWorker(message) { worker?.postMessage(message); }
let centre = [0, 0, 0];    // the document's bounds, for the perspective dolly, F and the
let radius = 50;           // depth range; an empty page is the origin at a sketch's scale
let queued = false;        // whether a rebuild is already waiting for the next frame

// One rebuild per animation frame. A drag fires many `input` and `pointermove` events per
// frame; the first one queues the frame, the rest ride along. Nothing is queued before the
// View exists: the startup path calls `schedule()` itself once it does, and that build
// reads the document as the early edits left it.
function schedule() {
    overlayDirty();
    if (!viewReady || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; rebuild(); });
}


// A curve's centre and radius in the sketch plane: the box of its handles (a NURBS lies
// within its control polygon's; a conic's axis ends span its box).
function boundsOf(c) {
    const s = c.shape;
    const corners = c.kind === "rect" || c.kind === "line" || c.kind === "arc" ? handlesOf(c)
        : c.kind === "circle" ? [[s.cx - s.r, s.cy - s.r], [s.cx + s.r, s.cy + s.r]]
        : c.kind === "ellipse" ? [[s.cx - s.rx, s.cy - s.ry], [s.cx + s.rx, s.cy + s.ry]]
        : c.kind === "polygon" ? [[s.cx - s.r, s.cy - s.r], [s.cx + s.r, s.cy + s.r]]
        : c.kind === "polycurve" ? Array.from({ length: c.sketch.length / 4 }, (_, i) => [c.sketch[4 * i], c.sketch[4 * i + 1]])
        : s.points;
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const [x, y] of corners) { lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
    return { centre: embed3(c.plane, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]), radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2 };
}

// The forge worker builds every body (forge-worker.js), so the kernel's seconds never freeze
// the page: it holds its own replica of the document, takes every op the page's took, and
// answers each body whose node changed with its table (the worker draws the body itself),
// keyed by the item's id and the key the node had. There is no page-side build: where no
// worker can run the status line says so and no body is built.
let worker = null;
let heard = false;   // whether the worker has said anything since it started
// The page's background, #1C1B1A, as the View takes it: the bytes over 255. The View
// clears to the value it is handed on a canvas it keeps out of sRGB, so this is what the
// page shows (see `encoded`).
const BACKGROUND = [0x1C, 0x1B, 0x1A].map((b) => b / 255);
// ?backend=webgl2 forces the fallback, as a browser without WebGPU gets it.
const backendParam = new URLSearchParams(location.search).get("backend");
const wanted = createWantedSender((message) => toWorker(message));
let resolveFirstView = null;
const firstView = new Promise((resolve) => { resolveFirstView = resolve; });   // the first View set up
function startWorker() {
    heard = false;
    viewReady = false;
    lastReport = null;
    try {
        worker = new Worker("./forge-worker.js", { type: "module" });
        worker.onmessage = onWorkerMessage;
        worker.onerror = (error) => restartWorker(error.message || error);
    } catch (error) {
        worker = null;
        say(`the forge worker cannot start (${error.message || error}) -- no body can be built here`, true);
        return;
    }
    if (testMode) toWorker({ kind: "forge.test", on: true });
    openWorkerReplica();
    for (const [id, bitmap] of imageBitmaps) postBitmap(id, bitmap);
    const mine = attachViewer({ canvas: viewCanvas, worker, id: VIEW_ID, surfaces: "exact", background: BACKGROUND, maxRatio: MAX_RATIO,
        ...(backendParam ? { backend: backendParam } : {}),
        onError: (m) => say(m, true),
        // A tap comes back as view.tapped (setPickOnTap(false): no GPU pick); the
        // router runs the page's click where the press landed.
        onTap: (tap, viewport, double, seq) => router?.tapped({ seq, tap, viewport, double }),
        onFrame: (viewports) => { if (viewports && viewports.length) { lastReport = viewports; drawOverlay(); } },
        // The ratio changed (a window dragged to another monitor, a canvas past the device's
        // largest texture): the rects and the tap distance are in device pixels.
        onResized: () => { if (client === mine && viewReady) { pushViewports(); router.syncTap(); } overlayDirty(); } });
    client = mine;
    viewer = client.view;
    // The input router, over the worker: `input` posts the event as it is and answers its seq.
    router = createRouter({ viewer: { input: (event) => ({ seq: client.inputEvent(event) }), setTap: (px, ms) => viewerCall(() => viewer.setTap(px, ms)) },
                            ratio: drawRatio, tap: (i, px, e) => userAct(() => pressAt(i, px, e)), onError: (e) => say(String(e?.message ?? e), true) });
    client.ready.then(({ backend }) => { if (client === mine) { viewBackend = backend; afterViewReady(); } },
                      (e) => { if (client === mine) say(`the view failed: ${e.message}`, true); });
}
// The View is made: the post-create setup, in order, then the first build.
let announced = false;
function afterViewReady() {
    viewReady = true;
    cameraRadius = null; lastRefusal = null;
    viewerCall(() => viewer.setGrid({ axes: true, step: 10, extent: 100 }));
    // The pointer's presses the page does not claim go to the view's handler; its taps come
    // back as the page's click (`pressAt`), with no GPU pick of the View's own -- the page
    // hit-tests where the press landed. A tap is three CSS pixels with no time limit, as the
    // forge's click was: a slow click still drops a point. A double tap is two clicks, as two
    // clicks were (a double click frames nothing).
    viewerCall(() => viewer.setPickOnTap(false));
    router.syncTap();
    setupViewports();
    syncLayers();
    syncLighting();
    // The empty page: every camera placed about the origin once, so the Top view has a centre
    // for the first curve to land on.
    frameAll();
    if (!announced) { announced = true; say(`add a curve from the panel — ${cadaclysm()}`); }
    if (testMode) installTestHook();
    resolveFirstView();
    schedule();
}
let progress = null;         // the latest word from the worker on the body it is building
// The worker's replica opened from the page's own save, the preview the page holds sent
// after it: a new worker, and one whose replica parted from the page's (`opFailed`).
// The quarantine (`createQuarantine`) leaves out the nodes the kernel trapped on.
const quarantine = createQuarantine();
let reopens = 0;   // `opFailed` evaluations answered by a reopen, with no change in between
function openWorkerReplica() {
    if (!worker || doc === null) return;
    worker.postMessage({ kind: "open", text: wasm.cadaclysm_blacksmith_document_save(doc), skip: quarantine.nodes() });
    if (previewOp !== null) worker.postMessage({ kind: "preview", op: previewOp });
}
// A body's build failed for a reason of the page's: the error shown, the body answered for.
function failBody(c, why) {
    c.error = why; c.closure = null; c.key = c.wantKey ?? null;
    statusCurve = c.id;
    say(`${c.name}: ${why}`, true);
}
// The worker is gone (a trap, an error, or the test's kill): another is started, its replica
// opened from the page's save, and every body is answered again, the progress dialog showing
// the rebuild. There is no page-side build. A trap's node (the worker names the node running;
// a trap outside an evaluation names none, and blames no body) is quarantined: the new worker leaves it out -- the body fails
// "the kernel crashed on this node", what reads it is blocked -- until its item's key moves.
// A restart with a new culprit is not counted; one without (a kill, an error, a culprit held
// already) is, and a worker that keeps stopping so is given up on: RESTARTS.most within
// RESTARTS.within ms.
const RESTARTS = { most: 3, within: 10000 };
const restarts = [];
let restartsCounted = 0;   // every counted restart since the page opened (the test's `restarts()`)
function restartWorker(why, { blame = true, body = null, node = null } = {}) {
    if (worker === null && restarts.length >= RESTARTS.most) return;   // already given up on
    // A worker that never answered (its script failed to load) has run nothing: no body is to blame.
    // Only a node the worker named as running (or the test's body) is to blame: a trap outside
    // an evaluation (the View's, a pick's, a resync's) names none, and blames no body.
    const culpritNode = body ? `i${body.id}` : blame && heard ? node : null;
    const culprit = culpritNode !== null ? byId(itemOfNode(culpritNode)) : null;
    const quarantined = culpritNode !== null && quarantine.add(culpritNode, byId(itemOfNode(culpritNode))?.wantKey ?? null);
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    viewReady = false;
    for (const out of exportsOut.values()) out.reject(new Error(`the forge worker stopped (${why})`));
    exportsOut.clear();
    for (const out of testReqs.values()) out.reject(new Error(`the forge worker stopped (${why})`));
    testReqs.clear();
    for (const out of picksOut.values()) out({ error: `the forge worker stopped (${why})` });
    picksOut.clear();
    for (const out of resolvesOut.values()) out(null);
    resolvesOut.clear();
    progress = null; renderProgress();
    const now = performance.now();
    while (restarts.length && now - restarts[0] > RESTARTS.within) restarts.shift();
    if (!quarantined) { restarts.push(now); restartsCounted++; }
    // Every body is answered again by the new worker, under the key it has now.
    for (const c of curves) if (isBody(c)) { c.key = null; c.jobAt = now; }
    if (restarts.length > RESTARTS.most) {
        // Given up on: nothing can be built, so nothing waits for a build.
        for (const c of curves) if (isBody(c) && (c.wantKey ?? null) !== null) failBody(c, "the forge worker is not running");
        say(`the forge worker keeps stopping (${why}) -- reload the page`, true);
        wakeSettled();
        order.release();
        return;
    }
    if (quarantined) say(`the kernel crashed on ${culprit?.name ?? culpritNode} -- it is left out until it changes; rebuilding the rest`, true);
    else say(`the forge worker stopped (${why}) -- rebuilding`, true);
    // The dead worker's View held the cameras, the items and the canvas's drawing: all start
    // over. A canvas hands its drawing to a worker once, so the view gets a new one in the same
    // place (found by its id, beside the overlay), and the wanted list is sent whole again.
    client?.free();
    drag = drag?.kind === "cube" ? null : drag;   // the cube's drag was on the View that is gone
    const fresh = viewCanvas.cloneNode(false);
    viewCanvas.replaceWith(fresh);
    viewCanvas = fresh;
    wanted.reset();
    startWorker();   // makes the new client and opens its replica; its images and, once its View is made, the cameras follow
    schedule();
}
const testMode = new URLSearchParams(location.search).has("test");
let bridgeBytes = 0;   // typed-array bytes received from the forge worker; counted under ?test only
function onWorkerMessage({ data }) {
    heard = true;
    // The View's traffic (frames, answers) is the client's; the bridge count is of the forge's own.
    if (data.kind.startsWith("view.")) { client?.receive(data); return; }
    if (testMode) bridgeBytes += typedBytes(data);
    if (data.kind === "forge.error") { say(data.message, true); return; }
    if (data.kind === "forge.test.result") {
        const out = testReqs.get(data.req);
        testReqs.delete(data.req);
        if (out) { if (data.error !== undefined) out.reject(new Error(data.error)); else out.resolve(data.value); }
        return;
    }
    if (data.kind === "crashed") {
        // The worker names the node whose build trapped (`node`): that node is quarantined. A
        // trap that names no node blames no body.
        restartWorker(data.error ?? data.message ?? "it crashed", data.node ? { node: data.node } : {});
        return;
    }
    if (data.kind === "exported" || data.kind === "exportFailed") {
        const out = exportsOut.get(data.req);
        exportsOut.delete(data.req);
        if (out) { if (data.kind === "exported") out.resolve(data); else out.reject(new Error(data.error)); }
        return;
    }
    if (data.kind === "picked") {
        const out = picksOut.get(data.req);
        picksOut.delete(data.req);
        out?.(data);
        return;
    }
    if (data.kind === "resolved") {
        const out = resolvesOut.get(data.req);
        resolvesOut.delete(data.req);
        out?.(data);
        return;
    }
    if (data.kind === "opFailed") {
        // The worker's replica refused what the page's took (or its evaluation failed): the two
        // have parted, and the worker's is opened again from the page's save. One that cannot
        // even open it is said, not tried again.
        console.error(`forge: the worker's replica refused ${data.what}: ${data.error}`);
        if (data.what === "open") { say(`the forge worker cannot open the document: ${data.error}`, true); return; }
        // An evaluation that fails the same way again is not tried a third time: the bodies out
        // fail with its error until the document changes (`afterChange` counts again).
        if (data.what === "evaluate" && ++reopens >= 2) {
            for (const c of curves) if (bodyPending(c)) failBody(c, `the forge worker cannot evaluate the document: ${data.error}`);
            say(`the forge worker cannot evaluate the document: ${data.error}`, true);
            renderProgress(); renderList(); wakeSettled();
            return;
        }
        for (const c of curves) if (isBody(c)) c.key = null;   // answered again from the open
        openWorkerReplica();
        return;
    }
    if (data.kind === "progress") { progress = { ...data, name: byId(data.id)?.name ?? data.node ?? "" }; renderProgress(); return; }
    if (data.kind === "forgotten") {
        // Bodies that left the worker's replica: their tables go, and only now.
        for (const id of data.ids) {
            bodyResults.delete(id);
            const c = byId(id);
            if (c && !isBody(c)) for (const k of BODY_RESULT_KEYS) delete c[k];
        }
        renderProgress();
        wakeSettled();
        return;
    }
    if (data.kind !== "built" && data.kind !== "failed") return;
    // A body's answer, under the key its node had in the worker: kept whatever its version
    // (a body back to the solid it keeps, and every body on an open, comes at the version it
    // had). A failure keeps the last table; the "no node" one has no key (null).
    const result = data.kind === "built"
        ? { key: data.key ?? null, error: null, version: data.version, bounds: data.table.bounds, closure: data.table.closure, ghostFaces: data.ghostFaces ?? 0,
            gpu: { faceKinds: data.table.faceKinds, frames: data.table.frames, rounds: data.table.rounds, chamfers: data.table.chamfers, edges: data.table.edges,
                   box: data.table.box, edgeOnly: data.table.edgeOnly, faceRefs: data.refs } }
        : { key: data.key ?? null, error: data.error, closure: null };
    const c = byId(data.id);
    bodyResults.set(data.id, { ...bodyResults.get(data.id), ...result, kind: c && isBody(c) ? c.kind : bodyResults.get(data.id)?.kind });
    if (progress?.id === data.id) progress = null;
    renderProgress();
    if (!c || !isBody(c)) { wakeSettled(); return; }
    const before = `${c.error === null}|${closureText(c.closure)}`;
    Object.assign(c, result);
    renderProgress();   // again, now the body holds its answer: the card goes with the last body out
    if (data.kind === "built") {
        statusCurve = null;
        say(`built ${c.name} in ${data.elapsed < 1000 ? `${data.elapsed} ms` : `${(data.elapsed / 1000).toFixed(1)} s`} — ${cadaclysm()}`);
    } else {
        statusCurve = c.id;
        say(`${c.name}: ${c.error}`, true);
    }
    if (before !== `${c.error === null}|${closureText(c.closure)}`) renderList();
    // A sketch on one of its faces moves with it, and what is on that sketch follows.
    schedule();
    // What waits for this answer wakes after the cascade it causes is marked (the sketch that
    // moved with the body, and what is on it), which `rebuild` does.
    if (settledWaiters.length) rebuild();
    wakeSettled();
}

// The progress dialog: which body is being built, the kernel's phase and count, and a
// bar of the whole with the time so far and a guess at the rest -- a card in the middle
// of the page over a dimmed backdrop, while the solid it started from
// stays in the scene (`awaited`). Shown once a body has been out a moment (a drag's
// cheap moves come and go unseen). The worker's `step` of `steps` counts the nodes the
// evaluation computes, in document order -- the moves and frames among them too, which report nothing --
// so the bar is the larger of where the reporting node stands in that order (its phases
// weighted by the share of the time each took on the slowest join measured: snapping
// onto curved surfaces is most of it) and the share of the bodies out at the start that
// have been answered; it only goes forward while bodies are out, and goes when none is.
// The counts are exact, and the time left is `~` for a reason (and not guessed at before
// a tenth).
const PROGRESS_AFTER_MS = 150;
const PHASE_WEIGHTS = {
    join: { meshing: 3, partitioning: 12, clipping: 12, outlining: 3, snapping: 65, facing: 5 },
    shell: { offsetting: 30, snapping: 40, facing: 30 },
};
PHASE_WEIGHTS.cut = PHASE_WEIGHTS.intersect = PHASE_WEIGHTS.join;   // the same boolean, another op
PHASE_WEIGHTS.trim = PHASE_WEIGHTS.join;   // a split is the boolean's own pipeline
PHASE_WEIGHTS.fillet = PHASE_WEIGHTS.join;   // and so is a fillet's cut, per edge
function progressFraction({ op, phase, done, total, step, steps }) {
    const weights = PHASE_WEIGHTS[op] ?? {};
    let before = 0, sum = 0, own = 0;
    for (const [name, w] of Object.entries(weights)) { sum += w; if (name === phase) own = w; else if (!own) before += w; }
    // A node's `start` (it reports before it runs) is the beginning of its step.
    const inPhase = phase === "start" ? 0 : sum ? (before + own * (total ? done / total : 0)) / sum : (total ? done / total : 0);
    return Math.min(1, steps ? (Math.max(0, step) + inPhase) / steps : inPhase);
}
// The bodies out since the bar last stood empty, and how far it has gone: it never goes back.
let progressRun = null;   // { ids: Set, high }
function renderProgress() {
    const now = performance.now();
    const out = curves.filter(bodyPending);
    if (!out.length) { progressRun = null; progress = null; progressEl.hidden = true; return; }
    progressRun ??= { ids: new Set(), high: 0 };
    for (const c of out) progressRun.ids.add(c.id);
    const shown = out.filter((c) => now - (c.jobAt ?? now) >= PROGRESS_AFTER_MS);
    progressEl.hidden = shown.length === 0;
    if (progressEl.hidden) return;
    const p = progress;
    const answered = (progressRun.ids.size - out.length) / progressRun.ids.size;
    const f = progressRun.high = Math.min(1, Math.max(progressRun.high, answered, p ? progressFraction(p) : 0));
    const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
    const name = p?.name || shown[0].name;
    const what = p ? `${p.op} ${Math.max(0, p.step) + 1} of ${p.steps} · ${p.phase} ${p.done} of ${p.total}` : "starting";
    const left = p && f >= 0.1 ? ` · ~${seconds(p.elapsed * (1 - f) / f)} left` : "";
    const more = out.length > 1 ? ` · ${out.length - 1} more queued` : "";
    progressTitleEl.textContent = `building ${name}`;
    progressWhatEl.textContent = what + more;
    progressFillEl.style.width = `${Math.round(f * 100)}%`;
    progressTimeEl.textContent = p ? `${Math.round(f * 100)}% · ${seconds(p.elapsed)}${left}` : "";
}

// Rebuild the dirty curves, then re-assemble the scene from every curve. A curve whose
// build fails keeps its last Béziers and carries the error (a red dot in its row, the
// status line while it is the freshest news); the others are unaffected. The panel is
// only redrawn when a dot changes: a drag rebuilds every frame, and the rows need not.
function rebuild() {
    const started = performance.now();
    const built = [];
    let failed = null, dotsChanged = false;
    const fail = (c, error) => { dotsChanged ||= c.error === null || !!c.closure; c.error = error instanceof Error ? error.message : String(error); c.closure = null; failed = c; };
    const ok = (c, closure = null) => { dotsChanged ||= c.error !== null || closureText(c.closure) !== closureText(closure); c.error = null; c.closure = closure; built.push(c); };
    // The curves, then any sketch whose plane moved with them (its offset or tilt typed,
    // its hinge or path dragged) takes everything on it along -- round again until no
    // plane moves, which a chain of sketches on sketches needs. Then the bodies, and a
    // body rebuilt moves the sketches on its faces: the rounds again, until nothing moves.
    for (let pass = 0; pass < 8; pass++) {
        for (let round = 0; round < 8; round++) {
            buildCurves();
            let moved = false;
            for (const sk of curves.filter(isSketch)) {
                const sig = frameSig(sk.id);
                if (sig === sk.sig) continue;
                sk.sig = sig; moved = true; dotsChanged = true;   // its row's tag may say "path gone" until its path is built
                for (const c of curves) if (c.plane === sk.id && isCurve(c)) c.dirty = true;   // a body on it follows in the worker: its frame is the document's
                const v = VIEW_PLANE_KEYS.find((k) => viewPlane[k] === sk.id);
                if (v !== undefined && !planeInfo(sk.id).base) { aimCamera(v); }
            }
            if (!moved) break;
        }
        break;   // a body is built in the worker; its answer rebuilds, and moves the sketches on its faces
    }
    function buildCurves() { for (const c of curves) {
        // Only a curve is built here: a body, a sketch or an image marked is answered for elsewhere.
        if (!isCurve(c)) { c.dirty = false; continue; }
        if (!c.dirty) continue;
        c.dirty = false;
        touchSketch(c.plane);   // a shape or kind changed, or a curve added: its sketch's diagnosis is stale
        try {
            c.sketch = beziersOf(c);
            c.beziers = embedBeziers(wasm, c.sketch, frame9(c.plane));
            // What the worker's copy of the Béziers is keyed by: page-wide, so a curve made
            // again by a replay or a load (a new item, same id) never matches the old one's.
            c.rev = ++curveRevs;
        } catch (error) {
            fail(c, error);
            continue;
        }
        c.bounds = boundsOf(c);
        // Drawn, but the document's own evaluation refuses it: its error is the curve's.
        if (c.docError) fail(c, c.docError); else ok(c);
    } }
    // The page's items as they differ from the document's (a drag's frame), previewed.
    livePreview();
    if (dotsChanged) renderList();
    show();
    if (failed) { statusCurve = failed.id; say(`${failed.name}: ${failed.error}`, true); }
    else if (built.length) {
        statusCurve = null;
        sayDof(`built ${built.map((c) => c.name).join(", ")} in ${(performance.now() - started).toFixed(1)} ms — ${cadaclysm()}`);
    } else sayDof(null);
    overlayDirty();
    wakeSettled();
}

// Hand every body, curve and image to the View -- a curve as Béziers alone, the
// selected one in the accent -- over the union of their bounds, and write the stats line.
// The cameras are never placed from here: a curve is laid down where the Top view already
// looks, a first point is no size to frame to, and F frames the document whenever asked.
// The radius is the viewports' depth range as well as F's, so it is held at a sketch's
// scale for a document of a point.
let statusCurve = null;  // the id of the curve the status line's error is about, or null
// The overlay's outline grey and accent, in linear as every colour here is; a closed
// curve is drawn brighter than an open one, so what the sketch has closed reads at a
// glance in every view. A surface is the glossy style's plastic, its `grey`
// (0.82, 0.82, 0.83) in sRGB, in linear as bevy's `Patch.color` is; a selected one a
// warmer grey.
const BODY = [0.646, 0.646, 0.664, 1.0];
const SELECTED_BODY = [0.70, 0.66, 0.58, 1.0];
// A body's look: its colour (sRGB hex) and its material, kept on the item as `look`
// and set by the dialog (a `set` command, so it is in the history and the file). A
// feature without a look of its own wears its input's (a chamfer of a red solid is
// red), so the look set on the body row carries down its chain. The material goes
// to the View by name; `LOOKS` is the set of the names it knows.
const LOOKS = new Set(["plastic", "metal", "matte", "paint", "brushed", "glass"]);
const DEFAULT_LOOK = { colour: "#a5a5a9", material: "plastic", opacity: 0.35 };
function lookOf(c) {
    for (let b = c, guard = 0; b && guard < 64; guard++) {
        if (b.look) return { ...DEFAULT_LOOK, ...b.look };
        const input = b.parts?.[0] ?? b.from;
        b = input !== undefined ? byId(input) : null;
    }
    return DEFAULT_LOOK;
}
// How the View draws a body: its look's colour in linear light, the look's material by
// name and, for glass, its opacity. Never the selection tint -- that goes through the
// per-face colours (`tintOf`, `faceColoursOver`) so selecting a body recolours it without
// an upload.
// A body with no look of its own (`lookOf` gives DEFAULT_LOOK) under studio or the showroom
// goes with no material -- the View's default, the one its lighting lights; under the headlight
// it stays plastic, as the forge has always drawn it.
function bodyColour(c) {
    const look = lookOf(c);
    const rgb = linear(look.colour);
    if (look === DEFAULT_LOOK && lighting !== "headlight") return { colour: rgb.slice(0, 3), material: undefined, opacity: 1 };
    const material = LOOKS.has(look.material) ? look.material : "plastic";
    const opacity = material === "glass" ? Math.min(0.95, Math.max(0.05, look.opacity ?? 0.35)) : 1;
    return { colour: rgb.slice(0, 3), material, opacity };
}
// Whether a selected body wears the tint: not the body whose faces are being picked by
// shell or trim, so its own colour lets the faces lit for the pick (`faceColoursOf`)
// stand out from the rest of it.
const tinted = (c) => isSelected(c) && shellMode?.body !== c && trimMode?.body !== c;
// A body's own colour warmed towards the accent, for a selected body's face tint.
function tintOf(rgb) {
    const accent = linear(ACCENT);
    return [0, 1, 2].map((k) => 0.65 * rgb[k] + 0.35 * accent[k]);
}
const GHOST = [0.26, 0.26, 0.25];        // a trim's dropped pieces while it is being picked
const HOVER_EDGE = "#9CD3FF";            // the edge under the pointer while a fillet's are picked: the accent, lighter
const linear = (hex) => [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).concat(1);
// A linear colour as the View takes it: [r, g, b] sRGB-encoded. The View writes the
// colours it is handed straight to a canvas it keeps out of sRGB (its clear colour too),
// where the forge's own retired WebGPU renderer had an sRGB view encode them on the
// way out -- so the forge's colours, worked out in linear light, are encoded on the way in.
const encoded = (rgb) => [0, 1, 2].map((k) => { const c = Math.min(Math.max(rgb[k], 0), 1); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; });
// A face-colour map (`faceColoursOf`'s) encoded the same way, or undefined for none.
const encodedFaces = (colours) => colours && Object.fromEntries(Object.entries(colours).map(([k, v]) => [k, encoded(v)]));
const CURVE = linear(OUTLINE_COLOUR), CLOSED_CURVE = linear(HANDLE_COLOUR), SELECTED_CURVE = linear(ACCENT), HOVER_CURVE = linear(HOVER_EDGE);
// A curve of a constrained sketch still free to move: a grey blue, apart from the
// selection's accent and the hover's light blue.
const FREE_CURVE = linear("#8AA4C8");
const ISO_CURVE = linear("#5F5E5A");
const TRIM_PIECE = linear("#ff5a5a");   // the piece a sketch trim would remove, red     // a face's isoparametric lines: a grey lighter than the edges' black

// The closed-curve detection, redone whenever the scene is: `loops` is a list of loops,
// each the ids of the curves that join end to end into it (one id for a curve that
// closes on itself), `loopOf` the loop number a curve is in. Ends meet within a
// micrometre -- a snapped end is the other's exact coordinates, and the tolerance only
// absorbs the arithmetic in between (`LOOP_TOLERANCE`, in forge-curves.js). A curve with no
// ends is closed by kind.
let loops = [], loopOf = new Map();
function detect(shown) {
    loops = []; loopOf = new Map();
    // Plane by plane: ends meet in one sketch plane, never across two.
    for (const plane of new Set(shown.filter(isCurve).map((c) => c.plane))) {
        const open = shown.filter((c) => isCurve(c) && c.plane === plane && endsOf(c) !== null);
        if (!open.length) continue;
        const ends = new Float64Array(open.length * 4);
        open.forEach((c, i) => { const [a, b] = endsOf(c); ends.set([a[0], a[1], b[0], b[1]], i * 4); });
        const flat = detectLoops(wasm, ends, LOOP_TOLERANCE);
        for (let at = 0; at < flat.length;) {
            const n = flat[at++];
            const ids = Array.from(flat.subarray(at, at + n), (i) => open[i].id);
            at += n;
            loops.push(ids);
            for (const id of ids) loopOf.set(id, loops.length);
        }
    }
}
// Closed by kind: no ends, and not merely a single point with nothing to join yet.
const closedByKind = (c) => isCurve(c) && endsOf(c) === null && !(pointed(c) && c.shape.points.length < 2);
const isClosed = (c) => closedByKind(c) || loopOf.has(c.id);
// The row's tag: what the detection says of the curve, or a surface's holes.
function tagOf(c) {
    if (isSketch(c)) {
        const ref = (id) => curves.find((k) => k.id === id)?.name;
        if (c.mode === "offset") return `${PLANES[c.base].name} ${c.offset < 0 ? "−" : "+"} ${Math.abs(c.offset)}`;
        if (c.mode === "angle" && c.hinge === null) return "pick a hinge";
        if (c.mode === "path" && c.path === null) return "pick a path";
        if (c.mode === "face" && c.face === null) return "pick a face";
        if (c.mode === "mid" && !c.mid) return "pick two planes";
        if (c.mode === "points" && !c.points) return "pick three points";
        if (planeInfo(c.id).broken) return { angle: "hinge gone", path: "path gone", face: "face gone", mid: "no midplane", points: "no plane through" }[c.mode];
        if (c.mode === "face") return `on ${ref(c.face.body)} · face ${c.face.index + 1}`;
        if (c.mode === "mid") return `between ${c.mid.map((r) => typeof r === "object" ? `${ref(r.body)} · face ${r.index + 1}` : PLANES[r]?.name ?? ref(r)).join(" and ")}`;
        if (c.mode === "points") return `through ${c.points.map((e) => `${ref(e.curve)} ${e.end ? "end" : "start"}`).join(", ")}`;
        return c.mode === "angle" ? `on ${ref(c.hinge)} · ${c.tilt}°` : `across ${ref(c.path)}`;
    }
    return tagText(c);
}
function tagText(c) {
    if (isBody(c)) {
        const bits = [];
        if (c.kind === "extrusion" || c.kind === "solid" || c.kind === "prism" || c.kind === "press") bits.push(`h ${c.height}${c.taper ? ` · ${c.taper}°` : ""}`);
        if (c.kind === "revolution") bits.push(`${c.angle}°`);
        if (c.kind === "sweep") bits.push(`along ${byId(c.path)?.name ?? "?"}`);
        if (c.kind === "loft") bits.push(`${c.via?.length ? `through ${c.via.map((v) => v.name).join(", ")} ` : ""}to ${c.to.name}`);
        if ((c.source && !c.loops) || c.parts?.some((p) => typeof p === "object")) bits.push("frozen");   // a version-1 body: its sources baked, following nothing
        if (c.kind === "join") bits.push(`${c.parts.length} parts`);
        if (c.kind === "cut" || c.kind === "intersect") bits.push(`${c.parts.length} parts`);
        if (c.kind === "shell") bits.push(`t ${c.thickness}${c.open.length ? ` · ${c.open.length} open` : ""}`);
        if (c.kind === "thicken") bits.push(`t ${c.thickness}`);
        if (c.kind === "trim") bits.push(c.drop.length ? `${c.drop.length} removed` : "whole");
        if (c.kind === "fillet") bits.push(`${c.style === "chamfer" ? "c" : "r"} ${c.radius}${c.edges.length ? ` · ${c.edges.length} edge${c.edges.length === 1 ? "" : "s"}` : " · no edges"}`);
        if (c.holes) bits.push(`${c.holes} hole${c.holes === 1 ? "" : "s"}`);
        return bits.join(" · ");
    }
    if (c.kind === "polycurve") return `${c.shape.pieces.length} pieces${closedByKind(c) ? " · closed" : loopOf.has(c.id) ? ` · loop ${loopOf.get(c.id)}` : ""}`;
    if (closedByKind(c)) return "closed";
    const n = loopOf.get(c.id);
    if (n === undefined) return "";
    return loops[n - 1].length === 1 ? "closed" : `loop ${n}`;
}
function show() {
    renderProps();
    stlEl.disabled = glbEl.disabled = objEl.disabled = stepEl.disabled = !curves.some((c) => isSolid(c) && c.gpu && c.error === null);   // a build made a solid to export
    for (const c of curves) if (isImage(c)) c.bounds = imageBounds(c);
    const shown = curves.filter((c) => c.bounds !== null && visible(c));
    const bodies = shown.filter(isBody), sketch = shown.filter(isCurve), images = shown.filter(isImage);
    if (shown.length) {
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const { bounds: b } of shown) {
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.centre[k] - b.radius); hi[k] = Math.max(hi[k], b.centre[k] + b.radius); }
        }
        centre = lo.map((v, k) => (v + hi[k]) / 2);
        sceneCentre = centre;
        radius = 25;
        for (const { bounds: b } of shown) {
            radius = Math.max(radius, Math.hypot(b.centre[0] - centre[0], b.centre[1] - centre[1], b.centre[2] - centre[2]) + b.radius);
        }
        syncPivot();
        followRadius();
    }
    const tags = () => curves.map((c) => `${tagOf(c)}${isSketch(c) ? dofText(c) : ""}`).join("|");
    const before = tags();
    detect(sketch);
    refreshDiagnoses();
    if (tags() !== before) renderList();
    syncSurfaceButton();
    // Bodies, their ghosts, the sketch's curves, the trim preview and the reference images are
    // what the page wants shown, by key and dependencies (forge-items.js, in the worker): only a
    // key whose dependencies changed sends its payload again. Every colour is handed over
    // sRGB-encoded (`encoded`). A curve-like item's colour (a sketch curve's hover and selection,
    // the trim piece, the isocurves) is its `colour`, not a dependency: a change is sent with
    // `setColour`, in place, rather than showing the curves again.
    const out = [];
    for (const c of bodies) {
        if (!c.gpu) continue;
        const own = bodyColour(c);
        const look = { colour: encoded(own.colour), material: own.material, opacity: own.opacity };
        if (!c.gpu.edgeOnly) {
            // The tint (a selected body, warmed towards the accent) fills every face; the
            // hover and the shell pick's highlights, lit from what the face already shows,
            // override it -- both through `faceColoursOver`, so a click never re-uploads.
            const tint = tinted(c) ? tintOf(own.colour) : undefined;
            const faceCount = c.gpu.faceKinds.length;
            out.push({ key: `body:${c.id}`, deps: [look.colour.join(), look.material, look.opacity], kind: "body", body: c.id, look,
                       faceColours: encodedFaces(faceColoursOver(faceCount, tint, faceColoursOf(c, tint ?? own.colour))) });
        } else out.push({ key: `body:${c.id}`, deps: [], kind: "body", body: c.id, look });   // no exact face: its edges, as curves
        if (showIsocurves) out.push({ key: `iso:${c.id}`, deps: [], kind: "isocurves", body: c.id, colour: encoded(ISO_CURVE) });
    }
    for (const c of ghosted()) out.push({ key: `ghost:${c.id}`, deps: [], kind: "ghost", body: c.id, faceColours: encodedFaces(faceColoursOf(c, GHOST, true)) });
    const lit = hoverConstraintCurves();
    for (const c of sketch) {
        if (!c.beziers?.length) continue;
        const free = diagnoses.get(c.plane)?.freeCurves.has(c.id);
        const colour = encoded((c === hoverCurve || lit.has(c.id)) && !isSelected(c) ? HOVER_CURVE : isSelected(c) ? SELECTED_CURVE : free ? FREE_CURVE : isClosed(c) ? CLOSED_CURVE : CURVE);
        out.push({ key: `curve:${c.id}`, deps: [c.rev], kind: "curves", colour, ref: c });
    }
    const piece = sketchTrim?.hover && sketchTrim.pieces.get(sketchTrim.hover.id)?.[sketchTrim.hover.k];
    if (piece) out.push({ key: "trim-piece", deps: [sketchTrim.hover.id, sketchTrim.hover.k, sketchTrim.rev], kind: "curves", colour: encoded(TRIM_PIECE), ref: piece });
    if (imagesLayerEl.checked) {
        for (const c of images) {
            if (!imageBitmaps.has(c.id)) continue;   // still decoding: shown once it is
            // `imageCorners` runs round the quad from its top-left; the View takes the
            // corners from the bottom-left (bottom-left, bottom-right, top-right, top-left).
            const at = imageCorners(c);
            const corners = [3, 2, 1, 0].map((k) => Array.from(at.subarray(k * 3, k * 3 + 3)));
            out.push({ key: `image:${c.id}`, deps: [JSON.stringify(corners), c.opacity, !!c.flipX, !!c.flipY, imageGens.get(c.id)], kind: "image", image: c.id, corners, opacity: c.opacity, flipX: !!c.flipX, flipY: !!c.flipY });
        }
    }
    wanted.send(out, (it) => it.kind === "curves" ? { beziers: it.ref.beziers ?? it.ref.world } : {});
    const spans = sketch.reduce((n, c) => n + c.beziers.length / 16, 0);
    const closed = sketch.filter(isClosed).length;
    const chains = loops.filter((l) => l.length > 1).length;
    const parts = [];
    if (sketch.length) {
        parts.push(`${sketch.length} curve${sketch.length === 1 ? "" : "s"} · ${spans} exact span${spans === 1 ? "" : "s"} · ${closed} closed` +
            (chains ? ` · ${chains} loop${chains === 1 ? "" : "s"} of several` : ""));
    }
    const solids = bodies.filter(isSolid).length, sheets = bodies.length - solids;
    if (sheets) parts.push(`${sheets} surface${sheets === 1 ? "" : "s"}`);
    const open = bodies.filter(notClosed).length;
    if (solids) parts.push(`${solids} solid${solids === 1 ? "" : "s"}${open ? ` (${open} not closed)` : ""}`);
    statsEl.textContent = parts.join(" · ");
}
// The surface button follows the detection as well as the selection: a loop closed by a
// drag enables it without a new click in the panel.
function syncSurfaceButton() { syncModifyButtons(); syncSolidButtons(); }
// The Solid tab, as the Sketch tab's modify: loft always there (it picks its profiles);
// join, cut and intersect lit while the selection holds a solid they can start from --
// pressed with enough selected they run, with less they pick the rest.
function syncSolidButtons() {
    const solids = selectedCurves().filter(isSolid);
    loftEl.disabled = false;
    loftEl.setAttribute("aria-pressed", String(sketchPick?.kind === "loft"));
    joinEl.disabled = sketchPick?.kind !== "join" && solids.length < 1;
    joinEl.setAttribute("aria-pressed", String(sketchPick?.kind === "join"));
    for (const [el, op] of [[cutEl, "cut"], [intersectEl, "intersect"]]) {
        el.disabled = sketchPick?.kind !== op && combineParts() === null && solids.length !== 1;
        el.setAttribute("aria-pressed", String(sketchPick?.kind === op));
    }
    trimEl.setAttribute("aria-pressed", String(!!trimMode || sketchPick?.kind === "trim"));
}
// The sketch's modify tools work on what is selected: each is enabled while the
// selection holds something it takes (a closable curve, a polycurve, a mergeable
// curve, a closed curve or a loop of several for surface) -- or while it is the
// tool picking, so its button can put it down. A click runs it on the selection
// when that is enough, and picks the rest in the views when it is not (merge's
// second curve).
const modifies = (kind) => sketchPick?.kind === kind || (kind === "surface" ? loopsOfSelection().length > 0 : selectedCurves().some((k) => pickAccepts(kind, [], k)));
function syncModifyButtons() {
    sketchTrimEl.disabled = !sketchTrim && !selectedCurves().some(trimmable);
    sketchTrimEl.setAttribute("aria-pressed", String(!!sketchTrim));
    closedEl.disabled = !modifies("close");
    explodeEl.disabled = !modifies("explode");
    mergeEl.disabled = !modifies("merge");
    surfaceEl.disabled = !modifies("surface");
    sketchFilletEl.disabled = !modifies("fillet");
}

// ------------------------------------------------------------------ the file

// The file is the blacksmith document's own text (`cadaclysm_blacksmith_document_save`): its
// nodes, its params and its whole history, the undone tails and the branches too. Anything
// else is refused in words: a forge file of before (`cadaclysm-forge`, version 1 to 3) is
// "not a cadaclysm-blacksmith document: its format is ..." The reference images are the
// session's and never in it. Loading replaces the document whole: every view looks at
// its origin plane, nothing is selected, and the worker opens the same text, so both replicas
// start from the same bytes.
function documentJson() {
    flushPending();
    return wasm.cadaclysm_blacksmith_document_save(doc);
}
// The first item id no commit of `d`'s tree has used: an id is never used again (ids are
// unique, stable, never reused), not even one an undone line or another branch holds, so an
// undo, a redo or a switch never lowers `nextId`. Read off the save: every node id `i<n>`
// (and its helpers `i<n>_<role>`) any commit names.
function idsAfter(d) {
    let top = 0;
    for (const m of wasm.cadaclysm_blacksmith_document_save(d).matchAll(/"i(\d+)(?:_[^"]*)?"/g)) top = Math.max(top, +m[1]);
    return top + 1;
}
function loadDocument(text) {
    // All of it in the order's turn: what the document was stays until what is in flight is done.
    return act(async () => {
        const opened = forgeDoc.openDocument(wasm, text);   // throws for what is no document
        pendingRun = null;
        endPreview();
        const old = doc;
        doc = opened;
        if (old !== null) wasm.cadaclysm_blacksmith_document_free(old);
        // A tool session or a pick left open belongs to the document that was: dropped, or
        // its Cancel would roll the loaded history back to where that session began.
        tool = null;
        disarmSketchPick();
        selection = []; selected = null;
        chainSeen.clear();
        curves = [];
        nextId = idsAfter(opened);   // another document: past every id it ever gave (the sync bumps past what stands)
        bodyResults.clear();
        progress = null;
        quarantine.clear();   // another document: nothing of it has crashed yet
        undoOrder.reset();
        openWorkerReplica();
        afterChange({ reset: true });
    });
}
// Save and load go through the browser's file pickers (the File System Access API,
// Chrome and Edge): the first save asks where, and the file's handle is kept so the next
// saves write the same file back, as "load" keeps the handle of what it opened. Where the
// API is missing (Firefox, Safari) a save is a download and a load the file input. Where
// no dialog can open at all -- the page in a sandboxed cross-origin frame, as an artifact
// is, which forbids the pickers and swallows downloads -- the document goes through a
// text box: copied out on a save, pasted in on a load.
const PICKER = { types: [{ description: "forge document", accept: { "application/json": [".json"] } }] };
let fileHandle = null;
const framed = window.self !== window.top;
const textFileEl = document.getElementById("text-file");
const textFileTitle = document.getElementById("text-file-title");
const textFileBody = document.getElementById("text-file-body");
function textFile(mode, text = "") {
    textFileTitle.textContent = mode === "save"
        ? "no file dialog can open here -- copy this document and keep it as a .json file"
        : "no file dialog can open here -- paste a document's .json here and load it";
    textFileBody.value = text;
    document.getElementById("text-file-copy").hidden = mode !== "save";
    document.getElementById("text-file-load").hidden = mode !== "load";
    textFileEl.showModal();
    if (mode === "save") textFileBody.select(); else textFileBody.focus();
}
document.getElementById("text-file-close").addEventListener("click", () => textFileEl.close());
document.getElementById("text-file-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(textFileBody.value); say("document copied"); }
    catch { textFileBody.select(); say("select the text and copy it", true); }
});
document.getElementById("text-file-load").addEventListener("click", async () => {
    try { await loadDocument(textFileBody.value); textFileEl.close(); say(`loaded ${curves.length} item${curves.length === 1 ? "" : "s"}`); }
    catch (error) { say(`load: ${error.message || error}`, true); }
});
textFileEl.addEventListener("keydown", (e) => e.stopPropagation());   // typing in the box is not the page's keys
// The exports (STL, GLB, OBJ, and STEP exact): the selected solids -- every solid, with none selected --
// meshed now at `STL_TOLERANCE` (chord deviation, millimetres, for all three formats)
// into one file. Where no download can start (the page in a frame), the text form goes
// into the dialog to be copied out instead. The mesh is made for the file and kept nowhere.
const STL_TOLERANCE = 0.02;
// The bodies an export takes: the selected solids, else every visible one -- those the worker
// has built.
function exportBodies() {
    const picked = selectedCurves().filter((c) => isSolid(c) && c.gpu && c.error === null);
    return picked.length ? picked : curves.filter((c) => isSolid(c) && c.gpu && c.error === null && visible(c));
}
// The glb's materials: metallic and roughness by kind.
const GLTF_LOOKS = { plastic: [0, 0.5], metal: [1, 0.3], matte: [0, 0.9], paint: [0, 0.25], brushed: [1, 0.6], glass: [0, 0.1] };
// The export's file, made in the worker (which holds the solids) and not downloaded: a promise of
// `{ name, bodies, triangles, bytes }` (name without its extension), or null when nothing is
// exportable. `bytes` is the binary file, or with `text` the UTF-8 of its text form (an STL's ASCII,
// a GLB's .gltf; an OBJ is text always). A worker that stops meanwhile rejects it.
let exportReq = 0;
const exportsOut = new Map();
async function exportFile(format, { text = false } = {}) {
    // Every body answered for first -- the dirty ones posted, the ones out landed -- so the file
    // is of the document as it is, not as it was a build ago.
    await whenBuilt(curves.filter(isBody).map((c) => c.id));
    const bodies = exportBodies();
    if (!bodies.length) return null;
    if (!worker) throw new Error("the forge worker is not running");
    const req = ++exportReq;
    // The body's look as PBR: its swatch in linear light, its material kind as the
    // metallic/roughness pair, glass carrying its opacity as the alpha.
    const looks = Object.fromEntries(bodies.map((c) => {
        const look = lookOf(c);
        const [r, g, b] = linear(look.colour);
        const [metallic, roughness] = GLTF_LOOKS[look.material] ?? GLTF_LOOKS.plastic;
        return [c.id, [r, g, b, look.material === "glass" ? Math.min(0.95, Math.max(0.05, look.opacity ?? 0.35)) : 1, metallic, roughness]];
    }));
    const names = Object.fromEntries(bodies.map((c) => [c.id, c.name]));
    names.file = bodies.length === 1 ? bodies[0].name.replace(/\s+/g, "-").toLowerCase() : "forge";
    worker.postMessage({ kind: "export", req, format, ids: bodies.map((c) => c.id), names, looks, text, tolerance: STL_TOLERANCE });
    return new Promise((resolve, reject) => exportsOut.set(req, { resolve, reject }));
}
// One export clicked: the file downloaded, or where no download can start (the page in a
// frame) its text put into the dialog to be copied out instead. The mesh is made for the
// file and kept nowhere. The glb is each body its own named node; the obj has no .mtl, so no
// colours, since a download is one file and an OBJ that names a library is two. The step is
// no mesh: the bodies' exact B-reps, each a part named as its body.
async function exportAs(format, mime, what) {
    let out;
    try { out = await exportFile(format, { text: framed }); } catch (error) { say(`export: ${error.message || error}`, true); return; }
    if (!out) { say("nothing to export: no solid is built", true); return; }
    const step = format === "step";
    if (framed) { textFile("save", new TextDecoder().decode(out.bytes)); say(`${step ? `${out.bodies} solid${out.bodies === 1 ? "" : "s"}` : `${out.triangles} triangles`} as ${what} -- copy it out`); return; }
    const url = URL.createObjectURL(new Blob([out.bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = `${out.name}.${format}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`${out.name}.${format}: ${out.bodies} solid${out.bodies === 1 ? "" : "s"}${step ? ", exact" : `, ${out.triangles} triangles at ${STL_TOLERANCE} mm`}`);
}
stlEl.addEventListener("click", () => exportAs("stl", "model/stl", "ASCII STL"));
glbEl.addEventListener("click", () => exportAs("glb", "model/gltf-binary", ".gltf"));
objEl.addEventListener("click", () => exportAs("obj", "model/obj", "OBJ"));
stepEl.addEventListener("click", () => exportAs("step", "model/step", "STEP"));
async function saveDocument(asNew = false) {
    const text = await userAct(() => documentJson());   // in the order's turn: a pending run's commit is a command
    if (framed) { textFile("save", text); return; }
    try {
        if (window.showSaveFilePicker) {
            if (!fileHandle || asNew) fileHandle = await window.showSaveFilePicker({ suggestedName: fileHandle?.name ?? "forge.json", ...PICKER });
            const stream = await fileHandle.createWritable();
            await stream.write(text);
            await stream.close();
            say(`${fileHandle.name}: ${curves.length} item${curves.length === 1 ? "" : "s"} saved`);
            return;
        }
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url; a.download = "forge.json"; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);   // Firefox starts the download after `click` returns
        say(`forge.json: ${curves.length} item${curves.length === 1 ? "" : "s"}`);
    } catch (error) {
        if (error?.name === "AbortError") return;   // the picker was cancelled
        say(`save: ${error.message || error}`, true);
    }
}
async function openDocument() {
    if (framed) { textFile("load"); return; }
    try {
        let file;
        if (window.showOpenFilePicker) {
            [fileHandle] = await window.showOpenFilePicker({ multiple: false, ...PICKER });
            file = await fileHandle.getFile();
        } else {
            file = await new Promise((resolve) => {
                loadFileEl.onchange = () => { resolve(loadFileEl.files?.[0] ?? null); loadFileEl.value = ""; };
                loadFileEl.click();
            });
            if (!file) return;
        }
        await loadDocument(await file.text());
        say(`${file.name}: ${curves.length} item${curves.length === 1 ? "" : "s"}`);
    } catch (error) {
        if (error?.name === "AbortError") return;
        say(`load: ${error.message || error}`, true);
    }
}
saveEl.addEventListener("click", () => saveDocument(false));
loadEl.addEventListener("click", openDocument);
// Save-as: ctrl/cmd-shift-S asks where again; ctrl/cmd-S saves back to the file.
addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") { e.preventDefault(); saveDocument(e.shiftKey); }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyO") { e.preventDefault(); openDocument(); }
    // Undo and redo, from anywhere but a field being typed in (that undo is the field's).
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyY" && !typing) { e.preventDefault(); redo(); }
});

// ------------------------------------------------------------------ go

syncToolbar();
renderList();
// The rects follow the container; the maximized state survives a resize since `layout`
// recomputes from it. The overlay is repainted by itself here (the names and borders alone,
// before the View has drawn a frame); afterwards each frame the worker reports repaints it.
new ResizeObserver(() => { pushViewports(); overlayDirty(); }).observe(viewsEl);
// Painted before the wasm and the View resolve, so the views have their names and
// borders while they load (and under the red status line if either fails): `drawOverlay`
// touches only the document (nothing built yet, so nothing but handles), the cameras and
// the 2D canvas, never `viewer` or the wasm module.
drawOverlay();

try {
    await wasm.load();
} catch (error) {
    say(`the wasm failed to load (${error.message || error}). Run "npm run setup" to put the cadaclysm web package in pkg/, then reload.`, true);
    throw error;
}
// The forge draws in its worker, on an OffscreenCanvas: a browser without one draws nothing
// here (there is no page-side View to fall back on).
if (!("transferControlToOffscreen" in HTMLCanvasElement.prototype) || typeof Worker === "undefined") {
    say("this browser cannot draw the forge in a worker (no OffscreenCanvas or Worker)", true);
    throw new Error("no OffscreenCanvas");
}
// The page's replica: an empty document until one is loaded; the worker opens its own from
// the page's save as it starts.
doc = wasm.cadaclysm_blacksmith_document_new(UNITS);
afterChange();
startWorker();
// The page's own controls wait behind a command or action in flight; the view's own input and
// typing into a field do not. A hung build cannot lock them for good: after HELD_MS the held
// events go through, said on the status line (`armRelease`).
const HELD_MS = 10000;
let releaseTimer = null;
function armRelease() {
    if (releaseTimer !== null) return;
    releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (!order.busy) return;
        say("still building -- the controls are let through now", true);
        order.release();
    }, HELD_MS);
    order.idle().then(() => { clearTimeout(releaseTimer); releaseTimer = null; });
}
deferWhileBusy(document, order, (e) => {
    const through = (e.target === overlay && e.type !== "click" && e.type !== "dblclick")
        || (e.type.startsWith("key") && (MOVE_CODES.has(e.code) || e.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "") && e.target.type !== "checkbox" && e.target.type !== "radio"));
    if (!through) armRelease();
    return through;
});

// ?test: what the headless check (test/browser.mjs) reads and loads; absent otherwise.
// Installed once the first View is made, so the hook's presence says the view is up. The
// View is in the worker: what is read from it (`cameras`, `flying`) is asked of the worker
// (`testOp`, forge-cameras.js) and answers a promise, as does `refuse`.
const testReqs = new Map();
let testReq = 0;
function testOp(op, name, extra = {}) {
    return new Promise((resolve, reject) => {
        if (!worker) { reject(new Error("the forge worker is not running")); return; }
        const req = ++testReq;
        testReqs.set(req, { resolve, reject });
        worker.postMessage({ kind: "forge.test", req, op, name, ...extra });
    });
}
function killNow() { worker.terminate(); restartWorker("killed by the test", { blame: false }); }
function installTestHook() {
    if (window.__forgeTest) return;
    window.__forgeTest = {
        radius: () => radius, cameras: () => testOp("cameras"), backend: () => viewBackend, version: () => version(), cadaclysm: () => cadaclysm(),
        flying: () => testOp("flying"),
        // What the worker's View says it lights with (its `lighting` getter, across the bridge).
        lighting: () => viewer.lighting(),
        // The named View call refuses from now on, as a value it will not take would.
        refuse: (name) => testOp("refuse", name),
        stats: () => statsEl.textContent,
        // Loads a document's text and resolves once every body has been answered for.
        async load(text) { await loadDocument(text); await window.__forgeTest.settled(); },
        // Resolves when no body is out in the worker, no command or action is in flight and
        // nothing is previewed -- a pending run (a typed field's, a colour's) committed first, in
        // the order's turn, so `history()` and `items()` agree once it resolves.
        async settled() {
            await userAct(() => flushPending());
            return new Promise((resolve, reject) => {
                const deadline = performance.now() + 120000;   // a stuck body rejects; it must not hang the script's evaluate
                const check = () => (!curves.some(bodyPending) && !curves.some((c) => c.dirty) && previewOp === null && !order.busy) ? resolve()
                    : performance.now() > deadline ? reject(new Error("settled: a body is still dirty or out after 120 s")) : setTimeout(check, 50);
                check();
            });
        },
        // Each body as the page holds it: what a replay must give again.
        bodies: () => curves.filter(isBody).map((c) => ({ id: c.id, name: c.name, kind: c.kind, error: c.error,
            faces: c.gpu ? c.gpu.faceKinds.length : null,
            bounds: c.bounds ? { centre: c.bounds.centre.map((v) => +v.toFixed(4)), radius: +c.bounds.radius.toFixed(4) } : null,
            closure: c.closure ?? null })),
        // Every body's figures (test/fixtures/forge-pins.json): the kept solid's volume and area (its mass properties),
        // faces and edges, asked of the worker, with the page's own kind, error and bounds.
        async figures() {
            const bodies = curves.filter(isBody);
            const kept = await testOp("figures", undefined, { ids: bodies.map((c) => c.id) });
            return bodies.map((c) => ({ id: c.id, kind: c.kind, error: c.error ?? null, volume: kept[c.id]?.volume ?? null,
                area: kept[c.id]?.area ?? null, faces: kept[c.id]?.faces ?? null, edges: kept[c.id]?.edges ?? null,
                bounds: c.bounds ? { centre: [...c.bounds.centre], radius: c.bounds.radius } : null }));
        },
        // Every item as the document holds it: the runtime fields (cache, gpu, job, dirty, ...) dropped.
        items: () => JSON.parse(JSON.stringify(curves, (key, v) => RUNTIME_KEYS.has(key) ? undefined : v)),
        // The export's bytes, base64, and its counts.
        async exportBase64(format) {
            const out = await exportFile(format, { text: false });
            if (!out) return null;
            let s = ""; for (const b of out.bytes) s += String.fromCharCode(b);
            return { name: out.name, bodies: out.bodies, triangles: out.triangles, base64: btoa(s) };
        },
        // The body face under a CSS pixel of view `i` (overlay coordinates).
        async pick(i, x, y) { const hit = await pickBody(i, [x, y]); return hit ? { body: hit.body.id, index: hit.index, ghost: !!hit.ghost } : null; },
        // Typed-array bytes the page has received from the forge worker so far (the View's own
        // traffic, `view.*`, is not counted).
        bridgeBytes: () => bridgeBytes,
        run: (cmd) => run(cmd),
        nextId: () => nextId,
        undo: () => undo(),
        redo: () => redo(),
        // A drag's commit of body `id` as it is now, to be applied later (`commitLater`).
        dragCommitter: (id) => { const c = byId(id), at = resets; return () => noteLater(c, ["transform"], false, at); },
        // The forge worker killed (not a trap): another is started and every body posted again.
        killWorker: () => { const out = curves.filter(bodyPending).length; killNow(); return out; },
        pendingJobs: () => curves.filter(bodyPending).length,
        // The status line's text and whether it is said as an error.
        status: () => ({ text: statusEl.textContent, error: statusEl.classList.contains("error") }),
        // A View call out (it answers across the worker) when the worker is killed: the line the
        // restart said is what stays.
        async callAcrossRestart() {
            viewerCall(() => viewer.camera(0));
            killNow();
            await new Promise((r) => setTimeout(r, 0));   // the freed call's refusal has come by now
            return { text: statusEl.textContent, error: statusEl.classList.contains("error") };
        },
        // A click in view `i` at overlay pixel (x, y) with the pick out when the worker is killed:
        // the selection is what it was (a pick the restart cut off is not empty space).
        async selectAcrossRestart(i, x, y) {
            selectAt(i, [x, y], {}, true);
            await new Promise((r) => setTimeout(r, 0));   // the pick is out now
            killNow();
            await new Promise((r) => setTimeout(r, 200));
            return [...selection];
        },
        selection: () => [...selection],
        select: (ids) => setSelection(ids),
        // The last commands applied, in the order they were applied.
        applied: () => applied.slice(-8),
        // The worker stopped on the body it was building, as a kernel trap would stop it.
        // A trap on body `id` (null: a trap that names no node, outside an evaluation).
        crashWorker: (id) => restartWorker("crashed in the test", { body: id === null ? null : byId(id) }),
        // How many restarts were counted against RESTARTS since the page opened (a quarantined
        // one is not).
        restarts: () => restartsCounted,
        busy: () => order.busy,
        // The main branch's commits, newest first, as the document logs them.
        // A pending run is committed first (`flushPending`), so the log has what `items()` shows.
        history: () => { flushPending(); return JSON.parse(wasm.cadaclysm_blacksmith_document_log(doc, "main")); },
        // How many commits the document stands after on its line (what undo takes back).
        headCount: () => { flushPending(); return head; },
        // The document's branches (`branch_list`: the branch, the head, the tips).
        branches: () => JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(doc)),
        // The document switched to a branch or a commit id, on both replicas (`switchBranch`).
        switchBranch: (to) => switchBranch(to),
        // The save, as Ctrl+S takes it (`documentJson`, in the order's turn).
        save: () => userAct(() => documentJson()),
        // Whether a drag's frame or a pending run is previewed on both replicas now.
        previewing: () => previewOp !== null,
        // The pending run's command (a typed field's, a merged set's), not committed by asking.
        pendingRun: () => pendingRun ? structuredClone(pendingRun.cmd) : null,
        // Every node of the page's replica as its cheap evaluation gives it -- `{ id, state,
        // key, hash }`, the heavy nodes `pending` -- the preview, if any, applied. No pending
        // run is committed for it: a typed field's run is compared as it is previewed.
        statuses: () => JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, true)),
        // The same of the worker's replica, once everything sent to it is evaluated.
        workerStatuses: () => testOp("statuses"),
        // The worker replica's save text, once everything sent to it is applied.
        workerSave: () => testOp("save"),
        // The page replica's save text as it stands: no pending run committed for it.
        pageSave: () => wasm.cadaclysm_blacksmith_document_save(doc),
        // The selected body's gizmo in the first pane showing it, in the page's CSS pixels:
        // its centre and its arrows' tips (a drag of one moves the body along the axis).
        gizmo() {
            const o = overlay.getBoundingClientRect();
            const rects = layout();
            for (let view = 0; view < rects.length; view++) {
                const [x, y, w, h] = rects[view];
                if (w <= 0 || h <= 0) continue;
                const m = manipulatorOf(view);
                const g = m && layoutManipulator(m, view, [w, h]);
                if (!g) continue;
                const at = (p) => [o.left + x + p[0], o.top + y + p[1]];
                return { view, centre: at(g.centre), axes: g.axes.map((a) => ({ name: a.name, tip: at(a.tip) })) };
            }
            return null;
        },
        order: () => curves.map((c) => c.id),
        rects: () => layout(),
    };
}

// ?open=<url> loads a forge document from a URL at start, for the same reason the viewer
// takes one: a picture of a known state, taken by a script.
const openParam = new URLSearchParams(location.search).get("open");
if (openParam) {
    // Once the first View is up, as the page opened it before the View moved to its worker.
    Promise.all([fetch(openParam).then((r) => r.text()), firstView]).then(([text]) => loadDocument(text)).catch((e) => console.error("open:", e));
}
