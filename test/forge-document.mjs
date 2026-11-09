// The forge page's document, checked without a browser: the curve helpers the page draws and
// its sketch tools work with (forge-curves.js) -- a polycurve's chain, a sketch fillet, a
// polygon, a body's place, the edge list and the closure in words -- and the blacksmith
// document the page holds (forge-doc-convert.js over the kernel's public exports; a body's
// solid its node's `cadaclysm_blacksmith_document_result_solid`, read as the worker's scene
// reads it): the documents converted once from forge's old files (a
// version-1 file's one commit, a version-2 fillet's legacy edge numbering, a history with an
// undone tail), and an old file refused in words.
//
// Run: node test/forge-document.mjs   (after npm run setup)
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadWasm } from "./package.mjs";
import { command, openDocument } from "../forge-doc-convert.js";
import { itemsOf as itemsOfState } from "../forge-doc-nodes.js";
import { Q, chainPieces, beziersOf, polygonPoints, roundCorner, roundPolyline, roundPolycurve, orderPieces, trimPieces, trimmedChains, chainCurve, parseEdges, closureText } from "../forge-curves.js";
import { edgeList, massOf } from "../forge-scene.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = await loadWasm();
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8").replace(/\r\n/g, "\n");
const example = (name) => readFileSync(join(here, "..", "examples", name), "utf8").replace(/\r\n/g, "\n");
const pins = JSON.parse(fixture("forge-pins.json"));
const line = (x0, y0, x1, y1) => ({ kind: "line", shape: { x0, y0, x1, y1 } });

// A polycurve's pieces chain whatever order and way round they were drawn: a line, an
// arc and a line given end-first and shuffled come out one run end to end;
// a polycurve of them is a curve like any other; a closed chain says so; a piece that
// meets nothing, or is closed on its own, is refused by number and kind.
{
    const arc = { kind: "arc", shape: { x0: 10, y0: 0, xm: 20, ym: 10, x1: 10, y1: 20 } };
    const { beziers, closed } = chainPieces([line(10, 20, 0, 20), arc, line(0, 0, 10, 0)]);
    assert.strictEqual(beziers.length / 16, 1 + 2 + 1, "one Bézier a line, two the arc");
    assert.ok(!closed);
    // The arc's end meets the first line's start, so it goes in front as it is; the
    // last line's end meets the arc's start, so it goes in front turned round.
    assert.deepStrictEqual([beziers[0], beziers[1]], [0, 0], "the chain runs from the last line's far end");
    assert.deepStrictEqual([beziers[16], beziers[17]], [10, 0], "then the arc from its own start");
    assert.deepStrictEqual([beziers[beziers.length - 4], beziers[beziers.length - 3]], [0, 20], "to the first line's far end");
    const poly = { kind: "polycurve", shape: { pieces: [line(10, 20, 0, 20), arc, line(0, 0, 10, 0)], closed: false } };
    assert.strictEqual(beziersOf(poly).length, beziers.length);
    assert.ok(chainPieces([line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 0)]).closed);
    assert.throws(() => chainPieces([line(0, 0, 10, 0), line(20, 20, 30, 30)]), /piece 2 \(line\) does not meet/);
    assert.throws(() => chainPieces([line(0, 0, 10, 0), { kind: "circle", shape: { cx: 10, cy: 0, r: 5 } }]), /piece 2 \(circle\) is closed/);
    // The chaining is the kernel's (`Profile::chain`): a joint within the tolerance is the
    // chain's own point, and a loop within it closes on its start exactly.
    const gappy = chainPieces([line(0, 0, 10, 0), line(10.0005, 0, 10, 10), line(10, 10, 0.0004, 0)]);
    assert.ok(gappy.closed);
    assert.deepStrictEqual([gappy.beziers[16], gappy.beziers[17]], [10, 0], "the second line starts where the first ends");
    assert.deepStrictEqual([gappy.beziers[gappy.beziers.length - 4], gappy.beziers[gappy.beziers.length - 3]], [0, 0], "and the last lands on the start");
    assert.throws(() => chainPieces([]), /no pieces/);
}

