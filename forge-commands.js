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
//                                 as nodes (the ops that turn its nodes into those): curves,
//                                 sketches, held items and bodies (`ITEM_CLASSES`)
//   Draft                         the document as a command's ops leave it: node lookups,
//                                 positions and the forge meta, every change an op
//   pieceToNode / pieceFromNode   a polycurve piece, the page's `{ kind, shape }` <-> a
//                                 `curve.polycurve` piece `{ kind, ...shape }` (nurbs <-> spline)
//   Unported                      the error of a command or an item kind not on nodes yet
//
// On nodes so far: `add`, `image`, `sketch`, `duplicate`, `delete`, `round`, `merge`, `snip`,
// `explode` (5.3a); the made bodies `surface`, `sweep` (an extrusion or a revolution of a
// curve), `solid`, `revolved`, `lofted`, `swept`, `primitive`, `pipe` (5.3b); `set` / `edit`
// of curves, sketches, held items and those bodies, a body's in-plane move and its place in
// the world among them. The body verbs throw `Unported` until their group lands: each adds
// its kinds to the body class (`bodyNodes`, `bodyHeld`) and its cases to `build`.
//
// Every command first adopts the held items the model lists without a head of their own
// (`adoptHeld`): each gets its head `i<n>` under the number the model shows for it, and the
// next id moves past it, in the command's own batch. The model numbers a headless held
// item from the next id, so without this a command that moves the next id would renumber
// them; with it, a document opened and not touched shows the numbers it keeps.
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
// - A held item gets a head of its own (adopted, copied, placed): `solid.transform` of the
//   held node (`profile.translate` by 0 for a held profile), `meta.forge` `{ kind: "held" |
//   "held_profile", node, sheet? }`, so the model lists it as `i<n>` and not as the held node.
//   A held body is a body here (below): placed, its head is the world transform of the node.
// - A body is its chain (forge-model.js's header): helpers, the verb, `i<n>_moved`, the
//   world `solid.transform`, the last step named `i<n>`. Its fields:
//   - a drawn body (surface, extrusion, solid, revolution, sweep, loft): its profile
//     `i<n>_src`, `profile.from_curves` over its loops' curve heads (`curves`, `per_loop`)
//     with its `pivot`, and its transform's `scale` -- and `move` / `turn` (degrees): the
//     page moves a drawn body's profile, not what it is swept along or lofted to. A loft's
//     other sections are `i<n>_to` / `i<n>_via<k>`, each with its own pivot and transform
//     (their loops read back off them, the rest kept in `meta.forge.to` / `.via`). The verb
//     on the plane's frame: `sheet.face`, `solid.extrude[_open][_tapered]` (`height`,
//     `taper`), `solid.revolve[_open]_in_plane` (`angle`; `from` / `to` the axis as the item
//     holds it, in sketch coordinates, scaled with the profile about the pivot when scaled),
//     `solid.sweep[_open]` (`path`), `solid.loft[_open]` / `solid.loft_through`. A sheet
//     where the page builds one (`open` on the profile).
//   - a revolution's turn and slide in its plane, and a made body's, are `i<n>_moved`
//     `{ solid, frame, pivot: [px, py, 0], turn: [0, 0, deg], by: [tx, ty, 0] }`.
//   - a quick solid: `solid.<shape>` on the plane's frame (`solid.cuboid` with `anchor:
//     "base"`; a coil `i<n>_circle` -> `i<n>_wire` -> `i<n>_coil` -> `solid.place`), its
//     `dims` read back off it. A pipe: `solid.pipe` (`path`, `dims`).
//   - placed (`place` not the identity): the head is `{ solid, frame, pivot: [px + tx, py +
//     ty, 0], turn_in: "world", turn, by_in: "world", by: offset }`.
//   - `meta.forge`: `kind`, and every page field the nodes do not give back as it is
//     (`bodyHeld`): `holes`, `axis`, `source`, `from`, a made body's `pivot`, `parts`, a
//     transform whose turn has no degree value giving its radians back bit for bit, ...
//   - a body that cannot be written (a curve, a path or a held node gone, dims of the wrong
//     count) is a stand-in in the 0.14 layer's words; a helper a delete stood in (`was`) is
//     read as the node it was.
// - A new body's pivot is the centre of its curves' exact bounds (`profile_bounds`), as a
//   literal (spec; test/fixtures/golden/ACCEPTED.md).
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
import { headId, helperId, itemOfId, isFacePlaneId, CURVE_KINDS, isBodyKind, isMadeKind, isQuickKind, isBody, isSketch, isCurve, isHeldProfile, metaOp, bumpId } from "./forge-model.js";
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
    /// for none (or one this command removed). One whose head this command wrote (a new
    /// item, an adopted held one) as that head says.
    item(n) {
        const it = this.model.item(n);
        if (it && !this.over.has(headId(n))) return this.has(it.of !== undefined ? it.node : headId(n)) ? it : undefined;
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

/// A stand-in for a node whose input went (`meta.forge.was`, see the header) as the node it
/// was; any other node as it is.
function wasNode(nd) {
    const was = nd?.kind === "value.unresolved" ? nd.meta?.forge?.was : undefined;
    if (!isMap(was)) return nd;
    const { was: _, ...forge } = nd.meta.forge;
    const out = { ...clone(was), id: nd.id };
    const meta = { ...nd.meta, forge };
    if (Object.keys(forge).length || Object.keys(meta).length > 1) out.meta = meta;
    return out;
}

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

// ---------------------------------------------------------------------------------
// Bodies.

/// Degrees -> radians, as the page's `transform.angle` is read back off a node's degrees.
const toRadians = (d) => d * Math.PI / 180;

const bits = new DataView(new ArrayBuffer(8));
/// The double one ulp from `v`, up or down.
function nextToward(v, up) {
    if (v === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    bits.setFloat64(0, v);
    const b = bits.getBigUint64(0);
    bits.setBigUint64(0, (v > 0) === up ? b + 1n : b - 1n);
    return bits.getFloat64(0);
}

/// The degrees a node holds for the page's `rad` radians: the double nearest
/// `rad * 180 / PI` whose `toRadians` is `rad` bit for bit (a few ulps either side), so the
/// page reads its own angle back; the nearest itself when none is.
function degreesFor(rad) {
    const d0 = rad * (180 / Math.PI);
    if (!Number.isFinite(d0) || toRadians(d0) === rad) return d0;
    let up = d0, down = d0;
    for (let k = 0; k < 16; k++) {
        up = nextToward(up, true);
        if (toRadians(up) === rad) return up;
        down = nextToward(down, false);
        if (toRadians(down) === rad) return down;
    }
    return d0;
}

/// `len` finite numbers, else undefined.
function nums(l, len) {
    return Array.isArray(l) && l.length === len && l.every((x) => num(x) !== undefined) ? l.slice() : undefined;
}

const still = () => ({ tx: 0, ty: 0, angle: 0, scale: 1 });
const noPlace = () => ({ offset: [0, 0, 0], turn: [0, 0, 0] });

/// The bodies drawn from profiles (their move is their profile's, a revolution's excepted).
const DRAWN = ["surface", "extrusion", "solid", "revolution", "sweep", "loft"];

/// Whether a body builds a sheet (the 0.14 layer's `bodyIsSheet`).
function bodyIsSheet(c) {
    switch (c.kind) {
        case "surface": case "extrusion": case "trim": case "face": return true;
        case "held": return Boolean(c.sheet);
        case "revolution": return c.sheet !== false;
        case "loft": case "sweep": return Boolean(c.sheet);
        default: return false;
    }
}

/// A body's transform as numbers (absent ones the identity's).
function moveOf(c) {
    const t = get(c, "transform");
    return { tx: num(get(t, "tx")) ?? 0, ty: num(get(t, "ty")) ?? 0, angle: num(get(t, "angle")) ?? 0, scale: num(get(t, "scale")) ?? 1 };
}

/// A body's place, when it is three and three numbers.
function placeOfBody(c) {
    const p = get(c, "place");
    const offset = nums(get(p, "offset"), 3), turn = nums(get(p, "turn"), 3);
    return offset && turn ? { offset, turn } : undefined;
}

/// The page's `isPlaced`: a place whose offset or turn is not 0.
function isPlaced(c) {
    const p = placeOfBody(c);
    return p !== undefined && [...p.offset, ...p.turn].some((v) => v !== 0);
}

/// Whether a body moves in its plane after its verb (`_moved`): a made body, or a
/// revolution (its axis stays in sketch coordinates), whose tx, ty or angle is not 0. A
/// drawn body's other moves are its profile's (`profile.from_curves`), as the page moves
/// the profile and not what it is swept along or lofted to.
function movesAfter(c) {
    if (!(isMadeKind(c.kind) || c.kind === "revolution")) return false;
    const t = moveOf(c);
    return t.tx !== 0 || t.ty !== 0 || t.angle !== 0;
}

/// A body item that cannot be written: its stand-in's `why`.
class Refuse extends Error {}
const refuse = (why) => { throw new Refuse(why); };

/// The quick solids' kinds, their dims' count and their node's fields.
const QUICK = {
    box: [3, (d) => ({ kind: "solid.cuboid", x: d[0], y: d[1], z: d[2], anchor: "base" })],
    cylinder: [2, (d) => ({ kind: "solid.cylinder", r: d[0], h: d[1] })],
    cone: [2, (d) => ({ kind: "solid.cone", r: d[0], h: d[1] })],
    pyramid: [3, (d) => ({ kind: "solid.pyramid", sides: d[0], r: d[1], h: d[2] })],
    sphere: [1, (d) => ({ kind: "solid.sphere", r: d[0] })],
    torus: [2, (d) => ({ kind: "solid.torus", major: d[0], minor: d[1] })],
};

/// The pivot a new body over curves takes: the centre of their profiles' exact bounds
/// (`profile_bounds`), refused as the page refused a curve that is not there.
function pivotOver(kernel, curves) {
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const c of curves) {
        const b = withProfile(kernel, () => curveProfile(kernel, c), (h) => call(kernel, "cadaclysm_blacksmith_profile_bounds", h));
        lo = [Math.min(lo[0], b[0]), Math.min(lo[1], b[1])];
        hi = [Math.max(hi[0], b[2]), Math.max(hi[1], b[3])];
    }
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2].map((v) => (Number.isFinite(v) ? v : null));
}

