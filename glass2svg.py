#!/usr/bin/env python3
"""
glass2svg — convert a JPG/PNG stained-glass drawing into a clean, cut-ready SVG.

Detects the black lead lines, throws away all color (background becomes white),
simplifies the node count so a Cricut can cut it, and writes filled black paths.

Usage:
    python3 glass2svg.py input.png [-o out.svg] [options]

Common knobs:
    --threshold N     0-255 cutoff for "is this pixel a line?" (default 95)
    --auto            auto-pick threshold (Otsu) instead of the fixed default
    --simplify F      node-reduction tolerance in px (default 0.15)
    --sigma F         contour smoothing strength in px (default 1.5)
    --min-area N      drop specks smaller than N px^2 (default 100)
    --close N         bridge gaps in lines up to N px (default 1)
    --invert          use if your lines are light on a dark background
    --preview out.png also dump a raster preview of what got cut
"""
import argparse
import sys
import xml.sax.saxutils as sax

import cv2
import numpy as np


def load_binary(path, threshold, invert, close):
    """Return a uint8 mask where 255 = line (to be cut), 0 = glass/background."""
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        sys.exit(f"error: could not read image '{path}'")
    return img.shape, binarize(img, threshold, invert, close)


def binarize(img, threshold, invert, close):
    """Grayscale image -> ink mask (255 = line, 0 = glass/background)."""
    if threshold is None:
        # Otsu picks the cutoff automatically from the histogram. Handy for
        # clean scans, but it tends to grab colored-pencil shading as "line".
        _, mask = cv2.threshold(img, 0, 255,
                                cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    else:
        # Fixed cutoff: only near-black ink counts, so color fills stay white.
        _, mask = cv2.threshold(img, threshold, 255, cv2.THRESH_BINARY_INV)

    if invert:
        mask = cv2.bitwise_not(mask)

    if close > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close * 2 + 1,) * 2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)

    return mask


def _n(v):
    """Trim trailing zeros so the path data stays compact."""
    return f"{v:.1f}".rstrip("0").rstrip(".")


def _polyline_d(pts):
    """Straight-segment fallback for tiny contours."""
    return "M" + " L".join(f"{_n(x)} {_n(y)}" for x, y in pts) + " Z"


def _gaussian_smooth_closed(pts, sigma):
    """Circularly Gaussian-smooth a closed contour's coordinates.

    Removes the 1-px staircase from pixel tracing without moving the curve
    off the true line, so downstream curve fitting has clean data.
    """
    if sigma <= 0 or len(pts) < 8:
        return pts
    radius = max(1, int(3 * sigma))
    x = np.arange(-radius, radius + 1)
    kernel = np.exp(-(x ** 2) / (2.0 * sigma ** 2))
    kernel /= kernel.sum()
    padded = np.concatenate([pts[-radius:], pts, pts[:radius]])
    out = np.empty_like(pts)
    for axis in range(2):
        out[:, axis] = np.convolve(padded[:, axis], kernel, mode="valid")
    return out


def _catmull_rom_d(pts):
    """Closed contour -> cubic Béziers via centripetal Catmull-Rom.

    Centripetal parameterization keeps the curve snug through unevenly
    spaced nodes — no overshoot bulges where a long segment meets a short
    one, unlike the uniform variant.
    """
    n = len(pts)
    if n < 4:
        return _polyline_d(pts)
    d = [f"M{_n(pts[0][0])} {_n(pts[0][1])}"]
    for i in range(n):
        p0 = pts[(i - 1) % n]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        p3 = pts[(i + 2) % n]
        # knot intervals, alpha = 0.5 (centripetal)
        dt0 = max(np.hypot(*(p1 - p0)) ** 0.5, 1e-4)
        dt1 = max(np.hypot(*(p2 - p1)) ** 0.5, 1e-4)
        dt2 = max(np.hypot(*(p3 - p2)) ** 0.5, 1e-4)
        m1 = (p1 - p0) / dt0 - (p2 - p0) / (dt0 + dt1) + (p2 - p1) / dt1
        m2 = (p2 - p1) / dt1 - (p3 - p1) / (dt1 + dt2) + (p3 - p2) / dt2
        c1 = p1 + m1 * dt1 / 3.0
        c2 = p2 - m2 * dt1 / 3.0
        d.append(f"C{_n(c1[0])} {_n(c1[1])} {_n(c2[0])} {_n(c2[1])} "
                 f"{_n(p2[0])} {_n(p2[1])}")
    d.append("Z")
    return " ".join(d)


