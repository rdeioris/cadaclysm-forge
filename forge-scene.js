// The forge worker's scene: the worker's replica of the forge document, every body it
// evaluates to kept by item id as a solid in the worker's wasm, answered with its table,
// and written out here when exported. The worker (forge-worker.js) wires it to messages;
// the tests drive it directly with a `post` that collects.
//
// The page holds its own replica and sends the worker the same ops it applies (the batch
// op forge-doc-convert.js's `command` gives back), so both save the same bytes. The
// document's cache is the only cache: a body whose node is unchanged is not built again.
// The document layer is forge-doc-*.js over the kernel's public `cadaclysm_blacksmith_*`
// exports, and so is everything here: a body is its node's solid handle
// (`cadaclysm_blacksmith_document_result_solid`), its table read off the solid getters,
// drawn with `View.showSolid`, written out with `cadaclysm_blacksmith_mesh_file` (STL, glTF,
// OBJ) or `_step`; a trim's ghost is forge-doc-convert.js's `trimGhost`. Every face is
// numbered as the solid's B-rep numbers it -- the table, the picks, the face colours.
//
//   createForgeScene({ wasm, post, now = () => performance.now(), host, viewId, crashed })
//     open(text, skip = [])                     the replica from a document's text
//                                               (`openDocument`; null: a new document),
//                                               the nodes `skip` names left out (a crash
//                                               quarantine, `cadaclysm_blacksmith_document_set_skip`);
//                                               every body is posted again
//     skip(nodes)                               the quarantine replaced: each node named is an
//                                               error ("the kernel crashed on this node"), what
//                                               reads it blocked; one no longer named is tried
//                                               again
//     op(op)                                    apply the page's op (`cadaclysm_blacksmith_document_apply`)
//     preview(op)                               a drag frame: the op applied unrecorded, the last
//                                               frame taken back first (`_document_preview`)
//     endPreview()                              the drag's preview taken back (`_end_preview`):
//                                               before the op that commits it, or alone when the
//                                               drag ends with nothing to commit
//     undo() / redo() / switchBranch(branch)    the same on the replica
//     dropRedo()                                the commits past the head left unnamed, the
//                                               branch's tip moved back to the head (`dropRedo`):
//                                               a tool's Cancel, as the page does it
//     resolve({ req, cmd })                     a forge command that needs built geometry (a
//                                               new face plane, a pick without references):
//                                               its op off this replica, evaluated
//                                               (`commandOp`), answered `{ kind: "resolved",
//                                               req, op }` (the op as JSON text, or `error`),
//                                               nothing applied -- the page applies the op and
//                                               sends it back as any other
//     pick({ req, id, what, indices })          answer `{ kind: "picked", req, refs }` (or
//                                               `{ kind: "picked", req, error }`), once the
//                                               replica is evaluated (`documentPickRefs`: face
//                                               indices are the B-rep's)
//     exportFile({ req, format, ids, names, looks, text, tolerance })
//                                               posts exported or exportFailed; ids with no kept
//                                               body are skipped (all of them: exportFailed);
//                                               format "stl", "glb", "obj" or "step"
//     solidOf(id)                               the kept solid's handle (the scene's: never
//                                               free it) or null
//     figuresOf(id)                             the kept solid's { volume, area, faces, edges }
//                                               or null (the ?test hook's `figures`)
//     save()                                    the replica's save text, or null (the ?test hook's)
//     statuses()                                the last evaluation's node statuses (`{ id,
//                                               state, key, hash }`), or null (the ?test hook's)
//     doc                                       (a getter) the replica's handle, or null
//     drain()                                   a promise resolved once everything sent is
//                                               applied, evaluated and answered
//     wanted(items) / bitmap({ id, bitmap })    what the page wants shown, and an image's pixels
//     viewer                                    (a getter) the host's View for VIEW_ID, or null
//     markDirty()                               ask the host for a draw
//     crashed({ id, node, message })            (an option) hears a trap in an evaluation (node:
//                                               the node running -- every heavy node reports
//                                               `start` before it runs, and a body being made
//                                               a solid is its own -- and id its item) or a
//                                               resync; no `failed` follows
//     resync()                                  show the kept wanted list again (the worker's view just appeared)
//     bodyOfItem(item)                          a shown View item id -> { body, ghost } or null
//
// Ops, previews, undo, redo and switches are applied as they come; the evaluation runs once the
// messages sent meanwhile are in (a drag's ops are one evaluation). A preview ends only on
// `endPreview`, which the page sends before the op that commits a drag, and alone for a drag
// that commits nothing. An op the replica
// refuses is answered `{ kind: "opFailed", what, error }`: the replicas have parted, and the
// page should open the worker again from its own save. An evaluation that fails outside any
// node (not a trap) is answered the same, `what` "evaluate". A change that lists nothing (a
// no-op set, an undo with nothing to undo) evaluates nothing.
//
// After an evaluation every body item whose node's `(key, hash)` changed is posted:
// `{ kind: "built", id, key, version, table, refs, ghostFaces, elapsed }` (the table holds
// the bounds, faces, edges and closure the page reads -- `bodyTable` -- `refs` the faces'
// references, eight numbers a face; nothing the View draws crosses), or `{ kind: "failed", id, key, error,
// by?, elapsed }` -- a node in error with its message, a blocked one naming the blocker
// (`by`, the failed node; its own message when the blocker is one of the body's own steps).
// `key` is null on the one failure that has no node to key it (below).
// A failed body keeps its last solid; one that comes back to it is answered from it (the same
// `version`). A body item with no node is `failed` "no node i<n>". `version` counts up per id
// each time a solid replaces the kept one; `elapsed` is the evaluation's, in ms.
//
// Bodies that left the document (deleted, undone, switched away) are freed and posted once per
// evaluation as `{ kind: "forgotten", ids }`. The page drops a body's table only on that
// message, never off its own items: changes are coalesced into one evaluation, so a body
// removed and put back meanwhile (undo then redo, delete then undo) is neither forgotten nor
// posted again, and the page keeps the table it has.
//
// Posts `{ kind: "progress", id, node, op, step, steps, phase, done, total, elapsed }` as the
// kernel goes (`cadaclysm_blacksmith_document_evaluate_with`; throttled to one every
// THROTTLE_MS, and always at a phase's start): `node` the node building, `id` its item and
// `op` the item's kind, `steps` the nodes this evaluation computes (those a cheap-only pass
// leaves pending: the heavy nodes with no cached result, and what reads them) and `step` this
// node's place among them.
// `{ kind: "exported", req, name, bodies, triangles, bytes }` (bytes transferred; a "step"
// export is the bodies' exact B-reps as STEP text, triangles 0) or
// `{ kind: "exportFailed", req, error }`. `post(message, transfer)`.
//
// `wanted` is the page's list of what to show, by key and `deps` (see forge-items.js), shown
// on the worker's own View through createItemSync: `{ key, deps, kind, colour?, faceColours?,
// ... }` by kind -- `body` ({ body, look }; edge-only bodies show their edges), `ghost` ({ body },
// a trim's dropped faces: its face colours keyed by the place in the trim's `drop`, as a
// `view.picked` hit on it names them -- forge-worker.js maps the hit's face back), `isocurves`
// ({ body, colour }, made only when shown), `curves`
// ({ colour, beziers? }) and `image` ({ image, corners?, opacity, flipX, flipY }; the pixels
// from `bitmap`). A body's, ghost's and isocurves' deps get the body's `version` added here, so
// a rebuilt body is shown again without the page: after each evaluation that built something
// the last list is synced again. A payload (`beziers`, `corners`) comes once per key and is
// kept here, dropped when the key is left out of a list (as the page's sender forgets it).
// With no View (no `host`, or no view yet) `wanted` only keeps the list.
import { createItemSync } from "./forge-items.js";
import { openDocument, commandOp, documentPickRefs, trimGhost, faceFrames, toJson } from "./forge-doc-convert.js";
import { itemsOf as docItemsOf, UNITS } from "./forge-doc-nodes.js";

