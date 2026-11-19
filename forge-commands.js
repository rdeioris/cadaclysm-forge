// The page's commands as document batches: each command reads the nodes it needs (through
// the model, forge-model.js) and emits the ops that write the item layout that file's header
// documents -- `add`, `set`, `remove`, plus a `meta` op when the counters or the next id
// move. No DOM: importable by the page, the worker and node. No geometry: what a sketch tool
// makes of curves is the kernel's (`cadaclysm_blacksmith_profile_*`), and a face's reference
// is forge-picks.js's.
//
//   commandOps(model, cmd, env)   `{ ops, meta? }`: the ops `cmd` (the page's command object,
//                                 as forge-doc-commands.js's `applyCommand` takes it) makes
//                                 on the model's document, and the forge meta when the
//                                 command moved it (write it with `metaOp`). `env` is
//                                 `{ kernel, picks }`, `picks` forge-picks.js's `docPicks`
//                                 (asked only by a command that needs a face's reference).
//                                 Nothing is applied. Throws what the page would throw (an
//                                 item a command names is not there, an unknown op), and
//                                 `Unported` for a command or an item kind not on nodes yet.
//   command(kernel, model, doc, cmd, env?)
//                                 the command as one commit: `{ op: "batch", ops (+ the meta
//                                 op), message: "forge: <op>" }` applied with
//                                 `document_apply`, the model refreshed with the changed set
//                                 and the batch. `{ changed, op }`: the kernel's changed set
//                                 (parsed) and the batch, which a replica applies as it is
//                                 (forge-scene.js, the worker). An item whose node the kernel
//                                 refuses (a polygon of 2.5 sides) is written as a stand-in
//                                 instead and the batch applied again, as the 0.14 layer did.
//   sketchFillet(kernel, curves, radius)
//                                 a sketch fillet over item fields: two curves meeting at an
//                                 end -> `{ two: { a, b, arc } }` (each curve's new `{ kind,
//                                 shape }`, the arc's shape) by `profile_fillet_corner`; one
//                                 curve -> `{ one: { kind: "polycurve", shape } }` by
//                                 `profile_from_pieces` -> `profile_round` ->
//                                 `profile_pieces_json`. Refused in the kernel's words.
//   trimmedCurves(kernel, curve, cutters, piece)
//                                 the sketch trim: `curve` (item fields) with piece `piece`
//                                 of its cut by `cutters` taken away, what is left as curve
//                                 definitions (`{ kind, shape }`), by `profile_from_pieces`
//                                 -> `profile_trim_chain` -> `profile_pieces_json`
//   readItem(draft, n) / writeItem(draft, n, fields, at?)
//                                 an item's page fields read off its nodes, and written back
//                                 as nodes (the ops that turn its nodes into those): curves
//                                 and sketches here (`ITEM_CLASSES`), bodies by later groups
//   Draft                         the document as a command's ops leave it: node lookups,
//                                 positions and the forge meta, every change an op
//   pieceToNode / pieceFromNode   a polycurve piece, the page's `{ kind, shape }` <-> a
//                                 `curve.polycurve` piece `{ kind, ...shape }` (nurbs <-> spline)
//   Unported                      the error of a command or an item kind not on nodes yet
//
// On nodes so far: `add`, `image`, `sketch`, `duplicate`, `delete`, `round`, `merge`, `snip`,
// `explode`, and `set` / `edit` of curves, sketches and held items (5.3a). The made bodies,
// the body verbs and the moves throw `Unported` until their groups land: each adds its class
// to `ITEM_CLASSES` and its cases to `build`.
//
// # How a command writes
//
// A command builds on a `Draft` of the model: `d.add(node, at)`, `d.set(id, fields)`,
// `d.remove(id)`, `d.replace(id, node)` (a node whose kind changes: removed and added again
// at its place, in the same batch) each record one op and keep the draft's order, so a later
// op's `at` is right. An item's fields go through `readItem` / `writeItem`: the writer of its
// class makes the nodes the fields ask for (helpers, then the head), and `writeItem` emits
// the ops between those and the nodes the item has. `nameFor` / `bumpId` work on `d.forge()`,
// the command's copy of the forge meta; touching it marks it moved.
//
// What is where, for this group's items (forge-model.js's header is the contract):
// - A curve is its head `i<n>`, `curve.<kind>` with the shape's fields (`SHAPE_KEYS`; a
//   polycurve's pieces as `curve.polycurve` holds them) and `frame` (its plane: "xy" / "xz" /
//   "yz" for Top / Front / Right, `i<s>` a sketch, `f<b>_<k>` a face plane). `meta.forge`:
//   `kind`, the shape keys no node field holds (`shape.ends` of a polycurve), `plane` where the
//   frame does not give it back (a sketch that is gone: the curve is on Top), and any other
//   field the page keeps (`look`, ...).
// - A sketch is `i<n>_frame` (its plane) and the head `i<n>`, `sketch` `{ frame: "i<n>_frame",
//   forge_constraints? }`; a midplane sketch's faces are `i<n>_mid<k>` (`frame.on_face`) before
//   them. The frame: `frame.offset` (mode `offset`), `frame.tilted` (`angle`), `frame.on_path`
//   (`path`), `frame.on_face` (`face`), `frame.mid` (`mid`), `frame.through_ends` (`points`);
//   Top (`frame.offset` on "xy" by 0) where what it stands on is gone, as the page falls back.
//   `meta.forge`: `kind`, `mode`, and every plane parameter the frame node does not hold
//   (`base` / `offset` / `hinge` / `tilt` / `path` read off the frame where it holds them;
//   `face`, `mid`, `points` -- index picks -- always kept). A face's reference is the frame
//   node's: the command's `faceRefs` where it gives them, else `env.picks.faceRef`.
// - A held item copied or placed gets a head of its own: `solid.transform` of the held node
//   (`profile.translate` by 0 for a held profile), `meta.forge` `{ kind: "held" |
//   "held_profile", node, sheet? }`, so the model lists it as `i<n>` and not as the held node.
// - A stand-in: the head `i<n>` `value.unresolved` `{ type, why }`, the item's page fields
//   whole in `meta.forge`; a stand-in for a node an item reads that went (`delete`, `explode`,
//   ...) keeps its own id, and the node it was as `meta.forge.was`.
//
// # Readers
//
// A command that removes nodes (`delete`, `merge`, `snip`, `explode`) looks up who reads them
// with `document_readers`. Profile loops (`profile.from_curves` `curves` / `per_loop`) are
// rewritten as the page rewrote them (the arc a fillet adds, the curve a merge makes, the
// curves an explode or a trim leaves). Then every other node still reading what went: a curve
// or a sketch on a plane that went is written again (it falls back to Top, its `plane` kept
// in `meta.forge`); a sketch whose frame stood on what went falls back to Top the same way;
// any other node is a `value.unresolved` stand-in of its output type, `why` "<id>: curve #n
// is gone" (the 0.14 layer's words). A held node no item names any more goes with its last
// item.
import { headId, helperId, itemOfId, isFacePlaneId, CURVE_KINDS, isBodyKind, isBody, isSketch, isCurve, isHeldProfile, metaOp, bumpId } from "./forge-model.js";
import { bodyNode, facePlaneId, docPicks } from "./forge-picks.js";

