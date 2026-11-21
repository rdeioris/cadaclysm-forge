// The forge's view of a document: its nodes, mirrored off the kernel and kept by the changed
// sets `cadaclysm_blacksmith_document_apply` (and undo / redo) give back, and the page's
// items read straight off them. No DOM: importable by the page, the worker and node. No
// geometry: what a node builds is the kernel's to say.
//
// # The node layout (the contract every forge-*.js writer and reader follows)
//
// - Item `n` is the node `i<n>` (digits, no leading zero): its HEAD, the node a reader of
//   the item names (a join's part, a fillet's source, a curve's sketch frame).
// - Its helpers are `i<n>_<role>`, written BEFORE the head in document order. Roles keep
//   their old names where they still apply: `_frame` (a sketch's plane), `_src`, `_to`,
//   `_via<k>` (a body's profiles), `_mid<k>` (a midplane sketch's face), `_split`,
//   `_tool` (a trim's), `_cut` (a split's profile), `_inner`, `_flush`, `_moved`, `_at` (a
//   pattern's placements), `_axis` (its axis as numbers, `frame.at`), `_path` (its path,
//   `curve.as_nurbs`), `_copy` (a mirror join's mirrored copy). There is no `_placed` and no
//   cast node any more.
// - A body pattern is a GROUP item (kind `pattern`, not a body): its head `i<n>` is
//   `solid.pattern` (a list of bodies, `combine: "separate"`) over `i<n>_at`; and one body
//   item per instance (kind `instance`), its head `solid.nth { list: "i<n>", index }`. A
//   mirror as new bodies is a group too (`placements.mirror`).
// - A body's chain, each step reading the one before:
//     the verb node `i<n>_inner` (or `i<n>` itself when nothing follows it)
//     -> `solid.merge_flush` `i<n>_flush`                      when the body is flush
//     -> in-plane `solid.transform` `i<n>_moved`               when not the identity:
//          `{ frame: <the sketch's frame node>, pivot, turn: [0, 0, deg], by: [tx, ty, 0] }`
//     -> world `solid.transform` as `i<n>`
//          `{ pivot, turn_in: "world", turn: [rx, ry, rz], by_in: "world", by: offset }`
//   or, when a step is not needed, the last step written is `i<n>`. No casts: a transform
//   outputs its input's type.
// - Page-only fields live in the HEAD node's `meta.forge` object: always `kind` (the page's
//   item kind: line, rect, sketch, extrusion, fillet, box, ...), plus whatever no node field
//   holds (a sketch's mode and look, style, holes, from, a made body's scale, index picks
//   such as a fillet's `edges`, a shell's `open`, a trim's `drop`, a revolution's
//   sketch-space `axis`, ...). They are read as they are: no `@node` guards, no
//   `@was` / `@value`. A head with no `meta.forge.kind` takes its kind from its node kind
//   (`curve.line` -> line, ..., `curve.spline` -> nurbs; see `CURVE_KINDS`).
// - A face of a body used as a plane is one shared `frame.on_face` node `f<b>_<k>`
//   (body item `b`, face `k`), read by everything on it. It is no item's helper.
// - The counters (`Line 3`) and the next free id are document-level meta, app `forge`:
//   `{ counters: { line: 3, ... }, nextId: 7 }`, written by the command that moves them
//   with `{ op: "meta", app: "forge", value: {...} }` in that command's own batch.
//   `document_meta(doc, "forge")` absent reads `{ counters: {}, nextId: 1 }`; a counter
//   absent is 0.
// - An item that cannot be built (an unresolved pick, a gone input) is a head `i<n>` of
//   kind `value.unresolved` `{ type: curve|sketch|solid|sheet|..., why }`, with the item's
//   page fields in its `meta.forge` as ever.
// - A foreign node (another app's: not `i<n>`, `i<n>_*` nor `f<b>_<k>`) is an item too
//   when it is held -- kind `solid.body` / `sheet.body` / `profile.path`, or any kind whose
//   `meta.show` is true (`heldOf`): kind `held` (a body) or `held_profile` (a profile),
//   unless a head's `meta.forge.node` already names it (a held body the page has placed).
//   Held items come after the forge's own, in document order, numbered from
//   `max(nextId, the largest item id + 1)` up, as the 0.14 layer numbered them.
// - Units: every forge document is "mm".
//
// # Here
//
//   new Model(kernel, doc)       the mirror: every node (`document_nodes(doc, null)`), the
//                                revision, the `forge` meta
//     .refresh(changed, ops?)    kept by a changed set (`document_apply`'s, undo's, redo's;
//                                JSON text or parsed; null: nothing changed): the removed
//                                dropped, the added and changed re-read in ONE
//                                `document_nodes` call naming only them, the `forge` meta
//                                re-read only when `changed.meta` names it, the revision.
//                                An added node's position: replayed from `ops` (the op the
//                                caller applied -- a batch, an add's `at`) when given and
//                                consistent with the set; otherwise that one call reads
//                                every node instead. Never `document_save`.
//     .revision                  the document's revision as of the last read
//     .node(id) / .nodes()       a node (file form: `{ id, kind, name?, hidden?, meta?,
//                                ...fields }`) / all of them in document order
//     .items()                   [{ id: n, head, helpers, kind, name, of?, node? }] in the
//                                document order of the heads, then the held ones
//     .item(n)                   item `n`, or undefined
//     .itemKind(item)            the page's kind (`meta.forge.kind` ?? from the head's kind)
//     .label(kind)               "Line"; "undefined" for a kind it lacks, as forge.js did
//     .nameFor(kind, meta?)      `{ name: "Line 4", meta }`: `meta` (a `forgeMeta()` copy,
//                                made when not given) with `counters[kind]` moved on. The
//                                caller writes `metaOp(meta)` in its batch; the counters
//                                move only through it. Pass the same `meta` to name
//                                several new items in one command.
//     .forgeMeta()               a fresh copy of the `forge` meta, defaults filled in
//     .over(nodes, meta?)        a model of `nodes` (file form, in document order) and the
//                                forge meta `meta` (this one's when not given), read off
//                                nothing: what a command's draft leaves, listed without
//                                applying it (forge-commands.js's `itemsAfter`)
//   openDocument(kernel, text)   a document handle off a file's text: a cadaclysm-blacksmith
//                                document, else refused as not one (naming the format it
//                                gives); one the kernel cannot load (a 0.14 forge file's
//                                `forge.*` nodes) refused in the kernel's words
//   bumpId(meta, n)              `meta.nextId` raised past item `n` (forge.js `bump`)
//   takeId(meta)                 the next free id, `meta.nextId` moved past it
//   metaOp(meta)                 `{ op: "meta", app: "forge", value: meta }`
//   helper(item, role)           the item's helper node `i<n>_<role>`, or undefined
//   headId(n), helperId(n, role), itemOfId(id), isFacePlaneId(id), isForgeId(id)
//   heldOf(node)                 "solid" | "sheet" | "profile" for a held node, else undefined
//   isBody / isSketch / isCurve / isImage / isHeldProfile / isPattern(item)   the page's predicates
//   isBodyKind / isMadeKind / isQuickKind(kind), label(kind), CURVE_KINDS, COUNTERS, UNITS

