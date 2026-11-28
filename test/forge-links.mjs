// Linked parts (forge-links.js): a part file brought in as a component with a link and a
// `component.derive` whose bodies are held bodies; what the part file offers (`partInfo`); the
// link's status (`linkRows`); an update takes the new copy in one undoable commit and only
// then do the bodies change; relink, break, edit, remove; a save and an open keep the part.
// Skipped (and says so) on a package without the link calls.
//
// Run: node test/forge-links.mjs   (after npm run setup)
import assert from "node:assert";
import { loadWasm } from "./package.mjs";
import { Model, UNITS, openDocument } from "../forge-model.js";
import { command } from "../forge-commands.js";
import { createForgeScene } from "../forge-scene.js";
import { hasLinks, partInfo, componentInfo, linkRows, components, partOf, nameOf, isKey, deriveId, bodyId } from "../forge-links.js";

const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
if (!hasLinks(wasm)) {
    console.log("skip: this package has no document links (the linked parts hide themselves)");
    process.exit(0);
}

// A part file's text: params, a w x 10 x h block marked as the body `puck`, and a second body.
function partText({ w = 20, h = 5, marked = true } = {}) {
    const doc = wasm[K + "document_new"]("mm");
    try {
        const apply = (op) => wasm[K + "document_apply"](doc, JSON.stringify(op), undefined);
        apply({ op: "param", name: "w", value: w });
        apply({ op: "param", name: "h", value: h });
        apply({ op: "add", node: { id: marked ? "c" : "i1", kind: "solid.cuboid", name: "Block", x: "=w", y: 10, z: "=h" } });
        apply({ op: "add", node: { id: marked ? "s" : "i2", kind: "solid.sphere", name: "Ball", r: 2 } });
        if (marked) {
            apply({ op: "add", node: { id: "b1", kind: "part.body", body: "puck", solids: ["c"] } });
            apply({ op: "add", node: { id: "b2", kind: "part.body", body: "ball", solids: ["s"] } });
        }
        return wasm[K + "document_save"](doc);
    } finally {
        wasm[K + "document_free"](doc);
    }
}

