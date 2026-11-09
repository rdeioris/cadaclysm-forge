// One forge command's effect on the document's items: forge.js `applyNow` as the Rust
// `forge::commands` has it, so the forge runs on the public kernel build. No DOM: importable by the page, the worker
// and node.
//
// Only what a document field depends on is ported. The page's UI effects are not:
// selection, status lines, the worker's `forget`, the sketch revisions (`touchSketch`),
// `sig`, `dirty` and the other runtime keys the `items()` hook drops. Reference images
// (`image`) are the session's, never the document's: their command only takes its id.
//
// What a command needs of geometry comes through an env (the Rust `PickEnv`):
//
//   env.kernel                         the curve helpers' kernel (forge-doc-curves.js): a
//                                      sketch fillet draws through it
//   env.sourcePivot(items, loops)      the pivot a new body over `loops` takes: the middle
//                                      of its Béziers' control-point box (forge.js `bodyOf`)
//   env.faceFrame(body, face)          face `face` (a reference) of body `body` as a sketch
//                                      on it takes it, twelve numbers
//   env.edgeRef(body, index)           edge `index` of body `body`'s solid as a reference
//   env.faceRef(body, index)           face `index` of body `body`'s solid as a reference
//
// `applyCommand` asks only for the pivot (which `noGeometry` answers from the curves alone);
// the face frame and the references are for the picks (forge-doc-convert.js's `docPicks`).
//
//   applyCommand(items, cmd, env)      the command on an `Items`, in place; throws what the
//                                      page would throw (an item a command names is not
//                                      there, an unknown op) -- the items may then be partly
//                                      changed, as the page's are
//   noGeometry(kernel)                 the env with no geometry: every geometric question
//                                      fails but the pivot
import {
    item, label, get, put, putOpt, kept, clone, isMap, f, idOf, idsOf, loopsOf, loopsLit, still, noPlace, kindOf, isBody, isSketch, isCurve,
    truthy, orElse, writeNumber, facePlane, placeOf, RUNTIME_KEYS,
} from "./forge-doc-items.js";
import { sketchFillet, loopsCurves, sourcePivot } from "./forge-doc-curves.js";
import { heldNodeOf } from "./forge-doc-nodes.js";

/// The env with no geometry: every geometric question fails; the pivot, from the curves
/// alone, is still answered (through `kernel`, the curve helpers').
export function noGeometry(kernel) {
    return {
        kernel,
        sourcePivot: (items, loops) => sourcePivot(kernel, loopsCurves(items, loops)),
        faceFrame: (body) => { throw new Error(`no geometry: the face frame of #${body}`); },
        edgeRef: (body, index) => { throw new Error(`no geometry: edge ${index} of #${body}`); },
        faceRef: (body, index) => { throw new Error(`no geometry: face ${index} of #${body}`); },
    };
}

const fail = (why) => { throw new Error(why); };

function opOf(cmd) {
    const o = get(cmd, "op");
    return typeof o === "string" ? o : "";
}

// An object from pairs, in their order.
function map(pairs) {
    const out = {};
    for (const [k, v] of pairs) put(out, k, v);
    return out;
}

/// `byId(id)` that must be there: the page would throw reading a field of `undefined`.
function need(items, id, op) {
    const it = id === undefined ? undefined : items.get(id);
    if (!it) fail(`${op}: item ${id === undefined ? "?" : id} is not there`);
    return it;
}

function needMut(items, id, op) {
    const it = items.get(id);
    if (!it) fail(`${op}: item ${id} is not there`);
    return it;
}

function cmdId(cmd, key, op) {
    const id = idOf(get(cmd, key));
    if (id === undefined) fail(`${op}: \`${key}\` is not an id`);
    return id;
}

/// A field's value as it is, `undefined` where the page's object has no such key.
const field = (fields, key) => clone(get(fields, key));

/// A kind named by a command: its string, or "undefined" as a template string writes it.
function kindIn(l) {
    const k = get(l, "kind");
    return typeof k === "string" ? k : "undefined";
}

/// forge.js `pivotOf` (2708): the pivot where the transform took it.
function pivotOf(c) {
    const pv = get(c, "pivot");
    const p = (k) => (Array.isArray(pv) && typeof pv[k] === "number" ? pv[k] : NaN);
    const t = (k) => f(get(c, "transform"), k) ?? NaN;
    return pivotLit([p(0) + t("tx"), p(1) + t("ty")]);
}

/// A pivot as JSON writes it: a number that is not finite is `null`.
const pivotLit = (p) => p.map((v) => (Number.isFinite(v) ? v : null));