/// The loops a profile field holds, as lists of ids.
const loopsOf = (v) => (Array.isArray(v) ? v.map(idsOf) : undefined);

/// The `profile.from_curves` node `id` over `holder`'s loops (or a version-1 source's
/// curves, written as `<id>_c<k>` curve nodes on `frame`, pushed to `pre`), with its pivot
/// and scale -- and its move and turn when `moves` (a drawn body's own, a loft section's).
function profileNode(d, id, holder, frame, open, moves, pre) {
    const nd = { id, kind: "profile.from_curves" };
    const loops = get(holder, "loops"), src = get(holder, "source");
    if (Array.isArray(loops)) {
        const curves = [], per = [];
        for (const l of loops) {
            if (!Array.isArray(l)) refuse(`${id}: a loop is not a list`);
            for (const k of l) {
                const i = idOf(k);
                if (i === undefined || !curveItem(d.item(i)) || classOf(d.item(i).kind) !== "curve") refuse(`${id}: curve #${i ?? "?"} is gone`);
                curves.push(headId(i));
            }
            per.push(l.length);
        }
        nd.curves = curves;
        nd.per_loop = per;
    } else if (isMap(src)) {
        const cs = get(src, "curves");
        if (!Array.isArray(cs)) refuse(`${id}: a source without curves`);
        nd.curves = cs.map((c, k) => {
            const kind = get(c, "kind");
            if (!isCurveKind(kind)) refuse(`${id}: no curve kind \`${kind}\``);
            const cid = `${id}_c${k}`;
            const out = { id: cid, kind: CURVE_KINDS[kind] };
            const shape = get(c, "shape");
            for (const key of SHAPE_KEYS[kind]) if (get(shape, key) !== undefined) out[key] = key === "pieces" && Array.isArray(shape[key]) ? shape[key].map(pieceToNode) : clone(shape[key]);
            out.frame = frame;
            pre.push(out);
            return cid;
        });
        const per = get(src, "perLoop");
        if (Array.isArray(per)) nd.per_loop = clone(per);
    } else refuse(`${id}: no loops and no source`);
    const p = nums(get(holder, "pivot"), 2);
    if (p) nd.pivot = p;
    const t = moveOf(holder);
    if (moves && (t.tx !== 0 || t.ty !== 0)) nd.move = [t.tx, t.ty];
    if (moves && t.angle !== 0) nd.turn = degreesFor(t.angle);
    if (t.scale !== 1) nd.scale = t.scale;
    if (open) nd.open = true;
    return nd;
}

