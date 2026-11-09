// The forge's constraint layer: a sketch's curve items mapped onto a wasm sketch session
// (points, lines, arcs, circles, free curves and the stored constraints between their
// spots), and the solved session's geometry written back as new curve shapes. No DOM:
// forge.js calls it on the page, synchronously.
// A spot is `{ curve, at }`, `at` one of the names `spotsOf` lists; a stored
// constraint is `{ id, kind, refs, value?, driving?, sense?, end? }`, `kind` the Python
// wrapper's snake_case name. A rectangle's and a polygon's own constraints are internal
// (made here, never stored); a polycurve is reference only, its ends fixed. A model also
// keeps `curveOf` (every kernel entity -> its curve) and `withheld` (the curves the last
// `writeBack` refused to write, `{ id, error }`).
import { regularPolygonPoints } from "./forge-doc-curves.js";

// The constraint kinds in the C ABI's code order (index = the code).
export const KINDS = Object.freeze([
    "coincident", "point_on_line", "point_on_circle", "horizontal", "vertical", "parallel",
    "perpendicular", "collinear", "tangent", "tangent_at_end", "concentric", "equal_length",
    "equal_radius", "midpoint", "symmetric", "fix", "distance", "point_line_distance",
    "line_distance", "circle_line_distance", "circle_distance", "horizontal_distance",
    "vertical_distance", "length", "angle", "radius", "diameter",
]);
// The kinds that carry a value.
export const DIMENSIONS = new Set(KINDS.slice(KINDS.indexOf("distance")));

const SENSE = { auto: 0, positive: 1, negative: 2 };
const END = { start: 0, end: 1 };
const code = (name) => KINDS.indexOf(name);

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const polygonSides = (s) => Math.max(3, Math.round(s.sides));
const message = (e) => (e && e.message) || String(e);

// Every `at` the curve offers, in a fixed order.
export function spotsOf(curve) {
    const s = curve.shape;
    switch (curve.kind) {
        case "line": return ["start", "end", "curve"];
        case "arc": return ["start", "end", "centre", "curve"];
        case "circle": return ["centre", "curve"];
        case "rect": return [...range(4, (i) => `corner:${i}`), ...range(4, (i) => `side:${i}`)];
        case "polyline": {
            const n = s.points.length, sides = s.closed ? n : n - 1;
            return [...range(n, (i) => `vertex:${i}`), ...range(sides, (i) => `side:${i}`), ...(s.closed ? [] : ["start", "end"])];
        }
        case "polygon": {
            const n = polygonSides(s);
            return ["centre", ...range(n, (i) => `vertex:${i}`), ...range(n, (i) => `side:${i}`)];
        }
        case "ellipse": return ["centre"];
        case "nurbs": {
            const v = range(s.points.length, (i) => `vertex:${i}`);
            return s.closed ? v : [...v, "start", "end", "curve"];
        }
        case "polycurve": return s.closed ? [] : ["start", "end"];
        default: return [];
    }
}

