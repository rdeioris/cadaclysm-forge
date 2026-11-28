// Linked parts: a part file kept as a document component with a link back to its file, and a
// `component.derive` node that brings the part's bodies in as held bodies. No DOM: importable
// by the page, the worker and node. The page reads files (forge.js); this file turns their
// text into what the kernel takes and the commands' ops.
//
// # The layout (forge-model.js's contract, this part of it)
//
// A linked part named `<c>` (a component name: see `nameOf`) is
//   - the document component `<c>` (`{ op: "component", name, document, link: { path,
//     auto_update } }`), the part file's state, with its link -- a path relative to the parts
//     folder (spec docs/superpowers/specs/2026-11-28-forge-linked-parts-design.md);
//   - `p_<c>`, `component.derive` `{ component: "<c>", bodies: [keys], configuration?,
//     params? }`, `meta.forge: { kind: "part", file }` -- not an item (not held);
//   - per body `p_<c>__<key>`, `value` `{ value: "=p_<c>.bodies.<key>" }`, named "<c> <body>",
//     `meta.show: true`: a held body (forge-model.js `heldOf`), placed, joined, cut as any.
// A body key is the part's `part.body` name or, in a part with none (a forge file), a
// visible body item's head id (`i3`). Keys are read with `.`, so they must be names.
//
// # Here
//
//   hasLinks(kernel)                  the package has the link calls (else the UI hides)
//   nameOf(text)                      a component name off a file's stem: "puck (2).json" -> "puck_2"
//   isKey(s)                          a body key the derive can be read with: an identifier
//   partInfo(kernel, text)            `{ bodies: [{ key, name, ok, why? }], params: {name: value},
//                                     configurations: [names], units }` of a part file's text;
//                                     refused (Error) for one that is not a document or holds
//                                     components
//   componentInfo(kernel, doc, name)  `partInfo` of linked part `name`'s embedded copy (the
//                                     list's edit, with no file at hand)
//   linkRows(kernel, doc, sources?)   `check_links_from`'s rows (sources `{ path: text|null }`;
//                                     none: every row `missing`, which is how the page lists
//                                     the links without reading a file)
//   components(kernel, doc)           the document's component names (`document_save`'s
//                                     `components` keys), in name order
//   partOf(model, name)               `{ derive, bodies: [keys], configuration, params, file }`
//                                     of linked part `name` off its `p_<c>` node, or undefined
//   partOps(d, cmd, drop)             the ops of the part commands on a forge-commands.js draft
//                                     (`part`, `part_edit`, `part_update`, `relink`, `unlink`,
//                                     `part_remove`); false for any other command. `drop(ids)`
//                                     takes nodes out as the forge's delete does (the items
//                                     they are, their readers made stand-ins)
//   deriveId(c), bodyId(c, key)       the node ids

const K = "cadaclysm_blacksmith_";

export const hasLinks = (kernel) => typeof kernel?.[K + "document_check_links_from"] === "function";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isKey = (s) => typeof s === "string" && IDENT.test(s);

export const deriveId = (c) => `p_${c}`;
export const bodyId = (c, key) => `p_${c}__${key}`;

/// A component name off a file name: its stem, every run of other characters an `_`, a
/// leading digit prefixed, "part" for nothing left.
export function nameOf(file) {
    const stem = String(file ?? "").replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
    let s = stem.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!s) s = "part";
    if (/^[0-9]/.test(s)) s = `part_${s}`;
    return s;
}

function call(kernel, name, ...args) {
    const fn = kernel?.[K + name];
    if (typeof fn !== "function") throw new Error(`the kernel has no \`${K + name}\``);
    return fn(...args);
}

/// What a part file offers (see the header).
export function partInfo(kernel, text) {
    let lit;
    try { lit = JSON.parse(text); } catch { throw new Error("not a cadaclysm-blacksmith document (it is not JSON)"); }
    if (lit?.format !== "cadaclysm-blacksmith") throw new Error("not a cadaclysm-blacksmith document");
    if (lit.components && Object.keys(lit.components).length) throw new Error("the part holds parts of its own: a linked part cannot (components do not nest)");
    let doc;
    try { doc = call(kernel, "document_load", text); } catch (e) { throw new Error(String(e?.message ?? e).replace(/^document_load: /, "")); }
    try {
        return infoOf(kernel, doc, lit);
    } finally {
        call(kernel, "document_free", doc);
    }
}

