"use strict";
// glass2svg web editor: trace on the server, then edit pieces client-side.
// A piece is a closed path parsed into nodes {p:[x,y], cin, cout}. Segment
// i->i+1 is a cubic iff node[i].cout && node[i+1].cin, else a straight line.

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  mode: "pieces",
  pieces: [],        // [{id, rings:[[node,...],...]}]
  W: 0, H: 0,
  vb: null,          // {x,y,w,h} current viewBox
  tool: "nodes",
  sel: null,         // selected piece id (nodes/cut)
  pick: [],          // combine: [id,...]; cut: [[x,y],...]
  showWarn: true,
  undoStack: [],
  nextId: 1,
};

// ---------- number + path formatting -------------------------------------
const n = (v) => {
  const s = v.toFixed(1);
  return s.replace(/\.0$/, "");
};

function parsePath(d) {
  // -> array of rings; each ring is [node,...]
  const rings = [];
  let ring = null, start = null, prev = null;
  const cmds = d.match(/[MLCZ][^MLCZ]*/g) || [];
  for (const c of cmds) {
    const t = c[0];
    const nums = (c.slice(1).match(/-?\d*\.?\d+/g) || []).map(Number);
    if (t === "M") {
      ring = []; start = { p: [nums[0], nums[1]], cin: null, cout: null };
      ring.push(start); prev = start; rings.push(ring);
    } else if (t === "L") {
      const nd = { p: [nums[0], nums[1]], cin: null, cout: null };
      ring.push(nd); prev = nd;
    } else if (t === "C") {
      prev.cout = [nums[0], nums[1]];
      const nd = { p: [nums[4], nums[5]], cin: [nums[2], nums[3]], cout: null };
      ring.push(nd); prev = nd;
    } else if (t === "Z") {
      // if the last node duplicates the start, fold it back (closing curve)
      if (ring.length > 1) {
        const last = ring[ring.length - 1];
        if (Math.abs(last.p[0] - start.p[0]) < 0.05 &&
            Math.abs(last.p[1] - start.p[1]) < 0.05) {
          start.cin = last.cin;
          ring.pop();
          prev = ring[ring.length - 1];
        }
      }
    }
  }
  return rings.filter((r) => r.length >= 3);
}

function ringD(ring) {
  const out = [`M${n(ring[0].p[0])} ${n(ring[0].p[1])}`];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    if (a.cout && b.cin)
      out.push(`C${n(a.cout[0])} ${n(a.cout[1])} ${n(b.cin[0])} ${n(b.cin[1])} ${n(b.p[0])} ${n(b.p[1])}`);
    else
      out.push(`L${n(b.p[0])} ${n(b.p[1])}`);
  }
  // closing segment back to start
  const a = ring[ring.length - 1], b = ring[0];
  if (a.cout && b.cin)
    out.push(`C${n(a.cout[0])} ${n(a.cout[1])} ${n(b.cin[0])} ${n(b.cin[1])} ${n(b.p[0])} ${n(b.p[1])}`);
  out.push("Z");
  return out.join(" ");
}

const pieceD = (pc) => pc.rings.map(ringD).join(" ");

// ---------- SVG document build -------------------------------------------
let svg, gPieces, gOverlay;

function buildSvg() {
  $("canvas").querySelectorAll("svg").forEach((e) => e.remove());
  svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("xmlns", SVGNS);
  gPieces = document.createElementNS(SVGNS, "g");
  gOverlay = document.createElementNS(SVGNS, "g");
  svg.append(gPieces, gOverlay);
  $("canvas").appendChild(svg);
  renderPieces();
  fitView();
  wireCanvas();
}

function renderPieces() {
  gPieces.textContent = "";
  for (const pc of state.pieces) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", pieceD(pc));
    p.setAttribute("class", "piece");
    p.dataset.id = pc.id;
    gPieces.appendChild(p);
  }
  applyClasses();
}