/// A transform copied (`{ ...t }`).
const transformOf = (c) => clone(get(c, "transform") ?? {});

/// The tail every made body's item ends with: `holes`, (`height`), `axis`, `angle`,
/// `source`, then `blankBody`'s kept keys `hidden` and `place` (forge.js 669).
function madeTail(pairs, height) {
    pairs.push(["holes", 0]);
    if (height) pairs.push(["height", 0]);
    pairs.push(["axis", null], ["angle", 0], ["source", null], ["hidden", false], ["place", noPlace()]);
}

/// forge.js `consume` (675): the item hidden, and what it was made of -- a curve's
/// sketch, a surface's curves.
function consume(items, id) {
    const it = id === undefined ? undefined : items.get(id);
    if (!it) return;
    put(it.fields, "hidden", true);
    const fields = it.fields;
    if (isCurve(fields)) {
        const plane = get(fields, "plane");
        const sk = items.items.find((k) => plane === k.id && isSketch(k.fields));
        if (sk) put(sk.fields, "hidden", true);
    } else {
        const loops = loopsOf(get(fields, "loops"));
        if (loops) for (const l of loops) for (const k of l) consume(items, k);
    }
}

/// forge.js `profileOf` (689): a profile's sources as a new body keeps them --
/// `{ loops }` or `{ source }`.
function profileOf(c) {
    if (isCurve(c.fields)) return { loops: [[c.id]] };
    const loops = truthy(get(c.fields, "loops")) ? loopsOf(get(c.fields, "loops")) : undefined;
    if (loops) return { loops };
    return { source: clone(get(c.fields, "source") ?? null) };
}

/// `{ ...profileOf(g) }`'s keys.
const profilePairs = (p) => (p.loops ? [["loops", loopsLit(p.loops)]] : [["source", clone(p.source)]]);

/// forge.js `bodyOf` (2298): a new body over `profile` on `plane`, its pivot the middle
/// of its Béziers' control-point box. `height` and `angle` start 0 here: the page's
/// tool-field defaults (`heightOf`, `angleOf`) are overwritten by every command that
/// makes such a body.
function bodyOf(items, env, kind, profile, holes, plane, id) {
    const name = items.nameFor(kind);
    let pivot;
    if (profile.loops) pivot = env.sourcePivot(items, profile.loops);
    else {
        const curves = get(profile.source, "curves");
        if (!Array.isArray(curves)) fail(`#${id}: its source has no curves`);
        pivot = sourcePivot(env.kernel, clone(curves));
    }
    const pairs = [["id", id], ["name", name], ["kind", kind]];
    if (plane !== undefined) pairs.push(["plane", plane]);
    if (profile.loops) pairs.push(["loops", loopsLit(profile.loops)], ["source", null]);
    else pairs.push(["source", clone(profile.source)]);
    pairs.push(["hidden", false], ["pivot", pivotLit(pivot)], ["transform", still()], ["place", noPlace()], ["holes", holes], ["height", 0], ["axis", null], ["angle", 0]);
    return map(pairs);
}

/// The holes count a body over `c` takes (`c.holes`), null where it has none.
const holesOf = (c) => clone(get(c, "holes") ?? null);

/// forge.js `editItems` (1133): each `{ id, ...fields }` set on its item.
function editItems(items, list) {
    if (!Array.isArray(list)) return;
    for (const it of list) {
        const id = idOf(get(it, "id"));
        const c = id === undefined ? undefined : items.get(id);
        if (!c || !isMap(it)) continue;
        for (const [k, v] of Object.entries(it)) if (k !== "id" && !RUNTIME_KEYS.includes(k)) put(c.fields, k, kept(v));
    }
}

/// forge's old recipe.js `loopsWithArc` (813).
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

/// forge's old recipe.js `loopsMerged` (824).
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

/// forge's old recipe.js `loopsExploded` (837).
const loopsExploded = (loops, id, pieces) => loops.map((l) => (l.includes(id) ? l.flatMap((k) => (k === id ? pieces.slice() : [k])) : l));

/// forge.js `rewriteLoops` (694): every profile loop in the document (a body's, a loft's
/// second profile's and its `via`s') rewritten by `rewrite`.
function rewriteLoops(items, rewrite) {
    const fix = (holder) => {
        if (truthy(get(holder, "loops"))) {
            const l = loopsOf(get(holder, "loops"));
            if (l) put(holder, "loops", loopsLit(rewrite(l)));
        }
    };
    for (const c of items.items) {
        fix(c.fields);
        const to = get(c.fields, "to");
        if (isMap(to)) {
            const t = clone(to);
            fix(t);
            put(c.fields, "to", t);
        }
        const via = get(c.fields, "via");
        if (Array.isArray(via)) {
            put(c.fields, "via", via.map((v) => {
                const w = clone(v);
                if (isMap(w)) fix(w);
                return w;
            }));
        }
    }
}

