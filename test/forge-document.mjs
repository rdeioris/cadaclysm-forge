// The forge page's document, checked without a browser: the sketch geometry the page draws and
// its sketch tools work with, asked of the kernel (forge-sketch.js; the fillet and the trim
// forge-commands.js's) -- a polycurve's chain, a sketch fillet, a polygon -- a body's place,
// the edge list and the closure in words (forge-curves.js), and the blacksmith document the
// page holds (its nodes the model, forge-model.js; the page's commands forge-commands.js's,
// over the kernel's public exports; a body's solid its node's
// `cadaclysm_blacksmith_document_result_solid`, read as the worker's scene reads it): the
// documents converted once from forge's 0.14 files (a version-1 file, a version-2 fillet's
// legacy edge numbering, a history), an old file refused in words, and another app's
// document.
//
// Run: node test/forge-document.mjs   (after npm run setup)
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadWasm } from "./package.mjs";
import { Model, openDocument } from "../forge-model.js";
import { command as commandOn, pageItems, sketchFillet, trimmedCurves } from "../forge-commands.js";
import { chainOf, curveBeziers, polygonPoints as kernelPolygon, trimPieces, closingSide, detectLoops } from "../forge-sketch.js";
import { Q, parseEdges, closureText } from "../forge-curves.js";
import { edgeList, massOf } from "../forge-scene.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasm = await loadWasm();
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8").replace(/\r\n/g, "\n");
// A file of the repo as forge-pins.json names it (examples/, test/fixtures/: node documents).
const repoFile = (name) => readFileSync(join(here, "..", name), "utf8").replace(/\r\n/g, "\n");
const pins = JSON.parse(fixture("forge-pins.json"));
const line = (x0, y0, x1, y1) => ({ kind: "line", shape: { x0, y0, x1, y1 } });
const chainPieces = (pieces) => chainOf(wasm, pieces);
const beziersOf = (c) => curveBeziers(wasm, c);
const polygonPoints = (s) => kernelPolygon(wasm, s);
// A page command on a document: its nodes mirrored, the document evaluated first (a pick reads
// the bodies built).
const models = new Map();
const modelOf = (doc) => { if (!models.has(doc)) models.set(doc, new Model(wasm, doc)); return models.get(doc); };
const command = (doc, cmd) => { wasm.cadaclysm_blacksmith_document_evaluate(doc, false); return commandOn(wasm, modelOf(doc), doc, cmd); };

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
    assert.throws(() => chainPieces([line(0, 0, 10, 0), { kind: "circle", shape: { cx: 10, cy: 0, r: 5 } }]), /piece 2 \(circle\)/);
    // The chaining is the kernel's (`Profile::chain`): a joint within the tolerance is the
    // chain's own point, and a loop within it closes on its start exactly.
    const gappy = chainPieces([line(0, 0, 10, 0), line(10.0005, 0, 10, 10), line(10, 10, 0.0004, 0)]);
    assert.ok(gappy.closed);
    assert.deepStrictEqual([gappy.beziers[16], gappy.beziers[17]], [10, 0], "the second line starts where the first ends");
    assert.deepStrictEqual([gappy.beziers[gappy.beziers.length - 4], gappy.beziers[gappy.beziers.length - 3]], [0, 0], "and the last lands on the start");
    assert.throws(() => chainPieces([]), /piece/);
    // The side that closes a chain (`profile_close_loop`): from its end back to its start;
    // none where they meet.
    assert.deepStrictEqual(closingSide(wasm, [line(0, 0, 10, 0), line(10, 0, 10, 10)]), [10, 10, 0, 0]);
    assert.strictEqual(closingSide(wasm, [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 0)]), null);
    // The loops curves' ends close (`profile_loops`): three lines end to end are one loop, a
    // fourth apart is none; an end that is not finite meets nothing.
    const ends = Float64Array.of(0, 0, 10, 0, 10, 0, 10, 10, 10, 10, 0, 0, 50, 50, 60, 60);
    assert.deepStrictEqual(Array.from(detectLoops(wasm, ends)), [3, 0, 1, 2]);
    assert.deepStrictEqual(Array.from(detectLoops(wasm, Float64Array.of(0, 0, NaN, 0, NaN, 0, 0, 0))), []);
}

