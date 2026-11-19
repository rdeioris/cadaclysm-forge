// The forge's picks over the kernel: faces and edges of a body named by references (what a
// node holds and looks its face or edge up by), and the frames faces take as planes. No DOM:
// importable by the page, the worker and node. No geometry: the references are the kernel's
// (`face_ref` / `edge_ref`), and a face's frame is what the document's own `frame.on_face`
// node evaluates to.
//
// Item `n`'s body is its head node `i<n>`, or, for a held body (`forge-model.js`'s `heldOf`),
// the foreign node it is (`item.node`). A face of body `b` used as a plane is the shared
// `frame.on_face` node `f<b>_<k>` (the node layout in forge-model.js's header).
//
//   faceRefLit(a) / edgeRefLit(a)           a kernel reference's doubles as the JSON a node holds
//   faceRefOf(kernel, solid, f)             face `f` of a solid handle as a reference that finds
//                                           it again, or refused
//   edgeRefOf(kernel, solid, e)             the same for edge `e` (`cadaclysm_blacksmith::edges`
//                                           numbers, as `edge_count` / `edge_ref` index them)
//   pickRefs(kernel, solid, faces, indices) references to faces or edges of a solid handle
//   documentPickRefs(kernel, doc, id, kind, indices)   the same off node `id`'s solid, the
//                                           document evaluated first: what the worker answers
//                                           a pick with
//   bodyNode(model, n)                      the node item `n`'s body is (`i<n>`, or a held
//                                           item's own node); undefined for no body item
//   docPicks(kernel, doc, model?)           the geometry a command may ask of a document:
//                                           `{ kernel, edgeRef(n, k), faceRef(n, k),
//                                           faceFrame(n, k) }` (faceFrame needs the model),
//                                           and off any node's result: `nodeFaceRef(id, k)`,
//                                           `findFace(id, ref8, hint)` (the face the page's
//                                           own eight-number reference finds, -1 none),
//                                           `frameValue(id)` (a frame node's twelve numbers);
//                                           a node with no result yet: "`id` has not been built"
//   faceFrames(kernel, doc, model, wanted, solids?)   per `{ body, face }` of `wanted`, the
//                                           twelve doubles (origin, x, y, z) its `frame.on_face`
//                                           `f<body>_<face>` evaluates to, or null where it has
//                                           none (not flat, no area, no reference); one probe
//
// `faceFrames` reads each body's solid as the document last evaluated it (evaluating the
// document once when one has no result yet), or from `solids` (a Map body -> a solid handle
// the caller owns). The frames come off ONE `document_probe`: a `frame.on_face` node per
// wanted face (`add`ed, or `set` to the face's reference where the document has that node
// already), read with `document_value` while the probe is open, then `document_probe_end` --
// also when a read throws. The document's state, history and revision are untouched. A probe
// the kernel refuses (a batch, a preview or another probe open) is thrown, and ends nothing.
//
// An error is thrown as an `Error` in the kernel's words.
import { headId } from "./forge-model.js";

/// How far a reference may be from the face or edge it names, as a node looks it up (the
/// Rust `kind::REF_TOLERANCE`).
const REF_TOLERANCE = 1e-6;
/// How far the page's own face reference (eight numbers: a shell's `openRefs`, a face item's
/// `ref`) may be from the face it finds (the 0.14 layer's `FORGE_REF_TOLERANCE`).
const PAGE_REF_TOLERANCE = 1e-3;

const fail = (why) => { throw new Error(why); };

/// One kernel call; its refusal (a bare string off the wasm) an `Error` in the Rust's words,
/// the export's own `<what>: ` taken off.
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

/// Node `id`'s solid or sheet as a new handle (free it), or undefined where it has none.
function resultSolid(kernel, doc, id) {
    const kind = call(kernel, "cadaclysm_blacksmith_document_result_kind", doc, id);
    return kind === "solid" || kind === "sheet" ? call(kernel, "cadaclysm_blacksmith_document_result_solid", doc, id) : undefined;
}

/// `f` on node `id`'s solid handle, freed after; `none()` where it has none.
function withSolid(kernel, doc, id, f, none) {
    const s = resultSolid(kernel, doc, id);
    if (s === undefined) return none();
    try {
        return f(s);
    } finally {
        call(kernel, "cadaclysm_blacksmith_solid_free", s);
    }
}