/// `partInfo` of linked part `name`'s embedded copy in `doc` (its file not read): the copy's
/// state built again in a scratch document, its parameters and nodes added in order.
export function componentInfo(kernel, doc, name) {
    const saved = JSON.parse(call(kernel, "document_save", doc));
    const st = saved.components?.[name]?.document;
    if (!st) throw new Error(`no part \`${name}\``);
    const scratch = call(kernel, "document_new", st.units ?? "mm");
    try {
        const apply = (op) => call(kernel, "document_apply", scratch, JSON.stringify(op), undefined);
        for (const [n, v] of Object.entries(st.params ?? {})) apply({ op: "param", name: n, value: v });
        for (const node of st.nodes ?? []) apply({ op: "add", node });
        const info = infoOf(kernel, scratch, st);
        const named = st.configurations && typeof st.configurations === "object" ? Object.keys(st.configurations) : [];
        if (!info.configurations.length && named.length) info.configurations = named;
        return info;
    } finally {
        call(kernel, "document_free", scratch);
    }
}

// What a part document handle offers (`partInfo`'s answer); `lit` its file form.
function infoOf(kernel, doc, lit) {
    {
        const nodes = JSON.parse(call(kernel, "document_nodes", doc, null));
        const params = JSON.parse(call(kernel, "document_params", doc) ?? "{}");
        let configurations = [];
        try { configurations = JSON.parse(call(kernel, "document_configurations", doc)).map((c) => c.name ?? c).filter((n) => typeof n === "string"); } catch { configurations = []; }
        const marked = nodes.filter((n) => n.kind === "part.body" && typeof n.body === "string");
        let bodies;
        if (marked.length) {
            bodies = [...new Set(marked.map((n) => n.body))].map((name) => ({ key: name, name }));
        } else {
            // A forge file: its visible body items, by head id.
            const solid = new Set(["solid", "sheet"]);
            const status = JSON.parse(call(kernel, "document_evaluate", doc, true));
            const typeOf = new Map(status.map((s) => [s.id, s.type]));
            bodies = nodes
                .filter((n) => /^i(0|[1-9][0-9]*)$/.test(n.id) && !n.hidden && (solid.has(typeOf.get(n.id)) || /^(solid|sheet)\./.test(n.kind)))
                .map((n) => ({ key: n.id, name: typeof n.name === "string" ? n.name : n.id }));
        }
        bodies = bodies.map((b) => (isKey(b.key) ? { ...b, ok: true } : { ...b, ok: false, why: `\`${b.key}\` is not a name the forge can read a body by` }));
        return { bodies, params: plainParams(params), configurations, units: lit.units ?? "mm" };
    }
}

// `document_params`' JSON as `{ name: value }`: a parameter given as a record keeps its
// `value` (or its expression's text).
function plainParams(p) {
    const out = {};
    const entries = Array.isArray(p) ? p.map((x) => [x.name, x]) : Object.entries(p ?? {});
    for (const [name, v] of entries) {
        if (typeof name !== "string") continue;
        out[name] = v !== null && typeof v === "object" && !Array.isArray(v) ? (v.value ?? v.expr ?? v.text ?? JSON.stringify(v)) : v;
    }
    return out;
}

/// `check_links_from`'s rows (see the header).
export function linkRows(kernel, doc, sources = {}) {
    if (!hasLinks(kernel)) return [];
    return JSON.parse(call(kernel, "document_check_links_from", doc, JSON.stringify(sources)));
}

/// The document's component names, in name order.
export function components(kernel, doc) {
    const saved = JSON.parse(call(kernel, "document_save", doc));
    return Object.keys(saved.components ?? {}).sort();
}

/// Linked part `name` off its derive node (see the header).
export function partOf(model, name) {
    const derive = model.node(deriveId(name));
    if (!derive || derive.kind !== "component.derive") return undefined;
    return {
        derive,
        bodies: Array.isArray(derive.bodies) ? derive.bodies.slice() : [],
        configuration: typeof derive.configuration === "string" ? derive.configuration : null,
        params: derive.params && typeof derive.params === "object" ? { ...derive.params } : {},
        file: derive.meta?.forge?.file ?? null,
    };
}

const fail = (m) => { throw new Error(m); };

function checkName(op, name) {
    if (!isKey(name)) fail(`${op}: \`${name}\` is not a part name (letters, digits and _)`);
}

