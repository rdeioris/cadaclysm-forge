// Forge commands as document ops: a port of the Rust `forge::convert` and `forge::trim_ghost`
// in the kernel's forge layer, so the forge runs on
// the public kernel build. No DOM: importable by the page, the worker and node.
//
// `command` is one forge command on a document: the items read off its nodes (`itemsOf`),
// the command (`applyCommand`), the picks it made resolved to references, the items
// written as nodes again (`nodesOf`), and the difference applied as one batch op -- one
// commit, the batch returned so a replica can apply the very same op.
//
// # The kernel
//
// Everything geometric comes through `kernel`, an object the caller hands in: the public
// exports of the standard kernel build (pass the wasm module itself), never a `forge_*`
// one. The same object serves forge-doc-curves.js's run functions (a sketch fillet, a
// body's pivot). Documents are its handles:
//
//   cadaclysm_blacksmith_document_save / _load / _apply / _evaluate / _result_kind /
//     _result_solid / _kinds, and _preview_begin / _preview / _end_preview
//   cadaclysm_blacksmith_face_count / _face_ref / _find_face, _edge_count / _edge_ref /
//     _find_edge, _solid_free
//
// # Picks
//
// Forge names faces and edges by index; a document by reference. An item's pick is
// resolved when it is made -- the item is new, or the command changed its indices without
// giving references of its own -- against the solid it is picked on as the document builds
// it right then: the command's nodes evaluated on a scratch state. The scratch state is a
// preview on the document itself (`_preview_begin`, the diff to the command's nodes
// `_preview`ed, `_evaluate`, the results read, `_end_preview`): what is unchanged is not
// computed again, as the Rust's evaluation on a copy of the document's cache, and the
// document's state is as it was after. Unlike the Rust, the document's cache keeps what the
// scratch evaluation computed (results the next evaluation would compute anyway), and its
// last statuses are the scratch ones until it is evaluated again.
//
// - an item's picks keep their references in its own `faceRefs` / `edgeRefs`: a fillet's
//   edges, a shell's open faces, a trim's dropped faces, a face item's face, a face
//   sketch's face and a mid sketch's face planes. Press, refillet, rechamfer and remove
//   read theirs off their face items.
// - a face plane `face:<b>:<k>` keeps its reference in `Items.planes`, resolved the first
//   time a node uses it.
//
// Every index is the solid's B-rep face index (the kernel's for what the kernel takes) or
// its `cadaclysm_blacksmith::edges` number -- face planes and face sketches too. (The Rust
// maps a face plane's index through the GPU pack's faces, which skip a face of no area;
// the public View numbers faces the B-rep's way.) Where the page kept its own reference to
// a face (a shell's `openRefs`, a face item's `ref`, eight numbers), the face is found by
// it on the unmoved solid first. A version-2 file's fillet numbering (`edgeNumbering: 1`)
// is not mapped: its indices are taken as today's.
//
// A pick that resolves to nothing -- an index the solid has no face or edge at, a source
// that does not build -- refuses the command. Nothing is guessed. One exception keeps the
// item as its `forge.broken_<type>`: the pick of an item that was a stand-in already. A
// face plane that cannot be resolved breaks the items that stand on it. A stand-in's pick
// is never resolved from the indices it kept: it stays a stand-in until a command picks
// for it afresh.
//
//   command(kernel, doc, cmd)               { changed, op }: the command committed
//   commandOp(kernel, doc, cmd)             the batch op it would commit, nothing applied
//   commandNodes(kernel, doc, cmd)          { batch, nodes }: that op, and the nodes it
//                                           leaves the document with (`itemsOf` reads them)
//   commandNeedsGeometry(kernel, doc, cmd)  whether it needs built geometry to become a batch
//   adopt(kernel, doc)                      another app's held nodes given forge's: the op, or null
//   openDocument(kernel, text)              a document handle: the text loaded, then adopted
//   trimGhost(kernel, doc, id)              a solid handle (free it): the trim's split pieces
//                                           under its move, nothing dropped
//   faceFrames(kernel, doc, id, solid, faces)   per face of node `id`'s solid (`solid`, its
//                                           handle) the frame the document's `frame.on_face`
//                                           gives it (twelve doubles), or null where it has none
//   pickRefs(kernel, solid, faces, indices) references to faces or edges of a solid handle
//   documentPickRefs(kernel, doc, id, kind, indices)   the same off node `id`'s solid
//   docPicks(kernel, doc)                   the env (forge-doc-commands.js) over a document
//   faceRefLit(a) / edgeRefLit(a)           a kernel reference's doubles as the JSON a node holds
//   toJson(v)                               JSON text as the kernel reads it (a -0 kept)
//
// `cmd` is the page's command; it crosses as JSON does (an `undefined` key is no key). An
// error is thrown as an `Error` with the Rust's words.
import { get, put, remove, clone, litEq, isMap, idOf, kindOf, isBody, isSketch, U32_MAX } from "./forge-doc-items.js";
import { itemsOf, nodesOf, registryOf, facePlaceholder, isPlaceholder, isFacePlaneId, nodeFromLit } from "./forge-doc-nodes.js";
import { applyCommand } from "./forge-doc-commands.js";
import { sourcePivot, loopsCurves } from "./forge-doc-curves.js";