/// `c[k] = v` for a `v` that may be `undefined`.
function pushOpt(c, k, v) {
    if (v !== undefined) c.push([k, v]);
}

/// forge.js `itemFromV1` (7998): a version-1 file's item as the page holds it.
function itemFromV1(it) {
    const c = [];
    for (const k of ["id", "name", "kind"]) pushOpt(c, k, field(it, k));
    c.push(["hidden", truthy(get(it, "hidden"))]);
    const kind = kindOf(it);
    const opt = (k) => field(it, k);
    const or = (k, b) => orElse(get(it, k), b);
    if (kind === "sketch") {
        c.push(["mode", or("mode", "offset")], ["base", or("base", "top")], ["offset", or("offset", 0)], ["hinge", or("hinge", null)], ["tilt", or("tilt", 30)]);
        c.push(["path", or("path", null)], ["face", or("face", null)], ["mid", or("mid", null)], ["points", or("points", null)]);
    } else if (kind === "join" || kind === "shell") {
        pushOpt(c, "plane", opt("plane"));
        pushOpt(c, "pivot", opt("pivot"));
        const transform = map([["scale", 1]]);
        const t = get(it, "transform");
        if (isMap(t)) for (const [k, v] of Object.entries(t)) put(transform, k, clone(v));
        c.push(["transform", transform], ["parts", or("parts", [])], ["thickness", or("thickness", 2)], ["open", or("open", [])]);
        c.push(["holes", 0], ["height", 0], ["axis", null], ["angle", 0], ["source", null]);
    } else if (isBody(it)) {
        pushOpt(c, "plane", opt("plane"));
        pushOpt(c, "pivot", opt("pivot"));
        pushOpt(c, "transform", opt("transform"));
        c.push(["holes", or("holes", 0)], ["height", or("height", 0)], ["axis", or("axis", null)], ["angle", or("angle", 0)]);
        const src = get(it, "source");
        const source = [];
        const curves = get(src, "curves"), perLoop = get(src, "perLoop");
        if (curves !== undefined) source.push(["curves", clone(curves)]);
        if (perLoop !== undefined) source.push(["perLoop", clone(perLoop)]);
        c.push(["source", map(source)]);
    } else {
        pushOpt(c, "plane", opt("plane"));
        pushOpt(c, "shape", opt("shape"));
    }
    return kept(map(c));
}

/// A name as a template string writes it (`${c.name} copy`).
function nameText(n) {
    if (typeof n === "string") return n;
    if (typeof n === "number") return writeNumber(n);
    return n === null ? "null" : "undefined";
}