// A sketch fillet (forge-commands.js's, the kernel's `profile_fillet_corner` / `profile_round`):
// a right-angle corner of two lines rounded by 5 has its tangent points 5 back along each leg
// and its middle on the bisector 5·(√2 − 1) in; a square becomes a closed polycurve of four
// lines and four arcs whose Béziers chain; a polycurve of two lines gets one arc; a radius
// that does not fit, or no corner, is refused.
{
    const corner = sketchFillet(wasm, [line(10, 0, 0, 0), line(0, 0, 0, 10)], 5).two;
    assert.ok(Math.abs(corner.a.shape.x1 - 5) < 1e-9 && Math.abs(corner.a.shape.y1) < 1e-9 && Math.abs(corner.b.shape.y0 - 5) < 1e-9, JSON.stringify(corner));
    const d = 5 * (Math.SQRT2 - 1) / Math.SQRT2;
    assert.ok(Math.abs(corner.arc.xm - d) < 1e-9 && Math.abs(corner.arc.ym - d) < 1e-9, JSON.stringify(corner.arc));
    assert.throws(() => sketchFillet(wasm, [line(10, 0, 0, 0), line(0, 0, -10, 0)], 5), "straight on: no corner");
    assert.throws(() => sketchFillet(wasm, [line(3, 0, 0, 0), line(0, 0, 0, 10)], 5), "a leg shorter than the tangent distance");
    const square = sketchFillet(wasm, [{ kind: "rect", shape: { x0: 0, y0: 0, x1: 20, y1: 20 } }], 4).one.shape;
    assert.deepStrictEqual(square.pieces.map((p) => p.kind).sort(), ["arc", "arc", "arc", "arc", "line", "line", "line", "line"]);
    assert.ok(square.closed);
    const chained = chainPieces(square.pieces);
    assert.ok(chained.closed, "the rounded square closes");
    assert.ok(chained.beziers.length / 16 >= 8 && chained.beziers.length / 16 <= 12, "four lines and four quarter arcs (an arc may split in two)");
    const open = sketchFillet(wasm, [{ kind: "polyline", shape: { points: [[0, 0], [10, 0], [10, 10]], closed: false } }], 3).one.shape;
    assert.deepStrictEqual(open.pieces.map((p) => p.kind), ["line", "arc", "line"]);
    assert.ok(!open.closed);
    assert.throws(() => sketchFillet(wasm, [{ kind: "rect", shape: { x0: 0, y0: 0, x1: 20, y1: 20 } }], 11));
    const two = sketchFillet(wasm, [{ kind: "polycurve", shape: { pieces: [line(10, 10, 10, 0), line(0, 0, 10, 0)], closed: false } }], 2).one.shape;
    assert.deepStrictEqual(two.pieces.map((p) => p.kind), ["line", "arc", "line"], "ordered and turned to chain, then rounded");
    assert.ok(!two.closed);
}

// The sketch trim: a line crossed by two others is three pieces, each drawn in its sketch and
// on its plane's frame (forge-sketch.js's `trimPieces`); the middle one removed leaves two
// curves, each a line again (forge-commands.js's `trimmedCurves`); a chain of lines is a
// polyline.
{
    const cutters = [line(10, -5, 10, 5), line(20, -5, 20, 5)];
    const front = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0];
    const pieces = trimPieces(wasm, line(0, 0, 30, 0), cutters, front);
    assert.strictEqual(pieces.length, 3, "cut twice, three pieces");
    assert.deepStrictEqual([pieces[1].beziers[0], pieces[1].beziers[1]], [10, 0], "the middle piece from the first crossing");
    assert.deepStrictEqual([pieces[1].world[0], pieces[1].world[1], pieces[1].world[2]], [10, 0, 0], "on the Front plane");
    const kept = trimmedCurves(wasm, line(0, 0, 30, 0), cutters, 1);
    assert.strictEqual(kept.length, 2, "the middle piece gone: two curves left");
    assert.deepStrictEqual(kept.map((c) => c.kind), ["line", "line"]);
    assert.ok(Math.abs(kept[0].shape.x1 - 10) < 1e-6 && Math.abs(kept[1].shape.x0 - 20) < 1e-6, JSON.stringify(kept));
    const corner = trimmedCurves(wasm, { kind: "polyline", shape: { points: [[0, 0], [30, 0], [30, 30]], closed: false } }, [line(10, -5, 10, 5)], 0);
    assert.deepStrictEqual(corner.map((c) => c.kind), ["polyline"]);
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
    const rounded = sketchFillet(wasm, [{ kind: "polygon", shape: hex }], 3).one.shape;
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
    command(doc, { op: "primitive", id: 1, kind: "box", plane: "top", dims: [20, 20, 20] });
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
    models.delete(doc);   // a handle is used again
}

