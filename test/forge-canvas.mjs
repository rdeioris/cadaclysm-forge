// The forge's canvas ratio and size, against the View's clamp: unchanged under the
// device's largest texture; a window past it drawn at a ratio that fits, both sides
// scaled alike, and exactly the size the View's `resize` takes.
//
// Run: node test/forge-canvas.mjs
import assert from "node:assert";
import { drawingRatio, drawingSide } from "../forge-canvas.js";

// The View's resize, as `View::resize` does it: each side times the ratio in f32,
// rounded, then clamped into 1..max on its own.
const viewerSide = (css, r, max) => Math.min(Math.max(Math.round(Math.fround(Math.fround(css) * Math.fround(r))), 1), max);

// The normal case: a window well under the limit keeps the device ratio.
{
    assert.strictEqual(drawingRatio(2, 1600, 900, 8192), 2);
    assert.strictEqual(drawingRatio(1.25, 1917, 1000, 4096), 1.25);
    assert.strictEqual(drawingSide(1600, 2, 8192), 3200);
    assert.strictEqual(drawingSide(1917, 1.25, 4096), viewerSide(1917, 1.25, 4096));
}

// No limit known yet (the View not made), or no size: the ratio as given.
{
    assert.strictEqual(drawingRatio(2, 10000, 800, undefined), 2);
    assert.strictEqual(drawingRatio(2, 10000, 800, 0), 2);
    assert.strictEqual(drawingRatio(2, 0, 0, 4096), 2);
}

// A 10000 px wide window at a ratio of 2 against a 4096 limit: a ratio that fits, both
// sides within it, the aspect kept, and the View's own clamp never needed -- the two
// sizes are the same.
{
    const [w, h] = [10000, 1200];
    const r = drawingRatio(2, w, h, 4096);
    assert.ok(r < 2 && r > 0, `ratio ${r}`);
    const [bw, bh] = [drawingSide(w, r, 4096), drawingSide(h, r, 4096)];
    assert.ok(bw <= 4096 && bh <= 4096, `${bw} x ${bh}`);
    assert.ok(bw >= 4095, `the wide side uses the limit: ${bw}`);
    assert.ok(Math.abs(bw / bh - w / h) < 0.01, `aspect ${bw / bh} against ${w / h}`);
    assert.strictEqual(Math.round(Math.fround(Math.fround(w) * Math.fround(r))), bw, "the View's clamp is not what fits it");
    assert.deepStrictEqual([bw, bh], [viewerSide(w, r, 4096), viewerSide(h, r, 4096)]);
    // A viewport rect's width scaled by the same ratio fits the canvas.
    assert.ok(Math.round(w * r) <= 4096);
}

// A tall window: the height sets the ratio.
{
    const r = drawingRatio(2, 800, 9000, 8192);
    assert.ok(Math.abs(r - 8192 / 9000) < 1e-12, `ratio ${r}`);
    assert.ok(drawingSide(9000, r, 8192) <= 8192);
}

// Sweep: every size the ratio makes is the View's, and within the limit.
{
    for (const max of [2048, 4096, 8192]) {
        for (let w = 1; w < 12000; w += 997) {
            for (const h of [1, 333, 5000, 11111]) {
                for (const dpr of [1, 1.25, 1.5, 2]) {
                    const r = drawingRatio(dpr, w, h, max);
                    const bw = drawingSide(w, r, max), bh = drawingSide(h, r, max);
                    assert.ok(bw <= max && bh <= max, `${w}x${h}@${dpr}/${max}: ${bw} x ${bh}`);
                    assert.deepStrictEqual([bw, bh], [viewerSide(w, r, max), viewerSide(h, r, max)]);
                    // The unclamped product is within half a pixel of the limit at most.
                    assert.ok(Math.fround(Math.fround(w) * Math.fround(r)) < max + 0.5);
                }
            }
        }
    }
}
console.log("forge-canvas: ok");
