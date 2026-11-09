// The page's bridge helpers: the bytes a worker message carries.
//
// Run: node test/forge-wanted.mjs
import assert from "node:assert";
import { typedBytes, createWantedSender } from "../forge-wanted.js";

assert.strictEqual(typedBytes({ a: new Float32Array(4), b: { c: new Uint32Array(2) }, d: 3 }), 24);
const shared = new Float32Array(8);
assert.strictEqual(typedBytes({ a: shared, b: shared }), 32, "one array counted once");
assert.strictEqual(typedBytes(null), 0);
assert.strictEqual(typedBytes({ a: new ArrayBuffer(16), b: new SharedArrayBuffer(8) }), 24, "raw buffers count");
const cyclic = { a: new Uint8Array(3) }; cyclic.self = cyclic;
assert.strictEqual(typedBytes(cyclic), 3, "a cycle ends");
assert.strictEqual(typedBytes({ v: new DataView(new ArrayBuffer(10), 2, 4) }), 4, "a view counts its own window");
// The sender: floats only when deps changed since last sent under that key.
{
    const sent = []; const w = createWantedSender((m) => sent.push(m));
    const items = [{ key: "curve:1", deps: [3], kind: "curves", colour: [1, 0, 0] }];
    w.send(items, () => ({ beziers: new Float32Array(16) }));
    w.send(items, () => ({ beziers: new Float32Array(16) }));
    assert.ok(sent[0].items[0].beziers instanceof Float32Array, "first send carries the floats");
    assert.strictEqual(sent[1].items[0].beziers, undefined, "unchanged deps: no floats");
    assert.strictEqual(sent[0].kind, "wanted");
    w.reset(); w.send(items, () => ({ beziers: new Float32Array(16) }));
    assert.ok(sent[2].items[0].beziers, "after a reset, sent again");
    w.send([{ ...items[0], deps: [4] }], () => ({ beziers: new Float32Array(16) }));
    assert.ok(sent[3].items[0].beziers, "changed deps: sent again");
    // F10: a key that left and came back has no payload on the worker, so it goes again.
    w.send([], () => null); w.send([{ ...items[0], deps: [4] }], () => ({ beziers: new Float32Array(16) }));
    assert.ok(sent[5].items[0].beziers, "a key absent from one send is sent whole when it returns");
    // `ref` (the page's own object a payload is read from) never crosses: it is not cloneable data.
    const out = []; const r = createWantedSender((m) => out.push(m));
    const ref = { beziers: new Float32Array(4), fn() {} };
    r.send([{ key: "curve:2", deps: [1], kind: "curves", colour: [0, 0, 0], ref }], (it) => ({ beziers: it.ref.beziers }));
    assert.ok(!("ref" in out[0].items[0]), "ref is stripped");
    assert.doesNotThrow(() => structuredClone(out[0]), "and the message clones");
    assert.strictEqual(out[0].items[0].beziers, ref.beziers, "the payload read from it is there");
    r.send([{ key: "curve:2", deps: [1], kind: "curves", colour: [0, 0, 0], ref }], (it) => ({ beziers: it.ref.beziers }));
    assert.ok(!("ref" in out[1].items[0]), "ref is stripped on a repeat too");
}
console.log("forge-wanted: ok");