// A sketch fillet: a right-angle corner rounded by 5 has its tangent points 5 back
// along each leg and its middle on the bisector 5·(√2 − 1) in; a square becomes a
// closed polycurve of four lines and four arcs whose Béziers chain; a polycurve of two
// lines gets one arc; a radius that does not fit, or no corner, is refused by name.
{
    const r = roundCorner([0, 0], [10, 0], [0, 10], 5);
    assert.ok(Math.abs(r.t1[0] - 5) < 1e-9 && Math.abs(r.t1[1]) < 1e-9 && Math.abs(r.t2[1] - 5) < 1e-9, JSON.stringify(r));
    const d = 5 * (Math.SQRT2 - 1) / Math.SQRT2;
    assert.ok(Math.abs(r.m[0] - d) < 1e-9 && Math.abs(r.m[1] - d) < 1e-9, JSON.stringify(r.m));
    assert.strictEqual(roundCorner([0, 0], [10, 0], [20, 0], 5), null, "straight on: no corner");
    assert.strictEqual(roundCorner([0, 0], [3, 0], [0, 10], 5), null, "a leg shorter than the tangent distance");
    const square = roundPolyline([[0, 0], [20, 0], [20, 20], [0, 20]], true, 4);
    assert.deepStrictEqual(square.pieces.map((p) => p.kind), ["line", "arc", "line", "arc", "line", "arc", "line", "arc"]);
    const chained = chainPieces(square.pieces);
    assert.ok(chained.closed, "the rounded square closes");
    assert.ok(chained.beziers.length / 16 >= 8 && chained.beziers.length / 16 <= 12, "four lines and four quarter arcs (an arc may split in two)");
    const open = roundPolyline([[0, 0], [10, 0], [10, 10]], false, 3);
    assert.deepStrictEqual(open.pieces.map((p) => p.kind), ["line", "arc", "line"]);
    assert.ok(!open.closed);
    assert.throws(() => roundPolyline([[0, 0], [20, 0], [20, 20], [0, 20]], true, 11), /does not fit/);
    const two = roundPolycurve([line(10, 10, 10, 0), line(0, 0, 10, 0)], 2);
    assert.deepStrictEqual(two.pieces.map((p) => p.kind), ["line", "arc", "line"], "ordered and turned to chain, then rounded");
    assert.ok(!two.closed);
    assert.strictEqual(orderPieces([line(0, 0, 5, 0), line(9, 0, 5, 0)]).pieces[1].shape.x0, 5, "the second line turned round");
}

// The sketch trim: a line crossed by two others is three pieces; the middle one removed
// leaves two chains, each a line again (`chainCurve`); a chain of lines is a polyline.
{
    const cut = beziersOf(line(0, 0, 30, 0));
    const cutters = new Float32Array([...beziersOf(line(10, -5, 10, 5)), ...beziersOf(line(20, -5, 20, 5))]);
    const pieces = trimPieces(cut, cutters, new Uint32Array([1, 1]));
    assert.strictEqual(pieces.length, 3, "cut twice, three pieces");
    const chains = trimmedChains(cut, cutters, new Uint32Array([1, 1]), 1);
    assert.strictEqual(chains.length, 2, "the middle piece gone: two chains left");
    const kept = chains.map(chainCurve);
    assert.deepStrictEqual(kept.map((c) => c.kind), ["line", "line"]);
    assert.ok(Math.abs(kept[0].shape.x1 - 10) < 1e-6 && Math.abs(kept[1].shape.x0 - 20) < 1e-6, JSON.stringify(kept));
    assert.strictEqual(chainCurve([line(0, 0, 1, 0), line(1, 0, 1, 1)]).kind, "polyline");
}

// A body's place: the turns about the world axes round-trip through a quaternion, and a
// turn composed onto them reads back.
{
    for (const turn of [[0, 0, 0], [30, 0, 0], [0, 45, 0], [10, 20, 30], [-60, 15, 100]]) {
        const back = Q.toEuler(Q.fromEuler(turn));
        assert.ok(back.every((v, i) => Math.abs(v - turn[i]) < 1e-6), `${turn} -> ${back}`);
    }
    const quarter = Q.toEuler(Q.mul(Q.fromAxisAngle([0, 0, 1], Math.PI / 2), Q.fromEuler([0, 0, 0])));
    assert.ok(Math.abs(quarter[2] - 90) < 1e-6 && Math.abs(quarter[0]) < 1e-6, `${quarter}`);
}