/// How far a reference may be from the face or edge it names, as a node looks it up (the
/// Rust `kind::REF_TOLERANCE`).
const REF_TOLERANCE = 1e-6;
/// How far a face may be from where the page's own reference says (forge's old recipe.js
/// `FACE_REF_TOLERANCE`).
const FORGE_REF_TOLERANCE = 1e-3;

/// The reason of a stand-in whose pick was never resolved, once what it was picked on
/// builds: the file's indices are never taken against today's solid.
const PICK_AGAIN = "make this pick again on the page: it could not be resolved when the file was opened";

const fail = (why) => { throw new Error(why); };

// ---------------------------------------------------------------------------------
// The kernel.

const registries = new WeakMap();
/// The kinds the nodes are checked against, read once per kernel.
function registryFor(kernel) {
    let r = registries.get(kernel);
    if (!r) {
        r = registryOf(call(kernel, "cadaclysm_blacksmith_document_kinds"));
        registries.set(kernel, r);
    }
    return r;
}

/// One kernel call; its refusal (a bare string off the wasm) an `Error` in the Rust's
/// words, the export's own `<what>: ` taken off.
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

/// JSON text as the kernel's reader takes it: `JSON.stringify`, but a negative zero is
/// written `-0.0` (as the document writes it) rather than `0`.
export function toJson(v) {
    if (typeof v === "number") return Object.is(v, -0) ? "-0.0" : JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : toJson(x))).join(",")}]`;
    if (isMap(v)) return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${toJson(x)}`).join(",")}}`;
    return JSON.stringify(v) ?? "null";
}

/// The document as it is saved: `{ units, params, nodes, ... }`.
/// The document's save, parsed, and its items (`itemsOf`), kept while the save's text stays
/// the same: a commit reads them three times over (the page's `commandNeedsGeometry`, then
/// `command`, then its items again), and parsing a long document costs more than saving it.
/// Read-only: callers clone what they change.
let lastSave = { kernel: null, text: null, state: null, items: null };
function savedState(kernel, doc) {
    const text = call(kernel, "cadaclysm_blacksmith_document_save", doc);
    if (lastSave.kernel !== kernel || lastSave.text !== text) lastSave = { kernel, text, state: JSON.parse(text), items: null };
    return lastSave;
}
// The items only where asked: `itemsOf` refuses some documents that are read for their nodes.
function savedWithItems(kernel, doc) {
    const s = savedState(kernel, doc);
    s.items ??= itemsOf(s.state);
    return s;
}
const saved = (kernel, doc) => savedState(kernel, doc).state;

/// The nodes `commandNeedsGeometry` made for a command that needs no geometry, kept for the
/// `command` that follows it on the same document text: the page asks one, then runs the other.
let lastPlan = null;

/// The document's items, as `itemsOf` its save gives them. Read-only (`toLit` and `clone`
/// copy).
export function documentItems(kernel, doc) {
    return savedWithItems(kernel, doc).items;
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
function faceRefOf(kernel, solid, f) {
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
function edgeRefOf(kernel, solid, e) {
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

/// The geometry `applyCommand` may ask of a document: item `n`'s solid is node `i<n>`'s,
/// as the document last evaluated it.
export function docPicks(kernel, doc) {
    const body = (n, f) => withSolid(kernel, doc, `i${n}`, f, () => fail(`#${n} has not been built`));
    return {
        kernel,
        sourcePivot: (items, loops) => sourcePivot(kernel, loopsCurves(items, loops)),
        faceFrame: (n) => fail(`the frame of a face of #${n} is its \`frame.on_face\` node's`),
        edgeRef: (n, index) => body(n, (s) => edgeRefOf(kernel, s, index)),
        faceRef: (n, index) => body(n, (s) => faceRefOf(kernel, s, index)),
    };
}