def _max_dev(pts, i, j):
    """Max perpendicular deviation of pts[i..j] from the chord pts[i]->pts[j]."""
    a, b = pts[i], pts[j]
    ab = b - a
    length = np.hypot(*ab)
    if length < 1e-9:
        return 0.0
    return float(np.abs(np.cross(ab, pts[i:j + 1] - a)).max() / length)


def _angle_between(v, w):
    na, nb = np.hypot(*v), np.hypot(*w)
    if na < 1e-9 or nb < 1e-9:
        return 180.0
    c = np.clip(np.dot(v, w) / (na * nb), -1.0, 1.0)
    return float(np.degrees(np.arccos(c)))


def _corner_bounded(pts, i, j, k=10, thresh=18.0):
    """True if the run i..j ends in corners rather than continuing smoothly.

    A genuine straight edge (border brick, frame bar) turns sharply at both
    ends; a chord that merely fits a stretch of a gentle curve continues in
    nearly the same direction — flattening it would facet the curve.
    """
    n = len(pts)
    chord = pts[j] - pts[i]
    start_ok = i <= k or _angle_between(
        pts[i] - pts[i - k], chord) > thresh
    end_ok = j >= n - 1 - k or _angle_between(
        pts[min(j + k, n - 1)] - pts[j], chord) > thresh
    return start_ok and end_ok