// A regular polygon: `sides` vertices on its circle, the first at `angle`, its Béziers
// the closed polyline of them; it rounds at every corner as a rectangle does.
{
    const hex = { cx: 10, cy: -5, r: 20, sides: 6, angle: 30 };
    const pts = polygonPoints(hex);
    assert.strictEqual(pts.length, 6);
    for (const [x, y] of pts) assert.ok(Math.abs(Math.hypot(x - 10, y + 5) - 20) < 1e-9, "on the circle");
    assert.ok(Math.abs(pts[0][0] - (10 + 20 * Math.cos(Math.PI / 6))) < 1e-9 && Math.abs(pts[0][1] - (-5 + 10)) < 1e-9, "the first vertex at the angle");
    assert.ok(Math.abs(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) - 20) < 1e-9, "a hexagon's side is its radius");
    assert.strictEqual(beziersOf({ kind: "polygon", shape: hex }).length, 6 * 16, "six lines");
    assert.strictEqual(polygonPoints({ ...hex, sides: 2 }).length, 3, "never fewer than three");
    const rounded = roundPolyline(pts, true, 3);
    assert.strictEqual(rounded.pieces.length, 12, "six lines and six arcs");
    assert.ok(rounded.closed);
}

// The closure in words, as the browser's tooltip says it.
{
    assert.strictEqual(closureText({ closed: true, manifold: true, boundaryEdges: 0, nonManifoldEdges: 0, nonManifoldVertices: 0 }), "closed");
    assert.strictEqual(closureText({ closed: false, manifold: true, boundaryEdges: 1, nonManifoldEdges: 0, nonManifoldVertices: 0 }), "open · 1 boundary edge");
    assert.strictEqual(closureText({ closed: false, manifold: false, boundaryEdges: 0, nonManifoldEdges: 1, nonManifoldVertices: 2 }), "not manifold · 1 edge on 3+ faces, 2 pinched vertices");
    assert.strictEqual(closureText(null), "");
}

// A body of the page's document: a box made by one forge command, its edge list read back
// (`parseEdges`, what a fillet's pick reads) -- twelve edges, each between two faces with a
// straight segment 20 long from each.
{
    const doc = wasm.cadaclysm_blacksmith_document_new("mm");
    command(wasm, doc, { op: "primitive", id: 1, kind: "box", plane: "top", dims: [20, 20, 20] });
    wasm.cadaclysm_blacksmith_document_evaluate(doc, false);
    const solid = wasm.cadaclysm_blacksmith_document_result_solid(doc, "i1");
    const edges = parseEdges(edgeList(wasm, solid));
    assert.strictEqual(wasm.cadaclysm_blacksmith_face_count(solid), 6, "a box has six faces");
    assert.strictEqual(edges.length, 12, "and twelve edges");
    for (const e of edges) {
        assert.strictEqual(e.faces.length, 2, "each between two faces");
        assert.strictEqual(e.segments.length, 2, "a segment from each");
        for (const [a, b] of e.segments) assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) - 20) < 1e-6, `an edge of 20: ${a} ${b}`);
    }
    wasm.cadaclysm_blacksmith_solid_free(solid);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// The document's figures of node `i<id>` against a pinned body.
function checkPinned(doc, file) {
    wasm.cadaclysm_blacksmith_document_evaluate(doc, false);
    for (const pin of pins[file].bodies) {
        const solid = wasm.cadaclysm_blacksmith_document_result_solid(doc, `i${pin.id}`);
        const faces = wasm.cadaclysm_blacksmith_face_count(solid), edges = wasm.cadaclysm_blacksmith_edge_count(solid);
        const [volume, area] = massOf(wasm, solid);
        wasm.cadaclysm_blacksmith_solid_free(solid);
        assert.strictEqual(faces, pin.faces, `${file} i${pin.id}: faces`);
        assert.strictEqual(edges, pin.edges, `${file} i${pin.id}: edges`);
        const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
        assert.ok(near(volume, pin.volume) && near(area, pin.area), `${file} i${pin.id}: volume ${volume} area ${area}, pinned ${pin.volume} ${pin.area}`);
    }
}
const itemsOf = (doc) => itemsOfState(JSON.parse(wasm.cadaclysm_blacksmith_document_save(doc))).toLit();

