// Forge's items as document nodes, and back: `nodesOf` writes every item as the node (and
// its helpers) that builds what the page builds for it, and `itemsOf` reads the items back
// off those nodes. A port of the Rust `forge::nodes`, with the node checks it borrows
// from `state::check_node` and `refs`, so the forge runs on the public kernel build. No
// DOM, no wasm: the kinds the nodes are checked against come in as data (the parsed
// `cadaclysm_blacksmith_document_kinds()` JSON).
//
// # Ids
//
// - Item `n` is node `i<n>`: the node a reader of the item names (a join's part, a
//   fillet's source, a curve's sketch).
// - Its helpers are `i<n>_<role>`, before it: `_frame` (a sketch's plane), `_src`, `_to`,
//   `_via<k>` (a body's profiles), `_c<k>` (a version-1 source's curves), `_p<k>` (a
//   version-1 made body's frozen parts, each a body of its own), `_mid<k>` (a midplane
//   sketch's face), `_split`, `_tool` (a trim's), `_cut` (a split's profile).
// - A body's build is a chain, each step reading the one before: the verb (`_inner`),
//   then `_flush` (`solid.merge_flush`), `_moved` (`forge.moved`, the made body's in-plane
//   move), `_placed` (`forge.placed`, its place in the world), and a cast (`forge.solid` /
//   `forge.sheet`) where the last step gives only a body. The chain's last step is `i<n>`
//   itself; a step not needed (an identity move) is not written.
// - A face of a body used as a plane (`face:<b>:<k>`) is one `frame.on_face` node
//   `f<b>_<k>`, shared by everything on it.
// - Node `forge` (`forge.counters`) holds the counters and the next free id.
// - An item whose nodes cannot be written -- a part, curve, path, face item or split
//   cutter it reads is gone, or a value its kind's range refuses (a fillet of radius 0, a
//   polygon of 2.5 sides), or whose pick the command layer could not resolve
//   (`Items.broken`) -- is one node `i<n>` `forge.broken_<curve|sketch|solid|sheet>`
//   failing with the reason, the whole item in its meta: its readers still type-check,
//   the page's error is the node's, and nothing is quietly built instead.
//
// # What is where
//
// Every item node carries `meta.forge`: the item's fields in the page's key order, each
// value either kept there or replaced by the string `"@node"`. The rule:
//
// - **Read back from the nodes** (`"@node"`): every field a node field holds as it is, so
//   a later edit of that node field shows in the item: id, name, hidden; a curve's plane
//   and shape; a sketch's plane parameters (base, offset, hinge, tilt, path, the face's
//   body, mid, points) and constraints; a body's plane, loops (or a version-1 source),
//   pivot and in-plane transform (`profile.from_curves`), height, taper, the revolution's
//   angle, sheet, path, a loft's sections, parts, thickness, radius, dims, flush, cutter,
//   side, and its place (`forge.placed`) and a made body's move (`forge.moved`).
// - **Kept in meta**: what no node field holds -- a body's or a sketch's kind (a quick
//   solid's `shape`, a fillet's verb and a split's are chosen by it), the sketch's mode,
//   look and the other page-only fields (holes, from, a polycurve's ends, style, what,
//   tool, a made body's scale, ...) -- and the fields the nodes are derived from:
//   - a revolution's `axis` (the nodes take the axis under the transform, forge's old
//     recipe.js `worldAxis`, which does not invert exactly);
//   - a made body's place and move when it has none (the identity is not written);
//   - **index picks**: fillet `edges` (and `edgeNumbering`), shell `open`/`openRefs`, a
//     face item's `face`/`ref`, a trim's `drop`, and the faces press, refillet, rechamfer
//     and remove read through their face items, and a face sketch's `face` index. The
//     indices are kept; the references they resolved to are the item's `faceRefs` /
//     `edgeRefs`, read back from the nodes, and a face plane's are `Items.planes`, read off
//     its `f<b>_<k>` node. Until a pick is resolved its node holds a placeholder (see
//     `facePlaceholder`).
// - A string kept in meta that starts with `@` is written with one more `@`. An item never
//   has a map whose keys are `@was` and `@value`, so a guard (below) is never mistaken for
//   an item's own value.
// - A field a node holds that does not read back exactly (a turn in radians with no degree
//   value giving it back bit for bit) is kept as `{"@was": <what the node reads>,
//   "@value": <the item's>}`: the item's value while the node still reads `@was`, the
//   node's once it is edited. `guards` counts them.
//
// A forge document is canonical through forge commands: each one is `itemsOf`, the
// command, `nodesOf`, so every node is written again from the items. The derived
// duplicates (`forge.placed`'s pivot, tx and ty beside the source's, a revolution's
// `from`/`to`, the move nodes' frame) are rewritten by every forge command; a direct edit
// of a node field they derive from may leave them stale until the next one.
//
// Angles: the document's are degrees, forge's in-plane turns radians. A turn is written as
// the degree value `degreesFor` picks, which gives the radians back exactly through the
// consuming kind's own conversion.
//
// # Nodes here
//
// Nodes cross this module's surface as a document file holds them: `{ id, kind, name?,
// hidden? (only when true), meta?, ...fields }`, fields in the kind's param order -- what
// `cadaclysm_blacksmith_document_save` writes and `_load` / `_apply` take. Inside, a node is
// `{ id, kind, name, hidden, meta, fields: [[key, value], ...] }` (the Rust `Node`).
//
//   itemsOf(state)                  an `Items` read off `state.nodes` (or a list of nodes)
//   nodesOf(items, registry)        the nodes, file form; `registry` from `registryOf`
//   stateOf(nodes)                  { units: "mm", params: {}, nodes }
//   registryOf(kinds)               Map kind name -> kind, from the kinds JSON (text or parsed)
//   checkNode(kind, node, output)   the Rust `state::check_node`: throws a `Refusal`
//   guards(nodes)                   how many guards the nodes' meta carries
//   turnRadians(d), fieldRadians(d), degreesFor(rad, back)
//   facePlaceholder(), edgePlaceholder(), isPlaceholder(ref), NO_KIND
//   heldOf(kind), heldNodeOf(node), isFacePlaneId(id), nodeFromLit(lit), nodeToLit(node)
//   UNITS
import { Items, get, put, clone, litEq, isMap, kindOf, isBody, isCurve, isSketch, isMadeKind, isQuickKind, idOf, planeKey, writeNumber, U32_MAX } from "./forge-doc-items.js";

/// The units of every forge document: the page draws in millimetres.
export const UNITS = "mm";

const NODE = "@node";
const WAS = "@was";
const VALUE = "@value";

/// What cannot be written or read: the Rust's `Err(String)`, kept apart from a bug in
/// this code so that only a refusal becomes a stand-in.
export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };

/// The radians `profile.from_curves` turns by: `turn * Math.PI / 180`.
export const turnRadians = (d) => d * Math.PI / 180;

/// The radians an angle field gives a kind (`Args::radians`): `d * (PI / 180)`.
export const fieldRadians = (d) => d * (Math.PI / 180);