/// The page fields a body's nodes give back (`get`: its nodes by id), less what only its
/// head's meta holds.
function bodyHeld(get, n, head, kind) {
    const out = {};
    const inner = get(helperId(n, "inner")), moved = get(helperId(n, "moved")), flush = get(helperId(n, "flush"));
    const world = head.kind === "solid.transform" && head.turn_in === "world" ? head : undefined;
    const verb = inner ?? (world || moved || flush ? undefined : head);
    const src = get(helperId(n, "src"));
    const frame = verb?.frame ?? moved?.frame ?? world?.frame;
    if (frame !== undefined) {
        const p = planeOfFrame(frame);
        if (p !== undefined) out.plane = p;
    }
    if (src?.kind === "profile.from_curves") {
        const l = loopsOfNode(src);
        if (l) out.loops = l;
        const p = nums(src.pivot, 2);
        if (p) out.pivot = p;
    }
    if (out.pivot === undefined && moved) {
        const p = nums(moved.pivot, 3);
        if (p) out.pivot = p.slice(0, 2);
    }
    const t = still();
    if (moved) {
        const by = nums(moved.by, 3), turn = nums(moved.turn, 3);
        if (by) [t.tx, t.ty] = by;
        if (turn) t.angle = toRadians(turn[2]);
    } else if (src?.kind === "profile.from_curves") {
        const mv = nums(src.move, 2);
        if (mv) [t.tx, t.ty] = mv;
        if (num(src.turn) !== undefined) t.angle = toRadians(src.turn);
    }
    if (src?.kind === "profile.from_curves" && num(src.scale) !== undefined) t.scale = src.scale;
    out.transform = t;
    out.place = world ? { offset: clone(world.by ?? [0, 0, 0]), turn: clone(world.turn ?? [0, 0, 0]) } : noPlace();
    const vk = verb?.kind ?? "";
    if (kind === "held") return out;
    if (vk.startsWith("solid.extrude")) {
        out.height = clone(verb.distance);
        out.taper = vk.endsWith("_tapered") ? clone(verb.taper) : 0;
    } else if (vk.startsWith("solid.revolve")) {
        out.angle = clone(verb.angle ?? 360);
        out.sheet = vk.includes("_open");
    } else if (vk === "solid.sweep" || vk === "solid.sweep_open") {
        out.path = itemOfId(verb.path);
        out.sheet = vk === "solid.sweep_open";
    } else if (vk === "solid.loft" || vk === "solid.loft_open") {
        out.sheet = vk === "solid.loft_open";
    } else if (vk === "solid.loft_through") {
        out.sheet = verb.solid === false;
    } else if (vk === "solid.pipe") {
        out.path = itemOfId(verb.path);
        out.dims = [clone(verb.radius), clone(verb.thickness ?? 0)];
    } else if (vk === "solid.place") {
        const circle = get(helperId(n, "circle")), wire = get(helperId(n, "wire")), coil = get(helperId(n, "coil"));
        if (circle && wire && coil) out.dims = [clone(wire.by?.[0]), clone(circle.r), clone(coil.pitch), clone(coil.turns)];
    } else if (Object.hasOwn(QUICK, kind) && QUICK[kind][1]([0, 0, 0]).kind === vk) {
        const k = QUICK[kind][1]([0, 0, 0]);
        out.dims = Object.keys(k).filter((x) => x !== "kind" && x !== "anchor").map((x) => clone(verb[x]));
    }
    return out;
}