def _line_runs(pts, tol, min_len):
    """Greedy scan for maximal corner-bounded straight runs within tol."""
    n = len(pts)
    runs = []
    i = 0
    while i < n - 2:
        if _max_dev(pts, i, min(i + 2, n - 1)) > tol:
            i += 1
            continue
        good, step = min(i + 2, n - 1), 4
        while good < n - 1:
            j = min(good + step, n - 1)
            if _max_dev(pts, i, j) <= tol:
                good, step = j, step * 2
            else:
                lo, hi = good, j
                while hi - lo > 1:          # binary search the boundary
                    mid = (lo + hi) // 2
                    if _max_dev(pts, i, mid) <= tol:
                        lo = mid
                    else:
                        hi = mid
                good = lo
                break
        if (np.hypot(*(pts[good] - pts[i])) >= min_len
                and _corner_bounded(pts, i, good)):
            runs.append((i, good))
            i = good
        else:
            # no straight edge starting here; skip ahead a little so a
            # rejected long chord doesn't cost O(n) rescans
            i += max(1, (good - i) // 4)
    return _bridge_runs(pts, runs)


def _bridge_runs(pts, runs, gap=44, max_angle=12.0):
    """Merge collinear runs split by a small bump (drawing artifact).

    The bump between them gets replaced by the continuing straight line,
    shaving warts off otherwise-straight edges. Iterates so a chain of
    bumps collapses into one line.
    """
    while True:
        if len(runs) < 2:
            return runs
        merged = [runs[0]]
        for a, b in runs[1:]:
            pa, pb = merged[-1]
            chord_prev = pts[pb] - pts[pa]
            chord_next = pts[b] - pts[a]
            if (np.hypot(*(pts[a] - pts[pb])) <= gap
                    and _angle_between(chord_prev, chord_next) <= max_angle):
                merged[-1] = (pa, b)
            else:
                merged.append((a, b))
        if len(merged) == len(runs):
            return merged
        runs = merged


def _rotate_to_corner(pts):
    """Start the closed contour at its sharpest corner so no straight run
    is split by the arbitrary wrap-around point."""
    k = 5
    if len(pts) < 3 * k:
        return pts
    fwd = np.roll(pts, -k, axis=0) - pts
    ang = np.arctan2(fwd[:, 1], fwd[:, 0])
    turn = np.abs((np.roll(ang, -k) - ang + np.pi) % (2 * np.pi) - np.pi)
    return np.roll(pts, -int(turn.argmax()), axis=0)


def _catmull_rom_open(pts, scale):
    """Open polyline -> C commands (endpoints pinned, one-sided tangents)."""
    m = len(pts)
    cmds = []
    for i in range(m - 1):
        p0 = pts[max(i - 1, 0)]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[min(i + 2, m - 1)]
        dt0 = max(np.hypot(*(p1 - p0)) ** 0.5, 1e-4)
        dt1 = max(np.hypot(*(p2 - p1)) ** 0.5, 1e-4)
        dt2 = max(np.hypot(*(p3 - p2)) ** 0.5, 1e-4)
        m1 = (p1 - p0) / dt0 - (p2 - p0) / (dt0 + dt1) + (p2 - p1) / dt1
        m2 = (p2 - p1) / dt1 - (p3 - p1) / (dt1 + dt2) + (p3 - p2) / dt2
        c1 = p1 + m1 * dt1 / 3.0
        c2 = p2 - m2 * dt1 / 3.0
        cmds.append(f"C{_fmt_pt(c1, scale)} {_fmt_pt(c2, scale)} "
                    f"{_fmt_pt(p2, scale)}")
    return cmds


def _fmt_pt(p, scale):
    return f"{_n(p[0] / scale)} {_n(p[1] / scale)}"


def _curve_chunk(pts, simplify, smooth, scale):
    """Dense open run -> path commands continuing from pts[0]."""
    if simplify > 0 and len(pts) > 2:
        cnt = cv2.approxPolyDP(
            pts.astype(np.float32).reshape(-1, 1, 2), simplify, False)
        pts = cnt.reshape(-1, 2).astype(float)
    if not smooth or len(pts) < 3:
        return [f"L{_fmt_pt(p, scale)}" for p in pts[1:]]
    return _catmull_rom_open(pts, scale)


def _mixed_d(pts, runs, simplify, smooth, scale):
    """Contour with straight runs -> path: L for runs, curves between."""
    n = len(pts)
    d = [f"M{_fmt_pt(pts[0], scale)}"]
    pos = 0
    for a, b in runs:
        if a > pos:
            d.extend(_curve_chunk(pts[pos:a + 1], simplify, smooth, scale))
        d.append(f"L{_fmt_pt(pts[b], scale)}")
        pos = b
    if pos < n - 1:
        d.extend(_curve_chunk(pts[pos:], simplify, smooth, scale))
    d.append("Z")
    return " ".join(d)


def _fit_contour(cnt, simplify, sigma, smooth, scale,
                 straighten=0.0, min_run=0.0):
    """Pixel-chain contour -> SVG subpath string (or None if degenerate)."""
    pts = cnt.reshape(-1, 2).astype(float)
    if smooth:
        pts = _gaussian_smooth_closed(pts, sigma)
    if straighten > 0 and len(pts) >= 16:
        pts = _rotate_to_corner(pts)
        closed = np.vstack([pts, pts[:1]])   # explicit wrap for run search
        runs = _line_runs(closed, straighten, min_run)
        return _mixed_d(closed, runs, simplify, smooth, scale)
    if simplify > 0:
        # epsilon is in absolute pixels — perimeter-relative epsilons
        # butcher long contours.
        cnt = cv2.approxPolyDP(
            pts.astype(np.float32).reshape(-1, 1, 2), simplify, True)
        pts = cnt.reshape(-1, 2).astype(float)
    if len(pts) < 3:
        return None
    pts /= scale
    return _catmull_rom_d(pts) if smooth else _polyline_d(pts)


def _prepare_mask(mask, grow, scale=2):
    """Upscale 2x (half-pixel coordinates) and grow the ink by `grow` px."""
    mask = cv2.resize(mask, None, fx=scale, fy=scale,
                      interpolation=cv2.INTER_NEAREST)
    if grow > 0:
        r = max(1, round(grow * scale))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1,) * 2)
        mask = cv2.dilate(mask, k)
    return mask


