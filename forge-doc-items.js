// The forge document's items: forge's curves, sketches and bodies as plain objects -- the
// fields exactly as the page's `__forgeTest.items()` hook gives them -- the counters that
// name new items, the page's predicates over them, the plane keys an item is placed by,
// and a body's place in the world. A port of the Rust `forge::items`, `forge::planes` and
// `forge::place`, so the forge runs on
// the public kernel build: no DOM, no wasm, importable by the page, the worker and node.
//
// Values are JSON values (objects, arrays, numbers, strings, booleans, null); a key the
// page leaves `undefined` is absent, as JSON leaves it out. An item's fields are a plain
// object in the key order the page's object has: a key set again stays where it was, a
// new key goes last -- JavaScript's own order for string keys, which `put` keeps. The
// order matters: the document stores each item's fields in it (forge-doc-nodes.js).
//
//   new Items()                       an empty document: no items, every counter 0, next id 1
//     .items                          [{ id, fields }], in list order
//     .counters / .nextId             the counters (`Line 3`) and the next free id
//     .planes                         Map: face plane node `f<b>_<k>` -> its face reference
//     .broken                         Map: item id -> why its pick could not be resolved
//     .foreign                        another app's nodes, in document order, as they are
//     .toLit() .indexOf(id) .get(id) .bump(id) .count(kind) .nameFor(kind) .clone()
//   item(fields)                      an item from its fields; the id is the fields' own
//   label(kind), isQuickKind / isMadeKind / isBodyKind(kind)
//   kindOf / isBody / isSketch / isImage / isHeldProfile / isCurve(fields)
//   get(map, key), put / putOpt / remove(map, key, v), kept(v), litEq(a, b), clone(v)
//   f(fields, key), idOf(v), idsOf(v), loopsOf(v), loopsLit(loops), still(), noPlace()
//   writeNumber(v)                    a number as the document's text writes it
//   facePlane(body, index), planeKey(v), originFrame(name)
//   placeOf(body), fromAxisAngle / mul / fromEuler / toAxisAngle, placeAxisAngle(body)

/// The largest id (a `u32` in the Rust).
export const U32_MAX = 4294967295;

// ---------------------------------------------------------------------------------
// JSON values.

export const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/// `map[key]` when `map` is an object holding `key`; `undefined` otherwise (a list, a
/// number, a missing key) -- never a value off the prototype.
export function get(map, key) {
    return isMap(map) && Object.hasOwn(map, key) ? map[key] : undefined;
}

/// A deep copy: the Rust clones every value it hands on, so nothing here aliases what
/// the caller keeps.
export const clone = (v) => (v === null || typeof v !== "object" ? v : structuredClone(v));

/// The Rust `Lit`'s equality: numbers by `===` (so `-0` is `0`, and `NaN` is nothing),
/// lists element by element, objects key by key in order.
export function litEq(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => litEq(x, b[i]));
    if (isMap(a)) {
        if (!isMap(b)) return false;
        const ka = Object.keys(a), kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k, i) => k === kb[i] && litEq(a[k], b[k]));
    }
    return false;
}

/// `map[key] = v`: in place where the key is, else last. An own `__proto__` key is a key
/// like any other, as a JSON object has it.
export function put(map, key, v) {
    if (!isMap(map)) return;
    if (key === "__proto__" && !Object.hasOwn(map, key)) Object.defineProperty(map, key, { value: v, enumerable: true, writable: true, configurable: true });
    else map[key] = v;
}

/// `map[key] = v` where `v` may be `undefined`: the key then leaves the JSON.
export function putOpt(map, key, v) {
    if (v === undefined) remove(map, key);
    else put(map, key, v);
}

export function remove(map, key) {
    if (isMap(map)) delete map[key];
}

/// The keys the page derives or keeps while it runs, dropped at any depth by the
/// `items()` hook (forge.js 8223): never stored here.
export const RUNTIME_KEYS = ["cache", "gpu", "job", "dirty", "waiting", "version", "ghostFaces", "sig", "bounds", "beziers", "sketch", "error", "closure", "joined", "jobAt", "sigOut", "waitingSig", "rev"];

