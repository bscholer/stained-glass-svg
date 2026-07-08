# stained-glass-svg

Convert a JPG/PNG stained-glass drawing into a clean, cut-ready SVG for a
Cricut (or any vinyl/craft cutter). Detects the black lead lines, throws away
color, and emits either:

- **pieces** (default) — every enclosed glass cell as its own closed path,
  so the cutter sees individual shapes
- **lines** — the lead line work as one filled drawing

Purpose-built because general-purpose vectorizers try to be too smart:
they posterize, blur, and merge shapes. This just traces edges — then cleans
them up with a few passes tuned for stained-glass patterns:

- centripetal Catmull-Rom curve fitting (smooth, no overshoot)
- edge straightening: nearly-straight runs snap to true lines, but only when
  corner-bounded, so organic curves stay organic
- bump bridging: little artifact warts on straight edges get shaved off
- sliver/speck filtering: pieces too thin or small to cut are dropped

**It runs entirely in your browser** — the tracer is plain JS, no server, no
upload. Your images never leave the machine.

## Use it

Live at **https://bscholer.github.io/stained-glass-svg/**. Drop in a drawing,
tweak the knobs, edit the pieces, download the SVG.

Or run it locally — it's a static site, so any file server works:

```bash
cd site && python3 -m http.server 8080   # then open http://localhost:8080
```

## Editing

After tracing, the built-in editor lets you:

- **nodes** — drag corners; snapping locks onto nearby vertices, straight
  lines, and neighbour axes (hold shift to bypass)
- **delete** — remove a piece
- **cut** — slice a piece in two along a line
- **⚠ corners** — flag inside corners too tight for your grinder bit, sized
  from the finished dimension + bit diameter you set

## How it works

`site/trace.js` is the whole pipeline: binarize (fixed cutoff or Otsu) →
morphological close → 2× upscale + ink grow → connected-component labelling →
Moore boundary tracing (outer + holes) → Gaussian contour smoothing →
corner-bounded straight-run flattening → centripetal Catmull-Rom béziers.
The sliver filter uses a Felzenszwalb Euclidean distance transform.

## Development

```bash
node test/trace.test.cjs   # pipeline smoke tests (no deps)
```

CI syntax-checks and runs the tests on every push/PR; pushes to `main` deploy
the `site/` folder to GitHub Pages.
