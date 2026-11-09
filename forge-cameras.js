// The forge worker's camera operations on its View (viewer-host.js's view `viewId`), and the
// ?test hook's reads. The page keeps no camera: these are the moves that read a camera and write
// it back, done here in one call so a gesture the worker applies between the read and the write
// cannot be lost, and the camera a view had before it looked at a tilted sketch lives with the
// View that restores it.
//
//   aim({ view, basis: { view, right, up } })  view `view` looks square at a plane: an orthographic
//                                              camera on that basis, its centre carried onto the
//                                              plane through the origin, its height and radius
//                                              kept; the camera it replaces is kept the first time;
//                                              the view's grid goes
//   lookAway({ view, radius, grid })           the camera kept comes back at `radius`; the view's
//                                              grid is `grid`
//   radius({ value })                          every camera takes depth range `value`, pose kept
//   test({ on }) / test({ req, op, name })     the ?test hook, off until `on`: `flying` (the View's
//                                              getter), `cameras` (all four, read), `refuse name`
//                                              (that View call throws from now on); answered
//                                              `{ kind: "forge.test.result", req, value | error }`
//
// A refusal (a value the View will not take) is said through `onError(message)`, not thrown:
// the page says it on the status line, as it did when it called the View itself. The worker
// routes the page's `forge.<op>` messages here through `handle`.
const CAMERAS = 4;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function createForgeCameras({ host, viewId, onError, post }) {
    const saved = {};   // view -> the camera it had before aim
    let testing = false;
    const viewer = () => {
        const v = host?.views.get(viewId);
        if (!v) throw new Error("no view yet");
        return v;
    };
    const said = (f) => { try { f(); } catch (e) { onError?.(String(e?.message ?? e)); } };
    const changed = () => host?.markDirty?.(viewId);

    function aim({ view, basis }) {
        said(() => {
            const v = viewer();
            const now = v.camera(view);
            if (!now) throw new Error(`no camera for view ${view}`);
            if (saved[view] === undefined) saved[view] = now;
            const look = basis.view, along = dot(now.centre, look);
            const centre = [0, 1, 2].map((k) => now.centre[k] - look[k] * along);
            v.setCamera(view, { kind: "ortho", basis, centre, height: now.height, radius: now.radius });
            v.setViewportGrid(view, null);
            changed();
        });
    }

    function lookAway({ view, radius, grid }) {
        said(() => {
            const v = viewer();
            const kept = saved[view];
            delete saved[view];
            if (kept !== undefined) v.setCamera(view, { ...kept, radius });
            v.setViewportGrid(view, grid);
            changed();
        });
    }

    function radius({ value }) {
        let v;
        said(() => { v = viewer(); });
        if (!v) return;
        // Each camera on its own: one the View refuses does not stop the others following.
        for (let i = 0; i < CAMERAS; i++) {
            said(() => {
                const now = v.camera(i);
                if (now) v.setCamera(i, { ...now, radius: value });
            });
        }
        changed();
    }

    function test({ on, req, op, name }) {
        if (on !== undefined) { testing = !!on; return; }
        const answer = (rest) => post({ kind: "forge.test.result", req, ...rest });
        if (!testing) return answer({ error: "the test hook is off" });
        try {
            const v = viewer();
            if (op === "flying") answer({ value: !!v.flying });
            else if (op === "cameras") answer({ value: [0, 1, 2, 3].map((i) => v.camera(i)) });
            else if (op === "refuse") {
                v[name] = () => { throw new Error(`refused: ${name}`); };
                answer({ value: true });
            } else answer({ error: `unknown test op ${op}` });
        } catch (e) { answer({ error: String(e?.message ?? e) }); }
    }

    const ops = { "forge.aim": aim, "forge.lookAway": lookAway, "forge.radius": radius, "forge.test": test };
    return { aim, lookAway, radius, test, handle: (message) => ops[message.kind]?.(message) };
}