/// A command's value as the page keeps it (`structuredClone`), less the runtime keys
/// its `items()` hook would drop at any depth.
export function kept(v) {
    if (Array.isArray(v)) return v.map(kept);
    if (isMap(v)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (!RUNTIME_KEYS.includes(k)) put(out, k, kept(x));
        return out;
    }
    return v;
}

/// A number as the document's text writes it (the Rust `lit::write_number`): `-0.0` for a
/// negative zero, a whole number below 1e15 as digits, anything larger in exponent form,
/// and the rest as Rust's shortest form -- which turns to an exponent below 1e-4, where
/// JavaScript waits until 1e-6.
export function writeNumber(v) {
    if (v === 0 && 1 / v < 0) return "-0.0";
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    if (Math.abs(v) >= 1e15 || Math.abs(v) < 1e-4) return v.toExponential().replace("e+", "e");
    return String(v);
}

// ---------------------------------------------------------------------------------
// Kinds and predicates.

/// The counters as the page starts them (forge.js 1187), in its order.
const COUNTERS = [
    "image", "line", "polyline", "rect", "circle", "arc", "ellipse", "polygon", "nurbs", "polycurve", "surface", "extrusion", "revolution", "solid", "sweep", "loft", "join", "cut", "intersect", "chamfer", "shell", "thicken", "trim", "prism", "press", "refillet", "rechamfer", "remove", "fillet", "sketch", "face", "box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil", "pipe", "split",
];

const LABELS = {
    image: "Image", line: "Line", polyline: "Polyline", rect: "Rectangle", circle: "Circle", arc: "Arc", ellipse: "Ellipse", polygon: "Polygon", nurbs: "NURBS", polycurve: "Polycurve",
    surface: "Surface", extrusion: "Extrusion", revolution: "Revolution", solid: "Solid", sweep: "Sweep", loft: "Loft", join: "Join", cut: "Cut", intersect: "Intersect", chamfer: "Chamfer",
    shell: "Shell", thicken: "Thicken", trim: "Trim", prism: "Solid", press: "Press Pull", refillet: "Refillet", rechamfer: "Rechamfer", remove: "Remove", fillet: "Fillet", sketch: "Sketch",
    face: "Face", box: "Box", cylinder: "Cylinder", sphere: "Sphere", cone: "Cone", pyramid: "Pyramid", torus: "Torus", coil: "Coil", pipe: "Pipe", split: "Split",
};

/// An item kind's label (forge.js `LABELS`, 1188); "undefined" for a kind it lacks, as
/// a template string writes it.
export const label = (kind) => (Object.hasOwn(LABELS, kind) ? LABELS[kind] : "undefined");

/// The quick solids (forge's old recipe.js `QUICK_KINDS`, 444).
export const QUICK_KINDS = ["box", "cylinder", "sphere", "cone", "pyramid", "torus", "coil"];
export const isQuickKind = (kind) => QUICK_KINDS.includes(kind);

const MADE = ["join", "cut", "intersect", "shell", "thicken", "trim", "prism", "press", "refillet", "rechamfer", "remove", "fillet", "face", "pipe", "split", "held"];
/// forge.js `isMade` (1213): a body made of other bodies, or a quick solid, a pipe, a
/// split, a held body (another app's `solid.body` or `sheet.body`).
export const isMadeKind = (kind) => MADE.includes(kind) || isQuickKind(kind);

const DRAWN = ["surface", "extrusion", "revolution", "solid", "sweep", "loft"];
/// forge.js `isBody` (1203).
export const isBodyKind = (kind) => DRAWN.includes(kind) || isMadeKind(kind);

/// An item's kind, "" when it has none.
export function kindOf(fields) {
    const k = get(fields, "kind");
    return typeof k === "string" ? k : "";
}

export const isBody = (fields) => isBodyKind(kindOf(fields));
export const isSketch = (fields) => kindOf(fields) === "sketch";
export const isImage = (fields) => kindOf(fields) === "image";
/// A held profile (another app's `profile.path`): listed and kept, not drawn, and no
/// curve a tool takes.
export const isHeldProfile = (fields) => kindOf(fields) === "held_profile";
/// forge.js `isCurve` (1248): neither a body, a sketch, an image nor a held profile.
export const isCurve = (fields) => !isBody(fields) && !isSketch(fields) && !isImage(fields) && !isHeldProfile(fields);

/// JavaScript truthiness of a field that may be absent: the Rust spells it out, here it
/// is the language's own.
export const truthy = (v) => Boolean(v);