// The document's figures of node `i<id>` against a pinned body (but those `skip` names).
function checkPinned(doc, file, skip = []) {
    wasm.cadaclysm_blacksmith_document_evaluate(doc, false);
    for (const pin of pins[file].bodies) {
        if (skip.includes(pin.id)) continue;
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
const itemsOf = (doc) => pageItems(new Model(wasm, doc));

// A version-1 file (the items as they were, no history), converted, is one commit: its items
// by id, name and kind, every body built as the page built it but the join, whose parts a
// version-1 file held inline (a stand-in: test/fixtures/golden/ACCEPTED.md), and it saves to
// its own text.
{
    const name = "test/fixtures/forge-v1.json";
    const text = repoFile(name);
    assert.strictEqual(JSON.parse(text).format, "cadaclysm-blacksmith");
    const doc = openDocument(wasm, text);
    assert.deepStrictEqual(itemsOf(doc).map((it) => [it.id, it.name, it.kind]), pins[name].items.map((it) => [it.id, it.name, it.kind]));
    const log = JSON.parse(wasm.cadaclysm_blacksmith_document_log(doc, "main"));
    assert.strictEqual(log.length, 2, "the root and the one commit of the conversion");
    assert.strictEqual(log[0].message, "forge: converted from a 0.14 file");
    const statuses = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, false));
    assert.strictEqual(statuses.find((s) => s.id === "i1")?.state, "ok", "i1 builds");
    assert.strictEqual(statuses.find((s) => s.id === "i2")?.state, "error", "the join is a stand-in");
    checkPinned(doc, name, [2]);
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
    const doc = openDocument(wasm, repoFile(file));
    const fillet = itemsOf(doc).find((it) => it.kind === "fillet");
    assert.strictEqual(fillet.edgeNumbering, 1, "the fillet's edges are in the old numbering");
    assert.ok(Array.isArray(fillet.edgeRefs) && fillet.edgeRefs.length > 0, "and it carries their references");
    const legacy = pins[file].items.find((it) => it.id === fillet.id).edges;
    assert.deepStrictEqual(fillet.edges, legacy, "the indices as the old file wrote them");
    checkPinned(doc, file);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// A forge history with an undone tail (the old file's head 7 of its 9 commands), converted,
// opens at the head: the items the page held there, in one commit of the conversion (none of
// the 0.14 history), `main` at it. Taken back to the root and replayed, redo stops at the
// head again, with the same items and the same save.
{
    const file = "examples/kinds-history.json";
    const head = 1;
    const doc = openDocument(wasm, repoFile(file));
    const items = () => itemsOf(doc).map((it) => [it.id, it.name]);
    const atHead = items(), saved = wasm.cadaclysm_blacksmith_document_save(doc);
    assert.deepStrictEqual(atHead, pins[file].items.map((it) => [it.id, it.name]), "the items the page held at the head");
    const branches = JSON.parse(wasm.cadaclysm_blacksmith_document_branch_list(doc));
    assert.strictEqual(branches.branch, "main");
    assert.strictEqual(branches.can_redo, false, "main ends at the head");
    assert.strictEqual(JSON.parse(wasm.cadaclysm_blacksmith_document_log(doc, "main")).length, head + 1, "the conversion's commit, and the root");
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

// A blacksmith document the kernel cannot load is refused in the kernel's own words, as the
// page's error line shows them (`load: <message>`, forge.js `loadDocument`'s callers): a node
// of a kind the kernel has not, the message as `document_load` throws it (less the call's
// name). A forge file of 0.14 (test/fixtures/v014-sample.json) is such a document once the
// kernel has no `forge.*` kinds: refused naming one.
{
    const refusal = (text) => { try { openDocument(wasm, text); } catch (e) { return String(e?.message ?? e); } return null; };
    const kernelSays = (text) => { try { wasm.cadaclysm_blacksmith_document_load(text); } catch (e) { return String(e?.message ?? e); } return null; };
    const text = JSON.stringify({ format: "cadaclysm-blacksmith", version: 1, units: "mm", nodes: [{ id: "i1", kind: "forge.no_such_kind" }] });
    const said = kernelSays(text);
    assert.ok(said !== null, "the kernel refuses a kind it has not");
    assert.strictEqual(refusal(text), said.replace(/^document_load: /, ""), "the kernel's message, unchanged");
    assert.match(refusal(text), /forge\.no_such_kind/);
    const v014 = fixture("v014-sample.json");
    const old = refusal(v014);
    if (old === null) {
        console.log("forge-document.mjs: the 0.14-file refusal skipped -- this kernel still has the `forge.*` kinds, so it loads a 0.14 forge file");
    } else {
        assert.match(old, /forge\./, `a 0.14 file is refused naming a forge.* kind: ${old}`);
        assert.strictEqual(old, kernelSays(v014).replace(/^document_load: /, ""));
    }
}

// Another app's document (a notebook's: a held box, named and red, and a held profile) opens
// in forge untouched: the held box is an item forge's tools take -- joined with a box of
// forge's, the first command giving the held items heads of their own under the numbers they
// show (forge-commands.js's adoption) -- the profile is listed, and the other app's nodes stay
// as they were through the commands and a save that opens to the same text.
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
        // Opened, nothing is written: the document saves as it was.
        const text = wasm.cadaclysm_blacksmith_document_save(doc);
        const opened = openDocument(wasm, text);
        assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(opened), text, "an open writes nothing");
        wasm.cadaclysm_blacksmith_document_free(opened);
    }
    const items = itemsOf(doc);
    assert.deepStrictEqual(items.map((it) => [it.id, it.kind, it.name, it.node]), [[1, "held", "Plate", "plate"], [2, "held_profile", "Outline", "outline"]]);
    assert.strictEqual(items[0].look.colour, "#ff0000");
    command(doc, { op: "primitive", id: 3, kind: "box", plane: "top", dims: [10, 10, 40] });
    assert.ok(modelOf(doc).node("i1") && modelOf(doc).node("i2"), "the first command gives the held items their heads");
    assert.deepStrictEqual(itemsOf(doc).map((it) => [it.id, it.kind, it.node]), [[1, "held", "plate"], [2, "held_profile", "outline"], [3, "box", undefined]]);
    command(doc, { op: "join", id: 4, parts: [1, 3] });
    const statuses = JSON.parse(wasm.cadaclysm_blacksmith_document_evaluate(doc, false));
    assert.strictEqual(statuses.find((st) => st.id === "i4")?.state, "ok", JSON.stringify(statuses));
    const joined = wasm.cadaclysm_blacksmith_document_result_solid(doc, "i4");
    assert.ok(massOf(wasm, joined)[0] > 40 * 30 * 20, "the join is more than the plate");
    wasm.cadaclysm_blacksmith_solid_free(joined);
    const saved = wasm.cadaclysm_blacksmith_document_save(doc);
    const theirs = new Set(notebook.map((n) => n.id));
    assert.deepStrictEqual(JSON.parse(saved).nodes.filter((n) => theirs.has(n.id)), notebook, "the notebook's nodes, in their order and as they were");
    const again = openDocument(wasm, saved);
    assert.strictEqual(wasm.cadaclysm_blacksmith_document_save(again), saved);
    assert.deepStrictEqual(itemsOf(again).map((it) => it.id), [1, 2, 3, 4]);
    wasm.cadaclysm_blacksmith_document_free(again);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// The extrude on the 110-step document (examples/kinds-made.json: 110 nodes, the document the
