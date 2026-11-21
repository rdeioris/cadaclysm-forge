// examples/pattern-mirror.json: the four pattern and mirror tools in one document, written
// through the page's own commands (forge-commands.js `command`, as test/forge-commands.mjs
// runs them) and saved with `cadaclysm_blacksmith_document_save`:
//
// 1. a plate, 80 x 80 x 5;
// 2. a sketch on the plate's top face, one circle on it sketch-patterned 6 about the sketch
//    origin, each circle a surface extruded down through the plate, the six tools joined
//    and cut out of it;
// 3. a standoff (a cylinder) on the plate, body-patterned 6 about Z;
// 4. a leg (a box under the plate, one side on the YZ plane), mirrored across Right as a
//    new body.
//
// Its STEP file holds 9 solids: the plate, 6 standoffs (the source and its 5 instances) and
// 2 legs (the source and its mirror).
//
//     node scripts/pattern-example.mjs      (after npm run setup)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm } from "../test/package.mjs";
import { Model, UNITS } from "../forge-model.js";
import { command } from "../forge-commands.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
const doc = wasm[K + "document_new"](UNITS);
const model = new Model(wasm, doc);

// One command as the page sends it, the document evaluated first (a face pick reads it).
function run(cmd) {
    wasm[K + "document_evaluate"](doc, false);
    command(wasm, model, doc, cmd);
}
// The next id, as the page's `nextId` reads it off the forge meta; `n` of them, reserved.
const nextId = () => JSON.parse(wasm[K + "document_meta"](doc, "forge") ?? "null")?.nextId ?? 1;
const ids = (from, n) => Array.from({ length: n }, (_, k) => from + k);

// The face of body item `id` whose normal is +Z at height `z`: the plate's top.
function topFace(id, z) {
    wasm[K + "document_evaluate"](doc, false);
    const s = wasm[K + "document_result_solid"](doc, `i${id}`);
    try {
        for (let f = 0; f < wasm[K + "face_count"](s); f++) {
            const fr = wasm[K + "face_frame"](s, f);
            if (Math.abs(fr[2] - z) < 1e-9 && Math.abs(fr[11] - 1) < 1e-9) return f;
        }
    } finally {
        wasm[K + "solid_free"](s);
    }
    throw new Error(`#${id} has no top face at z ${z}`);
}

const T = 5;   // the plate's thickness

// 1. The plate.
const plate = nextId();
run({ op: "primitive", id: plate, kind: "box", plane: "top", dims: [80, 80, T] });

// 2. The bolt circle: a sketch on the plate's top, a circle at (25, 0), six of it about the
// sketch origin, the six one surface, raised down through the plate, cut out of it.
const sketch = nextId();
run({ op: "sketch", id: sketch, mode: "face", face: { body: plate, index: topFace(plate, T) } });
const hole = nextId();
run({ op: "add", id: hole, kind: "circle", plane: sketch, shape: { cx: 25, cy: 0, r: 4 } });
// 5 copies and the pattern's 2 construction step lines.
run({ op: "sketch_pattern", sketch, ids: [hole], type: "circular", centre: null, count: 6, angle: 360, copies: ids(nextId(), 7) });
const circles = model.items().filter((it) => it.kind === "circle").map((it) => it.id);
if (circles.length !== 6) throw new Error(`${circles.length} circles on the sketch, not 6`);
// Each closed profile its own surface and its own tool (a surface's loops nest: one boundary,
// holes inside it), the six tools one join, cut out of the plate in one cut.
const tools = [];
for (const c of circles) {
    const surface = nextId();
    run({ op: "surface", id: surface, plane: sketch, loops: [[c]] });
    const tool = nextId();
    run({ op: "solid", id: tool, from: surface, height: -2 * T, taper: 0 });
    tools.push(tool);
}
const holes = nextId();
run({ op: "join", id: holes, parts: tools, flush: true });
run({ op: "cut", id: nextId(), parts: [plate, holes], flush: true });

// 3. A standoff on the plate, between two holes, and five more about Z.
const standoff = nextId();
run({ op: "primitive", id: standoff, kind: "cylinder", plane: "top", dims: [4, 12] });
run({ op: "set", id: standoff, place: { offset: [35 * Math.cos(Math.PI / 6), 35 * Math.sin(Math.PI / 6), T], turn: [0, 0, 0] } });
const pattern = nextId();
run({ op: "pattern", id: pattern, sources: [standoff], type: "circular", axis: "z", count: 6, angle: 360, instances: ids(pattern + 1, 5) });

// 4. A leg under the plate, its inner side on the YZ plane, and its mirror across Right.
const leg = nextId();
run({ op: "primitive", id: leg, kind: "box", plane: "top", dims: [6, 70, 20] });
run({ op: "set", id: leg, place: { offset: [3, 0, -20], turn: [0, 0, 0] } });
const mirror = nextId();
run({ op: "mirror", id: mirror, objects: "bodies", sources: [leg], plane: "right", operation: "new", instances: [mirror + 1] });

// Every node built.
const failed = JSON.parse(wasm[K + "document_evaluate"](doc, false)).filter((s) => s.state !== "ok");
if (failed.length) throw new Error(`nodes not built: ${JSON.stringify(failed)}`);

const out = join(root, "examples", "pattern-mirror.json");
writeFileSync(out, wasm[K + "document_save"](doc));
console.log(`wrote ${out}: ${model.items().length} items`);
wasm[K + "document_free"](doc);
