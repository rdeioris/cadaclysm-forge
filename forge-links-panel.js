// The linked parts' page side: the `parts` ribbon group (insert part, links), the part dialog,
// the linked-parts list in the side panel, and reading the part files. What it writes goes
// through the page's commands (forge-links.js `partOps`); what it shows is read off the
// document each time the page changes (`refresh`), so an undo, a redo or a load needs nothing
// of its own. Spec docs/superpowers/specs/2026-11-28-forge-linked-parts-design.md.
//
// # Files
//
// A page has no paths. Link paths are relative to the **parts folder** -- the document's own
// folder -- which the user picks once (`folder…`, or the first `check`):
// - Chromium: `showDirectoryPicker`, a handle kept for the session and read fresh on every
//   check; a part picked from inside it is linked by its path there (`dir.resolve`).
// - elsewhere: `<input webkitdirectory>`, the folder's files as they were when picked (a
//   check after the file changed needs the folder picked again).
// - no folder: a part is linked by its file name, and the text picked is what a check
//   reads for that path until a folder is picked.
//
//   createLinksPanel({ wasm, doc, model, run, say })
//       `doc()` / `model()` the page's replica and its model now; `run(cmd)` a command in the
//       page's order (its result: true / false, or a promise of that); `say(text, isError)`.
//     .refresh()     after every change (forge.js `afterChange`): the list read again; a part
//                    whose copy changed since it was checked shows unchecked again
//     .opened()      after a document is opened: names its linked parts, and checks them when
//                    a parts folder is held (then takes the auto ones in)
//     .available     the package has the link calls (else every control stays hidden)

import { hasLinks, partInfo, componentInfo, linkRows, partOf, nameOf, isKey } from "./forge-links.js";

