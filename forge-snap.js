// forge-snap.js
// Snapping onto bodies and the grid, the part with no page and no View in it. The View
// (pkg/viewer-client.js `client.snap`) finds what lies under the pointer; the page snaps
// onto its own curves' ends (forge.js `snapSpot`), and that wins: only a curve end makes a
// coincident constraint. A snap onto a body, the grid or any other point of a curve (its
// middle, centre, quadrant, a point along it, another sketch's) is coordinates only -- the
// point lands there, nothing in the document names what it lies on.

// The kinds the toolbar offers, in its order. The View's "plane" (anywhere on the work
// plane) is left out: a sketch click lands on its plane already.
export const KINDS = ["vertex", "midpoint", "centre", "quadrant", "edge", "face", "grid"];

// On, every point kind and edges; no faces (a face snap is just the point under the
// pointer, seen square on), no grid (sketching stays free until it is asked for).
export function defaultSettings() {
    return {
        on: true,
        kinds: { vertex: true, midpoint: true, centre: true, quadrant: true, edge: true, face: false, grid: false },
        step: 10,
    };
}

// The settings kept in `localStorage` as text, read back field by field: anything missing
// or of the wrong type is the default's.
export function readSettings(text) {
    const s = defaultSettings();
    let saved = null;
    try { saved = JSON.parse(text); } catch { return s; }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return s;
    if (typeof saved.on === "boolean") s.on = saved.on;
    if (saved.kinds && typeof saved.kinds === "object") for (const k of KINDS) if (typeof saved.kinds[k] === "boolean") s.kinds[k] = saved.kinds[k];
    if (typeof saved.step === "number" && Number.isFinite(saved.step) && saved.step > 0) s.step = saved.step;
    return s;
}
export const writeSettings = (s) => JSON.stringify({ on: s.on, kinds: { ...s.kinds }, step: s.step });

// The `kinds` for `View.setSnap`, or null for snapping off (off, or nothing on). `grid`
// false leaves the grid out: Measure measures geometry.
export function viewKinds(s, { grid }) {
    if (!s.on) return null;
    const kinds = KINDS.filter((k) => s.kinds[k] && (grid || k !== "grid"));
    return kinds.length ? kinds : null;
}

// A View answer the forge uses, or null: a snap on a body (the worker marks it with the
// body's id, `body`), on the grid (with `grid`), or on a page curve (`curve`, its id; with
// `curves`, and not one `skip(id)` turns away). Anything else the View shows (a ghost, an
// image, an item already replaced when the answer came) is no snap.
export function bodyAnswer(answer, { grid = true, curves = false, skip = null } = {}) {
    if (!answer || !Array.isArray(answer.point) || !answer.point.every(Number.isFinite)) return null;
    if (answer.kind === "grid") return grid ? answer : null;
    if (answer.kind === "plane") return null;
    if (answer.body !== null && answer.body !== undefined) return answer;
    const curve = answer.curve;
    return curves && curve !== null && curve !== undefined && !skip?.(curve) ? answer : null;
}

// The page's curve-end snap wins whenever there is one.
export const choose = (pageSnap, viewSnap) => pageSnap ?? viewSnap ?? null;

// The cached answer (`{ px, view, answer }`) when the pointer is within a CSS pixel of
// where it was asked, in the same view; else null.
export function fresh(cache, px, view) {
    if (!cache || cache.view !== view) return null;
    return Math.hypot(px[0] - cache.px[0], px[1] - cache.px[1]) <= 1 ? cache.answer : null;
}

// The overlay's mark for a kind; a curve end (no kind) keeps the plain ring.
const GLYPHS = { vertex: "square", midpoint: "triangle", centre: "dot-ring", quadrant: "diamond", edge: "cross", face: "dot", grid: "plus" };
export const glyphOf = (kind) => GLYPHS[kind] ?? "ring";
