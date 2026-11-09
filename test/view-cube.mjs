// view-cube.js: which faces a camera sees and where, against figures worked out by hand.
//
// Run: node test/view-cube.mjs
import assert from "node:assert/strict";
import { CUBE_FACES, cubeFaces, cubeFaceAt, aimAt } from "../view-cube.js";

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

// Looking straight along +Y (from the front): only FRONT, square to the eye, a 2-size square
// about the centre with +X to the right and +Z up the screen (y down).
let faces = cubeFaces([0, 1, 0], [48, 48], 22);
assert.deepEqual(faces.map((f) => f.label), ["FRONT"]);
near(faces[0].facing, 1, "FRONT faces the eye");
const xs = faces[0].corners.map((p) => p[0]), ys = faces[0].corners.map((p) => p[1]);
assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [26, 70, 26, 70]);
// The face's +X corner is on the right and its +Z corner is up.
near(faces[0].corners[0][0], 70, "+a is to the right");
near(faces[0].corners[0][1], 26, "+b is up");

// Looking straight down: TOP alone, the up fallback keeping +X to the right.
faces = cubeFaces([0, 0, -1], [48, 48], 22);
assert.deepEqual(faces.map((f) => f.label), ["TOP"]);

// From above the front-right corner, looking down at the origin: TOP, FRONT and RIGHT, back to
// front by how square they are, and nothing from behind.
faces = cubeFaces([-1, 1, -1], [48, 48], 22);
assert.deepEqual(new Set(faces.map((f) => f.label)), new Set(["TOP", "FRONT", "RIGHT"]));
for (let k = 1; k < faces.length; k++) assert.ok(faces[k - 1].facing <= faces[k].facing);

// The face under a point: the centre of a square-on view is FRONT, a point outside is none.
faces = cubeFaces([0, 1, 0], [48, 48], 22);
assert.equal(cubeFaceAt(faces, [48, 48])?.label, "FRONT");
assert.equal(cubeFaceAt(faces, [5, 5]), null);

// Aiming at a face looks into it: TOP straight down, FRONT along +Y.
assert.deepEqual(aimAt("TOP"), [-0, -0, -1]);
assert.deepEqual(aimAt("FRONT"), [-0, 1, -0]);
assert.equal(aimAt("NOWHERE"), null);
assert.equal(CUBE_FACES.length, 6);

console.log("view-cube: ok");
