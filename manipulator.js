// manipulator.js
// The forge's manipulator: at a pivot, an arrow along each axis that
// slides the subject, a ring about each that turns it, the centre disc that slides it in the
// plane facing the camera, and a square beside the centre that scales it, all shown at once.
// It is drawn on a page's 2D overlay canvas, over the View's image, so nothing in the scene
// ever hides it. Pure functions: what the subject is, and what a drag does to it, are the
// page's.
//
// A manipulator `m` is `{ pivot, axes: [{a, name}], rings: [{n, name}], scale }`: the world
// pivot, the arrows' unit directions, the rings' unit normals ("X", "Y" or "Z" names their
// colour) and whether it has the scale square. A page leaves out what its subject cannot do
// (no rings, no scale).
//
// A camera `cam` is `{ worldToPx(p, size), ray(px, size), look, ahead }`: where a world point
// lands in a viewport of `size` (null behind the eye), the ray `{origin, dir}` through a pixel,
// the direction the camera looks, and whether a point read off a ray must lie ahead of its
// origin (a perspective view). projection.js's `cameraOf` answers the first two from a
// View's frame report. Pixels are the caller's; the sizes below are meant as CSS pixels.
//
// Sized on screen (GIZMO3_PX for an arrow) at any distance; an arrow or a ring seen edge-on is
// left out of the layout, so it can be neither drawn nor hit.

export const GIZMO3_PX = 80;
export const AXIS_COLOURS = { X: "#e06060", Y: "#70c070", Z: "#6090e8" };
export const AXES3 = [{ a: [1, 0, 0], name: "X" }, { a: [0, 1, 0], name: "Y" }, { a: [0, 0, 1], name: "Z" }];
/** The rings about the world's axes, for `m.rings`. */
export const RINGS3 = AXES3.map(({ a, name }) => ({ n: a, name }));
/** The colours of what is not an axis: the hot handle, the centre and the square, the
 *  square's stem. */
export const COLOURS = { accent: "#378ADD", handle: "#F1EFE8", stem: "#5F5E5A" };
// The smallest scale a drag reaches.
export const MIN_SCALE = 0.05;

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

