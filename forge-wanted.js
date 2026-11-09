// The page's bridge helpers for the forge's worker.

// Every typed array's bytes in a message, however deep -- what crossed from the worker.
export function typedBytes(o, seen = new Set()) {
    if (!o || typeof o !== "object" || seen.has(o)) return 0;
    seen.add(o);
    if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && o instanceof SharedArrayBuffer)) return o.byteLength;
    let n = 0;
    for (const v of Object.values(o)) n += typedBytes(v, seen);
    return n;
}

// The wanted set's sender: the page lists what it wants shown each redraw, and a payload
// (a curve's floats, an image's corners) rides only the first time under its deps -- the
// worker keeps it by key. A key left out of a send is forgotten here, as the worker drops
// its payload then: shown again later, its payload goes again. `post` clones, never
// transfers, so the page keeps its arrays.
//
//   send(items, payloadOf)   posts { kind: "wanted", items }; payloadOf(item) is called for an
//                            item whose JSON deps differ from the last send's, and returns
//                            the fields to add (or nothing); an item's `ref` is the page's
//                            own object to read that from, and is left out of what is posted
//   reset()                  forget everything sent (a new worker)
export function createWantedSender(post) {
    let sent = new Map();   // key -> JSON.stringify(deps) as last sent
    return {
        send(items, payloadOf) {
            const next = new Map();
            const out = items.map((item) => {
                const deps = JSON.stringify(item.deps);
                next.set(item.key, deps);
                // `ref`: the page's own object the payload is read from, never sent.
                const { ref, ...plain } = item;
                if (sent.get(item.key) === deps) return plain;
                const payload = payloadOf?.(item);
                return payload ? { ...plain, ...payload } : plain;
            });
            sent = next;
            post({ kind: "wanted", items: out });
        },
        reset() { sent = new Map(); },
    };
}
