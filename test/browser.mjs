// The headless-Chrome check: the page served by scripts/serve.mjs, in a Chrome or Edge you
// have installed, driven over the DevTools protocol (Node's own WebSocket: no dependency).
// For each example asked: the page opens it, every body builds with no error, the bodies
// draw (a pick in the views lands on one), the STEP button -- offered once a closed solid is
// built -- downloads a STEP file with at least one solid in it, and nothing is logged as an
// error by the page or its worker. Then the snap check: in box-fillet's Top view, with real
// pointer events, a line drawn onto two of the box's corners lands on them exactly, grid
// snaps land on the step, Alt snaps nothing, and Measure reads a box edge's length.
//
//     npm run test:browser                          # examples/box-fillet.json, the default backend
//     node test/browser.mjs --webgl2                # the WebGL2 fallback (?backend=webgl2)
//     node test/browser.mjs --example plate-peg --example cut-shell
//     node test/browser.mjs --all                   # every example
//     node test/browser.mjs --out test/out          # also a screenshot of each, and the STEP files
//     node test/browser.mjs --chrome <path to chrome or msedge>   (or the CHROME variable)
//     node test/browser.mjs --headed                # watch it
//     node test/browser.mjs --no-snap               # the examples alone, no snap check
//
// Needs `npm run setup` first. Exits 1 on the first example that fails.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const options = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const W = 1600, H = 1000;

function findChrome() {
    const given = options("--chrome")[0] ?? process.env.CHROME;
    if (given) return given;
    const candidates = process.platform === "win32"
        ? [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [
            join(d, "Google", "Chrome", "Application", "chrome.exe"), join(d, "Microsoft", "Edge", "Application", "msedge.exe")])
        : process.platform === "darwin"
            ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
            : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
                "/usr/bin/microsoft-edge"];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error("no Chrome or Edge found: pass --chrome <path> or set CHROME");
    return found;
}

const freePort = () => new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