/** The distance from pixel `p` to the segment `a`..`b`. */
export function segmentDistance(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

/** `m` laid out in a viewport of `size` seen by `cam`: `{ centre, axes: [{...ax, tip}],
 *  rings: [{...rg, points}], scale }` in its pixels -- the arrows' tips, 48 points round each
 *  ring, the scale square's centre (null without one) -- the edge-on ones dropped; null when
 *  the pivot is behind the eye. */
export function layoutManipulator(m, cam, size) {
    const centre = cam.worldToPx(m.pivot, size);
    if (!centre) return null;
    // `unit` is the world length spanning one pixel at the pivot's depth.
    const f = cam.look;
    const s = unit(cross(f, [0, 0, 1])) ?? unit(cross(f, [0, 1, 0]));
    const q = cam.worldToPx(add(m.pivot, s), size);
    const perUnit = q ? Math.hypot(q[0] - centre[0], q[1] - centre[1]) : 1;
    const px = 1 / Math.max(perUnit, 1e-6);
    const arrow = GIZMO3_PX * px, ring = 0.75 * GIZMO3_PX * px;
    const axes = m.axes.map((ax) => {
        const tip = cam.worldToPx(add(m.pivot, mul(ax.a, arrow)), size);
        return tip && Math.hypot(tip[0] - centre[0], tip[1] - centre[1]) >= 14 ? { ...ax, tip } : null;
    }).filter((ax) => ax);
    const rings = m.rings.map((rg) => {
        const e1 = unit(cross(rg.n, Math.abs(rg.n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), e2 = cross(rg.n, e1);
        const points = [];
        for (let k = 0; k < 48; k++) {
            const t = 2 * Math.PI * k / 48;
            const p = cam.worldToPx(add(m.pivot, add(mul(e1, ring * Math.cos(t)), mul(e2, ring * Math.sin(t)))), size);
            if (p) points.push(p);
        }
        if (points.length < 24) return null;
        const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
        if (Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 12) return null;   // edge-on
        return { ...rg, points };
    }).filter((rg) => rg);
    return { centre, axes, rings, scale: m.scale ? [centre[0] + 44, centre[1] + 44] : null };
}

/** Layout `g` drawn on the 2D context `ctx` in the viewport `[x, y, w, h]` of it (clipped to
 *  it). `hot(kind, name)` says which handle a drag holds ("move" with an axis name or null
 *  for the centre, "rotate" with a ring's, "scale" with null): it is drawn in the accent.
 *  `colours` overrides COLOURS. `hollow` draws the centre as a circle rather than a disc, the
 *  shafts and the stem starting outside it, so what the page draws at the pivot (a picked
 *  vertex's dot) shows through it. */
export function drawManipulator(ctx, g, [x, y, w, h], { hot = () => false, colours = {}, hollow = false } = {}) {
    if (!g) return;
    const { accent, handle, stem } = { ...COLOURS, ...colours };
    const at = (p) => [x + p[0], y + p[1]];
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.lineWidth = 1.5;
    for (const rg of g.rings) {
        ctx.strokeStyle = hot("rotate", rg.name) ? accent : AXIS_COLOURS[rg.name];
        ctx.beginPath();
        rg.points.forEach((p, k) => { const q = at(p); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
        ctx.closePath(); ctx.stroke();
    }
    for (const ax of g.axes) {
        const colour = hot("move", ax.name) ? accent : AXIS_COLOURS[ax.name];
        const a = at(g.centre), b = at(ax.tip);
        const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]) || 1, u = [d[0] / l, d[1] / l], n = [-u[1], u[0]];
        // Hollow, the shaft starts outside the centre's circle.
        const s0 = hollow ? 8 : 0;
        ctx.strokeStyle = colour; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a[0] + u[0] * s0, a[1] + u[1] * s0); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(b[0] + u[0] * 6, b[1] + u[1] * 6);
        ctx.lineTo(b[0] - u[0] * 6 + n[0] * 4.5, b[1] - u[1] * 6 + n[1] * 4.5);
        ctx.lineTo(b[0] - u[0] * 6 - n[0] * 4.5, b[1] - u[1] * 6 - n[1] * 4.5);
        ctx.closePath(); ctx.fill();
        ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(ax.name, b[0] + u[0] * 13, b[1] + u[1] * 13);
    }
    const [cx, cy] = at(g.centre);
    if (hollow) {
        ctx.strokeStyle = hot("move", null) ? accent : handle; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.stroke();
    } else {
        ctx.fillStyle = hot("move", null) ? accent : handle;
        ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
    }
    if (g.scale) {
        const [sx, sy] = at(g.scale);
        const k = hollow ? 8 / Math.SQRT2 : 0;   // the stem, too (the square is diagonal from the centre)
        ctx.strokeStyle = stem; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx + k, cy + k); ctx.lineTo(sx, sy); ctx.stroke();
        ctx.fillStyle = hot("scale", null) ? accent : handle;
        ctx.fillRect(sx - 5, sy - 5, 10, 10);
    }
    ctx.restore();
}

/** The handle of layout `g` under pixel `p`, or null: an arrow's tip, the scale square and
 *  the centre within nine pixels, a ring within eight of its polyline -- in that order.
 *  Answers `{ kind, name, axis }`: "move" with the arrow's direction (or null axis and name
 *  for the centre), "rotate" with the ring's normal, "scale". */
export function hitManipulator(g, p) {
    if (!g) return null;
    const close = (q, r) => q && Math.hypot(q[0] - p[0], q[1] - p[1]) <= r;
    for (const ax of g.axes) if (close(ax.tip, 9)) return { kind: "move", name: ax.name, axis: ax.a };
    if (close(g.scale, 9)) return { kind: "scale", name: null, axis: null };
    if (close(g.centre, 9)) return { kind: "move", name: null, axis: null };
    for (const rg of g.rings) {
        for (let k = 0; k < rg.points.length; k++) {
            if (segmentDistance(p, rg.points[k], rg.points[(k + 1) % rg.points.length]) <= 8) return { kind: "rotate", name: rg.name, axis: rg.n };
        }
    }
    return null;
}

/** The world point a drag on handle `h` (`hitManipulator`'s, with the drag's `pivot`) reads at
 *  pixel `p`: along an axis, the axis line's point nearest the pointer's ray; a turn, the ray
 *  met with the plane square to the axis through the pivot; the free move, the ray met with
 *  the plane facing the camera. Null where there is none. */
export function manipulatorPoint(h, cam, p, size) {
    const { origin, dir } = cam.ray(p, size);
    const pivot = h.pivot;
    if (h.kind === "move" && h.axis) {
        const a = h.axis, w0 = sub(origin, pivot), b = dot(dir, a), d = dot(dir, w0), e = dot(a, w0);
        const denom = 1 - b * b;
        if (Math.abs(denom) < 1e-9) return null;
        return add(pivot, mul(a, (e - b * d) / denom));
    }
    const n = h.kind === "rotate" ? h.axis : cam.look;
    const denom = dot(dir, n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = dot(sub(pivot, origin), n) / denom;
    return !cam.ahead || t > 0 ? add(origin, mul(dir, t)) : null;
}

/** A drag on `h` begun at pixel `p`: `h` with `fromPx` and `from` (the world point it read
 *  there; none for a scale), to measure every move from. */
export function beginDrag(h, cam, p, size) {
    return { ...h, fromPx: p, from: h.kind === "scale" ? null : manipulatorPoint(h, cam, p, size) };
}

/** The drag `d` (`beginDrag`'s) at pixel `p`, since it began: `{ slide, turn, scale }` -- a
 *  world slide (or null), radians about the ring's normal (by the right hand), and a scale
 *  (the pointer's distance from the pivot on screen, as a ratio of where it began, at least
 *  MIN_SCALE). Null when the pixel reads nothing. */
export function dragDelta(d, cam, p, size) {
    if (d.kind === "scale") {
        const centre = cam.worldToPx(d.pivot, size);
        if (!centre) return null;
        const d0 = Math.hypot(d.fromPx[0] - centre[0], d.fromPx[1] - centre[1]);
        if (d0 < 1e-9) return null;
        return { slide: null, turn: 0, scale: Math.max(MIN_SCALE, Math.hypot(p[0] - centre[0], p[1] - centre[1]) / d0) };
    }
    const q = manipulatorPoint(d, cam, p, size);
    if (!q || !d.from) return null;
    if (d.kind === "move") return { slide: sub(q, d.from), turn: 0, scale: 1 };
    const r0 = sub(d.from, d.pivot), r1 = sub(q, d.pivot);
    return { slide: null, turn: Math.atan2(dot(cross(r0, r1), d.axis), dot(r0, r1)), scale: 1 };
}

/** A delta as a 4 x 4 matrix about `pivot`, column-major (entry 4 * col + row): slid, or
 *  turned about the unit `axis` through the pivot, or scaled about it. */
export function deltaMatrix(delta, pivot, axis = null) {
    const m = new Float64Array(16);
    m[15] = 1;
    if (delta.slide) {
        m[0] = m[5] = m[10] = 1;
        m[12] = delta.slide[0]; m[13] = delta.slide[1]; m[14] = delta.slide[2];
        return m;
    }
    // The linear part l, then the translation p - l p.
    let l;
    if (delta.turn && axis) {
        const [x, y, z] = axis, c = Math.cos(delta.turn), s = Math.sin(delta.turn), t = 1 - c;
        // Rodrigues, column-major.
        l = [t * x * x + c, t * x * y + s * z, t * x * z - s * y,
            t * x * y - s * z, t * y * y + c, t * y * z + s * x,
            t * x * z + s * y, t * y * z - s * x, t * z * z + c];
    } else {
        const k = delta.scale ?? 1;
        l = [k, 0, 0, 0, k, 0, 0, 0, k];
    }
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[4 * col + row] = l[3 * col + row];
    for (let row = 0; row < 3; row++) m[12 + row] = pivot[row] - (l[row] * pivot[0] + l[3 + row] * pivot[1] + l[6 + row] * pivot[2]);
    return m;
}