/// How close the pieces of a curve must meet (the page's `LOOP_TOLERANCE`).
const LOOP_TOLERANCE = 1e-3;
/// How close two curves' ends must be for a sketch fillet to round their corner (the page's
/// `LOOP_TOLERANCE * 10`).
const MEET_TOLERANCE = 1e-2;

/// A command or an item kind the node layer does not write yet (5.3b-d port them).
export class Unported extends Error {}
const unported = (why) => { throw new Unported(why); };
const fail = (why) => { throw new Error(why); };

/// Fields the page keeps only while it runs: never written to a node (its `items()` hook
/// dropped them).
const RUNTIME_KEYS = ["cache", "gpu", "job", "dirty", "waiting", "version", "ghostFaces", "sig", "bounds", "beziers", "sketch", "error", "closure", "joined", "jobAt", "sigOut", "waitingSig", "rev"];

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === null || typeof v !== "object" ? v : structuredClone(v));
const get = (m, k) => (isMap(m) && Object.hasOwn(m, k) ? m[k] : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const U32_MAX = 4294967295;
const idOf = (v) => (typeof v === "number" && v >= 0 && Number.isInteger(v) && v <= U32_MAX ? v : undefined);
const idsOf = (v) => (Array.isArray(v) ? v.map(idOf).filter((x) => x !== undefined) : []);
const orElse = (v, b) => (v === undefined || v === null ? b : clone(v));

/// A command's value as the page keeps it, less the runtime keys at any depth.
function kept(v) {
    if (Array.isArray(v)) return v.map(kept);
    if (isMap(v)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (!RUNTIME_KEYS.includes(k)) out[k] = kept(x);
        return out;
    }
    return v;
}

/// Literal equality, objects by their keys in any order.
function same(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
    if (isMap(a)) {
        if (!isMap(b)) return false;
        const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
        return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
    }
    return false;
}

/// One kernel call; its refusal an `Error` in the kernel's words, the export's own
/// `<what>: ` taken off.
function call(kernel, name, ...args) {
    const fn = kernel?.[name];
    if (typeof fn !== "function") throw new Error(`the kernel has no \`${name}\``);
    try {
        return fn(...args);
    } catch (e) {
        const text = String(e?.message ?? e);
        const what = `${name.replace(/^cadaclysm_blacksmith_/, "")}: `;
        throw new Error(text.startsWith(what) ? text.slice(what.length) : text);
    }
}

/// The kinds by name, read once per kernel.
const registries = new WeakMap();
function kindsOf(kernel) {
    let r = registries.get(kernel);
    if (!r) {
        r = new Map(JSON.parse(call(kernel, "cadaclysm_blacksmith_document_kinds")).map((k) => [k.name, k]));
        registries.set(kernel, r);
    }
    return r;
}

// ---------------------------------------------------------------------------------
// Ids and planes.

/// The item a forge node belongs to (`i<n>` or `i<n>_<role>`), else undefined.
function ownerOf(id) {
    const m = typeof id === "string" ? /^i(0|[1-9][0-9]*)(?:_(.+))?$/.exec(id) : null;
    if (!m) return undefined;
    const n = Number(m[1]);
    return n <= U32_MAX ? n : undefined;
}

const ORIGIN_FRAMES = { top: "xy", front: "xz", right: "yz" };
const ORIGIN_PLANES = { xy: "top", xz: "front", yz: "right" };

/// The page's plane a frame field names: an origin plane, a sketch (`i<s>`), a face of a
/// body (`f<b>_<k>`); undefined for anything else.
function planeOfFrame(f) {
    if (typeof f !== "string") return undefined;
    if (Object.hasOwn(ORIGIN_PLANES, f)) return ORIGIN_PLANES[f];
    const s = itemOfId(f);
    if (s !== undefined) return s;
    if (isFacePlaneId(f)) {
        const [b, k] = f.slice(1).split("_");
        return `face:${Number(b)}:${Number(k)}`;
    }
    return undefined;
}

/// A page plane key: `{ origin }`, `{ sketch }` or `{ face: { body, index } }`.
function planeKey(v) {
    if (typeof v === "string") {
        if (Object.hasOwn(ORIGIN_FRAMES, v)) return { origin: v };
        const m = /^face:\+?([0-9]+):\+?([0-9]+)$/.exec(v);
        if (!m) return undefined;
        const body = Number(m[1]), index = Number(m[2]);
        return body <= U32_MAX && index <= U32_MAX ? { face: { body, index } } : undefined;
    }
    if (typeof v === "number" && v >= 0 && Number.isInteger(v)) return { sketch: Math.min(v, U32_MAX) };
    return undefined;
}

// ---------------------------------------------------------------------------------
// Curves and pieces.

/// The shape keys a curve kind's node holds.
const SHAPE_KEYS = {
    line: ["x0", "y0", "x1", "y1"], rect: ["x0", "y0", "x1", "y1"], arc: ["x0", "y0", "xm", "ym", "x1", "y1"], circle: ["cx", "cy", "r"],
    ellipse: ["cx", "cy", "rx", "ry"], polygon: ["cx", "cy", "r", "sides", "angle"], polyline: ["points", "closed"],
    nurbs: ["points", "degree", "weights", "closed"], polycurve: ["pieces", "closed"],
};
const PAGE_CURVE_KINDS = Object.fromEntries(Object.entries(CURVE_KINDS).map(([k, v]) => [v, k]));
const isCurveKind = (k) => Object.hasOwn(CURVE_KINDS, k);
/// An item that is there and a curve (forge-model.js's `isCurve` holds for no item at all).
const curveItem = (it) => it !== undefined && isCurve(it);

/// A polycurve piece as the page holds it (`{ kind, shape }`, `nurbs`) as `curve.polycurve`
/// takes it (`{ kind, ...shape }`, `spline`).
export function pieceToNode(p) {
    const k = get(p, "kind");
    const out = { kind: k === "nurbs" ? "spline" : k === undefined ? null : clone(k) };
    const sh = get(p, "shape");
    if (isMap(sh)) for (const [x, v] of Object.entries(sh)) out[x] = clone(v);
    return out;
}

/// A `curve.polycurve` piece as the page holds it.
export function pieceFromNode(p) {
    if (!isMap(p)) return clone(p);
    const { kind, ...shape } = p;
    return { kind: kind === "spline" ? "nurbs" : kind === undefined ? null : clone(kind), shape: clone(shape) };
}

/// A piece's two ends (node form): a line's or an arc's, a polyline's or spline's first and
/// last point; undefined where it has none.
function pieceEnds(p) {
    if (p.kind === "line" || p.kind === "arc") return [[p.x0, p.y0], [p.x1, p.y1]];
    const pts = p.points;
    return Array.isArray(pts) && pts.length ? [clone(pts[0]), clone(pts[pts.length - 1])] : undefined;
}

/// Whether a chain of pieces (node form, in chain order) ends on its start.
function chainCloses(pieces) {
    const a = pieces.length ? pieceEnds(pieces[0]) : undefined, b = pieces.length ? pieceEnds(pieces[pieces.length - 1]) : undefined;
    return Boolean(a && b) && same(a[0], b[1]);
}

/// The curve a chain of pieces (node form) is, as the page's `chainCurve` makes it: one piece
/// that piece's own kind; lines only a polyline; else a polycurve with its two ends.
function curveOfPieces(pieces, closed = false) {
    if (pieces.length === 1 && !closed) {
        const { kind, shape } = pieceFromNode(pieces[0]);
        return { kind, shape };
    }
    if (pieces.length && pieces.every((p) => p.kind === "line")) {
        const pts = [[pieces[0].x0, pieces[0].y0], ...pieces.map((p) => [p.x1, p.y1])];
        if (closed) pts.pop();
        return { kind: "polyline", shape: { points: pts, closed } };
    }
    return { kind: "polycurve", shape: { pieces: pieces.map(pieceFromNode), closed, ends: endsOf(pieces, closed) } };
}

/// A polycurve's `ends` as the page keeps them: its first piece's start and its last
/// piece's end, `[[0, 0], [0, 0]]` closed.
function endsOf(pieces, closed) {
    if (closed || !pieces.length) return [[0, 0], [0, 0]];
    return [pieceEnds(pieces[0])?.[0] ?? null, pieceEnds(pieces[pieces.length - 1])?.[1] ?? null];
}

/// A curve item's pieces (node form) and whether `profile_from_pieces` is to close them.
function piecesOfCurve(c) {
    const kind = get(c, "kind"), shape = get(c, "shape");
    if (kind === "polycurve") {
        const p = get(shape, "pieces");
        if (!Array.isArray(p)) fail("a polycurve without pieces");
        return { pieces: p.map(pieceToNode), closed: get(shape, "closed") === true };
    }
    if (!isCurveKind(kind)) fail(`no curve kind \`${kind}\``);
    const piece = { kind: kind === "nurbs" ? "spline" : kind };
    for (const k of SHAPE_KEYS[kind]) if (get(shape, k) !== undefined) piece[k] = clone(shape[k]);
    return { pieces: [piece], closed: false };
}

/// `f` on a new profile handle, freed after.
function withProfile(kernel, make, f) {
    const h = make();
    try {
        return f(h);
    } finally {
        call(kernel, "cadaclysm_blacksmith_profile_free", h);
    }
}

/// A curve item as a profile handle (free it).
function curveProfile(kernel, c) {
    const { pieces, closed } = piecesOfCurve(c);
    return call(kernel, "cadaclysm_blacksmith_profile_from_pieces", JSON.stringify(pieces), closed, LOOP_TOLERANCE);
}

const piecesJson = (kernel, h) => JSON.parse(call(kernel, "cadaclysm_blacksmith_profile_pieces_json", h));

const CLOSED_KINDS = ["rect", "polygon", "circle", "ellipse"];

/// The sketch fillet (see the header). `curves`: item fields (`{ kind, shape }`).
export function sketchFillet(kernel, curves, radius) {
    if (curves.length === 2) {
        const [a, b] = curves;
        if (!a || !b) fail("a fillet of two curves needs both");
        const out = withProfile(kernel, () => curveProfile(kernel, a), (ha) => withProfile(kernel, () => curveProfile(kernel, b), (hb) =>
            JSON.parse(call(kernel, "cadaclysm_blacksmith_profile_fillet_corner", ha, hb, radius, MEET_TOLERANCE))));
        return { two: { a: curveOfPieces(out.a), b: curveOfPieces(out.b), arc: pieceFromNode(out.arc).shape } };
    }
    if (curves.length !== 1 || !curves[0]) fail("a sketch fillet takes one curve or two");
    const c = curves[0], kind = get(c, "kind"), shape = get(c, "shape");
    return withProfile(kernel, () => curveProfile(kernel, c), (h) => {
        const closed = CLOSED_KINDS.includes(kind) ? true
            : kind === "polycurve" ? get(shape, "closed") === true || chainCloses(piecesJson(kernel, h))
                : get(shape, "closed") === true;
        const pieces = withProfile(kernel, () => call(kernel, "cadaclysm_blacksmith_profile_round", h, radius, null, !closed), (r) => piecesJson(kernel, r));
        const out = { pieces: pieces.map(pieceFromNode) };
        // A polyline keeps its own `closed`, as the page handed it on (absent: left out).
        const cl = kind === "polyline" ? get(shape, "closed") : closed;
        if (cl !== undefined) out.closed = cl;
        out.ends = endsOf(pieces, closed);
        return { one: { kind: "polycurve", shape: out } };
    });
}

/// The sketch trim (see the header). `curve`, `cutters`: item fields.
export function trimmedCurves(kernel, curve, cutters, piece) {
    const handles = [];
    try {
        for (const c of cutters) handles.push(curveProfile(kernel, c));
        const hs = Uint32Array.from(handles);
        return withProfile(kernel, () => curveProfile(kernel, curve), (h) => {
            const n = call(kernel, "cadaclysm_blacksmith_profile_trim_count", h, hs, piece, LOOP_TOLERANCE);
            const out = [];
            for (let k = 0; k < n; k++) {
                const pieces = withProfile(kernel, () => call(kernel, "cadaclysm_blacksmith_profile_trim_chain", h, hs, piece, k, LOOP_TOLERANCE), (t) => piecesJson(kernel, t));
                out.push(curveOfPieces(pieces));
            }
            return out;
        });
    } finally {
        for (const h of handles) call(kernel, "cadaclysm_blacksmith_profile_free", h);
    }
}

// ---------------------------------------------------------------------------------
// The draft.

/// The document as a command's ops leave it (see the header).
export class Draft {
    constructor(model, env = {}, broken = new Map()) {
        this.model = model;
        this.kernel = model.kernel;
        this.doc = model.doc;
        this.env = env;
        this.broken = broken;          // item -> why: written as a stand-in (the kernel refused its node)
        this.ops = [];
        this.order = model.nodes().map((n) => n.id);
        this.over = new Map();         // id -> node as the ops left it, null: removed
        this.written = new Set();      // the items whose nodes this command wrote
        this._meta = undefined;
    }

    node(id) {
        return this.over.has(id) ? (this.over.get(id) ?? undefined) : this.model.node(id);
    }

    has(id) {
        return this.node(id) !== undefined;
    }

    index(id) {
        return this.order.indexOf(id);
    }

    /// The command's copy of the forge meta; asking for it marks it moved.
    forge() {
        this._meta ??= this.model.forgeMeta();
        return this._meta;
    }

    get metaMoved() {
        return this._meta !== undefined;
    }

    nameFor(kind) {
        return this.model.nameFor(kind, this.forge()).name;
    }

    bump(n) {
        bumpId(this.forge(), n);
    }

    add(node, at = this.order.length) {
        at = Math.min(Math.max(at, 0), this.order.length);
        this.order.splice(at, 0, node.id);
        this.over.set(node.id, node);
        this.ops.push({ op: "add", node, at });
        this._wrote(node.id);
    }

    set(id, fields) {
        const cur = this.node(id) ?? fail(`set: no node \`${id}\``);
        const next = { ...cur };
        for (const [k, v] of Object.entries(fields)) {
            if (v === null) delete next[k];
            else next[k] = clone(v);
        }
        this.over.set(id, next);
        this.ops.push({ op: "set", id, fields });
        this._wrote(id);
    }

    remove(id) {
        const at = this.index(id);
        if (at < 0) fail(`remove: no node \`${id}\``);
        this.order.splice(at, 1);
        this.over.set(id, null);
        this.ops.push({ op: "remove", id });
        this._wrote(id);
    }

    /// Node `id` as `node`, whose kind differs: removed, and added again at its place.
    replace(id, node) {
        const at = this.index(id);
        this.remove(id);
        this.add(node, at);
    }

    _wrote(id) {
        const n = ownerOf(id);
        if (n !== undefined) this.written.add(n);
    }

    /// The ids of item `n`'s nodes (its helpers and its head), in document order.
    nodesOf(n) {
        return this.order.filter((id) => ownerOf(id) === n);
    }

    /// Item `n` as the model lists it, while its nodes are still in the draft; undefined
    /// for none (or one this command removed).
    item(n) {
        const it = this.model.item(n);
        if (it) return this.has(it.of !== undefined ? it.node : headId(n)) ? it : undefined;
        // One this command wrote.
        const head = this.node(headId(n));
        if (!head) return undefined;
        const kind = head.meta?.forge?.kind;
        return { id: n, head, helpers: [], kind: typeof kind === "string" ? kind : (PAGE_CURVE_KINDS[head.kind] ?? ""), name: head.name };
    }

    /// The nodes that read node `id`, as the document has them before this command.
    readers(id) {
        if (this.model.node(id) === undefined) return [];
        return JSON.parse(call(this.kernel, "cadaclysm_blacksmith_document_readers", this.doc, id, false));
    }

    /// The face reference of face `k` of body item `b`, off the evaluated document.
    faceRef(b, k) {
        const picks = this.env?.picks ?? fail(`no geometry: face ${k} of #${b}`);
        return picks.faceRef(b, k);
    }
}

// ---------------------------------------------------------------------------------
// Items: their page fields off their nodes, and back.

/// What reads the page's frame field `plane` resolves to, for item `n` writing it: a frame
/// literal, or a face plane's node (`pending` gets it when it is new).
function frameFor(d, plane, pending) {
    const k = planeKey(plane);
    if (!k) return "xy";
    if (k.origin) return ORIGIN_FRAMES[k.origin];
    if (k.sketch !== undefined) return isSketch(d.item(k.sketch)) ? headId(k.sketch) : "xy";
    const { body, index } = k.face;
    if (!isBody(d.item(body))) return "xy";
    const id = facePlaneId(body, index);
    if (!d.has(id) && !pending.some((p) => p.id === id)) {
        pending.push({ id, kind: "frame.on_face", solid: bodyNode(d.model, body), face: d.faceRef(body, index) });
    }
    return id;
}

/// The head's own keys, its page fields' name and hidden flag.
function headOf(n, kind, fields) {
    const out = { id: headId(n), kind };
    if (typeof fields.name === "string") out.name = fields.name;
    if (fields.hidden === true) out.hidden = true;
    return out;
}

/// Fields the head node holds outside `meta.forge`.
const OWN = ["id", "name", "hidden"];

/// The page fields of a stand-in, off its head.
function readStandIn(n, head) {
    const mf = clone(head.meta?.forge ?? {});
    delete mf.was;
    return { ...mf, id: n, name: head.name, hidden: head.hidden === true };
}

const curveClass = {
    read(d, n, head) {
        const mf = head.meta?.forge ?? {};
        const kind = typeof mf.kind === "string" ? mf.kind : PAGE_CURVE_KINDS[head.kind];
        const shape = {};
        for (const k of SHAPE_KEYS[kind] ?? []) {
            if (head[k] === undefined) continue;
            shape[k] = k === "pieces" && Array.isArray(head[k]) ? head[k].map(pieceFromNode) : clone(head[k]);
        }
        Object.assign(shape, clone(mf.shape ?? {}));
        const out = { id: n, name: head.name, kind, plane: Object.hasOwn(mf, "plane") ? clone(mf.plane) : planeOfFrame(head.frame ?? "xy"), shape };
        for (const [k, v] of Object.entries(mf)) if (!["kind", "plane", "shape"].includes(k)) out[k] = clone(v);
        out.hidden = head.hidden === true;
        return out;
    },
    write(d, n, c, pending) {
        const kind = c.kind;
        if (!isCurveKind(kind)) return [standIn(n, c, "curve", `${headId(n)}: no item kind \`${kind}\``)];
        const head = headOf(n, CURVE_KINDS[kind], c);
        const shape = isMap(c.shape) ? c.shape : {};
        const mfShape = {};
        for (const [k, v] of Object.entries(shape)) {
            if (v === undefined) continue;
            if (SHAPE_KEYS[kind].includes(k)) head[k] = k === "pieces" && Array.isArray(v) ? v.map(pieceToNode) : clone(v);
            else mfShape[k] = clone(v);
        }
        head.frame = frameFor(d, c.plane, pending);
        const mf = { kind };
        if (c.plane !== undefined && !same(planeOfFrame(head.frame), c.plane)) mf.plane = clone(c.plane);
        if (Object.keys(mfShape).length) mf.shape = mfShape;
        for (const [k, v] of Object.entries(c)) if (v !== undefined && ![...OWN, "kind", "plane", "shape"].includes(k)) mf[k] = clone(v);
        head.meta = { forge: mf };
        return [head];
    },
};

/// The plane parameters a sketch frame node holds, as the page's fields.
function frameParams(f) {
    if (!f) return {};
    switch (f.kind) {
        case "frame.offset": {
            const base = Object.hasOwn(ORIGIN_PLANES, f.base ?? "xy") ? ORIGIN_PLANES[f.base ?? "xy"] : undefined;
            return base === undefined ? {} : { base, offset: f.offset ?? 0 };
        }
        case "frame.tilted": return { hinge: itemOfId(f.hinge), tilt: f.tilt };
        case "frame.on_path": return { path: itemOfId(f.path) };
        default: return {};
    }
}

/// The page's own copy of a face's reference: `faceRefs[k]` where the command gave it.
const givenRef = (c, k) => (Array.isArray(c.faceRefs) && isMap(c.faceRefs[k]) ? clone(c.faceRefs[k]) : undefined);

/// A sketch's frame node `i<n>_frame` (forge.js `planeInfo`) and the `i<n>_mid<k>` faces a
/// midplane stands between: Top where what it stands on is gone, as the page falls back.
function sketchFrame(d, n, c, pending) {
    const id = helperId(n, "frame");
    const fallback = () => [{ id, kind: "frame.offset", base: "xy", offset: 0 }];
    const curve = (v) => {
        const i = idOf(v);
        return i !== undefined && curveItem(d.item(i)) ? headId(i) : undefined;
    };
    switch (typeof c.mode === "string" ? c.mode : "") {
        case "offset": {
            const o = num(c.offset);
            return Object.hasOwn(ORIGIN_FRAMES, c.base) && o !== undefined ? [{ id, kind: "frame.offset", base: ORIGIN_FRAMES[c.base], offset: o }] : fallback();
        }
        case "angle": {
            const h = curve(c.hinge), t = num(c.tilt);
            return h !== undefined && t !== undefined ? [{ id, kind: "frame.tilted", hinge: h, tilt: t }] : fallback();
        }
        case "path": {
            const p = curve(c.path);
            return p !== undefined ? [{ id, kind: "frame.on_path", path: p }] : fallback();
        }
        case "face": {
            const b = idOf(get(c.face, "body"));
            if (b === undefined || !isBody(d.item(b))) return fallback();
            const k = idOf(get(c.face, "index"));
            const ref = givenRef(c, 0) ?? (k !== undefined ? d.faceRef(b, k) : fail(`${id}: a pick has no reference`));
            return [{ id, kind: "frame.on_face", solid: bodyNode(d.model, b), face: ref }];
        }
        case "mid": {
            if (!Array.isArray(c.mid) || c.mid.length !== 2) return fallback();
            const out = [], frames = [];
            for (let k = 0; k < 2; k++) {
                const r = c.mid[k];
                let fr;
                if (isMap(r)) {
                    const b = idOf(get(r, "body"));
                    if (b !== undefined && isBody(d.item(b))) {
                        const i = idOf(get(r, "index"));
                        const ref = givenRef(c, k) ?? (i !== undefined ? d.faceRef(b, i) : fail(`${helperId(n, `mid${k}`)}: a pick has no reference`));
                        fr = helperId(n, `mid${k}`);
                        out.push({ id: fr, kind: "frame.on_face", solid: bodyNode(d.model, b), face: ref });
                    }
                } else if (idOf(r) !== n) {
                    const key = planeKey(r);
                    fr = key ? frameFor(d, r, pending) : undefined;
                    if (fr === "xy" && !(key?.origin)) fr = undefined;   // a plane that is gone
                }
                if (fr === undefined) return fallback();
                frames.push(fr);
            }
            return [...out, { id, kind: "frame.mid", a: frames[0], b: frames[1] }];
        }
        case "points": {
            if (!Array.isArray(c.points)) return fallback();
            const curves = [], ends = [];
            for (const p of c.points) {
                const ci = idOf(get(p, "curve")), e = num(get(p, "end"));
                const it = ci === undefined ? undefined : d.item(ci);
                if (!curveItem(it) || (e !== 0 && e !== 1) || same(readItem(d, ci).plane, n)) return fallback();
                curves.push(headId(ci));
                ends.push(e);
            }
            return [{ id, kind: "frame.through_ends", curves, ends }];
        }
        default: return fallback();
    }
}

const SKETCH_NODE_HELD = ["constraints", "faceRefs"];

const sketchClass = {
    read(d, n, head) {
        const mf = head.meta?.forge ?? {};
        const frame = d.node(typeof head.frame === "string" ? head.frame : "");
        const out = { id: n, name: head.name, kind: "sketch", ...frameParams(frame) };
        for (const [k, v] of Object.entries(mf)) if (k !== "kind") out[k] = clone(v);
        if (head.forge_constraints !== undefined) out.constraints = clone(head.forge_constraints);
        out.hidden = head.hidden === true;
        return out;
    },
    write(d, n, c, pending) {
        const frames = sketchFrame(d, n, c, pending);
        const held = frameParams(frames[frames.length - 1]);
        const head = headOf(n, "sketch", c);
        head.frame = helperId(n, "frame");
        if (c.constraints !== undefined) head.forge_constraints = clone(c.constraints);
        const mf = { kind: "sketch" };
        for (const [k, v] of Object.entries(c)) {
            if (v === undefined || [...OWN, "kind", ...SKETCH_NODE_HELD].includes(k)) continue;
            if (Object.hasOwn(held, k) && same(held[k], v)) continue;
            mf[k] = clone(v);
        }
        head.meta = { forge: mf };
        return [...frames, head];
    },
};

/// A held item placed on the page: a head of its own over the held node.
const heldClass = {
    read(d, n, head) {
        const mf = head.meta?.forge ?? {};
        const out = { id: n, name: head.name };
        for (const [k, v] of Object.entries(mf)) out[k] = clone(v);
        out.hidden = head.hidden === true;
        return out;
    },
    write(d, n, c) {
        const profile = c.kind === "held_profile";
        const head = headOf(n, profile ? "profile.translate" : "solid.transform", c);
        if (profile) Object.assign(head, { profile: c.node, by: [0, 0] });
        else head.solid = c.node;
        const mf = {};
        for (const [k, v] of Object.entries(c)) if (v !== undefined && !OWN.includes(k)) mf[k] = clone(v);
        head.meta = { forge: mf };
        return [head];
    },
};

/// Item classes by the page's kind: each `{ read(d, n, head), write(d, n, fields, pending) }`.
/// Bodies are added by the made-body and verb groups.
export const ITEM_CLASSES = { curve: curveClass, sketch: sketchClass, held: heldClass };

/// The class name of a page kind.
export function classOf(kind) {
    if (kind === "sketch") return "sketch";
    if (kind === "held" || kind === "held_profile") return "held";
    if (isBodyKind(kind)) return "body";
    if (kind === "image") return "image";
    return "curve";
}

function classFor(kind) {
    const name = classOf(kind);
    return ITEM_CLASSES[name] ?? unported(`a ${kind} item is not on nodes yet`);
}

/// The stand-in for item `n` (fields `c`): `value.unresolved` of `type`, failing with `why`.
function standIn(n, c, type, why) {
    const head = headOf(n, "value.unresolved", c);
    Object.assign(head, { type, why });
    const mf = {};
    for (const [k, v] of Object.entries(c)) if (v !== undefined && !OWN.includes(k)) mf[k] = clone(v);
    head.meta = { forge: mf };
    return head;
}

const standInType = (kind) => (kind === "sketch" ? "sketch" : classOf(kind) === "curve" ? "curve" : kind === "held_profile" ? "profile" : "solid");

/// Item `n`'s page fields, read off its nodes as the draft has them. A held item with no
/// head of its own reads off its held node.
export function readItem(d, n) {
    const head = d.node(headId(n));
    if (!head) {
        const it = d.item(n);
        if (it?.of === undefined) fail(`#${n} is not an item`);
        const out = { id: n, name: it.name, kind: it.kind, node: it.node };
        if (it.of === "sheet") out.sheet = true;
        out.hidden = it.head.hidden === true;
        return out;
    }
    const mf = head.meta?.forge ?? {};
    if (head.kind === "value.unresolved") return readStandIn(n, head);
    const kind = typeof mf.kind === "string" ? mf.kind : (PAGE_CURVE_KINDS[head.kind] ?? "");
    return classFor(kind).read(d, n, head);
}

/// The fields `set` takes to turn node `cur` into `want` (a field gone is `null`).
function fieldsDiff(cur, want) {
    const out = {};
    for (const [k, v] of Object.entries(want)) {
        if (k === "id" || k === "kind") continue;
        if (k === "hidden") continue;
        if (!same(cur[k], v)) out[k] = clone(v);
    }
    for (const k of Object.keys(cur)) if (!["id", "kind", "hidden"].includes(k) && want[k] === undefined && cur[k] !== undefined) out[k] = null;
    if ((cur.hidden === true) !== (want.hidden === true)) out.hidden = want.hidden === true;
    return out;
}

/// Item `n` written as `fields` asks: its class's nodes, the ops between those and the
/// nodes the item has. A new item's nodes go at `at` (the end when not given); a node of
/// it the item lacks goes before its first node there is. Another app's keys in a node's
/// `meta` are kept.
export function writeItem(d, n, fields, at) {
    const c = { ...fields, id: n };
    const pending = [];
    const want = d.broken.has(n) ? [standIn(n, c, standInType(c.kind), d.broken.get(n))] : classFor(c.kind).write(d, n, c, pending);
    const have = d.nodesOf(n);
    const wanted = new Set(want.map((x) => x.id));
    for (const id of have) if (!wanted.has(id)) d.remove(id);
    const first = have.find((id) => wanted.has(id));
    let pos = first !== undefined ? d.index(first) : (at ?? d.order.length);
    for (const nd of pending) d.add(nd, pos++);
    for (const nd of want) {
        const cur = d.node(nd.id);
        if (cur) {
            const others = isMap(cur.meta) ? Object.fromEntries(Object.entries(cur.meta).filter(([k]) => k !== "forge")) : {};
            if (Object.keys(others).length) nd.meta = { ...others, ...(nd.meta ?? {}) };
            if (cur.kind !== nd.kind) d.replace(nd.id, nd);
            else {
                const diff = fieldsDiff(cur, nd);
                if (Object.keys(diff).length) d.set(nd.id, diff);
            }
            pos = d.index(nd.id) + 1;
        } else d.add(nd, pos++);
    }
}

// ---------------------------------------------------------------------------------
// Profile loops and readers.

/// The loops a `profile.from_curves` node reads, as item ids; undefined where a curve is not
/// an item's head or `per_loop` does not add up.
function loopsOfNode(nd) {
    const ids = Array.isArray(nd.curves) ? nd.curves.map(itemOfId) : undefined;
    if (!ids || ids.includes(undefined)) return undefined;
    const per = Array.isArray(nd.per_loop) ? nd.per_loop : [ids.length];
    if (per.reduce((a, b) => a + b, 0) !== ids.length) return undefined;
    let at = 0;
    return per.map((k) => { at += k; return ids.slice(at - k, at); });
}

/// Every profile loop that reads one of curve items `curves` rewritten by `rewrite` (the
/// page's `rewriteLoops`).
function rewriteLoops(d, curves, rewrite) {
    const seen = new Set();
    for (const c of curves) {
        for (const r of d.readers(headId(c))) {
            if (seen.has(r)) continue;
            seen.add(r);
            const nd = d.node(r);
            if (nd?.kind !== "profile.from_curves") continue;
            const loops = loopsOfNode(nd);
            if (!loops) continue;
            const next = rewrite(loops);
            if (same(next, loops)) continue;
            const fields = { curves: next.flat().map(headId) };
            if (nd.per_loop !== undefined || next.length !== 1) fields.per_loop = next.map((l) => l.length);
            d.set(r, fields);
        }
    }
}

/// forge's old recipe.js `loopsWithArc`.
function loopsWithArc(loops, a, b, arc) {
    return loops.map((l) => {
        const ia = l.indexOf(a), ib = l.indexOf(b);
        if (ia < 0 || ib < 0) return l;
        const n = l.length, out = l.slice();
        if (ib === ia + 1 || (ia === n - 1 && ib === 0)) out.splice(ia + 1, 0, arc);
        else if (ia === ib + 1 || (ib === n - 1 && ia === 0)) out.splice(ib + 1, 0, arc);
        else out.splice(ia + 1, 0, arc);
        return out;
    });
}

/// forge's old recipe.js `loopsMerged`.
function loopsMerged(loops, ids, into) {
    return loops.map((l) => {
        if (!l.some((x) => ids.includes(x))) return l;
        const out = [];
        let placed = false;
        for (const id of l) {
            if (!ids.includes(id)) out.push(id);
            else if (!placed) { out.push(into); placed = true; }
        }
        return out;
    });
}

/// forge's old recipe.js `loopsExploded`.
const loopsExploded = (loops, id, pieces) => loops.map((l) => (l.includes(id) ? l.flatMap((k) => (k === id ? pieces.slice() : [k])) : l));

/// Whether literal `v` names one of `ids` anywhere.
function names(v, ids) {
    if (typeof v === "string") return ids.has(v);
    if (Array.isArray(v)) return v.some((x) => names(x, ids));
    if (isMap(v)) return Object.values(v).some((x) => names(x, ids));
    return false;
}
const fieldsNaming = (nd, ids) => Object.entries(nd).some(([k, v]) => !["id", "kind", "name", "hidden", "meta"].includes(k) && names(v, ids));

/// A node's output type as `value.unresolved` names it.
function outputType(d, nd, depth = 0) {
    const kind = kindsOf(d.kernel).get(nd.kind);
    const out = kind?.output;
    const CHOICES = ["solid", "sheet", "body", "curve", "profile", "sketch", "frame", "number", "record"];
    if (typeof out === "string") {
        if (CHOICES.includes(out)) return out;
        if (out === "profiles") return "profile";
        if (out === "value" && nd.kind === "value.unresolved") return nd.type ?? "solid";
        return "record";
    }
    if (isMap(out) && typeof out.like === "string" && depth < 64) {
        const from = d.node(nd[out.like]);
        return from ? outputType(d, from, depth + 1) : "solid";
    }
    return "solid";
}

/// The words for what went: "curve #1", "sketch #2", "body #3", "node `x`".
function whatOf(d, id) {
    const n = ownerOf(id);
    if (n === undefined) return isFacePlaneId(id) ? `face plane \`${id}\`` : `node \`${id}\``;
    const it = d.model.item(n);
    return `${isSketch(it) ? "sketch" : isBody(it) ? "body" : curveItem(it) ? "curve" : "item"} #${n}`;
}

/// Every node outside `gone` that still reads one of `gone` (removed by this command) made
/// whole again: see the header's Readers.
function orphanReaders(d, gone) {
    const set = new Set(gone);
    const done = new Set();
    for (const g of gone) {
        for (const r of d.readers(g)) {
            if (set.has(r) || done.has(r)) continue;
            const nd = d.node(r);
            if (!nd || !fieldsNaming(nd, set)) continue;
            done.add(r);
            const n = ownerOf(r);
            const it = n === undefined ? undefined : d.item(n);
            if (it && it.of === undefined && (isSketch(it) || (isCurve(it) && !isHeldProfile(it))) && nd.kind !== "value.unresolved") {
                writeItem(d, n, readItem(d, n));   // its plane or its frame falls back
                continue;
            }
            const went = [...set].find((id) => names(Object.fromEntries(Object.entries(nd).filter(([k]) => !["id", "kind", "name", "hidden", "meta"].includes(k))), new Set([id])));
            const was = Object.fromEntries(Object.entries(nd).filter(([k]) => !["id", "meta"].includes(k)));
            const stand = { id: r, kind: "value.unresolved", type: outputType(d, nd), why: `${r}: ${whatOf(d, went)} is gone` };
            if (typeof nd.name === "string") stand.name = nd.name;
            if (nd.hidden === true) stand.hidden = true;
            stand.meta = { ...(isMap(nd.meta) ? clone(nd.meta) : {}), forge: { ...(clone(nd.meta?.forge) ?? {}), was } };
            d.replace(r, stand);
        }
    }
}

/// Items `ns` taken out (their nodes removed), at the position of the first; returns that
/// position and the removed ids.
function takeOut(d, ns) {
    const ids = d.order.filter((id) => ns.includes(ownerOf(id)));
    const at = ids.length ? d.index(ids[0]) : d.order.length;
    for (const id of ids) d.remove(id);
    return { at, ids };
}

// ---------------------------------------------------------------------------------
// The commands.

function opOf(cmd) {
    const o = get(cmd, "op");
    return typeof o === "string" ? o : "";
}

function cmdId(cmd, key, op) {
    const id = idOf(get(cmd, key));
    if (id === undefined) fail(`${op}: \`${key}\` is not an id`);
    return id;
}

/// A kind named by a command: its string, or "undefined" as a template string writes it.
function kindIn(l) {
    const k = get(l, "kind");
    return typeof k === "string" ? k : "undefined";
}

/// A name as a template string writes it (`${c.name} copy`).
function nameText(n) {
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    return n === null ? "null" : "undefined";
}

/// A new curve item `n` from a page definition (`{ kind, shape }`) on `plane`, at `at`.
function newCurve(d, n, def, plane, at) {
    d.bump(n);
    const kind = kindIn(def);
    const c = { id: n, name: d.nameFor(kind), kind };
    if (plane !== undefined) c.plane = clone(plane);
    const sh = get(def, "shape");
    if (sh !== undefined) c.shape = kept(sh);
    c.hidden = false;
    writeItem(d, n, c, at);
}

/// Each `{ id, ...fields }` set on its item (forge.js `editItems`).
function editItems(d, list) {
    if (!Array.isArray(list)) return;
    for (const it of list) {
        const n = idOf(get(it, "id"));
        if (n === undefined || !d.item(n) || !isMap(it)) continue;
        const c = readItem(d, n);
        for (const [k, v] of Object.entries(it)) if (k !== "id" && !RUNTIME_KEYS.includes(k)) c[k] = kept(v);
        writeItem(d, n, c);
    }
}

/// Item `n` copied as `copy` (named `name`), its nodes right after its head.
function copyNodes(d, n, copy, name) {
    const ids = d.nodesOf(n);
    const rename = new Map(ids.map((id) => [id, `i${copy}${id.slice(`i${n}`.length)}`]));
    const swap = (v) => {
        if (typeof v === "string") return rename.get(v) ?? v;
        if (Array.isArray(v)) return v.map(swap);
        if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
        return v;
    };
    let pos = d.index(headId(n)) + 1;
    for (const id of ids) {
        const nd = d.node(id);
        const out = { id: rename.get(id), kind: nd.kind };
        for (const [k, v] of Object.entries(nd)) if (!["id", "kind", "meta"].includes(k)) out[k] = k === "name" || k === "hidden" ? clone(v) : swap(clone(v));
        if (nd.meta !== undefined) out.meta = clone(nd.meta);
        if (id === headId(n)) out.name = name;
        d.add(out, pos++);
    }
}

/// The ops of `cmd` (see the header) on a draft.
function build(model, cmd, env, broken) {
    const d = new Draft(model, env, broken);
    const op = opOf(cmd);
    switch (op) {
        case "add": {
            const n = cmdId(cmd, "id", op);
            newCurve(d, n, cmd, get(cmd, "plane"));
            editItems(d, get(cmd, "items"));
            break;
        }
        // A reference image is the session's: only its id is taken.
        case "image":
            d.bump(cmdId(cmd, "id", op));
            break;
        case "sketch": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const c = { id: n, name: d.nameFor("sketch"), kind: "sketch" };
            for (const k of ["mode", "base", "offset"]) if (get(cmd, k) !== undefined) c[k] = clone(cmd[k]);
            c.hinge = orElse(get(cmd, "hinge"), null);
            if (get(cmd, "tilt") !== undefined) c.tilt = clone(cmd.tilt);
            c.path = orElse(get(cmd, "path"), null);
            for (const k of ["face", "mid", "points"]) c[k] = get(cmd, k) ? kept(cmd[k]) : null;
            if (get(cmd, "faceRefs") !== undefined) c.faceRefs = kept(cmd.faceRefs);
            c.hidden = false;
            if (get(cmd, "constraints")) c.constraints = kept(cmd.constraints);
            writeItem(d, n, c);
            break;
        }
        case "duplicate": {
            const copies = idsOf(get(cmd, "copies"));
            idsOf(get(cmd, "ids")).forEach((n, k) => {
                const copy = copies[k];
                if (copy === undefined) return;
                d.bump(copy);   // an image's copy (the page's) takes its id all the same
                const it = d.item(n);
                if (!it) return;
                const name = `${nameText(it.name)} copy`;
                if (it.of !== undefined) {
                    // A held item copied: the held node gets a head for each, so the model
                    // lists both (and not the node) from here on.
                    const c = readItem(d, n);
                    const at = d.index(it.node) + 1;
                    writeItem(d, n, c, at);
                    writeItem(d, copy, { ...c, name }, d.index(headId(n)) + 1);
                    return;
                }
                const cls = classOf(it.kind);
                if (cls === "curve" && d.node(headId(n)).kind !== "value.unresolved") {
                    const c = readItem(d, n);
                    const out = { id: copy, name };
                    for (const key of ["kind", "plane", "shape", "node"]) if (c[key] !== undefined) out[key] = clone(c[key]);
                    out.hidden = c.hidden;
                    writeItem(d, copy, out, d.index(headId(n)) + 1);
                } else if (cls === "sketch" && d.node(headId(n)).kind !== "value.unresolved") {
                    const c = readItem(d, n);
                    const out = { ...c, id: copy, name };
                    if (c.constraints) out.constraints = [];
                    writeItem(d, copy, out, d.index(headId(n)) + 1);
                } else copyNodes(d, n, copy, name);
            });
            break;
        }
        case "delete": {
            // A sketch takes what is on it along (what has a node on its frame).
            const doomed = idsOf(get(cmd, "ids")).filter((n) => d.item(n));
            for (const n of doomed.slice()) {
                if (!isSketch(d.item(n))) continue;
                for (const it of model.items()) {
                    if (doomed.includes(it.id) || it.of !== undefined) continue;
                    if (d.nodesOf(it.id).some((id) => d.node(id)?.frame === headId(n))) doomed.push(it.id);
                }
            }
            const gone = [];
            const heldNamed = (keep) => new Set(model.items().filter((it) => keep(it.id)).map((it) => (it.of !== undefined ? it.node : model.node(headId(it.id))?.meta?.forge?.node)).filter((v) => typeof v === "string"));
            const before = heldNamed((id) => doomed.includes(id));
            const after = heldNamed((id) => !doomed.includes(id));
            for (const n of doomed) {
                const it = d.item(n);
                if (it.of !== undefined) continue;
                for (const id of d.nodesOf(n)) { d.remove(id); gone.push(id); }
                if (isBody(it)) for (const id of d.order.filter((x) => isFacePlaneId(x) && x.startsWith(`f${n}_`))) { d.remove(id); gone.push(id); }
            }
            // A held node no item names any more goes with its last item.
            for (const id of before) if (!after.has(id) && d.has(id)) { d.remove(id); gone.push(id); }
            orphanReaders(d, gone);
            break;
        }
        case "round": {
            const ids = idsOf(get(cmd, "ids"));
            const radius = num(get(cmd, "radius")) ?? NaN;
            const picked = ids.map((n) => (d.item(n) ? readItem(d, n) : undefined));
            if (picked.some((c) => c === undefined || classOf(c.kind) !== "curve")) fail("round: pick one curve or two");
            const done = sketchFillet(d.kernel, picked, radius);
            if (done.two) {
                const [ia, ib] = ids;
                const { a, b, arc } = done.two;
                writeItem(d, ia, { ...picked[0], kind: a.kind, shape: a.shape });
                writeItem(d, ib, { ...picked[1], kind: b.kind, shape: b.shape });
                const arcId = cmdId(cmd, "arc", op);
                d.bump(arcId);
                const c = { id: arcId, name: d.nameFor("arc"), kind: "arc" };
                if (picked[0].plane !== undefined) c.plane = clone(picked[0].plane);
                c.shape = arc;
                c.hidden = false;
                writeItem(d, arcId, c, d.index(headId(ib)) + 1);
                rewriteLoops(d, [ia, ib], (l) => loopsWithArc(l, ia, ib, arcId));
            } else {
                writeItem(d, ids[0], { ...picked[0], kind: "polycurve", shape: done.one.shape });
            }
            break;
        }
        case "merge": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const taken = idsOf(get(cmd, "ids")).filter((i) => d.item(i));
            const c = { id: n, name: d.nameFor("polycurve"), kind: "polycurve" };
            if (get(cmd, "plane") !== undefined) c.plane = clone(cmd.plane);
            const shape = {};
            for (const key of ["pieces", "closed", "ends"]) if (get(cmd, key) !== undefined) shape[key] = kept(cmd[key]);
            c.shape = shape;
            c.hidden = false;
            rewriteLoops(d, taken, (l) => loopsMerged(l, taken, n));
            const { at, ids } = takeOut(d, taken);
            writeItem(d, n, c, at);
            orphanReaders(d, ids);
            break;
        }
        // The sketch trim ("trim" is the sheet's) and a polycurve taken into its pieces.
        case "snip":
        case "explode": {
            const n = cmdId(cmd, "id", op);
            if (!d.item(n)) break;
            const c = readItem(d, n);
            const ids = idsOf(get(cmd, "ids"));
            let list;
            if (op === "snip") {
                const l = get(cmd, "items");
                if (Array.isArray(l)) list = l;
                else if (idOf(get(cmd, "piece")) !== undefined) {
                    // No items: the trim made here, by the cutters the command names.
                    const cutters = idsOf(get(cmd, "cutters")).filter((i) => curveItem(d.item(i))).map((i) => readItem(d, i));
                    list = trimmedCurves(d.kernel, c, cutters, cmd.piece);
                } else list = [];
            } else {
                const p = get(c.shape, "pieces");
                if (c.kind !== "polycurve" || !Array.isArray(p)) fail("explode: not a polycurve");
                list = p;
            }
            if (list.length > ids.length) fail(op === "snip" ? "snip: fewer ids than items" : "explode: fewer ids than pieces");
            rewriteLoops(d, [n], (l) => loopsExploded(l, n, ids.slice(0, list.length)));
            const { at, ids: gone } = takeOut(d, [n]);
            let pos = at;
            list.forEach((it, k) => {
                newCurve(d, ids[k], it, c.plane, pos);
                pos = d.index(headId(ids[k])) + 1;
            });
            orphanReaders(d, gone);
            break;
        }
        case "set": {
            const n = idOf(get(cmd, "id"));
            if (n === undefined || !d.item(n) || !isMap(cmd)) break;
            const c = readItem(d, n);
            for (const [k, v] of Object.entries(cmd)) {
                if (k === "op" || k === "id" || k === "sketchConstraints" || k === "sketchEdits" || RUNTIME_KEYS.includes(k)) continue;
                c[k] = kept(v);
            }
            writeItem(d, n, c);
            break;
        }
        case "edit":
            editItems(d, get(cmd, "items"));
            break;
        case "surface": case "sweep": case "solid": case "revolved": case "lofted": case "swept": case "join": case "cut": case "intersect":
        case "shell": case "thicken": case "trim": case "face": case "prism": case "press": case "rechamfer": case "remove": case "refillet":
        case "fillet": case "primitive": case "pipe": case "split": case "state":
            unported(`${op}: not on nodes yet`);
            break;
        default:
            fail(`unknown command ${op}`);
    }
    finish(d, cmd);
    return d;
}