// ---------------------------------------------------------------------------------
// References.

const vec = (a, at) => [a[at], a[at + 1], a[at + 2]];

/// A face reference (the kernel's eight doubles: kind, at, normal, extent) as a node's
/// field holds it (the Rust `refs::face_ref_lit`).
export const faceRefLit = (a) => ({ surface: a[0], at: vec(a, 1), normal: vec(a, 4), extent: a[7] });

/// An edge reference (fifteen doubles: kind, mid, tangent, length, the two faces' normals,
/// span) as a node's field holds it (`refs::edge_ref_lit`).
export const edgeRefLit = (a) => ({ curve: a[0], mid: vec(a, 1), tangent: vec(a, 4), length: a[7], faces: [vec(a, 8), vec(a, 11)], span: a[14] });

/// Face `f`'s reference -- one that finds `f` again, as a node will look it up.
export function faceRefOf(kernel, solid, f) {
    const gone = `face ${f} is not on the solid`;
    if (!(f < call(kernel, "cadaclysm_blacksmith_face_count", solid))) fail(gone);
    let a;
    try {
        a = call(kernel, "cadaclysm_blacksmith_face_ref", solid, f);
    } catch {
        fail(gone);
    }
    const k = call(kernel, "cadaclysm_blacksmith_find_face", solid, a, -1, REF_TOLERANCE);
    if (k !== f) fail(`face ${f} cannot be told apart by its reference (it finds ${k < 0 ? "none" : `face ${k}`})`);
    return faceRefLit(Array.from(a));
}

/// Edge `e`'s reference -- one that finds `e` again (edges as `cadaclysm_blacksmith::edges`
/// numbers them, which `edge_count` / `edge_ref` index).
export function edgeRefOf(kernel, solid, e) {
    const gone = `edge ${e} is not on the solid`;
    if (!(e < call(kernel, "cadaclysm_blacksmith_edge_count", solid))) fail(gone);
    let a;
    try {
        a = call(kernel, "cadaclysm_blacksmith_edge_ref", solid, e);
    } catch {
        fail(gone);
    }
    const k = call(kernel, "cadaclysm_blacksmith_find_edge", solid, a, REF_TOLERANCE);
    if (k !== e) fail(`edge ${e} cannot be told apart by its reference (it finds ${k < 0 ? "none" : `edge ${k}`})`);
    return edgeRefLit(Array.from(a));
}

/// References (as `faceRefs` / `edgeRefs` hold them) to faces (`faces`: B-rep face
/// indices) or edges (`cadaclysm_blacksmith::edges` numbers) of a solid handle. Each finds
/// its face or edge again, or the pick is refused.
export function pickRefs(kernel, solid, faces, indices) {
    return Array.from(indices, (k) => (faces ? faceRefOf(kernel, solid, k) : edgeRefOf(kernel, solid, k)));
}

/// `pickRefs` off node `id`'s solid, the document evaluated first (`kind` "edges" or
/// "faces"): what the worker answers a pick with.
export function documentPickRefs(kernel, doc, id, kind, indices) {
    if (kind !== "faces" && kind !== "edges") fail(`kind \`${kind}\` is not \`edges\` or \`faces\``);
    call(kernel, "cadaclysm_blacksmith_document_evaluate", doc, false);
    return withSolid(kernel, doc, id, (s) => pickRefs(kernel, s, kind === "faces", indices), () => fail(`\`${id}\` has no solid (not a node, or it failed to build)`));
}

/// The node item `n`'s body is: its head `i<n>`, or a held item's own node. Without a model,
/// `i<n>`. Undefined where the model has no item `n`.
export function bodyNode(model, n) {
    if (!model) return headId(n);
    const item = model.item(n);
    if (!item) return undefined;
    return item.of !== undefined ? item.node : headId(n);
}