/// The units of every forge document.
export const UNITS = "mm";

/// The largest id (a `u32` in the kernel).
const U32_MAX = 4294967295;

/// The counters as the page starts them, in its order (all 0 when the meta has none).
export const COUNTERS = [
    "image", "line", "polyline", "rect", "circle", "arc", "ellipse", "polygon", "nurbs", "polycurve", "surface", "extrusion", "revolution", "solid", "sweep", "loft", "join", "cut", "intersect", "chamfer", "shell", "thicken", "trim", "prism", "press", "refillet", "rechamfer", "remove", "fillet", "sketch", "face", "box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil", "pipe", "split", "pattern", "instance", "mirror",
];

const LABELS = {
    image: "Image", line: "Line", polyline: "Polyline", rect: "Rectangle", circle: "Circle", arc: "Arc", ellipse: "Ellipse", polygon: "Polygon", nurbs: "NURBS", polycurve: "Polycurve",
    surface: "Surface", extrusion: "Extrusion", revolution: "Revolution", solid: "Solid", sweep: "Sweep", loft: "Loft", join: "Join", cut: "Cut", intersect: "Intersect", chamfer: "Chamfer",
    shell: "Shell", thicken: "Thicken", trim: "Trim", prism: "Solid", press: "Press Pull", refillet: "Refillet", rechamfer: "Rechamfer", remove: "Remove", fillet: "Fillet", sketch: "Sketch",
    face: "Face", box: "Box", cylinder: "Cylinder", sphere: "Sphere", cone: "Cone", pyramid: "Pyramid", torus: "Torus", coil: "Coil", pipe: "Pipe", split: "Split",
    pattern: "Pattern", instance: "Instance", pattern_feature: "Pattern", mirror: "Mirror",
};