/// `a ?? b`: the field unless it is absent or null.
export const orElse = (v, b) => (v === undefined || v === null ? b : clone(v));

// ---------------------------------------------------------------------------------
// Fields.

/// A number field, if it is one.
export function f(fields, key) {
    const v = get(fields, key);
    return typeof v === "number" ? v : undefined;
}

/// An id field: a whole, non-negative number a `u32` holds.
export function idOf(v) {
    return typeof v === "number" && v >= 0 && Number.isInteger(v) && v <= U32_MAX ? v : undefined;
}

/// A list of ids, what is no id left out.
export function idsOf(v) {
    return Array.isArray(v) ? v.map(idOf).filter((x) => x !== undefined) : [];
}

/// A body's loops: lists of curve ids; `undefined` where it has none.
export function loopsOf(v) {
    return Array.isArray(v) ? v.map(idsOf) : undefined;
}

export const loopsLit = (loops) => loops.map((l) => l.slice());

/// The identity transform `{ tx: 0, ty: 0, angle: 0, scale: 1 }`.
export const still = () => ({ tx: 0, ty: 0, angle: 0, scale: 1 });
/// The identity place `{ offset: [0, 0, 0], turn: [0, 0, 0] }` (forge's old recipe.js `placeOf`, 406).
export const noPlace = () => ({ offset: [0, 0, 0], turn: [0, 0, 0] });

// ---------------------------------------------------------------------------------
// The items.

/// The page's document state: the items in list order, the counters that name new items
/// (`Line 3`), and the next free id (forge.js `nextId`, raised by `bump`).
///
/// `planes` is the document's, not the page's: the face reference each face plane
/// (`face:<b>:<k>`) resolved to when it was first used, by the id of its shared
/// `frame.on_face` node (`f<b>_<k>`). An item's own picks keep theirs in its
/// `faceRefs` / `edgeRefs` fields (see forge-doc-nodes.js).
///
/// `broken` is the document's too, and lives for one command: the items whose picks
/// the command layer could not resolve and keeps as stand-ins, by id, with the reason.
/// `nodesOf` writes each as its `forge.broken_<type>`; `itemsOf` never fills it.
///
/// `foreign` is the document's too: the nodes forge did not write (another app's -- a
/// held bodies, say), in document order, kept as they are. `nodesOf` writes
/// them first, untouched. A held one (`solid.body`, `sheet.body`, `profile.path`) is an
/// item of kind `held` or `held_profile` besides, naming it by its `node`.
export class Items {
    /// An empty document: no items, every counter 0, the next id 1 (forge.js `replay`, 1146).
    constructor() {
        this.items = [];
        this.counters = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
        this.nextId = 1;
        this.planes = new Map();
        this.broken = new Map();
        this.foreign = [];
    }

    /// The items as a list of their fields: what the page's `items()` hook returns.
    toLit() {
        return this.items.map((i) => clone(i.fields));
    }

    indexOf(id) {
        const at = this.items.findIndex((i) => i.id === id);
        return at < 0 ? undefined : at;
    }
    get(id) {
        return this.items.find((i) => i.id === id);
    }

    /// forge.js `bump` (653).
    bump(id) {
        this.nextId = Math.max(this.nextId, Math.min(id + 1, U32_MAX));
    }

    /// `++counters[kind]`.
    count(kind) {
        const n = (f(this.counters, kind) ?? 0) + 1;
        put(this.counters, kind, n);
        return Number.isNaN(n) ? 0 : Math.min(Math.max(Math.trunc(n), 0), U32_MAX);
    }

    /// `${LABELS[kind]} ${++counters[kind]}`: a new item's name.
    nameFor(kind) {
        return `${label(kind)} ${this.count(kind)}`;
    }

    /// A copy sharing nothing with this one.
    clone() {
        const out = new Items();
        out.items = this.items.map((i) => ({ id: i.id, fields: clone(i.fields) }));
        out.counters = clone(this.counters);
        out.nextId = this.nextId;
        out.planes = new Map([...this.planes].map(([k, v]) => [k, clone(v)]));
        out.broken = new Map(this.broken);
        out.foreign = clone(this.foreign);
        return out;
    }
}

/// An item from its fields; the id is the fields' own.
export const item = (fields) => ({ id: idOf(get(fields, "id")) ?? 0, fields });

