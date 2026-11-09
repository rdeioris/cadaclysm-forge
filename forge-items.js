// The forge's shown things -- bodies, sketch curves, previews, reference images -- as
// View items, kept in step with the document. It runs in the forge's worker (forge-scene.js
// hands it the wanted set against the worker's own View), not on the page. Each redraw the page lists what it wants
// shown, by a key that names the thing and the `deps` it is drawn from; only a thing new
// or changed is shown again (the View uploads on every show and remove, so re-sending
// the whole document every redraw, as the old renderer's setScene was, would upload it
// every frame of a drag). Face colours -- the hover and the pick's highlights, and a
// selected body's tint -- change without an upload, and are sent only when they change.
// So does an item's own `colour` (a sketch curve selected or hovered): kept out of its
// deps, it is sent with `viewer.setColour` -- which rewrites the item's colour in place,
// no upload -- only when it differs, by value, from the colour it was shown or last set in.

// Every face of a body (0..faceCount-1) coloured `base` where one is given, then
// `overrides` (a face -> colour map, itself possibly undefined) laid on top of that --
// a selection's tint under the hover and pick highlights that already override it.
// Undefined out where there is nothing to show (no base, no overrides), so the caller
// clears the View's face colours with null rather than sending an empty map.
export function faceColoursOver(faceCount, base, overrides) {
    if (!base && !overrides) return undefined;
    const colours = {};
    if (base) for (let k = 0; k < faceCount; k++) colours[k] = base;
    if (overrides) for (const [k, v] of Object.entries(overrides)) colours[k] = v;
    return Object.keys(colours).length ? colours : undefined;
}

export function createItemSync(viewer) {
    const shown = new Map();   // key -> { id (null where the View refused it), deps, value, faces, colour }
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    // A colour as compared: its components joined, or null for none.
    const colourKey = (c) => (c ? Array.from(c).join() : null);
    const drop = (key, entry) => {
        if (entry.id !== null) viewer.remove(entry.id);
        shown.delete(key);
    };
    return {
        sync(wanted) {
            const keep = new Set(wanted.map((w) => w.key));
            for (const [key, entry] of shown) if (!keep.has(key)) drop(key, entry);
            for (const w of wanted) {
                let entry = shown.get(w.key);
                if (entry && !same(entry.deps, w.deps)) { drop(w.key, entry); entry = undefined; }
                if (!entry) {
                    let id = null;
                    try { id = w.show(); } catch (error) { if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) throw error; console.error(`${w.key}:`, error); }
                    // Shown in its colour: `show` applied it, so it is not sent again.
                    entry = { id, deps: w.deps.slice(), value: w.value ?? null, faces: null, colour: colourKey(w.colour) };
                    shown.set(w.key, entry);
                }
                if (entry.id === null) continue;
                // One item's refused colour (a face number past the solid's count, say) is
                // logged and left as it was -- tried again at the next sync -- not thrown
                // out of the worker's message handler.
                try {
                    const colour = colourKey(w.colour);
                    if (colour !== null && colour !== entry.colour) {
                        viewer.setColour(entry.id, Array.from(w.colour));
                        entry.colour = colour;
                    }
                    const faces = w.faceColours ? JSON.stringify(w.faceColours) : null;
                    if (faces !== entry.faces) {
                        viewer.setFaceColours(entry.id, w.faceColours ?? null);
                        entry.faces = faces;
                    }
                } catch (error) { if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) throw error; console.error(`${w.key}:`, error); }
            }
        },
        valueOf(id) {
            for (const entry of shown.values()) if (entry.id === id) return entry.value;
            return null;
        },
        clear() {
            for (const [key, entry] of shown) drop(key, entry);
        },
    };
}
