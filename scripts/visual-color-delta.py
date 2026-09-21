#!/usr/bin/env python3
"""Measure what changed between a Playwright visual baseline and its actual render.

Used by the visual-test-writer agent (§10, step 3) so that a possible colour change is
*measured* rather than eyeballed from two PNGs. Reports the changed bounding box, sampled
expected/actual RGB pairs with per-channel deltas, and whether the change reads as a uniform
token/theme shift or as edge-scattered anti-aliasing.

Usage:
  python visual-color-delta.py <expected.png> <actual.png> [--samples N] [--json]

Exit codes: 0 = compared (identical or not), 2 = bad input.
"""

import argparse
import json
import sys
from collections import Counter

try:
    from PIL import Image, ImageChops
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "Pillow is required: pip install Pillow  (or run the review with the RGB values read "
        "manually from the expected/actual PNGs)\n"
    )
    sys.exit(2)


def load(path):
    try:
        return Image.open(path).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("cannot open %s: %s\n" % (path, exc))
        sys.exit(2)


def analyse(expected_path, actual_path, samples):
    exp = load(expected_path)
    act = load(actual_path)

    if exp.size != act.size:
        return {
            "verdict": "size-mismatch",
            "expected_size": list(exp.size),
            "actual_size": list(act.size),
            "note": "Images differ in size - this is a layout/viewport change, not a colour one.",
        }

    diff = ImageChops.difference(exp, act)
    bbox = diff.getbbox()
    if bbox is None:
        return {"verdict": "identical", "changed_pixels": 0, "size": list(exp.size)}

    region = diff.crop(bbox)
    exp_region = exp.crop(bbox)
    act_region = act.crop(bbox)
    w, h = region.size
    def pixels(img):
        raw = img.tobytes()
        return list(zip(raw[0::3], raw[1::3], raw[2::3]))

    d = pixels(region)
    e = pixels(exp_region)
    a = pixels(act_region)

    changed = [i for i, px in enumerate(d) if px != (0, 0, 0)]
    deltas = Counter(
        (a[i][0] - e[i][0], a[i][1] - e[i][1], a[i][2] - e[i][2]) for i in changed
    )
    top_delta, top_count = deltas.most_common(1)[0]
    uniformity = top_count / float(len(changed))

    # Edge-scatter heuristic: a pixel whose 4-neighbours are mostly unchanged looks like
    # anti-aliasing; a pixel sitting inside a changed block looks like a fill/token change.
    changed_set = set(changed)
    isolated = 0
    for i in changed:
        x, y = i % w, i // w
        neighbours = 0
        if x > 0 and (i - 1) in changed_set:
            neighbours += 1
        if x < w - 1 and (i + 1) in changed_set:
            neighbours += 1
        if y > 0 and (i - w) in changed_set:
            neighbours += 1
        if y < h - 1 and (i + w) in changed_set:
            neighbours += 1
        if neighbours <= 1:
            isolated += 1
    scatter = isolated / float(len(changed))

    if uniformity >= 0.6 and scatter < 0.5:
        verdict = "uniform-shift"
        reading = (
            "Uniform delta across a contiguous region - reads as a token / theme / fill colour "
            "change, not anti-aliasing. Treat as a real chromatic change until proven intended."
        )
    elif scatter >= 0.5 and max(abs(c) for c in top_delta) <= 24:
        verdict = "edge-scatter"
        reading = (
            "Small deltas on mostly isolated pixels along edges - reads as anti-aliasing / "
            "subpixel rendering noise. Fix the harness rather than the budget."
        )
    else:
        verdict = "mixed"
        reading = (
            "Neither cleanly uniform nor cleanly edge-scattered - look at the sampled points and "
            "the diff image together before classifying."
        )

    step = max(1, len(changed) // max(1, samples))
    points = []
    for i in changed[::step][:samples]:
        x, y = i % w, i // w
        points.append(
            {
                "xy": [bbox[0] + x, bbox[1] + y],
                "expected_rgb": list(e[i]),
                "actual_rgb": list(a[i]),
                "delta": [a[i][k] - e[i][k] for k in range(3)],
            }
        )

    return {
        "verdict": verdict,
        "reading": reading,
        "size": list(exp.size),
        "changed_bbox": list(bbox),
        "changed_pixels": len(changed),
        "changed_ratio": round(len(changed) / float(exp.size[0] * exp.size[1]), 6),
        "dominant_delta": list(top_delta),
        "dominant_delta_share": round(uniformity, 3),
        "isolated_pixel_share": round(scatter, 3),
        "distinct_deltas": len(deltas),
        "samples": points,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("expected")
    ap.add_argument("actual")
    ap.add_argument("--samples", type=int, default=8, help="how many changed pixels to print")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    result = analyse(args.expected, args.actual, max(1, args.samples))

    if args.json:
        print(json.dumps(result, indent=2))
        return

    v = result["verdict"]
    if v == "identical":
        print("identical - no pixels differ (%dx%d)" % tuple(result["size"]))
        return
    if v == "size-mismatch":
        print("SIZE MISMATCH: expected %s vs actual %s" % (
            "x".join(map(str, result["expected_size"])),
            "x".join(map(str, result["actual_size"])),
        ))
        print(result["note"])
        return

    print("verdict           : %s" % v)
    print("reading           : %s" % result["reading"])
    print("image size        : %dx%d" % tuple(result["size"]))
    print("changed bbox      : %s  (left, top, right, bottom)" % (result["changed_bbox"],))
    print("changed pixels    : %d  (ratio %s)" % (result["changed_pixels"], result["changed_ratio"]))
    print("dominant delta    : %s  in %.1f%% of changed pixels (%d distinct deltas)" % (
        tuple(result["dominant_delta"]), result["dominant_delta_share"] * 100,
        result["distinct_deltas"],
    ))
    print("isolated pixels   : %.1f%% (high = anti-aliasing along edges)" % (
        result["isolated_pixel_share"] * 100,
    ))
    print("samples (x,y): expected -> actual  [delta]")
    for s in result["samples"]:
        print("  (%4d,%4d): rgb%s -> rgb%s  %s" % (
            s["xy"][0], s["xy"][1], tuple(s["expected_rgb"]), tuple(s["actual_rgb"]),
            tuple(s["delta"]),
        ))


if __name__ == "__main__":
    main()