// The circumcentre of three points, or null when they are in a line.
function circumcentre([ax, ay], [bx, by], [cx, cy]) {
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (!Number.isFinite(d) || Math.abs(d) <= 1e-12 * Math.max(1, Math.hypot(bx - ax, by - ay) * Math.hypot(cx - ax, cy - ay))) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    return [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
}

// Clamped uniform knots for `n` control points of `degree`.
function clampedKnots(n, degree) {
    return [...range(degree + 1, () => 0), ...range(n - degree - 1, (i) => (i + 1) / (n - degree)), ...range(degree + 1, () => 1)];
}

// One curve into the session: its spots (`at` -> kernel id), every kernel id it made,
// whether it was added reversed, and its internal constraints. Throws a message on a
// shape the kernel cannot hold, having taken out whatever of it was already made (its
// entities, newest first, and with them its internal constraints).
function addCurve(w, h, c, internal) {
    const ids = [], before = internal.length;
    try {
        return addCurveParts(w, h, c, internal, ids);
    } catch (e) {
        // A point still held by a curve refuses removal: retry what is left until a pass
        // removes nothing.
        let left = ids.slice().reverse();
        while (left.length) {
            const next = left.filter((id) => {
                try { w.cadaclysm_blacksmith_sketch_remove_entity(h, id); return false; } catch { return true; }
            });
            if (next.length === left.length) break;
            left = next;
        }
        internal.length = before;
        throw e;
    }
}

function addCurveParts(w, h, c, internal, ids) {
    const s = c.shape, spots = {};
    const pt = (x, y) => { const id = w.cadaclysm_blacksmith_sketch_add_point(h, x, y); ids.push(id); return id; };
    const line = (a, b) => { const id = w.cadaclysm_blacksmith_sketch_add_line(h, a, b); ids.push(id); return id; };
    const inner = (kind, refs) => internal.push(w.cadaclysm_blacksmith_sketch_constrain(h, code(kind), Uint32Array.from(refs), 0, true, 0, 0));
    let reversed;
    switch (c.kind) {
        case "line":
            spots.start = pt(s.x0, s.y0);
            spots.end = pt(s.x1, s.y1);
            spots.curve = line(spots.start, spots.end);
            break;
        case "arc": {
            const a = [s.x0, s.y0], m = [s.xm, s.ym], b = [s.x1, s.y1];
            const centre = circumcentre(a, m, b);
            if (!centre) throw `arc ${c.id}: its three points are in a line`;
            reversed = !((m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) > 0);
            spots.centre = pt(centre[0], centre[1]);
            spots.start = pt(a[0], a[1]);
            spots.end = pt(b[0], b[1]);
            const arc = reversed
                ? w.cadaclysm_blacksmith_sketch_add_arc(h, spots.centre, spots.end, spots.start)
                : w.cadaclysm_blacksmith_sketch_add_arc(h, spots.centre, spots.start, spots.end);
            ids.push(arc);
            spots.curve = arc;
            break;
        }
        case "circle":
            spots.centre = pt(s.cx, s.cy);
            spots.curve = w.cadaclysm_blacksmith_sketch_add_circle(h, spots.centre, s.r);
            ids.push(spots.curve);
            break;
        case "rect": {
            const r = Array.from(w.cadaclysm_blacksmith_sketch_add_rect(h, s.x0, s.y0, s.x1, s.y1));
            ids.push(...r);
            r.slice(0, 4).forEach((id, i) => { spots[`corner:${i}`] = id; });
            r.slice(4).forEach((id, i) => { spots[`side:${i}`] = id; });
            break;
        }
        case "polyline": {
            const n = s.points.length;
            if (n < 2) throw `polyline ${c.id}: fewer than two points`;
            const v = s.points.map(([x, y]) => pt(x, y));
            v.forEach((id, i) => { spots[`vertex:${i}`] = id; });
            for (let i = 0; i < (s.closed ? n : n - 1); i++) spots[`side:${i}`] = line(v[i], v[(i + 1) % n]);
            if (!s.closed) { spots.start = v[0]; spots.end = v[n - 1]; }
            break;
        }
        case "polygon": {
            const n = polygonSides(s);
            spots.centre = pt(s.cx, s.cy);
            const ring = w.cadaclysm_blacksmith_sketch_add_circle(h, spots.centre, s.r);
            ids.push(ring);
            w.cadaclysm_blacksmith_sketch_set_construction(h, ring, true);
            const flat = regularPolygonPoints(w, s.cx, s.cy, s.r, n, s.angle ?? 0);
            const v = range(n, (i) => pt(flat[2 * i], flat[2 * i + 1]));
            v.forEach((id, i) => { spots[`vertex:${i}`] = id; inner("point_on_circle", [id, ring]); });
            const sides = range(n, (i) => line(v[i], v[(i + 1) % n]));
            sides.forEach((id, i) => { spots[`side:${i}`] = id; });
            for (let i = 1; i < n; i++) inner("equal_length", [sides[0], sides[i]]);
            break;
        }
        case "ellipse":
            spots.centre = pt(s.cx, s.cy);
            break;
        case "nurbs": {
            const n = s.points.length;
            if (s.closed) {
                s.points.forEach(([x, y], i) => { spots[`vertex:${i}`] = pt(x, y); });
                break;
            }
            if (n < 2) throw `nurbs ${c.id}: fewer than two control points`;
            const degree = Math.max(1, Math.min(Math.round(s.degree ?? 3), n - 1));
            const start = pt(s.points[0][0], s.points[0][1]);
            const xy = Float64Array.from(s.points.slice(1).flat());
            const weights = Array.isArray(s.weights) && s.weights.length === n ? Float64Array.from(s.weights) : undefined;
            const fc = w.cadaclysm_blacksmith_sketch_add_nurbs(h, start, degree, xy, weights, Float64Array.from(clampedKnots(n, degree)));
            const ends = Array.from(w.cadaclysm_blacksmith_sketch_ends(h, fc));
            ids.push(fc, ...ends.slice(1));
            ends.forEach((id, i) => { spots[`vertex:${i}`] = id; });
            spots.start = ends[0];
            spots.end = ends[ends.length - 1];
            spots.curve = fc;
            break;
        }
        case "polycurve":
            if (!s.closed && Array.isArray(s.ends) && s.ends.length === 2) {
                spots.start = pt(s.ends[0][0], s.ends[0][1]);
                spots.end = pt(s.ends[1][0], s.ends[1][1]);
                inner("fix", [spots.start]);
                inner("fix", [spots.end]);
            }
            break;
        default:
            break;
    }
    return { spots, ids, reversed };
}

// What the session holds for curve `c` now, as numbers (the points it writes back from,
// and a circle's radius): the same readings mean the same shape.
function readingsOf(w, model, c) {
    const part = model.parts.get(c.id);
    if (!part) return [];
    const at = (spot) => Array.from(w.cadaclysm_blacksmith_sketch_point(model.h, model.entity.get(`${c.id}:${spot}`)));
    const s = c.shape;
    switch (part.kind) {
        case "line": return [...at("start"), ...at("end")];
        case "arc": return [...at("start"), ...at("end"), ...at("centre")];
        case "circle": return [...at("centre"), w.cadaclysm_blacksmith_sketch_radius(model.h, model.entity.get(`${c.id}:curve`))];
        case "rect": return [...at("corner:0"), ...at("corner:2")];
        case "polyline": return s.points.flatMap((_, i) => at(`vertex:${i}`));
        case "polygon": return [...at("centre"), ...range(polygonSides(s), (i) => at(`vertex:${i}`)).flat()];
        case "ellipse": return at("centre");
        case "nurbs": return s.points.flatMap((_, i) => at(`vertex:${i}`));
        default: return [];
    }
}

// A stored constraint's arguments for `sketch_constrain` (after the handle), or why it
// cannot be made: `{ stale: true }` for a spot the model does not hold, `{ error }` for a
// name the forge does not know.
function constraintArgs(model, k) {
    const refs = (k.refs ?? []).map((r) => model.entity.get(`${r.curve}:${r.at}`));
    if (refs.some((id) => id === undefined)) return { stale: true, error: `constraint ${k.id}: a spot it binds is gone` };
    const kind = code(k.kind);
    if (kind < 0) return { error: `unknown constraint kind ${k.kind}` };
    const sense = k.sense ?? "auto", end = k.end ?? "start";
    if (!Object.hasOwn(SENSE, sense)) return { error: `constraint ${k.id}: unknown sense ${sense}` };
    if (!Object.hasOwn(END, end)) return { error: `constraint ${k.id}: unknown end ${end}` };
    return { call: [kind, Uint32Array.from(refs), k.value ?? 0, k.driving ?? true, SENSE[sense], END[end]] };
}

// A curve as the forge's words name it: its name, else what it is ("a line") -- never an
// internal id.
export const curveName = (c) => c?.name ?? (c?.kind ? `a ${c.kind}` : "a curve");
// A sketch item and its curve items (`plane === sketch.id`) as a sketch session. A build
// that throws part way frees the session it made. A stored record whose add (the kernel
// solves on each) shrinks a curve to a point (`collapsedOf`) is not applied: refused with
// `collapse: true` ("it would shrink Line N to a point"), which is not a conflict (no drag
// undoes it, so it is never judged again), the session as it was before that record.
// `collapsed` names the records a previous session of this sketch refused so: they are left
// out of the build and tried last, each checked -- one that no longer collapses sends the
// build back to the plain order. The rest is checked once at the end. A build that ends
// with a curve collapsed finds the first record that shrinks that curve (`firstShrinking`,
// that curve alone watched) and is made again with it left out the same way; where none
// is found (or a hint went stale), it is made again record by record, each one checked.
export function buildModel(w, sketch, curves, { collapsed = null, scan = true } = {}) {
    let h = w.cadaclysm_blacksmith_sketch_new();
    try {
        const test = collapseCheck(w, curves);
        const deferred = collapsed?.size ? (sketch.constraints ?? []).filter((k) => collapsed.has(k.id)) : [];
        const skip = new Set(deferred.map((k) => k.id));
        const model = buildInto(w, h, sketch, curves, null, skip);
        const gone = model.kernelOf.size === 0 && !deferred.length ? null : test(model);
        if (gone === null) {
            if (deferred.every((k) => addRecord(w, model, k, test) === "collapse")) return model;
            w.cadaclysm_blacksmith_sketch_free(h);
            h = null;
            return buildModel(w, sketch, curves, { scan: false });   // a hint gone stale: the plain order
        }
        w.cadaclysm_blacksmith_sketch_free(h);
        h = null;
        const k = scan ? firstShrinking(w, sketch, curves, gone, skip) : null;
        if (k !== null) return buildModel(w, sketch, curves, { collapsed: new Set([...skip, k]) });
        h = w.cadaclysm_blacksmith_sketch_new();
        return buildInto(w, h, sketch, curves, test, new Set());
    } catch (e) {
        if (h !== null) w.cadaclysm_blacksmith_sketch_free(h);
        throw e;
    }
}
// A test of a session's curves against their document shapes `curves` (`collapsedOf`,
// its extent and maps made once): the first curve the session's geometry shrinks to a
// point, or null.
function collapseCheck(w, curves, only = null) {
    const byIdNow = new Map(curves.map((c) => [c.id, c]));
    const test = collapseTest({ shapes: new Map(curves.map((c) => [c.id, c.shape])), kinds: new Map(curves.map((c) => [c.id, c.kind])) });
    let ids = only;
    return (model) => {
        ids ??= [...model.parts.keys()].filter((id) => model.parts.get(id).kind !== "polycurve");
        const id = test((id) => ({ kind: model.parts.get(id).kind, shape: solvedShape(w, model, byIdNow.get(id)) }), ids);
        return id === null ? null : byIdNow.get(id);
    };
}
// The id of the first stored record (`skip` left out) after whose add curve `gone` is shrunk
// to a point, in a session of its own (freed), only that curve watched; or null.
function firstShrinking(w, sketch, curves, gone, skip) {
    const h = w.cadaclysm_blacksmith_sketch_new();
    try {
        const records = sketch.constraints ?? [];
        const model = buildInto(w, h, sketch, curves, null, new Set(records.map((k) => k.id)));
        const watch = collapseCheck(w, curves, [gone.id]);
        for (const k of records) if (!skip.has(k.id) && addRecord(w, model, k, null) === "applied" && watch(model)) return k.id;
        return null;
    } finally {
        w.cadaclysm_blacksmith_sketch_free(h);
    }
}
// Stored record `k` added to the session: "stale", "refused", "collapse" (with `test`, a
// `collapseCheck`: added, it shrank a curve to a point, so it is taken out and the
// geometry put back as it was) or "applied".
function addRecord(w, model, k, test) {
    const args = constraintArgs(model, k);
    if (args.stale) { model.stale.push(k.id); return "stale"; }
    if (args.error) { model.refused.push({ id: k.id, error: args.error }); return "refused"; }
    const before = test ? geometryOf(w, model) : null;
    let kid;
    try {
        kid = w.cadaclysm_blacksmith_sketch_constrain(model.h, ...args.call);
    } catch (e) {
        model.refused.push({ id: k.id, error: message(e) });
        return "refused";
    }
    const gone = test ? test(model) : null;
    if (gone) {
        w.cadaclysm_blacksmith_sketch_remove(model.h, kid);
        setGeometry(w, model, before);
        model.refused.push({ id: k.id, error: `constraint ${k.id}: it would shrink ${curveName(gone)} to a point`, collapse: true, curve: gone.id });
        return "collapse";
    }
    model.kernelOf.set(k.id, kid);
    model.docOf.set(kid, k.id);
    return "applied";
}
function buildInto(w, h, sketch, curves, test, skip) {
    const model = {
        h, sketchId: sketch.id,
        entity: new Map(), owner: new Map(), kernelOf: new Map(), docOf: new Map(),
        stale: [], refused: [], parts: new Map(), internal: [], base: new Map(),
        curveOf: new Map(), withheld: [],
    };
    for (const c of curves) {
        let got;
        try {
            got = addCurve(w, h, c, model.internal);
        } catch (e) {
            model.refused.push({ id: null, error: typeof e === "string" ? e : `${c.kind} ${c.id}: ${message(e)}` });
            continue;
        }
        const part = { kind: c.kind, ids: got.ids };
        if (got.reversed !== undefined) part.reversed = got.reversed;
        model.parts.set(c.id, part);
        for (const id of got.ids) model.curveOf.set(id, c.id);
        for (const [at, id] of Object.entries(got.spots)) {
            model.entity.set(`${c.id}:${at}`, id);
            if (!model.owner.has(id)) model.owner.set(id, { curve: c.id, at });
        }
    }
    // What the curves read before any stored constraint is added: the session solves each
    // as it is added, so a curve moved by one then reads differently and is written back.
    for (const c of curves) if (model.parts.has(c.id)) model.base.set(c.id, { shape: structuredClone(c.shape), readings: readingsOf(w, model, c) });
    for (const k of sketch.constraints ?? []) if (!skip.has(k.id)) addRecord(w, model, k, test);
    return model;
}

// The curves `curves` (as the document now has them) taken as the session's new starting
// point: after their write-back, so a later `writeBack` skips them until they move again.
export function rebase(w, model, curves) {
    for (const c of curves) if (model.parts.has(c.id)) model.base.set(c.id, { shape: structuredClone(c.shape), readings: readingsOf(w, model, c) });
}

export function freeModel(w, model) {
    w.cadaclysm_blacksmith_sketch_free(model.h);
}

// The shape the session gives curve `c` now (a new object).
function solvedShape(w, model, c) {
    const part = model.parts.get(c.id), s = c.shape;
    const at = (spot) => Array.from(w.cadaclysm_blacksmith_sketch_point(model.h, model.entity.get(`${c.id}:${spot}`)));
    switch (part.kind) {
        case "line": {
            const [x0, y0] = at("start"), [x1, y1] = at("end");
            return { ...s, x0, y0, x1, y1 };
        }
        case "arc": {
            const a = at("start"), b = at("end"), o = at("centre");
            // The kernel's arc runs counter-clockwise from its start to its end.
            const [ks, ke] = part.reversed ? [b, a] : [a, b];
            const t0 = Math.atan2(ks[1] - o[1], ks[0] - o[0]);
            let sweep = Math.atan2(ke[1] - o[1], ke[0] - o[0]) - t0;
            if (sweep <= 0) sweep += 2 * Math.PI;
            const r = Math.hypot(ks[0] - o[0], ks[1] - o[1]), t = t0 + sweep / 2;
            return { ...s, x0: a[0], y0: a[1], xm: o[0] + r * Math.cos(t), ym: o[1] + r * Math.sin(t), x1: b[0], y1: b[1] };
        }
        case "circle": {
            const [cx, cy] = at("centre");
            return { ...s, cx, cy, r: w.cadaclysm_blacksmith_sketch_radius(model.h, model.entity.get(`${c.id}:curve`)) };
        }
        case "rect": {
            const [x0, y0] = at("corner:0"), [x1, y1] = at("corner:2");
            return { ...s, x0, y0, x1, y1 };
        }
        case "polyline":
        case "nurbs":
            return { ...s, points: s.points.map((_, i) => at(`vertex:${i}`)) };
        case "polygon": {
            const [cx, cy] = at("centre"), [vx, vy] = at("vertex:0");
            let angle = Math.atan2(vy - cy, vx - cx) * 180 / Math.PI;
            if (angle < 0) angle += 360;
            if (angle >= 360) angle -= 360;
            return { ...s, cx, cy, r: Math.hypot(vx - cx, vy - cy), angle };
        }
        case "ellipse": {
            const [cx, cy] = at("centre");
            return { ...s, cx, cy };
        }
        default:
            return s;
    }
}

// The points a shape spans (its bounds' corners, near enough), and the sizes of it a
// solve must not shrink to nothing: a line's length, an arc's chord and radius (none where
// its points are in a line), a circle's or a polygon's radius, a rectangle's width and
// height, every side of a polyline, every leg of a spline's control polygon and an open
// one's first-to-last.
function shapePoints(kind, s) {
    switch (kind) {
    case "line": case "rect": return [[s.x0, s.y0], [s.x1, s.y1]];
    case "arc": return [[s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]];
    case "circle": case "polygon": return [[s.cx - s.r, s.cy - s.r], [s.cx + s.r, s.cy + s.r]];
    case "ellipse": return [[s.cx - s.rx, s.cy - s.ry], [s.cx + s.rx, s.cy + s.ry]];
    case "polyline": case "nurbs": return s.points;
    case "polycurve": return s.ends ?? [];
    default: return [];
    }
}
// forge.js's `circumcentreOf` (an absolute 1e-12 test), which the sizes have always used.
function centreOf([ax, ay], [bx, by], [cx, cy]) {
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (!(Math.abs(d) > 1e-12)) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    return [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
}
function shapeSizes(kind, s) {
    const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const legs = (pts, closed) => { const n = pts.length, out = []; for (let i = 0; i < (closed ? n : n - 1); i++) out.push(d(pts[i], pts[(i + 1) % n])); return out; };
    switch (kind) {
    case "line": return [d([s.x0, s.y0], [s.x1, s.y1])];
    case "arc": { const a = [s.x0, s.y0], o = centreOf(a, [s.xm, s.ym], [s.x1, s.y1]); return [d(a, [s.x1, s.y1]), o ? d(o, a) : 0]; }
    case "circle": case "polygon": return [s.r];
    case "rect": return [Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0)];
    case "polyline": return legs(s.points, s.closed);
    case "nurbs": return [...legs(s.points, s.closed), ...(s.closed || s.points.length < 2 ? [] : [d(s.points[0], s.points[s.points.length - 1])])];
    default: return [];
    }
}
// The first of the curves `ids` that a solve since `start` (`{ shapes, kinds }`, Maps by
// id) shrank to a point: one with a size (`shapeSizes`) now below 1e-6 of the sketch's
// extent at `start` (the diagonal of its curves' bounds, at least 1e-12) that had none so
// small then; `now(id)` gives its `{ kind, shape }` now. Its id, or null where none did.
// The kernel holds a collapsed curve as solved (a horizontal and a vertical on one line),
// and an arc shrunk so is refused ever after.
export const collapsedOf = (start, now, ids) => collapseTest(start)(now, ids);
// `collapsedOf` with `start` read once: `(now, ids) => id | null`.
export function collapseTest(start) {
    const pts = [...start.shapes].flatMap(([id, shape]) => shapePoints(start.kinds.get(id), shape));
    if (!pts.length) return () => null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const tol = Math.max(1e-12, 1e-6 * Math.hypot(x1 - x0, y1 - y0));
    const small = (kind, shape) => shapeSizes(kind, shape).some((m) => !(m >= tol));
    const smallAtStart = new Map();
    return (now, ids) => {
        for (const id of ids) {
            const was = start.shapes.get(id);
            if (!was) continue;
            let tiny = smallAtStart.get(id);
            if (tiny === undefined) { tiny = small(start.kinds.get(id), was); smallAtStart.set(id, tiny); }
            if (tiny) continue;
            const c = now(id);
            if (c && small(c.kind, c.shape)) return id;
        }
        return null;
    };
}

const sameNumbers = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function sameShape(a, b) {
    for (const key of Object.keys(b)) {
        const x = a[key], y = b[key];
        if (Array.isArray(y)) {
            if (!Array.isArray(x) || x.length !== y.length) return false;
            if (!y.every((p, i) => Array.isArray(p) ? Array.isArray(x[i]) && sameNumbers(x[i], p) : x[i] === p)) return false;
        } else if (x !== y) return false;
    }
    return true;
}

// Why the session's polygon vertices are not the regular polygon `shape` draws (the same
// `regularPolygonPoints` the forge draws with, vertex for vertex within 1e-6 r), or null.
// Equal sides on a ring also hold for a polygon run backwards or folded into a star.
function polygonMismatch(w, model, c, shape) {
    const n = polygonSides(shape);
    const flat = regularPolygonPoints(w, shape.cx, shape.cy, shape.r, n, shape.angle ?? 0);
    const tol = 1e-6 * Math.max(shape.r, Number.MIN_VALUE);
    for (let i = 0; i < n; i++) {
        const [x, y] = w.cadaclysm_blacksmith_sketch_point(model.h, model.entity.get(`${c.id}:vertex:${i}`));
        if (!(Math.hypot(x - flat[2 * i], y - flat[2 * i + 1]) <= tol)) return `polygon ${c.id}: vertex ${i} is off the regular polygon (folded or reversed), not written`;
    }
    return null;
}

// The curves whose shapes the solved session changes, each `{ id, shape }` with a new shape
// object (the input is never touched). A curve the session still holds exactly as it was
// built is left out, so a recomputed through-point or polygon angle never shows a rounding
// as a change (unless the curve has moved since the build). A polygon whose session
// vertices are not the regular polygon its new shape draws is not written: each such
// curve is listed in `model.withheld` as `{ id, error }` (reset by every call).
export function writeBack(w, model, curvesById) {
    const out = [];
    model.withheld = [];
    for (const [id, part] of model.parts) {
        const c = curvesById.get(id);
        if (!c || part.kind === "polycurve") continue;
        const base = model.base.get(id);
        if (base && sameShape(c.shape, base.shape) && sameNumbers(readingsOf(w, model, c), base.readings)) continue;
        const shape = solvedShape(w, model, c);
        if (part.kind === "polygon") {
            const error = polygonMismatch(w, model, c, shape);
            if (error) { model.withheld.push({ id, error }); continue; }
        }
        if (!sameShape(c.shape, shape)) out.push({ id, shape });
    }
    return out;
}

// ---- solving, dragging, diagnosing, editing ----

const STATUS = ["converged", "conflicting", "diverged"];
const STATE = ["under", "full", "over"];
const DOF_REDUNDANT = 0, DOF_CONFLICTING = 1, DOF_FREE_ENTITIES = 2;

// Kernel constraint ids as doc ids: internal and unknown ones dropped, each once.
function docIds(model, ids, skip) {
    const out = [];
    for (const kid of ids) {
        const doc = model.docOf.get(kid);
        if (doc !== undefined && doc !== skip && !out.includes(doc)) out.push(doc);
    }
    return out;
}
const reportIds = (w, model, skip) => docIds(model, Array.from(w.cadaclysm_blacksmith_sketch_report_ids(model.h)), skip);
function toReport(w, model, r) {
    return { status: STATUS[r[0]] ?? "diverged", iterations: r[1], residual: r[2], ids: reportIds(w, model) };
}

// Solves the session as it stands.
export function solveModel(w, model) {
    return toReport(w, model, w.cadaclysm_blacksmith_sketch_solve(model.h));
}

// Drags spots (`{ curve, at, x, y }`, each a point spot) towards their targets while the
// constraints hold; a non-converged drag leaves the session as it was. Throws on a spot
// the model does not hold or one that is not a point.
export function dragModel(w, model, moves) {
    const ids = moves.map((mv) => {
        const id = model.entity.get(`${mv.curve}:${mv.at}`);
        if (id === undefined) throw new Error(`no spot ${mv.curve}:${mv.at}`);
        return id;
    });
    const xy = Float64Array.from(moves.flatMap((mv) => [mv.x, mv.y]));
    return toReport(w, model, w.cadaclysm_blacksmith_sketch_drag(model.h, Uint32Array.from(ids), xy));
}

// Puts the point spot `curve:at` at (x, y) without solving: how a polycurve's fixed end
// (a fix holds a point where it stands) is carried along with a block. Throws on a spot
// the model does not hold.
export function placeSpot(w, model, curve, at, x, y) {
    const id = model.entity.get(`${curve}:${at}`);
    if (id === undefined) throw new Error(`no spot ${curve}:${at}`);
    w.cadaclysm_blacksmith_sketch_set_point(model.h, id, x, y);
}

// The degrees of freedom: how many are left, the state, the curves still free to move,
// and the stored constraints that are redundant or conflicting.
export function diagnoseModel(w, model) {
    const [free, state] = w.cadaclysm_blacksmith_sketch_diagnose(model.h);
    const freeCurves = new Set();
    for (const id of w.cadaclysm_blacksmith_sketch_dof_list(model.h, DOF_FREE_ENTITIES)) {
        const curve = model.owner.get(id)?.curve ?? model.curveOf.get(id);
        if (curve !== undefined) freeCurves.add(curve);
    }
    return {
        free, state: STATE[state] ?? "over", freeCurves,
        redundant: docIds(model, Array.from(w.cadaclysm_blacksmith_sketch_dof_list(model.h, DOF_REDUNDANT))),
        conflicting: docIds(model, Array.from(w.cadaclysm_blacksmith_sketch_dof_list(model.h, DOF_CONFLICTING))),
    };
}

// Adds the stored-constraint record `k` (its doc id chosen) to the session. A refusal
// changes nothing and names the stored constraints it fights.
export function addConstraint(w, model, k) {
    const args = constraintArgs(model, k);
    if (args.error) return { ok: false, error: args.error, with: [] };
    let kid;
    try {
        kid = w.cadaclysm_blacksmith_sketch_constrain(model.h, ...args.call);
    } catch (e) {
        return { ok: false, error: message(e), with: reportIds(w, model, k.id) };
    }
    model.kernelOf.set(k.id, kid);
    model.docOf.set(kid, k.id);
    return { ok: true, kernelId: kid };
}

// Whether a refusal is a conflict -- refused as over-constrained or as not solving, which
// the geometry may decide (a point held on a circle while it sits at the centre) -- and not
// one no edit can change (an unknown kind or end).
// Takes a refusal (`{ error, collapse }`: a collapse is never a conflict) or its error text.
export const isConflictRefusal = (r) => r !== null && typeof r === "object" ? !r.collapse && isConflictRefusal(r.error) : /over-constrained|did not converge/.test(String(r));

// The records the session refused as conflicts (`isConflictRefusal`) judged again where the
// geometry now stands: each with a record still in `sketch.constraints` added again, in
// document order. One that applies leaves `model.refused` (and is in `kernelOf` and `docOf`
// from now on); one still refused stays as it was, the session unchanged. A record refused
// for anything else is never tried. The doc ids that now apply; until the next retry,
// `revertRetried` takes them out again.
export function retryRefused(w, model, sketch) {
    model.retried = null;
    const tries = (sketch.constraints ?? []).filter((k) => {
        const r = model.refused.find((x) => x.id === k.id);
        return r && isConflictRefusal(r) && !model.kernelOf.has(k.id);
    });
    if (!tries.length) return [];
    // Kept before any is added, so a throw part way can still be reverted.
    const applied = [];
    model.retried = { ids: applied, refused: model.refused.slice(), geometry: geometryOf(w, model) };
    for (const k of tries) {
        if (!addConstraint(w, model, k).ok) continue;
        model.refused.splice(model.refused.findIndex((x) => x.id === k.id), 1);
        applied.push(k.id);
    }
    if (!applied.length) model.retried = null;
    return applied;
}

// The last `retryRefused`'s records taken out again and the session's geometry put back as
// it was before it (anything solved since undone too): refused as they were, as if never
// tried. Nothing where that retry applied none.
export function revertRetried(w, model) {
    const r = model.retried;
    if (!r) return;
    for (const id of r.ids) removeConstraint(w, model, id);
    model.refused.splice(0, model.refused.length, ...r.refused);
    setGeometry(w, model, r.geometry);
    model.retried = null;
}
// The session's geometry put back as `geometryOf` read it.
export function setGeometry(w, model, geometry) {
    for (const [id, v] of geometry) {
        if (v.length === 2) w.cadaclysm_blacksmith_sketch_set_point(model.h, id, v[0], v[1]);
        else w.cadaclysm_blacksmith_sketch_set_radius(model.h, id, v[0]);
    }
}

// What the session's solve can move: every point's place and every circle's radius.
const ENTITY_POINT = 0, ENTITY_CIRCLE = 2;
export function geometryOf(w, model) {
    const out = new Map();
    for (const id of Array.from(w.cadaclysm_blacksmith_sketch_entities(model.h))) {
        const kind = w.cadaclysm_blacksmith_sketch_kind(model.h, id);
        if (kind === ENTITY_POINT) out.set(id, Array.from(w.cadaclysm_blacksmith_sketch_point(model.h, id)));
        else if (kind === ENTITY_CIRCLE) out.set(id, [w.cadaclysm_blacksmith_sketch_radius(model.h, id)]);
    }
    return out;
}

// Removes the stored constraint `docId` (nothing moves).
export function removeConstraint(w, model, docId) {
    const kid = model.kernelOf.get(docId);
    if (kid === undefined) return;
    w.cadaclysm_blacksmith_sketch_remove(model.h, kid);
    model.kernelOf.delete(docId);
    model.docOf.delete(kid);
}

// A dimension edit through the kernel: re-solved, or refused with nothing changed.
function edit(w, model, docId, f) {
    const kid = model.kernelOf.get(docId);
    if (kid === undefined) return { ok: false, error: `no constraint ${docId} in the session`, with: [] };
    try {
        return { ok: true, report: toReport(w, model, f(kid)), with: [] };
    } catch (e) {
        return { ok: false, error: message(e), with: reportIds(w, model, docId) };
    }
}
export function setValue(w, model, docId, value) {
    return edit(w, model, docId, (kid) => w.cadaclysm_blacksmith_sketch_set_value(model.h, kid, value));
}
export function setDriving(w, model, docId, driving) {
    return edit(w, model, docId, (kid) => w.cadaclysm_blacksmith_sketch_set_driving(model.h, kid, driving));
}

// What the geometry measures now for the dimension `docId`.
export function measure(w, model, docId) {
    const kid = model.kernelOf.get(docId);
    if (kid === undefined) throw new Error(`no constraint ${docId} in the session`);
    return w.cadaclysm_blacksmith_sketch_measure(model.h, kid);
}

// The doc id for a sketch's next stored constraint.
export function nextConstraintId(sketch) {
    return 1 + (sketch.constraints ?? []).reduce((m, k) => Math.max(m, Number(k.id) || 0), 0);
}

// ---- inference, migration, pruning (pure: no session) ----

// Where a point spot of `curve` lies, as [x, y], or null for a spot that is not a point.
function spotPoint(curve, at) {
    const s = curve.shape;
    switch (curve.kind) {
        case "line":
        case "arc":
            if (at === "start") return [s.x0, s.y0];
            if (at === "end") return [s.x1, s.y1];
            return null;
        case "polyline":
        case "nurbs": {
            const v = /^vertex:(\d+)$/.exec(at);
            if (v) return s.points[Number(v[1])] ?? null;
            if (s.closed || !s.points.length) return null;
            if (at === "start") return s.points[0];
            if (at === "end") return s.points[s.points.length - 1];
            return null;
        }
        case "polycurve":
            if (s.closed || !Array.isArray(s.ends) || s.ends.length !== 2) return null;
            return at === "start" ? s.ends[0] : at === "end" ? s.ends[1] : null;
        default:
            return null;
    }
}

const spot = (curve, at) => ({ curve, at });
const DEG = Math.PI / 180;
const POINT_AT = /^(start|end|vertex:\d+)$/;
const TARGET_AT = /^(start|end|vertex:\d+|corner:\d+)$/;

// The unit tangent of the circle through the arc's three points at its start, along the arc.
function arcStartDirection(s) {
    const o = circumcentre([s.x0, s.y0], [s.xm, s.ym], [s.x1, s.y1]);
    if (!o) return null;
    const rx = s.x0 - o[0], ry = s.y0 - o[1], len = Math.hypot(rx, ry);
    if (!(len > 0)) return null;
    const ccw = (s.xm - s.x0) * (s.y1 - s.ym) - (s.ym - s.y0) * (s.x1 - s.xm) > 0;
    const sign = ccw ? 1 : -1;
    return [-sign * ry / len, sign * rx / len];
}

// The constraints a just-drawn `curve` gets (ids from `nextId` upward). `snaps` lists
// `{ at, target: { curve, at } }`: which of this curve's spots snapped onto which other spot.
export function inferForCurve(curve, snaps, curvesById, nextId) {
    const out = [];
    const add = (kind, refs, extra) => out.push({ id: nextId + out.length, kind, refs, driving: true, ...extra });
    const s = curve.shape;
    for (const sn of snaps ?? []) {
        const other = curvesById.get(sn.target.curve);
        if (!other || sn.target.curve === curve.id) continue;
        if (POINT_AT.test(sn.at) && TARGET_AT.test(sn.target.at)) {
            add("coincident", [spot(curve.id, sn.at), spot(other.id, sn.target.at)]);
        } else if (sn.at === "centre" && sn.target.at === "centre") {
            const round = (c) => c.kind === "circle" || c.kind === "arc";
            if (round(curve) && round(other)) add("concentric", [spot(curve.id, "curve"), spot(other.id, "curve")]);
            else add("coincident", [spot(curve.id, "centre"), spot(other.id, "centre")]);
        } else if (sn.at === "centre" && TARGET_AT.test(sn.target.at)) {
            // A centre placed on a point (a line's end, a corner): held there.
            add("coincident", [spot(curve.id, "centre"), spot(other.id, sn.target.at)]);
        }
    }
    if (curve.kind === "line") {
        const dx = Math.abs(s.x1 - s.x0), dy = Math.abs(s.y1 - s.y0);
        if (Math.hypot(dx, dy) >= 1e-9) {
            const ends = [spot(curve.id, "start"), spot(curve.id, "end")];
            if (Math.atan2(dy, dx) <= 3 * DEG) add("horizontal", ends);
            else if (Math.atan2(dx, dy) <= 3 * DEG) add("vertical", ends);
        }
    }
    if (curve.kind === "arc") {
        const dir = arcStartDirection(s);
        for (const sn of snaps ?? []) {
            const line = curvesById.get(sn.target.curve);
            if (sn.at !== "start" || sn.target.curve === curve.id || !line || line.kind !== "line" || (sn.target.at !== "start" && sn.target.at !== "end")) continue;
            const lx = line.shape.x1 - line.shape.x0, ly = line.shape.y1 - line.shape.y0, ll = Math.hypot(lx, ly);
            if (!dir || !(ll > 0)) continue;
            // The line travels into the joint along +d at its end, along -d at its start; the
            // arc must carry on that way (a doubling-back arc is a cusp, not a tangent).
            const sgn = sn.target.at === "end" ? 1 : -1;
            const tx = sgn * lx / ll, ty = sgn * ly / ll;
            const cross = Math.abs(dir[0] * ty - dir[1] * tx), dot = dir[0] * tx + dir[1] * ty;
            if (dot > 0 && Math.atan2(cross, dot) <= 5 * DEG) add("tangent", [spot(line.id, "curve"), spot(curve.id, "curve")], { sense: "auto" });
        }
    }
    return out;
}

// Coincident constraints for a sketch that has none yet: every group of start/end spots
// at exactly one point is chained to its first spot. Ids from 1.
export function migrateCoincidences(sketch, curves) {
    if (sketch.constraints) return [];
    const groups = new Map();
    for (const c of curves) {
        for (const at of ["start", "end"]) {
            if (!spotsOf(c).includes(at)) continue;
            const p = spotPoint(c, at);
            if (!p) continue;
            const key = `${p[0]},${p[1]}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(spot(c.id, at));
        }
    }
    const out = [];
    for (const g of groups.values()) {
        for (let i = 1; i < g.length; i++) out.push({ id: out.length + 1, kind: "coincident", refs: [g[0], g[i]], driving: true });
    }
    return out;
}

// Keeps the records whose every ref still names a curve offering that spot.
export function pruneConstraints(constraints, curvesById) {
    const kept = [], dropped = [];
    for (const k of constraints ?? []) {
        const ok = (k.refs ?? []).every((r) => {
            const c = curvesById.get(r.curve);
            return c && spotsOf(c).includes(r.at);
        });
        (ok ? kept : dropped).push(k);
    }
    return { kept, dropped };
}

// The start/end spots of `items` (curves, in run order) nearest `ends`' two points, within
// 1e-6 of each (relative past 1), as [{ curve, at, p } or null, same]. Where several lie
// equally near, the start takes the first piece's and the end the last piece's, and the end
// never takes the spot the start took (a run back through its start, or to a joint).
function pieceEnds(items, ends) {
    const nearest = (p, order, ats, taken) => {
        const tol = 1e-6 * Math.max(1, Math.hypot(p[0], p[1]));
        let best = null, bestD = Infinity;
        for (const c of order) {
            for (const at of ats) {
                if (taken && taken.curve === c.id && taken.at === at) continue;
                const q = spotPoint(c, at);
                if (!q) continue;
                const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (d <= tol && d < bestD) { best = { curve: c.id, at, p: q }; bestD = d; }
            }
        }
        return best;
    };
    const first = nearest(ends[0], items, ["start", "end"], null);
    return [first, nearest(ends[1], items.slice().reverse(), ["end", "start"], first)];
}

// A merged polycurve's two ends: each of `ends` (the chained run's, Float32) replaced by the
// exact start or end of the `picked` curve nearest it, or kept as given where none is near.
export function mergedEnds(picked, ends) {
    const found = pieceEnds(picked, ends);
    return ends.map((e, k) => (found[k] ? [found[k].p[0], found[k].p[1]] : [e[0], e[1]]));
}

// The records after `picked` merged into the polycurve `mergedId` whose ends are `ends`
// (null for a closed one: nothing moves): a ref on a picked curve's point spot lying exactly
// at an end becomes that end of the polycurve. Every other ref is left as it is, for the
// prune to drop those still naming a picked curve.
export function remapMerged(constraints, picked, mergedId, ends) {
    if (!ends) return constraints;
    const byId = new Map(picked.map((c) => [c.id, c]));
    const same = (p, q) => p && q && p[0] === q[0] && p[1] === q[1];
    return (constraints ?? []).map((k) => {
        let changed = false;
        const refs = (k.refs ?? []).map((r) => {
            const c = byId.get(r.curve);
            if (!c || !POINT_AT.test(r.at)) return r;
            const p = spotPoint(c, r.at);
            const at = same(p, ends[0]) ? "start" : same(p, ends[1]) ? "end" : null;
            if (!at) return r;
            changed = true;
            return spot(mergedId, at);
        });
        return changed ? { ...k, refs } : k;
    });
}

// The records after `polycurve` exploded into `pieces` ([{ id, kind, shape }]): a ref on the
// polycurve's start or end becomes the piece end lying there (matched by place, as a piece
// may run either way). Every other ref is left as it is.
export function remapExploded(constraints, polycurve, pieces) {
    const ends = polycurve.shape?.ends;
    const found = Array.isArray(ends) && ends.length === 2 ? pieceEnds(pieces, ends) : [null, null];
    return (constraints ?? []).map((k) => {
        let changed = false;
        const refs = (k.refs ?? []).map((r) => {
            if (r.curve !== polycurve.id || (r.at !== "start" && r.at !== "end")) return r;
            const n = found[r.at === "start" ? 0 : 1];
            if (!n) return r;
            changed = true;
            return spot(n.curve, n.at);
        });
        return changed ? { ...k, refs } : k;
    });
}

// Where the glyphs' marks go, side by side by the spots they sit at: `anchors` are overlay
// pixels (or null), in drawing order. Each joins the first-made slot within 12 px (else makes
// one), its mark 12 px right of and above the slot's pixel, 16 px further right per mark
// already there, and moved on right while an earlier mark lies within 15 px on both axes.
// Null in, null out. The placement is the plain all-pairs scan's, number for number, without
// its cost on a big sketch: the slots are found through a 12 px grid (the 3x3 cells around),
// and the marks are kept in 15 px rows, each sorted by x, so a mark moving right walks the
// three rows about its y with one cursor each -- every test still the scan's own comparison.
export function stackMarks(anchors) {
    const SLOT = 12, BOX = 15;
    const slots = new Map();   // y cell -> x cell -> the slots there
    const rows = new Map();    // y cell -> the marks there, [x, y], sorted by x
    let made = 0;
    const slotFor = (p) => {
        const cx = Math.floor(p[0] / SLOT), cy = Math.floor(p[1] / SLOT);
        let found = null;
        for (let j = -1; j <= 1; j++) {
            const row = slots.get(cy + j);
            if (!row) continue;
            for (let i = -1; i <= 1; i++) {
                for (const s of row.get(cx + i) ?? []) {
                    if ((!found || s.i < found.i) && Math.hypot(s.p[0] - p[0], s.p[1] - p[1]) < SLOT) found = s;
                }
            }
        }
        if (found) return found;
        const slot = { p, n: 0, i: made++ };
        let row = slots.get(cy);
        if (!row) slots.set(cy, row = new Map());
        const cell = row.get(cx);
        if (cell) cell.push(slot); else row.set(cx, [slot]);
        return slot;
    };
    // The first index in `row` whose x is not below `x`.
    const lowerBound = (row, x) => {
        let lo = 0, hi = row.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (row[mid][0] < x) lo = mid + 1; else hi = mid; }
        return lo;
    };
    return anchors.map((p) => {
        if (!p) return null;
        const slot = slotFor(p);
        let x = slot.p[0] + 12 + 16 * slot.n;
        const y = slot.p[1] - 12;
        // A mark off any finite pixel is never blocked, and never blocks one (its tests are NaN).
        if (Number.isFinite(x) && Number.isFinite(y)) {
            const cy = Math.floor(y / BOX);
            const near = [rows.get(cy - 1), rows.get(cy), rows.get(cy + 1)].filter(Boolean);
            // Cursors trail x by a margin past the 15 px test (and past rounding), so every mark
            // the test could hit lies at or after its row's cursor and before x + margin.
            const margin = () => 16 + Math.abs(x) * 1e-9;
            const at = near.map((row) => lowerBound(row, x - margin()));
            const taken = () => {
                const m = margin();
                for (let r = 0; r < near.length; r++) {
                    const row = near[r];
                    while (at[r] < row.length && row[at[r]][0] < x - m) at[r]++;
                    for (let j = at[r]; j < row.length && row[j][0] < x + m; j++) {
                        const b = row[j];
                        if (Math.abs(b[0] - x) < BOX && Math.abs(b[1] - y) < BOX) return true;
                    }
                }
                return false;
            };
            while (taken()) { x += 16; slot.n++; }
        }
        slot.n++;
        if (Number.isFinite(x) && Number.isFinite(y)) {
            const cy = Math.floor(y / BOX);
            let row = rows.get(cy);
            if (!row) rows.set(cy, row = []);
            row.splice(lowerBound(row, x), 0, [x, y]);
        }
        return [x, y];
    });
}