const $ = (id) => document.getElementById(id);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createLinksPanel({ wasm, doc, model, run, say }) {
    const available = hasLinks(wasm);
    const panel = {
        available,
        refresh() {},
        opened() {},
    };
    if (!available) return panel;

    const group = $("parts-group"), insertEl = $("part-insert"), showEl = $("links-show");
    const listBox = $("links"), listEl = $("links-list"), noteEl = $("links-note");
    const checkEl = $("links-check"), updateAllEl = $("links-update-all"), folderEl = $("links-folder");
    const dialog = $("part-dialog"), form = $("part-form");
    const fileInput = $("part-file"), folderInput = $("part-folder");
    group.hidden = false;

    // ---- files

    let dirHandle = null;            // Chromium: the parts folder
    let folderFiles = null;          // elsewhere: Map path -> File, as picked
    const remembered = new Map();    // path -> text picked this session (no folder held)

    const hasFolder = () => dirHandle !== null || folderFiles !== null;

    async function pickFolder() {
        if (window.showDirectoryPicker) {
            try {
                dirHandle = await window.showDirectoryPicker({ id: "forge-parts", mode: "read" });
                folderFiles = null;
                return true;
            } catch (e) {
                if (e?.name === "AbortError") return false;
                // A frame that forbids the picker: the input below.
            }
        }
        const files = await new Promise((resolve) => {
            folderInput.onchange = () => { resolve([...(folderInput.files ?? [])]); folderInput.value = ""; };
            folderInput.oncancel = () => resolve(null);
            folderInput.click();
        });
        if (!files || !files.length) return false;
        folderFiles = new Map();
        for (const f of files) {
            const rel = (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name;
            folderFiles.set(rel, f);
        }
        dirHandle = null;
        return true;
    }

    // A link path's text, or null (missing): read through the folder, else what was picked.
    async function read(path) {
        try {
            if (dirHandle) {
                const parts = path.split("/");
                if (parts.includes("..")) return null;   // outside the folder: not reachable from here
                let dir = dirHandle;
                for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
                const fh = await dir.getFileHandle(parts[parts.length - 1]);
                return await (await fh.getFile()).text();
            }
            if (folderFiles) {
                const f = folderFiles.get(path);
                return f ? await f.text() : null;
            }
        } catch {
            return null;
        }
        return remembered.has(path) ? remembered.get(path) : null;
    }

    // A part file picked: `{ name, path, text }`, the path relative to the parts folder when
    // the file is inside it, else its name. Null when cancelled.
    async function pickFile() {
        if (window.showOpenFilePicker) {
            try {
                const [fh] = await window.showOpenFilePicker({ id: "forge-parts", multiple: false, types: [{ description: "cadaclysm-blacksmith document", accept: { "application/json": [".json", ".blacksmith"] } }], ...(dirHandle ? { startIn: dirHandle } : {}) });
                const file = await fh.getFile();
                const inside = dirHandle ? await dirHandle.resolve(fh) : null;
                return { name: file.name, path: inside ? inside.join("/") : file.name, text: await file.text() };
            } catch (e) {
                if (e?.name === "AbortError") return null;
            }
        }
        const file = await new Promise((resolve) => {
            fileInput.onchange = () => { resolve(fileInput.files?.[0] ?? null); fileInput.value = ""; };
            fileInput.oncancel = () => resolve(null);
            fileInput.click();
        });
        if (!file) return null;
        let path = file.name;
        if (folderFiles) for (const [p, f] of folderFiles) if (f.name === file.name && f.size === file.size && f.lastModified === file.lastModified) { path = p; break; }
        return { name: file.name, path, text: await file.text() };
    }

    // ---- what the document holds

    // `name -> { status, hash, text?, message? }` from the last check, `hash` the copy's then.
    const checked = new Map();

    // Every part: the linked ones (`check_links_from`, nothing read) and the embedded ones (a
    // derive node, no link), in name order.
    function parts() {
        const rows = linkRows(wasm, doc());
        const out = new Map(rows.map((r) => [r.name, { name: r.name, path: r.path, auto: r.auto_update, hash: r.hash, linked: true }]));
        for (const n of model().nodes()) {
            if (n.kind !== "component.derive" || !n.id.startsWith("p_")) continue;
            const c = n.component;
            if (typeof c === "string" && !out.has(c)) out.set(c, { name: c, path: null, auto: false, hash: null, linked: false });
        }
        return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    function statusOf(p) {
        if (!p.linked) return null;
        const c = checked.get(p.name);
        return c && c.hash === p.hash ? c : { status: "unchecked" };
    }

    const LABEL = { unchecked: "unchecked", up_to_date: "up to date", changed: "changed", missing: "missing", unreadable: "unreadable" };

    function render() {
        const all = parts();
        listBox.hidden = !all.length && showEl.getAttribute("aria-pressed") !== "true";
        listEl.replaceChildren();
        const changed = all.filter((p) => statusOf(p)?.status === "changed");
        updateAllEl.disabled = !changed.length;
        checkEl.disabled = !all.some((p) => p.linked);
        for (const p of all) {
            const li = document.createElement("li");
            const st = statusOf(p);
            const name = document.createElement("span"); name.className = "name"; name.textContent = p.name;
            const chip = document.createElement("span"); chip.className = `chip ${st ? st.status : "embedded"}`;
            chip.textContent = st ? LABEL[st.status] : "embedded";
            if (st?.message) chip.title = st.message;
            const path = document.createElement("span"); path.className = "path";
            path.textContent = p.linked ? p.path : "no link: the copy is the document's own";
            path.title = path.textContent;
            const tools = document.createElement("span"); tools.className = "tools";
            const button = (label, title, fn, disabled = false) => {
                const b = document.createElement("button");
                b.textContent = label; b.title = title; b.disabled = disabled;
                b.addEventListener("click", () => fn());
                tools.append(b);
                return b;
            };
            if (p.linked) button("update", "take the changed file's new copy in", () => update([p.name]), st?.status !== "changed");
            button("relink", "link this part to another file (or this one moved)", () => relink(p));
            if (p.linked) button("break", "keep the copy and drop the link: the file is never read again", () => brk(p));
            button("edit", "its bodies, configuration and parameters", () => edit(p));
            button("remove", "take the part and its bodies out of the document", () => remove(p));
            if (p.linked) {
                const auto = document.createElement("label");
                const box = document.createElement("input"); box.type = "checkbox"; box.checked = Boolean(p.auto);
                box.addEventListener("change", () => run({ op: "relink", name: p.name, path: p.path, auto: box.checked }));
                auto.append(box, " auto");
                auto.title = "update this part by itself when the document is opened and its file changed";
                tools.append(auto);
            }
            li.append(name, chip, path, tools);
            listEl.append(li);
        }
    }

    // ---- check and update

    async function check({ ask = true } = {}) {
        if (!hasFolder() && ask && !(await pickFolder()) && !remembered.size) return null;
        const linked = parts().filter((p) => p.linked);
        const sources = {};
        for (const p of linked) sources[p.path] = await read(p.path);
        const rows = linkRows(wasm, doc(), sources);
        for (const r of rows) checked.set(r.name, { status: r.status, hash: r.hash, message: r.message, text: r.status === "changed" ? sources[r.path] : undefined, auto: r.auto_update });
        render();
        const count = (s) => rows.filter((r) => r.status === s).length;
        const bits = [["changed", "changed"], ["missing", "missing"], ["unreadable", "unreadable"]].filter(([s]) => count(s)).map(([s, w]) => `${count(s)} ${w}`);
        say(bits.length ? `linked parts: ${bits.join(", ")}` : `linked parts: ${plural(rows.length, "part")} up to date`, count("missing") + count("unreadable") > 0);
        return rows;
    }

    async function update(names) {
        const texts = {};
        for (const n of names) {
            const c = checked.get(n);
            if (c?.text !== undefined) texts[n] = c.text;
        }
        if (!Object.keys(texts).length) return false;
        const ok = await run({ op: "part_update", parts: texts });
        if (ok !== false) {
            // The copies are the files now: up to date, under their new hashes.
            const rows = linkRows(wasm, doc());
            for (const n of Object.keys(texts)) {
                const r = rows.find((x) => x.name === n);
                if (r) checked.set(n, { status: "up_to_date", hash: r.hash });
            }
            render();
            say(`updated ${plural(Object.keys(texts).length, "linked part")}: ${Object.keys(texts).join(", ")}`);
        }
        return ok;
    }

    async function relink(p) {
        const picked = await pickFile();
        if (!picked) return;
        try { partInfo(wasm, picked.text); } catch (e) { say(`relink: ${picked.name}: ${e.message}`, true); return; }
        if (!dirHandle && !folderFiles) remembered.set(picked.path, picked.text);
        const ok = await run({ op: "relink", name: p.name, path: picked.path, auto: Boolean(p.auto) });
        if (ok !== false) await check({ ask: false });
    }

    async function brk(p) {
        if (!window.confirm(`Break the link of ${p.name}? Its copy stays in the document, and ${p.path} is never read again.`)) return;
        await run({ op: "unlink", name: p.name });
        checked.delete(p.name);
    }

    async function remove(p) {
        if (!window.confirm(`Remove ${p.name} and its bodies from the document? What is made from them stays, unresolved.`)) return;
        await run({ op: "part_remove", name: p.name });
        checked.delete(p.name);
    }

    // ---- the part dialog

    // `{ name, path, auto, bodies, configuration, params }` the user chose, or null.
    function ask({ title, ok, info, name, path, auto, bodies, configuration, params, editing }) {
        $("part-title").textContent = title;
        $("part-ok").textContent = ok;
        $("part-error").textContent = "";
        const nameEl = $("part-name"), pathEl = $("part-path");
        nameEl.value = name; nameEl.disabled = editing;
        pathEl.value = path ?? ""; pathEl.disabled = editing;
        pathEl.closest("label").hidden = editing;
        const bodyBox = $("part-bodies");
        bodyBox.replaceChildren(Object.assign(document.createElement("legend"), { textContent: "bodies" }));
        for (const b of info.bodies) {
            const l = document.createElement("label");
            const box = document.createElement("input"); box.type = "checkbox"; box.value = b.key;
            box.checked = b.ok && (bodies ? bodies.includes(b.key) : true);
            box.disabled = !b.ok;
            if (!b.ok) { l.className = "off"; l.title = b.why; }
            l.append(box, ` ${b.name}${b.name !== b.key ? ` (${b.key})` : ""}`);
            bodyBox.append(l);
        }
        if (!info.bodies.length) bodyBox.append(Object.assign(document.createElement("span"), { textContent: "the part has no bodies" }));
        const configRow = $("part-config-row"), configEl = $("part-config");
        configRow.hidden = !info.configurations.length;
        configEl.replaceChildren(new Option("(the part as saved)", ""), ...info.configurations.map((c) => new Option(c, c)));
        configEl.value = configuration ?? "";
        const paramBox = $("part-params");
        paramBox.replaceChildren(Object.assign(document.createElement("legend"), { textContent: "parameters (blank: the part's own)" }));
        const names = Object.keys(info.params);
        paramBox.hidden = !names.length;
        for (const n of names) {
            const l = document.createElement("label");
            const input = document.createElement("input"); input.dataset.param = n;
            input.placeholder = String(info.params[n]);
            input.value = params && params[n] !== undefined ? String(params[n]) : "";
            l.append(`${n} `, input);
            paramBox.append(l);
        }
        $("part-auto").checked = Boolean(auto);
        $("part-auto").closest("label").hidden = editing;
        return new Promise((resolve) => {
            const done = () => {
                dialog.removeEventListener("close", done);
                if (dialog.returnValue !== "ok") { resolve(null); return; }
                const chosen = [...bodyBox.querySelectorAll("input:checked")].map((b) => b.value);
                const ps = {};
                for (const input of paramBox.querySelectorAll("input")) if (input.value.trim() !== "") ps[input.dataset.param] = input.value.trim();
                resolve({ name: nameEl.value.trim(), path: pathEl.value.trim(), auto: $("part-auto").checked, bodies: chosen.map((k) => ({ key: k, name: info.bodies.find((b) => b.key === k)?.name ?? k })), configuration: configEl.value || null, params: ps });
            };
            form.onsubmit = (e) => {
                if (e.submitter?.value !== "ok") return;
                const err = (m) => { e.preventDefault(); $("part-error").textContent = m; };
                if (!editing && !isKey(nameEl.value.trim())) return err("the name takes letters, digits and _, and starts with a letter");
                if (!editing && parts().some((p) => p.name === nameEl.value.trim())) return err(`there is a part ${nameEl.value.trim()} already`);
                if (!editing && !pathEl.value.trim()) return err("the file's path is needed");
                if (!bodyBox.querySelector("input:checked")) return err("tick a body to bring in");
            };
            dialog.addEventListener("close", done);
            dialog.returnValue = "";
            dialog.showModal();
        });
    }

    function freeName(base) {
        const taken = new Set(parts().map((p) => p.name));
        if (!taken.has(base)) return base;
        for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
    }

    async function insert() {
        const picked = await pickFile();
        if (!picked) return;
        let info;
        try { info = partInfo(wasm, picked.text); } catch (e) { say(`insert part: ${picked.name}: ${e.message}`, true); return; }
        const chosen = await ask({ title: `Insert ${picked.name}`, ok: "insert", info, name: freeName(nameOf(picked.name)), path: picked.path, auto: false });
        if (!chosen) return;
        if (!dirHandle && !folderFiles) remembered.set(chosen.path, picked.text);
        const ok = await run({ op: "part", name: chosen.name, path: chosen.path, auto: chosen.auto, text: picked.text, file: picked.name, bodies: chosen.bodies, configuration: chosen.configuration, params: chosen.params });
        if (ok !== false) {
            const r = linkRows(wasm, doc()).find((x) => x.name === chosen.name);
            if (r) checked.set(chosen.name, { status: chosen.path === picked.path ? "up_to_date" : "unchecked", hash: r.hash });
            render();
            say(`${chosen.name}: ${plural(chosen.bodies.length, "body", "bodies")} linked to ${chosen.path}`);
        }
    }

    async function edit(p) {
        const cur = partOf(model(), p.name);
        let info;
        try { info = componentInfo(wasm, doc(), p.name); } catch (e) { say(`edit part: ${e.message}`, true); return; }
        const chosen = await ask({ title: `Edit ${p.name}`, ok: "apply", info, name: p.name, path: p.path, editing: true, bodies: cur?.bodies, configuration: cur?.configuration, params: cur?.params });
        if (!chosen) return;
        await run({ op: "part_edit", name: p.name, bodies: chosen.bodies, configuration: chosen.configuration, params: chosen.params });
    }

    // ---- wiring

    insertEl.addEventListener("click", () => insert());
    showEl.addEventListener("click", () => {
        const on = showEl.getAttribute("aria-pressed") !== "true";
        showEl.setAttribute("aria-pressed", String(on));
        render();
        if (on) listBox.scrollIntoView({ block: "nearest" });
    });
    checkEl.addEventListener("click", () => check());
    updateAllEl.addEventListener("click", () => update(parts().filter((p) => statusOf(p)?.status === "changed").map((p) => p.name)));
    folderEl.addEventListener("click", async () => { if (await pickFolder()) await check({ ask: false }); });

    panel.refresh = () => render();
    panel.opened = async () => {
        checked.clear();
        const linked = parts().filter((p) => p.linked);
        render();
        if (!linked.length) { noteEl.textContent = ""; return; }
        if (!hasFolder()) {
            noteEl.textContent = `${plural(linked.length, "linked part")}: check for changes`;
            say(`this document links ${plural(linked.length, "part")} -- check them in the linked parts list`);
            return;
        }
        noteEl.textContent = "";
        const rows = await check({ ask: false });
        const auto = (rows ?? []).filter((r) => r.status === "changed" && r.auto_update).map((r) => r.name);
        if (auto.length) await update(auto);
    };
    // A check clears the note.
    checkEl.addEventListener("click", () => { noteEl.textContent = ""; });
    render();
    return panel;
}