function pieceEl(id) { return gPieces.querySelector(`path[data-id="${id}"]`); }

function applyClasses() {
  for (const p of gPieces.children) {
    const id = +p.dataset.id;
    p.classList.toggle("sel", state.tool !== "combine" && state.sel === id);
    p.classList.toggle("pick", state.tool === "combine" && state.pick.includes(id));
  }
}

// ---------- viewBox zoom / pan -------------------------------------------
function setVB() {
  const { x, y, w, h } = state.vb;
  svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  renderOverlay();
}

function fitView() {
  const r = $("canvas").getBoundingClientRect();
  const pad = 0.04;
  const ar = r.width / r.height, iar = state.W / state.H;
  let w, h;
  if (iar > ar) { w = state.W * (1 + pad * 2); h = w / ar; }
  else { h = state.H * (1 + pad * 2); w = h * ar; }
  state.vb = { x: (state.W - w) / 2, y: (state.H - h) / 2, w, h };
  setVB();
}

function px2user() { // px-per-user scale factor for constant-size handles
  const r = $("canvas").getBoundingClientRect();
  return state.vb.w / r.width;
}

function evtUser(e) {
  const r = $("canvas").getBoundingClientRect();
  return [
    state.vb.x + ((e.clientX - r.left) / r.width) * state.vb.w,
    state.vb.y + ((e.clientY - r.top) / r.height) * state.vb.h,
  ];
}

function wireCanvas() {
  const cv = $("canvas");
  cv.onwheel = (e) => {
    e.preventDefault();
    const [ux, uy] = evtUser(e);
    const f = e.deltaY < 0 ? 0.85 : 1.18;
    const nw = Math.max(state.W / 200, Math.min(state.W * 4, state.vb.w * f));
    const k = nw / state.vb.w;
    state.vb = {
      w: nw, h: state.vb.h * k,
      x: ux - (ux - state.vb.x) * k,
      y: uy - (uy - state.vb.y) * k,
    };
    setVB();
  };

  let panning = false, moved = false, last = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".handle")) return;          // node drag handles it
    const pathEl = e.target.closest("path.piece");
    if (pathEl) { onPieceDown(+pathEl.dataset.id, e); return; }
    // empty space -> pan (or place cut point handled in onPieceDown for cut)
    panning = true; moved = false; last = [e.clientX, e.clientY];
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!panning) return;
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    const s = px2user();
    state.vb.x -= dx * s; state.vb.y -= dy * s;
    last = [e.clientX, e.clientY]; setVB();
  });
  svg.addEventListener("pointerup", (e) => {
    if (panning && !moved) onEmptyClick();
    panning = false;
  });
  svg.addEventListener("mouseover", (e) => {
    const p = e.target.closest("path.piece");
    if (p && (state.tool === "delete" || state.tool === "combine")) p.classList.add("hot");
  });
  svg.addEventListener("mouseout", (e) => {
    const p = e.target.closest("path.piece");
    if (p) p.classList.remove("hot");
  });
}

// ---------- overlay: handles, warnings, cut points -----------------------
function renderOverlay() {
  if (!gOverlay) return;
  gOverlay.textContent = "";
  const r = px2user();
  if (state.showWarn) drawWarnings(r);
  if (state.tool === "nodes" && state.sel != null) drawHandles(r);
  if (state.tool === "cut") drawCutPoints(r);
}

function circle(x, y, rad, cls, extra) {
  const c = document.createElementNS(SVGNS, "circle");
  c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", rad);
  c.setAttribute("class", cls);
  if (extra) for (const k in extra) c.dataset[k] = extra[k];
  gOverlay.appendChild(c);
  return c;
}

function drawHandles(r) {
  const pc = piece(state.sel);
  if (!pc) return;
  pc.rings.forEach((ring, ri) => ring.forEach((nd, ni) => {
    const c = circle(nd.p[0], nd.p[1], 5 * r, "handle", { ri, ni });
    c.addEventListener("pointerdown", (e) => startNodeDrag(e, ri, ni));
  }));
}