export const THROTTLE_MS = 40;
// The host's view the forge draws in, and a trim's dropped faces' colour.
export const VIEW_ID = "forge";
const GHOST = [0.26, 0.26, 0.25];
const EDGES = [0, 0, 0];
// A body's look (`{ colour, material, opacity }`, the page's) as `showSolid` takes it: the
// colour over the solid's own, its triangles at MESH_TOLERANCE.
const lookOptions = (look) => ({ tolerance: MESH_TOLERANCE, colour: look?.colour ?? undefined, material: look?.material ?? undefined, opacity: look?.opacity ?? undefined });
// The tolerance a body's triangles are made at -- what WebGL2 draws, and the bounds' mesh
// (one tessellation the kernel caches) -- and the edges' and isocurves' Béziers'.
export const MESH_TOLERANCE = 0.5;
export const EDGE_TOLERANCE = 0.05;
// A STEP file's length unit by the document's (`cadaclysm_blacksmith_step`'s `unit`:
// 0 metre, 1 millimetre, 2 inch), and the frame a body placed where it is takes.
const STEP_UNITS = { m: 0, mm: 1, in: 2 };
const IDENTITY_FRAME = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
// The density of the isocurves the readers draw: one line each way through the middle of a
// curved face, and the lines at the ends of its span.
export const ISOCURVE_DENSITY = 1;

// forge.js `isBody`: the item kinds that are bodies (node `i<id>` a solid or a sheet), another
// app's held body (`held`) among them.
const BODY_KINDS = new Set(["surface", "extrusion", "revolution", "solid", "sweep", "loft",
    "join", "cut", "intersect", "shell", "thicken", "trim", "prism", "press", "refillet", "rechamfer", "remove", "fillet", "face", "pipe", "split",
    "box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil", "held"]);
export const isBodyKind = (kind) => BODY_KINDS.has(kind);
// The item a node belongs to: `i<n>` and its helpers `i<n>_<role>` are item n's.
export const itemOfNode = (node) => { const m = /^i(\d+)(?:_|$)/.exec(node ?? ""); return m ? Number(m[1]) : null; };

// The commits past the head of the branch the head is on left as an unnamed tip, the branch
// moved back to the head: what a tool's Cancel does after taking its commits back, so a redo
// does not bring them back. Nothing when detached or at the tip. The state does not change.
// The page and the worker do it the same way, so both replicas save the same bytes.
export function dropRedo(wasm, doc) {
    const b = JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(doc));
    if (!b.branch || !b.can_redo) return false;
    wasm.cadaclysm_blacksmith_document_branch_switch(doc, b.head);
    wasm.cadaclysm_blacksmith_document_branch_delete(doc, b.branch);
    wasm.cadaclysm_blacksmith_document_branch_new(doc, b.branch, b.head);
    wasm.cadaclysm_blacksmith_document_branch_switch(doc, b.branch);
    return true;
}

