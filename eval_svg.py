#!/usr/bin/env python3
"""
eval_svg — quantitative quality check for glass2svg output.

Renders the SVG at source resolution and compares it against the source
ink mask. Reports:

  IoU / precision / recall   how much ink lands where the original had ink
  width fidelity             per-ridge-pixel |render width - source width|
  width wobble               local (r=6) std of line width along the lines,
                             for source vs render — the "inconsistent lines"
                             number. Render wobble should be <= source.

Usage:
    python3 eval_svg.py source.png output.svg [--threshold 95]
"""
import argparse
import subprocess
import sys
import tempfile

import cv2
import numpy as np


def ink_mask(path, threshold):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        sys.exit(f"error: could not read '{path}'")
    _, mask = cv2.threshold(img, threshold, 255, cv2.THRESH_BINARY_INV)
    return mask


def render_svg(svg_path, w, h):
    with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
        subprocess.run(
            ["rsvg-convert", "-w", str(w), "-h", str(h), svg_path,
             "-o", tmp.name],
            check=True)
        img = cv2.imread(tmp.name, cv2.IMREAD_GRAYSCALE)
    _, mask = cv2.threshold(img, 128, 255, cv2.THRESH_BINARY_INV)
    return mask


def ridge_pixels(mask):
    """Approximate skeleton: distance-transform plateau ridge points."""
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    dmax = cv2.dilate(dist, np.ones((3, 3), np.uint8))
    ridge = (dist >= dmax - 1e-6) & (dist > 0.8)
    return ridge, dist


def local_wobble(ridge, width, radius=6):
    """Median over ridge pixels of the local std of line width.

    High value = line width oscillates over short distances = wobbly lines.
    """
    k = 2 * radius + 1
    r = ridge.astype(np.float32)
    w = np.where(ridge, width, 0).astype(np.float32)
    cnt = cv2.boxFilter(r, -1, (k, k), normalize=False)
    s1 = cv2.boxFilter(w, -1, (k, k), normalize=False)
    s2 = cv2.boxFilter(w * w, -1, (k, k), normalize=False)
    ok = ridge & (cnt >= 5)
    mean = s1[ok] / cnt[ok]
    var = np.maximum(s2[ok] / cnt[ok] - mean ** 2, 0)
    std = np.sqrt(var)
    return float(std.mean()), float(np.percentile(std, 90))


def evaluate(src, ren):
    """Return dict of quality metrics comparing render mask to source mask."""
    s, r = src > 0, ren > 0
    inter, union = np.sum(s & r), np.sum(s | r)

    ridge_s, dist_s = ridge_pixels(src)
    _, dist_r = ridge_pixels(ren)
    ws = 2 * dist_s[ridge_s]           # source line width at its centerline
    wr = 2 * dist_r[ridge_s]           # render width sampled at same spots
    err = np.abs(wr - ws)

    wob_s, wob_s90 = local_wobble(ridge_s, 2 * dist_s)
    ridge_r, dist_r2 = ridge_pixels(ren)
    wob_r, wob_r90 = local_wobble(ridge_r, 2 * dist_r2)

    return {
        "iou": inter / union,
        "precision": inter / max(np.sum(r), 1),
        "recall": inter / max(np.sum(s), 1),
        "src_width": float(np.median(ws)),
        "werr_mean": float(err.mean()),
        "werr_p95": float(np.percentile(err, 95)),
        "wobble_src": wob_s, "wobble_src90": wob_s90,
        "wobble_ren": wob_r, "wobble_ren90": wob_r90,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("svg")
    ap.add_argument("--threshold", type=int, default=95)
    ap.add_argument("--diff", help="write diff overlay PNG "
                                   "(red=missing ink, blue=extra ink)")
    args = ap.parse_args()

    src = ink_mask(args.source, args.threshold)
    h, w = src.shape
    ren = render_svg(args.svg, w, h)
    m = evaluate(src, ren)

    print(f"IoU        {m['iou']:.3f}   precision {m['precision']:.3f}   "
          f"recall {m['recall']:.3f}")
    print(f"src width  median {m['src_width']:.2f}px")
    print(f"width err  mean {m['werr_mean']:.2f}px   "
          f"p95 {m['werr_p95']:.2f}px")
    print(f"wobble     source {m['wobble_src']:.3f}/{m['wobble_src90']:.3f} "
          f"render {m['wobble_ren']:.3f}/{m['wobble_ren90']:.3f} (mean/p90, "
          f"render <= source is good)")

    if args.diff:
        s, r = src > 0, ren > 0
        vis = np.full((h, w, 3), 255, np.uint8)
        vis[s & r] = (0, 0, 0)
        vis[s & ~r] = (0, 0, 255)      # missing ink: red
        vis[~s & r] = (255, 0, 0)      # extra ink: blue
        cv2.imwrite(args.diff, vis)


if __name__ == "__main__":
    main()
