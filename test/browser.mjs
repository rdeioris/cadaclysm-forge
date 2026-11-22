// The headless-Chrome check: the page served by scripts/serve.mjs, in a Chrome or Edge you
// have installed, driven over the DevTools protocol (Node's own WebSocket: no dependency).
// For each example asked: the page opens it, every body builds with no error, the bodies
// draw (a pick in the views lands on one), the STEP button -- offered once a closed solid is
// built -- downloads a STEP file with at least one solid in it (as many as the pins' `solids`
// where they have one), and nothing is logged as an
// error by the page or its worker. Then the snap check: in box-fillet's Top view, with real
// pointer events, a line drawn onto two of the box's corners lands on them exactly, grid
// snaps land on the step, Alt snaps nothing, a rectangle snaps onto another line's middle
// and the grid, a dragged corner follows the pointer, and Measure reads a box edge's length.
//
//     npm run test:browser                          # examples/box-fillet.json, the default backend
//     node test/browser.mjs --webgl2                # the WebGL2 fallback (?backend=webgl2)
//     node test/browser.mjs --example plate-peg --example cut-shell
//     node test/browser.mjs --all                   # every example
//     node test/browser.mjs --out test/out          # also a screenshot of each, and the STEP files
//     node test/browser.mjs --chrome <path to chrome or msedge>   (or the CHROME variable)
//     node test/browser.mjs --headed                # watch it
//     node test/browser.mjs --no-snap               # the examples alone, no snap check
//     node test/browser.mjs --no-sketch-tools       # no sketch pattern / mirror check
//     node test/browser.mjs --no-sketch-copy        # no sketch copy to plane / duplicate check
//     node test/browser.mjs --no-solid-tools        # no solid pattern / mirror check
//     node test/browser.mjs --no-move               # no Move/Copy check
//     node test/browser.mjs --no-sketch-move        # no Sketch › move check
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
            // The pinned count where the pins have one (`solids`), at least one otherwise.
            const solids = pins[`examples/${name}.json`]?.solids;
            if (solids !== undefined && breps !== solids) throw new Error(`${stepName} has ${breps} solids, the pins have ${solids}`);
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
    // A two-click curve (a line, a rectangle) drawn with the tool's button: its shape.
    async function draw(kind, a, b, alt = false) {
        const ofKind = async () => (await evaluate("window.__forgeTest.items()")).filter((c) => c.kind === kind);
        const before = (await ofKind()).length;
        await evaluate(`document.querySelector("#ribbon-sketch [data-kind=${kind}]").click()`);
        await frame(); await sleep(300); await frame();
        await click(await a(), alt);
        await click(await b(), alt);
        await evaluate("window.__forgeTest.settled()");
        // Done, not still in hand: both clicks were the page's (a click off the view never reaches it).
        if (await evaluate(`document.querySelector("#ribbon-sketch [data-kind=${kind}]").getAttribute("aria-pressed")`) === "true") throw new Error(`the ${kind} is still being drawn after its second click`);
        const now = await ofKind();
        if (now.length !== before + 1) throw new Error(`${now.length - before} ${kind}s drawn, not one`);
        return now[now.length - 1].shape;
    }
    async function drawLine(a, b, alt = false) {
        const s = await draw("line", a, b, alt);
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
        const [c, cEnd] = await drawLine(async () => near(await at([-10, 10, 10])), async () => at([-22, 18, 0]));
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

        // 6. Onto another curve and the grid: a rectangle from the middle of the line drawn in 3
        // (-10, 10) -> about (-22, 18), off every grid crossing, to a crossing of a 5 mm grid.
        // The middle is the line's own, to the last digits (the View's float32 point is not).
        await evaluate(`window.__forgeTest.snap({ kinds: { vertex: false, midpoint: true, centre: false, quadrant: false, edge: false, grid: true }, step: 5 })`);
        const r = await draw("rect", async () => near(await at([-16, 14, 0])), async () => at([-30.12, 25.09, 0]));
        const mid = [(c[0] + cEnd[0]) / 2, (c[1] + cEnd[1]) / 2];
        const exact = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
        if (!exact([r.x0, r.y0], mid) || !exact([r.x1, r.y1], [-30, 25])) throw new Error(`the rectangle is ${text([r.x0, r.y0])} -> ${text([r.x1, r.y1])}, not ${text(mid)} -> (-30, 25)`);

        // 7. A dragged corner follows the pointer, a few pixels at a time, and lets go on the
        // middle of the grid line drawn in 4, (25, -15) -> (35, -25): exactly (30, -20).
        await evaluate(`window.__forgeTest.snap({ kinds: { vertex: true, midpoint: true, centre: true, quadrant: true, edge: true, grid: false } })`);
        const from = await at([-30, 25, 0]), to = near(await at([30, -20, 0]));
        await mouse("mouseMoved", from);
        await sleep(150);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
        const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2);   // 2 px: inside the snap's 10, as a hand moves
        for (let k = 1; k <= steps; k++) {
            const q = [from[0] + (to[0] - from[0]) * k / steps, from[1] + (to[1] - from[1]) * k / steps];
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: q[0], y: q[1], button: "left", buttons: 1, pointerType: "mouse" });
            await sleep(16);
        }
        await sleep(300);
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
        await evaluate("window.__forgeTest.settled()");
        const rects = (await evaluate("window.__forgeTest.items()")).filter((c) => c.kind === "rect");
        const d = rects[rects.length - 1].shape;
        if (!exact([d.x1, d.y1], [30, -20])) throw new Error(`the dragged corner is at ${text([d.x1, d.y1])}, not (30, -20)`);

        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `snap${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        console.log(`ok - snap: corners ${text(a)} ${text(b)}, a curve end first, grid ${text(g0)} ${text(g1)}, Alt off, rectangle ${text([r.x0, r.y0])} ${text([r.x1, r.y1])}, dragged to ${text([d.x1, d.y1])}, ${status.text}`);
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

// ---- the sketch tab's pattern and mirror, through the page's own buttons ----------------
// On a sketch of its own: a circle selected and Pattern pressed previews 6 copies about the
// origin at once; the dialog's count re-runs it (4, then 6); Esc rolls it all back (1 circle,
// the history as it was). Pressed again, OK keeps 6 circles as one commit. Mirror over the
// circle and a vertical line, the line clicked last: one circle more, across the line, one
// commit. `--out`: a picture of the pattern's dialog over the six-circle preview.
async function checkSketchCopies(cdp, base, { webgl2, out }) {
    const { send, evaluate, errors, close } = await openForge(cdp, base, "box-fillet", { webgl2 });
    const frame = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const settled = () => evaluate("window.__forgeTest.settled()");
    const key = async (k, code, vk) => {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
    };
    const press = async (id) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(100); await settled(); };
    const field = async (id, v) => {
        await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await sleep(100);
        await settled();
    };
    try {
        const S = await evaluate("window.__forgeTest.nextId()"), C = S + 1, L = S + 2;
        await evaluate(`window.__forgeTest.run({ op: "sketch", id: ${S}, mode: "offset", base: "top", offset: 30 })`);
        await evaluate(`window.__forgeTest.run({ op: "add", id: ${C}, kind: "circle", plane: ${S}, shape: { cx: 10, cy: 0, r: 3 } })`);
        await settled();
        const circles = async () => (await evaluate("window.__forgeTest.items()")).filter((c) => c.kind === "circle" && c.plane === S);
        const head0 = await evaluate("window.__forgeTest.headCount()");
        // Top filling the area: where the sketch is seen.
        await evaluate(`document.querySelector('#viewbar [data-view="0"]').click()`);
        await frame();

        // Pattern, then Esc: the preview, re-run by the count, rolled back whole.
        await evaluate(`window.__forgeTest.select([${C}])`);
        if (await evaluate(`document.getElementById("sketch-pattern").disabled`)) throw new Error("pattern is off with a circle selected");
        await press("sketch-pattern");
        if ((await circles()).length !== 6) throw new Error(`pattern previews ${(await circles()).length} circles, not 6`);
        await field("pattern-count", 4);
        if ((await circles()).length !== 4) throw new Error(`count 4 previews ${(await circles()).length} circles`);
        await field("pattern-count", 6);
        const six = await circles();
        if (six.length !== 6) throw new Error(`count 6 previews ${six.length} circles`);
        const radii = six.map((c) => Math.hypot(c.shape.cx, c.shape.cy));
        if (radii.some((r) => Math.abs(r - 10) > 1e-6)) throw new Error(`the copies are not 10 from the origin: ${radii.join(", ")}`);
        if (await evaluate(`document.getElementById("dialog").hidden`)) throw new Error("no dialog while the pattern previews");
        await key("Escape", "Escape", 27);
        await sleep(100); await settled();
        if ((await circles()).length !== 1) throw new Error(`Esc leaves ${(await circles()).length} circles, not 1`);
        if (await evaluate("window.__forgeTest.headCount()") !== head0) throw new Error("Esc left a commit behind");

        // Pattern, then OK: one commit, six circles; the step lines construction lines.
        await evaluate(`window.__forgeTest.select([${C}])`);
        await press("sketch-pattern");
        if ((await circles()).length !== 6) throw new Error(`pattern previews ${(await circles()).length} circles, not 6`);
        if (out) {
            mkdirSync(out, { recursive: true });
            await key("f", "KeyF", 70);
            await frame(); await sleep(500); await frame();
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `sketch-pattern${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        await press("dialog-ok");
        if ((await circles()).length !== 6) throw new Error(`OK keeps ${(await circles()).length} circles, not 6`);
        const head1 = await evaluate("window.__forgeTest.headCount()");
        if (head1 !== head0 + 1) throw new Error(`the pattern is ${head1 - head0} commits, not 1`);
        const steps = (await evaluate("window.__forgeTest.items()")).filter((c) => c.kind === "line" && c.plane === S && c.construction === true);
        if (steps.length !== 2) throw new Error(`${steps.length} construction step lines, not 2`);
        const log = await evaluate("window.__forgeTest.history()");
        if (!JSON.stringify(log[0]).includes("sketch_pattern")) throw new Error(`the last commit is not the pattern: ${JSON.stringify(log[0]).slice(0, 200)}`);

        // Mirror: the circle and a vertical line, the line last; OK keeps one more circle.
        await evaluate(`window.__forgeTest.run({ op: "add", id: ${L}, kind: "line", plane: ${S}, shape: { x0: -20, y0: -20, x1: -20, y1: 20 } })`);
        await settled();
        const head2 = await evaluate("window.__forgeTest.headCount()");
        await evaluate(`window.__forgeTest.select([${C}, ${L}])`);
        await press("sketch-mirror");
        const mirrored = (await circles()).filter((c) => Math.abs(c.shape.cx + 50) < 1e-6 && Math.abs(c.shape.cy) < 1e-6);
        if ((await circles()).length !== 7 || mirrored.length !== 1) throw new Error(`mirror gives ${(await circles()).length} circles, ${mirrored.length} at (-50, 0)`);
        await press("dialog-ok");
        if ((await circles()).length !== 7) throw new Error(`OK keeps ${(await circles()).length} circles after the mirror, not 7`);
        if (await evaluate("window.__forgeTest.headCount()") !== head2 + 1) throw new Error("the mirror is not one commit");
        // Mirror and Esc: as it was.
        await evaluate(`window.__forgeTest.select([${C}, ${L}])`);
        await press("sketch-mirror");
        if ((await circles()).length !== 8) throw new Error(`a second mirror previews ${(await circles()).length} circles, not 8`);
        await key("Escape", "Escape", 27);
        await sleep(100); await settled();
        if ((await circles()).length !== 7) throw new Error(`Esc after a mirror leaves ${(await circles()).length} circles, not 7`);

        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        console.log("ok - sketch tools: pattern previews 6 / 4 / 6, Esc rolls back to 1, OK keeps 6 in one commit; mirror keeps one across the line, Esc rolls back");
    } catch (e) {
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `sketch-tools${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await close();
    }
}

// ---- Sketch › copy to plane and the browser's duplicate of a sketch ---------------------
// A circle on an offset sketch (Top, 30): the sketch row selected and Copy to plane pressed
// opens the session over a copy at once (offset 50); the dialog's offset typed as 36 runs it
// again; OK keeps two sketches, the second at 36 with one circle of the same radius, in one
// commit whose command is `sketch_copy`. Copied again and Esc: still two sketches, no
// commit. The browser's duplicate on the sketch row: a third sketch on the same plane, with
// its circle. `--out`: a picture of the copy dialog over a hexagon plate (a hexagon, six
// holes patterned round the origin, a rectangle) copied to offset 36, in Perspective.
async function checkSketchCopy(cdp, base, { webgl2, out }) {
    const { send, evaluate, errors, close } = await openForge(cdp, base, "box-fillet", { webgl2 });
    const frame = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const settled = () => evaluate("window.__forgeTest.settled()");
    const key = async (k, code, vk) => {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
    };
    const press = async (id) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(100); await settled(); };
    const field = async (id, v) => {
        await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await sleep(100);
        await settled();
    };
    const items = () => evaluate("window.__forgeTest.items()");
    const sketches = async () => (await items()).filter((c) => c.kind === "sketch");
    const on = async (s) => (await items()).filter((c) => c.plane === s && c.kind !== "image");
    try {
        const S = await evaluate("window.__forgeTest.nextId()"), C = S + 1;
        await evaluate(`window.__forgeTest.run({ op: "sketch", id: ${S}, mode: "offset", base: "top", offset: 30 })`);
        await evaluate(`window.__forgeTest.run({ op: "add", id: ${C}, kind: "circle", plane: ${S}, shape: { cx: 10, cy: 0, r: 3 } })`);
        await settled();
        const n0 = (await sketches()).length;
        const head0 = await evaluate("window.__forgeTest.headCount()");

        // Copy to plane, offset 36, OK: one commit, the copy at 36 with its circle.
        await evaluate(`window.__forgeTest.select([${S}])`);
        if (await evaluate(`document.getElementById("copy-sketch").disabled`)) throw new Error("copy to plane is off with a sketch selected");
        await press("copy-sketch");
        let copies = (await sketches()).filter((c) => c.id !== S && c.id > S);
        if (copies.length !== 1 || copies[0].offset !== 50) throw new Error(`copy to plane previews ${JSON.stringify(copies.map((c) => [c.id, c.offset]))}, not one at offset 50`);
        if (await evaluate(`document.getElementById("dialog").hidden`)) throw new Error("no dialog while the copy previews");
        const readout = await evaluate(`document.getElementById("copy-sketch-what").textContent`);
        if (!/· 1 curve$/.test(readout)) throw new Error(`the readout says ${JSON.stringify(readout)}`);
        await field("offset", 36);
        if (await evaluate("window.__forgeTest.headCount()") !== head0 + 1) throw new Error("the session is not one commit while it is open");
        await press("dialog-ok");
        const all = await sketches();
        copies = all.filter((c) => c.id > C);
        if (all.length !== n0 + 1 || copies.length !== 1) throw new Error(`OK leaves ${all.length} sketches (${n0} before)`);
        const copy = copies[0];
        if (copy.mode !== "offset" || copy.base !== "top" || copy.offset !== 36) throw new Error(`the copy is on ${JSON.stringify([copy.mode, copy.base, copy.offset])}, not Top 36`);
        const circles = (await on(copy.id)).filter((c) => c.kind === "circle");
        if ((await on(copy.id)).length !== 1 || circles.length !== 1 || circles[0].shape.r !== 3) throw new Error(`the copy holds ${JSON.stringify(await on(copy.id))}`);
        if (await evaluate("window.__forgeTest.headCount()") !== head0 + 1) throw new Error("copy to plane is not one commit");
        const log = await evaluate("window.__forgeTest.history()");
        if (!JSON.stringify(log[0]).includes("sketch_copy")) throw new Error(`the last commit is not the copy: ${JSON.stringify(log[0]).slice(0, 200)}`);

        // Copied again, Esc: as it was.
        await evaluate(`window.__forgeTest.select([${S}])`);
        await press("copy-sketch");
        if ((await sketches()).length !== n0 + 2) throw new Error(`a second copy previews ${(await sketches()).length} sketches`);
        await key("Escape", "Escape", 27);
        await sleep(100); await settled();
        if ((await sketches()).length !== n0 + 1) throw new Error(`Esc leaves ${(await sketches()).length} sketches, not ${n0 + 1}`);
        if (await evaluate("window.__forgeTest.headCount()") !== head0 + 1) throw new Error("Esc left a commit behind");

        // The browser's duplicate on the sketch row: a third sketch on Top 30, with its circle.
        await evaluate(`window.__forgeTest.select([${S}])`);
        await press("duplicate");
        const third = (await sketches()).filter((c) => c.id !== S && c.id !== copy.id && c.id > C);
        if (third.length !== 1 || third[0].base !== "top" || third[0].offset !== 30) throw new Error(`duplicate gives ${JSON.stringify(third.map((c) => [c.id, c.base, c.offset]))}`);
        const dup = await on(third[0].id);
        if (dup.length !== 1 || dup[0].kind !== "circle" || dup[0].shape.r !== 3 || dup[0].shape.cx !== 10) throw new Error(`the duplicate holds ${JSON.stringify(dup)}`);
        if (await evaluate("window.__forgeTest.headCount()") !== head0 + 2) throw new Error("duplicate is not one commit");

        if (out) {
            // The hexagon plate copied to offset 36, the session open, in Perspective.
            const P = await evaluate("window.__forgeTest.nextId()");
            await evaluate(`window.__forgeTest.run({ op: "sketch", id: ${P}, mode: "offset", base: "top", offset: 0 })`);
            await evaluate(`window.__forgeTest.run({ op: "add", id: ${P + 1}, kind: "polygon", plane: ${P}, shape: { cx: 0, cy: 0, r: 104, sides: 6, angle: 0 } })`);
            await evaluate(`window.__forgeTest.run({ op: "add", id: ${P + 2}, kind: "circle", plane: ${P}, shape: { cx: 80, cy: 0, r: 11 } })`);
            await evaluate(`window.__forgeTest.run({ op: "sketch_pattern", sketch: ${P}, ids: [${P + 2}], type: "circular", centre: null, count: 6, angle: 360, copies: [${[3, 4, 5, 6, 7, 8, 9].map((k) => P + k).join(", ")}] })`);
            await evaluate(`window.__forgeTest.run({ op: "add", id: ${P + 10}, kind: "rect", plane: ${P}, shape: { x0: -20, y0: -10, x1: 20, y1: 10 } })`);
            await settled();
            await evaluate(`document.querySelector('#viewbar [data-view="1"]').click()`);
            await evaluate(`window.__forgeTest.select([${P}])`);
            await press("copy-sketch");
            await field("offset", 36);
            await key("f", "KeyF", 70);
            await frame(); await sleep(500); await frame();
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `sketch-copy${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
            await press("dialog-ok");
            const plate = (await sketches()).filter((c) => c.id > P + 10);
            if (plate.length !== 1 || plate[0].offset !== 36 || (await on(plate[0].id)).length !== 10) throw new Error(`the plate's copy is ${JSON.stringify(plate)}`);
        }

        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        console.log("ok - sketch copy: copy to plane previews at 50, offset 36 re-runs it, OK keeps 2 sketches in one commit (sketch_copy); Esc rolls a second back; duplicate copies the sketch with its circle");
    } catch (e) {
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `sketch-copy${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await close();
    }
}

// Solid › pattern and Solid › mirror on a box: the session previews 5 instance items and the
// outline's group row, Esc leaves none and no commit; OK keeps them in one commit. Mirror
// across Right as a new body: 1 instance. The STEP of every body: one MANIFOLD_SOLID_BREP per
// solid, the instances each their own.
async function checkSolidCopies(cdp, base, { webgl2, out }) {
    const { send, evaluate, errors, close } = await openForge(cdp, base, "box-fillet", { webgl2 });
    const frame = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const settled = () => evaluate("window.__forgeTest.settled()");
    const key = async (k, code, vk) => {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
    };
    const press = async (id) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(100); await settled(); };
    const breps = async () => {
        await evaluate("window.__forgeTest.select([])");
        const got = await evaluate(`window.__forgeTest.exportBase64("step")`);
        return got ? (Buffer.from(got.base64, "base64").toString("utf8").match(/MANIFOLD_SOLID_BREP/g) ?? []).length : 0;
    };
    try {
        await settled();
        // The example's own bodies hidden: the copies alone in the views (and the STEP).
        const own = (await evaluate("window.__forgeTest.bodies()")).map((b) => b.id);
        await evaluate(`window.__forgeTest.run({ op: "edit", items: ${JSON.stringify(own)}.map((id) => ({ id, hidden: true })) })`);
        await settled();
        const before = await breps();
        const B = await evaluate("window.__forgeTest.nextId()");
        await evaluate(`window.__forgeTest.run({ op: "primitive", id: ${B}, kind: "box", plane: "top", dims: [6, 6, 6] })`);
        await evaluate(`window.__forgeTest.run({ op: "set", id: ${B}, place: { offset: [40, 0, 0], turn: [0, 0, 0] } })`);
        await settled();
        const items = () => evaluate("window.__forgeTest.items()");
        const made = async () => (await items()).filter((c) => c.kind === "instance" || c.kind === "pattern");
        const head0 = await evaluate("window.__forgeTest.headCount()");

        // Pattern, then Esc: 5 instances and the group row previewed, rolled back whole.
        await evaluate(`window.__forgeTest.select([${B}])`);
        if (await evaluate(`document.getElementById("pattern").disabled`)) throw new Error("Solid › pattern is off with a box selected");
        await press("pattern");
        let now = await made();
        const insts = now.filter((c) => c.kind === "instance"), group = now.find((c) => c.kind === "pattern");
        if (insts.length !== 5 || !group) throw new Error(`pattern previews ${insts.length} instances and ${group ? "a" : "no"} group, not 5 and one`);
        const rowText = await evaluate(`document.querySelector('#curves li[data-id="${group.id}"] .name')?.textContent ?? null`);
        if (!rowText || !rowText.includes("6 × 1 body")) throw new Error(`the group row reads ${JSON.stringify(rowText)}`);
        const instRows = await evaluate(`${JSON.stringify(insts.map((c) => c.id))}.filter((id) => document.querySelector('#curves li[data-id="' + id + '"]')).length`);
        if (instRows !== 5) throw new Error(`${instRows} instance rows under the group, not 5`);
        await key("Escape", "Escape", 27);
        await sleep(100); await settled();
        if ((await made()).length) throw new Error(`Esc leaves ${(await made()).length} pattern items`);
        if (await evaluate("window.__forgeTest.headCount()") !== head0) throw new Error("Esc left a commit behind");

        // Pattern, then OK: one commit, the instances built, each a box.
        await evaluate(`window.__forgeTest.select([${B}])`);
        await press("pattern");
        if ((await made()).filter((c) => c.kind === "instance").length !== 5) throw new Error("the second pattern does not preview 5 instances");
        if (out) {
            mkdirSync(out, { recursive: true });
            await key("f", "KeyF", 70);
            await frame(); await sleep(500); await frame();
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `solid-pattern${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        await press("dialog-ok");
        now = await made();
        if (now.filter((c) => c.kind === "instance").length !== 5) throw new Error(`OK keeps ${now.filter((c) => c.kind === "instance").length} instances, not 5`);
        if (await evaluate("window.__forgeTest.headCount()") !== head0 + 1) throw new Error("the pattern is not one commit");
        const bodies = await evaluate("window.__forgeTest.bodies()");
        const bad = bodies.filter((b) => b.kind === "instance" && (b.error !== null || b.faces !== 6));
        if (bad.length) throw new Error(`instances not built as boxes: ${JSON.stringify(bad)}`);

        // Mirror across Right as a new body: one instance, named "<box> mirror".
        const head1 = await evaluate("window.__forgeTest.headCount()");
        await evaluate(`window.__forgeTest.select([${B}])`);
        await press("mirror");
        await press("dialog-ok");
        const mirrored = (await items()).filter((c) => c.kind === "instance" && / mirror$/.test(c.name));
        if (mirrored.length !== 1) throw new Error(`mirror makes ${mirrored.length} instances, not 1`);
        if (await evaluate("window.__forgeTest.headCount()") !== head1 + 1) throw new Error("the mirror is not one commit");
        const mb = (await evaluate("window.__forgeTest.bodies()")).find((b) => b.id === mirrored[0].id);
        if (!mb || mb.error !== null || !(Math.abs(mb.bounds.centre[0] + 40) < 1e-3)) throw new Error(`the mirror is not at x -40: ${JSON.stringify(mb)}`);

        // The STEP of all: the box, its 5 instances and its mirror each a solid of their own.
        const after = await breps();
        if (after !== before + 7) throw new Error(`the STEP has ${after} solids, not ${before} + 7`);

        // The group's eye hides the group and every instance.
        const kept = (await items()).find((c) => c.kind === "pattern" && c.type === "circular");
        await evaluate(`document.querySelector('#curves li[data-id="${kept.id}"] .eye').click()`);
        await sleep(100); await settled();
        const shown = (await items()).filter((c) => c.kind === "instance" && c.pattern === kept.id && !c.hidden);
        if (shown.length) throw new Error(`the group's eye leaves ${shown.length} instances shown`);

        // Mirror joined across Front (the box straddles it): one body, consuming the box --
        // the command asks the worker for the box's bounds and kind.
        await evaluate(`window.__forgeTest.select([${B}])`);
        await press("mirror");
        await evaluate(`(() => { document.querySelector('[data-solid-plane="front"]').click(); })()`);
        await sleep(100); await settled();
        await evaluate(`(() => { const el = document.getElementById("solid-operation"); el.value = "join"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await sleep(100); await settled();
        await press("dialog-ok");
        const joined = (await items()).filter((c) => c.kind === "mirror");
        if (joined.length !== 1 || joined[0].across !== "front" || joined[0].parts?.[0] !== B) throw new Error(`mirror join gives ${JSON.stringify(joined)}`);
        const jb = (await evaluate("window.__forgeTest.bodies()")).find((b) => b.id === joined[0].id);
        if (!jb || jb.error !== null || !jb.closure?.closed) throw new Error(`the mirror join did not build a closed solid: ${JSON.stringify(jb)}`);

        // A feature pattern: a plate's off-centre hole, 6 about Z -- the cut selected, then
        // "feature" in the dialog; the item takes the cut's place, one body with 4 holes.
        const P = await evaluate("window.__forgeTest.nextId()");
        for (const c of [{ op: "primitive", id: P, kind: "box", plane: "top", dims: [40, 40, 4] },
            { op: "primitive", id: P + 1, kind: "cylinder", plane: "top", dims: [2, 10] }, { op: "set", id: P + 1, place: { offset: [10, 0, -3], turn: [0, 0, 0] } },
            { op: "cut", id: P + 2, parts: [P, P + 1] }]) await evaluate(`window.__forgeTest.run(${JSON.stringify(c)})`);
        await settled();
        await evaluate(`window.__forgeTest.select([${P + 2}])`);
        await press("pattern");
        await evaluate(`document.querySelector('[data-solid-objects="feature"]').click()`);
        await sleep(100); await settled();
        await press("dialog-ok");
        const fp = (await items()).filter((c) => c.kind === "pattern_feature");
        if (fp.length !== 1 || fp[0].parts?.[0] !== P + 2) throw new Error(`the feature pattern gives ${JSON.stringify(fp)}`);
        const fb = (await evaluate("window.__forgeTest.figures()")).find((b) => b.id === fp[0].id);
        const want = 40 * 40 * 4 - 6 * Math.PI * 2 * 2 * 4;
        if (!fb || fb.error !== null || !(Math.abs(fb.volume - want) < 1e-3 * want)) throw new Error(`the feature pattern is not the plate less 6 holes (${want.toFixed(3)}): ${JSON.stringify(fb)}`);
        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        console.log(`ok - solid tools: pattern previews 5 instances and the group row, Esc rolls back, OK keeps them in one commit; mirror makes 1; the STEP has ${after} solids (${before} + 7); the group's eye hides its instances; mirror join builds one solid; a feature pattern cuts 6 holes`);
    } catch (e) {
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `solid-tools${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await close();
    }
}

// ---- Solid › move, through the page's own button, key and picks --------------------------
// Two boxes of 4 at x 20 and x 40 selected: no manipulator; M opens the Move session with the
// manipulator at their box centre (30, 0, 2). Z° 90 and OK: one commit, one move chip, the
// boxes centred at (30, -10, 2) and (30, 10, 2). Esc in a fresh session changes nothing. Set
// pivot onto a corner (a vertex snap): the pivot readout is that corner. Point to point from a
// corner of box 1 to the same corner of box 2: box 1 lands on box 2. Copy: the originals
// stay, the copies move. Then six boxes in a ring (a box and its pattern): the session about
// their middle, and Set pivot onto a corner of one. The manipulator's look (F3), on the ring:
// the Z arc's grip hovered (the grab cursor), a drag of it about 50 degrees that steps to 45
// (and with Shift does not), the readout and the ghost boxes during it, a drag of the XY square
// (X and Y, never Z), and a click on the X arrow with 10 typed (Esc in the field does nothing).
// `--out`: those pictures (move-session.png, move-pivot.png, manipulator-new.png with the arc
// hovered, manipulator-drag.png mid-drag, manipulator-old.png in the older rings-only look).
async function checkMove(cdp, base, { webgl2, out }) {
    const { send, evaluate, errors, close } = await openForge(cdp, base, "box-fillet", { webgl2 });
    const frame = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const settled = () => evaluate("window.__forgeTest.settled()");
    const T = (expr) => evaluate(`window.__forgeTest.${expr}`);
    const key = async (k, code, vk) => {
        await evaluate("document.activeElement?.blur?.()");
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
        await sleep(100); await settled();
    };
    const press = async (id) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(100); await settled(); };
    const field = async (id, v) => {
        await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await sleep(100); await settled();
    };
    const origin = await evaluate(`(() => { const r = document.getElementById("overlay").getBoundingClientRect(); return [r.left, r.top]; })()`);
    // A world point in the Perspective view, in page pixels.
    const at = async (p) => {
        const q = await T(`screenOf(1, ${JSON.stringify(p)})`);
        if (!q) throw new Error(`no pixel for ${JSON.stringify(p)} in Perspective`);
        return [origin[0] + q[0], origin[1] + q[1]];
    };
    const mouse = (type, [x, y]) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
    async function click(px) {
        await mouse("mouseMoved", [px[0] - 6, px[1] - 6]);
        await mouse("mouseMoved", px);
        await sleep(250);
        await mouse("mousePressed", px);
        await mouse("mouseReleased", px);
        await sleep(150);
        await settled();
    }
    const near = (a, b, tol = 1e-3) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
    const boxOf = async (id) => { const b = await T(`box(${id})`); if (!b) throw new Error(`#${id} has no box`); return b; };
    const centre = (b) => [0, 1, 2].map((k) => (b.lo[k] + b.hi[k]) / 2);
    const moveChips = () => evaluate(`document.querySelectorAll('#timeline-chips .chip use[href="#i-move"]').length`);
    const text = (p) => `(${p.map((v) => +v.toFixed(4)).join(", ")})`;
    try {
        await settled();
        const own = (await T("bodies()")).map((b) => b.id);
        await T(`run({ op: "edit", items: ${JSON.stringify(own)}.map((id) => ({ id, hidden: true })) })`);
        const B = await T("nextId()");
        for (const c of [{ op: "primitive", id: B, kind: "box", plane: "top", dims: [4, 4, 4] }, { op: "set", id: B, place: { offset: [20, 0, 0], turn: [0, 0, 0] } },
            { op: "primitive", id: B + 1, kind: "box", plane: "top", dims: [4, 4, 4] }, { op: "set", id: B + 1, place: { offset: [40, 0, 0], turn: [0, 0, 0] } }]) await T(`run(${JSON.stringify(c)})`);
        await settled();
        await T(`select([${B}, ${B + 1}])`);
        await key("f", "KeyF", 70);
        await frame(); await sleep(300); await frame();

        // Selected: no manipulator. M: the session, the manipulator at the box centre.
        if (await T("gizmo()")) throw new Error("two selected boxes show a manipulator outside the Move session");
        if (await evaluate(`document.getElementById("move").disabled`)) throw new Error("Solid › move is off with two boxes selected");
        await key("m", "KeyM", 77);
        let st = await T("moveState()");
        if (!st || !near(st.pivot, [30, 0, 2])) throw new Error(`M opens ${JSON.stringify(st)}, not a session with its pivot at (30, 0, 2)`);
        const g = await T("gizmo()");
        if (!g) throw new Error("the Move session shows no manipulator");
        const want = await T(`screenOf(${g.view}, [30, 0, 2])`);
        if (!near([g.centre[0] - origin[0], g.centre[1] - origin[1]], want, 1)) throw new Error(`the manipulator is at ${text(g.centre)}, the box centre at ${text(want)}`);
        const head0 = await T("headCount()"), chips0 = await moveChips();
        await field("move-rz", 90);
        await press("dialog-ok");
        if (await T("moveState()")) throw new Error("OK leaves the Move session open");
        if (await T("headCount()") !== head0 + 1) throw new Error(`the move is ${await T("headCount()") - head0} commits, not one`);
        if (await moveChips() !== chips0 + 1) throw new Error(`the move makes ${await moveChips() - chips0} move chips, not one`);
        const c1 = centre(await boxOf(B)), c2 = centre(await boxOf(B + 1));
        if (!near(c1, [30, -10, 2]) || !near(c2, [30, 10, 2])) throw new Error(`the boxes turned are centred at ${text(c1)} and ${text(c2)}, not (30, -10, 2) and (30, 10, 2)`);

        // Esc in a fresh session: nothing changed.
        const head1 = await T("headCount()");
        await T(`select([${B}, ${B + 1}])`);
        await key("m", "KeyM", 77);
        await field("move-x", 10);
        if (!near(centre(await boxOf(B)), [40, -10, 2])) throw new Error(`X 10 previews box 1 at ${text(centre(await boxOf(B)))}, not (40, -10, 2)`);
        await key("Escape", "Escape", 27);
        if (await T("moveState()")) throw new Error("Esc leaves the Move session open");
        if (await T("headCount()") !== head1) throw new Error("Esc left a commit behind");
        if (!near(centre(await boxOf(B)), c1)) throw new Error(`Esc leaves box 1 at ${text(centre(await boxOf(B)))}`);

        // A drag of the X arrow: its slide is the dialog's X, both boxes moved, no commit until OK.
        // Ctrl-click on the centre arms Set pivot; Esc puts the pick down, Esc again cancels.
        await T(`select([${B}, ${B + 1}])`);
        await key("m", "KeyM", 77);
        const g3 = await T("gizmo()");
        const tip = g3.axes.find((a) => a.name === "X").tip, dir = [tip[0] - g3.centre[0], tip[1] - g3.centre[1]];
        const len = Math.hypot(...dir), to = [tip[0] + dir[0] / len * 60, tip[1] + dir[1] / len * 60];
        await mouse("mouseMoved", tip);
        await sleep(100);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: tip[0], y: tip[1], button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
        for (let k = 1; k <= 20; k++) {
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tip[0] + (to[0] - tip[0]) * k / 20, y: tip[1] + (to[1] - tip[1]) * k / 20, button: "left", buttons: 1, pointerType: "mouse" });
            await sleep(16);
        }
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
        await sleep(200); await settled();
        st = await T("moveState()");
        if (!(st.by[0] > 1) || Math.abs(st.by[1]) > 1e-6 || Math.abs(st.by[2]) > 1e-6) throw new Error(`a drag along X gives by ${text(st.by)}`);
        const typed = Number(await evaluate(`document.getElementById("move-x").value`));
        if (Math.abs(typed - st.by[0]) > 1e-3) throw new Error(`the drag's X ${st.by[0]} shows as ${typed}`);
        if (!near(centre(await boxOf(B + 1)), [c2[0] + st.by[0], c2[1], c2[2]])) throw new Error(`the drag left box 2 at ${text(centre(await boxOf(B + 1)))}`);
        if (await T("headCount()") !== head1 + 1) throw new Error("a drag in the session is not the session's one command");
        const g4 = await T("gizmo()");
        await mouse("mouseMoved", g4.centre);
        await sleep(100);
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: g4.centre[0], y: g4.centre[1], button: "left", buttons: 1, clickCount: 1, modifiers: 2, pointerType: "mouse" });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g4.centre[0], y: g4.centre[1], button: "left", buttons: 0, clickCount: 1, modifiers: 2, pointerType: "mouse" });
        await sleep(100); await settled();
        if ((await T("moveState()"))?.picking !== "pivot") throw new Error("Ctrl-click on the manipulator's centre does not arm Set pivot");
        await key("Escape", "Escape", 27);
        if ((await T("moveState()"))?.picking !== null) throw new Error("Esc does not put the pivot's pick down");
        await key("Escape", "Escape", 27);
        if (await T("headCount()") !== head1) throw new Error("Esc after a drag left a commit behind");
        if (!near(centre(await boxOf(B)), c1)) throw new Error(`Esc after a drag leaves box 1 at ${text(centre(await boxOf(B)))}`);

        // Set pivot onto a vertex snap: the readout is that corner, the manipulator there.
        await T(`snap({ on: true, kinds: { vertex: true, midpoint: false, centre: false, quadrant: false, edge: false, face: false, grid: false } })`);
        await T(`select([${B}])`);
        await key("m", "KeyM", 77);
        await press("move-pivot-set");
        if ((await T("moveState()")).picking !== "pivot") throw new Error("set does not arm the pivot's pick");
        const corner = [32, -8, 4];
        const cp = await at(corner);
        await click([cp[0] + 3, cp[1] - 2]);
        st = await T("moveState()");
        if (!near(st.pivot, corner, 1e-6)) throw new Error(`the pivot set onto the corner ${text(corner)} is ${text(st.pivot)}`);
        const readout = await evaluate(`document.getElementById("move-pivot").textContent`);
        if (!/^32, -8, 4$/.test(readout)) throw new Error(`the pivot readout says ${JSON.stringify(readout)}`);
        const g2 = await T("gizmo()");
        const want2 = await T(`screenOf(${g2.view}, ${JSON.stringify(corner)})`);
        if (!near([g2.centre[0] - origin[0], g2.centre[1] - origin[1]], want2, 1)) throw new Error("the manipulator did not go to the pivot");
        await key("Escape", "Escape", 27);

        // Point to point: box 1's corner onto box 2's: box 1 lands on box 2.
        await T(`select([${B}])`);
        await key("m", "KeyM", 77);
        await evaluate(`document.querySelector('[data-move-type="points"]').click()`);
        await sleep(100); await settled();
        if ((await T("moveState()")).picking !== "from") throw new Error("point to point does not arm its first pick");
        const fp = await at(corner);
        await click([fp[0] + 3, fp[1] - 2]);
        const tp = await at([32, 12, 4]);
        await click([tp[0] + 3, tp[1] - 2]);
        st = await T("moveState()");
        if (!near(st.by, [0, 20, 0], 1e-6)) throw new Error(`point to point gives by ${text(st.by)}, not (0, 20, 0)`);
        await press("dialog-ok");
        if (!near(centre(await boxOf(B)), c2)) throw new Error(`box 1 lands at ${text(centre(await boxOf(B)))}, not on box 2 at ${text(c2)}`);

        // Copy: the originals stay, the copies move.
        await T(`select([${B}, ${B + 1}])`);
        await key("m", "KeyM", 77);
        await evaluate(`(() => { const el = document.getElementById("move-copy"); el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await sleep(100); await settled();
        await field("move-z", 50);
        await press("dialog-ok");
        const copies = (await T("bodies()")).filter((b) => / copy$/.test(b.name));
        if (copies.length !== 2) throw new Error(`copy makes ${copies.length} copies, not 2`);
        if (!near(centre(await boxOf(B + 1)), c2)) throw new Error("copy moved an original");
        for (const c of copies) { const z = centre(await boxOf(c.id))[2]; if (!near([z], [52])) throw new Error(`a copy is at z ${z}, not 52`); }

        // Six boxes in a ring (a box and its pattern), the session over them: the pictures.
        await T(`run({ op: "edit", items: ${JSON.stringify([B, B + 1, ...copies.map((c) => c.id)])}.map((id) => ({ id, hidden: true })) })`);
        const R = await T("nextId()");
        await T(`run({ op: "primitive", id: ${R}, kind: "box", plane: "top", dims: [6, 6, 10] })`);
        await T(`run({ op: "set", id: ${R}, place: { offset: [30, 0, 0], turn: [0, 0, 0] } })`);
        await T(`run({ op: "pattern", id: ${R + 1}, sources: [${R}], type: "circular", axis: "z", count: 6, instances: [${R + 2}, ${R + 3}, ${R + 4}, ${R + 5}, ${R + 6}] })`);
        await settled();
        await T(`select([${R}, ${R + 1}])`);
        await key("f", "KeyF", 70);
        await key("m", "KeyM", 77);
        st = await T("moveState()");
        if (!st || st.ids.length !== 6 || !near(st.pivot, [0, 0, 5], 1e-3)) throw new Error(`the ring's session is ${JSON.stringify(st)}, not 6 bodies about (0, 0, 5)`);
        await frame(); await sleep(500); await frame();
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `move-session${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        await press("move-pivot-set");
        const ring = [33, 3, 10];
        const rp = await at(ring);
        await click([rp[0] + 3, rp[1] - 2]);
        st = await T("moveState()");
        if (!near(st.pivot, ring, 1e-6)) throw new Error(`the ring's pivot set onto ${text(ring)} is ${text(st.pivot)}`);
        await frame(); await sleep(300); await frame();
        if (out) {
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `move-pivot${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        }
        await key("Escape", "Escape", 27);
        await sleep(300);

        // The look: arrows, plane squares, quarter arcs.
        const shoot = async (name) => {
            if (!out) return;
            const shot = await send("Page.captureScreenshot", { format: "png" });
            writeFileSync(join(out, `${name}${webgl2 ? "-webgl2" : ""}.png`), Buffer.from(shot.data, "base64"));
        };
        const openRing = async () => { await T(`select([${R}, ${R + 1}])`); await key("m", "KeyM", 77); await frame(); await sleep(200); await frame(); };
        const dragAlong = async (from, path, { modifiers = 0, mid = null } = {}) => {
            await mouse("mouseMoved", from);
            await sleep(100);
            await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1, modifiers, pointerType: "mouse" });
            for (const q of path) {
                await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: q[0], y: q[1], button: "left", buttons: 1, modifiers, pointerType: "mouse" });
                await sleep(16);
            }
            const during = mid ? await mid() : null;
            const end = path.at(-1);
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end[0], y: end[1], button: "left", buttons: 0, clickCount: 1, modifiers, pointerType: "mouse" });
            await sleep(200); await settled();
            return during;
        };
        // Round the Z arc about the pivot (0, 0, 5), from its grip (45 degrees) to 95: 50 degrees.
        const zTurn = async (modifiers, mid) => {
            const gz = await T("gizmo()");
            const grip = gz.arcs.find((a) => a.name === "Z")?.grip;
            if (!grip) throw new Error(`the ring's manipulator has no Z arc: ${JSON.stringify(gz)}`);
            const path = [];
            for (let k = 1; k <= 20; k++) { const t = (45 + 50 * k / 20) * Math.PI / 180; path.push(await at([10 * Math.cos(t), 10 * Math.sin(t), 5])); }
            return dragAlong(grip, path, { modifiers, mid });
        };
        await openRing();
        const g5 = await T("gizmo()");
        if (!g5.arcs?.length || !g5.planes?.length) throw new Error(`the session's manipulator has no arcs or squares: ${JSON.stringify(g5)}`);
        const zGrip = g5.arcs.find((a) => a.name === "Z").grip;
        await mouse("mouseMoved", [zGrip[0] - 20, zGrip[1] - 20]);
        await mouse("mouseMoved", zGrip);
        await sleep(100); await frame();
        const cursor = await evaluate(`document.getElementById("overlay").style.cursor`);
        const look = await T("manipulatorState()");
        if (cursor !== "grab" || look.hover !== "rotate Z") throw new Error(`over the Z arc's grip the cursor is ${cursor} and the hover ${look.hover}, not grab and rotate Z`);
        await frame(); await sleep(300); await frame();
        await shoot("manipulator-new");
        await T("oldLook(true)");
        await frame(); await sleep(300); await frame();
        await shoot("manipulator-old");
        await T("oldLook(false)");
        await frame();
        // The Z arc dragged 50 degrees, snapping on: 45, in 15-degree steps.
        await T("snap({ on: true })");
        const during = await zTurn(0, async () => { await frame(); await sleep(200); await frame(); await shoot("manipulator-drag"); return T("manipulatorState()"); });
        st = await T("moveState()");
        if (Math.abs(st.turn[2] - 45) > 1e-6 || Math.abs(st.turn[0]) > 1e-6 || Math.abs(st.turn[1]) > 1e-6) throw new Error(`the Z arc dragged 50 degrees gives turn ${text(st.turn)}, not (0, 0, 45)`);
        if (during.readout !== "Z 45°") throw new Error(`the readout during the drag says ${JSON.stringify(during.readout)}, not "Z 45°"`);
        if (during.ghosts !== 6) throw new Error(`the drag shows ${during.ghosts} ghost boxes, not 6`);
        if ((await T("manipulatorState()")).readout !== null) throw new Error("the readout stays after the drag");
        await key("Escape", "Escape", 27);
        // With Shift: free of the steps.
        await openRing();
        await zTurn(8, null);
        st = await T("moveState()");
        const free = st.turn[2];
        if (Math.abs(free) < 1 || Math.abs(free / 15 - Math.round(free / 15)) < 0.05) throw new Error(`the Z arc dragged with Shift gives ${free} degrees, a step of 15`);
        await key("Escape", "Escape", 27);
        // The XY square: X and Y, never Z.
        await openRing();
        const sq = (await T("gizmo()")).planes.find((p) => p.name === "Z")?.centre;
        if (!sq) throw new Error("no XY square on the ring's manipulator");
        const p0 = await at([0, 0, 5]), p1 = await at([16, 14, 5]);
        const sqPath = [];
        for (let k = 1; k <= 20; k++) sqPath.push([sq[0] + (p1[0] - p0[0]) * k / 20, sq[1] + (p1[1] - p0[1]) * k / 20]);
        await dragAlong(sq, sqPath);
        st = await T("moveState()");
        if (st.by[0] === 0 || st.by[1] === 0 || st.by[2] !== 0) throw new Error(`a drag of the XY square gives by ${text(st.by)}`);
        await key("Escape", "Escape", 27);
        // A click on the X arrow: a field; 10 and Enter moves the bodies 10 along X.
        await openRing();
        const before = centre(await boxOf(R));
        const typeAt = async (name, typed, enter) => {
            const tip = (await T("gizmo()")).axes.find((a) => a.name === name).tip;
            await click(tip);
            const label = await evaluate(`document.querySelector(".move-typed")?.dataset.label ?? null`);
            const focused = await evaluate(`document.activeElement?.closest?.(".move-typed") ? document.activeElement.value : null`);
            if (label !== name || focused !== "") throw new Error(`a click on the ${name} arrow opens ${JSON.stringify(label)} with ${JSON.stringify(focused)} focused, not an empty ${name} field`);
            await send("Input.insertText", { text: typed });
            const [k, vk] = enter ? ["Enter", 13] : ["Escape", 27];
            await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk });
            await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk });
            await sleep(150); await settled();
            if (await evaluate(`!!document.querySelector(".move-typed")`)) throw new Error(`the ${name} field stays after ${k}`);
        };
        await typeAt("Y", "5", false);
        st = await T("moveState()");
        if (!st || !near(st.by, [0, 0, 0], 0)) throw new Error(`Esc in the typed field changed the session: ${JSON.stringify(st)}`);
        await typeAt("X", "10", true);
        st = await T("moveState()");
        if (!near(st.by, [10, 0, 0], 1e-9)) throw new Error(`X 10 typed gives by ${text(st.by)}`);
        if (Number(await evaluate(`document.getElementById("move-x").value`)) !== 10) throw new Error("the dialog's X does not read 10");
        const after = centre(await boxOf(R));
        if (!near(after, [before[0] + 10, before[1], before[2]])) throw new Error(`X 10 typed leaves the box at ${text(after)}, from ${text(before)}`);
        await key("Escape", "Escape", 27);
        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        console.log(`ok - move: no manipulator on a selection; M at the box centre; Z° 90 one commit and one chip, the boxes at ${text(c1)} ${text(c2)}; Esc restores; Set pivot onto ${text(corner)}; point to point lands box 1 on box 2; copy keeps the originals; the ring's session about (0, 0, 5); the Z arc's grip grabs, steps to 45 (Shift ${+free.toFixed(2)}) with the readout and 6 ghosts; the XY square stays in Z; X 10 typed`);
    } catch (e) {
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `move${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
        }
        throw e;
    } finally {
        await close();
    }
}

// ---- Sketch › move, through the page's key ------------------------------------------------
// A circle on a sketch selected: no manipulator; M opens Sketch › move with one; X 10 and OK:
// the circle's centre 10 over, one commit, and no chip of its own (its sketch's chip covers
// it). Esc in a fresh session changes nothing. On a constrained sketch -- a line coincident
// with the end of a fixed line -- a move keeps the coincidence or says why not and keeps
// nothing, as a drag of the block does.
async function checkSketchMove(cdp, base, { webgl2, out }) {
    const { send, evaluate, errors, close } = await openForge(cdp, base, "box-fillet", { webgl2 });
    const settled = () => evaluate("window.__forgeTest.settled()");
    const T = (expr) => evaluate(`window.__forgeTest.${expr}`);
    const key = async (k, code, vk) => {
        await evaluate("document.activeElement?.blur?.()");
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
        await sleep(100); await settled();
    };
    const press = async (id) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(100); await settled(); };
    const field = async (id, v) => {
        await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await sleep(100); await settled();
    };
    const item = async (id) => (await T("items()")).find((c) => c.id === id);
    const chips = () => evaluate(`document.querySelectorAll('#timeline-chips .chip').length`);
    const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
    try {
        await settled();
        const S = await T("nextId()");
        for (const c of [{ op: "sketch", id: S, mode: "offset", base: "top", offset: 0 },
            { op: "add", id: S + 1, kind: "circle", plane: S, shape: { cx: 0, cy: 0, r: 5 } }]) await T(`run(${JSON.stringify(c)})`);
        await settled();
        await T(`select([${S + 1}])`);
        if (await T("gizmo()")) throw new Error("a selected circle shows a manipulator outside Sketch › move");
        if (await evaluate(`document.getElementById("sketch-move").disabled`)) throw new Error("Sketch › move is off with a circle selected");
        const head0 = await T("headCount()"), chips0 = await chips();
        await key("m", "KeyM", 77);
        let st = await T("sketchMoveState()");
        // The pivot: the middle of the circle's handles' box -- its centre and its rim handle (5, 0).
        if (!st || st.ids.length !== 1 || st.pivot2[0] !== 2.5 || st.pivot2[1] !== 0) throw new Error(`M opens ${JSON.stringify(st)}, not Sketch › move on the circle about (2.5, 0)`);
        if (!(await T("gizmo()"))) throw new Error("Sketch › move shows no manipulator");
        await field("sketch-move-x", 10);
        await press("dialog-ok");
        if (await T("sketchMoveState()")) throw new Error("OK leaves Sketch › move open");
        const circle = await item(S + 1);
        if (!near(circle.shape.cx, 10) || !near(circle.shape.cy, 0) || !near(circle.shape.r, 5)) throw new Error(`the circle moved is ${JSON.stringify(circle.shape)}, not centred at (10, 0)`);
        if (await T("headCount()") !== head0 + 1) throw new Error(`Sketch › move is ${await T("headCount()") - head0} commits, not one`);
        if (await chips() !== chips0) throw new Error(`Sketch › move adds ${await chips() - chips0} chips: its sketch's chip covers it`);
        const log = await T("history()");
        if (!/^forge: sketch_move/.test(log[0].message)) throw new Error(`the commit is ${log[0].message}, not a sketch_move`);

        // Esc: nothing changed.
        await T(`select([${S + 1}])`);
        await key("m", "KeyM", 77);
        await field("sketch-move-y", 7);
        if (!near((await item(S + 1)).shape.cy, 7)) throw new Error("Y 7 does not preview the circle 7 up");
        await key("Escape", "Escape", 27);
        if (await T("headCount()") !== head0 + 1 || !near((await item(S + 1)).shape.cy, 0)) throw new Error("Esc did not roll Sketch › move back");

        // A line held at its start to the end of a fixed line, moved 10 along x.
        const L1 = S + 2, L2 = S + 3;
        for (const c of [{ op: "add", id: L1, kind: "line", plane: S, shape: { x0: 0, y0: 20, x1: 10, y1: 20 } },
            { op: "add", id: L2, kind: "line", plane: S, shape: { x0: 10, y0: 20, x1: 20, y1: 30 } },
            { op: "edit", items: [{ id: S, constraints: [{ id: 1, kind: "fix", refs: [{ curve: L1, at: "start" }] }, { id: 2, kind: "fix", refs: [{ curve: L1, at: "end" }] },
                { id: 3, kind: "coincident", refs: [{ curve: L1, at: "end" }, { curve: L2, at: "start" }] }] }] }]) await T(`run(${JSON.stringify(c)})`);
        await settled();
        const head1 = await T("headCount()");
        await T(`select([${L2}])`);
        await key("m", "KeyM", 77);
        await field("sketch-move-x", 10);
        await press("dialog-ok");
        const l1 = (await item(L1)).shape, l2 = (await item(L2)).shape;
        if (!near(l1.x0, 0) || !near(l1.y0, 20) || !near(l1.x1, 10) || !near(l1.y1, 20)) throw new Error(`the fixed line moved: ${JSON.stringify(l1)}`);
        const status = await T("status()");
        const kept = near(l2.x0, 10, 1e-6) && near(l2.y0, 20, 1e-6);
        const said = status.error && (await T("headCount()")) === head1;
        if (!kept && !said) throw new Error(`the held line is ${JSON.stringify(l2)}, off the fixed line's end, and nothing was said (${status.text})`);
        const how = kept ? `keeps its start on the fixed line's end (its end at (${+l2.x1.toFixed(3)}, ${+l2.y1.toFixed(3)}))` : `is refused: ${status.text}`;
        await sleep(300);
        if (errors.length) throw new Error(`errors logged:\n  ${errors.join("\n  ")}`);
        console.log(`ok - sketch move: no manipulator on a selection; M, X 10, OK moves the circle to (10, 0) in one sketch_move commit, no chip of its own; Esc restores; a line held to a fixed line ${how}`);
    } catch (e) {
        if (out) {
            mkdirSync(out, { recursive: true });
            const shot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
            if (shot) writeFileSync(join(out, `sketch-move${webgl2 ? "-webgl2" : ""}-failed.png`), Buffer.from(shot.data, "base64"));
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
        if (!failed && !flag("--no-sketch-tools")) {
            try {
                await checkSketchCopies(cdp, `http://127.0.0.1:${port}`, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - sketch tools: ${e.message}`);
            }
        }
        if (!failed && !flag("--no-sketch-copy")) {
            try {
                await checkSketchCopy(cdp, `http://127.0.0.1:${port}`, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - sketch copy: ${e.message}`);
            }
        }
        if (!failed && !flag("--no-solid-tools")) {
            try {
                await checkSolidCopies(cdp, `http://127.0.0.1:${port}`, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - solid tools: ${e.message}`);
            }
        }
        if (!failed && !flag("--no-move")) {
            try {
                await checkMove(cdp, `http://127.0.0.1:${port}`, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - move: ${e.message}`);
            }
        }
        if (!failed && !flag("--no-sketch-move")) {
            try {
                await checkSketchMove(cdp, `http://127.0.0.1:${port}`, { webgl2: flag("--webgl2"), out });
            } catch (e) {
                failed++;
                console.error(`not ok - sketch move: ${e.message}`);
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