// ---------------------------------------------------------------------------------
// The picks.
//
// A group is one pick: where its references go (`target`: `{ item, key }`, a list field
// of an item, or `{ plane }`, a face plane's node id), what it was made of (`sig`: when
// that changes the references are made again), and per entry the node it is picked on
// and what (`want`): `{ face, forge? }` a face by its B-rep index, `forge` the page's own
// reference to it; `{ edges }` fillet edges; `{ nothing: true }` a mid sketch's plane that
// is not a face of a body.

const index = idOf;

function indices(l) {
    if (!Array.isArray(l)) return undefined;
    const out = l.map(index);
    return out.includes(undefined) ? undefined : out;
}

/// The page's own face reference: eight finite numbers, the kind not -1.
function forgeRef(l) {
    if (!Array.isArray(l) || l.length !== 8 || !l.every((x) => typeof x === "number" && Number.isFinite(x))) return undefined;
    return l[0] >= 0 ? l.slice() : undefined;
}

/// The node a made body's first part is: item `i<p>`, or a version-1 frozen part.
function firstPart(base, c) {
    const p = get(c, "parts");
    if (!Array.isArray(p)) return undefined;
    if (isMap(p[0])) return `${base}_p0`;
    const id = idOf(p[0]);
    return id === undefined ? undefined : `i${id}`;
}

function sigKeys(c) {
    if (isSketch(c)) return ["mode", "face", "mid"];
    switch (kindOf(c)) {
        case "fillet": return ["parts", "edges", "edgeNumbering"];
        case "shell": return ["parts", "open", "openRefs"];
        case "trim": return ["parts", "drop"];
        case "face": return ["parts", "face", "ref"];
        default: return [];
    }
}

/// What an item's pick is made of: when one of these fields changes, its references are
/// made again.
const sigOf = (c) => sigKeys(c).map((k) => clone(get(c, k) ?? null));

/// Whether `cmd` picks for item `id` (`c` its fields) afresh: it names the item and one of
/// the fields its pick (or its face plane) is made of.
const repicked = (cmd, id, c) => idOf(get(cmd, "id")) === id && [...sigKeys(c), "plane"].some((k) => get(cmd, k) !== undefined);

/// The picks the items make (a face plane's are the nodes', see `planeGroups`).
function groupsOf(items) {
    const out = [];
    const body = (id) => (id !== undefined && items.get(id) && isBody(items.get(id).fields) ? id : undefined);
    for (const it of items.items) {
        const c = it.fields, base = `i${it.id}`;
        const target = (key) => ({ item: it.id, key });
        if (isSketch(c)) {
            const mode = get(c, "mode");
            if (mode === "face") {
                const f = get(c, "face");
                const b = body(idOf(get(f, "body"))), k = index(get(f, "index"));
                if (b !== undefined && k !== undefined) out.push({ target: target("faceRefs"), sig: sigOf(c), entries: [[`i${b}`, { face: k }]] });
            } else if (mode === "mid") {
                const mid = get(c, "mid");
                if (!Array.isArray(mid) || mid.length !== 2 || !mid.some(isMap)) continue;
                const entries = mid.map((r) => {
                    if (!isMap(r)) return ["", { nothing: true }];
                    const b = body(idOf(get(r, "body"))), k = index(get(r, "index"));
                    return b === undefined || k === undefined ? undefined : [`i${b}`, { face: k }];
                });
                if (!entries.includes(undefined)) out.push({ target: target("faceRefs"), sig: sigOf(c), entries });
            }
            continue;
        }
        if (!isBody(c)) continue;
        switch (kindOf(c)) {
            case "fillet": {
                const src = firstPart(base, c), edges = indices(get(c, "edges"));
                if (src !== undefined && edges !== undefined) out.push({ target: target("edgeRefs"), sig: sigOf(c), entries: [[src, { edges }]] });
                break;
            }
            case "shell": {
                const src = firstPart(base, c), open = indices(get(c, "open"));
                if (src === undefined || open === undefined) break;
                const r = get(c, "openRefs"), refs = Array.isArray(r) ? r : [];
                out.push({ target: target("faceRefs"), sig: sigOf(c), entries: open.map((k, i) => [src, { face: k, forge: forgeRef(refs[i]) }]) });
                break;
            }
            case "trim": {
                const drop = indices(get(c, "drop"));
                if (drop !== undefined) out.push({ target: target("faceRefs"), sig: sigOf(c), entries: drop.map((k) => [`${base}_split`, { face: k }]) });
                break;
            }
            case "face": {
                const src = firstPart(base, c), k = index(get(c, "face"));
                if (src !== undefined && k !== undefined) out.push({ target: target("faceRefs"), sig: sigOf(c), entries: [[src, { face: k, forge: forgeRef(get(c, "ref")) }]] });
                break;
            }
        }
    }
    return out;
}