/// A body's nodes (see the header): its helpers, then its chain, the last step `i<n>`.
function bodyNodes(d, n, c, pending) {
    const kind = c.kind, base = headId(n);
    const made = isMadeKind(kind);
    const sheet = bodyIsSheet(c);
    const after = movesAfter(c), placed = isPlaced(c);
    const t = moveOf(c);
    const frame = !made || isQuickKind(kind) || after || placed ? frameFor(d, c.plane, pending) : undefined;
    const pre = [], steps = [];
    const numOr = (k) => num(get(c, k)) ?? refuse(`${base}: \`${k}\` is not a number`);
    const src = helperId(n, "src");
    const path = () => {
        const i = idOf(get(c, "path"));
        return i !== undefined && curveItem(d.item(i)) && classOf(d.item(i).kind) === "curve" ? headId(i) : refuse(`${base}: path #${i ?? "?"} is gone`);
    };
    if (!made) {
        const open = kind === "extrusion" ? true : kind === "revolution" || kind === "sweep" ? sheet : kind === "loft" ? sheet && !(Array.isArray(c.via) && c.via.length) : false;
        if (!DRAWN.includes(kind)) refuse(`${base}: no body kind \`${kind}\``);
        pre.push(profileNode(d, src, c, frame, open, kind !== "revolution", pre));
        switch (kind) {
            case "surface":
                steps.push({ kind: "sheet.face", profile: src, frame });
                break;
            case "extrusion": case "solid": {
                const tapered = Boolean(get(c, "taper"));
                const k = (kind === "extrusion" ? "solid.extrude_open" : "solid.extrude") + (tapered ? "_tapered" : "");
                const v = { kind: k, profile: src, frame, distance: numOr("height") };
                if (tapered) v.taper = numOr("taper");
                steps.push(v);
                break;
            }
            case "revolution": {
                const axis = get(c, "axis");
                let a = nums(Array.isArray(axis) ? axis[0] : undefined, 2), b = nums(Array.isArray(axis) ? axis[1] : undefined, 2);
                if (!Array.isArray(axis) || axis.length !== 2 || !a || !b) refuse(`${base}: no axis`);
                // The profile scaled about the pivot: the axis with it (a turn and a slide
                // are `_moved`'s, after).
                const p = nums(get(c, "pivot"), 2);
                if (t.scale !== 1 && p) [a, b] = [a, b].map((q) => [p[0] + t.scale * (q[0] - p[0]), p[1] + t.scale * (q[1] - p[1])]);
                steps.push({ kind: sheet ? "solid.revolve_open_in_plane" : "solid.revolve_in_plane", profile: src, frame, from: a, to: b, angle: numOr("angle") });
                break;
            }
            case "sweep":
                steps.push({ kind: sheet ? "solid.sweep_open" : "solid.sweep", profile: src, frame, path: path() });
                break;
            case "loft": {
                const to = get(c, "to");
                if (!isMap(to)) refuse(`${base}: a loft without \`to\``);
                const toId = helperId(n, "to");
                const toFrame = frameFor(d, get(to, "plane"), pending);
                pre.push(profileNode(d, toId, to, toFrame, open, true, pre));
                if (Array.isArray(c.via) && c.via.length) {
                    const profiles = [src], frames = [frame];
                    c.via.forEach((v, k) => {
                        const vid = helperId(n, `via${k}`);
                        const vf = frameFor(d, get(v, "plane"), pending);
                        pre.push(profileNode(d, vid, v, vf, false, true, pre));
                        profiles.push(vid);
                        frames.push(vf);
                    });
                    profiles.push(toId);
                    frames.push(toFrame);
                    steps.push({ kind: "solid.loft_through", profiles, frames, solid: !sheet });
                } else steps.push({ kind: sheet ? "solid.loft_open" : "solid.loft", a: src, frame_a: frame, b: toId, frame_b: toFrame });
                break;
            }
        }
    } else if (kind === "pipe") {
        const dims = nums(get(c, "dims"), 2) ?? refuse(`${base}: a pipe's dims are two numbers`);
        steps.push({ kind: "solid.pipe", path: path(), radius: dims[0], thickness: dims[1] });
    } else if (kind === "held") {
        if (typeof c.node !== "string" || !d.has(c.node)) refuse(`${base}: the held node \`${c.node}\` is gone`);
    } else if (isQuickKind(kind)) {
        const dims = get(c, "dims");
        if (!Array.isArray(dims)) refuse(`${base}: a quick solid without dims`);
        const count = kind === "coil" ? 4 : QUICK[kind][0];
        if (dims.length !== count) refuse(`${base}: ${kind}: ${count} dimensions, not ${dims.length}`);
        if (kind === "coil") {
            // A round wire of radius `section` resting on the plane at the coil's radius,
            // coiled about the plane's normal.
            const [radius, section, pitch, turns] = dims;
            pre.push({ id: helperId(n, "circle"), kind: "profile.circle", r: section });
            pre.push({ id: helperId(n, "wire"), kind: "profile.translate", profile: helperId(n, "circle"), by: [radius, section] });
            pre.push({ id: helperId(n, "coil"), kind: "solid.coil", section: helperId(n, "wire"), pitch, turns });
            steps.push({ kind: "solid.place", solid: helperId(n, "coil"), frame });
        } else steps.push({ ...QUICK[kind][1](dims), frame });
    } else unported(`a ${kind} item is not on nodes yet`);
    // The in-plane move, then the place in the world.
    const pivot = nums(get(c, "pivot"), 2) ?? [0, 0];
    const input = kind === "held" ? c.node : undefined;
    if (after) steps.push({ role: "moved", kind: "solid.transform", frame, pivot: [pivot[0], pivot[1], 0], turn: [0, 0, degreesFor(t.angle)], by: [t.tx, t.ty, 0] });
    if (placed) {
        const p = placeOfBody(c);
        steps.push({ role: "placed", kind: "solid.transform", frame, pivot: [pivot[0] + t.tx, pivot[1] + t.ty, 0], turn_in: "world", turn: p.turn, by_in: "world", by: p.offset });
    }
    // A held body with nothing to do still has a head of its own.
    if (!steps.length) steps.push({ kind: "solid.transform" });
    let prev = input;
    const chain = steps.map((st, k) => {
        const { role, ...fields } = st;
        const id = k + 1 === steps.length ? base : helperId(n, role ?? "inner");
        const nd = { id, kind: fields.kind };
        if (prev !== undefined && fields.kind === "solid.transform") nd.solid = prev;
        for (const [key, v] of Object.entries(fields)) if (key !== "kind") nd[key] = clone(v);
        prev = id;
        return nd;
    });
    return [...pre, ...chain];
}

