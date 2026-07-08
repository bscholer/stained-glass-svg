"use strict";
// Smoke tests for the browser trace pipeline, run in node (no DOM needed —
// traceGray takes a raw grayscale buffer). Each assertion guards a real
// regression in labelling / boundary tracing / EDT sliver filter, not just
// "JS works".
const assert = require("assert");
const { traceGray, otsu, distanceTransform, dp } = require("../site/trace.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("ok  -", name); }
  catch (e) { failures++; console.error("FAIL-", name, "\n   ", e.message); }
}

// A 3x3 grid of white cells walled off by a black frame + internal lines.
// The surrounding background touches the image border (dropped), so exactly
// nine enclosed cells should register as pieces.
function grid() {
  const W = 90, H = 90, gray = new Uint8Array(W * H).fill(255);
  const walls = new Set([0, 1, 29, 30, 31, 59, 60, 61, 88, 89]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (walls.has(x) || walls.has(y)) gray[y * W + x] = 0;
  return { gray, W, H };
}

test("pieces mode finds every enclosed cell", () => {
  const { gray, W, H } = grid();
  const out = traceGray(gray, W, H, "pieces", {});
  assert.strictEqual(out.count, 9, `expected 9 pieces, got ${out.count}`);
  assert.strictEqual((out.svg.match(/<path id="piece-/g) || []).length, 9);
  assert.ok(out.width === W && out.height === H);
});

test("lines mode traces the wall web as one shape", () => {
  const { gray, W, H } = grid();
  const out = traceGray(gray, W, H, "lines", {});
  assert.strictEqual(out.count, 1, `expected 1 web, got ${out.count}`);
});

test("min_width drops an uncuttable sliver but keeps the fat cells", () => {
  // three cells inside a frame: wide, a ~4px-thin strip, wide (full-height
  // walls so each is genuinely its own region)
  const W = 80, H = 40, gray = new Uint8Array(W * H).fill(255);
  const ink = (x, y) => { gray[y * W + x] = 0; };
  for (let x = 0; x < W; x++) { ink(x, 0); ink(x, 1); ink(x, H - 1); ink(x, H - 2); }
  for (let y = 0; y < H; y++) {
    ink(0, y); ink(1, y); ink(W - 1, y); ink(W - 2, y);   // frame
    ink(40, y); ink(41, y); ink(46, y); ink(47, y);        // walls -> thin strip at x42..45
  }
  // min_area 0 so min_width is the only thing that can drop a cell
  const wide = traceGray(gray, W, H, "pieces", { min_width: 0, min_area: 0 }).count;
  const cut = traceGray(gray, W, H, "pieces", { min_width: 6, min_area: 0 }).count;
  assert.strictEqual(wide, 3, `baseline should see all three cells, got ${wide}`);
  assert.strictEqual(cut, 2, `min_width should drop the one sliver, got ${cut}`);
});

test("otsu picks a cutoff that separates a clean bimodal histogram", () => {
  const g = new Uint8Array(1000);
  for (let i = 0; i < 500; i++) g[i] = 20;
  for (let i = 500; i < 1000; i++) g[i] = 200;
  const t = otsu(g);
  // dark mode (<=t) must be ink, bright mode (>t) must be background
  assert.ok(t >= 20 && t < 200, `threshold ${t} fails to separate the modes`);
});

test("EDT gives the true distance to the centre of a square", () => {
  const W = 21, H = 21, seed = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) { seed[x] = 1; seed[(H - 1) * W + x] = 1; }
  for (let y = 0; y < H; y++) { seed[y * W] = 1; seed[y * W + W - 1] = 1; }
  const d = distanceTransform(seed, W, H);
  assert.strictEqual(d[10 * W + 10], 10);   // centre is 10px from each wall
});

test("Douglas-Peucker collapses collinear points to the two endpoints", () => {
  const line = Array.from({ length: 10 }, (_, i) => [i, 0]);
  assert.strictEqual(dp(line, 0.5, false).length, 2);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nall trace tests passed");