/// The face planes the nodes (file form) use that have no reference yet.
function planeGroups(nodes) {
    const out = [];
    for (const nd of nodes) {
        if (nd.kind !== "frame.on_face" || !isFacePlaneId(nd.id)) continue;
        const face = get(nd, "face");
        if (face === undefined || !isPlaceholder(face)) continue;
        const [b, k] = nd.id.slice(1).split("_");
        out.push({ target: { plane: nd.id }, sig: null, entries: [[`i${b}`, { face: Number(k) }]] });
    }
    return out;
}

/// The item picks to resolve now: an item's pick with no references, or whose indices the
/// command changed while leaving its references as they were.
function pending(old, now) {
    return groupsOf(now).filter((g) => {
        if (!isItemTarget(g)) return true;
        const { item: id, key } = g.target;
        const cur = get(now.get(id)?.fields, key);
        if (cur === undefined) return true;
        const was = old.get(id);
        if (!was) return false;
        // Unchanged indices keep their references; changed indices with the references
        // the command gave keep those.
        const wasRefs = get(was.fields, key);
        return !litEq(sigOf(was.fields), g.sig) && wasRefs !== undefined && litEq(wasRefs, cur);
    });
}

const isItemTarget = (g) => g.target.plane === undefined;

/// Why `src` has no body in the scratch evaluation (`statuses`, the kernel's rows).
function whyNot(src, statuses) {
    const st = statuses.find((s) => s.id === src);
    if (!st) return `there is no ${src}`;
    if (st.state === "error") return `${src} does not build: ${st.error}`;
    if (st.state === "blocked") {
        const b = st.by, bs = statuses.find((s) => s.id === b);
        // The step of its own build that failed: its reason.
        if (bs?.state === "error" && b.startsWith(`${src}_`)) return `${src} does not build: ${bs.error}`;
        return `${src} does not build: blocked by ${b}`;
    }
    return `${src} is not a body`;
}

/// The references of a pick's entries, off the scratch evaluation: `{ refs }`, or why not
/// yet -- its source has not built (`{ wait }`, which a later round may change) or it
/// never will (`{ fail }`).
function resolve(kernel, doc, ids, statuses, g) {
    const out = [];
    for (const [src, want] of g.entries) {
        if (want.nothing) {
            out.push(null);
            continue;
        }
        if (want.edges && want.edges.length === 0) continue;
        const solid = resultSolid(kernel, doc, src);
        if (solid === undefined) return { wait: whyNot(src, statuses) };
        try {
            if (want.edges) {
                for (const e of want.edges) out.push(edgeRefOf(kernel, solid, e));
            } else {
                let at = want.face;
                if (want.forge) {
                    const unmoved = [`${src}_flush`, `${src}_inner`].find((id) => ids.has(id)) ?? src;
                    const on = resultSolid(kernel, doc, unmoved);
                    if (on === undefined) return { wait: `${unmoved} does not build` };
                    try {
                        const hint = want.face <= 0x7fffffff ? want.face : -1;
                        at = call(kernel, "cadaclysm_blacksmith_find_face", on, Float64Array.from(want.forge), hint, FORGE_REF_TOLERANCE);
                    } finally {
                        call(kernel, "cadaclysm_blacksmith_solid_free", on);
                    }
                    if (at < 0) return { fail: `the face (${want.face + 1} when it was picked) is no longer on the solid` };
                }
                out.push(faceRefOf(kernel, solid, at));
            }
        } catch (e) {
            return { fail: e.message };
        } finally {
            call(kernel, "cadaclysm_blacksmith_solid_free", solid);
        }
    }
    return { refs: out };
}

function write(items, g, refs) {
    if (isItemTarget(g)) {
        const it = items.get(g.target.item);
        if (it) put(it.fields, g.target.key, refs);
    } else items.planes.set(g.target.plane, refs.length ? refs[0] : facePlaceholder());
}

/// The fields of a node in file form: every key but the node's own.
const fieldsOf = (nd) => Object.entries(nd).filter(([k]) => !["id", "kind", "name", "hidden", "meta"].includes(k));

/// Whether `l` is the string `id`, at any depth.
function names(l, id) {
    if (typeof l === "string") return l === id;
    if (Array.isArray(l)) return l.some((x) => names(x, id));
    if (isMap(l)) return Object.values(l).some((x) => names(x, id));
    return false;
}