// ---- a DevTools connection: one WebSocket to the browser, flat sessions ------------------
class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.next = 0;
        this.waiting = new Map();
        this.handlers = [];
        this.ws.onmessage = ({ data }) => {
            const m = JSON.parse(data);
            if (m.id !== undefined) {
                const w = this.waiting.get(m.id);
                this.waiting.delete(m.id);
                if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`)); else w?.resolve(m.result);
            } else for (const h of this.handlers) h(m);
        };
    }
    open() { return new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = () => fail(new Error("DevTools connection failed")); }); }
    send(method, params = {}, sessionId) {
        const id = ++this.next;
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject, method }));
    }
    on(fn) { this.handlers.push(fn); }
    close() { this.ws.close(); }
}

async function launch(chrome, profile) {
    const flags = [`--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${W},${H}`, "--no-first-run",
        "--no-default-browser-check", "--disable-extensions", "--enable-unsafe-webgpu", "--hide-scrollbars", "about:blank"];
    if (!flag("--headed")) flags.unshift("--headless=new");
    const child = spawn(chrome, flags, { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    const text = await until("Chrome's DevTools port", () => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n") && readFileSync(portFile, "utf8"), 30000);
    const [port, path] = text.trim().split("\n");
    return { child, url: `ws://127.0.0.1:${port}${path}` };
}

// ---- the forge in a fresh tab, an example loaded ------------------------------------------
// `{ send, evaluate, errors, done, downloads, backend, close }`: the tab's own DevTools calls,
// what its page and worker logged as errors, the downloads' states and folder.
async function openForge(cdp, base, name, { webgl2 }) {
    const errors = [];
    const downloads = mkdtempSync(join(tmpdir(), "forge-step-"));
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessions = new Set([sessionId]);
    const label = (s) => (s === sessionId ? "page" : "worker");
    const done = new Map();   // download guid -> state
    cdp.on((m) => {
        if (m.method === "Browser.downloadProgress") done.set(m.params.guid, m.params.state);
        if (!sessions.has(m.sessionId)) return;
        if (m.method === "Runtime.exceptionThrown") {
            const d = m.params.exceptionDetails;
            errors.push(`${label(m.sessionId)}: ${d.exception?.description ?? d.text}`);
        } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
            errors.push(`${label(m.sessionId)} console.error: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
        } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
            errors.push(`${label(m.sessionId)} log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
        } else if (m.method === "Target.attachedToTarget") {
            // The forge worker (and any other): its console and exceptions too.
            const s = m.params.sessionId;
            sessions.add(s);
            cdp.send("Runtime.enable", {}, s).catch(() => {});
            cdp.send("Log.enable", {}, s).catch(() => {});
            cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
        }
    });
    const send = (method, params) => cdp.send(method, params, sessionId);
    async function evaluate(expression) {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
    }
    async function close() {
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
        // Chrome can hold the download folder a moment after the tab closes (EBUSY on Windows):
        // retried, and a folder left in the temp folder is no failure.
        try { rmSync(downloads, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left behind */ }
    }
    try {
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        await send("Runtime.enable");
        await send("Log.enable");
        await send("Page.enable");
        // In front, with focus: a background tab gets no animation frames, and the page draws on them.
        await send("Page.bringToFront");
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
        await send("Page.navigate", { url: `${base}/?test${webgl2 ? "&backend=webgl2" : ""}` });
        // The hook is installed once the first View is made.
        await until("the page's View", () => evaluate("!!window.__forgeTest"), 60000);
        const backend = await evaluate("window.__forgeTest.backend()");
        await evaluate(`(async () => { const text = await (await fetch("examples/${name}.json")).text(); await window.__forgeTest.load(text); })()`);
        return { send, evaluate, errors, done, downloads, backend, close };
    } catch (e) {
        await close();
        throw e;
    }
}

// ---- one example in a fresh tab ----------------------------------------------------------
async function checkExample(cdp, base, name, { webgl2, out, pins }) {
    const { send, evaluate, errors, done, downloads, backend, close } = await openForge(cdp, base, name, { webgl2 });
    try {
        const bodies = await evaluate("window.__forgeTest.bodies()");
        const status = await evaluate("window.__forgeTest.status()");
        if (status.error) throw new Error(`the status line says: ${status.text}`);
        // Every body built as the pins have it: an error exactly where the pin has one.
        const pinned = pins[`examples/${name}.json`]?.bodies ?? [];
        const failed = bodies.filter((b) => b.error !== null && !pinned.some((p) => p.id === b.id && p.error));
        if (failed.length) throw new Error(`bodies with errors: ${failed.map((b) => `${b.id} ${b.kind}: ${b.error}`).join("; ")}`);
        if (pinned.length && bodies.length !== pinned.length) throw new Error(`${bodies.length} bodies, the pins have ${pinned.length}`);
        const built = bodies.filter((b) => b.error === null);
        if (!built.length) throw new Error("no body built");
        if (built.some((b) => !b.faces)) throw new Error(`a body has no faces: ${JSON.stringify(built.find((b) => !b.faces))}`);
        // Drawn: framed (F, as a user frames), then the faces under the points of the views.
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, text: "f" });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
        await sleep(500);
        // A grid of points in each view shown, finer until one lands on a body: a body may be
        // small beside the curves the framing takes in, or a sheet seen nearly edge on.
        const hits = await evaluate(`(async () => {
            const t = window.__forgeTest, rects = t.rects();
            for (const [nx, ny] of [[40, 25], [120, 75]]) {
                const hits = [];
                for (let v = 0; v < rects.length; v++) {
                    const [, , w, h] = rects[v];
                    if (w <= 0 || h <= 0) continue;
                    for (let gy = 1; gy < ny; gy++) for (let gx = 1; gx < nx; gx++) {
                        const hit = await t.pick(v, w * gx / nx, h * gy / ny);
                        if (hit) hits.push({ view: v, body: hit.body });
                    }
                }
                if (hits.length) return hits;
            }
            return [];
        })()`);
        const seen = new Set(hits.map((h) => h.body));
        if (!hits.length) throw new Error("no pick in any view landed on a body: nothing drawn");
        // The STEP download: the button, as a user clicks it. The page offers it once a solid is
        // built (a document of surfaces alone has none to write).
        let stepName = null, step = null, breps = 0;
        const solidBuilt = built.some((b) => b.closure?.closed);
        const offered = !(await evaluate(`document.getElementById("step").disabled`));
        if (offered !== solidBuilt) throw new Error(`the STEP button is ${offered ? "on" : "off"} with ${solidBuilt ? "a" : "no"} closed solid built`);
        if (offered) {
            await evaluate(`document.getElementById("step").click()`);
            await until("the STEP download", () => [...done.values()].includes("completed") && readdirSync(downloads).find((f) => /\.step$/i.test(f)), 120000);
            stepName = readdirSync(downloads).find((f) => /\.step$/i.test(f));
            step = readFileSync(join(downloads, stepName), "utf8");
            if (!step.startsWith("ISO-10303-21;")) throw new Error(`${stepName} is not a STEP file`);
            breps = (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length;
            if (breps < 1) throw new Error(`${stepName} has no solid`);
        }
        await sleep(300);   // late console errors
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        if (out) {
            mkdirSync(out, { recursive: true });
            await evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
            await sleep(500);
            const shot = await send("Page.captureScreenshot", { format: "png" });
            const png = join(out, `${name}${webgl2 ? "-webgl2" : ""}.png`);
            writeFileSync(png, Buffer.from(shot.data, "base64"));
            if (step) writeFileSync(join(out, `${name}${webgl2 ? "-webgl2" : ""}.step`), step);
        }
        console.log(`ok - ${name}: ${backend}, ${built.length} bod${built.length === 1 ? "y" : "ies"} built, ${seen.size} picked in the views (${hits.length} hits), ` +
            (step ? `${stepName} ${(step.length / 1024).toFixed(0)} KB with ${breps} solid${breps === 1 ? "" : "s"}` : "no closed solid, so no STEP offered"));
    } catch (e) {
        // What the page showed when it failed, beside the screenshots of those that passed.
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `${name}${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await close();
    }
}

// ---- snapping, with real pointer events ------------------------------------------------
// box-fillet: a 20 mm box about the origin, its bottom edges filleted, so its top corners
// (+-10, +-10, 10) are sharp vertices -- what Top looks down on.
async function checkSnap(cdp, base, { webgl2, out }) {
    const { send, evaluate, errors, close } = await openForge(cdp, base, "box-fillet", { webgl2 });
    const frame = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    // Overlay CSS pixels to the page's, for Input.dispatchMouseEvent.
    const origin = await evaluate(`(() => { const r = document.getElementById("overlay").getBoundingClientRect(); return [r.left, r.top]; })()`);
    const at = async (p) => {
        const q = await evaluate(`window.__forgeTest.screenOf(0, ${JSON.stringify(p)})`);
        if (!q) throw new Error(`no pixel for ${JSON.stringify(p)} in Top`);
        return [origin[0] + q[0], origin[1] + q[1]];
    };
    const mouse = (type, [x, y], alt = false) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, modifiers: alt ? 1 : 0, pointerType: "mouse" });
    // A hover, a pause for the View's answer, a click: as a user aims and clicks.
    async function click(px, alt = false) {
        await mouse("mouseMoved", [px[0] - 6, px[1] - 6], alt);
        await mouse("mouseMoved", px, alt);
        await sleep(250);
        await mouse("mousePressed", px, alt);
        await mouse("mouseReleased", px, alt);
        await sleep(100);
    }
    const near = ([x, y]) => [x + 3, y - 2];   // a few pixels off: inside the snap's 10
    const lines = async () => (await evaluate("window.__forgeTest.items()")).filter((c) => c.kind === "line");
    async function drawLine(a, b, alt = false) {
        const before = (await lines()).length;
        await evaluate(`document.querySelector("#ribbon-sketch [data-kind=line]").click()`);
        await frame(); await sleep(300); await frame();
        await click(await a(), alt);
        await click(await b(), alt);
        await evaluate("window.__forgeTest.settled()");
        // Done, not still in hand: both clicks were the page's (a click off the view never reaches it).
        if (await evaluate(`document.querySelector("#ribbon-sketch [data-kind=line]").getAttribute("aria-pressed")`) === "true") throw new Error("the line is still being drawn after its second click");
        const now = await lines();
        if (now.length !== before + 1) throw new Error(`${now.length - before} lines drawn, not one`);
        const s = now[now.length - 1].shape;
        return [[s.x0, s.y0], [s.x1, s.y1]];
    }
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
    const text = (p) => `(${p.map((v) => +v.toFixed(9)).join(", ")})`;
    try {
        // Top filling the area, framed.
        await evaluate(`document.querySelector('#viewbar [data-view="0"]').click()`);
        await frame(); await sleep(300);
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, text: "f" });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
        await frame(); await sleep(500); await frame();
        await evaluate(`window.__forgeTest.snap({ on: true, kinds: { vertex: true, midpoint: true, centre: true, quadrant: true, edge: true, face: false, grid: false }, step: 10 })`);

        // 1. Measure: two corners of one top edge, 20 mm apart.
        await evaluate(`document.getElementById("measure").click()`);
        await frame();
        await click(near(await at([10, 10, 10])));
        await click(near(await at([10, -10, 10])));
        const status = await evaluate("window.__forgeTest.status()");
        if (status.error || !/^L 20 mm/.test(status.text)) throw new Error(`Measure says "${status.text}", not L 20 mm`);
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

        // A pointer held still over a view while a curve tool is in hand asks the View once,
        // not again with every answer (a loop that froze the page on a real GPU).
        await evaluate(`document.querySelector("#ribbon-sketch [data-kind=line]").click()`);
        await frame(); await sleep(300);
        await mouse("mouseMoved", await at([30, 30, 0]));
        await sleep(200);
        const asks0 = await evaluate("window.__forgeTest.snapAsks()");
        await sleep(1000);
        const asks = (await evaluate("window.__forgeTest.snapAsks()")) - asks0;
        if (asks > 1) throw new Error(`a pointer held still asked the View for ${asks} snaps in a second`);
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await frame();

        // 2. Onto two corners: the ends are the corners' x and y.
        const [a, b] = await drawLine(async () => near(await at([10, 10, 10])), async () => near(await at([-10, 10, 10])));
        if (!same(a, [10, 10]) || !same(b, [-10, 10])) throw new Error(`the line onto the corners is ${text(a)} -> ${text(b)}, not (10, 10) -> (-10, 10)`);

        // 3. A curve end still wins: a line begun at the first line's end starts there exactly.
        const [c] = await drawLine(async () => near(await at([-10, 10, 10])), async () => at([-22, 18, 0]));
        if (!same(c, b)) throw new Error(`a line begun at another's end starts at ${text(c)}, not ${text(b)}`);

        // 4. The grid alone, every 5 mm: clicks a hair off its crossings, away from the box, land on them.
        await evaluate(`window.__forgeTest.snap({ kinds: { vertex: false, midpoint: false, centre: false, quadrant: false, edge: false, face: false, grid: true }, step: 5 })`);
        const onGrid = (v) => Math.abs(v / 5 - Math.round(v / 5)) < 1e-6;
        const [g0, g1] = await drawLine(async () => at([25.12, -14.91, 0]), async () => at([34.9, -25.08, 0]));
        if (![...g0, ...g1].every(onGrid)) throw new Error(`grid snaps at ${text(g0)} -> ${text(g1)}, not on the 5 mm grid`);

        // 5. Alt: no snap -- a click by a corner stays off it.
        await evaluate(`window.__forgeTest.snap({ kinds: { vertex: true, midpoint: true, centre: true, quadrant: true, edge: true, grid: false } })`);
        const [h] = await drawLine(async () => near(await at([10, -10, 10])), async () => at([22, -18, 0]), true);
        if (same(h, [10, -10])) throw new Error("a click with Alt held snapped onto the corner");

        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `snap${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        console.log(`ok - snap: corners ${text(a)} ${text(b)}, a curve end first, grid ${text(g0)} ${text(g1)}, Alt off, ${status.text}`);
    } catch (e) {
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `snap${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await close();
    }
}

async function main() {
    if (!existsSync(join(root, "pkg", "cadaclysm_bg.wasm"))) throw new Error("no pkg/: run `npm run setup` first");
    const all = readdirSync(join(root, "examples")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    const asked = flag("--all") ? all : options("--example").length ? options("--example").map((e) => e.replace(/\.json$/, "")) : ["box-fillet"];
    for (const e of asked) if (!all.includes(e)) throw new Error(`no examples/${e}.json`);
    const out = options("--out")[0] ? resolve(options("--out")[0]) : null;
    const pins = JSON.parse(readFileSync(join(root, "test", "fixtures", "forge-pins.json"), "utf8"));

    const port = await freePort();
    const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((ok) => server.stdout.once("data", ok));
    const profile = mkdtempSync(join(tmpdir(), "forge-chrome-"));
    const chrome = findChrome();
    const { child, url } = await launch(chrome, profile);
    const cdp = new Cdp(url);
    let failed = 0;
    try {
        await cdp.open();
        for (const name of asked) {
            try {
                await checkExample(cdp, `http://127.0.0.1:${port}`, name, { webgl2: flag("--webgl2"), out, pins });
            } catch (e) {
                failed++;
                console.error(`not ok - ${name}: ${e.message}`);
                break;
            }
        }
        if (!failed && !flag("--no-snap")) {
            try {
                await checkSnap(cdp, `http://127.0.0.1:${port}`, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - snap: ${e.message}`);
            }
        }
    } finally {
        cdp.close();
        const exited = new Promise((ok) => child.once("exit", ok));
        child.kill();
        server.kill();
        await Promise.race([exited, sleep(5000)]);
        // Chrome's helpers can hold a file a moment longer: a profile left in the temp folder is no failure.
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left behind */ }
    }
    if (failed) process.exit(1);
}

main().catch((e) => { console.error(`browser: ${e.message}`); process.exit(1); });