function drawWarnings(r) {
  for (const pc of state.pieces) {
    for (const ring of pc.rings) {
      const bad = tightCorners(ring);
      for (const i of bad) {
        const c = circle(ring[i].p[0], ring[i].p[1], 6 * r, "warn");
        const t = document.createElementNS(SVGNS, "title");
        t.textContent = "tight inside corner — hard to cut";
        c.appendChild(t);
      }
    }
  }
}

function drawCutPoints(r) {
  for (const p of state.pick) circle(p[0], p[1], 5 * r, "cutpt");
}

// ---------- node dragging ------------------------------------------------
function startNodeDrag(e, ri, ni) {
  e.stopPropagation();
  pushUndo();
  const pc = piece(state.sel);
  const nd = pc.rings[ri][ni];
  const el = pieceEl(pc.id);
  const handle = e.target;
  svg.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const [ux, uy] = evtUser(ev);
    const dx = ux - nd.p[0], dy = uy - nd.p[1];
    for (const q of [nd.p, nd.cin, nd.cout]) if (q) { q[0] += dx; q[1] += dy; }
    el.setAttribute("d", pieceD(pc));
    handle.setAttribute("cx", nd.p[0]); handle.setAttribute("cy", nd.p[1]);
  };
  const up = (ev) => {
    svg.releasePointerCapture(ev.pointerId);
    svg.removeEventListener("pointermove", move);
    svg.removeEventListener("pointerup", up);
    markDirty(); renderOverlay();
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", up);
}

// ---------- clicks by tool ----------------------------------------------
function onPieceDown(id, e) {
  if (state.tool === "delete") {
    pushUndo(); removePiece(id); markDirty(); renderPieces(); renderOverlay(); updateStat();
  } else if (state.tool === "nodes") {
    state.sel = id; applyClasses(); renderOverlay();
  } else if (state.tool === "cut") {
    if (state.sel !== id) { state.sel = id; state.pick = []; applyClasses(); }
    state.pick.push(evtUser(e));
    renderOverlay();
    if (state.pick.length === 2) doCut();
  } else if (state.tool === "combine") {
    if (state.pick.includes(id)) state.pick = state.pick.filter((x) => x !== id);
    else state.pick.push(id);
    applyClasses(); renderOverlay();
    if (state.pick.length === 2) doCombine();
  }
}

function onEmptyClick() {
  if (state.tool === "nodes") { state.sel = null; applyClasses(); renderOverlay(); }
  else if (state.tool === "cut") { state.sel = null; state.pick = []; applyClasses(); renderOverlay(); }
  else if (state.tool === "combine") { state.pick = []; applyClasses(); renderOverlay(); }
}

// ---------- geometry helpers --------------------------------------------
function piece(id) { return state.pieces.find((p) => p.id === id); }
function removePiece(id) { state.pieces = state.pieces.filter((p) => p.id !== id); if (state.sel === id) state.sel = null; }

function tightCorners(ring, degThresh = 32) {
  const bad = [];
  const N = ring.length;
  if (N < 3) return bad;
  for (let i = 0; i < N; i++) {
    const a = ring[(i - 1 + N) % N].p, b = ring[i].p, c = ring[(i + 1) % N].p;
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    if (l1 < 1e-3 || l2 < 1e-3) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))) * 180 / Math.PI;
    // only flag if both adjacent edges have real length (not a smoothing wiggle)
    if (ang < degThresh && Math.min(l1, l2) > 4) bad.push(i);
  }
  return bad;
}