/// An item kind's label; "undefined" for a kind it lacks, as a template string writes it.
export const label = (kind) => (Object.hasOwn(LABELS, kind) ? LABELS[kind] : "undefined");

/// The page's curve kinds and the node kind each is.
export const CURVE_KINDS = { line: "curve.line", arc: "curve.arc", circle: "curve.circle", ellipse: "curve.ellipse", rect: "curve.rect", polygon: "curve.polygon", polyline: "curve.polyline", nurbs: "curve.spline", polycurve: "curve.polycurve" };
const PAGE_CURVE_KINDS = Object.fromEntries(Object.entries(CURVE_KINDS).map(([k, v]) => [v, k]));

/// The quick solids.
export const QUICK_KINDS = ["box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil"];
export const isQuickKind = (kind) => QUICK_KINDS.includes(kind);
const MADE = ["join", "cut", "intersect", "shell", "thicken", "trim", "prism", "press", "refillet", "rechamfer", "remove", "fillet", "face", "pipe", "split", "held", "instance", "pattern_feature", "mirror"];
/// A body made of other bodies, or a quick solid, a pipe, a split, a held body.
export const isMadeKind = (kind) => MADE.includes(kind) || isQuickKind(kind);
const DRAWN = ["surface", "extrusion", "revolution", "solid", "sweep", "loft"];
export const isBodyKind = (kind) => DRAWN.includes(kind) || isMadeKind(kind);

// The predicates take an item (`items()`'s) and read its `kind`.
const kindOf = (item) => (typeof item?.kind === "string" ? item.kind : "");
export const isBody = (item) => isBodyKind(kindOf(item));
export const isSketch = (item) => kindOf(item) === "sketch";
export const isImage = (item) => kindOf(item) === "image";
/// A body pattern's group item (kind `pattern`): its head a list of bodies, not a body. Its
/// instances are body items of their own (kind `instance`).
export const isPattern = (item) => kindOf(item) === "pattern";
/// A held profile (another app's): listed and kept, not drawn, and no curve a tool takes.
export const isHeldProfile = (item) => kindOf(item) === "held_profile";
/// Neither a body, a sketch, an image, a held profile nor a pattern group.
export const isCurve = (item) => !isBody(item) && !isSketch(item) && !isImage(item) && !isHeldProfile(item) && !isPattern(item);

// ---------------------------------------------------------------------------------
// Ids.

/// The item a head id `i<n>` names (digits, no leading zero, within u32), else undefined.
export function itemOfId(id) {
    if (typeof id !== "string" || !/^i(0|[1-9][0-9]*)$/.test(id)) return undefined;
    const n = Number(id.slice(1));
    return n <= U32_MAX ? n : undefined;
}

export const headId = (n) => `i${n}`;
export const helperId = (n, role) => `i${n}_${role}`;

// [item, role] for a helper id `i<n>_<role>`, else undefined.
function helperOfId(id) {
    if (typeof id !== "string") return undefined;
    const us = id.indexOf("_");
    if (us < 0 || us === id.length - 1) return undefined;
    const n = itemOfId(id.slice(0, us));
    return n === undefined ? undefined : [n, id.slice(us + 1)];
}

/// Whether a node id is a face plane's shared node, `f<b>_<k>`.
export const isFacePlaneId = (id) => typeof id === "string" && /^f[0-9]+_[0-9]+$/.test(id);

/// Whether the forge writes node `id`: a head, a helper or a face plane. Anything else is
/// another app's.
export const isForgeId = (id) => itemOfId(id) !== undefined || helperOfId(id) !== undefined || isFacePlaneId(id);

const HELD = { "solid.body": "solid", "sheet.body": "sheet", "profile.path": "profile" };
/// What a foreign node holds as a held item: its kind's (`solid.body` / `sheet.body` /
/// `profile.path`), or, for any other kind whose `meta.show` is true, `sheet` for a
/// `sheet.*` kind and `solid` for the rest; undefined when it is not held.
export function heldOf(node) {
    if (Object.hasOwn(HELD, node.kind)) return HELD[node.kind];
    return node.meta?.show === true ? (node.kind.startsWith("sheet.") ? "sheet" : "solid") : undefined;
}

/// The item's helper node `i<n>_<role>`, or undefined.
export const helper = (item, role) => item.helpers.find((h) => h.id === helperId(item.id, role));

// ---------------------------------------------------------------------------------
// The forge meta.

