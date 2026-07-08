"use strict";
// trace.js — client-side port of glass2svg.py. Turns a grayscale drawing into
// clean, cut-ready SVG paths entirely in the browser: binarize the lead lines,
// throw away colour, trace each glass cell (or the line web), smooth + straighten
// the contours, and emit filled paths. No server, no upload.
//
// Faithful to the Python: fixed/Otsu threshold, morphology, 2x-resolution trace
// with ink grow, Gaussian contour smoothing, centripetal Catmull-Rom béziers,
// corner-bounded straight-run flattening, and a distance-transform sliver filter.
// OpenCV's findContours/distanceTransform are replaced with connected-component
// labelling + Moore boundary tracing + a Felzenszwalb EDT.

const SVGNS_T = "http://www.w3.org/2000/svg";

// ---------- small vector + number helpers --------------------------------
const nf = (v) => { const s = v.toFixed(1); return s.endsWith(".0") ? s.slice(0, -2) : s; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const hyp = (v) => Math.hypot(v[0], v[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

// ---------- decode -------------------------------------------------------
function decodeToGray(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { reject(new Error("could not decode image — upload a PNG/JPG")); return; }
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      // Flatten onto white first: a transparent PNG background is glass, not
      // ink. Without this, transparent pixels read as (0,0,0,0) — pure black —
      // which inverts the whole drawing (background becomes one giant piece,
      // real pieces vanish). OpenCV's decode did this implicitly.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        // ITU-R 601 luma, matching OpenCV's IMREAD_GRAYSCALE weights
        gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114 + 500) / 1000 | 0;
      }
      resolve({ gray, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not decode image — upload a PNG/JPG")); };
    img.src = url;
  });
}

// ---------- binarize -----------------------------------------------------
function otsu(gray) {
  const hist = new Float64Array(256);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// elliptical (disk) structuring-element offsets of radius r
function diskOffsets(r) {
  const off = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r) off.push([dx, dy]);
  return off;
}

function morph(mask, w, h, off, erode) {
  // dilate: 255 if any neighbour is ink; erode: 0 if any neighbour is empty.
  // Out-of-bounds counts as empty (matches OpenCV's default border).
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 255 : 0;
      for (const [dx, dy] of off) {
        const nx = x + dx, ny = y + dy;
        const oob = nx < 0 || ny < 0 || nx >= w || ny >= h;
        if (erode) { if (oob || mask[ny * w + nx] === 0) { v = 0; break; } }
        else if (!oob && mask[ny * w + nx] === 255) { v = 255; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function binarize(gray, w, h, threshold, invert, close) {
  const thr = threshold === null || threshold === undefined ? otsu(gray) : threshold;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] <= thr ? 255 : 0;   // BINARY_INV: dark = ink
  if (invert) for (let i = 0; i < w * h; i++) mask[i] = 255 - mask[i];
  if (close > 0) {
    const off = diskOffsets(close);
    mask = morph(mask, w, h, off, false);   // dilate
    mask = morph(mask, w, h, off, true);    // erode  -> close
  }
  return mask;
}

// ---------- 2x prepare ---------------------------------------------------
function prepareMask(mask, w, h, grow, scale) {
  const w2 = w * scale, h2 = h * scale;
  let up = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const sy = (y / scale) | 0;
    for (let x = 0; x < w2; x++) up[y * w2 + x] = mask[sy * w + ((x / scale) | 0)];
  }
  if (grow > 0) up = morph(up, w2, h2, diskOffsets(Math.max(1, Math.round(grow * scale))), false);
  return { mask: up, w: w2, h: h2 };
}

// ---------- Felzenszwalb squared EDT -------------------------------------
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// distance (in px) from every seed==false pixel to the nearest seed==true pixel
function distanceTransform(seed, w, h) {
  const INF = 1e12;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = seed[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {                 // columns
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {                 // rows
    const base = y * w;
    for (let x = 0; x < w; x++) f[x] = g[base + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[base + x] = Math.sqrt(d[x]);
  }
  return g;
}

// ---------- connected components (8-connectivity) ------------------------
function labelComponents(mask, w, h, dist) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    next++;
    let count = 0, minx = w, miny = h, maxx = 0, maxy = 0, maxDist = 0;
    labels[s] = next; stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      count++;
      const x = p % w, y = (p / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (dist && dist[p] > maxDist) maxDist = dist[p];
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) { labels[q] = next; stack.push(q); }
        }
      }
    }
    comps.push({ label: next, count, minx, miny, maxx, maxy, maxDist });
  }
  return { labels, comps };
}

