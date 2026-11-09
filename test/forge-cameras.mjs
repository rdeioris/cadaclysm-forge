// The forge worker's camera operations: the page's read-modify-write camera moves, done in
// the worker so a gesture applied between the read and the write cannot be lost, and the
// ?test hook's reads. Checked against a fake View that keeps cameras and records calls.
//
// Run: node test/forge-cameras.mjs
import assert from "node:assert/strict";
import { createForgeCameras } from "../forge-cameras.js";
import { createForgeRouter, VIEW_ID } from "../forge-scene.js";

const start = () => [
    { kind: "ortho", basis: "top", centre: [5, 6, 7], height: 40, radius: 50 },
    { kind: "fly", eye: [1, 2, 3], radius: 50 },
    { kind: "ortho", basis: "front", centre: [0, 0, 0], height: 30, radius: 50 },
    { kind: "ortho", basis: "right", centre: [0, 0, 0], height: 30, radius: 50 },
];
function fakeViewer() {
    const cameras = start(), grids = [], log = [];
    return {
        cameras, grids, log, flying: false,
        camera: (i) => (log.push(["camera", i]), cameras[i] ? structuredClone(cameras[i]) : null),
        setCamera: (i, c) => { log.push(["setCamera", i]); cameras[i] = structuredClone(c); },
        setViewportGrid: (i, g) => { log.push(["setViewportGrid", i, g]); grids[i] = g; },
    };
}
function setup(viewer = fakeViewer(), enabled = false) {
    const marked = [], errors = [], posted = [];
    const host = { views: new Map(viewer ? [[VIEW_ID, viewer]] : []), markDirty: (id) => marked.push(id) };
    const cameras = createForgeCameras({ host, viewId: VIEW_ID, onError: (m) => errors.push(m), post: (m) => posted.push(m) });
    return { viewer, cameras, marked, errors, posted };
}

// aim: the view looks square at a tilted plane, its centre carried onto it, its height and
// radius kept; the grid goes. The camera it replaced is kept the first time only.
{
    const { viewer, cameras, marked } = setup();
    const basis = { view: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
    cameras.aim({ view: 0, basis });
    assert.deepEqual(viewer.cameras[0], { kind: "ortho", basis, centre: [5, 6, 0], height: 40, radius: 50 });
    assert.equal(viewer.grids[0], null);
    assert.ok(marked.length > 0, "the host is asked for a draw");
    // aimed again at another plane: the saved camera is still the original
    cameras.aim({ view: 0, basis: { view: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] } });
    cameras.lookAway({ view: 0, radius: 80, grid: "top" });
    assert.deepEqual(viewer.cameras[0], { kind: "ortho", basis: "top", centre: [5, 6, 7], height: 40, radius: 80 }, "back as it was, at the document's radius");
    assert.equal(viewer.grids[0], "top");
    // looking away with nothing saved: the grid only, the camera untouched
    const before = structuredClone(viewer.cameras[2]);
    cameras.lookAway({ view: 2, radius: 99, grid: "front" });
    assert.deepEqual(viewer.cameras[2], before);
    assert.equal(viewer.grids[2], "front");
}

// The race F17 names: a gesture (a camera change) applied by the worker is not lost to a radius
// change, because the read and the write happen in one call here.
{
    const { viewer, cameras } = setup();
    viewer.cameras[0].height = 11;   // a zoom landed first
    cameras.radius({ value: 200 });
    assert.deepEqual(viewer.cameras.map((c) => c.radius), [200, 200, 200, 200]);
    assert.equal(viewer.cameras[0].height, 11, "the pose is kept");
    assert.deepEqual(viewer.cameras[0].centre, [5, 6, 7]);
}

// A refusal in one camera is said once for it and the others still follow.
{
    const { viewer, cameras, errors } = setup();
    const real = viewer.setCamera;
    viewer.setCamera = (i, c) => { if (i === 1) throw new Error("refused: setCamera"); real(i, c); };
    cameras.radius({ value: 9 });
    assert.deepEqual(errors, ["refused: setCamera"]);
    assert.deepEqual(viewer.cameras.map((c) => c.radius), [9, 50, 9, 9]);
    viewer.setCamera = () => { throw new Error("refused: setCamera"); };
    errors.length = 0;
    cameras.aim({ view: 0, basis: { view: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] } });
    assert.deepEqual(errors, ["refused: setCamera"], "an aim that is refused is said, and does not throw");
}

// No view yet: nothing throws out of the worker's message handler for the page's op; it is said.
{
    const { cameras, errors } = setup(null);
    cameras.radius({ value: 5 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no view/);
}

// The ?test hook: refused until switched on; then flying, cameras and refuse answer by req.
{
    const { viewer, cameras, posted } = setup();
    cameras.test({ req: 1, op: "flying" });
    assert.deepEqual(posted.at(-1), { kind: "forge.test.result", req: 1, error: "the test hook is off" });
    cameras.test({ on: true });
    viewer.flying = true;
    cameras.test({ req: 2, op: "flying" });
    assert.deepEqual(posted.at(-1), { kind: "forge.test.result", req: 2, value: true });
    cameras.test({ req: 3, op: "cameras" });
    assert.deepEqual(posted.at(-1).value, start());
    cameras.test({ req: 4, op: "refuse", name: "setPivot" });
    assert.throws(() => viewer.setPivot(), /refused: setPivot/);
    assert.deepEqual(posted.at(-1), { kind: "forge.test.result", req: 4, value: true });
    cameras.test({ req: 5, op: "nonsense" });
    assert.match(posted.at(-1).error, /unknown/);
}

// The router carries forge.* to it, in order with the rest, and a throwing op does not stop the next.
{
    const { cameras, viewer, posted } = setup();
    const posts = [];
    const route = createForgeRouter({ scene: { build() {}, forget() {}, keep() {}, exportFile() {}, wanted() {}, bitmap() {} }, post: (m) => posts.push(m), ready: Promise.resolve(), host: null, cameras });
    route({ kind: "forge.radius", value: 77 });
    route({ kind: "forge.aim", view: 99 });   // no such camera: refused, said, not thrown
    route({ kind: "forge.lookAway", view: 0, radius: 12, grid: "top" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(viewer.cameras[2].radius, 77);
    assert.equal(viewer.grids[0], "top");
    assert.ok(!posts.some((m) => m.kind === "failed"));
}

console.log("forge-cameras: ok");