// A version-1 file (the items as they were, no history), converted, is one commit: its items
// by id, name and kind, every body built as the page built it, and it saves to its own text.
{
    const file = "test/fixtures/forge-v1.json";
    const text = fixture("forge-v1.json");
    assert.strictEqual(JSON.parse(text).format, "cadaclysm-blacksmith");
    const doc = openDocument(wasm, text);
    assert.deepStrictEqual(itemsOf(doc).map((it) => [it.id, it.name, it.kind]), pins[file].items.map((it) => [it.id, it.name, it.kind]));
    const log = JSON.parse(wasm.cadaclysm_blacksmith_document_log(doc, "main"));
    assert.strictEqual(log.length, 2, "the root and the one state commit");
    assert.strictEqual(log[0].message, "forge: state");
    const statuses = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, false));
    for (const id of ["i1", "i2"]) assert.strictEqual(statuses.find((s) => s.id === id)?.state, "ok", `${id} builds`);
    checkPinned(doc, file);
    const saved = wasm.cadaclysm_blacksmith_document_save(doc);
    assert.strictEqual(saved, text, "the file saves to itself");
    const again = openDocument(wasm, saved);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(again), saved, "the save opens to the same text");
    wasm.cadaclysm_blacksmith_document_free(again);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// A version-2 fillet names its edges in the old numbering (a spline's every chord an edge):
// converted, it is marked (`edgeNumbering: 1`) and holds the references of the edges it
// meant, so it rounds the same edges -- the fillet's figures are the page's. (A pick made now
// is in today's numbering only: the JS layer maps no old one.)
{
    const file = "examples/kinds-v2-spline-fillet.json";
    const doc = openDocument(wasm, example("kinds-v2-spline-fillet.json"));
    const fillet = itemsOf(doc).find((it) => it.kind === "fillet");
    assert.strictEqual(fillet.edgeNumbering, 1, "the fillet's edges are in the old numbering");
    assert.ok(Array.isArray(fillet.edgeRefs) && fillet.edgeRefs.length > 0, "and it carries their references");
    const legacy = pins[file].items.find((it) => it.id === fillet.id).edges;
    assert.deepStrictEqual(fillet.edges, legacy, "the indices as the old file wrote them");
    checkPinned(doc, file);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// A forge history with an undone tail (the old file's head 7 of its 9 commands), converted,
// opens at the head: the items the page held there, `main` at the head's commit and the tail
// an unnamed tip past it. Taken back to the root and replayed, redo stops at the head again,
// with the same items and the same save.
{
    const file = "examples/kinds-history.json";
    const head = 7;
    const doc = openDocument(wasm, example("kinds-history.json"));
    const items = () => itemsOf(doc).map((it) => [it.id, it.name]);
    const atHead = items(), saved = wasm.cadaclysm_blacksmith_document_save(doc);
    assert.deepStrictEqual(atHead, pins[file].items.map((it) => [it.id, it.name]), "the items the page held at the head");
    const branches = JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(doc));
    assert.strictEqual(branches.branch, "main");
    assert.strictEqual(branches.can_redo, false, "main ends at the head");
    assert.strictEqual(branches.unnamed.length, 1, "the undone tail is an unnamed tip");
    assert.strictEqual(JSON.parse(wasm.cadaclysm_blacksmith_document_log(doc, "main")).length, head + 1, "a commit per command up to the head, and the root");
    let back = 0;
    while (wasm.cadaclysm_blacksmith_document_undo(doc) !== "null") back++;
    assert.strictEqual(back, head);
    assert.deepStrictEqual(items(), [], "nothing at the root");
    let forward = 0;
    while (wasm.cadaclysm_blacksmith_document_redo(doc) !== "null") forward++;
    assert.strictEqual(forward, head, "the replay ends at the head, not past it");
    assert.deepStrictEqual(items(), atHead);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(doc), saved);
    checkPinned(doc, file);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// A forge file of before (`cadaclysm-forge`, version 1 to 3) no longer opens: it is refused in
