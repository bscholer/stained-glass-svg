#!/usr/bin/env python3
"""Parameter grid search: run glass2svg over a grid, score with eval_svg."""
import itertools
import sys

import cv2

import glass2svg
import eval_svg

SRC = sys.argv[1]
TMP_SVG = "/private/tmp/claude-502/-Users-bscholer-projects-personal-stained-glass-svg/7a0efc43-b548-484c-8507-dfbe4b3fb82c/scratchpad/sweep.svg"

size, mask = glass2svg.load_binary(SRC, 95, False, 1)
src_mask = eval_svg.ink_mask(SRC, 95)
h, w = src_mask.shape

grid = itertools.product(
    [0.0, 0.25, 0.5, 0.75, 1.0],   # grow
    [1.0, 1.5, 2.0],               # sigma
    [0.4, 0.8],                    # simplify
)

print(f"{'grow':>4} {'sig':>4} {'simp':>4} | {'IoU':>5} {'prec':>5} "
      f"{'rec':>5} {'werr':>5} {'p95':>5} {'wob':>5} {'wob90':>5}")
rows = []
for grow, sigma, simplify in grid:
    paths = glass2svg.contours_to_paths(
        mask.copy(), simplify, 30, smooth=True, sigma=sigma, grow=grow)
    glass2svg.write_svg(TMP_SVG, size, paths, "black")
    ren = eval_svg.render_svg(TMP_SVG, w, h)
    m = eval_svg.evaluate(src_mask, ren)
    rows.append((grow, sigma, simplify, m))
    print(f"{grow:>4} {sigma:>4} {simplify:>4} | {m['iou']:5.3f} "
          f"{m['precision']:5.3f} {m['recall']:5.3f} {m['werr_mean']:5.2f} "
          f"{m['werr_p95']:5.2f} {m['wobble_ren']:5.3f} "
          f"{m['wobble_ren90']:5.3f}")

best = max(rows, key=lambda r: r[3]["iou"] - r[3]["werr_mean"] * 0.05
           - r[3]["wobble_ren"] * 0.3)
g, s, p, m = best
print(f"\nbest: grow={g} sigma={s} simplify={p}  "
      f"(IoU {m['iou']:.3f}, werr {m['werr_mean']:.2f}, "
      f"wobble {m['wobble_ren']:.3f})")