// ---------------------------------------------------------------------------------
// Plane keys (forge.js `PLANES` 3899, `facePlane` 3943, `planeInfo` 3945): an origin
// plane's name, a sketch item's id, or `face:<body>:<index>` for a face of a body. The
// item model only reads and writes the keys; their frames are the node mapping's
// (origin planes are literal frames, the others need geometry).

/// forge.js `facePlane` (3943): the key of face `index` of body `body`, the index as a
/// template string would write it -- a number as the document writes numbers.
export function facePlane(body, index) {
    const at = typeof index === "number" ? writeNumber(index) : typeof index === "string" ? index : index === null ? "null" : "undefined";
    return `face:${body}:${at}`;
}

// A Rust `u32` parsed from text: digits, an optional leading `+`, nothing past u32.
function parseU32(t) {
    if (!/^\+?[0-9]+$/.test(t)) return undefined;
    const v = Number(t);
    return v <= U32_MAX ? v : undefined;
}

/// A plane key read off an item's `plane`: `{ origin: "top" | "front" | "right" }`,
/// `{ sketch: id }` or `{ face: { body, index } }`; `undefined` for one forge would not know.
export function planeKey(v) {
    if (typeof v === "string") {
        if (v === "top" || v === "front" || v === "right") return { origin: v };
        if (!v.startsWith("face:")) return undefined;
        const rest = v.slice(5), colon = rest.indexOf(":");
        if (colon < 0) return undefined;
        const body = parseU32(rest.slice(0, colon)), index = parseU32(rest.slice(colon + 1));
        return body === undefined || index === undefined ? undefined : { face: { body, index } };
    }
    if (typeof v === "number" && v >= 0 && Number.isInteger(v)) return { sketch: Math.min(v, U32_MAX) };
    return undefined;
}

/// An origin plane's frame, twelve numbers (origin, x, y, z) as forge.js `PLANES` gives
/// it (`right`, `up`, `normal`).
export function originFrame(name) {
    if (name === "top") return [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    if (name === "front") return [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0];
    if (name === "right") return [0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0];
    return undefined;
}

// ---------------------------------------------------------------------------------
// A body's place in the world (forge's old recipe.js `placeOf` 406, `Q` 378-403): an
// offset and turns about the world axes in degrees, X then Y then Z, about the body's
// pivot. The turn as one axis and angle is what a `solid.move` takes; the arithmetic is
// the page's (the Rust copies V8's `Math.hypot` and fdlibm's `sin` / `cos` to match it).

/// forge's old recipe.js `placeOf` (406): the body's `place`, or the identity.
export const placeOf = (body) => {
    const p = get(body, "place");
    return p === undefined ? noPlace() : clone(p);
};

/// forge's old recipe.js `Q.fromAxisAngle`.
export function fromAxisAngle(axis, angle) {
    const l = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(l > 1e-12)) return [0, 0, 0, 1];
    const s = Math.sin(angle / 2);
    return [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, Math.cos(angle / 2)];
}

/// forge's old recipe.js `Q.mul`.
export const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/// forge's old recipe.js `Q.fromEuler`: degrees about X, then Y, then Z.
export function fromEuler(turn) {
    const d = Math.PI / 180;
    return mul(fromAxisAngle([0, 0, 1], turn[2] * d), mul(fromAxisAngle([0, 1, 0], turn[1] * d), fromAxisAngle([1, 0, 0], turn[0] * d)));
}

/// forge's old recipe.js `Q.toAxisAngle`: the unit axis and the angle in radians.
export function toAxisAngle(q) {
    const s = Math.hypot(q[0], q[1], q[2]);
    if (s < 1e-12) return { axis: [0, 0, 1], angle: 0 };
    return { axis: [q[0] / s, q[1] / s, q[2] / s], angle: 2 * Math.atan2(s, q[3]) };
}

/// A body's place turn as one axis and angle (radians): what `placedSolid` moves by. A
/// turn entry that is not a number counts as 0.
export function placeAxisAngle(body) {
    const t = get(placeOf(body), "turn");
    const turn = [0, 1, 2].map((k) => (Array.isArray(t) && typeof t[k] === "number" ? t[k] : 0));
    return toAxisAngle(fromEuler(turn));
}