// flatten a ring's cubic segments into a dense polygon for rasterizing
function flattenRing(ring, step = 8) {
  const pts = [];
  const N = ring.length;
  for (let i = 0; i < N; i++) {
    const a = ring[i], b = ring[(i + 1) % N];
    pts.push(a.p);
    if (a.cout && b.cin) {
      for (let t = 1; t < step; t++) {
        const u = t / step, iu = 1 - u;
        const x = iu * iu * iu * a.p[0] + 3 * iu * iu * u * a.cout[0] + 3 * iu * u * u * b.cin[0] + u * u * u * b.p[0];
        const y = iu * iu * iu * a.p[1] + 3 * iu * iu * u * a.cout[1] + 3 * iu * u * u * b.cin[1] + u * u * u * b.p[1];
        pts.push([x, y]);
      }
    }
  }
  return pts;
}

// ---------- raster round-trip for cut & combine --------------------------
// Cut/combine are hard to do as robust polygon booleans in the browser, so
// we rasterize the affected pieces, edit the bitmap (slice or weld), then
// re-trace the outline(s). Straight edges stay crisp (DP simplify, no
// re-smoothing); good for the blocky pieces these tools target.
function rasterizePieces(pcs, bridge) {
  const W = state.W, H = state.H;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round";
  ctx.lineWidth = bridge || 0;
  for (const pc of pcs) {
    for (const ring of pc.rings) {
      const pts = flattenRing(ring);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fill();
      if (bridge) ctx.stroke();
    }
  }
  return { ctx, W, H };
}

function maskFrom(ctx, W, H) {
  const d = ctx.getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  return m;
}

function eraseSegment(ctx, a, b, width) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "#000"; ctx.lineWidth = width; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  ctx.restore();
}

function labelComponents(mask, W, H) {
  const labels = new Int32Array(W * H).fill(0);
  let next = 0;
  const comps = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || labels[s]) continue;
    next++; let size = 0; stack.push(s);
    labels[s] = next;
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % W, y = (p / W) | 0;
      const nb = [];
      if (x > 0) nb.push(p - 1);
      if (x < W - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - W);
      if (y < H - 1) nb.push(p + W);
      for (const q of nb) if (mask[q] && !labels[q]) { labels[q] = next; stack.push(q); }
    }
    comps.push({ label: next, size });
  }
  return { labels, comps };
}

const N8 = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
function traceBoundary(labels, W, H, label) {
  let sx = -1, sy = -1;
  for (let y = 0; y < H && sx < 0; y++) for (let x = 0; x < W; x++) if (labels[y * W + x] === label) { sx = x; sy = y; break; }
  if (sx < 0) return [];
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && labels[y * W + x] === label;
  const ring = [[sx, sy]];
  let cx = sx, cy = sy, b = 7;
  const max = W * H * 4;
  for (let it = 0; it < max; it++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const dir = (b + 1 + k) % 8;
      const nx = cx + N8[dir][0], ny = cy + N8[dir][1];
      if (on(nx, ny)) { b = (dir + 4) % 8; cx = nx; cy = ny; ring.push([cx, cy]); found = true; break; }
    }
    if (!found) break;
    if (cx === sx && cy === sy) { ring.pop(); break; }
  }
  return ring;
}

function dpSimplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dx * (ay - pts[k][1]) - dy * (ax - pts[k][0])) / L;
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

function ringFromPolygon(poly) {
  // closed polygon points -> node ring (straight segments)
  let simp = dpSimplify(poly, 1.2);
  if (simp.length > 2) {
    const a = simp[0], b = simp[simp.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5) simp = simp.slice(0, -1);
  }
  return simp.map((p) => ({ p: [p[0], p[1]], cin: null, cout: null }));
}

function tracedPieces(ctx, W, H, minArea) {
  const mask = maskFrom(ctx, W, H);
  const { labels, comps } = labelComponents(mask, W, H);
  const out = [];
  for (const c of comps) {
    if (c.size < minArea) continue;
    const ring = traceBoundary(labels, W, H, c.label);
    if (ring.length < 6) continue;
    const nodes = ringFromPolygon(ring);
    if (nodes.length >= 3) out.push({ rings: [nodes] });
  }
  return out;
}