// ---------- Moore boundary trace -----------------------------------------
const MOORE = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
function traceBoundary(labels, w, h, label, ox, oy) {
  // start at the first labelled pixel (top-most, left-most)
  let sx = -1, sy = -1;
  for (let y = 0; y < h && sx < 0; y++)
    for (let x = 0; x < w; x++) if (labels[y * w + x] === label) { sx = x; sy = y; break; }
  if (sx < 0) return [];
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === label;
  const ring = [[sx + ox, sy + oy]];
  let cx = sx, cy = sy, b = 7;
  const max = w * h * 4 + 16;
  for (let it = 0; it < max; it++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const dir = (b + 1 + k) % 8;
      const nx = cx + MOORE[dir][0], ny = cy + MOORE[dir][1];
      if (on(nx, ny)) { b = (dir + 4) % 8; cx = nx; cy = ny; ring.push([cx + ox, cy + oy]); found = true; break; }
    }
    if (!found) break;
    if (cx === sx && cy === sy) { ring.pop(); break; }
  }
  return ring;
}

const shoelace = (pts) => {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
};

// enclosed holes of a component: non-label pixels that can't reach the padded
// bbox border. Returns an array of hole rings (image coords), largest first.
function componentHoles(labels, w, h, comp) {
  const x0 = Math.max(0, comp.minx - 1), y0 = Math.max(0, comp.miny - 1);
  const x1 = Math.min(w - 1, comp.maxx + 1), y1 = Math.min(h - 1, comp.maxy + 1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const isNon = (lx, ly) => labels[(y0 + ly) * w + (x0 + lx)] !== comp.label;
  const outside = new Uint8Array(bw * bh);
  const stack = [];
  const seed = (lx, ly) => { const i = ly * bw + lx; if (!outside[i] && isNon(lx, ly)) { outside[i] = 1; stack.push(i); } };
  for (let lx = 0; lx < bw; lx++) { seed(lx, 0); seed(lx, bh - 1); }
  for (let ly = 0; ly < bh; ly++) { seed(0, ly); seed(bw - 1, ly); }
  while (stack.length) {
    const i = stack.pop(), lx = i % bw, ly = (i / bw) | 0;
    if (lx > 0) seed(lx - 1, ly); if (lx < bw - 1) seed(lx + 1, ly);
    if (ly > 0) seed(lx, ly - 1); if (ly < bh - 1) seed(lx, ly + 1);
  }
  const hlabels = new Int32Array(bw * bh);
  const holes = [];
  let hn = 0;
  for (let i = 0; i < bw * bh; i++) {
    if (outside[i] || hlabels[i]) continue;
    const lx0 = i % bw, ly0 = (i / bw) | 0;
    if (!isNon(lx0, ly0)) continue;
    hn++;
    const st = [i]; hlabels[i] = hn;
    while (st.length) {
      const p = st.pop(), lx = p % bw, ly = (p / bw) | 0;
      const push = (nx, ny) => { const q = ny * bw + nx; if (!hlabels[q] && !outside[q] && isNon(nx, ny)) { hlabels[q] = hn; st.push(q); } };
      if (lx > 0) push(lx - 1, ly); if (lx < bw - 1) push(lx + 1, ly);
      if (ly > 0) push(lx, ly - 1); if (ly < bh - 1) push(lx, ly + 1);
    }
    const ring = traceBoundary(hlabels, bw, bh, hn, x0, y0);
    if (ring.length >= 6) holes.push(ring);
  }
  return holes;
}

// ---------- contour fitting (straight runs + curves) ---------------------
function gaussianSmoothClosed(pts, sigma) {
  const n = pts.length;
  if (sigma <= 0 || n < 8) return pts;
  const radius = Math.max(1, Math.floor(3 * sigma));
  const kernel = [];
  let ksum = 0;
  for (let x = -radius; x <= radius; x++) { const k = Math.exp(-(x * x) / (2 * sigma * sigma)); kernel.push(k); ksum += k; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let j = -radius; j <= radius; j++) {
      const p = pts[((i + j) % n + n) % n], wk = kernel[j + radius];
      sx += p[0] * wk; sy += p[1] * wk;
    }
    out[i] = [sx, sy];
  }
  return out;
}

