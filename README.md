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
- bump bridging: little AI-artifact warts on straight edges get shaved off
- sliver/speck filtering: pieces too thin or small to cut are dropped

## Web UI

```bash
uvicorn app:app --port 8080
# or
docker run -p 8080:8080 ghcr.io/bscholer/stained-glass-svg:latest
```

Open http://localhost:8080, drop in a drawing, tweak, download the SVG.

## CLI

```bash
python3 glass2svg.py drawing.png -o template.svg            # pieces mode
python3 glass2svg.py drawing.png -o lines.svg --mode lines  # line art
python3 glass2svg.py --help                                 # all knobs
```

Useful knobs: `--threshold` (ink cutoff, default 95), `--straighten`
(edge-flattening tolerance in px, 0 disables), `--sigma` (smoothing),
`--min-area` / `--min-width` (piece filters).

## Quality evaluation

`eval_svg.py` scores an output SVG against its source image — IoU,
line-width fidelity, and width wobble — by rendering it back to raster
(requires `rsvg-convert`):

```bash
python3 eval_svg.py drawing.png template.svg --diff diff.png
```

## Development

```bash
pip install -r requirements.txt pytest httpx
pytest
```

CI runs tests on every push/PR. Pushes to `main` publish
`ghcr.io/bscholer/stained-glass-svg:latest`; tagging `vX.Y.Z` publishes a
versioned image and cuts a GitHub release.