function doCut() {
  const pc = piece(state.sel);
  const [a, b] = state.pick;
  state.pick = [];
  if (!pc) { renderOverlay(); return; }
  pushUndo();
  const { ctx, W, H } = rasterizePieces([pc], 0);
  eraseSegment(ctx, a, b, Math.max(3, state.W * 0.006));
  const parts = tracedPieces(ctx, W, H, 40);
  if (parts.length < 2) {
    popUndo();
    toolHint("cut didn't split the piece — draw across it, edge to edge");
    state.sel = null; applyClasses(); renderOverlay();
    return;
  }
  const idx = state.pieces.indexOf(pc);
  const made = parts.map((p) => ({ id: state.nextId++, rings: p.rings }));
  state.pieces.splice(idx, 1, ...made);
  state.sel = null;
  markDirty(); renderPieces(); renderOverlay(); updateStat();
  toolHint(`split into ${made.length} pieces`);
}

function doCombine() {
  const ids = state.pick.slice();
  state.pick = [];
  const pcs = ids.map(piece).filter(Boolean);
  if (pcs.length < 2) { renderOverlay(); return; }
  pushUndo();
  // stroke width bridges the lead-line gap between the two pieces
  const bridge = Math.max(4, state.W * 0.012);
  const { ctx, W, H } = rasterizePieces(pcs, bridge);
  const parts = tracedPieces(ctx, W, H, 40);
  if (parts.length !== 1) {
    popUndo();
    toolHint("those pieces aren't adjacent — nothing to weld");
    applyClasses(); renderOverlay();
    return;
  }
  const idx = Math.min(...pcs.map((p) => state.pieces.indexOf(p)));
  state.pieces = state.pieces.filter((p) => !pcs.includes(p));
  state.pieces.splice(idx, 0, { id: state.nextId++, rings: parts[0].rings });
  markDirty(); renderPieces(); renderOverlay(); updateStat();
  toolHint("welded into one piece");
}

// ---------- undo ---------------------------------------------------------
function snapshot() { return JSON.parse(JSON.stringify(state.pieces)); }
function pushUndo() { state.undoStack.push(snapshot()); if (state.undoStack.length > 60) state.undoStack.shift(); $("undo").disabled = false; }
function popUndo() { const s = state.undoStack.pop(); if (s) state.pieces = s; $("undo").disabled = state.undoStack.length === 0; }
function undo() {
  if (!state.undoStack.length) return;
  state.pieces = state.undoStack.pop();
  state.sel = null; state.pick = [];
  $("undo").disabled = state.undoStack.length === 0;
  renderPieces(); renderOverlay(); updateStat(); refreshDownload();
}

let dirty = false;
function markDirty() { dirty = true; refreshDownload(); }

// ---------- stat + download ---------------------------------------------
function updateStat() {
  const noun = state.mode === "pieces" ? "pieces" : "shapes";
  $("stat").innerHTML = `<b>${state.pieces.length}</b> ${noun} · ${state.W}×${state.H}px`;
}

function serialize() {
  const body = state.pieces.map((pc, i) =>
    `  <path id="piece-${i + 1}" d="${pieceD(pc)}"/>`).join("\n");
  const stroke = state.mode === "pieces"
    ? 'fill="white" fill-rule="evenodd" stroke="black" stroke-width="1"'
    : 'fill="black" fill-rule="evenodd" stroke="none"';
  const rect = state.mode === "pieces" ? "" :
    `  <rect width="${state.W}" height="${state.H}" fill="white"/>\n`;
  return `<svg xmlns="${SVGNS}" width="${state.W}" height="${state.H}" viewBox="0 0 ${state.W} ${state.H}">\n${rect}  <g ${stroke}>\n${body}\n  </g>\n</svg>\n`;
}

let baseName = "template";
function refreshDownload() {
  const dl = $("dl");
  if (dl.href) URL.revokeObjectURL(dl.href);
  dl.href = URL.createObjectURL(new Blob([serialize()], { type: "image/svg+xml" }));
  dl.download = baseName + ".svg";
  dl.hidden = false;
}