/// A made body (and a held one placed on the page): its nodes, its head's meta every page
/// field the nodes do not give back.
const bodyClass = {
    read(d, n, head) {
        const mf = head.meta?.forge ?? {};
        const out = { id: n, name: head.name, kind: mf.kind, ...bodyHeld((id) => wasNode(d.node(id)), n, head, mf.kind) };
        for (const [k, v] of Object.entries(mf)) if (k !== "kind") out[k] = clone(v);
        // A loft's sections keep their loops in their own profile nodes.
        if (isMap(out.to)) {
            const l = wasNode(d.node(helperId(n, "to")));
            const loops = l?.kind === "profile.from_curves" ? loopsOfNode(l) : undefined;
            if (loops && Array.isArray(out.to.loops)) out.to.loops = loops;
        }
        if (Array.isArray(out.via)) out.via.forEach((v, k) => {
            const l = wasNode(d.node(helperId(n, `via${k}`)));
            const loops = l?.kind === "profile.from_curves" ? loopsOfNode(l) : undefined;
            if (loops && isMap(v) && Array.isArray(v.loops)) v.loops = loops;
        });
        out.hidden = head.hidden === true;
        return out;
    },
    write(d, n, c, pending) {
        let nodes;
        const mark = pending.length;
        try {
            nodes = bodyNodes(d, n, c, pending);
        } catch (e) {
            if (!(e instanceof Refuse)) throw e;
            pending.length = mark;
            return [standIn(n, c, bodyIsSheet(c) ? "sheet" : "solid", e.message)];
        }
        const head = nodes[nodes.length - 1];
        if (typeof c.name === "string") head.name = c.name;
        if (c.hidden === true) head.hidden = true;
        const byId = new Map(nodes.map((x) => [x.id, x]));
        const held = bodyHeld((id) => byId.get(id), n, head, c.kind);
        const mf = { kind: c.kind };
        for (const [k, v] of Object.entries(c)) if (v !== undefined && ![...OWN, "kind"].includes(k) && !same(held[k], v)) mf[k] = clone(v);
        head.meta = { forge: mf };
        return nodes;
    },
};

