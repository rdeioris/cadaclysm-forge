// The forge's gizmo arithmetic and a built body's tables in words: the vector and quaternion
// arithmetic of a body's place (`V`, `Q`, the manipulator's), the reading of a built body's
// edge list (`parseEdges`) and its closure (`closureText`). No geometry of a curve or a body:
// that is the kernel's (forge-sketch.js, the document's nodes).
export const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    unit: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; },
};

// A body's closure in words, as the reader page's Topology row puts it.
export function closureText(m) {
    if (!m) return "";
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (m.closed) return "closed";
    if (m.manifold) return `open · ${count(m.boundaryEdges, "boundary edge", "boundary edges")}`;
    const where = [];
    if (m.nonManifoldEdges) where.push(`${count(m.nonManifoldEdges, "edge", "edges")} on 3+ faces`);
    if (m.nonManifoldVertices) where.push(count(m.nonManifoldVertices, "pinched vertex", "pinched vertices"));
    return `not manifold · ${where.join(", ")}`;
}

// The edge list as the wasm flattens it, read back: per edge the faces it lies
// between and its segments, six numbers each (two points).
export function parseEdges(flat) {
    const out = [];
    let at = 1;
    const n = flat[0] | 0;
    for (let k = 0; k < n; k++) {
        const faces = flat[at++] | 0;
        const f = [];
        for (let i = 0; i < faces; i++) f.push(flat[at++] | 0);
        const segs = flat[at++] | 0;
        const segments = [];
        for (let i = 0; i < segs; i++) { segments.push([[flat[at], flat[at + 1], flat[at + 2]], [flat[at + 3], flat[at + 4], flat[at + 5]]]); at += 6; }
        out.push({ faces: f, segments });
    }
    return out;
}

// Quaternions `[x, y, z, w]`, for a body's turn in the world: made from an axis and an
// angle or from turns about the world axes (X, then Y, then Z, in degrees), composed,
// and read back as either. Enough for the place a drag composes and the fields show.
export const Q = {
    fromAxisAngle: (axis, angle) => { const u = V.unit(axis); if (!u) return [0, 0, 0, 1]; const s = Math.sin(angle / 2); return [u[0] * s, u[1] * s, u[2] * s, Math.cos(angle / 2)]; },
    mul: (a, b) => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]],
    fromEuler: ([rx, ry, rz]) => {
        const d = Math.PI / 180;
        return Q.mul(Q.fromAxisAngle([0, 0, 1], rz * d), Q.mul(Q.fromAxisAngle([0, 1, 0], ry * d), Q.fromAxisAngle([1, 0, 0], rx * d)));
    },
    toEuler: ([x, y, z, w]) => {
        // The X-then-Y-then-Z angles that make this turn back.
        const d = 180 / Math.PI;
        const sy = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
        const rx = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d;
        const ry = Math.asin(sy) * d;
        const rz = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d;
        return [rx, ry, rz].map((v) => Math.round(v * 1e6) / 1e6);
    },
    toAxisAngle: ([x, y, z, w]) => {
        const s = Math.hypot(x, y, z);
        if (s < 1e-12) return { axis: [0, 0, 1], angle: 0 };
        return { axis: [x / s, y / s, z / s], angle: 2 * Math.atan2(s, w) };
    },
};
