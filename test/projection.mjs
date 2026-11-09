// projection.js: a frame report's matrices read back into pixels, rays and world
// points, against figures worked out by hand from the matrices' own definitions (the
// view as View builds it, the perspective's cot(0.4), the orthographic
// height) -- not against another implementation of the same reading.
//
// Run: node test/projection.mjs
import assert from "node:assert/strict";
import { worldToPx, pxToWorld, ray, forward, basis, isOrthographic, cameraOf } from "../projection.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const near = (a, b, tol, what) => { for (let k = 0; k < a.length; k++) assert.ok(Math.abs(a[k] - b[k]) <= tol, `${what}: ${a} vs ${b}`); };

// World to eye from an eye and a basis (right s, up u, looking along f), column-major, f32 as reported.
function viewOf(eye, s, u, f) {
    return Float32Array.from([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
}
function perspective(aspect, n, fa) {
    const c = 1 / Math.tan(0.4);
    return Float32Array.from([c / aspect, 0, 0, 0, 0, c, 0, 0, 0, 0, fa / (n - fa), -1, 0, 0, (fa * n) / (n - fa), 0]);
}
function ortho(height, aspect, n, fa) {
    return Float32Array.from([2 / (height * aspect), 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, -1 / (fa - n), 0, 0, 0, -n / (fa - n), 1]);
}
const SIZE = [200, 100];   // 2:1, so an x/y mix-up shows

// Top: looking down -Z, right +X, up +Y, centre (5, 7) on the plane, 100 units tall, eye 500 back.
const centreTop = [5, 7, 0], fTop = [0, 0, -1];
const top = { rect: [0, 0, 400, 200], kind: "ortho", eye: [5, 7, 500], view: viewOf([5, 7, 500], [1, 0, 0], [0, 1, 0], fTop), projection: ortho(100, 2, 1, 1000) };

// 1. Orthographic pixels: the centre is the middle; 10 right is 10 px right (100 px = 100 units); 10 up is 10 px up.
near(worldToPx(top, centreTop, SIZE), [100, 50], 1e-3, "ortho centre");
near(worldToPx(top, [15, 7, 0], SIZE), [110, 50], 1e-3, "ortho right");
near(worldToPx(top, [5, 17, -30], SIZE), [100, 40], 1e-3, "ortho up, depth ignored");

// 2. Back: a pixel to the world on the origin plane square to the view (the old JS camera's answer), and on a given plane.
near(pxToWorld(top, [110, 40], SIZE), [15, 17, 0], 1e-3, "ortho pxToWorld, no plane");
near(pxToWorld(top, [110, 40], SIZE, { origin: [0, 0, 5], normal: [0, 0, 1] }), [15, 17, 5], 1e-3, "ortho pxToWorld on z = 5");
assert.equal(isOrthographic(top), true);

// 3. The basis read back from the view matrix: forward is -(third row), not +.
near(forward(top), [0, 0, -1], 1e-6, "ortho forward");
near(basis(top).right, [1, 0, 0], 1e-6, "ortho right axis");
near(basis(top).up, [0, 1, 0], 1e-6, "ortho up axis");

// 4. A tilted basis (a sketch at 30 degrees), off the origin: round trip pixel -> world -> pixel.
const t = Math.PI / 6, sT = [1, 0, 0], uT = [0, Math.cos(t), Math.sin(t)], fT = cross(uT, sT);   // f = u x s keeps s x f = u
const eyeT = [3, -4, 2].map((v, k) => v - fT[k] * 400);
const tilted = { rect: [0, 0, 400, 200], kind: "ortho", eye: eyeT, view: viewOf(eyeT, sT, uT, fT), projection: ortho(60, 2, 1, 1000) };
const onPlane = pxToWorld(tilted, [37, 81], SIZE, { origin: [3, -4, 2], normal: fT });
near(worldToPx(tilted, onPlane, SIZE), [37, 81], 1e-3, "tilted round trip");
near(basis(tilted).view, fT, 1e-6, "tilted view axis");

// 5. Perspective: from (0, -100, 0) looking +Y, z up. A point straight ahead is the middle;
// one tan(0.4) of its distance up is the top edge; tan(0.4) * aspect right is the right edge.
const eyeP = [0, -100, 0], fP = [0, 1, 0], sP = unit(cross(fP, [0, 0, 1])), uP = cross(sP, fP);
const persp = { rect: [0, 0, 400, 200], kind: "fly", eye: eyeP, view: viewOf(eyeP, sP, uP, fP), projection: perspective(2, 0.1, 1000) };
const d = 80, tn = Math.tan(0.4);
near(worldToPx(persp, [0, -20, 0], SIZE), [100, 50], 1e-3, "perspective centre");
near(worldToPx(persp, [0, -20, d * tn], SIZE), [100, 0], 1e-3, "perspective top edge");
near(worldToPx(persp, [d * tn * 2, -20, 0], SIZE), [200, 50], 1e-3, "perspective right edge");
assert.equal(worldToPx(persp, [0, -150, 0], SIZE), null, "behind the eye");
assert.equal(isOrthographic(persp), false);
assert.equal(pxToWorld(persp, [10, 10], SIZE), null, "perspective needs a plane");

// 6. A ray through a pixel meets the plane y = 0 (square to the view, in front of the eye) where that pixel looks: back to the same pixel.
for (const px of [[20, 30], [150, 90], [199, 1]]) {
    const { origin, dir } = ray(persp, px, SIZE);
    near(origin, eyeP, 1e-6, "perspective ray starts at the eye");
    assert.ok(Math.abs(Math.hypot(...dir) - 1) < 1e-9, "unit direction");
    const hit = pxToWorld(persp, px, SIZE, { origin: [0, 0, 0], normal: [0, 1, 0] });
    near(worldToPx(persp, hit, SIZE), px, 1e-3, `ray ${px}`);
}
// A plane behind the eye is no hit: y = -150 lies behind the perspective eye (worldToPx above says so), so the centre pixel's ray meets it at t < 0.
assert.equal(pxToWorld(persp, [100, 50], SIZE, { origin: [0, -150, 0], normal: [0, 1, 0] }), null, "plane behind the eye");
// The orthographic ray runs along the view, from the eye's plane.
const r0 = ray(top, [110, 40], SIZE);
near(r0.dir, [0, 0, -1], 1e-6, "ortho ray along the view");
near(r0.origin, [15, 17, 500], 1e-3, "ortho ray from the eye's plane");

// 7. cameraOf: the old JS camera shape over one record, null for none.
const cam = cameraOf(persp);
near(cam.worldToPx([0, -20, 0], SIZE), [100, 50], 1e-3, "cameraOf worldToPx");
near(cam.forward(), fP, 1e-6, "cameraOf forward");
near(cam.basis.view, fP, 1e-6, "cameraOf basis");
assert.equal(cameraOf(undefined), null);

console.log("projection: a frame report's camera, read back");