// The page's crash quarantine: the nodes the kernel trapped on, each with the key its item
// had then (`wantKey`), left out of the worker's replica (`open`'s `skip`, the `skip`
// message) so a restarted worker does not trap on them again. A node leaves the moment its
// item's key moves (an edit of it or of what it reads, an undo, a load): it is tried again.
export function createQuarantine() {
    const held = new Map();   // node -> its item's key when it trapped
    return {
        nodes: () => [...held.keys()],
        has: (node) => held.has(node),
        // A trap on `node` while its item's key was `key`: true when it was not held already.
        add(node, key) { const fresh = !held.has(node); held.set(node, key ?? null); return fresh; },
        // The keys now (`keyOf(item id)`): the nodes whose item's key moved leave; true when any did.
        refresh(keyOf) {
            let moved = false;
            for (const [node, key] of [...held]) if ((keyOf(itemOfNode(node)) ?? null) !== key) { held.delete(node); moved = true; }
            return moved;
        },
        clear() { held.clear(); },
    };
}

// A solid's faces by what they are (`cadaclysm_blacksmith_face_ref`), eight numbers a face
// -- the surface's kind, a point on the face, the outward normal there, the extent -- and a
// row of -1 and zeros for a face with nothing to read. By B-rep face index.
export function faceRefs(kernel, solid) {
    const n = kernel.cadaclysm_blacksmith_face_count(solid);
    const out = new Float64Array(8 * n);
    for (let f = 0; f < n; f++) {
        try { out.set(kernel.cadaclysm_blacksmith_face_ref(solid, f), 8 * f); }
        catch (error) { if (isTrap(error)) throw error; out[8 * f] = -1; }
    }
    return out;
}

// A solid's edges as a picker sees them (`cadaclysm_blacksmith_edge`, numbered as a fillet
// takes them), flat as forge-curves.js's `parseEdges` reads them (float32, as the page reads them): the edge count, then per
// edge its face count and faces, its segment count and the segments' ends, six numbers each.
export function edgeList(kernel, solid) {
    const n = kernel.cadaclysm_blacksmith_edge_count(solid);
    const out = [n];
    for (let e = 0; e < n; e++) {
        const { faces, segments } = kernel.cadaclysm_blacksmith_edge(solid, e);
        out.push(faces.length);
        for (const f of faces) out.push(f);
        out.push(segments.length / 6);
        for (const v of segments) out.push(v);
    }
    return Float32Array.from(out);
}

// A solid's volume and area: the kernel's mass properties at accuracy 1e-9 (an open body's
// volume 0), or [0, 0] where it refuses to measure (faces that do not all point out).
export function massOf(kernel, solid) {
    try {
        const m = kernel.cadaclysm_blacksmith_mass_properties(solid, 1e-9);
        return [m[6], m[4]];
    } catch (error) { if (isTrap(error)) throw error; return [0, 0]; }
}

// What the page's editing code reads of a built body, and nothing it only draws, every face
// by its B-rep index (as the View's picks and face colours number them): each face's surface
// kind (`faceKinds`, face_ref's: 0 a plane, 1 to 4 a cylinder, cone, sphere or torus, -1
// nothing to read; read by onTurned, a sketch's face pick and the trim's count) and, for a
// plane, the frame a sketch on it takes (`frames`, twelve numbers a face -- origin, x, y, z
// -- NaN where none: `framesOf(planes)` gives them, the document's own `frame.on_face`),
// each face's round radius and chamfer distance, the edge list (`edgeList`: fillet edge
// picks), the box round the edges' control points (the overlay's dimension box), the bounds
// (centre, radius: the kernel's mesh at MESH_TOLERANCE, the edges' box for a body of edges
// alone) and the closure. `refs` the solid's `faceRefs`, when the caller has them.
export function bodyTable(kernel, solid, { refs = faceRefs(kernel, solid), framesOf = null } = {}) {
    const n = refs.length / 8;
    const faceKinds = new Int32Array(n), rounds = new Float32Array(n), chamfers = new Float32Array(n);
    const frames = new Float64Array(12 * n).fill(NaN);
    const planes = [];
    for (let f = 0; f < n; f++) {
        faceKinds[f] = refs[8 * f];
        if (faceKinds[f] === 0) planes.push(f);
        rounds[f] = kernel.cadaclysm_blacksmith_face_round_radius(solid, f);
        chamfers[f] = kernel.cadaclysm_blacksmith_face_chamfer_distance(solid, f);
    }
    if (framesOf && planes.length) framesOf(planes).forEach((frame, k) => { if (frame) frames.set(frame, 12 * planes[k]); });
    const beziers = kernel.cadaclysm_blacksmith_edge_beziers(solid, EDGE_TOLERANCE);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 4 <= beziers.length; i += 4) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], beziers[i + k]); hi[k] = Math.max(hi[k], beziers[i + k]); }
    const curves = beziers.length >= 16;
    let box = null;
    if (n > 0) {
        try { const b = kernel.cadaclysm_blacksmith_bounds(solid, MESH_TOLERANCE); box = [[b[0], b[1], b[2]], [b[3], b[4], b[5]]]; }
        catch (error) { if (isTrap(error)) throw error; }
    }
    const [l, h] = box ?? (curves ? [lo, hi] : [[0, 0, 0], [0, 0, 0]]);
    const diagonal = Math.hypot(h[0] - l[0], h[1] - l[1], h[2] - l[2]);
    const bounds = diagonal < 1e-12 ? { centre: l.slice(), radius: 1 } : { centre: [0, 1, 2].map((k) => (l[k] + h[k]) / 2), radius: diagonal / 2 };
    return {
        faceKinds, frames, rounds, chamfers, edges: edgeList(kernel, solid),
        box: curves ? { lo, hi } : null, edgeOnly: n === 0 && curves,
        bounds, closure: closureOf(kernel.cadaclysm_blacksmith_manifold(solid)),
    };
}