let hintTimer = null;
function toolHint(msg) {
  const h = $("toolhint");
  if (!msg) { h.hidden = true; return; }
  h.textContent = msg; h.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { h.hidden = true; }, 2600);
}

// ---------- controls wiring ---------------------------------------------
document.querySelectorAll("input[type=range]").forEach((r) =>
  r.addEventListener("input", () => (r.nextElementSibling.value = r.value)));

const drop = $("drop");
$("file").addEventListener("change", (e) => setFile(e.target.files[0]));
["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
function setFile(f) {
  if (!f) return;
  state.file = f;
  $("fname").textContent = `${f.name} · ${(f.size / 1024).toFixed(0)} kB`;
  $("go").disabled = false;
}

$("modePieces").onclick = () => setMode("pieces");
$("modeLines").onclick = () => setMode("lines");
function setMode(m) {
  state.mode = m;
  $("modePieces").classList.toggle("on", m === "pieces");
  $("modeLines").classList.toggle("on", m === "lines");
}

$("toolset").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.tool = b.dataset.tool;
  state.sel = null; state.pick = [];
  for (const x of $("toolset").children) x.classList.toggle("on", x === b);
  applyClasses(); renderOverlay(); toolHint(TOOL_HINTS[state.tool]);
});
const TOOL_HINTS = {
  nodes: "click a piece, then drag its corner dots",
  delete: "click a piece to remove it",
  cut: "click a piece, then click two points to slice it",
  combine: "click two adjacent pieces to weld them",
};

$("warnToggle").onclick = () => { state.showWarn = !state.showWarn; $("warnToggle").classList.toggle("on", state.showWarn); renderOverlay(); };
$("undo").onclick = undo;
$("fit").onclick = fitView;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "z" && state.pieces.length) { e.preventDefault(); undo(); }
});
window.addEventListener("resize", () => { if (state.vb) setVB(); });

// ---------- trace --------------------------------------------------------
$("go").onclick = async () => {
  if (!state.file) return;
  if (dirty && !confirm("Re-tracing rebuilds every piece and discards your edits. Continue?")) return;
  const go = $("go");
  go.disabled = true; go.textContent = "Tracing…";
  $("err").hidden = true;
  try {
    const fd = new FormData();
    fd.append("image", state.file);
    fd.append("mode", state.mode);
    for (const id of ["threshold", "straighten", "sigma", "simplify", "min_area", "min_width", "grow"])
      fd.append(id, $(id).value);
    fd.append("auto_threshold", $("auto_threshold").checked);
    fd.append("invert", $("invert").checked);
    const res = await fetch("/convert", { method: "POST", body: fd });
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail || `server error (${res.status})`); }
    const out = await res.json();
    loadTrace(out);
  } catch (e) {
    $("err").textContent = e.message; $("err").hidden = false;
  } finally {
    go.disabled = false; go.textContent = "Trace it";
  }
};

function loadTrace(out) {
  const doc = new DOMParser().parseFromString(out.svg, "image/svg+xml");
  state.W = out.width; state.H = out.height;
  state.pieces = [];
  state.nextId = 1;
  for (const p of doc.querySelectorAll("path"))
    state.pieces.push({ id: state.nextId++, rings: parsePath(p.getAttribute("d")) });
  state.undoStack = []; dirty = false; state.sel = null; state.pick = [];
  baseName = (state.file.name.replace(/\.[^.]+$/, "") || "template");
  $("stagehint").hidden = true;
  $("toolset").hidden = state.mode !== "pieces";
  state.tool = state.mode === "pieces" ? "nodes" : "nodes";
  for (const x of $("toolset").children) x.classList.toggle("on", x.dataset.tool === "nodes");
  $("warnToggle").hidden = false; $("undo").hidden = false; $("fit").hidden = false;
  $("undo").disabled = true;
  buildSvg();
  updateStat(); refreshDownload();
}
