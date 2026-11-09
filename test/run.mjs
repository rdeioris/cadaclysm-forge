// `npm test`: every node test here, one process each, in order, against ./pkg (`npm run
// setup`). Stops at the first that fails; says how many ran.
//
//     node test/run.mjs                 # all of them
//     node test/run.mjs forge-scene     # those whose name contains a word
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(here, "..", "pkg", "cadaclysm_bg.wasm"))) {
    console.error("no pkg/: run `npm run setup` first");
    process.exit(1);
}
const words = process.argv.slice(2);
// browser.mjs is the headless-Chrome check (`npm run test:browser`), run.mjs this file,
// package.mjs the loader the others share.
const tests = readdirSync(here).filter((f) => f.endsWith(".mjs") && !["run.mjs", "package.mjs", "browser.mjs"].includes(f))
    .filter((f) => !words.length || words.some((w) => f.includes(w))).sort();
let passed = 0;
for (const t of tests) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [join(here, t)], { stdio: "inherit" });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (r.status !== 0) {
        console.error(`FAIL ${t} (exit ${r.status ?? r.signal}, ${seconds} s)`);
        console.error(`${passed} of ${tests.length} test files passed`);
        process.exit(1);
    }
    console.log(`pass ${t} (${seconds} s)`);
    passed++;
}
console.log(`${passed} of ${tests.length} test files passed`);