/// Item classes by the page's kind: each `{ read(d, n, head), write(d, n, fields, pending) }`.
/// The body verbs (5.3c) add their kinds to the body class.
export const ITEM_CLASSES = { curve: curveClass, sketch: sketchClass, held: heldClass, body: bodyClass };

/// The class name of a page kind.
export function classOf(kind) {
    if (kind === "sketch") return "sketch";
    if (kind === "held_profile") return "held";
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

const standInType = (c) => (c.kind === "sketch" ? "sketch" : classOf(c.kind) === "curve" ? "curve" : c.kind === "held_profile" ? "profile" : bodyIsSheet(c) ? "sheet" : "solid");

/// Item `n`'s page fields, read off its nodes as the draft has them. A held item with no
/// head of its own reads off its held node.
export function readItem(d, n) {
    let head = d.node(headId(n));
    if (!head) {
        const it = d.item(n);
        if (it?.of === undefined) fail(`#${n} is not an item`);
        const out = { id: n, name: it.name, kind: it.kind, node: it.node };
        if (it.of === "sheet") out.sheet = true;
        out.hidden = it.head.hidden === true;
        return out;
    }
    if (head.kind === "value.unresolved") {
        // Stood in for what it read going: read as the node it was.
        if (!isMap(head.meta?.forge?.was)) return readStandIn(n, head);
        head = wasNode(head);
    }
    const mf = head.meta?.forge ?? {};
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
    const want = d.broken.has(n) ? [standIn(n, c, standInType(c), d.broken.get(n))] : classFor(c.kind).write(d, n, c, pending);
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

/// Item `n` a command names, which must be there (the page read a field of it): its fields.
function need(d, n, op) {
    if (n === undefined || !d.item(n)) fail(`${op}: item ${n === undefined ? "?" : n} is not there`);
    return readItem(d, n);
}

const isCurveFields = (c) => classOf(c.kind) === "curve";

/// The page's `profileOf`: what a new body over item `c` keeps of it, `{ loops }` or
/// `{ source }`.
function profileOf(c) {
    if (isCurveFields(c)) return { loops: [[c.id]] };
    const loops = c.loops ? loopsOf(c.loops) : undefined;
    if (loops) return { loops };
    return { source: clone(c.source ?? null) };
}

/// The page's `bodyOf`: a new body's fields over `profile` on `plane`, its pivot the
/// centre of its curves' exact bounds (`pivotOver`).
function bodyOf(d, kind, profile, holes, plane, n) {
    const name = d.nameFor(kind);
    let curves;
    if (profile.loops) {
        curves = profile.loops.flat().map((k) => {
            const c = d.item(k) ? readItem(d, k) : undefined;
            if (!c || c.shape === undefined) fail(`#${k} is gone`);
            return c;
        });
    } else {
        curves = get(profile.source, "curves");
        if (!Array.isArray(curves)) fail(`#${n}: its source has no curves`);
    }
    const c = { id: n, name, kind };
    if (plane !== undefined) c.plane = clone(plane);
    if (profile.loops) Object.assign(c, { loops: profile.loops.map((l) => l.slice()), source: null });
    else c.source = clone(profile.source);
    return Object.assign(c, { hidden: false, pivot: pivotOver(d.kernel, curves), transform: still(), place: noPlace(), holes: clone(holes), height: 0, axis: null, angle: 0 });
}

/// The fields every made body's item ends with (the page's `madeTail` and `blankBody`).
function madeTail(c, height) {
    c.holes = 0;
    if (height) c.height = 0;
    return Object.assign(c, { axis: null, angle: 0, source: null, hidden: false, place: noPlace() });
}

/// Item `n` hidden (its head's `hidden`).
function hide(d, n) {
    const id = headId(n), nd = d.node(id);
    if (nd) {
        if (nd.hidden !== true) d.set(id, { hidden: true });
    } else writeItem(d, n, { ...readItem(d, n), hidden: true });
}

/// The page's `consume`: item `n` hidden, and what it was made of -- a curve's sketch, a
/// body's loops' curves.
function consume(d, n, seen = new Set()) {
    if (n === undefined || seen.has(n) || !d.item(n)) return;
    seen.add(n);
    hide(d, n);
    const c = readItem(d, n);
    if (isCurveFields(c)) {
        if (typeof c.plane === "number" && isSketch(d.item(c.plane))) hide(d, c.plane);
    } else {
        const loops = c.loops ? loopsOf(c.loops) : undefined;
        if (loops) for (const l of loops) for (const k of l) consume(d, k, seen);
    }
}

/// Every held item the model lists without a head of its own gets one, under the number
/// the model shows for it, and the next id moves past it: what a command does to the next
/// id never renumbers a held item, and a document opened and not touched shows the numbers
/// it will keep.
function adoptHeld(d) {
    for (const it of d.model.items()) {
        if (it.of === undefined) continue;
        writeItem(d, it.id, readItem(d, it.id), d.index(it.node) + 1);
        d.bump(it.id);
    }
}

/// The ops of `cmd` (see the header) on a draft.
function build(model, cmd, env, broken) {
    const d = new Draft(model, env, broken);
    const op = opOf(cmd);
    adoptHeld(d);
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
        case "surface": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const loops = loopsOf(get(cmd, "loops")) ?? fail("surface: no loops");
            writeItem(d, n, bodyOf(d, "surface", { loops }, loops.length - 1, get(cmd, "plane"), n));
            for (const l of loops) for (const k of l) consume(d, k);
            break;
        }
        case "sweep": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const k = need(d, idOf(get(cmd, "source")), op);
            const kind = kindIn(cmd);
            const c = bodyOf(d, kind, profileOf(k), 0, clone(k.plane), n);
            if (kind === "revolution") {
                const axis = get(cmd, "axis");
                if (axis === undefined) fail("sweep: no axis");
                c.axis = kept(axis);
                if (get(cmd, "angle") !== undefined) c.angle = clone(cmd.angle);
            } else {
                if (get(cmd, "height") !== undefined) c.height = clone(cmd.height);
                c.taper = orElse(get(cmd, "taper"), 0);
            }
            writeItem(d, n, c);
            consume(d, k.id);
            break;
        }
        case "solid":
        case "revolved": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const fi = need(d, idOf(get(cmd, "from")), op);
            const c = bodyOf(d, op === "solid" ? "solid" : "revolution", profileOf(fi), clone(fi.holes ?? null), clone(fi.plane), n);
            if (fi.pivot !== undefined) c.pivot = clone(fi.pivot);
            c.transform = clone(fi.transform ?? {});
            if (op === "solid") {
                if (get(cmd, "height") !== undefined) c.height = clone(cmd.height);
                c.taper = orElse(get(cmd, "taper"), 0);
            } else {
                const axis = get(cmd, "axis");
                if (axis === undefined) fail("revolved: no axis");
                c.axis = kept(axis);
                if (get(cmd, "angle") !== undefined) c.angle = clone(cmd.angle);
                c.sheet = false;
            }
            c.from = fi.id;
            writeItem(d, n, c);
            consume(d, fi.id);
            break;
        }
        case "lofted": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const fi = need(d, idOf(get(cmd, "from")), op);
            const gi = need(d, idOf(get(cmd, "to")), op);
            const sheet = isCurveFields(fi);
            const c = bodyOf(d, "loft", profileOf(fi), sheet ? 0 : clone(fi.holes ?? null), clone(fi.plane), n);
            c.sheet = sheet;
            if (!sheet) {
                if (fi.pivot !== undefined) c.pivot = clone(fi.pivot);
                c.transform = clone(fi.transform ?? {});
            }
            const riding = (g) => {
                const p = profileOf(g);
                const out = p.loops ? { loops: p.loops } : { source: p.source };
                if (sheet) Object.assign(out, { pivot: [0, 0], transform: still() });
                else Object.assign(out, { pivot: clone(g.pivot ?? null), transform: clone(g.transform ?? {}) });
                if (g.plane !== undefined) out.plane = clone(g.plane);
                if (g.name !== undefined) out.name = clone(g.name);
                if (!sheet) out.from = g.id;
                return out;
            };
            c.to = riding(gi);
            const via = idsOf(get(cmd, "via")).filter((v) => d.item(v)).map((v) => readItem(d, v));
            if (via.length) c.via = via.map(riding);
            if (!sheet) c.from = fi.id;
            writeItem(d, n, c);
            consume(d, fi.id);
            consume(d, gi.id);
            for (const v of via) consume(d, v.id);
            break;
        }
        case "swept": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const fi = need(d, idOf(get(cmd, "from")), op);
            const path = need(d, idOf(get(cmd, "path")), op).id;
            const curve = isCurveFields(fi);
            const c = bodyOf(d, "sweep", profileOf(fi), curve ? 0 : clone(fi.holes ?? null), clone(fi.plane), n);
            c.sheet = curve;
            if (!curve) {
                if (fi.pivot !== undefined) c.pivot = clone(fi.pivot);
                c.transform = clone(fi.transform ?? {});
                c.from = fi.id;
            }
            c.path = path;
            writeItem(d, n, c);
            consume(d, fi.id);
            break;
        }
        case "primitive": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const kind = kindIn(cmd);
            const c = { id: n, name: d.nameFor(kind), kind };
            if (get(cmd, "plane") !== undefined) c.plane = clone(cmd.plane);
            const dims = get(cmd, "dims");
            if (dims === undefined) fail("primitive: no dims");
            Object.assign(c, { parts: [], dims: kept(dims), pivot: [0, 0], transform: still() });
            writeItem(d, n, madeTail(c, true));
            break;
        }
        case "pipe": {
            const n = cmdId(cmd, "id", op);
            d.bump(n);
            const path = need(d, idOf(get(cmd, "path")), op);
            const c = { id: n, name: d.nameFor("pipe"), kind: "pipe" };
            if (path.plane !== undefined) c.plane = clone(path.plane);
            const dims = get(cmd, "dims");
            Object.assign(c, { parts: [], path: path.id });
            if (dims === undefined) fail("pipe: no dims");
            Object.assign(c, { dims: kept(dims), pivot: [0, 0], transform: still() });
            writeItem(d, n, madeTail(c, true));
            break;
        }
        case "join": case "cut": case "intersect":
        case "shell": case "thicken": case "trim": case "face": case "prism": case "press": case "rechamfer": case "remove": case "refillet":
        case "fillet": case "split": case "state":
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