def _grouped_contours(mask, min_area):
    """findContours + group each outer contour with its holes."""
    contours, hierarchy = cv2.findContours(
        mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]
    groups = {}
    for i, cnt in enumerate(contours):
        _, _, _, parent = hierarchy[i]
        outer = i if parent == -1 else parent
        groups.setdefault(outer, []).append((i == outer, cnt))
    out = []
    for outer, cnts in groups.items():
        if cv2.contourArea(contours[outer]) < min_area:
            continue
        out.append(cnts)
    return out


def contours_to_paths(mask, simplify, min_area, smooth, sigma, grow=0.5,
                      straighten=0.0, min_run=0.0):
    """Lines mode: trace the ink itself -> one path per connected line web."""
    scale = 2
    mask = _prepare_mask(mask, grow, scale)
    paths = []
    for cnts in _grouped_contours(mask, min_area * scale * scale):
        subpaths = [_fit_contour(c, simplify * scale, sigma * scale,
                                 smooth, scale, straighten * scale,
                                 min_run * scale)
                    for _, c in cnts
                    if cv2.contourArea(c) >= min_area * scale * scale]
        subpaths = [s for s in subpaths if s]
        if subpaths:
            paths.append(" ".join(subpaths))
    return paths


def pieces_to_paths(mask, simplify, min_area, smooth, sigma, grow=0.5,
                    straighten=0.0, min_run=0.0, min_width=3.0):
    """Pieces mode: each enclosed glass cell becomes its own closed path.

    Inverts the ink mask and traces every white region that does NOT touch
    the image border (that one is the background, not a piece). Pieces
    thinner than `min_width` px everywhere are dropped — you can't cut a
    hair-thin sliver of glass.
    """
    scale = 2
    mask = _prepare_mask(mask, grow, scale)
    inv = cv2.bitwise_not(mask)
    dist = cv2.distanceTransform(inv, cv2.DIST_L2, 5)
    h2, w2 = inv.shape
    paths = []
    for cnts in _grouped_contours(inv, min_area * scale * scale):
        outer = next(c for is_outer, c in cnts if is_outer)
        x, y, bw, bh = cv2.boundingRect(outer)
        if x <= 0 or y <= 0 or x + bw >= w2 or y + bh >= h2:
            continue                     # background region, not a piece
        sub = np.zeros((bh, bw), np.uint8)
        cv2.drawContours(sub, [outer - (x, y)], -1, (255,), -1)
        widest = 2 * dist[y:y + bh, x:x + bw][sub > 0].max()
        if widest < min_width * scale:
            continue                     # uncuttable sliver
        subpaths = [_fit_contour(c, simplify * scale, sigma * scale,
                                 smooth, scale, straighten * scale,
                                 min_run * scale)
                    for _, c in cnts
                    if cv2.contourArea(c) >= min_area * scale * scale]
        subpaths = [s for s in subpaths if s]
        if subpaths:
            paths.append(" ".join(subpaths))
    return paths


def svg_string(size, paths, fill, mode="lines"):
    h, w = size
    if mode == "pieces":
        # One <path> per glass piece so cutters see individual shapes.
        # No background rect — it would import as an extra cut shape.
        body = "\n".join(
            f'  <path id="piece-{i + 1}" d="{sax.escape(d)}"/>'
            for i, d in enumerate(paths))
        group = ('  <g fill="white" fill-rule="evenodd" stroke="black" '
                 'stroke-width="1">\n')
    else:
        body = "\n".join(f'  <path d="{sax.escape(d)}"/>' for d in paths)
        group = f'  <g fill="{fill}" fill-rule="evenodd" stroke="none">\n'
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n'
        + ("" if mode == "pieces"
           else f'  <rect width="{w}" height="{h}" fill="white"/>\n')
        + group
        + f'{body}\n'
        f'  </g>\n'
        f'</svg>\n'
    )
    return svg