/// After every command (forge.js 1142-1150): a structural command's sketches' pruned
/// constraints, and the curves its red records moved.
function finish(d, cmd) {
    const list = get(cmd, "sketchConstraints");
    if (Array.isArray(list)) {
        for (const entry of list) {
            const n = idOf(get(entry, "sketch"));
            if (n === undefined || !isSketch(d.item(n))) continue;
            const cs = get(entry, "constraints");
            if (cs === undefined) continue;
            writeItem(d, n, { ...readItem(d, n), constraints: kept(cs) });
        }
    }
    if (get(cmd, "sketchEdits")) editItems(d, get(cmd, "sketchEdits"));
}

/// The command as the kernel would read it off the page's JSON.
const asJson = (cmd) => JSON.parse(JSON.stringify(cmd) ?? "null");

/// The ops of `cmd` on the model's document (see the header).
export function commandOps(model, cmd, env) {
    const d = build(model, asJson(cmd), env, new Map());
    return d.metaMoved ? { ops: d.ops, meta: d.forge() } : { ops: d.ops };
}

/// One command as one commit (see the header).
export function command(kernel, model, doc, cmd, env) {
    cmd = asJson(cmd);
    env ??= { kernel, picks: docPicks(kernel, doc, model) };
    const broken = new Map();
    for (;;) {
        const d = build(model, cmd, env, broken);
        const ops = d.metaMoved ? [...d.ops, metaOp(d.forge())] : d.ops;
        const batch = { op: "batch", ops, message: `forge: ${opOf(cmd)}` };
        let changed;
        try {
            changed = JSON.parse(call(kernel, "cadaclysm_blacksmith_document_apply", doc, JSON.stringify(batch), undefined));
        } catch (e) {
            // A node of an item this command wrote is refused: that item is a stand-in.
            const m = /^i(0|[1-9][0-9]*)(?:_[^:\s]*)?: /.exec(e.message);
            const n = m ? Number(m[1]) : undefined;
            if (n !== undefined && d.written.has(n) && !broken.has(n) && d.node(headId(n)) && d.node(headId(n)).kind !== "value.unresolved") {
                broken.set(n, e.message);
                continue;
            }
            throw e;
        }
        model.refresh(changed, batch);
        return { changed, op: batch };
    }
}