// 0.14 layer's ~48 ms commit was measured on) costs what its own batch costs: the page's
// `command()` (forge-commands.js) for a solid off a new rect, a median of 9 (after one
// warm-up), each on the document freshly opened, at most 6.5 ms -- the Rust command layer's
// figure. A loaded machine can miss it: rerun this file alone before blaming a change.
{
    const text = repoFile("examples/kinds-made.json");
    const times = [];
    for (let run = 0; run < 10; run++) {
        const doc = openDocument(wasm, text);
        const model = new Model(wasm, doc);
        const id = model.forgeMeta().nextId;
        commandOn(wasm, model, doc, { op: "add", id, kind: "rect", plane: "top", shape: { x0: 100, y0: 100, x1: 120, y1: 110 } });
        const t = performance.now();
        commandOn(wasm, model, doc, { op: "solid", id: id + 1, from: id, height: 15, taper: 0 });
        if (run > 0) times.push(performance.now() - t);
        assert.strictEqual(model.node(`i${id + 1}`)?.kind, "solid.extrude", "the extrude is a node of its own");
        wasm.cadaclysm_blacksmith_document_free(doc);
    }
    times.sort((a, b) => a - b);
    const median = times[4];
    assert.ok(median <= 6.5, `the extrude took ${median.toFixed(2)} ms (median of 9: ${times.map((x) => x.toFixed(2)).join(" ")}), over 6.5 ms`);
}

console.log("forge-document.mjs: ok");