def convert(img, mode="pieces", threshold: "int | None" = 95,
            simplify=0.15, sigma=1.5, min_area: float = 100, close=1,
            invert=False, grow=0.5, straighten=2.2, min_run: float = 15,
            min_width=3.0, smooth=True, fill="black"):
    """Grayscale numpy image -> (svg string, shape count). Library entry."""
    mask = binarize(img, threshold, invert, close)
    tracer = pieces_to_paths if mode == "pieces" else contours_to_paths
    kwargs = dict(smooth=smooth, sigma=sigma, grow=grow,
                  straighten=straighten, min_run=min_run)
    if mode == "pieces":
        kwargs["min_width"] = min_width
    paths = tracer(mask, simplify, min_area, **kwargs)
    return svg_string(img.shape, paths, fill, mode=mode), len(paths)


def write_svg(out_path, size, paths, fill, mode="lines"):
    with open(out_path, "w") as f:
        f.write(svg_string(size, paths, fill, mode))


def main():
    ap = argparse.ArgumentParser(description="JPG/PNG -> clean stained-glass SVG")
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--threshold", type=int, default=95,
                    help="0-255 ink cutoff (default 95). Lower = only true "
                         "black lines, kills color-cell speckle.")
    ap.add_argument("--auto", action="store_true",
                    help="pick threshold automatically (Otsu) instead of 95")
    ap.add_argument("--simplify", type=float, default=0.15,
                    help="node-reduction tolerance in PIXELS (default 0.15). "
                         "Higher = fewer nodes but less faithful.")
    ap.add_argument("--sigma", type=float, default=1.5,
                    help="contour smoothing strength in px (default 1.5). "
                         "Kills pixel staircase; 0 disables.")
    ap.add_argument("--mode", choices=["pieces", "lines"], default="pieces",
                    help="pieces: one shape per glass cell (default). "
                         "lines: the lead lines as one filled drawing.")
    ap.add_argument("--grow", type=float, default=0.5,
                    help="widen lines by N px to offset tracing/AA thinning "
                         "(default 0.5)")
    ap.add_argument("--straighten", type=float, default=2.2,
                    help="snap nearly-straight edges to true lines: max "
                         "waviness in px to flatten (default 2.2, 0=off)")
    ap.add_argument("--min-run", type=float, default=15,
                    help="min straight-run length in px worth flattening "
                         "(default 15)")
    ap.add_argument("--no-smooth", action="store_true",
                    help="emit straight segments instead of smooth curves")
    ap.add_argument("--min-area", type=float, default=100,
                help="drop regions under N px^2 — specks and uncuttable slivers (default 100)")
    ap.add_argument("--close", type=int, default=1)
    ap.add_argument("--invert", action="store_true")
    ap.add_argument("--fill", default="black")
    ap.add_argument("--preview")
    args = ap.parse_args()

    out = args.output or args.input.rsplit(".", 1)[0] + ".svg"
    threshold = None if args.auto else args.threshold
    size, mask = load_binary(args.input, threshold, args.invert, args.close)
    tracer = pieces_to_paths if args.mode == "pieces" else contours_to_paths
    paths = tracer(mask, args.simplify, args.min_area,
                   smooth=not args.no_smooth, sigma=args.sigma,
                   grow=args.grow, straighten=args.straighten,
                   min_run=args.min_run)
    if not paths:
        sys.exit("error: no line-work detected — try --threshold or --invert")
    write_svg(out, size, paths, args.fill, mode=args.mode)

    if args.preview:
        cv2.imwrite(args.preview, cv2.bitwise_not(mask))

    noun = "pieces" if args.mode == "pieces" else "shapes"
    print(f"wrote {out}  ({len(paths)} {noun}, {size[1]}x{size[0]} px)")


if __name__ == "__main__":
    main()
