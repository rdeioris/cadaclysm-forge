// Writes test/fixtures/links-pin.json and links-pin-v2.json: the part files the browser
// check's linked part comes from (a pin of radius r, 10 high, on a 2-high r + 2 head, marked
// as the body `pin`), v2 with r 4 for 3. Run once: node test/fixtures/make-links-parts.mjs
import { writeFileSync } from "node:fs";
import { loadWasm } from "../package.mjs";
const wasm = await loadWasm();
const K = "cadaclysm_blacksmith_";
for (const [file, r] of [["links-pin.json", 3], ["links-pin-v2.json", 4]]) {
    const doc = wasm[K + "document_new"]("mm");
    const apply = (op) => wasm[K + "document_apply"](doc, JSON.stringify(op), undefined);
    apply({ op: "param", name: "r", value: r });
    apply({ op: "add", node: { id: "shank", kind: "solid.cylinder", r: "=r", h: 10 } });
    apply({ op: "add", node: { id: "head", kind: "solid.cylinder", r: "=r + 2", h: 2 } });
    apply({ op: "add", node: { id: "pin_solid", kind: "solid.join", solids: ["shank", "head"] } });
    apply({ op: "add", node: { id: "body", kind: "part.body", body: "pin", solids: ["pin_solid"] } });
    writeFileSync(new URL(file, import.meta.url), wasm[K + "document_save"](doc));
    wasm[K + "document_free"](doc);
}
console.log("wrote links-pin.json, links-pin-v2.json");