/// The geometry a command may ask of a document: item `n`'s solid is its body node's
/// (`bodyNode`), as the document last evaluated it. Without a model (the 0.14 layer's
/// callers) item `n` is `i<n>`, and a face's frame is refused (its `frame.on_face` node's).
export function docPicks(kernel, doc, model) {
    const body = (n, f) => {
        const id = bodyNode(model, n);
        if (id === undefined) fail(`#${n} is not an item`);
        return withSolid(kernel, doc, id, f, () => fail(`#${n} has not been built`));
    };
    const onNode = (id, f) => withSolid(kernel, doc, id, f, () => fail(`\`${id}\` has not been built`));
    return {
        kernel,
        faceFrame: (n, k) => {
            if (!model) fail(`the frame of a face of #${n} is its \`frame.on_face\` node's`);
            const [frame] = faceFrames(kernel, doc, model, [{ body: n, face: k }]);
            return frame ?? fail(`face ${k} of #${n} has no frame (not flat, or not on the solid)`);
        },
        edgeRef: (n, index) => body(n, (s) => edgeRefOf(kernel, s, index)),
        faceRef: (n, index) => body(n, (s) => faceRefOf(kernel, s, index)),
        nodeFaceRef: (id, index) => onNode(id, (s) => faceRefOf(kernel, s, index)),
        findFace: (id, ref, hint) => onNode(id, (s) => call(kernel, "cadaclysm_blacksmith_find_face", s, Float64Array.from(ref), hint, PAGE_REF_TOLERANCE)),
        frameValue: (id) => {
            if (call(kernel, "cadaclysm_blacksmith_document_result_kind", doc, id) === "none") fail(`\`${id}\` has not been built`);
            return JSON.parse(call(kernel, "cadaclysm_blacksmith_document_value", doc, id));
        },
    };
}

// ---------------------------------------------------------------------------------
// Face frames.

/// The face plane node of face `k` of body item `b`.
export const facePlaneId = (b, k) => `f${b}_${k}`;

/// Per entry `{ body, face }` of `wanted` (body: an item id, face: a B-rep face index of its
/// solid), the frame its face plane `f<body>_<face>` evaluates to -- twelve doubles, origin,
/// x, y, z -- or null where it has none. See the header: one probe, ended always.
export function faceFrames(kernel, doc, model, wanted, solids) {
    const out = wanted.map(() => null);
    // The reference of each wanted face, off its body's solid: [fid, node, ref] once per fid.
    const planes = new Map();
    let evaluated = false;
    const refsOf = (b, node, faces) => {
        const read = (s) => faces.map((k) => {
            try { return faceRefLit(Array.from(call(kernel, "cadaclysm_blacksmith_face_ref", s, k))); } catch { return null; }
        });
        const given = solids?.get(b);
        if (given !== undefined) return read(given);
        if (!evaluated && call(kernel, "cadaclysm_blacksmith_document_result_kind", doc, node) === "none") {
            call(kernel, "cadaclysm_blacksmith_document_evaluate", doc, false);
            evaluated = true;
        }
        return withSolid(kernel, doc, node, read, () => faces.map(() => null));
    };
    const byBody = new Map();
    wanted.forEach(({ body: b, face: k }) => {
        if (!Number.isInteger(k) || k < 0) return;
        if (!byBody.has(b)) byBody.set(b, new Set());
        byBody.get(b).add(k);
    });
    for (const [b, set] of byBody) {
        const node = bodyNode(model, b);
        if (node === undefined) fail(`#${b} is not an item`);
        const faces = [...set];
        refsOf(b, node, faces).forEach((ref, i) => {
            if (ref) planes.set(facePlaneId(b, faces[i]), { node, ref });
        });
    }
    if (!planes.size) return out;
    const ops = [...planes].map(([id, { node, ref }]) => (model?.node(id)
        ? { op: "set", id, fields: { solid: node, face: ref } }
        : { op: "add", node: { id, kind: "frame.on_face", solid: node, face: ref } }));
    const ids = [...planes.keys()];
    call(kernel, "cadaclysm_blacksmith_document_probe", doc, JSON.stringify({ op: "batch", ops }), JSON.stringify(ids));
    try {
        const frames = new Map();
        for (const id of ids) {
            try {
                const v = JSON.parse(call(kernel, "cadaclysm_blacksmith_document_value", doc, id));
                if (Array.isArray(v) && v.length === 12 && v.every(Number.isFinite)) frames.set(id, v);
            } catch { /* this face has no frame */ }
        }
        wanted.forEach(({ body: b, face: k }, i) => { out[i] = frames.get(facePlaneId(b, k)) ?? null; });
        return out;
    } finally {
        call(kernel, "cadaclysm_blacksmith_document_probe_end", doc);
    }
}