// words, naming the format it gives, as is a file that names none or is no JSON.
{
    const refusal = (text) => { try { openDocument(wasm, text); } catch (e) { return String(e?.message ?? e); } return null; };
    const old = JSON.stringify({ format: "cadaclysm-forge", version: 3, head: 1, history: [{ op: "primitive", id: 1, kind: "box", plane: "top", dims: [20, 20, 20] }] });
    assert.strictEqual(refusal(old), 'not a cadaclysm-blacksmith document: its format is "cadaclysm-forge"');
    assert.strictEqual(refusal(JSON.stringify({ items: [] })), "not a cadaclysm-blacksmith document: it names no format");
    assert.strictEqual(refusal("solid box"), "not a cadaclysm-blacksmith document (it is not JSON)");
}

// Another app's document (a notebook's: a held box, named and red, and a held profile) opens
// in forge: the held box is an item forge's tools take -- joined with a box of forge's -- the
// profile is listed, and the other app's nodes stay as they were through the commands and
// a save that opens to the same text.
{
    const box = wasm.cadaclysm_blacksmith_cuboid(40, 30, 20);
    const body = JSON.parse(wasm.cadaclysm_blacksmith_document_solid_body(box));
    wasm.cadaclysm_blacksmith_solid_free(box);
    const rect = wasm.cadaclysm_blacksmith_profile_rect(10, 6);
    const path = JSON.parse(wasm.cadaclysm_blacksmith_document_profile_path(rect));
    wasm.cadaclysm_blacksmith_profile_free(rect);
    const doc = wasm.cadaclysm_blacksmith_document_new("mm");
    const add = (node) => wasm.cadaclysm_blacksmith_document_apply(doc, JSON.stringify({ op: "add", node }), null);
    add({ id: "plate", kind: "solid.body", name: "Plate", meta: { colour: "#ff0000" }, body });
    add({ id: "outline", kind: "profile.path", name: "Outline", path });
    const notebook = JSON.parse(wasm.cadaclysm_blacksmith_document_save(doc)).nodes;
    {
        // Opened, the held nodes get forge's nodes in one commit; a document of forge's own
        // opens untouched.
        const opened = openDocument(wasm, wasm.cadaclysm_blacksmith_document_save(doc));
        const log = JSON.parse(wasm.cadaclysm_blacksmith_document_log(opened, "main"));
        assert.strictEqual(log[0].message, "forge: open", "the newest commit adopts the held nodes");
        assert.strictEqual(log.filter((c) => c.message === "forge: open").length, 1);
        assert.ok(JSON.parse(wasm.cadaclysm_blacksmith_document_save(opened)).nodes.some((n) => n.id === "i1"), "the held box has its node");
        wasm.cadaclysm_blacksmith_document_free(opened);
    }
    const items = itemsOf(doc);
    assert.deepStrictEqual(items.map((it) => [it.id, it.kind, it.name, it.node]), [[1, "held", "Plate", "plate"], [2, "held_profile", "Outline", "outline"]]);
    assert.strictEqual(items[0].look.colour, "#ff0000");
    command(wasm, doc, { op: "primitive", id: 3, kind: "box", plane: "top", dims: [10, 10, 40] });
    command(wasm, doc, { op: "join", id: 4, parts: [1, 3] });
    const statuses = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, false));
    assert.strictEqual(statuses.find((st) => st.id === "i4")?.state, "ok", JSON.stringify(statuses));
    const joined = wasm.cadaclysm_blacksmith_document_result_solid(doc, "i4");
    assert.ok(massOf(wasm, joined)[0] > 40 * 30 * 20, "the join is more than the plate");
    wasm.cadaclysm_blacksmith_solid_free(joined);
    const saved = wasm.cadaclysm_blacksmith_document_save(doc);
    assert.deepStrictEqual(JSON.parse(saved).nodes.slice(0, notebook.length), notebook, "the notebook's nodes, first and as they were");
    const again = openDocument(wasm, saved);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(again), saved);
    assert.deepStrictEqual(itemsOf(again).map((it) => it.id), [1, 2, 3, 4]);
    wasm.cadaclysm_blacksmith_document_free(again);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

console.log("forge-document.mjs: ok");