/// `meta` read as the forge meta: an object with `counters` an object and `nextId` a
/// whole number in 1..u32; anything missing or malformed is the default.
function forgeMetaOf(v) {
    const out = v !== null && typeof v === "object" && !Array.isArray(v) ? structuredClone(v) : {};
    if (out.counters === null || typeof out.counters !== "object" || Array.isArray(out.counters)) out.counters = {};
    const id = out.nextId;
    out.nextId = typeof id === "number" && Number.isFinite(id) ? Math.min(Math.max(Math.trunc(id), 1), U32_MAX) : 1;
    return out;
}

/// `meta.nextId` raised past item `n` (forge.js `bump`). Returns `meta`.
export function bumpId(meta, n) {
    meta.nextId = Math.max(meta.nextId, Math.min(n + 1, U32_MAX));
    return meta;
}

/// The next free id, `meta.nextId` moved past it.
export function takeId(meta) {
    const n = meta.nextId;
    bumpId(meta, n);
    return n;
}

/// The op that writes the forge meta: one in the batch of the command that moved it.
export const metaOp = (meta) => ({ op: "meta", app: "forge", value: meta });

// ---------------------------------------------------------------------------------
// The model.

// Every op a (possibly nested) batch applies, in order.
function flatOps(op, out = []) {
    if (op?.op === "batch") for (const o of op.ops ?? []) flatOps(o, out);
    else if (op) out.push(op);
    return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class Model {
    /// The mirror of document handle `doc` (a `cadaclysm_blacksmith_document_*` handle) over
    /// the kernel module `kernel` (the web package's exports).
    constructor(kernel, doc) {
        this.kernel = kernel;
        this.doc = doc;
        this._readAll();
        this._meta = this._readMeta();
        this.revision = this._call("cadaclysm_blacksmith_document_revision", doc);
    }

    _call(name, ...args) {
        const fn = this.kernel?.[name];
        if (typeof fn !== "function") throw new Error(`the kernel has no \`${name}\``);
        return fn(...args);
    }

    _readAll() {
        const all = JSON.parse(this._call("cadaclysm_blacksmith_document_nodes", this.doc, null));
        this._byId = new Map(all.map((n) => [n.id, n]));
        this._order = all.map((n) => n.id);
        this._items = undefined;
    }

    _readMeta() {
        const text = this._call("cadaclysm_blacksmith_document_meta", this.doc, "forge");
        return forgeMetaOf(text === undefined || text === null ? undefined : JSON.parse(text));
    }

    /// Kept by a changed set (see the header). `ops`, the op the caller applied, places the
    /// added nodes without reading every node.
    refresh(changed, ops) {
        if (typeof changed === "string") changed = JSON.parse(changed);
        if (changed) {
            const added = changed.added ?? [];
            const removed = new Set(changed.removed ?? []);
            const order = added.length ? this._replay(ops, added, removed) : this._order.filter((id) => !removed.has(id));
            if (order === undefined) this._readAll();
            else {
                for (const id of removed) this._byId.delete(id);
                const ids = [...new Set([...added, ...(changed.changed ?? [])])];
                if (ids.length) {
                    const read = JSON.parse(this._call("cadaclysm_blacksmith_document_nodes", this.doc, JSON.stringify(ids)));
                    for (const n of read) this._byId.set(n.id, n);
                }
                this._order = order;
                this._items = undefined;
            }
            if ((changed.meta ?? []).includes("forge")) {
                this._meta = this._readMeta();
                this._items = undefined;
            }
        }
        this.revision = this._call("cadaclysm_blacksmith_document_revision", this.doc);
    }

    // The document order after `ops` (the applied op), replayed on the current order:
    // each add inserted at its `at` (the end when none), each remove taken out. Undefined
    // when there are no ops, or the replay cannot be trusted (a cascade removed readers it
    // does not know before a positioned add) or does not give the changed set's ids.
    _replay(ops, added, removed) {
        if (!ops) return undefined;
        const order = this._order.slice();
        let cascaded = false;
        for (const op of flatOps(ops)) {
            if (op.op === "add") {
                const id = op.node?.id;
                if (typeof id !== "string") return undefined;
                if (op.at === undefined || op.at === null) order.push(id);
                else if (cascaded || !(op.at >= 0 && op.at <= order.length)) return undefined;
                else order.splice(op.at, 0, id);
            } else if (op.op === "remove") {
                const at = order.indexOf(op.id);
                if (at >= 0) order.splice(at, 1);
                if (op.cascade) cascaded = true;
            }
        }
        const out = order.filter((id) => !removed.has(id));
        const before = new Set(this._order);
        const fresh = out.filter((id) => !before.has(id));
        const kept = this._order.filter((id) => !removed.has(id));
        if (!sameList(fresh, added) || out.length !== kept.length + added.length) return undefined;
        return out;
    }

    node(id) {
        return this._byId.get(id);
    }

    nodes() {
        return this._order.map((id) => this._byId.get(id));
    }

    items() {
        if (!this._items) this._items = this._readItems();
        return this._items;
    }

    item(n) {
        return this.items().find((it) => it.id === n);
    }

    _readItems() {
        const heads = [];
        const helpers = new Map();
        const foreign = [];
        for (const id of this._order) {
            const nd = this._byId.get(id);
            const n = itemOfId(id);
            if (n !== undefined) {
                heads.push(nd);
                continue;
            }
            const h = helperOfId(id);
            if (h) {
                if (!helpers.has(h[0])) helpers.set(h[0], []);
                helpers.get(h[0]).push(nd);
            } else if (!isFacePlaneId(id)) foreign.push(nd);
        }
        const items = heads.map((head) => {
            const id = itemOfId(head.id);
            const it = { id, head, helpers: helpers.get(id) ?? [], kind: "", name: head.name };
            it.kind = this.itemKind(it);
            return it;
        });
        const named = new Set(heads.map((h) => h.meta?.forge?.node).filter((v) => typeof v === "string"));
        let next = Math.max(this._meta.nextId, items.reduce((m, it) => Math.max(m, it.id + 1), 1));
        for (const nd of foreign) {
            if (named.has(nd.id)) continue;
            const of = heldOf(nd);
            if (of === undefined) continue;
            items.push({ id: next, head: nd, helpers: [], kind: of === "profile" ? "held_profile" : "held", name: typeof nd.name === "string" ? nd.name : nd.id, of, node: nd.id });
            next = Math.min(next + 1, U32_MAX);
        }
        return items;
    }

    /// The page's kind of an item: its head's `meta.forge.kind`, else the page's curve kind
    /// of its node kind; "" when neither says. A held item's is its own (`held`,
    /// `held_profile`).
    itemKind(item) {
        if (item.of !== undefined) return item.kind;
        const k = item.head?.meta?.forge?.kind;
        if (typeof k === "string") return k;
        const kind = item.head?.kind;
        return Object.hasOwn(PAGE_CURVE_KINDS, kind) ? PAGE_CURVE_KINDS[kind] : "";
    }

    label(kind) {
        return label(kind);
    }

    /// A new item's name, `${label(kind)} ${++counters[kind]}`, and `meta` with that counter
    /// moved: `{ name, meta }`. `meta` is the caller's working copy (a `forgeMeta()` one when
    /// not given) and is changed in place; the caller writes it with `metaOp(meta)`.
    nameFor(kind, meta = this.forgeMeta()) {
        const c = meta.counters[kind];
        const v = (typeof c === "number" && Number.isFinite(c) ? c : 0) + 1;
        const n = Math.min(Math.max(Math.trunc(v), 0), U32_MAX);
        meta.counters[kind] = n;
        return { name: `${label(kind)} ${n}`, meta };
    }

    /// A fresh copy of the forge meta (`{ counters, nextId, ... }`), safe to change.
    forgeMeta() {
        return structuredClone(this._meta);
    }

    /// A model of `nodes` and `meta`, not of the document (see the header). Not to refresh.
    over(nodes, meta = this._meta) {
        const m = Object.create(Model.prototype);
        m.kernel = this.kernel;
        m.doc = this.doc;
        m._byId = new Map(nodes.map((n) => [n.id, n]));
        m._order = nodes.map((n) => n.id);
        m._items = undefined;
        m._meta = forgeMetaOf(meta);
        m.revision = this.revision;
        return m;
    }
}

/// A document handle off a file's text (see the header). The caller frees it.
export function openDocument(kernel, text) {
    const NOT = "not a cadaclysm-blacksmith document";
    let lit;
    try {
        lit = JSON.parse(text);
    } catch {
        throw new Error(`${NOT} (it is not JSON)`);
    }
    const f = lit !== null && typeof lit === "object" && !Array.isArray(lit) ? lit.format : undefined;
    if (f !== "cadaclysm-blacksmith") throw new Error(typeof f === "string" ? `${NOT}: its format is "${f}"` : `${NOT}: it names no format`);
    const load = kernel?.cadaclysm_blacksmith_document_load;
    if (typeof load !== "function") throw new Error("the kernel has no `cadaclysm_blacksmith_document_load`");
    try {
        return load(text);
    } catch (e) {
        throw new Error(String(e?.message ?? e).replace(/^document_load: /, ""));
    }
}