/// The items a pick's references are for: its own item, or the items whose nodes stand on
/// a face plane.
function readers(g, nodes) {
    if (isItemTarget(g)) return [g.target.item];
    const out = new Set();
    for (const nd of nodes) {
        if (!fieldsOf(nd).some(([, v]) => names(v, g.target.plane))) continue;
        if (!nd.id.startsWith("i")) continue;
        const digits = nd.id.slice(1).split("_")[0];
        if (!/^\+?[0-9]+$/.test(digits) || Number(digits) > U32_MAX) continue;
        out.add(Number(digits));
    }
    return [...out].sort((a, b) => a - b);
}

/// Items `ids` as stand-ins for why `g` cannot be resolved. An item's own pick loses its
/// references: the next command resolves it again (it may build by then).
function standIn(items, g, ids, why) {
    if (isItemTarget(g)) {
        const it = items.get(g.target.item);
        if (it) remove(it.fields, g.target.key);
    }
    for (const id of ids) if (!items.broken.has(id)) items.broken.set(id, why);
}

/// Resolves the picks the command made: the items' nodes evaluated on the scratch state
/// (a preview the caller opened), each pick's references taken off its source, again
/// while that makes progress (a `state` command picks on parts made in the same command).
/// A pick that cannot be resolved refuses the command, unless its items were stand-ins
/// already: then they are stand-ins (`Items.broken`) with the reason. A stand-in's pick is
/// never resolved from the indices it kept, even once its source builds: it stays a
/// stand-in (`PICK_AGAIN`) until a command picks for it afresh. The items' nodes, every
/// pick written.
function resolvePicks(kernel, doc, docNodes, registry, cmd, old, items) {
    const brokenNow = new Set(docNodes.filter((n) => n.kind.startsWith("forge.broken_")).map((n) => n.id));
    const wasBroken = (id) => brokenNow.has(`i${id}`);
    const mayBreak = (ids) => ids.length > 0 && ids.every(wasBroken);
    // The stand-ins this command does not pick for afresh.
    const waits = new Set(items.items.filter((it) => wasBroken(it.id) && !repicked(cmd, it.id, it.fields)).map((it) => it.id));
    let groups = pending(old, items);
    for (;;) {
        const nodes = nodesOf(items, registry);
        const planes = planeGroups(nodes);
        if (!groups.length && !planes.length) return nodes;
        // The command's nodes as a preview frame on the document, evaluated.
        call(kernel, "cadaclysm_blacksmith_document_preview", doc, toJson(diff(docNodes, nodes)));
        const statuses = JSON.parse(call(kernel, "cadaclysm_blacksmith_document_evaluate", doc, false));
        const ids = new Set(nodes.map((n) => n.id));
        let progress = false, failed;
        const waiting = [], missed = [];
        for (const g of [...groups, ...planes]) {
            const r = resolve(kernel, doc, ids, statuses, g);
            if (r.refs) {
                const who = readers(g, nodes);
                if (who.length && who.every((id) => waits.has(id))) standIn(items, g, who, PICK_AGAIN);
                else write(items, g, r.refs);
                progress = true;
            } else if (r.wait !== undefined) {
                missed.push([g, readers(g, nodes), r.wait]);
                if (isItemTarget(g)) waiting.push(g);
            } else {
                const who = readers(g, nodes);
                if (!mayBreak(who)) {
                    failed = r.fail;
                    break;
                }
                standIn(items, g, who, r.fail);
                progress = true;
            }
        }
        if (failed !== undefined) fail(failed);
        if (!progress) {
            // Nothing more will build: the picks still waiting are stand-ins where they
            // may be, else the command is refused.
            if (!missed.length) fail("a pick cannot be resolved");
            const stuck = missed.find(([, who]) => !mayBreak(who));
            if (stuck) fail(stuck[2]);
            const why = missed[0][2], before = items.broken.size;
            for (const [g, who, w] of missed) standIn(items, g, who, w);
            if (items.broken.size === before) fail(why);
        }
        groups = waiting.filter((g) => readers(g, []).every((id) => !items.broken.has(id)));
    }
}

// ---------------------------------------------------------------------------------
// The batch.

/// The fields of `b` that differ from `a`'s (nodes as `nodeFromLit` reads them), as a
/// `set` takes them: a field gone is `null`.
function fieldDiff(a, b) {
    const out = [];
    if (a.name !== b.name) out.push(["name", b.name ?? null]);
    if (a.hidden !== b.hidden) out.push(["hidden", b.hidden]);
    if (!litEq(a.meta ?? null, b.meta ?? null)) out.push(["meta", clone(b.meta ?? null)]);
    for (const [k, v] of b.fields) {
        const was = a.fields.find(([ak]) => ak === k);
        if (!was || !litEq(was[1], v)) out.push([k, clone(v)]);
    }
    for (const [k] of a.fields) if (!b.fields.some(([bk]) => bk === k)) out.push([k, null]);
    const fields = {};
    for (const [k, v] of out) put(fields, k, v);
    return fields;
}