function over(doc) {
    const model = new Model(wasm, doc);
    const run = (cmd) => {
        wasm[K + "document_evaluate"](doc, false);
        return command(wasm, model, doc, cmd);
    };
    const volume = (id) => {
        const st = JSON.parse(wasm[K + "document_evaluate"](doc, false)).find((s) => s.id === id);
        assert.ok(st && !st.error, `${id}: ${JSON.stringify(st)}`);
        const s = wasm[K + "document_result_solid"](doc, id);
        // 34 doubles: four flags, area, its error, then the volume.
        try { return wasm[K + "mass_properties"](s, 0)[6]; } finally { wasm[K + "solid_free"](s); }
    };
    return { doc, model, run, volume };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${a} != ${b}`);

// ---- names and what a part offers
assert.equal(nameOf("parts/puck (2).json"), "puck_2");
assert.equal(nameOf("3d.json"), "part_3d");
assert.ok(isKey("i3") && !isKey("a b"));
const info = partInfo(wasm, partText());
assert.deepStrictEqual(info.bodies.map((b) => [b.key, b.ok]), [["puck", true], ["ball", true]]);
assert.equal(info.params.w, 20);
assert.equal(info.params.h, 5);
const forgeInfo = partInfo(wasm, partText({ marked: false }));
assert.deepStrictEqual(forgeInfo.bodies.map((b) => [b.key, b.name]), [["i1", "Block"], ["i2", "Ball"]]);
assert.throws(() => partInfo(wasm, "{}"), /not a cadaclysm-blacksmith document/);

// ---- insert
const t = over(wasm[K + "document_new"](UNITS));
const v1 = partText();
const out = t.run({ op: "part", name: "puck", path: "parts/puck.json", text: v1, bodies: [{ key: "puck", name: "puck" }], params: { w: "30" } });
assert.deepStrictEqual(out.changed.components, ["puck"]);
assert.deepStrictEqual(out.changed.links, ["puck"]);
const held = t.model.items().filter((it) => it.kind === "held");
assert.deepStrictEqual(held.map((it) => [it.node, it.name]), [[bodyId("puck", "puck"), "puck puck"]]);
assert.equal(t.model.node(deriveId("puck")).kind, "component.derive");
near(t.volume(bodyId("puck", "puck")), 30 * 10 * 5);   // the override, not the part's w
assert.deepStrictEqual(partOf(t.model, "puck").params, { w: 30 });
assert.deepStrictEqual(components(wasm, t.doc), ["puck"]);
assert.throws(() => t.run({ op: "part", name: "puck", path: "x.json", text: v1, bodies: ["puck"] }), /a part `puck` already/);
assert.throws(() => t.run({ op: "part", name: "two words", path: "x.json", text: v1, bodies: ["puck"] }), /not a part name/);

// the edit dialog reads the embedded copy when the file is not at hand
assert.deepStrictEqual(componentInfo(wasm, t.doc, "puck").bodies.map((b) => b.key), ["puck", "ball"]);
assert.equal(componentInfo(wasm, t.doc, "puck").params.w, 20);

// ---- status
let rows = linkRows(wasm, t.doc);
assert.deepStrictEqual(rows.map((r) => [r.name, r.path, r.status]), [["puck", "parts/puck.json", "missing"]]);
assert.equal(linkRows(wasm, t.doc, { "parts/puck.json": v1 })[0].status, "up_to_date");
const v2 = partText({ h: 8 });
assert.equal(linkRows(wasm, t.doc, { "parts/puck.json": v2 })[0].status, "changed");
near(t.volume(bodyId("puck", "puck")), 30 * 10 * 5);   // the copy holds until an update

// ---- a later command adopts the held body: it gets a head of its own, naming the node
t.run({ op: "part", name: "ball", path: "ball.json", text: v1, bodies: ["ball"] });
const adopted = t.model.items().find((it) => t.model.node(`i${it.id}`)?.meta?.forge?.node === bodyId("puck", "puck"));
assert.ok(adopted, "the puck's body has a head");
near(t.volume(`i${adopted.id}`), 30 * 10 * 5);

// ---- update: one commit, only the part's bodies move, undoable
const before = wasm[K + "document_revision"](t.doc);
const up = t.run({ op: "part_update", parts: { puck: v2 } });
assert.deepStrictEqual(up.changed.components, ["puck"]);
assert.equal(wasm[K + "document_revision"](t.doc), before + 1);
near(t.volume(`i${adopted.id}`), 30 * 10 * 8);
assert.equal(linkRows(wasm, t.doc, { "parts/puck.json": v2, "ball.json": v1 }).find((r) => r.name === "puck").status, "up_to_date");
wasm[K + "document_undo"](t.doc);
t.model.refresh(null);
near(t.volume(`i${adopted.id}`), 30 * 10 * 5);
wasm[K + "document_redo"](t.doc);
t.model.refresh(null);
near(t.volume(`i${adopted.id}`), 30 * 10 * 8);

// ---- edit: the override dropped, the second body ticked
t.run({ op: "part_edit", name: "puck", bodies: ["puck", "ball"], params: {} });
near(t.volume(`i${adopted.id}`), 20 * 10 * 8);
assert.ok(t.model.node(bodyId("puck", "ball")), "the ticked body is brought in");
t.run({ op: "part_edit", name: "puck", bodies: ["puck"], params: {} });
assert.equal(t.model.node(bodyId("puck", "ball")), undefined, "the unticked body goes");

// ---- relink and break
t.run({ op: "relink", name: "puck", path: "puck.json", auto: true });
rows = linkRows(wasm, t.doc, { "puck.json": v2 });
assert.deepStrictEqual(rows.find((r) => r.name === "puck"), { ...rows.find((r) => r.name === "puck"), path: "puck.json", auto_update: true, status: "up_to_date" });
const br = t.run({ op: "unlink", name: "puck" });
assert.deepStrictEqual(br.changed.links, ["puck"]);
assert.deepStrictEqual(linkRows(wasm, t.doc).map((r) => r.name), ["ball"]);
near(t.volume(`i${adopted.id}`), 20 * 10 * 8);   // the copy stays

// ---- save and open keep the parts
const saved = wasm[K + "document_save"](t.doc);
const reopened = openDocument(wasm, saved);
assert.deepStrictEqual(components(wasm, reopened), ["ball", "puck"]);
assert.deepStrictEqual(linkRows(wasm, reopened).map((r) => [r.name, r.path]), [["ball", "ball.json"]]);
wasm[K + "document_free"](reopened);

// ---- remove: its bodies go as a delete takes them, the component with them
const rm = t.run({ op: "part_remove", name: "puck" });
assert.ok(rm.changed.removed.includes(deriveId("puck")));
assert.equal(t.model.node(bodyId("puck", "puck")), undefined);
assert.equal(t.model.node(`i${adopted.id}`), undefined);
assert.deepStrictEqual(components(wasm, t.doc), ["ball"]);

// ---- the worker's replica: an update changes no node, yet the part's bodies build again
{
    const page = over(wasm[K + "document_new"](UNITS));
    const posted = [];
    const scene = createForgeScene({ wasm, post: (m) => posted.push(m), host: null });
    scene.open(wasm[K + "document_save"](page.doc));
    await scene.drain();
    const send = async (cmd) => { scene.op(JSON.stringify(page.run(cmd).op)); await scene.drain(); };
    await send({ op: "part", name: "pin", path: "pin.json", text: v1, bodies: ["puck"] });
    // Any command adopts the held body (its head written): the update below then adds nothing.
    await send({ op: "primitive", id: 50, kind: "box", plane: "top", dims: [1, 1, 1] });
    const pinItem = page.model.items().find((it) => page.model.node(`i${it.id}`)?.meta?.forge?.node === bodyId("pin", "puck"));
    assert.ok(pinItem, "the part's body is adopted");
    const builtOf = () => posted.filter((m) => m.kind === "built" && m.id === pinItem.id);
    posted.length = 0;
    await send({ op: "part_update", parts: { pin: v2 } });
    assert.equal(builtOf().length, 1, "the update posts the part's body again");
    posted.length = 0;
    await send({ op: "relink", name: "pin", path: "elsewhere.json", auto: false });
    assert.equal(builtOf().length, 0, "a relink alone builds nothing");
}
console.log("forge-links: ok");