// Whether a body is closed, off its B-rep's topology (the wasm's `manifold` row): what
// the browser's tooltip and its amber dot say.
export function closureOf(row) {
    return { closed: row[7] === 1, manifold: row[6] === 1, boundaryEdges: row[3], nonManifoldEdges: row[4], nonManifoldVertices: row[5] };
}

// Every typed array once, however deep (a table is an object of arrays).
const typed = (o) => Object.values(o ?? {}).flatMap((a) => ArrayBuffer.isView(a) ? [a] : a && typeof a === "object" ? typed(a) : []);
const copyOf = (a) => ArrayBuffer.isView(a) ? a.slice() : Array.isArray(a) ? a.map(copyOf) : a && typeof a === "object" ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, copyOf(v)])) : a;
const isTrap = (error) => typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError;
const nodeOf = (id) => typeof id === "number" ? `i${id}` : String(id);

export function createForgeScene({ wasm, post, now = () => performance.now(), host = null, viewId = VIEW_ID, crashed = null }) {
    let doc = null;
    const bodies = new Map();     // item id -> { solid, version, table, refs, ghostFaces, drop, kind }
    const sent = new Map();       // item id -> the `(key, hash)` or error last posted for it
    const ghosts = new Map();     // trim body id -> { solid, faces, version }, freed when replaced
    const bitmaps = new Map();    // image id -> { bitmap, gen }
    const payloads = new Map();   // wanted key -> { beziers?, corners? }, as last sent for it
    let wantedItems = [], synced = null;   // synced: { viewer, sync }
    let bitmapGen = 0;
    let heldAtWanted = new Set();   // the bitmap ids there were when the last `wanted` ran
    const versions = new Map();   // id -> the last version handed out (outlives the body)
    const queue = [];             // { kind, ... } as the router hands them, applied in order
    let stale = false;            // the replica changed since it was last evaluated
    let draining = null;
    let lastStatuses = null;      // the last evaluation's node statuses (the ?test hook's `statuses`)
    let dragOp = null;            // the live drag frame's op (`preview`), until a change ends it

    // A solid handle freed (a leak, not an error, where that fails: the trap is the news).
    const free = (solid) => { if (solid === null || solid === undefined) return; try { wasm.cadaclysm_blacksmith_solid_free(solid); } catch { /* leaked */ } };
    // `fn` -- a scratch evaluation on the replica (`_preview_begin`, which drops a drag's live
    // frame) -- and the drag's frame put back after it, so the replica is as the page's is.
    function scratch(fn) {
        try { return fn(); } finally {
            if (dragOp !== null && doc !== null) { try { wasm.cadaclysm_blacksmith_document_preview(doc, dragOp); } catch (error) { if (isTrap(error)) throw error; dragOp = null; } }
        }
    }

    function enqueue(message) { queue.push(message); drain(); }

    function drain() {
        if (draining) return draining;
        draining = (async () => {
            try {
                while (queue.length || stale) {
                    // A turn of the event loop first, so the messages posted meanwhile (a
                    // drag's ops) are applied before the one evaluation they share.
                    await new Promise((r) => setTimeout(r, 0));
                    while (queue.length) {
                        const m = queue.shift();
                        if (m.kind === "pick") { if (stale) evaluate(); answerPick(m); }
                        else if (m.kind === "resolve") { if (stale) evaluate(); answerResolve(m); }
                        else change(m);
                    }
                    if (stale) evaluate();
                }
            } finally { draining = null; }
        })();
        return draining;
    }

    // One message that changes the replica. A trap is a crash (the instance is poisoned);
    // an ordinary refusal is `opFailed`.
    function change(m) {
        try {
            if (m.kind === "open") {
                if (doc !== null) { const old = doc; doc = null; wasm.cadaclysm_blacksmith_document_free(old); }
                dragOp = null;
                doc = m.text === null || m.text === undefined ? wasm.cadaclysm_blacksmith_document_new(UNITS) : openDocument(wasm, m.text);
                if (m.skip?.length) wasm.cadaclysm_blacksmith_document_set_skip(doc, JSON.stringify(m.skip));
                sent.clear();
                stale = true;
                return;
            }
            if (doc === null) throw new Error("no document is open");
            if (m.kind === "dropRedo") { dragOp = null; dropRedo(wasm, doc); return; }
            if (m.kind === "skip") { wasm.cadaclysm_blacksmith_document_set_skip(doc, JSON.stringify(m.nodes ?? [])); stale = true; return; }
            const op = typeof m.op === "string" ? m.op : toJson(m.op);
            const changed = m.kind === "op" ? wasm.cadaclysm_blacksmith_document_apply(doc, op, m.message ?? undefined)
                : m.kind === "preview" ? wasm.cadaclysm_blacksmith_document_preview(doc, op)
                : m.kind === "endPreview" ? wasm.cadaclysm_blacksmith_document_end_preview(doc)
                : m.kind === "undo" ? wasm.cadaclysm_blacksmith_document_undo(doc)
                : m.kind === "redo" ? wasm.cadaclysm_blacksmith_document_redo(doc)
                : m.kind === "switch" ? wasm.cadaclysm_blacksmith_document_branch_switch(doc, String(m.branch))
                : null;
            if (changed === null) throw new Error(`unknown change \`${m.kind}\``);
            // A drag's frame lasts until the next change of any kind takes it back.
            dragOp = m.kind === "preview" ? op : null;
            if (lists(changed)) stale = true;
        } catch (error) {
            if (isTrap(error)) { fault(error, null); return; }
            post({ kind: "opFailed", what: m.kind, error: String(error?.message ?? error) });
        }
    }

    // Whether a change (`Changed` as JSON, or "null") lists anything: a no-op set lists nothing.
    function lists(changed) {
        if (changed === "null") return false;
        const c = JSON.parse(changed);
        return ["added", "changed", "removed", "params"].some((k) => c?.[k]?.length);
    }

    function answerPick({ req, id, what, indices }) {
        try {
            if (doc === null) throw new Error("no document is open");
            const refs = documentPickRefs(wasm, doc, nodeOf(id), what, indices ?? []);
            post({ kind: "picked", req, refs });
        } catch (error) {
            if (isTrap(error)) { fault(error, null); return; }
            post({ kind: "picked", req, error: String(error?.message ?? error) });
        }
    }

    function answerResolve({ req, cmd }) {
        try {
            if (doc === null) throw new Error("no document is open");
            const op = toJson(scratch(() => commandOp(wasm, doc, typeof cmd === "string" ? JSON.parse(cmd) : cmd)));
            post({ kind: "resolved", req, op });
        } catch (error) {
            if (isTrap(error)) { fault(error, null); return; }
            post({ kind: "resolved", req, error: String(error?.message ?? error) });
        }
    }

    function fault(error, id, node = null) {
        const message = String(error?.message ?? error);
        if (crashed) crashed({ id, node, message });
        else post({ kind: "crashed", ...(id !== null ? { id } : {}), ...(node !== null ? { node } : {}), message });
    }

    // Evaluate the replica and post what changed.
    function evaluate() {
        stale = false;
        if (doc === null) return;
        const started = now();
        const elapsed = () => Math.round(now() - started);
        let reporting = null;
        const rebuilt = new Set();
        try {
            const items = docItemsOf(JSON.parse(wasm.cadaclysm_blacksmith_document_save(doc))).toLit();
            const byId = new Map(items.map((item) => [item.id, item]));
            // The steps: what a cheap-only pass leaves pending (the cheap nodes it computes are
            // cached for the full pass, so nothing is evaluated twice).
            const pending = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, true)).filter((s) => s.state === "pending").map((s) => s.id);
            let last = -Infinity;
            const report = (node, phase, done, total) => {
                reporting = node;
                const t = now();
                if (done !== 0 && t - last < THROTTLE_MS) return;
                last = t;
                const id = itemOfNode(node);
                post({ kind: "progress", id, node, op: byId.get(id)?.kind ?? node, step: Math.max(0, pending.indexOf(node)), steps: pending.length, phase, done, total, elapsed: elapsed() });
            };
            const statuses = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate_with(doc, false, report));
            reporting = null;
            const byNode = new Map(statuses.map((s) => [s.id, s]));
            // Bodies gone from the document, or no longer bodies: freed, and the page told.
            const forgotten = new Set();
            for (const id of [...bodies.keys(), ...sent.keys()]) {
                if (isBodyKind(byId.get(id)?.kind)) continue;
                const b = bodies.get(id);
                if (b) { bodies.delete(id); free(b.solid); }
                sent.delete(id); dropGhost(id);
                forgotten.add(id);
            }
            if (forgotten.size) post({ kind: "forgotten", ids: [...forgotten].sort((a, b) => a - b) });
            lastStatuses = statuses;
            for (const item of items) {
                if (!isBodyKind(item.kind)) continue;
                const node = nodeOf(item.id), st = byNode.get(node);
                if (!st) {
                    if (sent.get(item.id) === "none") continue;
                    sent.set(item.id, "none");
                    post({ kind: "failed", id: item.id, key: null, error: `no node ${node}`, elapsed: elapsed() });
                    continue;
                }
                if (st.state === "pending") continue;
                if (st.state === "ok") {
                    const sig = `${st.key}|${st.hash ?? ""}`;
                    if (sent.get(item.id) === sig) continue;
                    // Back to the solid it keeps (a failure undone): answered from it, no new version.
                    const kept = bodies.get(item.id);
                    if (kept && kept.key === st.key) { answer(item.id, kept, elapsed()); sent.set(item.id, sig); continue; }
                    reporting = node;
                    if (built(item, node, st.key, elapsed)) rebuilt.add(item.id);
                    reporting = null;
                    sent.set(item.id, sig);
                    continue;
                }
                let error = st.error ?? st.state, by;
                if (st.state === "blocked") {
                    by = st.by;
                    const owner = itemOfNode(by);
                    error = owner === item.id ? byNode.get(by)?.error ?? `blocked by ${by}` : `blocked by ${byId.get(owner)?.name ?? by}`;
                }
                const sig = `${st.key}|${st.state}|${error}`;
                if (sent.get(item.id) === sig) continue;
                sent.set(item.id, sig);
                post({ kind: "failed", id: item.id, key: st.key, error, ...(by !== undefined ? { by } : {}), elapsed: elapsed() });
            }
        } catch (error) {
            if (isTrap(error)) { fault(error, itemOfNode(reporting), reporting); return; }
            // The answers the page waits for will not come: it should open the worker again.
            post({ kind: "opFailed", what: "evaluate", error: String(error?.message ?? error) });
            return;
        }
        // The page re-sends its list once it has the tables; until then the old list is
        // shown against the new solids, minus the face colours made for the old faces.
        // Outside the try: the bodies are answered, so a trap here is a crash, never a `failed`.
        if (rebuilt.size) {
            try { resync(rebuilt); } catch (error) { if (isTrap(error)) fault(error, [...rebuilt].at(-1)); else throw error; }
        }
    }

    // Body `item` (node `node`, Ok under `key`) made a solid, kept and answered: true when
    // it was. A solid that cannot be made is `failed`, the last one kept.
    function built(item, node, key, elapsed) {
        let solid = null;
        try {
            solid = wasm.cadaclysm_blacksmith_document_result_solid(doc, node);
            const version = (versions.get(item.id) ?? 0) + 1;
            const drop = item.kind === "trim" && Array.isArray(item.drop) ? item.drop.slice() : [];
            const refs = faceRefs(wasm, solid), handle = solid;
            // The flat faces' frames as the document's `frame.on_face` makes them; none where
            // the scratch evaluation is refused (the face sketch is then broken until a rebuild).
            const framesOf = (planes) => {
                try { return scratch(() => faceFrames(wasm, doc, node, handle, planes)); }
                catch (error) { if (isTrap(error)) throw error; return []; }
            };
            const body = { solid, version, key, kind: item.kind, drop, table: bodyTable(wasm, solid, { refs, framesOf }), refs, ghostFaces: drop.length };
            // Kept only once everything it needed has been read off it.
            const old = bodies.get(item.id);
            bodies.set(item.id, body); versions.set(item.id, version);
            solid = null;
            free(old?.solid); dropGhost(item.id);
            answer(item.id, body, elapsed());
            return true;
        } catch (error) {
            if (isTrap(error)) throw error;
            post({ kind: "failed", id: item.id, key, error: String(error?.message ?? error), elapsed: elapsed() });
            return false;
        } finally {
            free(solid);   // made but not kept: the table threw
        }
    }

    function answer(id, body, elapsed) {
        const table = copyOf(body.table), refs = body.refs ? body.refs.slice() : [];
        const buffers = [...new Set([...typed(table), ArrayBuffer.isView(refs) ? refs : null].filter((a) => a).map((a) => a.buffer))];
        post({ kind: "built", id, key: body.key, version: body.version, table, refs, ghostFaces: body.ghostFaces, elapsed }, buffers);
    }

    function dropGhost(id) {
        const g = ghosts.get(id);
        if (g) { ghosts.delete(id); free(g.solid); }
    }
    // A trim's ghost -- its split pieces under its move, the dropped faces shown -- kept per
    // body for the version it was made from.
    function ghostFor(id, body) {
        let g = ghosts.get(id);
        if (g && g.version === body.version) return g;
        dropGhost(id);
        if (body.kind !== "trim" || !body.drop.length || doc === null) return null;
        let solid;
        try { solid = scratch(() => trimGhost(wasm, doc, nodeOf(id))); }
        catch (error) { if (isTrap(error)) throw error; return null; }
        g = { solid, faces: Uint32Array.from(body.drop), version: body.version };
        ghosts.set(id, g);
        return g;
    }

    const viewer = () => host?.views.get(viewId) ?? null;
    const markDirty = () => host?.markDirty?.(viewId);

    // The wanted list as createItemSync takes it. `rebuilt` holds the bodies just replaced:
    // their face colours were made for the faces they had, so they are not applied.
    function itemsOf(v, rebuilt) {
        const out = [];
        for (const item of wantedItems) {
            const faceColours = rebuilt?.has(item.body) ? undefined : item.faceColours;
            const kept = payloads.get(item.key) ?? {};
            const body = item.body !== undefined ? bodies.get(item.body) : undefined;
            try {
                if (item.kind === "body") {
                    if (!body) continue;
                    const deps = [...item.deps, body.version];
                    if (body.table.edgeOnly) out.push({ key: item.key, deps, colour: EDGES, value: { body: item.body, ghost: false }, show: () => v.showCurves(wasm.cadaclysm_blacksmith_edge_beziers(body.solid, EDGE_TOLERANCE), EDGES) });
                    else out.push({ key: item.key, deps, faceColours, value: { body: item.body, ghost: false }, show: () => v.showSolid(body.solid, lookOptions(item.look)) });
                } else if (item.kind === "ghost") {
                    if (!body) continue;
                    const ghost = ghostFor(item.body, body);
                    if (!ghost) continue;
                    // The page keys a ghost's faces by their place in `drop`; the View by the split's own faces.
                    const colours = faceColours ? Object.fromEntries(Object.entries(faceColours).flatMap(([k, c]) => ghost.faces[k] !== undefined ? [[ghost.faces[k], c]] : [])) : undefined;
                    out.push({ key: item.key, deps: [...item.deps, body.version], faceColours: colours, value: { body: item.body, ghost: true, faces: Array.from(ghost.faces) },
                              show: () => v.showSolid(ghost.solid, { tolerance: MESH_TOLERANCE, colour: GHOST, material: "plastic", faces: ghost.faces }) });
                } else if (item.kind === "isocurves") {
                    if (!body) continue;
                    out.push({ key: item.key, deps: [...item.deps, body.version], colour: item.colour, show: () => v.showCurves(wasm.cadaclysm_blacksmith_isocurve_beziers(body.solid, ISOCURVE_DENSITY, EDGE_TOLERANCE), item.colour) });
                } else if (item.kind === "curves") {
                    if (!kept.beziers) continue;
                    out.push({ key: item.key, deps: item.deps, colour: item.colour, show: () => v.showCurves(kept.beziers, item.colour) });
                } else if (item.kind === "image") {
                    const held = bitmaps.get(item.image);
                    if (!held || !kept.corners) continue;   // still decoding, or its corners not yet here
                    out.push({ key: item.key, deps: [...item.deps, held.gen], show: () => v.showImage({ corners: kept.corners, bitmap: held.bitmap, opacity: item.opacity, flipX: !!item.flipX, flipY: !!item.flipY }) });
                }
            } catch (error) { if (isTrap(error)) throw error; console.error(`${item.key}:`, error); }
        }
        return out;
    }

    function resync(rebuilt) {
        const v = viewer();
        if (!v) return;
        try {
            if (synced?.viewer !== v) synced = { viewer: v, sync: createItemSync(v) };
            synced.sync.sync(itemsOf(v, rebuilt));
            markDirty();
        } catch (error) {
            if (isTrap(error)) throw error;   // the instance is poisoned: the worker reports a crash
            console.error("forge wanted:", error);
        }
    }

    function wanted(items) {
        const keys = new Set(items.map((i) => i.key));
        for (const key of [...payloads.keys()]) if (!keys.has(key)) payloads.delete(key);
        for (const item of items) {
            if (item.beziers || item.corners) payloads.set(item.key, { ...payloads.get(item.key), ...(item.beziers ? { beziers: item.beziers } : {}), ...(item.corners ? { corners: item.corners } : {}) });
        }
        wantedItems = items;
        // A bitmap no image item names is closed -- but only one already here at the previous
        // `wanted`: a bitmap may arrive (a decode, a restart) before the list that names it, and
        // that list must find it.
        const named = new Set(items.filter((i) => i.kind === "image").map((i) => i.image));
        for (const [id, held] of [...bitmaps]) if (!named.has(id) && heldAtWanted.has(id)) { bitmaps.delete(id); held.bitmap?.close?.(); }
        heldAtWanted = new Set(bitmaps.keys());
        resync();
    }

    function bitmap({ id, bitmap: image }) {
        const old = bitmaps.get(id);
        if (old && old.bitmap !== image) old.bitmap?.close?.();
        bitmaps.set(id, { bitmap: image, gen: ++bitmapGen });
        resync();
    }

    function bodyOfItem(item) { return synced?.sync.valueOf(item) ?? null; }

    // The bodies as one STEP file, their exact B-reps off the document
    // (`cadaclysm_blacksmith_document_result_solid`, each handle freed): one body through
    // `cadaclysm_blacksmith_step`, named; several through `_step_assembly`, each body a
    // part named as the forge names it, placed where it is (the identity frame).
    function stepText(solids, names) {
        const handles = [];
        try {
            for (const id of solids) handles.push(wasm.cadaclysm_blacksmith_document_result_solid(doc, nodeOf(id)));
            const unit = STEP_UNITS[UNITS] ?? 1, nameOf = (id) => names[id] ?? `Solid ${id}`;
            if (handles.length === 1) {
                handles.push(wasm.cadaclysm_blacksmith_named(handles[0], nameOf(solids[0])));
                return wasm.cadaclysm_blacksmith_step(Uint32Array.of(handles[1]), undefined, unit);
            }
            const frames = new Float64Array(12 * handles.length);
            for (let k = 0; k < handles.length; k++) frames.set(IDENTITY_FRAME, 12 * k);
            return wasm.cadaclysm_blacksmith_step_assembly(Uint32Array.from(handles), solids.map(nameOf), Uint32Array.from(handles, (_, k) => k), frames, undefined, unit);
        } finally {
            for (const h of handles) wasm.cadaclysm_blacksmith_solid_free(h);
        }
    }

    // The bodies as one mesh file (`cadaclysm_blacksmith_mesh_file`): binary STL, or ASCII
    // named as the file when `text`; GLB, or glTF text when `text`, each body named and in
    // its look (`looks[id]`: r g b alpha metallic roughness); OBJ, each body named. The
    // triangles counted off the same tessellation (`cadaclysm_blacksmith_mesh`, cached).
    const MESH_FORMATS = { stl: ["stl", "stl-ascii"], glb: ["glb", "gltf"], obj: ["obj", "obj"] };
    function exportFile({ req, format, ids, names = {}, looks = {}, text = false, tolerance }) {
        try {
            const solids = ids.filter((id) => bodies.has(id));
            if (!solids.length) throw new Error("nothing to export: no solid is built");
            if (format === "step") {
                const bytes = new TextEncoder().encode(stepText(solids, names));
                post({ kind: "exported", req, name: names.file ?? "forge", bodies: solids.length, triangles: 0, bytes }, [bytes.buffer]);
                return;
            }
            const kind = MESH_FORMATS[format]?.[text ? 1 : 0];
            if (!kind) throw new Error(`unknown export format: ${format}`);
            const handles = Uint32Array.from(solids, (id) => bodies.get(id).solid);
            const name = names.file ?? "forge";
            const solidNames = solids.map((id) => names[id] ?? `Solid ${id}`);
            if (kind === "stl-ascii") solidNames[0] = name;   // the one `solid` an ASCII STL names
            const lookValues = format === "glb" ? solids.flatMap((id) => looks[id] ?? [0.8, 0.8, 0.8, 1, 0, 0.5]) : undefined;
            const bytes = wasm.cadaclysm_blacksmith_mesh_file(handles, kind, solidNames, lookValues, tolerance);
            let triangles = 0;
            for (const h of handles) triangles += wasm.cadaclysm_blacksmith_mesh(h, tolerance).indices.length / 3;
            post({ kind: "exported", req, name, bodies: solids.length, triangles, bytes }, [bytes.buffer]);
        } catch (error) {
            post({ kind: "exportFailed", req, error: String(error) });
        }
    }

    // The kept solid's figures (test/fixtures/forge-pins.json): its mass properties, face and edge counts.
    function figuresOf(id) {
        const solid = bodies.get(id)?.solid;
        if (solid === undefined) return null;
        const [volume, area] = massOf(wasm, solid);
        return { volume, area, faces: wasm.cadaclysm_blacksmith_face_count(solid), edges: wasm.cadaclysm_blacksmith_edge_count(solid) };
    }

    return {
        open: (text, skip = []) => enqueue({ kind: "open", text, skip }),
        skip: (nodes) => enqueue({ kind: "skip", nodes }),
        resolve: (m) => enqueue({ ...m, kind: "resolve" }),
        op: (op, message) => enqueue({ kind: "op", op, message }),
        preview: (op) => enqueue({ kind: "preview", op }),
        endPreview: () => enqueue({ kind: "endPreview" }),
        dropRedo: () => enqueue({ kind: "dropRedo" }),
        undo: () => enqueue({ kind: "undo" }),
        redo: () => enqueue({ kind: "redo" }),
        switchBranch: (branch) => enqueue({ kind: "switch", branch }),
        pick: (m) => enqueue({ ...m, kind: "pick" }),
        exportFile, wanted, bitmap, resync: () => resync(), bodyOfItem, markDirty,
        get viewer() { return viewer(); }, get doc() { return doc; },
        solidOf: (id) => bodies.get(id)?.solid ?? null, figuresOf,
        statuses: () => lastStatuses,
        save: () => (doc === null ? null : wasm.cadaclysm_blacksmith_document_save(doc)),
        drain: async () => { while (draining || queue.length || stale) await (draining ?? drain()); },
    };
}