// The derive node's fields from a command's.
function deriveFields(cmd) {
    const out = {};
    if (typeof cmd.configuration === "string" && cmd.configuration) out.configuration = cmd.configuration;
    const params = {};
    for (const [k, v] of Object.entries(cmd.params ?? {})) {
        if (v === null || v === undefined || v === "") continue;
        params[k] = typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    if (Object.keys(params).length) out.params = params;
    return out;
}

function bodyNode(c, key, label) {
    return { id: bodyId(c, key), kind: "value", name: `${c} ${label ?? key}`, value: `=${deriveId(c)}.bodies.${key}`, meta: { show: true } };
}

function keysOf(op, bodies) {
    if (!Array.isArray(bodies) || !bodies.length) fail(`${op}: no body to bring in`);
    const keys = bodies.map((b) => (typeof b === "string" ? b : b?.key));
    for (const k of keys) if (!isKey(k)) fail(`${op}: \`${k}\` is not a name the forge can read a body by`);
    return keys;
}

// The labels of a command's bodies: `[{ key, name }]` or keys.
const labelsOf = (bodies) => new Map((bodies ?? []).map((b) => (typeof b === "string" ? [b, b] : [b.key, b.name ?? b.key])));

/// The ops of a part command on draft `d` (see the header); false for another command.
export function partOps(d, cmd, drop) {
    const op = cmd?.op;
    switch (op) {
        case "part": {
            const c = cmd.name;
            checkName(op, c);
            if (d.has(deriveId(c))) fail(`part: there is a part \`${c}\` already`);
            if (typeof cmd.text !== "string") fail("part: no part file");
            const keys = keysOf(op, cmd.bodies);
            const labels = labelsOf(cmd.bodies);
            const link = typeof cmd.path === "string" && cmd.path ? { path: cmd.path, ...(cmd.auto ? { auto_update: true } : {}) } : undefined;
            d.raw({ op: "component", name: c, document: cmd.text, ...(link ? { link } : {}) });
            d.add({ id: deriveId(c), kind: "component.derive", component: c, bodies: keys, ...deriveFields(cmd), meta: { forge: { kind: "part", file: cmd.file ?? cmd.path ?? null } } });
            for (const k of keys) d.add(bodyNode(c, k, labels.get(k)));
            return true;
        }
        case "part_edit": {
            const c = cmd.name;
            const derive = d.node(deriveId(c)) ?? fail(`part_edit: no part \`${c}\``);
            const keys = keysOf(op, cmd.bodies);
            const labels = labelsOf(cmd.bodies);
            const fields = deriveFields(cmd);
            d.set(deriveId(c), { bodies: keys, configuration: fields.configuration ?? null, params: fields.params ?? null });
            const had = Array.isArray(derive.bodies) ? derive.bodies : [];
            const gone = had.filter((k) => !keys.includes(k) && d.has(bodyId(c, k))).map((k) => bodyId(c, k));
            if (gone.length) drop(gone);
            const at = d.index(deriveId(c)) + 1;
            let next = at;
            for (const k of keys) {
                if (d.has(bodyId(c, k))) { next = d.index(bodyId(c, k)) + 1; continue; }
                d.add(bodyNode(c, k, labels.get(k)), next++);
            }
            return true;
        }
        case "part_update": {
            const parts = cmd.parts ?? {};
            const names = Object.keys(parts).sort();
            if (!names.length) fail("part_update: nothing to update");
            for (const c of names) {
                if (typeof parts[c] !== "string") fail(`part_update: no file for \`${c}\``);
                d.raw({ op: "component", name: c, document: parts[c] });
            }
            return true;
        }
        case "relink": {
            const c = cmd.name;
            if (typeof cmd.path !== "string" || !cmd.path) fail("relink: no path");
            d.raw({ op: "link", name: c, path: cmd.path, auto_update: Boolean(cmd.auto) });
            return true;
        }
        case "unlink": {
            d.raw({ op: "link", name: cmd.name, path: null });
            return true;
        }
        case "part_remove": {
            const c = cmd.name;
            const derive = d.node(deriveId(c));
            if (derive) drop([...(Array.isArray(derive.bodies) ? derive.bodies : []).map((k) => bodyId(c, k)).filter((id) => d.has(id)), deriveId(c)]);
            d.raw({ op: "component", name: c, document: null });
            return true;
        }
        default:
            return false;
    }
}