/// One forge command applied to the items: forge.js `applyNow`'s effect on the document
/// fields (see the module header). `cmd` is the page's command as JSON gives it.
export function applyCommand(items, cmd, env) {
    const op = opOf(cmd);
    switch (op) {
        // forge.js 740-746
        case "add": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const kind = kindIn(cmd);
            const pairs = [["id", id], ["name", items.nameFor(kind)], ["kind", kind]];
            pushOpt(pairs, "plane", field(cmd, "plane"));
            const sh = get(cmd, "shape");
            if (sh !== undefined) pairs.push(["shape", kept(sh)]);
            pairs.push(["hidden", false]);
            items.items.push(item(map(pairs)));
            editItems(items, get(cmd, "items"));
            break;
        }
        // forge.js 747-754: a reference image is the session's: only its id is taken.
        case "image":
            items.bump(cmdId(cmd, "id", op));
            break;
        // forge.js 755-765
        case "sketch": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const pairs = [["id", id], ["name", items.nameFor("sketch")], ["kind", "sketch"]];
            for (const k of ["mode", "base", "offset"]) pushOpt(pairs, k, field(cmd, k));
            pairs.push(["hinge", orElse(get(cmd, "hinge"), null)]);
            pushOpt(pairs, "tilt", field(cmd, "tilt"));
            pairs.push(["path", orElse(get(cmd, "path"), null)]);
            for (const k of ["face", "mid", "points"]) pairs.push([k, truthy(get(cmd, k)) ? kept(get(cmd, k)) : null]);
            pairs.push(["hidden", false]);
            if (truthy(get(cmd, "constraints"))) pairs.push(["constraints", kept(get(cmd, "constraints"))]);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 766-771
        case "surface": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const loops = loopsOf(get(cmd, "loops")) ?? fail("surface: no loops");
            const body = bodyOf(items, env, "surface", { loops: loopsLit(loops) }, loops.length - 1, field(cmd, "plane"), id);
            items.items.push(item(body));
            for (const l of loops) for (const k of l) consume(items, k);
            break;
        }
        // forge.js 772-781
        case "sweep": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const k = clone(need(items, idOf(get(cmd, "source")), op));
            const kind = kindIn(cmd);
            const body = bodyOf(items, env, kind, profileOf(k), 0, field(k.fields, "plane"), id);
            if (kind === "revolution") {
                const axis = get(cmd, "axis");
                if (axis === undefined) fail("sweep: no axis");
                put(body, "axis", kept(axis));
                putOpt(body, "angle", field(cmd, "angle"));
            } else {
                putOpt(body, "height", field(cmd, "height"));
                put(body, "taper", orElse(get(cmd, "taper"), 0));
            }
            items.items.push(item(body));
            consume(items, k.id);
            break;
        }
        // forge.js 782-792
        case "solid": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const fi = clone(need(items, idOf(get(cmd, "from")), op));
            const body = bodyOf(items, env, "solid", profileOf(fi), holesOf(fi.fields), field(fi.fields, "plane"), id);
            putOpt(body, "pivot", field(fi.fields, "pivot"));
            put(body, "transform", transformOf(fi.fields));
            putOpt(body, "height", field(cmd, "height"));
            put(body, "taper", orElse(get(cmd, "taper"), 0));
            put(body, "from", fi.id);
            items.items.push(item(body));
            consume(items, fi.id);
            break;
        }
        // forge.js 793-806
        case "revolved": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const fi = clone(need(items, idOf(get(cmd, "from")), op));
            const body = bodyOf(items, env, "revolution", profileOf(fi), holesOf(fi.fields), field(fi.fields, "plane"), id);
            putOpt(body, "pivot", field(fi.fields, "pivot"));
            put(body, "transform", transformOf(fi.fields));
            const axis = get(cmd, "axis");
            if (axis === undefined) fail("revolved: no axis");
            put(body, "axis", kept(axis));
            putOpt(body, "angle", field(cmd, "angle"));
            put(body, "sheet", false);
            put(body, "from", fi.id);
            items.items.push(item(body));
            consume(items, fi.id);
            break;
        }
        // forge.js 807-833
        case "lofted": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const fi = clone(need(items, idOf(get(cmd, "from")), op));
            const gi = clone(need(items, idOf(get(cmd, "to")), op));
            const sheet = isCurve(fi.fields);
            const body = bodyOf(items, env, "loft", profileOf(fi), sheet ? 0 : holesOf(fi.fields), field(fi.fields, "plane"), id);
            put(body, "sheet", sheet);
            if (!sheet) {
                putOpt(body, "pivot", field(fi.fields, "pivot"));
                put(body, "transform", transformOf(fi.fields));
            }
            const riding = (g) => {
                const pairs = profilePairs(profileOf(g));
                if (sheet) pairs.push(["pivot", [0, 0]], ["transform", still()]);
                else pairs.push(["pivot", clone(get(g.fields, "pivot") ?? null)], ["transform", transformOf(g.fields)]);
                const out = map(pairs);
                putOpt(out, "plane", field(g.fields, "plane"));
                putOpt(out, "name", field(g.fields, "name"));
                if (!sheet) put(out, "from", g.id);
                return out;
            };
            put(body, "to", riding(gi));
            const via = idsOf(get(cmd, "via")).map((v) => items.get(v)).filter(Boolean).map(clone);
            if (via.length) put(body, "via", via.map(riding));
            if (!sheet) put(body, "from", fi.id);
            items.items.push(item(body));
            consume(items, fi.id);
            consume(items, gi.id);
            for (const v of via) consume(items, v.id);
            break;
        }
        // forge.js 834-845
        case "swept": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const fi = clone(need(items, idOf(get(cmd, "from")), op));
            const path = need(items, idOf(get(cmd, "path")), op).id;
            const curve = isCurve(fi.fields);
            const body = bodyOf(items, env, "sweep", profileOf(fi), curve ? 0 : holesOf(fi.fields), field(fi.fields, "plane"), id);
            put(body, "sheet", curve);
            if (!curve) {
                putOpt(body, "pivot", field(fi.fields, "pivot"));
                put(body, "transform", transformOf(fi.fields));
                put(body, "from", fi.id);
            }
            put(body, "path", path);
            items.items.push(item(body));
            consume(items, fi.id);
            break;
        }
        // forge.js 846-854
        case "join": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const parts = idsOf(get(cmd, "parts"));
            const first = clone(need(items, parts[0], op).fields);
            const pairs = [["id", id], ["name", items.nameFor("join")], ["kind", "join"]];
            pushOpt(pairs, "plane", field(first, "plane"));
            pairs.push(["parts", kept(get(cmd, "parts"))], ["pivot", pivotOf(first)], ["transform", still()]);
            madeTail(pairs, true);
            if (truthy(get(cmd, "flush"))) pairs.push(["flush", true]);
            items.items.push(item(map(pairs)));
            for (const p of parts) consume(items, p);
            break;
        }
        // forge.js 855-867
        case "cut":
        case "intersect": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const parts = idsOf(get(cmd, "parts"));
            const first = clone(need(items, parts[0], op).fields);
            for (const p of parts) put(needMut(items, p, op).fields, "hidden", true);
            const pairs = [["id", id], ["name", items.nameFor(op)], ["kind", op]];
            pushOpt(pairs, "plane", field(first, "plane"));
            pairs.push(["parts", kept(get(cmd, "parts"))], ["pivot", pivotOf(first)], ["transform", still()]);
            madeTail(pairs, true);
            if (truthy(get(cmd, "flush"))) pairs.push(["flush", true]);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 868-876
        case "shell": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const src = clone(need(items, idOf(get(cmd, "source")), op));
            const pairs = [["id", id], ["name", items.nameFor("shell")], ["kind", "shell"]];
            pushOpt(pairs, "plane", field(src.fields, "plane"));
            pairs.push(["parts", [src.id]]);
            pushOpt(pairs, "thickness", field(cmd, "thickness"));
            const open = get(cmd, "open");
            if (open === undefined) fail("shell: no open");
            pairs.push(["open", kept(open)]);
            pairs.push(["openRefs", truthy(get(cmd, "openRefs")) ? kept(get(cmd, "openRefs")) : null]);
            // A live command's references (the document's, see forge-doc-convert.js).
            const refs = get(cmd, "faceRefs");
            if (refs !== undefined) pairs.push(["faceRefs", kept(refs)]);
            pairs.push(["pivot", pivotOf(src.fields)], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            consume(items, src.id);
            break;
        }
        // forge.js 877-888
        case "thicken": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const src = clone(need(items, idOf(get(cmd, "source")), op));
            const pairs = [["id", id], ["name", items.nameFor("thicken")], ["kind", "thicken"]];
            pushOpt(pairs, "plane", field(src.fields, "plane"));
            pairs.push(["parts", [src.id]]);
            pushOpt(pairs, "thickness", field(cmd, "thickness"));
            pairs.push(["pivot", pivotOf(src.fields)], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            consume(items, src.id);
            break;
        }
        // forge.js 889-901
        case "trim": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const sheet = clone(need(items, idOf(get(cmd, "sheet")), op));
            const tool = need(items, idOf(get(cmd, "tool")), op).id;
            put(needMut(items, sheet.id, op).fields, "hidden", true);
            const pairs = [["id", id], ["name", items.nameFor("trim")], ["kind", "trim"]];
            pushOpt(pairs, "plane", field(sheet.fields, "plane"));
            pairs.push(["parts", [sheet.id, tool]], ["drop", []], ["tool", tool], ["pivot", pivotOf(sheet.fields)], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 902-913
        case "face": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const src = clone(need(items, idOf(get(cmd, "from")), op));
            const pairs = [["id", id], ["name", items.nameFor("face")], ["kind", "face"]];
            const plane = truthy(get(cmd, "curved")) ? field(src.fields, "plane") : facePlane(src.id, get(cmd, "face") ?? null);
            pushOpt(pairs, "plane", plane);
            pairs.push(["parts", [src.id]]);
            pushOpt(pairs, "face", field(cmd, "face"));
            pairs.push(["ref", truthy(get(cmd, "ref")) ? kept(get(cmd, "ref")) : null]);
            const refs = get(cmd, "faceRefs");
            if (refs !== undefined) pairs.push(["faceRefs", kept(refs)]);
            pairs.push(["pivot", [0, 0]], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 914-925: named with the solids' counter.
        case "prism": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const sheet = clone(need(items, idOf(get(cmd, "from")), op));
            const pairs = [["id", id], ["name", `${label("prism")} ${items.count("solid")}`], ["kind", "prism"]];
            pushOpt(pairs, "plane", field(sheet.fields, "plane"));
            pairs.push(["parts", [sheet.id]]);
            pushOpt(pairs, "height", field(cmd, "height"));
            pairs.push(["pivot", pivotOf(sheet.fields)], ["transform", still()]);
            madeTail(pairs, false);
            items.items.push(item(map(pairs)));
            consume(items, sheet.id);
            break;
        }
        // forge.js 926-941
        case "press": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const from = get(cmd, "from");
            let faces;
            if (Array.isArray(from)) faces = idsOf(from);
            else {
                const one = idOf(from);
                if (one === undefined) fail("press: no face");
                faces = [one];
            }
            for (const fc of faces) need(items, fc, op);
            const first = clone(need(items, faces[0], op).fields);
            const src = clone(need(items, idsOf(get(first, "parts"))[0], op));
            const pairs = [["id", id], ["name", items.nameFor("press")], ["kind", "press"]];
            pushOpt(pairs, "plane", field(src.fields, "plane"));
            pairs.push(["parts", faces.slice()]);
            pushOpt(pairs, "height", field(cmd, "height"));
            pairs.push(["pivot", pivotOf(src.fields)], ["transform", still()]);
            madeTail(pairs, false);
            items.items.push(item(map(pairs)));
            for (const fc of faces) consume(items, fc);
            consume(items, src.id);
            break;
        }
        // forge.js 942-957
        case "rechamfer":
        case "remove": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const face = clone(need(items, idOf(get(cmd, "from")), op));
            const src = clone(need(items, idsOf(get(face.fields, "parts"))[0], op));
            const lab = op === "remove" ? (get(cmd, "what") === "chamfer" ? "Unchamfer" : "Unfillet") : label("rechamfer");
            const pairs = [["id", id], ["name", `${lab} ${items.count(op)}`], ["kind", op]];
            pushOpt(pairs, "plane", field(src.fields, "plane"));
            pairs.push(["parts", [face.id]], ["radius", orElse(get(cmd, "radius"), 0)], ["what", orElse(get(cmd, "what"), null)], ["pivot", pivotOf(src.fields)], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            consume(items, face.id);
            consume(items, src.id);
            break;
        }
        // forge.js 958-972
        case "refillet": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const face = clone(need(items, idOf(get(cmd, "from")), op));
            const src = clone(need(items, idsOf(get(face.fields, "parts"))[0], op));
            const pairs = [["id", id], ["name", items.nameFor("refillet")], ["kind", "refillet"]];
            pushOpt(pairs, "plane", field(src.fields, "plane"));
            pairs.push(["parts", [face.id]]);
            pushOpt(pairs, "radius", field(cmd, "radius"));
            pairs.push(["pivot", pivotOf(src.fields)], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            consume(items, face.id);
            consume(items, src.id);
            break;
        }
        // forge.js 973-985
        case "fillet": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const src = clone(need(items, idOf(get(cmd, "source")), op));
            put(needMut(items, src.id, op).fields, "hidden", true);
            const style = orElse(get(cmd, "style"), "round");
            const name = style === "chamfer" ? items.nameFor("chamfer") : items.nameFor("fillet");
            const pairs = [["id", id], ["name", name], ["kind", "fillet"], ["style", style]];
            pushOpt(pairs, "plane", field(src.fields, "plane"));
            pairs.push(["parts", [src.id]], ["edges", []]);
            pushOpt(pairs, "radius", field(cmd, "radius"));
            pairs.push(["tool", src.id], ["pivot", pivotOf(src.fields)], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 986-994
        case "primitive": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const kind = kindIn(cmd);
            const pairs = [["id", id], ["name", items.nameFor(kind)], ["kind", kind]];
            pushOpt(pairs, "plane", field(cmd, "plane"));
            const dims = get(cmd, "dims");
            if (dims === undefined) fail("primitive: no dims");
            pairs.push(["parts", []], ["dims", kept(dims)], ["pivot", [0, 0]], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 995-1004
        case "pipe": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const path = clone(need(items, idOf(get(cmd, "path")), op));
            const pairs = [["id", id], ["name", items.nameFor("pipe")], ["kind", "pipe"]];
            pushOpt(pairs, "plane", field(path.fields, "plane"));
            const dims = get(cmd, "dims");
            pairs.push(["parts", []], ["path", path.id]);
            if (dims === undefined) fail("pipe: no dims");
            pairs.push(["dims", kept(dims)], ["pivot", [0, 0]], ["transform", still()]);
            madeTail(pairs, true);
            items.items.push(item(map(pairs)));
            break;
        }
        // forge.js 1005-1018
        case "split": {
            const target = clone(need(items, idOf(get(cmd, "target")), op));
            idsOf(get(cmd, "ids")).forEach((id, side) => {
                items.bump(id);
                const pairs = [["id", id], ["name", items.nameFor("split")], ["kind", "split"]];
                pushOpt(pairs, "plane", field(target.fields, "plane"));
                pairs.push(["parts", [target.id]]);
                const cutter = get(cmd, "cutter");
                if (cutter !== undefined) pairs.push(["cutter", kept(cutter)]);
                pairs.push(["side", side], ["pivot", pivotOf(target.fields)], ["transform", still()]);
                madeTail(pairs, true);
                items.items.push(item(map(pairs)));
            });
            consume(items, target.id);
            break;
        }
        // forge.js 1019-1039
        case "duplicate": {
            const copies = idsOf(get(cmd, "copies"));
            idsOf(get(cmd, "ids")).forEach((id, k) => {
                const copyId = copies[k];
                if (copyId === undefined) return;
                const found = items.get(id);
                // An image (session-only, not kept here) is copied on the page: its copy's id
                // is bumped all the same.
                items.bump(copyId);
                if (!found) return;
                const cf = clone(found.fields);
                const name = `${nameText(get(cf, "name"))} copy`;
                let copy;
                if (isSketch(cf)) {
                    copy = clone(cf);
                    put(copy, "id", copyId);
                    put(copy, "name", name);
                    put(copy, "face", truthy(get(cf, "face")) ? clone(get(cf, "face")) : null);
                    if (truthy(get(cf, "constraints"))) put(copy, "constraints", []);
                } else if (isBody(cf)) {
                    copy = clone(cf);
                    const keepIf = (key) => putOpt(copy, key, truthy(get(cf, key)) ? clone(get(cf, key)) : undefined);
                    put(copy, "id", copyId);
                    put(copy, "name", name);
                    put(copy, "transform", transformOf(cf));
                    put(copy, "place", placeOf(cf));
                    putOpt(copy, "pivot", field(cf, "pivot"));
                    put(copy, "source", truthy(get(cf, "source")) ? clone(get(cf, "source")) : null);
                    keepIf("loops");
                    keepIf("to");
                    keepIf("via");
                    putOpt(copy, "from", field(cf, "from"));
                    for (const key of ["look", "parts", "dims", "open", "drop", "edges", "node", "sheet"]) keepIf(key);
                    put(copy, "axis", truthy(get(cf, "axis")) ? clone(get(cf, "axis")) : null);
                } else {
                    const pairs = [["id", copyId], ["name", name]];
                    for (const key of ["kind", "plane", "shape", "node"]) pushOpt(pairs, key, field(cf, key));
                    pairs.push(["hidden", truthy(get(cf, "hidden"))]);
                    copy = map(pairs);
                }
                items.items.splice(items.indexOf(id) + 1, 0, item(copy));
            });
            break;
        }
        // forge.js 1040-1053
        case "delete": {
            // A sketch takes what is on it along; the set grows as the walk goes, as the page's does.
            const doomed = idsOf(get(cmd, "ids"));
            for (const c of items.items) {
                if (isSketch(c.fields) && doomed.includes(c.id)) {
                    for (const k of items.items) if (get(k.fields, "plane") === c.id && !doomed.includes(k.id)) doomed.push(k.id);
                }
            }
            items.items = items.items.filter((c) => !doomed.includes(c.id));
            // A held node no item names any more goes with its last item.
            const named = items.items.map((c) => get(c.fields, "node")).filter((v) => v !== undefined);
            items.foreign = items.foreign.filter((nd) => heldNodeOf(nd) === undefined || named.some((v) => v === nd.id));
            break;
        }
        // forge.js 1054-1071
        case "round": {
            const ids = idsOf(get(cmd, "ids"));
            const picked = ids.map((i) => (items.get(i) ? clone(items.get(i).fields) : undefined));
            const radius = f(cmd, "radius") ?? NaN;
            const done = sketchFillet(env.kernel, picked, radius);
            if (done?.two) {
                const { a, b, arc } = done.two;
                const [ia, ib] = ids;
                for (const [id, part] of [[ia, a], [ib, b]]) {
                    const c = needMut(items, id, op);
                    const shape = clone(get(c.fields, "shape") ?? {});
                    if (isMap(part)) for (const [k, v] of Object.entries(part)) put(shape, k, v);
                    put(c.fields, "shape", shape);
                }
                const arcId = cmdId(cmd, "arc", op);
                items.bump(arcId);
                const plane = items.get(ia) ? field(items.get(ia).fields, "plane") : undefined;
                const pairs = [["id", arcId], ["name", items.nameFor("arc")], ["kind", "arc"]];
                pushOpt(pairs, "plane", plane);
                pairs.push(["shape", arc], ["hidden", false]);
                items.items.splice(items.indexOf(ib) + 1, 0, item(map(pairs)));
                rewriteLoops(items, (l) => loopsWithArc(l, ia, ib, arcId));
            } else if (done?.one) {
                const c = needMut(items, ids[0], op);
                put(c.fields, "kind", "polycurve");
                put(c.fields, "shape", done.one.shape);
            }
            break;
        }
        // forge.js 1072-1084
        case "merge": {
            const id = cmdId(cmd, "id", op);
            items.bump(id);
            const taken = idsOf(get(cmd, "ids"));
            const was = items.items.findIndex((c) => taken.includes(c.id));
            const pairs = [["id", id], ["name", items.nameFor("polycurve")], ["kind", "polycurve"]];
            pushOpt(pairs, "plane", field(cmd, "plane"));
            const shape = [];
            for (const key of ["pieces", "closed", "ends"]) {
                const v = get(cmd, key);
                if (v !== undefined) shape.push([key, kept(v)]);
            }
            pairs.push(["shape", map(shape)], ["hidden", false]);
            items.items = items.items.filter((c) => !taken.includes(c.id));
            const at = Math.min(was < 0 ? items.items.length : was, items.items.length);
            items.items.splice(at, 0, item(map(pairs)));
            rewriteLoops(items, (l) => loopsMerged(l, taken, id));
            break;
        }
        // forge.js 1085-1102: the sketch trim ("trim" is the sheet's).
        case "snip":
        case "explode": {
            const id = cmdId(cmd, "id", op);
            const found = items.get(id);
            if (!found) return finish(items, cmd);
            const c = clone(found);
            const at = items.indexOf(id);
            const ids = idsOf(get(cmd, "ids"));
            let list;
            if (op === "snip") {
                const l = get(cmd, "items");
                list = Array.isArray(l) ? l : [];
            } else {
                const p = get(get(c.fields, "shape"), "pieces");
                if (!Array.isArray(p)) fail("explode: not a polycurve");
                list = p;
            }
            const made = list.map((it, k) => {
                const nid = ids[k];
                if (nid === undefined) fail(op === "snip" ? "snip: fewer ids than items" : "explode: fewer ids than pieces");
                items.bump(nid);
                const kind = kindIn(it);
                const pairs = [["id", nid], ["name", items.nameFor(kind)], ["kind", kind]];
                pushOpt(pairs, "plane", field(c.fields, "plane"));
                const sh = get(it, "shape");
                if (sh !== undefined) pairs.push(["shape", kept(sh)]);
                pairs.push(["hidden", false]);
                return item(map(pairs));
            });
            items.items.splice(at, 1, ...made);
            rewriteLoops(items, (l) => loopsExploded(l, id, ids));
            break;
        }
        // forge.js 1117-1126
        case "set": {
            const id = idOf(get(cmd, "id"));
            const c = id === undefined ? undefined : items.get(id);
            if (c && isMap(cmd)) {
                for (const [k, v] of Object.entries(cmd)) {
                    // A runtime key is never stored: the hook would drop it.
                    if (k === "op" || k === "id" || k === "sketchConstraints" || k === "sketchEdits" || RUNTIME_KEYS.includes(k)) continue;
                    put(c.fields, k, kept(v));
                }
            }
            break;
        }
        // forge.js 1127-1132
        case "edit":
            editItems(items, get(cmd, "items"));
            break;
        // forge.js 1133-1140: a version-1 file's items, whole.
        case "state": {
            const list = get(cmd, "items");
            items.items = (Array.isArray(list) ? list : []).map((it) => item(itemFromV1(it)));
            const counters = get(cmd, "counters");
            if (isMap(counters)) for (const [k, v] of Object.entries(counters)) put(items.counters, k, clone(v));
            for (const c of items.items.slice()) items.bump(c.id);
            break;
        }
        default:
            fail(`unknown command ${op}`);
    }
    return finish(items, cmd);
}

/// After every command (forge.js 1142-1150): a structural command's sketches' pruned
/// constraints, and the curves its red records moved.
function finish(items, cmd) {
    const list = get(cmd, "sketchConstraints");
    if (Array.isArray(list)) {
        for (const entry of list) {
            const id = idOf(get(entry, "sketch"));
            const sk = id === undefined ? undefined : items.get(id);
            if (!sk || !isSketch(sk.fields)) continue;
            const c = get(entry, "constraints");
            putOpt(sk.fields, "constraints", c === undefined ? undefined : kept(c));
        }
    }
    if (truthy(get(cmd, "sketchEdits"))) editItems(items, get(cmd, "sketchEdits"));
}