function maxDev(pts, i, j) {
  const a = pts[i], b = pts[j], ab = sub(b, a), len = hyp(ab);
  if (len < 1e-9) return 0;
  let m = 0;
  for (let k = i; k <= j; k++) {
    const rel = sub(pts[k], a);
    const cross = Math.abs(ab[0] * rel[1] - ab[1] * rel[0]);
    if (cross > m) m = cross;
  }
  return m / len;
}

function angleBetween(v, w) {
  const na = hyp(v), nb = hyp(w);
  if (na < 1e-9 || nb < 1e-9) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot(v, w) / (na * nb)))) * 180 / Math.PI;
}

function cornerBounded(pts, i, j, k = 10, thresh = 18) {
  const n = pts.length, chord = sub(pts[j], pts[i]);
  const startOk = i <= k || angleBetween(sub(pts[i], pts[i - k]), chord) > thresh;
  const endOk = j >= n - 1 - k || angleBetween(sub(pts[Math.min(j + k, n - 1)], pts[j]), chord) > thresh;
  return startOk && endOk;
}

function bridgeRuns(pts, runs, gap = 44, maxAngle = 12) {
  while (true) {
    if (runs.length < 2) return runs;
    const merged = [runs[0]];
    for (let r = 1; r < runs.length; r++) {
      const [a, b] = runs[r], [pa, pb] = merged[merged.length - 1];
      const chordPrev = sub(pts[pb], pts[pa]), chordNext = sub(pts[b], pts[a]);
      if (hyp(sub(pts[a], pts[pb])) <= gap && angleBetween(chordPrev, chordNext) <= maxAngle)
        merged[merged.length - 1] = [pa, b];
      else merged.push([a, b]);
    }
    if (merged.length === runs.length) return merged;
    runs = merged;
  }
}

function lineRuns(pts, tol, minLen) {
  const n = pts.length, runs = [];
  let i = 0;
  while (i < n - 2) {
    if (maxDev(pts, i, Math.min(i + 2, n - 1)) > tol) { i++; continue; }
    let good = Math.min(i + 2, n - 1), step = 4;
    while (good < n - 1) {
      const j = Math.min(good + step, n - 1);
      if (maxDev(pts, i, j) <= tol) { good = j; step *= 2; }
      else {
        let lo = good, hi = j;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (maxDev(pts, i, mid) <= tol) lo = mid; else hi = mid; }
        good = lo; break;
      }
    }
    if (hyp(sub(pts[good], pts[i])) >= minLen && cornerBounded(pts, i, good)) { runs.push([i, good]); i = good; }
    else i += Math.max(1, (good - i) >> 2);
  }
  return bridgeRuns(pts, runs);
}

function rotateToCorner(pts) {
  const k = 5, n = pts.length;
  if (n < 3 * k) return pts;
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) { const f = sub(pts[(i + k) % n], pts[i]); ang[i] = Math.atan2(f[1], f[0]); }
  let bi = 0, bt = -1;
  for (let i = 0; i < n; i++) {
    let t = Math.abs(((ang[(i + k) % n] - ang[i] + Math.PI) % (2 * Math.PI)) - Math.PI);
    if (t > bt) { bt = t; bi = i; }
  }
  return pts.slice(bi).concat(pts.slice(0, bi));
}

const fmtPt = (p, scale) => `${nf(p[0] / scale)} ${nf(p[1] / scale)}`;