/// The Rust `Node`'s equality: fields in order.
const nodeEq = (a, b) =>
    a.id === b.id && a.kind === b.kind && a.name === b.name && a.hidden === b.hidden && litEq(a.meta ?? null, b.meta ?? null) &&
    a.fields.length === b.fields.length && a.fields.every(([k, v], i) => k === b.fields[i][0] && litEq(v, b.fields[i][1]));

/// The batch that turns the nodes `old` into `new` (file form): the nodes of `old` not
/// kept (the longest run of nodes both have in the same order, by id and kind) removed in
/// reverse order, then in `new`'s order each kept node's changed fields set and each other
/// node added at its place.
function diff(old, now, message) {
    const n = old.length, m = now.length;
    const same = (i, j) => old[i].id === now[j].id && old[i].kind === now[j].kind;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const keptOld = new Array(n).fill(false), keptNew = new Array(m).fill(-1);
    for (let i = 0, j = 0; i < n && j < m;) {
        if (same(i, j)) {
            keptOld[i] = true;
            keptNew[j] = i;
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
        else j++;
    }
    const ops = [];
    for (let i = n - 1; i >= 0; i--) if (!keptOld[i]) ops.push({ op: "remove", id: old[i].id });
    now.forEach((nd, j) => {
        const i = keptNew[j];
        if (i < 0) ops.push({ op: "add", node: clone(nd), at: j });
        else {
            const a = nodeFromLit(old[i]), b = nodeFromLit(nd);
            if (!nodeEq(a, b)) ops.push({ op: "set", id: nd.id, fields: fieldDiff(a, b) });
        }
    });
    const out = { op: "batch", ops };
    if (message !== undefined) out.message = message;
    return out;
}

function holdsPlaceholder(l) {
    if (isMap(l)) return isPlaceholder(l);
    if (Array.isArray(l)) return l.some(holdsPlaceholder);
    return false;
}

function opOf(cmd) {
    const o = get(cmd, "op");
    return typeof o === "string" ? o : "";
}

/// The command as the kernel would read it off the page's JSON.
const asJson = (cmd) => JSON.parse(JSON.stringify(cmd) ?? "null");

/// `cmd` on `doc`'s items: the batch from its nodes to the command's, and those nodes.
/// Refused while a batch or a sticky preview is open (`_preview_begin` refuses then).
export function commandNodes(kernel, doc, cmd) {
    cmd = asJson(cmd);
    const registry = registryFor(kernel);
    call(kernel, "cadaclysm_blacksmith_document_preview_begin", doc);
    try {
        const { state, items: old, text } = savedWithItems(kernel, doc);
        const plan = lastPlan;
        lastPlan = null;
        let nodes;
        if (plan && plan.kernel === kernel && plan.text === text && plan.cmd === toJson(cmd)) {
            nodes = plan.nodes;   // `commandNeedsGeometry` made them, and found no pick to resolve
        } else {
            const items = old.clone();
            applyCommand(items, cmd, docPicks(kernel, doc));
            nodes = resolvePicks(kernel, doc, state.nodes, registry, cmd, old, items);
        }
        const bad = nodes.find((nd) => fieldsOf(nd).some(([, v]) => holdsPlaceholder(v)));
        if (bad) fail(`${bad.id}: a pick has no reference`);
        return { batch: diff(state.nodes, nodes, `forge: ${opOf(cmd)}`), nodes };
    } finally {
        call(kernel, "cadaclysm_blacksmith_document_end_preview", doc);
    }
}

/// One forge command on a forge document, as one commit (`"forge: <op>"`): see the module
/// header. `{ changed, op }`: what changed (the kernel's set) and the batch, which a
/// replica applies as it is. Refused while a batch or a preview is open: the page ends a
/// drag's preview before it sends a forge command.
export function command(kernel, doc, cmd) {
    const { batch } = commandNodes(kernel, doc, cmd);
    const changed = JSON.parse(call(kernel, "cadaclysm_blacksmith_document_apply", doc, toJson(batch), undefined));
    return { changed, op: batch };
}

/// The batch `command` would commit for `cmd`, nothing applied: what a drag frame previews.
/// Refused as `command` is.
export function commandOp(kernel, doc, cmd) {
    return commandNodes(kernel, doc, cmd).batch;
}

/// Whether `cmd` needs built geometry to become a batch: a pick it made without its
/// references, or a face plane new to the document. The page asks this to send such a
/// command to its worker, whose replica is evaluated already.
export function commandNeedsGeometry(kernel, doc, cmd) {
    cmd = asJson(cmd);
    const { items: old, text } = savedWithItems(kernel, doc);
    const items = old.clone();
    applyCommand(items, cmd, docPicks(kernel, doc));
    const nodes = nodesOf(items, registryFor(kernel));
    const needs = pending(old, items).length > 0 || planeGroups(nodes).length > 0;
    lastPlan = needs ? null : { kernel, text, cmd: toJson(cmd), nodes };
    return needs;
}

/// Another app's document made forge's: where a held node is an item that has no node of
/// its own yet (`itemsOf` lists it, nothing reads it as `i<n>`), every such item's nodes
/// written as one commit (`"forge: open"`), the batch returned; `null` where there is
/// nothing to write. Forge's own documents are never touched.
export function adopt(kernel, doc) {
    const { state, items } = savedWithItems(kernel, doc);
    const has = new Set(state.nodes.map((n) => n.id));
    if (!items.items.some((it) => get(it.fields, "node") !== undefined && !has.has(`i${it.id}`))) return null;
    const batch = diff(state.nodes, nodesOf(items, registryFor(kernel)), "forge: open");
    call(kernel, "cadaclysm_blacksmith_document_apply", doc, toJson(batch), undefined);
    return batch;
}

/// Why `text` is no document, in the page's words: the format it names when it names one
/// (a forge file of before is `"cadaclysm-forge"`), else that it names none or is no JSON.
function notADocument(text) {
    const NOT = "not a cadaclysm-blacksmith document";
    let lit;
    try {
        lit = JSON.parse(text);
    } catch {
        return `${NOT} (it is not JSON)`;
    }
    const f = get(lit, "format");
    if (f === "cadaclysm-blacksmith") return undefined;
    return typeof f === "string" ? `${NOT}: its format is "${f}"` : `${NOT}: it names no format`;
}

/// A document from `text`, a `cadaclysm-blacksmith` file (anything else refused as "not a
/// cadaclysm-blacksmith document", naming the format it gives), another app's held bodies
/// and profiles adopted as forge items (`adopt`, one commit). A document handle.
export function openDocument(kernel, text) {
    const why = notADocument(text);
    if (why) fail(why);
    const doc = call(kernel, "cadaclysm_blacksmith_document_load", text);
    try {
        adopt(kernel, doc);
    } catch (e) {
        call(kernel, "cadaclysm_blacksmith_document_free", doc);
        throw e;
    }
    return doc;
}

// ---------------------------------------------------------------------------------
// A trim's ghost.

const PLANE_NAMES = ["xy", "xz", "yz"];
const NO_DEPS = ["text", "choice", "json", "body", "path"];
const REF_TYPES = ["face_ref", "face_refs", "edge_refs", "vertex_ref"];

/// The names an expression may read: every identifier in it (more than it reads, never
/// fewer -- a name that is no node or parameter is dropped).
function litDeps(l, out) {
    if (typeof l === "string") {
        if (l.startsWith("=")) for (const t of l.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) out.push(t);
    } else if (Array.isArray(l)) l.forEach((x) => litDeps(x, out));
    else if (isMap(l)) Object.values(l).forEach((x) => litDeps(x, out));
}

function frameDeps(l, out) {
    if (typeof l === "string") {
        if (!PLANE_NAMES.includes(l)) out.push(l);
    } else litDeps(l, out);
}

/// What a node's field reads (the Rust `state::field_deps`): node ids named by inputs, by
/// a reference field and by a frame, and the names of every expression.
function fieldDeps(p, l, out) {
    if (p.role === "input") {
        if (typeof l === "string") out.push(l);
        else if (Array.isArray(l)) for (const x of l) if (typeof x === "string") out.push(x);
    } else if (NO_DEPS.includes(p.type)) {
        // nothing
    } else if (REF_TYPES.includes(p.type)) {
        if (typeof l === "string") out.push(l);
    } else if (p.type === "frame") frameDeps(l, out);
    else if (p.type === "frames") {
        if (Array.isArray(l)) l.forEach((x) => frameDeps(x, out));
        else litDeps(l, out);
    } else litDeps(l, out);
}

/// What node `id` reads, however far: its transitive inputs (ids), wherever they sit.
function readsOf(state, registry, id) {
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    const params = isMap(state.params) ? state.params : {};
    const keep = new Set(), seenParams = new Set(), todo = [id];
    while (todo.length) {
        const name = todo.pop();
        const deps = [];
        const nd = byId.get(name);
        if (nd && !keep.has(name)) {
            keep.add(name);
            const kind = registry.get(nd.kind);
            for (const p of kind?.params ?? []) if (Object.hasOwn(nd, p.name)) fieldDeps(p, nd[p.name], deps);
        }
        if (Object.hasOwn(params, name) && !seenParams.has(name)) {
            seenParams.add(name);
            litDeps(params[name], deps);
        }
        for (const d of deps) if ((byId.has(d) && !keep.has(d)) || (Object.hasOwn(params, d) && !seenParams.has(d))) todo.push(d);
    }
    return keep;
}

/// A NodeState as the Rust's `{:?}` writes it.
function stateDebug(st) {
    if (!st) return "";
    const q = (s) => JSON.stringify(s);
    if (st.state === "error") return `Error(${q(st.error)})`;
    if (st.state === "blocked") return `Blocked(${q(st.by)})`;
    return st.state === "ok" ? "Ok" : "Pending";
}

/// A trim's ghost: what trim node `id` (`i<n>`) gives with nothing dropped -- its split
/// pieces under the trim's own move and place, the faces in the split's order, so the
/// trim's `drop` indices name the dropped ones on it. A new solid handle: free it.
///
/// Evaluated as a preview on the document (taken back after): the trim and its transitive
/// inputs, the trim's `solid.drop_faces` step (`<id>_inner`, or `id` itself when it has no
/// move) dropping no face; nothing reading the trim. Refused for a node that is no trim,
/// and while a batch or a preview is open.
/// The frames faces `faces` of node `id`'s solid (`solid`, the handle the caller read it as)
/// take as planes: per face, the twelve doubles (origin, x, y, z) the document's own
/// `frame.on_face` evaluates to -- the plane a face sketch or a face plane stands on --
/// or null where it refuses (not flat, no area, no reference to find it by). One scratch
/// evaluation, as `trimGhost`'s: a node per face added on a preview, read, taken back.
/// Refused while a batch or a sticky preview is open; a drag's live preview is dropped.
export function faceFrames(kernel, doc, id, solid, faces) {
    const out = faces.map(() => null);
    const tag = `${id}__face_frame_`;
    const ops = [];
    faces.forEach((f, k) => {
        let ref;
        try { ref = call(kernel, "cadaclysm_blacksmith_face_ref", solid, f); } catch { return; }
        ops.push({ op: "add", node: { id: `${tag}${k}`, kind: "frame.on_face", solid: id, face: faceRefLit(Array.from(ref)) } });
    });
    if (!ops.length) return out;
    call(kernel, "cadaclysm_blacksmith_document_preview_begin", doc);
    try {
        call(kernel, "cadaclysm_blacksmith_document_preview", doc, toJson({ op: "batch", ops }));
        call(kernel, "cadaclysm_blacksmith_document_evaluate", doc, false);
        faces.forEach((_, k) => {
            try {
                const v = JSON.parse(call(kernel, "cadaclysm_blacksmith_document_value", doc, `${tag}${k}`));
                if (Array.isArray(v) && v.length === 12 && v.every(Number.isFinite)) out[k] = v;
            } catch { /* this face has no frame */ }
        });
        return out;
    } finally {
        call(kernel, "cadaclysm_blacksmith_document_end_preview", doc);
    }
}

export function trimGhost(kernel, doc, id) {
    const state = saved(kernel, doc);
    if (!state.nodes.some((n) => n.id === id)) fail(`no node \`${id}\``);
    const keep = readsOf(state, registryFor(kernel), id);
    const inner = `${id}_inner`;
    const step = state.nodes.find((n) => keep.has(n.id) && (n.id === inner || n.id === id) && n.kind === "solid.drop_faces");
    if (!step) fail(`\`${id}\` is not a trim`);
    const ops = state.nodes.filter((n) => !keep.has(n.id)).reverse().map((n) => ({ op: "remove", id: n.id }));
    ops.push({ op: "set", id: step.id, fields: { faces: [] } });
    call(kernel, "cadaclysm_blacksmith_document_preview_begin", doc);
    try {
        call(kernel, "cadaclysm_blacksmith_document_preview", doc, toJson({ op: "batch", ops }));
        const statuses = JSON.parse(call(kernel, "cadaclysm_blacksmith_document_evaluate", doc, false));
        const s = resultSolid(kernel, doc, id);
        if (s !== undefined) return s;
        fail(`\`${id}\`'s ghost did not build: ${stateDebug(statuses.find((st) => st.id === id))}`);
    } finally {
        call(kernel, "cadaclysm_blacksmith_document_end_preview", doc);
    }
}
