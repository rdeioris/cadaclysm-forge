// A viewport's camera as the View drew it -- one record of `viewer.frameReport()`,
// `{ rect, view, projection, eye, kind }`, `view` (world to eye) and `projection` (eye to
// clip, depth 0..1) column-major, entry `4 * col + row` -- read back into what the forge
// asks of a camera on every pointer move: where a world point lands, which world point a
// pixel is, the ray through a pixel, which way the camera looks. Pure math, no state: the
// cameras live in `View` and move there; this only reads the matrices the last frame was
// drawn with, so the overlay and the image agree.
//
// Pixels are the caller's: `size` is the viewport's `[w, h]` in whatever unit the caller
// measures (the forge's CSS pixels). The matrices carry the drawn aspect and no pixel
// size, so any unit with that aspect reads the same. The frusta are symmetric, as every
// `View` camera kind makes them.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l < 1e-20 ? [0, 0, 1] : [v[0] / l, v[1] / l, v[2] / l]; };

/** A parallel projection: its clip w is 1 whatever the depth. */
export const isOrthographic = (r) => r.projection[15] === 1 && r.projection[11] === 0;

/** The camera's axes in the world: the view matrix's first two rows are right and up, its
 *  third is the look reversed. */
export function basis(r) {
    const v = r.view;
    return { right: unit([v[0], v[4], v[8]]), up: unit([v[1], v[5], v[9]]), view: unit([-v[2], -v[6], -v[10]]) };
}

/** Which way the camera looks. */
export const forward = (r) => basis(r).view;

/** Where world point `p` lands in a viewport of `size`, or null behind the eye: clip x and
 *  y over w, mapped to the viewport, y down. */
export function worldToPx(r, p, size) {
    const v = r.view, m = r.projection;
    const ex = v[0] * p[0] + v[4] * p[1] + v[8] * p[2] + v[12];
    const ey = v[1] * p[0] + v[5] * p[1] + v[9] * p[2] + v[13];
    const ez = v[2] * p[0] + v[6] * p[1] + v[10] * p[2] + v[14];
    const ew = v[3] * p[0] + v[7] * p[1] + v[11] * p[2] + v[15];
    const x = m[0] * ex + m[4] * ey + m[8] * ez + m[12] * ew;
    const y = m[1] * ex + m[5] * ey + m[9] * ez + m[13] * ew;
    const w = m[3] * ex + m[7] * ey + m[11] * ez + m[15] * ew;
    if (w <= 1e-9) return null;
    return [size[0] / 2 + (x / w) * size[0] / 2, size[1] / 2 - (y / w) * size[1] / 2];
}

/** The ray through pixel `px`: from the eye along the look turned by the pixel's share of
 *  the field of view; orthographic, along the view from the pixel's point on the eye's plane. */
export function ray(r, px, size) {
    const { right, up, view } = basis(r);
    const m = r.projection;
    const nx = (px[0] - size[0] / 2) / (size[0] / 2), ny = (size[1] / 2 - px[1]) / (size[1] / 2);
    if (isOrthographic(r)) {
        const origin = add(add(r.eye, right, (nx - m[12]) / m[0]), up, (ny - m[13]) / m[5]);
        return { origin, dir: view };
    }
    return { origin: [r.eye[0], r.eye[1], r.eye[2]], dir: unit(add(add(view, right, nx / m[0]), up, ny / m[5])) };
}

/** The world point pixel `px` shows: where its ray meets `plane` (`{ origin, normal }`), or,
 *  with no plane, an orthographic view's point on the plane through the world origin
 *  square to the view (what the forge's sketch reading flattens); null where there is
 *  none (a ray parallel to the plane, or meeting it behind the pixel's origin; a perspective view with no plane). */
export function pxToWorld(r, px, size, plane = null) {
    const { origin, dir } = ray(r, px, size);
    if (plane) {
        const d = dot(dir, plane.normal);
        if (Math.abs(d) < 1e-12) return null;
        const t = dot([plane.origin[0] - origin[0], plane.origin[1] - origin[1], plane.origin[2] - origin[2]], plane.normal) / d;
        return t < 0 ? null : add(origin, dir, t);
    }
    if (!isOrthographic(r)) return null;
    return add(origin, dir, -dot(origin, dir));
}

/** The record as the camera objects the forge used to hold answered: null for no record
 *  (no frame drawn yet). */
export function cameraOf(r) {
    if (!r) return null;
    return {
        worldToPx: (p, size) => worldToPx(r, p, size),
        pxToWorld: (px, size, plane = null) => pxToWorld(r, px, size, plane),
        ray: (px, size) => ray(r, px, size),
        forward: () => forward(r),
        get basis() { return basis(r); },
    };
}