const bits = new DataView(new ArrayBuffer(8));
// The double one ulp from `v`, up or down; past zero to the smallest subnormal.
function nextToward(v, up) {
    if (!Number.isFinite(v)) return v;
    if (v === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    bits.setFloat64(0, v);
    const b = bits.getBigUint64(0);
    bits.setBigUint64(0, (v > 0) === up ? b + 1n : b - 1n);
    return bits.getFloat64(0);
}

/// The degree value for `rad` radians: the double nearest `rad * 180 / PI` whose `back`
/// (the consuming kind's conversion) is `rad` bit for bit, searched a few ulps either
/// side; the nearest itself when none is.
export function degreesFor(rad, back) {
    const d0 = rad * (180 / Math.PI);
    if (!Number.isFinite(d0) || back(d0) === rad) return d0;
    let up = d0, down = d0;
    for (let k = 0; k < 16; k++) {
        up = nextToward(up, true);
        if (back(up) === rad) return up;
        down = nextToward(down, false);
        if (back(down) === rad) return down;
    }
    return d0;
}

// ---------------------------------------------------------------------------------
// Small helpers.

// A finite number, else undefined.
const num = (l) => (typeof l === "number" && Number.isFinite(l) ? l : undefined);

// `len` finite numbers, else undefined.
function nums(l, len) {
    if (!Array.isArray(l) || l.length !== len) return undefined;
    return l.every((x) => num(x) !== undefined) ? l.slice() : undefined;
}

// An object from pairs, in their order.
function obj(pairs) {
    const out = {};
    for (const [k, v] of pairs) put(out, k, v);
    return out;
}

/// `i<n>`, the node of item `n`.
const itemId = (id) => `i${id}`;

// A Rust `u32` parsed from text: digits, an optional leading `+`, nothing past u32.
function parseU32(t) {
    if (!/^\+?[0-9]+$/.test(t)) return undefined;
    const v = Number(t);
    return v <= U32_MAX ? v : undefined;
}

/// The item a node id `i<n>` names: digits, no leading zero.
function itemOfId(id) {
    if (typeof id !== "string" || !/^i(0|[1-9][0-9]*)$/.test(id)) return undefined;
    return parseU32(id.slice(1));
}

/// Whether forge writes node `id`: `forge`, an item's `i<n>`, its helpers `i<n>_<role>`
/// and the shared face planes `f<b>_<k>`. Any other node is another app's (`Items.foreign`).
function isForgeId(id) {
    const us = id.indexOf("_");
    return id === "forge" || itemOfId(id) !== undefined || (us >= 0 && itemOfId(id.slice(0, us)) !== undefined) || isFacePlaneId(id);
}

/// Whether a node id is a face plane's shared node, `f<b>_<k>`.
export function isFacePlaneId(id) {
    return typeof id === "string" && /^f[0-9]+_[0-9]+$/.test(id);
}

/// What a held node's kind holds, as a held item's `of`: `solid`, `sheet` or `profile`.
export function heldOf(kind) {
    return { "solid.body": "solid", "sheet.body": "sheet", "profile.path": "profile" }[kind];
}

/// What node `nd` holds as a held item's `of`: a held node's kind (`heldOf`), or -- for a
/// node of any other kind whose `meta` says `"show": true` (the last node of another app's
/// graph, the body it builds) -- `sheet` for a `sheet.*` kind and `solid` for the rest.
/// Takes a node in either form.
export function heldNodeOf(nd) {
    const of = heldOf(nd.kind);
    if (of) return of;
    return get(nd.meta, "show") === true ? (nd.kind.startsWith("sheet.") ? "sheet" : "solid") : undefined;
}

/// The look a held node's `meta` gives (`colour` as `#rrggbb`, or three or four numbers
/// in 0..1), as forge's `look`.
function heldLook(nd) {
    let colour = get(nd.meta, "colour");
    if (colour === undefined) colour = get(nd.meta, "color");
    let hex;
    if (typeof colour === "string" && /^#[0-9a-fA-F]{6}$/.test(colour)) hex = colour.toLowerCase();
    else if (Array.isArray(colour) && (colour.length === 3 || colour.length === 4)) {
        hex = "#";
        for (const c of colour.slice(0, 3)) {
            if (typeof c !== "number") return undefined;
            const v = Math.round(Math.min(Math.max(c, 0), 1) * 255);
            hex += (Number.isNaN(v) ? 0 : v).toString(16).padStart(2, "0");
        }
    } else return undefined;
    return { colour: hex };
}

/// A held node's item: named from the node (its id where it has no name), its look from
/// its meta; a body has what a new quick solid has (forge.js reads its pivot, transform
/// and place), on Top, placed nowhere yet.
function heldItem(id, nd, of) {
    const hidden = nd.hidden === true;
    const f = [["id", id], ["name", typeof nd.name === "string" ? nd.name : nd.id]];
    if (of === "profile") {
        f.push(["kind", "held_profile"], ["node", nd.id], ["hidden", hidden]);
    } else {
        f.push(["kind", "held"], ["node", nd.id], ["sheet", of === "sheet"], ["plane", "top"], ["parts", []]);
        f.push(["pivot", [0, 0]]);
        f.push(["transform", { tx: 0, ty: 0, angle: 0, scale: 1 }]);
        f.push(["holes", 0], ["axis", null], ["angle", 0], ["source", null], ["hidden", hidden]);
        f.push(["place", { offset: [0, 0, 0], turn: [0, 0, 0] }]);
        const look = heldLook(nd);
        if (look) f.push(["look", look]);
    }
    return { id, fields: obj(f) };
}

function idLit(l) {
    return typeof l === "string" ? itemOfId(l) : undefined;
}

/// The surface and curve kind a placeholder reference names: no face or edge has it, so
/// the placeholder resolves to nothing and its node fails rather than build on a face it
/// happens to sit on.
export const NO_KIND = U32_MAX;

/// A placeholder face reference: what a node field holds for a pick not resolved yet.
/// Inert: its surface kind is `NO_KIND`. The command layer resolves the pick (the index
/// in the item's meta) to the face's reference and keeps it in the item's `faceRefs` (or
/// `Items.planes`), which `nodesOf` writes here instead.
export const facePlaceholder = () => ({ surface: NO_KIND, at: [0, 0, 0], normal: [0, 0, 1], extent: 1 });

/// A placeholder edge reference, as `facePlaceholder`: one per picked index.
export const edgePlaceholder = () => ({ curve: NO_KIND, mid: [0, 0, 0], tangent: [1, 0, 0], length: 1, faces: [[0, 0, 0], [0, 0, 0]], span: 1 });

/// Whether a reference is a placeholder (its surface or curve kind is `NO_KIND`).
export const isPlaceholder = (r) => get(r, "surface") === NO_KIND || get(r, "curve") === NO_KIND;

/// An item's references `key` (`faceRefs` / `edgeRefs`) as its node's field takes them,
/// or `count` placeholders where it has none yet.
function refsOr(c, key, count, placeholder) {
    const l = get(c, key);
    return Array.isArray(l) ? clone(l) : Array.from({ length: count }, placeholder);
}

/// The one face reference of a face item or a face sketch: its `faceRefs`' only entry, or
/// a placeholder.
function oneFaceRef(c) {
    const l = get(c, "faceRefs");
    return Array.isArray(l) && l.length === 1 && isMap(l[0]) ? clone(l[0]) : facePlaceholder();
}

function escape(v) {
    if (typeof v === "string") return v.startsWith("@") ? `@${v}` : v;
    if (Array.isArray(v)) return v.map(escape);
    if (isMap(v)) return obj(Object.entries(v).map(([k, x]) => [k, escape(x)]));
    return v;
}

function unescape(v) {
    if (typeof v === "string") return v.startsWith("@@") ? v.slice(1) : v;
    if (Array.isArray(v)) return v.map(unescape);
    if (isMap(v)) return obj(Object.entries(v).map(([k, x]) => [k, unescape(x)]));
    return v;
}

// ---------------------------------------------------------------------------------
// Paths into an item's fields: a key is a string, an index a number.

const key = (path, at) => (typeof path[at] === "string" ? path[at] : undefined);
const index = (path, at) => (typeof path[at] === "number" ? path[at] : undefined);
const show = (path) => path.map((k) => (typeof k === "string" ? `.${k}` : `[${k}]`)).join("");

// ---------------------------------------------------------------------------------
// Nodes.

function node(id, kind, fields) {
    return { id, kind, name: undefined, hidden: false, meta: undefined, fields };
}

function field(nd, k) {
    const p = nd.fields.find(([f]) => f === k);
    return p ? p[1] : undefined;
}

/// A node as a file holds it read in: `id`, `kind`, `name` (null: none), `hidden`, `meta`,
/// the rest its fields in their order. Throws a `Refusal` for a node no file holds.
export function nodeFromLit(lit) {
    if (!isMap(lit)) refuse("a node must be an object");
    const id = get(lit, "id");
    if (typeof id !== "string") refuse("a node needs an `id` (a string)");
    const kind = get(lit, "kind");
    if (typeof kind !== "string") refuse(`${id}: needs a \`kind\` (a string)`);
    const name = get(lit, "name"), hidden = get(lit, "hidden"), meta = get(lit, "meta");
    if (name !== undefined && name !== null && typeof name !== "string") refuse(`${id}: \`name\` must be a string`);
    if (hidden !== undefined && hidden !== null && typeof hidden !== "boolean") refuse(`${id}: \`hidden\` must be true or false`);
    if (meta !== undefined && meta !== null && !isMap(meta)) refuse(`${id}: \`meta\` must be an object`);
    const fields = Object.entries(lit).filter(([k]) => !["id", "kind", "name", "hidden", "meta"].includes(k)).map(([k, v]) => [k, clone(v)]);
    return { id, kind, name: name ?? undefined, hidden: hidden === true, meta: meta == null ? undefined : clone(meta), fields };
}

/// The node as a file holds it: `id`, `kind`, `name`, `hidden` (only when true), `meta`,
/// then the fields in order.
export function nodeToLit(nd) {
    const out = { id: nd.id, kind: nd.kind };
    if (nd.name !== undefined) out.name = nd.name;
    if (nd.hidden) out.hidden = true;
    if (nd.meta !== undefined) out.meta = clone(nd.meta);
    for (const [k, v] of nd.fields) put(out, k, clone(v));
    return out;
}

// ---------------------------------------------------------------------------------
// Origin planes and frames.

const originFrame = (name) => (name === "top" ? "xy" : name === "front" ? "xz" : "yz");

/// The plane key a frame field names: an origin plane, a sketch (`i<n>`) or a body's face
/// (`f<b>_<k>`).
function planeFromFrame(l) {
    if (typeof l !== "string") return undefined;
    if (l === "xy") return "top";
    if (l === "xz") return "front";
    if (l === "yz") return "right";
    const i = itemOfId(l);
    if (i !== undefined) return i;
    if (!l.startsWith("f")) return undefined;
    const rest = l.slice(1), us = rest.indexOf("_");
    if (us < 0) return undefined;
    const b = parseU32(rest.slice(0, us)), k = parseU32(rest.slice(us + 1));
    return b === undefined || k === undefined ? undefined : `face:${b}:${k}`;
}

/// A version-1 frame (nine numbers: origin, x, y) as a frame literal.
function frame9Lit(l) {
    const v = nums(l, 9);
    return v && { origin: v.slice(0, 3), x: v.slice(3, 6), y: v.slice(6, 9) };
}

function frame9Of(l) {
    if (l === undefined) return undefined;
    const out = [];
    for (const k of ["origin", "x", "y"]) {
        const v = nums(get(l, k), 3);
        if (!v) return undefined;
        out.push(...v);
    }
    return out;
}

// ---------------------------------------------------------------------------------
// Curves.

const CURVE_KINDS = { line: "curve.line", arc: "curve.arc", circle: "curve.circle", ellipse: "curve.ellipse", rect: "curve.rect", polygon: "curve.polygon", polyline: "curve.polyline", nurbs: "curve.spline", polycurve: "curve.polycurve" };
const FORGE_CURVE_KINDS = Object.fromEntries(Object.entries(CURVE_KINDS).map(([k, v]) => [v, k]));

/// forge's curve kind to its node kind.
const curveKind = (kind) => (Object.hasOwn(CURVE_KINDS, kind) ? CURVE_KINDS[kind] : undefined);
const forgeCurveKind = (nodeKind) => (Object.hasOwn(FORGE_CURVE_KINDS, nodeKind) ? FORGE_CURVE_KINDS[nodeKind] : undefined);

/// The shape keys a curve kind's node holds.
function shapeKeys(kind) {
    switch (kind) {
        case "line": case "rect": return ["x0", "y0", "x1", "y1"];
        case "arc": return ["x0", "y0", "xm", "ym", "x1", "y1"];
        case "circle": return ["cx", "cy", "r"];
        case "ellipse": return ["cx", "cy", "rx", "ry"];
        case "polygon": return ["cx", "cy", "r", "sides", "angle"];
        case "polyline": return ["points", "closed"];
        case "nurbs": return ["points", "degree", "weights", "closed"];
        case "polycurve": return ["pieces", "closed"];
        default: return [];
    }
}

/// A forge polycurve piece (`{kind, shape}`) as `curve.polycurve` takes it (`{kind, ..shape}`).
function pieceToNode(p) {
    const k = get(p, "kind");
    const out = [["kind", k === "nurbs" ? "spline" : k === undefined ? null : clone(k)]];
    const sh = get(p, "shape");
    if (isMap(sh)) out.push(...Object.entries(sh).map(([x, v]) => [x, clone(v)]));
    return obj(out);
}

function pieceFromNode(p) {
    if (!isMap(p)) return clone(p);
    const k = get(p, "kind");
    const kind = k === "spline" ? "nurbs" : k === undefined ? null : clone(k);
    const shape = obj(Object.entries(p).filter(([x]) => x !== "kind").map(([x, v]) => [x, clone(v)]));
    return { kind, shape };
}

function curveFields(kind, shape, frame) {
    const fields = [];
    for (const k of shapeKeys(kind)) {
        const v = get(shape, k);
        if (v === undefined) continue;
        fields.push([k, k === "pieces" && Array.isArray(v) ? v.map(pieceToNode) : clone(v)]);
    }
    fields.push(["frame", frame]);
    return fields;
}

/// A curve node's fields read as the item's: `kind`, `plane`, `shape.<key>`.
function readCurve(nd, path) {
    const top = key(path, 0);
    if (top === "kind" && path.length === 1) return forgeCurveKind(nd.kind);
    if (top === "plane" && path.length === 1) return planeFromFrame(field(nd, "frame"));
    if (top === "shape" && path.length === 2) {
        const k = key(path, 1);
        if (k === undefined) return undefined;
        const v = field(nd, k);
        if (v === undefined) return undefined;
        return k === "pieces" && Array.isArray(v) ? v.map(pieceFromNode) : clone(v);
    }
    return undefined;
}

// ---------------------------------------------------------------------------------
// Writing.

/// One step of a body's chain: its kind, its fields, and the input it reads the step
/// before through (none for the first).
const step = (role, kind, fields, input) => ({ role, kind, fields, input });

/// Kinds whose output is only a body: a cast follows them as a chain's last step.
const BODY_OUT = ["forge.moved", "forge.placed", "solid.merge_flush", "solid.loft_through"];

/// Whether a body builds a sheet (forge's old recipe.js `defineBody`'s `sheet`, and the
/// verbs that make one).
function bodyIsSheet(c) {
    switch (kindOf(c)) {
        case "surface": case "extrusion": case "trim": case "face": return true;
        case "held": return Boolean(get(c, "sheet"));
        case "revolution": return get(c, "sheet") !== false;
        case "loft": case "sweep": return Boolean(get(c, "sheet"));
        default: return false;
    }
}

/// A made body's in-plane move moves it (its transform's tx, ty or angle not 0).
function moves(c) {
    const t = get(c, "transform");
    return isMadeKind(kindOf(c)) && ["tx", "ty", "angle"].some((k) => { const v = num(get(t, k)); return v !== undefined && v !== 0; });
}

/// forge's old recipe.js `isPlaced`: a place whose offset or turn is not 0.
function isPlaced(c) {
    const place = get(c, "place");
    if (place === undefined) return false;
    const o = nums(get(place, "offset"), 3), t = nums(get(place, "turn"), 3);
    return Boolean(o && t) && [...o, ...t].some((v) => v !== 0);
}

const hasVia = (c) => { const v = get(c, "via"); return Array.isArray(v) && v.length > 0; };

/// forge's old recipe.js `worldAxis` / `mapPoint`: the axis's two points under the transform.
function worldAxis(c) {
    const t = get(c, "transform");
    if (t === undefined) return undefined;
    const tx = num(get(t, "tx")), ty = num(get(t, "ty")), angle = num(get(t, "angle")), scale = num(get(t, "scale"));
    if (tx === undefined || ty === undefined || angle === undefined || scale === undefined) return undefined;
    const p = nums(get(c, "pivot"), 2);
    const axis = get(c, "axis");
    if (!p || !Array.isArray(axis) || axis.length !== 2) return undefined;
    const cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
    const at = (q) => {
        const v = nums(q, 2);
        if (!v) return undefined;
        const x = v[0] - p[0], y = v[1] - p[1];
        return [p[0] + tx + cos * x - sin * y, p[1] + ty + sin * x + cos * y];
    };
    const a = at(axis[0]), b = at(axis[1]);
    return a && b ? [a, b] : undefined;
}

class Out {
    constructor(items, registry) {
        this.items = items;
        this.registry = registry;
        this.nodes = [];
        this.have = new Set();
        this.foreign = items.foreign.map(nodeFromLit);
    }

    push(nd) {
        this.have.add(nd.id);
        this.nodes.push(nd);
    }

    get(id) {
        return this.items.get(id)?.fields;
    }

    /// The frame field for a plane key: an origin plane's, a sketch's node, or a body
    /// face's shared `frame.on_face` (written now if it is not yet). `undefined` for a key
    /// that resolves to nothing (the page falls back to Top).
    frameOf(plane) {
        if (plane === undefined) return undefined;
        const k = planeKey(plane);
        if (!k) return undefined;
        if (k.origin) return originFrame(k.origin);
        if (k.sketch !== undefined) {
            const f = this.get(k.sketch);
            return f !== undefined && isSketch(f) ? itemId(k.sketch) : undefined;
        }
        const { body, index: at } = k.face;
        const b = this.get(body);
        if (b === undefined || !isBody(b)) return undefined;
        const id = `f${body}_${at}`;
        if (!this.have.has(id)) {
            const face = this.items.planes.has(id) ? clone(this.items.planes.get(id)) : facePlaceholder();
            this.push(node(id, "frame.on_face", [["solid", itemId(body)], ["face", face]]));
        }
        return id;
    }

    frameOrTop(plane) {
        return this.frameOf(plane) ?? originFrame("top");
    }

    /// The node of an item of the kind `want` asks for.
    itemNode(id, want, what, base) {
        if (id === undefined) refuse(`${base}: no ${what}`);
        const f = this.get(id);
        if (f !== undefined && want(f)) return itemId(id);
        refuse(`${base}: ${what} #${id} is gone`);
    }

    /// The steps written as nodes: the last is `base`, the others `base_<role>`, each
    /// reading the one before; a cast added where the last gives only a body.
    chain(base, steps, sheet) {
        if (steps.length && BODY_OUT.includes(steps[steps.length - 1].kind)) steps.push(step("as", sheet ? "forge.sheet" : "forge.solid", [], "body"));
        let prev = "", last;
        steps.forEach((st, k) => {
            const id = k + 1 === steps.length ? base : `${base}_${st.role}`;
            const fields = st.input ? [[st.input, prev], ...st.fields] : st.fields;
            const nd = node(id, st.kind, fields);
            prev = id;
            if (k + 1 === steps.length) last = nd;
            else this.push(nd);
        });
        return last;
    }

    /// `profile.from_curves` node `id` over `holder`'s loops (or its version-1 source, as
    /// curve nodes `<id>_c<k>` on `frame`), moved by its pivot and transform.
    source(id, holder, frame, open) {
        const fields = [];
        const loops = get(holder, "loops"), src = get(holder, "source");
        if (Array.isArray(loops)) {
            const curves = [], per = [];
            for (const l of loops) {
                if (!Array.isArray(l)) refuse(`${id}: a loop is not a list`);
                for (const c of l) curves.push(this.itemNode(idOf(c), isCurve, "curve", id));
                per.push(l.length);
            }
            fields.push(["curves", curves], ["per_loop", per]);
        } else if (isMap(src)) {
            const cs = get(src, "curves");
            if (!Array.isArray(cs)) refuse(`${id}: a source without curves`);
            const curves = [];
            cs.forEach((c, k) => {
                const kind = kindOf(c);
                const nk = curveKind(kind) ?? refuse(`${id}: no curve kind \`${kind}\``);
                const cid = `${id}_c${k}`;
                this.push(node(cid, nk, curveFields(kind, get(c, "shape"), clone(frame))));
                curves.push(cid);
            });
            fields.push(["curves", curves]);
            const per = get(src, "perLoop");
            if (Array.isArray(per)) fields.push(["per_loop", clone(per)]);
        } else {
            refuse(`${id}: no loops and no source`);
        }
        const p = nums(get(holder, "pivot"), 2);
        if (p) fields.push(["pivot", p]);
        const t = get(holder, "transform");
        if (t !== undefined) {
            const tx = num(get(t, "tx")), ty = num(get(t, "ty")), a = num(get(t, "angle")), sc = num(get(t, "scale"));
            if (tx !== undefined && ty !== undefined) fields.push(["move", [tx, ty]]);
            if (a !== undefined) fields.push(["turn", degreesFor(a, turnRadians)]);
            if (sc !== undefined) fields.push(["scale", sc]);
        }
        if (open) fields.push(["open", true]);
        this.push(node(id, "profile.from_curves", fields));
    }

    /// A body part of a made body: an item's node, or a version-1 frozen definition
    /// written as a body of its own, `<base>_p<k>`.
    part(base, parts, k) {
        const p = parts[k];
        if (isMap(p)) {
            const id = `${base}_p${k}`;
            const frame = frame9Lit(get(p, "frame")) ?? originFrame("top");
            this.push(this.body(id, p, frame));
            return id;
        }
        return this.itemNode(idOf(p), isBody, "body", base);
    }

    /// The face item `parts[k]` names and the body that face is on.
    facePart(base, parts, k) {
        const id = idOf(parts[k]);
        if (id === undefined) refuse(`${base}: no face`);
        const face = this.get(id) ?? refuse(`${base}: face #${id} is gone`);
        const fp = get(face, "parts");
        if (!Array.isArray(fp)) refuse(`${base}: the face has no body`);
        return this.itemNode(idOf(fp[0]), isBody, "body", base);
    }

    /// The face reference of the face item `parts[k]` (a placeholder until it has one).
    facePartRef(parts, k) {
        const id = idOf(parts[k]);
        const f = id === undefined ? undefined : this.get(id);
        return f === undefined ? facePlaceholder() : oneFaceRef(f);
    }

    /// A body's nodes: its helpers pushed, its last node returned (id `base`). `frame` is a
    /// frozen part's own; an item's is its plane's, made only where a node reads it.
    body(base, c, frameIn) {
        const kind = kindOf(c);
        const sheet = bodyIsSheet(c);
        const steps = [];
        const made = isMadeKind(kind);
        const needsFrame = !made || isQuickKind(kind) || moves(c) || isPlaced(c);
        const frame = frameIn !== undefined ? frameIn : needsFrame ? this.frameOrTop(get(c, "plane")) : originFrame("top");
        const src = `${base}_src`;
        const numOr = (k) => num(get(c, k)) ?? refuse(`${base}: \`${k}\` is not a number`);
        if (!made) {
            const open = kind === "extrusion" ? true : kind === "revolution" || kind === "sweep" ? sheet : kind === "loft" ? sheet && !hasVia(c) : false;
            switch (kind) {
                case "surface":
                    this.source(src, c, frame, false);
                    steps.push(step("inner", "sheet.face", [["profile", src], ["frame", clone(frame)]]));
                    break;
                case "extrusion": case "solid": {
                    this.source(src, c, frame, open);
                    const tapered = Boolean(get(c, "taper"));
                    const k = kind === "extrusion" ? (tapered ? "solid.extrude_open_tapered" : "solid.extrude_open") : tapered ? "solid.extrude_tapered" : "solid.extrude";
                    const f = [["profile", src], ["frame", clone(frame)], ["distance", numOr("height")]];
                    if (tapered) f.push(["taper", numOr("taper")]);
                    steps.push(step("inner", k, f));
                    break;
                }
                case "revolution": {
                    this.source(src, c, frame, open);
                    const [a, b] = worldAxis(c) ?? refuse(`${base}: no axis`);
                    const k = sheet ? "solid.revolve_open_in_plane" : "solid.revolve_in_plane";
                    steps.push(step("inner", k, [["profile", src], ["frame", clone(frame)], ["from", a], ["to", b], ["angle", numOr("angle")]]));
                    break;
                }
                case "sweep": {
                    this.source(src, c, frame, open);
                    const path = this.itemNode(idOf(get(c, "path")), isCurve, "path", base);
                    steps.push(step("inner", sheet ? "solid.sweep_open" : "solid.sweep", [["profile", src], ["frame", clone(frame)], ["path", path]]));
                    break;
                }
                case "loft": {
                    this.source(src, c, frame, open);
                    const to = get(c, "to");
                    if (to === undefined) refuse(`${base}: a loft without \`to\``);
                    const toId = `${base}_to`;
                    const toFrame = this.frameOrTop(get(to, "plane"));
                    this.source(toId, to, toFrame, open);
                    if (hasVia(c)) {
                        const profiles = [src], frames = [clone(frame)];
                        get(c, "via").forEach((v, k) => {
                            const vid = `${base}_via${k}`;
                            const vf = this.frameOrTop(get(v, "plane"));
                            this.source(vid, v, vf, false);
                            profiles.push(vid);
                            frames.push(vf);
                        });
                        profiles.push(toId);
                        frames.push(toFrame);
                        steps.push(step("inner", "solid.loft_through", [["profiles", profiles], ["frames", frames], ["solid", !sheet]]));
                    } else {
                        steps.push(step("inner", sheet ? "solid.loft_open" : "solid.loft", [["a", src], ["frame_a", clone(frame)], ["b", toId], ["frame_b", toFrame]]));
                    }
                    break;
                }
                default: refuse(`${base}: no body kind \`${kind}\``);
            }
        } else {
            const ps = get(c, "parts");
            const parts = Array.isArray(ps) ? ps : [];
            const count = (k) => { const l = get(c, k); return Array.isArray(l) ? l.length : 0; };
            switch (kind) {
                case "join": {
                    const solids = parts.map((_, k) => this.part(base, parts, k));
                    steps.push(step("inner", "solid.join", [["solids", solids]]));
                    break;
                }
                case "cut": case "intersect": {
                    const a = this.part(base, parts, 0), b = this.part(base, parts, 1);
                    steps.push(kind === "cut" ? step("inner", "solid.cut", [["target", a], ["tool", b]]) : step("inner", "solid.common", [["a", a], ["b", b]]));
                    break;
                }
                case "shell": {
                    const p = this.part(base, parts, 0);
                    steps.push(step("inner", "solid.shell", [["solid", p], ["thickness", numOr("thickness")], ["open", refsOr(c, "faceRefs", count("open"), facePlaceholder)]]));
                    break;
                }
                case "thicken": {
                    const p = this.part(base, parts, 0);
                    steps.push(step("inner", "solid.thicken", [["sheet", p], ["thickness", numOr("thickness")]]));
                    break;
                }
                case "trim": {
                    const sheetIn = this.part(base, parts, 0);
                    const toolId = idOf(parts[1]);
                    const t = toolId === undefined ? undefined : this.get(toolId);
                    let tool;
                    if (t !== undefined && isCurve(t)) {
                        tool = `${base}_tool`;
                        this.push(node(tool, "forge.curve_tool", [["curve", itemId(toolId)], ["sheet", sheetIn]]));
                    } else {
                        tool = this.part(base, parts, 1);
                    }
                    const split = `${base}_split`;
                    this.push(node(split, "sheet.split_sheet", [["sheet", sheetIn], ["tool", tool]]));
                    steps.push(step("inner", "solid.drop_faces", [["solid", split], ["faces", refsOr(c, "faceRefs", count("drop"), facePlaceholder)]]));
                    break;
                }
                case "prism": {
                    const p = this.part(base, parts, 0);
                    steps.push(step("inner", "solid.extrude_faces", [["sheet", p], ["height", numOr("height")]]));
                    break;
                }
                case "press": {
                    const solid = this.facePart(base, parts, 0);
                    if (parts.length === 1) {
                        steps.push(step("inner", "solid.push_pull", [["solid", solid], ["face", this.facePartRef(parts, 0)], ["distance", numOr("height")]]));
                    } else {
                        const faces = parts.map((_, k) => this.facePartRef(parts, k));
                        steps.push(step("inner", "solid.push_pull_faces", [["solid", solid], ["faces", faces], ["distance", numOr("height")]]));
                    }
                    break;
                }
                case "refillet": case "rechamfer": case "remove": {
                    const solid = this.facePart(base, parts, 0);
                    const face = this.facePartRef(parts, 0);
                    if (kind === "refillet") steps.push(step("inner", "solid.refillet", [["solid", solid], ["face", face], ["radius", numOr("radius")]]));
                    else if (kind === "rechamfer") steps.push(step("inner", "solid.rechamfer", [["solid", solid], ["face", face], ["distance", numOr("radius")]]));
                    else steps.push(step("inner", get(c, "what") === "chamfer" ? "solid.unchamfer" : "solid.unfillet", [["solid", solid], ["face", face]]));
                    break;
                }
                case "face": {
                    const p = this.part(base, parts, 0);
                    steps.push(step("inner", "sheet.face_sheet", [["solid", p], ["face", oneFaceRef(c)]]));
                    break;
                }
                case "fillet": {
                    const p = this.part(base, parts, 0);
                    const edges = refsOr(c, "edgeRefs", count("edges"), edgePlaceholder);
                    if (get(c, "style") === "chamfer") steps.push(step("inner", "solid.chamfer", [["solid", p], ["edges", edges], ["distance", numOr("radius")]]));
                    else steps.push(step("inner", "solid.fillet", [["solid", p], ["edges", edges], ["radius", numOr("radius")]]));
                    break;
                }
                case "pipe": {
                    const path = this.itemNode(idOf(get(c, "path")), isCurve, "path", base);
                    const d = nums(get(c, "dims"), 2) ?? refuse(`${base}: a pipe's dims are two numbers`);
                    steps.push(step("inner", "solid.pipe", [["path", path], ["radius", d[0]], ["thickness", d[1]]]));
                    break;
                }
                case "split": {
                    const solid = this.part(base, parts, 0);
                    const side = clone(get(c, "side") ?? 0);
                    const cutter = get(c, "cutter");
                    const t = idOf(cutter), f = t === undefined ? undefined : this.get(t);
                    if (f !== undefined && isCurve(f)) {
                        const cut = `${base}_cut`;
                        const cf = this.frameOrTop(get(f, "plane"));
                        this.push(node(cut, "profile.from_curves", [["curves", [itemId(t)]]]));
                        steps.push(step("inner", "solid.split_side_by_profile", [["solid", solid], ["profile", cut], ["frame", cf], ["side", side]]));
                    } else if (f !== undefined && isBody(f)) {
                        steps.push(step("inner", "solid.split_side", [["solid", solid], ["tool", itemId(t)], ["side", side]]));
                    } else {
                        // A plane: an origin plane's key, a sketch's, a face's -- or gone.
                        const plane = this.frameOf(cutter) ?? refuse(`${base}: the cutter is gone`);
                        steps.push(step("inner", "solid.split_side_by_plane", [["solid", solid], ["plane", plane], ["side", side]]));
                    }
                    break;
                }
                case "held": {
                    const held = this.heldNode(base, c);
                    // The item's own node reads the held one as it is, typed as forge's bodies are.
                    steps.push(step("inner", sheet ? "forge.sheet" : "forge.solid", [["body", held]]));
                    break;
                }
                default: {
                    if (!isQuickKind(kind)) refuse(`${base}: no body kind \`${kind}\``);
                    const dims = get(c, "dims");
                    if (!Array.isArray(dims)) refuse(`${base}: a quick solid without dims`);
                    steps.push(step("inner", "forge.primitive", [["shape", kind], ["dims", clone(dims)], ["frame", clone(frame)]]));
                }
            }
            if (["join", "cut", "intersect"].includes(kind) && get(c, "flush")) steps.push(step("flush", "solid.merge_flush", [], "solid"));
            // forge's old recipe.js `movedSolid`: the in-plane move, written when it moves anything.
            if (moves(c)) {
                const t = get(c, "transform");
                const f = [["frame", clone(frame)]];
                const p = nums(get(c, "pivot"), 2);
                if (p) f.push(["pivot", p]);
                f.push(["tx", num(get(t, "tx")) ?? 0], ["ty", num(get(t, "ty")) ?? 0], ["angle", degreesFor(num(get(t, "angle")) ?? 0, fieldRadians)]);
                steps.push(step("moved", "forge.moved", f, "solid"));
            }
        }
        // forge's old recipe.js `placedSolid`: written when the body is placed (`isPlaced`).
        const place = get(c, "place");
        if (place !== undefined) {
            const o = nums(get(place, "offset"), 3), tu = nums(get(place, "turn"), 3);
            if (o && tu && isPlaced(c)) {
                const t = get(c, "transform");
                const f = [["frame", clone(frame)]];
                const p = nums(get(c, "pivot"), 2);
                if (p) f.push(["pivot", p]);
                f.push(["tx", num(get(t, "tx")) ?? 0], ["ty", num(get(t, "ty")) ?? 0], ["offset", o], ["turn", tu]);
                steps.push(step("placed", "forge.placed", f, "solid"));
            }
        }
        return this.chain(base, steps, sheet);
    }

    /// A sketch's plane node `i<n>_frame` (forge.js `planeInfo`): Top where what it is
    /// placed by is gone, as the page falls back.
    sketchFrame(n, c) {
        const id = `i${n}_frame`;
        const fallback = () => node(id, "frame.offset", [["base", originFrame("top")], ["offset", 0]]);
        const m = get(c, "mode");
        const mode = typeof m === "string" ? m : "";
        const curve = (k) => {
            const i = idOf(get(c, k));
            const f = i === undefined ? undefined : this.get(i);
            return f !== undefined && isCurve(f) ? itemId(i) : undefined;
        };
        switch (mode) {
            case "offset": {
                const b = get(c, "base"), o = num(get(c, "offset"));
                return typeof b === "string" && ["top", "front", "right"].includes(b) && o !== undefined ? node(id, "frame.offset", [["base", originFrame(b)], ["offset", o]]) : fallback();
            }
            case "angle": {
                const h = curve("hinge"), t = num(get(c, "tilt"));
                return h !== undefined && t !== undefined ? node(id, "frame.tilted", [["hinge", h], ["tilt", t]]) : fallback();
            }
            case "path": {
                const p = curve("path");
                return p !== undefined ? node(id, "frame.on_path", [["path", p]]) : fallback();
            }
            case "face": {
                const b = idOf(get(get(c, "face"), "body"));
                const f = b === undefined ? undefined : this.get(b);
                return f !== undefined && isBody(f) ? node(id, "frame.on_face", [["solid", itemId(b)], ["face", oneFaceRef(c)]]) : fallback();
            }
            case "mid": {
                const mid = get(c, "mid");
                if (!Array.isArray(mid) || mid.length !== 2) return fallback();
                const frames = [];
                for (let k = 0; k < mid.length; k++) {
                    const r = mid[k];
                    let fr;
                    if (isMap(r)) {
                        const b = idOf(get(r, "body"));
                        const bf = b === undefined ? undefined : this.get(b);
                        if (bf !== undefined && isBody(bf)) {
                            const midId = `i${n}_mid${k}`;
                            const refs = get(c, "faceRefs");
                            const face = Array.isArray(refs) && isMap(refs[k]) ? clone(refs[k]) : facePlaceholder();
                            this.push(node(midId, "frame.on_face", [["solid", itemId(b)], ["face", face]]));
                            fr = midId;
                        }
                    } else if (idOf(r) === n) {
                        fr = undefined;
                    } else {
                        fr = this.frameOf(r);
                    }
                    if (fr === undefined) return fallback();
                    frames.push(fr);
                }
                return node(id, "frame.mid", [["a", frames[0]], ["b", frames[1]]]);
            }
            case "points": {
                const points = get(c, "points");
                if (!Array.isArray(points)) return fallback();
                const curves = [], ends = [];
                for (const p of points) {
                    const ci = idOf(get(p, "curve"));
                    const f = ci === undefined ? undefined : this.get(ci);
                    const e = num(get(p, "end"));
                    if (f === undefined || !isCurve(f) || litEq(get(f, "plane"), n) || (e !== 0 && e !== 1)) return fallback();
                    curves.push(itemId(ci));
                    ends.push(e);
                }
                return node(id, "frame.through_ends", [["curves", curves], ["ends", ends]]);
            }
            default: return fallback();
        }
    }

    /// Item `it`'s nodes, its helpers pushed and its own returned, `broken` when it is a
    /// stand-in: where its nodes cannot be written (what it reads is gone) or a field of
    /// one is refused by its kind (`checkNode`), nothing of it is kept but
    /// `forge.broken_<type>` with the reason.
    item(it) {
        const mark = this.nodes.length;
        try {
            if (this.items.broken.has(it.id)) refuse(this.items.broken.get(it.id));   // a pick not resolved
            const last = this.build(it);
            const output = (id) => {
                const nd = id === last.id ? last : (this.nodes.findLast((x) => x.id === id) ?? this.foreign.find((x) => x.id === id));
                return nd ? this.registry.get(nd.kind)?.output : undefined;
            };
            for (const nd of [...this.nodes.slice(mark), last]) {
                const kind = this.registry.get(nd.kind) ?? refuse(`${nd.id}: no kind \`${nd.kind}\``);
                checkNode(kind, nd, output);
            }
            return { last, broken: false };
        } catch (e) {
            if (!(e instanceof Refusal)) throw e;
            for (const nd of this.nodes.splice(mark)) this.have.delete(nd.id);
            const c = it.fields;
            const kind = isSketch(c) ? "forge.broken_sketch" : isBody(c) ? (bodyIsSheet(c) ? "forge.broken_sheet" : "forge.broken_solid") : "forge.broken_curve";
            const nd = node(itemId(it.id), kind, [["why", e.message]]);
            const name = get(c, "name");
            if (typeof name === "string") nd.name = name;
            nd.hidden = get(c, "hidden") === true;
            return { last: nd, broken: true };
        }
    }

    /// The foreign node a held item names, refused where it is gone or holds no such thing.
    heldNode(base, c) {
        const held = get(c, "node");
        if (typeof held !== "string") refuse(`${base}: a held item names no node`);
        const nd = this.foreign.find((f) => f.id === held) ?? refuse(`${base}: the held node \`${held}\` is gone`);
        const want = kindOf(c) === "held_profile" ? "profile" : get(c, "sheet") ? "sheet" : "solid";
        if (heldNodeOf(nd) !== want) refuse(`${base}: \`${held}\` is a ${nd.kind}, not a held ${want}`);
        return held;
    }

    build(it) {
        const c = it.fields;
        const base = itemId(it.id);
        const kind = kindOf(c);
        let last;
        if (kind === "held_profile") {
            const held = this.heldNode(base, c);
            last = node(base, "profile.translate", [["profile", held], ["by", [0, 0]]]);
        } else if (isSketch(c)) {
            const frame = this.sketchFrame(it.id, c);
            this.push(frame);
            const f = [["frame", frame.id]];
            const cs = get(c, "constraints");
            if (cs !== undefined) f.push(["forge_constraints", clone(cs)]);
            last = node(base, "sketch", f);
        } else if (isBody(c)) {
            last = this.body(base, c, undefined);
        } else {
            const nk = curveKind(kind) ?? refuse(`${base}: no item kind \`${kind}\``);
            const frame = this.frameOrTop(get(c, "plane"));
            last = node(base, nk, curveFields(kind, get(c, "shape"), frame));
        }
        const name = get(c, "name");
        if (typeof name === "string") last.name = name;
        last.hidden = get(c, "hidden") === true;
        return last;
    }
}

// ---------------------------------------------------------------------------------
// Reading.

class Doc {
    constructor(nodes) {
        this.nodes = new Map();
        for (const nd of nodes) this.nodes.set(nd.id, nd);   // the last of an id wins, as the Rust's map has it
    }

    node(id) {
        return this.nodes.get(id);
    }

    /// A chain step: `<base>_<role>`, or `base` itself when it is that step.
    step(base, role, kinds) {
        const own = this.node(`${base}_${role}`);
        if (own) return own;
        const b = this.node(base);
        return b && kinds.includes(b.kind) ? b : undefined;
    }

    /// The verb: `<base>_inner`, or `base` when the chain is the verb alone.
    inner(base) {
        return this.node(`${base}_inner`) ?? this.node(base);
    }

    field(id, k) {
        const nd = this.node(id);
        return nd ? field(nd, k) : undefined;
    }
}

/// A `profile.from_curves` node's fields read as its holder's: `loops` (or a version-1
/// `source`), `pivot`, `transform.<tx|ty|angle|scale>`.
function readSource(doc, id, path) {
    const src = doc.node(id);
    if (!src) return undefined;
    const top = key(path, 0);
    if (top === "loops" && path.length === 1) {
        const curves = field(src, "curves");
        if (!Array.isArray(curves)) return undefined;
        const ids = curves.map(idLit);
        if (ids.some((x) => x === undefined)) return undefined;
        let per;
        const pl = field(src, "per_loop");
        if (Array.isArray(pl)) {
            per = pl.map(num);
            if (per.some((x) => x === undefined)) return undefined;
            per = per.map((v) => Math.max(Math.trunc(v), 0));   // `as usize`
        } else per = [ids.length];
        if (per.reduce((a, b) => a + b, 0) !== ids.length) return undefined;
        let at = 0;
        return per.map((k) => { at += k; return ids.slice(at - k, at); });
    }
    if (top === "source") {
        const k1 = key(path, 1);
        if (k1 === "perLoop" && path.length === 2) return clone(field(src, "per_loop"));
        if (k1 === "curves" && path.length >= 4) {
            const k = index(path, 2);
            if (k === undefined) return undefined;
            const c = doc.node(`${id}_c${k}`);
            return c ? readCurve(c, path.slice(3)) : undefined;
        }
        return undefined;
    }
    if (top === "pivot" && path.length === 1) return clone(field(src, "pivot"));
    if (top === "transform" && path.length === 2) {
        const mv = field(src, "move");
        switch (key(path, 1)) {
            case "tx": return Array.isArray(mv) ? clone(mv[0]) : undefined;
            case "ty": return Array.isArray(mv) ? clone(mv[1]) : undefined;
            case "angle": { const d = num(field(src, "turn")); return d === undefined ? undefined : turnRadians(d); }
            case "scale": return clone(field(src, "scale"));
            default: return undefined;
        }
    }
    return undefined;
}

/// A move node's (`forge.moved`, `forge.placed`) fields read as its body's: `plane`,
/// `pivot`, `transform.<tx|ty|angle>`, `place.<offset|turn>`.
function readMove(nd, path, frameKey) {
    const top = key(path, 0);
    if (top === undefined) return undefined;
    if (path.length === 1) {
        if (top === "plane" && frameKey === "plane") return planeFromFrame(field(nd, "frame"));
        if (top === "frame" && frameKey === "frame") return frame9Of(field(nd, "frame"));
        if (top === "pivot") return clone(field(nd, "pivot"));
        return undefined;
    }
    if (path.length === 2 && top === "transform") {
        switch (key(path, 1)) {
            case "tx": return clone(field(nd, "tx"));
            case "ty": return clone(field(nd, "ty"));
            case "angle": {
                if (nd.kind !== "forge.moved") return undefined;
                const d = num(field(nd, "angle"));
                return d === undefined ? undefined : fieldRadians(d);
            }
            default: return undefined;
        }
    }
    if (path.length === 2 && top === "place" && nd.kind === "forge.placed") {
        const k = key(path, 1);
        return k === "offset" || k === "turn" ? clone(field(nd, k)) : undefined;
    }
    return undefined;
}

const EXTRUDES = ["solid.extrude", "solid.extrude_open", "solid.extrude_tapered", "solid.extrude_open_tapered"];
const FRAMED = ["forge.primitive", "sheet.face", ...EXTRUDES, "solid.revolve_in_plane", "solid.revolve_open_in_plane", "solid.sweep", "solid.sweep_open"];

/// What the nodes say of `holder`'s field at `path`: `holder` is item `base`'s fields (or
/// a frozen part's), or its meta skeleton -- only its kind and the shape of its nested
/// parts are read off it.
function readBody(doc, base, holder, path, frameKey) {
    const kind = kindOf(holder);   // a kind never starts with `@`, so the skeleton's is the item's
    const inner = doc.inner(base);
    if (!inner) return undefined;
    const moved = doc.step(base, "moved", ["forge.moved"]);
    const placed = doc.step(base, "placed", ["forge.placed"]);
    const top = key(path, 0);
    if (top === undefined) return undefined;
    // The place, and a made body's move, from the move nodes.
    if (top === "place") return placed ? readMove(placed, path, frameKey) : undefined;
    const made = isMadeKind(kind);
    if (made && (top === "pivot" || top === "transform")) {
        const m = moved ?? placed;
        return m ? readMove(m, path, frameKey) : undefined;
    }
    if (!made) {
        if (["loops", "source", "pivot", "transform"].includes(top)) return readSource(doc, `${base}_src`, path);
        if (top === "to" || top === "via") {
            let id, at;
            if (top === "to") [id, at] = [`${base}_to`, 1];
            else {
                const v = index(path, 1);
                if (v === undefined) return undefined;
                [id, at] = [`${base}_via${v}`, 2];
            }
            if (key(path, at) === "plane" && path.length === at + 1) {
                let frame;
                if (inner.kind === "solid.loft_through") {
                    const fs = field(inner, "frames");
                    if (Array.isArray(fs)) frame = top === "to" ? fs[fs.length - 1] : fs[index(path, 1) + 1];
                } else if (top === "to") frame = field(inner, "frame_b");
                return planeFromFrame(frame);
            }
            return readSource(doc, id, path.slice(at));
        }
    }
    if (path.length === 1) {
        const one = (k) => clone(field(inner, k));
        const ik = inner.kind;
        switch (top) {
            case "plane": case "frame": {
                let frame;
                if (ik === "solid.loft_through") { const fs = field(inner, "frames"); frame = Array.isArray(fs) ? fs[0] : undefined; }
                else if (ik === "solid.loft" || ik === "solid.loft_open") frame = field(inner, "frame_a");
                else if (FRAMED.includes(ik)) frame = field(inner, "frame");
                else { const m = moved ?? placed; frame = m ? field(m, "frame") : undefined; }
                if (top === "plane" && frameKey === "plane") return planeFromFrame(frame);
                if (top === "frame" && frameKey === "frame") return frame9Of(frame);
                return undefined;
            }
            case "height":
                if (EXTRUDES.includes(ik) || ik === "solid.push_pull" || ik === "solid.push_pull_faces") return one("distance");
                return ik === "solid.extrude_faces" ? one("height") : undefined;
            case "taper": return ik.endsWith("_tapered") ? one("taper") : undefined;
            case "sheet":
                if (ik === "solid.loft_through") { const s = field(inner, "solid"); return typeof s === "boolean" ? !s : undefined; }
                if (ik.startsWith("solid.revolve") || ik.startsWith("solid.loft") || ik.startsWith("solid.sweep")) return ik.includes("_open");
                return undefined;
            case "path": return idLit(field(inner, "path"));
            // The picks' references: what the nodes hold.
            case "faceRefs":
                if (ik === "solid.shell") return one("open");
                if (ik === "solid.drop_faces") return one("faces");
                if (ik === "sheet.face_sheet") { const f = one("face"); return f === undefined ? undefined : [f]; }
                return undefined;
            case "edgeRefs": return ik === "solid.fillet" || ik === "solid.chamfer" ? one("edges") : undefined;
            case "radius":
                if (ik === "solid.fillet" || ik === "solid.refillet") return one("radius");
                return ik === "solid.chamfer" || ik === "solid.rechamfer" ? one("distance") : undefined;
            case "dims":
                if (ik === "forge.primitive") return one("dims");
                if (ik === "solid.pipe") { const r = field(inner, "radius"); return r === undefined ? undefined : [clone(r), clone(field(inner, "thickness") ?? 0)]; }
                return undefined;
            case "parts": {
                let ids;
                const req = (...ks) => { const vs = ks.map((k) => field(inner, k)); return vs.some((v) => v === undefined) ? undefined : vs; };
                if (ik === "solid.join") { const l = field(inner, "solids"); if (!Array.isArray(l)) return undefined; ids = l; }
                else if (ik === "solid.cut") ids = req("target", "tool");
                else if (ik === "solid.common") ids = req("a", "b");
                else if (["solid.shell", "solid.fillet", "solid.chamfer", "sheet.face_sheet", "solid.split_side", "solid.split_side_by_plane", "solid.split_side_by_profile"].includes(ik)) ids = req("solid");
                else if (ik === "solid.thicken" || ik === "solid.extrude_faces") ids = req("sheet");
                else if (ik === "solid.drop_faces") {
                    const split = doc.node(`${base}_split`);
                    if (!split) return undefined;
                    let tool = field(split, "tool");
                    if (tool === undefined) return undefined;
                    if (tool === `${base}_tool`) { tool = doc.field(tool, "curve"); if (tool === undefined) return undefined; }
                    const sheet = field(split, "sheet");
                    if (sheet === undefined) return undefined;
                    ids = [sheet, tool];
                } else return undefined;
                if (!ids) return undefined;
                const out = ids.map(idLit);
                return out.some((x) => x === undefined) ? undefined : out;
            }
        }
        if (top === "angle" && kind === "revolution") return one("angle");
        if (top === "thickness" && (kind === "shell" || kind === "thicken")) return one("thickness");
        if (top === "flush" && ["join", "cut", "intersect"].includes(kind)) return doc.step(base, "flush", ["solid.merge_flush"]) !== undefined;
        if (top === "side" && kind === "split") return one("side");
        if (top === "cutter" && kind === "split") {
            if (ik === "solid.split_side") return idLit(field(inner, "tool"));
            if (ik === "solid.split_side_by_plane") return planeFromFrame(field(inner, "plane"));
            if (ik === "solid.split_side_by_profile") { const cs = doc.field(`${base}_cut`, "curves"); return Array.isArray(cs) && cs.length === 1 ? idLit(cs[0]) : undefined; }
            return undefined;
        }
    }
    // A frozen part of a version-1 made body: a body of its own.
    if (top === "parts" && path.length >= 3) {
        const k = index(path, 1);
        if (k === undefined) return undefined;
        const ps = get(holder, "parts");
        const part = Array.isArray(ps) ? ps[k] : undefined;
        if (isMap(part)) return readBody(doc, `${base}_p${k}`, part, path.slice(2), "frame");
    }
    return undefined;
}

/// A sketch's fields read off its nodes: its plane parameters and constraints.
function readSketch(doc, base, path) {
    const frame = doc.node(`${base}_frame`);
    if (!frame) return undefined;
    const top = key(path, 0);
    if (top === undefined) return undefined;
    if (top === "constraints" && path.length === 1) return clone(doc.field(base, "forge_constraints"));
    const fk = frame.kind, len = path.length;
    if (fk === "frame.offset" && top === "base" && len === 1) { const b = planeFromFrame(field(frame, "base")); return typeof b === "string" ? b : undefined; }
    if (fk === "frame.offset" && top === "offset" && len === 1) return clone(field(frame, "offset"));
    if (fk === "frame.tilted" && top === "hinge" && len === 1) return idLit(field(frame, "hinge"));
    if (fk === "frame.tilted" && top === "tilt" && len === 1) return clone(field(frame, "tilt"));
    if (fk === "frame.on_path" && top === "path" && len === 1) return idLit(field(frame, "path"));
    if (fk === "frame.on_face" && top === "face" && len === 2 && key(path, 1) === "body") return idLit(field(frame, "solid"));
    if (fk === "frame.on_face" && top === "faceRefs" && len === 1) { const f = field(frame, "face"); return f === undefined ? undefined : [clone(f)]; }
    if (fk === "frame.mid" && top === "faceRefs" && len === 1) return [0, 1].map((k) => clone(doc.field(`${base}_mid${k}`, "face") ?? null));
    if (fk === "frame.mid" && top === "mid" && len === 2) {
        const k = index(path, 1);
        return k === 0 ? planeFromFrame(field(frame, "a")) : k === 1 ? planeFromFrame(field(frame, "b")) : undefined;
    }
    if (fk === "frame.mid" && top === "mid" && len === 3 && key(path, 2) === "body") {
        const k = index(path, 1);
        return k === undefined ? undefined : idLit(doc.field(`${base}_mid${k}`, "solid"));
    }
    if (fk === "frame.through_ends" && top === "points" && len === 3) {
        const k = index(path, 1);
        if (k === undefined) return undefined;
        const which = key(path, 2);
        if (which === "curve") { const cs = field(frame, "curves"); return Array.isArray(cs) ? idLit(cs[k]) : undefined; }
        if (which === "end") { const es = field(frame, "ends"); return Array.isArray(es) ? clone(es[k]) : undefined; }
    }
    return undefined;
}

/// What the nodes say of item `id`'s field at `path`; `holder` gives its kind (the item
/// itself, or its meta skeleton).
function readItem(doc, id, holder, path) {
    const base = itemId(id);
    const last = doc.node(base);
    if (!last) return undefined;
    const top = key(path, 0);
    if (top === undefined) return undefined;
    if (path.length === 1) {
        if (top === "id") return id;
        if (top === "name") return last.name;
        if (top === "hidden") return last.hidden;
    }
    if (isSketch(holder)) return readSketch(doc, base, path);
    if (isBody(holder)) return readBody(doc, base, holder, path, "plane");
    return readCurve(last, path);
}

/// The skeleton of `value` at `path`: `"@node"` where the nodes read it back as it is, a
/// guard where a field a node holds reads back otherwise, else the value (escaped).
function skeleton(value, path, read) {
    const got = path.length === 0 ? undefined : read(path);
    if (got !== undefined && litEq(got, value)) return NODE;
    if (isMap(value)) {
        return obj(Object.entries(value).map(([k, v]) => {
            path.push(k);
            const out = skeleton(v, path, read);
            path.pop();
            return [k, out];
        }));
    }
    if (Array.isArray(value)) {
        return value.map((v, i) => {
            path.push(i);
            const out = skeleton(v, path, read);
            path.pop();
            return out;
        });
    }
    return got !== undefined ? { [WAS]: got, [VALUE]: escape(value) } : escape(value);
}

function isGuard(l) {
    if (!isMap(l)) return false;
    const ks = Object.keys(l);
    return ks.length === 2 && ks[0] === WAS && ks[1] === VALUE;
}

/// The value a skeleton stands for, its `"@node"`s read off the nodes.
function fill(sk, path, read, base) {
    if (sk === NODE) {
        const v = read(path);
        if (v === undefined) refuse(`${base}: no node gives \`${show(path)}\``);
        return v;
    }
    if (isGuard(sk)) {
        const v = read(path);
        return v !== undefined && !litEq(v, sk[WAS]) ? v : unescape(sk[VALUE]);
    }
    if (isMap(sk)) {
        return obj(Object.entries(sk).map(([k, v]) => {
            path.push(k);
            const out = fill(v, path, read, base);
            path.pop();
            return [k, out];
        }));
    }
    if (Array.isArray(sk)) {
        return sk.map((v, i) => {
            path.push(i);
            const out = fill(v, path, read, base);
            path.pop();
            return out;
        });
    }
    return unescape(sk);
}

/// How many guards (fields a node holds that do not read back exactly) the nodes' meta
/// carries. Takes nodes in either form.
export function guards(nodes) {
    const count = (l) => {
        if (isGuard(l)) return 1;
        if (Array.isArray(l)) return l.reduce((n, x) => n + count(x), 0);
        if (isMap(l)) return Object.values(l).reduce((n, x) => n + count(x), 0);
        return 0;
    };
    return nodes.reduce((n, nd) => n + (nd.meta === undefined || nd.meta === null ? 0 : count(nd.meta)), 0);
}

/// The fields in the kind's param order (as a loaded document has them).
function ordered(nd, registry) {
    const k = registry.get(nd.kind);
    if (!k) return nd;
    const rest = nd.fields.slice(), fields = [];
    for (const p of k.params) {
        const at = rest.findIndex(([f]) => f === p.name);
        if (at >= 0) fields.push(...rest.splice(at, 1));
    }
    nd.fields = [...fields, ...rest];
    return nd;
}

/// The items as document nodes (file form), in the items' order, each item's helpers
/// before it, the counters' node `forge` first, another app's nodes before all of them.
/// See the module header for the mapping. It does not fail on an item: one it cannot
/// write is a `forge.broken_<type>`. `registry` is `registryOf(kinds)`: the kinds every
/// node is checked against and ordered by.
export function nodesOf(items, registry) {
    const out = new Out(items, registry);
    out.push(node("forge", "forge.counters", [["counters", clone(items.counters)], ["next_id", items.nextId]]));
    const itemNodes = [];
    for (const it of items.items) {
        const { last, broken } = out.item(it);
        itemNodes.push({ it, id: last.id, broken });
        out.push(last);
    }
    // Another app's nodes first, as they are; then forge's.
    const nodes = [...out.foreign.map((nd) => ({ ...nd, fields: clone(nd.fields), meta: clone(nd.meta) })), ...out.nodes.map((nd) => ordered(nd, registry))];
    // Each item's meta: its fields, what the nodes read back left as "@node".
    const doc = new Doc(nodes);
    const metas = itemNodes.map(({ it, id, broken }) => {
        // A stand-in reads nothing back: the whole item is its meta.
        if (broken) return [id, escape(it.fields)];
        return [id, skeleton(it.fields, [], (p) => readItem(doc, it.id, it.fields, p))];
    });
    for (const [id, sk] of metas) nodes.find((nd) => nd.id === id).meta = { forge: sk };
    return nodes.map(nodeToLit);
}

/// The items back off the nodes: every node with `meta.forge` is an item, in document
/// order, its fields its meta with every `"@node"` read off the nodes; the counters off
/// node `forge`. Every node forge does not write is kept (`Items.foreign`), and a held one
/// no item names yet is an item too, after forge's, ids from the next free one on.
/// `state` is a document (`{ nodes }`, as a file or `cadaclysm_blacksmith_document_save`
/// gives it) or its list of nodes. Throws a `Refusal` where a meta reads a field no node
/// gives.
export function itemsOf(state) {
    const nodes = (Array.isArray(state) ? state : state.nodes).map(nodeFromLit);
    const doc = new Doc(nodes);
    const items = new Items();
    const f = doc.node("forge");
    if (f) {
        const c = field(f, "counters");
        if (isMap(c)) items.counters = clone(c);
        const v = num(field(f, "next_id"));
        if (v !== undefined) items.nextId = Math.min(Math.max(Math.trunc(v), 0), U32_MAX);
    }
    for (const nd of nodes) {
        if (nd.kind === "frame.on_face" && isFacePlaneId(nd.id)) {
            const face = field(nd, "face");
            if (face !== undefined && !isPlaceholder(face)) items.planes.set(nd.id, clone(face));
        }
    }
    for (const nd of nodes) {
        const sk = get(nd.meta, "forge");
        if (sk === undefined) continue;
        const id = itemOfId(nd.id);
        if (id === undefined) continue;
        const fields = fill(sk, [], (p) => readItem(doc, id, sk, p), nd.id);
        items.items.push({ id, fields });
    }
    items.foreign = nodes.filter((nd) => !isForgeId(nd.id)).map(nodeToLit);
    const named = new Set(items.items.map((it) => get(it.fields, "node")).filter((h) => typeof h === "string"));
    const fresh = items.foreign.map((nd) => [nd, named.has(nd.id) ? undefined : heldNodeOf(nd)]).filter(([, of]) => of !== undefined);
    for (const [nd, of] of fresh) {
        const id = Math.max(items.nextId, items.items.reduce((m, it) => Math.max(m, it.id + 1), 1));
        items.items.push(heldItem(id, nd, of));
        items.nextId = id + 1;
    }
    return items;
}

/// A document state over these nodes, millimetres: what a document file holds less its
/// history (the format and version a file adds are the caller's).
export const stateOf = (nodes) => ({ units: UNITS, params: {}, nodes });

// ---------------------------------------------------------------------------------
// The kinds, and the node checks (the Rust `state::check_node`, `refs`).

/// The kinds by name, from `cadaclysm_blacksmith_document_kinds()` (its text or the parsed
/// list): each `{ name, output, params: [{ name, role, type, list?, optional?, default?,
/// range?, positive?, choices?, unit? }] }`.
export function registryOf(kinds) {
    const list = typeof kinds === "string" ? JSON.parse(kinds) : kinds;
    return new Map(list.map((k) => [k.name, k]));
}

const PLANES = ["xy", "xz", "yz"];
const LACING = "lacing";

const article = (name) => `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;

/// The Rust `Type::accepts`, over the kinds' type names (`solid`, `list<nurbs>`, ...).
function accepts(want, got) {
    if (want === got || got === "value") return true;
    if (want === "body" && (got === "solid" || got === "sheet")) return true;
    // A body-typed output (a placed or coloured body) may be a solid or a sheet: a solid or
    // sheet input takes it, and the reader checks what it got.
    if ((want === "solid" || want === "sheet") && got === "body") return true;
    if (want === "frame" && got === "sketch") return true;
    if (want === "profiles" && (got === "profile" || got === "sketch")) return true;
    const lw = /^list<(.*)>$/.exec(want), lg = /^list<(.*)>$/.exec(got);
    return Boolean(lw && lg) && accepts(lw[1], lg[1]);
}

/// A number in an error, as the Rust `state::number_text`: an exponent from 1e9 up.
function numberText(v) {
    return Math.abs(v) >= 1e9 && Number.isFinite(v) ? v.toExponential().replace("e+", "e") : writeNumber(v);
}

const UNIT_LITERAL_SHAPE = " must be a number, a unit literal or an expression";
const isExpression = (l) => typeof l === "string" && l.startsWith("=");

// One numeric slot. A number is checked against the range; an expression (`=...`) or a
// unit literal (`10 mm`) would need the kernel's expression parser, which forge never
// needs -- it writes only numbers: an expression is let through unchecked (the kernel
// checks it when the document is applied), and anything else is refused as the Rust
// refuses a literal that does not parse.
function checkSlot(lit, int, range, positive) {
    if (typeof lit === "number") {
        if (int && !Number.isInteger(lit)) return " must be a whole number";
        if (range && (lit < range[0] || lit > range[1])) return ` must be within ${numberText(range[0])} and ${numberText(range[1])}, not ${numberText(lit)}`;
        if (positive && lit <= 0) return ` must be above 0, not ${numberText(lit)}`;
        return null;
    }
    if (isExpression(lit)) return null;
    return UNIT_LITERAL_SHAPE;
}

function checkList(lit, len, what, each) {
    if (!Array.isArray(lit) || (len !== undefined && lit.length !== len)) return ` must be ${what}`;
    for (const x of lit) {
        const e = each(x);
        if (e) return e;
    }
    return null;
}

// The Rust `refs::*_from` checks: the key set exact, every number plain and finite.
function keyed(l, keys) {
    if (!isMap(l)) return "must be an object";
    const bad = Object.keys(l).find((k) => !keys.includes(k));
    if (bad !== undefined) return `has an unknown key \`${bad}\``;
    const missing = keys.find((k) => get(l, k) === undefined);
    return missing === undefined ? null : `\`${missing}\` is missing`;
}
const vecItem = (l) => Array.isArray(l) && l.length === 3 && l.every((v) => typeof v === "number" && Number.isFinite(v));
function refChecks(l, keys, checks) {
    const e = keyed(l, keys);
    if (e) return e;
    for (const [k, how] of checks) {
        const v = get(l, k);
        if (how === "kind" && !(typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= U32_MAX)) return `\`${k}\` must be a whole number from 0 to ${U32_MAX}`;
        if (how === "vec" && !vecItem(v)) return `\`${k}\` must be a list of 3 numbers`;
        if (how === "direction") {
            if (!vecItem(v)) return `\`${k}\` must be a list of 3 numbers`;
            const sq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
            if (!(sq > 0 && Number.isFinite(sq))) return `\`${k}\` must be a nonzero vector`;
        }
        if (how === "positive") {
            if (!(typeof v === "number" && Number.isFinite(v))) return `\`${k}\` must be a number`;
            if (!(v > 0)) return `\`${k}\` must be above 0`;
        }
        if (how === "pair" && !(Array.isArray(v) && v.length === 2 && vecItem(v[0]) && vecItem(v[1]))) return `\`${k}\` must be a list of 2 lists of 3 numbers`;
    }
    return null;
}
const faceRefError = (l) => refChecks(l, ["surface", "at", "normal", "extent"], [["surface", "kind"], ["at", "vec"], ["normal", "direction"], ["extent", "positive"]]);
const edgeRefError = (l) => refChecks(l, ["curve", "mid", "tangent", "length", "faces", "span"], [["curve", "kind"], ["mid", "vec"], ["tangent", "direction"], ["length", "positive"], ["faces", "pair"], ["span", "positive"]]);
const vertexRefError = (l) => refChecks(l, ["at"], [["at", "vec"]]);

function refList(lit, what, parse) {
    if (!Array.isArray(lit)) return ` must be ${what}`;
    for (let i = 0; i < lit.length; i++) {
        const e = parse(lit[i]);
        if (e) return `: reference ${i + 1}: ${e}`;
    }
    return null;
}

const WHOLE_EXPRESSION = ["point2", "point3", "vector3", "numbers", "ints", "points2", "points3"];

// A field's literal against its type; the error's tail (` must be ...`), or null.
function checkField(p, lit, output) {
    const ty = p.type, range = p.range, positive = Boolean(p.positive);
    const slot = (l) => checkSlot(l, false, range, positive);
    // A point: its numbers, or one expression giving it.
    const point = (l, n) => (isExpression(l) ? null : checkList(l, n, `a list of ${n} numbers`, slot));
    // A frame literal: a plane's name, a frame or sketch node, or `{origin, x, y}`.
    const frame = (l) => {
        if (typeof l === "string") {
            if (PLANES.includes(l)) return null;
            const out = output(l);
            if (out === undefined) return ` names no node \`${l}\``;
            return accepts("frame", out) ? null : ` wants a frame, \`${l}\` is ${article(out)}`;
        }
        if (isMap(l)) {
            const bad = Object.keys(l).find((k) => !["origin", "x", "y"].includes(k));
            if (bad !== undefined) return ` has an unknown key \`${bad}\``;
            for (const k of ["origin", "x", "y"]) {
                const v = get(l, k);
                if (v === undefined) return " needs `origin`, `x` and `y`";
                const e = point(v, 3);
                if (e) return `: \`${k}\`${e}`;
            }
            return null;
        }
        return ' must be "xy", "xz", "yz", a node id or {"origin", "x", "y"}';
    };
    // A list-shaped field given whole by one expression: checked when the node evaluates.
    if (isExpression(lit) && WHOLE_EXPRESSION.includes(ty)) return null;
    // A reference field naming the node that holds the references.
    if (typeof lit === "string" && ["face_ref", "face_refs", "edge_refs", "vertex_ref"].includes(ty)) return output(lit) === undefined ? ` names no node \`${lit}\`` : null;
    const fromRef = (e) => (e ? `: ${e}` : null);
    switch (ty) {
        case "number": return slot(lit);
        case "int": return checkSlot(lit, true, range, positive);
        case "bool": return typeof lit === "boolean" || isExpression(lit) ? null : " must be true, false or an expression";
        case "expr": {
            const expr = (l) => {
                if (typeof l === "number" || typeof l === "boolean") return null;
                if (typeof l === "string") return checkSlot(l, false, undefined, false);
                if (Array.isArray(l)) { for (const x of l) { const e = expr(x); if (e) return e; } return null; }
                return " must be a number, a unit literal, true or false, an expression or a list of them";
            };
            return expr(lit);
        }
        case "text": return typeof lit === "string" ? null : " must be text";
        case "choice": return typeof lit === "string" && (p.choices ?? []).includes(lit) ? null : ` must be one of ${(p.choices ?? []).join(", ")}`;
        case "point2": return point(lit, 2);
        case "point3": case "vector3": return point(lit, 3);
        case "numbers": return checkList(lit, undefined, "a list of numbers", slot);
        case "ints": return checkList(lit, undefined, "a list of whole numbers", (s) => checkSlot(s, true, range, positive));
        case "points2": return checkList(lit, undefined, "a list of 2D points", (q) => point(q, 2));
        case "points3": return checkList(lit, undefined, "a list of 3D points", (q) => point(q, 3));
        case "frame": return frame(lit);
        case "frames": {
            if (!Array.isArray(lit)) return " must be a list of frames";
            for (let i = 0; i < lit.length; i++) { const e = frame(lit[i]); if (e) return `: frame ${i + 1}${e}`; }
            return null;
        }
        case "plane": {
            if (!isMap(lit)) return ' must be {"at", "normal"}';
            const bad = Object.keys(lit).find((k) => !["at", "normal"].includes(k));
            if (bad !== undefined) return ` has an unknown key \`${bad}\``;
            for (const k of ["at", "normal"]) {
                const v = get(lit, k);
                if (v === undefined) return " needs `at` and `normal`";
                const e = point(v, 3);
                if (e) return `: \`${k}\`${e}`;
            }
            return null;
        }
        case "face_ref": return fromRef(faceRefError(lit));
        case "face_refs": return refList(lit, "a list of face references", faceRefError);
        case "edge_refs": return refList(lit, "a list of edge references", edgeRefError);
        case "vertex_ref": return fromRef(vertexRefError(lit));
        // A body's and a path's tables: forge writes neither (a held node is another app's,
        // kept as it is); the kernel checks them when the document is applied.
        default: return null;
    }
}

/// The Rust `state::check_node`: every param of `kind` present (or defaulted, or
/// optional) and of its type, no field the kind lacks, `lacing` one of its two words.
/// `output(id)` is the output type name of node `id`, `undefined` for no such node.
/// Throws a `Refusal` naming the node and the field. `nd` is a node in the inner form.
export function checkNode(kind, nd, output) {
    for (const p of kind.params) {
        const pair = nd.fields.find(([k]) => k === p.name);
        if (!pair) {
            if (!Object.hasOwn(p, "default") && !p.optional) refuse(`${nd.id}: \`${p.name}\` is missing`);
            continue;
        }
        const lit = pair[1];
        let e;
        if (p.role === "input") {
            const checkId = (l) => {
                if (typeof l !== "string") return " must be a node id";
                const out = output(l);
                if (out === undefined) return ` names no node \`${l}\``;
                return accepts(p.type, out) ? null : ` wants ${article(p.type)}, \`${l}\` is ${article(out)}`;
            };
            e = p.list ? checkList(lit, undefined, "a list of node ids", checkId) : checkId(lit);
        } else {
            e = checkField(p, lit, output);
        }
        if (e) refuse(`${nd.id}: \`${p.name}\`${e}`);
    }
    const bad = nd.fields.find(([k]) => k !== LACING && !kind.params.some((p) => p.name === k));
    if (bad) refuse(`${nd.id}: \`${bad[0]}\` is not a field of ${nd.kind}`);
    const lacing = nd.fields.find(([k]) => k === LACING);
    if (lacing && lacing[1] !== "longest" && lacing[1] !== "cross") refuse(`${nd.id}: \`lacing\` must be "longest" or "cross"`);
}
