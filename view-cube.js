// view-cube.js
// The orientation cube, as the Forge draws it in its Perspective view: a cube in the world's
// axes seen as a camera looking along `forward` sees it, each face named; a click on a face
// aims the camera square at it. Pure geometry: the page draws the faces (an SVG, a canvas)
// and asks which face is under a point.

/** The six faces: outward normal `n`, and `a`, `b` the face's half-edges in the world. */
export const CUBE_FACES = [
    { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], label: "TOP" }, { n: [0, 0, -1], a: [1, 0, 0], b: [0, -1, 0], label: "BOTTOM" },
    { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1], label: "FRONT" }, { n: [0, 1, 0], a: [-1, 0, 0], b: [0, 0, 1], label: "BACK" },
    { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1], label: "RIGHT" }, { n: [-1, 0, 0], a: [0, -1, 0], b: [0, 0, 1], label: "LEFT" },
];

const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const unit = (p) => {
    const l = Math.hypot(...p);
    return [p[0] / l, p[1] / l, p[2] / l];
};

/** The faces a camera looking along `forward` sees, back to front, placed about screen point
 *  `centre` with half-size `size`: each face with `facing` (how square it is to the eye, 0..1)
 *  and its four screen `corners` (y down). World up (+Z) stays up the screen, as in the Forge. */
export function cubeFaces(forward, centre, size = 22) {
    const f = unit(forward);
    let r = cross(f, [0, 0, 1]);
    if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
    r = unit(r);
    const u = cross(r, f);
    const at = (p) => [centre[0] + size * dot(p, r), centre[1] - size * dot(p, u)];
    return CUBE_FACES.map((face) => {
        const facing = -dot(face.n, f);
        const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sa, sb]) => at([0, 1, 2].map((k) => face.n[k] + face.a[k] * sa + face.b[k] * sb)));
        return { ...face, facing, corners };
    }).filter((face) => face.facing > 0.02).sort((p, q) => p.facing - q.facing);
}

/** The face of `faces` (cubeFaces' order, the front one last) under screen point `px`, or null. */
export function cubeFaceAt(faces, px) {
    const inside = (poly) => {
        let hit = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i], [xj, yj] = poly[j];
            if ((yi > px[1]) !== (yj > px[1]) && px[0] < ((xj - xi) * (px[1] - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    };
    for (let k = faces.length - 1; k >= 0; k--) if (inside(faces[k].corners)) return faces[k];
    return null;
}

/** The direction to aim a camera along to look square at face `label` (into it), or null. */
export const aimAt = (label) => {
    const face = CUBE_FACES.find((f) => f.label === label);
    return face ? face.n.map((x) => -x) : null;
};