// Douglas-Peucker; keeps endpoints. `closed` fits a wrap-around segment.
function dp(pts, eps, closed) {
  const src = closed ? pts.concat([pts[0]]) : pts;
  const nn = src.length;
  if (nn < 3) return closed ? pts : src.slice();
  const keep = new Uint8Array(nn); keep[0] = keep[nn - 1] = 1;
  const stack = [[0, nn - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let md = 0, idx = -1;
    const a = src[i], b = src[j], ab = sub(b, a), L = hyp(ab) || 1;
    for (let k = i + 1; k < j; k++) {
      const rel = sub(src[k], a);
      const dd = Math.abs(ab[0] * rel[1] - ab[1] * rel[0]) / L;
      if (dd > md) { md = dd; idx = k; }
    }
    if (md > eps && idx > 0) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  const out = [];
  for (let k = 0; k < nn; k++) if (keep[k]) out.push(src[k]);
  if (closed) out.pop();
  return out;
}

function catmullRomD(pts) {
  const n = pts.length;
  if (n < 4) return polylineD(pts);
  const d = [`M${nf(pts[0][0])} ${nf(pts[0][1])}`];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const dt0 = Math.max(Math.sqrt(hyp(sub(p1, p0))), 1e-4);
    const dt1 = Math.max(Math.sqrt(hyp(sub(p2, p1))), 1e-4);
    const dt2 = Math.max(Math.sqrt(hyp(sub(p3, p2))), 1e-4);
    const m1 = add(sub(mul(sub(p1, p0), 1 / dt0), mul(sub(p2, p0), 1 / (dt0 + dt1))), mul(sub(p2, p1), 1 / dt1));
    const m2 = add(sub(mul(sub(p2, p1), 1 / dt1), mul(sub(p3, p1), 1 / (dt1 + dt2))), mul(sub(p3, p2), 1 / dt2));
    const c1 = add(p1, mul(m1, dt1 / 3)), c2 = sub(p2, mul(m2, dt1 / 3));
    d.push(`C${nf(c1[0])} ${nf(c1[1])} ${nf(c2[0])} ${nf(c2[1])} ${nf(p2[0])} ${nf(p2[1])}`);
  }
  d.push("Z");
  return d.join(" ");
}

function catmullRomOpen(pts, scale) {
  const m = pts.length, cmds = [];
  for (let i = 0; i < m - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, m - 1)];
    const dt0 = Math.max(Math.sqrt(hyp(sub(p1, p0))), 1e-4);
    const dt1 = Math.max(Math.sqrt(hyp(sub(p2, p1))), 1e-4);
    const dt2 = Math.max(Math.sqrt(hyp(sub(p3, p2))), 1e-4);
    const m1 = add(sub(mul(sub(p1, p0), 1 / dt0), mul(sub(p2, p0), 1 / (dt0 + dt1))), mul(sub(p2, p1), 1 / dt1));
    const m2 = add(sub(mul(sub(p2, p1), 1 / dt1), mul(sub(p3, p1), 1 / (dt1 + dt2))), mul(sub(p3, p2), 1 / dt2));
    const c1 = add(p1, mul(m1, dt1 / 3)), c2 = sub(p2, mul(m2, dt1 / 3));
    cmds.push(`C${fmtPt(c1, scale)} ${fmtPt(c2, scale)} ${fmtPt(p2, scale)}`);
  }
  return cmds;
}

function polylineD(pts) {
  return "M" + pts.map((p) => `${nf(p[0])} ${nf(p[1])}`).join(" L") + " Z";
}

function curveChunk(pts, simplify, smooth, scale) {
  if (simplify > 0 && pts.length > 2) pts = dp(pts, simplify, false);
  if (!smooth || pts.length < 3) return pts.slice(1).map((p) => `L${fmtPt(p, scale)}`);
  return catmullRomOpen(pts, scale);
}

function mixedD(pts, runs, simplify, smooth, scale) {
  const n = pts.length;
  const d = [`M${fmtPt(pts[0], scale)}`];
  let pos = 0;
  for (const [a, b] of runs) {
    if (a > pos) d.push(...curveChunk(pts.slice(pos, a + 1), simplify, smooth, scale));
    d.push(`L${fmtPt(pts[b], scale)}`);
    pos = b;
  }
  if (pos < n - 1) d.push(...curveChunk(pts.slice(pos), simplify, smooth, scale));
  d.push("Z");
  return d.join(" ");
}

function fitContour(ring, simplify, sigma, smooth, scale, straighten, minRun) {
  let pts = ring.map((p) => [p[0], p[1]]);
  if (smooth) pts = gaussianSmoothClosed(pts, sigma);
  if (straighten > 0 && pts.length >= 16) {
    pts = rotateToCorner(pts);
    const closed = pts.concat([pts[0]]);
    const runs = lineRuns(closed, straighten, minRun);
    return mixedD(closed, runs, simplify, smooth, scale);
  }
  if (simplify > 0) pts = dp(pts, simplify, true);
  if (pts.length < 3) return null;
  pts = pts.map((p) => [p[0] / scale, p[1] / scale]);
  return smooth ? catmullRomD(pts) : polylineD(pts);
}