// The worker's message handling, apart from `self` so it can be tested: messages are taken
// in order once `ready` settles, and one that throws is answered (opFailed for a change,
// picked with the error for a pick, the export's own failure for an export) without
// stopping the ones after it.
const CHANGES = new Set(["open", "op", "preview", "endPreview", "dropRedo", "skip", "undo", "redo", "switch"]);
export function createForgeRouter({ scene, post, ready, host = null, cameras = null }) {
    // The ?test hook's `figures`: per asked id, what the kept solid measures (test/fixtures/forge-pins.json). Its volume
    // and area are the kernel's mass properties, its faces the B-rep's, its edges the picker's count.
    // Its `statuses`: every node's status as the replica's last evaluation gave it, once
    // everything sent is evaluated (the page compares its own replica's keys and hashes).
    function statuses({ req }) {
        scene.drain().then(() => post({ kind: "forge.test.result", req, value: scene.statuses() }),
            (e) => post({ kind: "forge.test.result", req, error: String(e?.message ?? e) }));
    }
    // Its `save`: the replica's save text, once everything sent is applied (the page compares
    // it with its own: the two replicas save the same bytes).
    function save({ req }) {
        scene.drain().then(() => post({ kind: "forge.test.result", req, value: scene.save() }),
            (e) => post({ kind: "forge.test.result", req, error: String(e?.message ?? e) }));
    }
    function figures({ req, ids }) {
        try {
            const value = {};
            for (const id of ids) {
                const figures = scene.figuresOf(id);
                if (figures) value[id] = figures;
            }
            post({ kind: "forge.test.result", req, value });
        } catch (e) { post({ kind: "forge.test.result", req, error: String(e?.message ?? e) }); }
    }
    let chain = Promise.resolve(ready).then(() => null, (error) => error);
    return (data) => {
        chain = chain.then((bootError) => {
            try {
                if (bootError) throw new Error(`the kernel did not start: ${bootError?.message ?? bootError}`);
                if (data.kind === "open") scene.open(data.text, data.skip ?? []);
                else if (data.kind === "skip") scene.skip(data.nodes ?? []);
                else if (data.kind === "resolve") scene.resolve(data);
                else if (data.kind === "op") scene.op(data.op, data.message);
                else if (data.kind === "preview") scene.preview(data.op);
                else if (data.kind === "endPreview") scene.endPreview();
                else if (data.kind === "dropRedo") scene.dropRedo();
                else if (data.kind === "undo") scene.undo();
                else if (data.kind === "redo") scene.redo();
                else if (data.kind === "switch") scene.switchBranch(data.branch);
                else if (data.kind === "pick") scene.pick(data);
                else if (data.kind === "export") scene.exportFile(data);
                else if (data.kind === "wanted") scene.wanted(data.items);
                else if (data.kind === "bitmap") scene.bitmap(data);
                else if (data.kind === "forge.test" && data.op === "figures") figures(data);
                else if (data.kind === "forge.test" && data.op === "statuses") statuses(data);
                else if (data.kind === "forge.test" && data.op === "save") save(data);
                else if (data.kind.startsWith("view.")) host?.handle(data);
                else if (data.kind.startsWith("forge.")) cameras?.handle(data);
            } catch (error) {
                if (data.kind === "export") post({ kind: "exportFailed", req: data.req, error: String(error) });
                else if (CHANGES.has(data.kind)) post({ kind: "opFailed", what: data.kind, error: String(error?.message ?? error) });
                else if (data.kind === "pick") post({ kind: "picked", req: data.req, error: String(error?.message ?? error) });
                else if (data.kind === "resolve") post({ kind: "resolved", req: data.req, error: String(error?.message ?? error) });
                else if (data.kind === "view.create") post({ kind: "view.failed", id: data.id, message: String(error?.message ?? error) });
                else console.error(`forge ${data.kind}:`, error);
                // A trap leaves the instance poisoned: the page remakes the worker.
                if (isTrap(error)) post({ kind: "crashed", message: String(error?.message ?? error) });
            }
            return bootError;
        });
    };
}
