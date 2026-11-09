// The forge's STEP download, off the worker's scene: the visible bodies' exact B-reps
// (`cadaclysm_blacksmith_document_result_solid`) as one STEP file -- one body through
// `cadaclysm_blacksmith_step`, named; several through `cadaclysm_blacksmith_step_assembly`,
// each a part named as the forge names it. The text is an ISO 10303-21 exchange file with
// one MANIFOLD_SOLID_BREP per body, and every handle the export took is freed.
//
// Run: node test/forge-step.mjs   (after npm run setup)
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadWasm } from "./package.mjs";
import { createForgeScene } from "../forge-scene.js";
import { command, toJson } from "../forge-doc-convert.js";
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const wasm = await loadWasm();
const pins = JSON.parse(readFileSync(join(here, "fixtures", "forge-pins.json"), "utf8"));

const harness = () => { const posted = []; return { s: createForgeScene({ wasm, post: (m) => posted.push(m) }), posted }; };
const count = (text, word) => text.split(`${word}(`).length - 1;
// The export's text, checked: an exchange file, its bodies named, a MANIFOLD_SOLID_BREP each.
function stepOf(s, posted, ids, names, req) {
    s.exportFile({ req, format: "step", ids, names, looks: {}, text: false, tolerance: 0.02 });
    const out = posted.at(-1);
    assert.strictEqual(out.kind, "exported", out.error);
    assert.deepStrictEqual([out.req, out.bodies, out.triangles], [req, ids.length, 0]);
    const text = new TextDecoder().decode(out.bytes);
    assert.ok(text.startsWith("ISO-10303-21;"), text.slice(0, 40));
    assert.ok(text.trimEnd().endsWith("END-ISO-10303-21;"));
    assert.strictEqual(count(text, "MANIFOLD_SOLID_BREP"), ids.length, "one MANIFOLD_SOLID_BREP a body");
    for (const id of ids) assert.ok(new RegExp(`PRODUCT\\('[^']*','${names[id]}'`).test(text), `body ${id} named ${names[id]}`);
    return text;
}
// The solid handles live: an export takes some and frees them all.
const live = () => { const probe = wasm.cadaclysm_blacksmith_cuboid(1, 1, 1); wasm.cadaclysm_blacksmith_solid_free(probe); return probe; };

// Two bodies made as the page makes them, and one alone.
{
    const doc = wasm.cadaclysm_blacksmith_document_new("mm"), { s, posted } = harness();
    s.open(wasm.cadaclysm_blacksmith_document_save(doc)); await s.drain();
    for (const cmd of [
        { op: "primitive", id: 1, kind: "box", plane: "top", dims: [20, 20, 20] },
        { op: "primitive", id: 2, kind: "cylinder", plane: "top", dims: [6, 30] },
    ]) s.op(toJson(command(wasm, doc, cmd).op));
    await s.drain();
    const before = live();
    stepOf(s, posted, [1, 2], { 1: "Plate", 2: "Peg", file: "forge" }, 1);
    stepOf(s, posted, [2], { 2: "Peg", file: "peg" }, 2);
    assert.strictEqual(posted.at(-1).name, "peg");
    assert.strictEqual(live(), before, "every solid handle the exports took is freed");
    s.exportFile({ req: 3, format: "step", ids: [99], names: {}, looks: {}, text: false, tolerance: 0.02 });
    assert.deepStrictEqual([posted.at(-1).kind, posted.at(-1).req], ["exportFailed", 3]);
    wasm.cadaclysm_blacksmith_document_free(doc);
}

// Every pinned document of several solid bodies, all of them in one file.
let files = 0, bodies = 0;
for (const [file, pin] of Object.entries(pins)) {
    const { s, posted } = harness();
    s.open(readFileSync(join(repo, file), "utf8")); await s.drain();
    const ids = pin.bodies.map((b) => b.id).filter((id) => s.solidOf(id) && wasm.cadaclysm_blacksmith_document_result_kind(s.doc, `i${id}`) === "solid"
        && (() => { const h = wasm.cadaclysm_blacksmith_document_result_solid(s.doc, `i${id}`); try { return wasm.cadaclysm_blacksmith_lump_count(h) === 1; } finally { wasm.cadaclysm_blacksmith_solid_free(h); } })());
    if (ids.length < 2) continue;
    stepOf(s, posted, ids, Object.fromEntries(ids.map((id) => [id, `Body ${id}`])), 10 + files);
    files++; bodies += ids.length;
}
assert.ok(files >= 1, "a pinned document of several solid bodies");

console.log(`ok - forge step: two bodies and one, and ${files} pinned documents (${bodies} bodies), one MANIFOLD_SOLID_BREP a body`);