// ---------- SVG assembly -------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function svgString(w, h, paths, fill, mode) {
  let body, group, rect = "";
  if (mode === "pieces") {
    body = paths.map((d, i) => `  <path id="piece-${i + 1}" d="${esc(d)}"/>`).join("\n");
    group = '  <g fill="white" fill-rule="evenodd" stroke="black" stroke-width="1">\n';
  } else {
    body = paths.map((d) => `  <path d="${esc(d)}"/>`).join("\n");
    group = `  <g fill="${fill}" fill-rule="evenodd" stroke="none">\n`;
    rect = `  <rect width="${w}" height="${h}" fill="white"/>\n`;
  }
  return `<svg xmlns="${SVGNS_T}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${rect}${group}${body}\n  </g>\n</svg>\n`;
}

// ---------- the two tracers ----------------------------------------------
function fitGroup(rings, o) {
  // rings: [outerRing, ...holeRings]; each already meets the area gate
  const subs = rings
    .map((r) => fitContour(r, o.simplify * o.scale, o.sigma * o.scale, o.smooth, o.scale, o.straighten * o.scale, o.minRun * o.scale))
    .filter(Boolean);
  return subs.length ? subs.join(" ") : null;
}

function tracePieces(prep, o) {
  const { mask, w, h } = prep;
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = 255 - mask[i];   // glass = 255
  const dist = distanceTransform(mask, w, h);               // dist from glass to nearest ink
  const { labels, comps } = labelComponents(inv, w, h, dist);
  const minAreaPx = o.minArea * o.scale * o.scale;
  const paths = [];
  for (const c of comps) {
    if (c.count < minAreaPx) continue;
    if (c.minx <= 0 || c.miny <= 0 || c.maxx >= w - 1 || c.maxy >= h - 1) continue; // background
    if (2 * c.maxDist < o.minWidth * o.scale) continue;      // uncuttable sliver
    const outer = traceBoundary(labels, w, h, c.label, 0, 0);
    if (outer.length < 6 || shoelace(outer) < minAreaPx) continue;
    const rings = [outer];
    for (const hole of componentHoles(labels, w, h, c)) if (shoelace(hole) >= minAreaPx) rings.push(hole);
    const d = fitGroup(rings, o);
    if (d) paths.push(d);
  }
  return paths;
}

function traceLines(prep, o) {
  const { mask, w, h } = prep;
  const { labels, comps } = labelComponents(mask, w, h, null);
  const minAreaPx = o.minArea * o.scale * o.scale;
  const paths = [];
  for (const c of comps) {
    if (c.count < minAreaPx) continue;
    const outer = traceBoundary(labels, w, h, c.label, 0, 0);
    if (outer.length < 6 || shoelace(outer) < minAreaPx) continue;
    const rings = [outer];
    for (const hole of componentHoles(labels, w, h, c)) if (shoelace(hole) >= minAreaPx) rings.push(hole);
    const d = fitGroup(rings, o);
    if (d) paths.push(d);
  }
  return paths;
}

// ---------- public entry -------------------------------------------------
// grayscale buffer -> {svg,count,width,height}; the browser-free core of the
// pipeline, so it can be exercised in node against the Python for parity.
function traceGray(gray, w, h, mode, opts) {
  const scale = 2;
  const o = {
    scale,
    simplify: Math.max(0, opts.simplify ?? 0.15),
    sigma: Math.max(0, opts.sigma ?? 1.5),
    straighten: Math.max(0, opts.straighten ?? 2.2),
    minRun: Math.max(0, opts.min_run ?? 15),
    minArea: Math.max(0, opts.min_area ?? 100),
    minWidth: Math.max(0, opts.min_width ?? 3),
    grow: Math.max(0, opts.grow ?? 0.5),
    smooth: opts.smooth !== false,
  };
  const threshold = opts.auto_threshold ? null : Math.max(0, Math.min(255, opts.threshold ?? 95));
  const close = Math.max(0, Math.min(10, opts.close ?? 1));
  const mask = binarize(gray, w, h, threshold, !!opts.invert, close);
  const prep = prepareMask(mask, w, h, o.grow, scale);
  const paths = (mode === "pieces" ? tracePieces : traceLines)(prep, o);
  const fill = opts.fill || "black";
  return { svg: svgString(w, h, paths, fill, mode), count: paths.length, width: w, height: h };
}

async function traceImage(file, mode, opts) {
  const { gray, w, h } = await decodeToGray(file);
  return traceGray(gray, w, h, mode, opts);
}

if (typeof window !== "undefined") window.traceImage = traceImage;
if (typeof module !== "undefined") module.exports = { traceImage, traceGray, otsu, distanceTransform, dp, lineRuns };
