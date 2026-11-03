#!/usr/bin/env python3
"""Resize and encode the landing-page screenshots as WebP.

`docs/screenshots/` is the source of truth. This script is run by hand when a
capture changes; the site build and CI only verify the committed results, so
they never need Pillow.

    python scripts/optimize-site-images.py --write
    python scripts/optimize-site-images.py --check

The second form is the one that fails when a committed image is missing, is not
WebP, has the wrong dimensions, or was upscaled from its source.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the message is the point
    sys.exit(
        "Pillow is required only for this script. Install it with:\n"
        "    python -m pip install pillow"
    )

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "screenshots"
OUTPUT = ROOT / "site" / "assets" / "img"

# width: target width in pixels. None keeps the native size. crop: left, top,
# right, bottom in source pixels, applied before any resize. quality: WebP
# quality; text-heavy captures need a little more than photographs.
IMAGES = [
    {
        "source": "auto-highlighting.webp",
        "output": "scroll-sync.webp",
        "width": 1800,
        "quality": 84,
    },
    {
        "source": "auto-highlighting.webp",
        "output": "sync-source.webp",
        "width": None,
        "crop": (60, 280, 980, 700),
        "quality": 86,
    },
    {
        "source": "auto-highlighting.webp",
        "output": "sync-preview.webp",
        "width": None,
        "crop": (1000, 340, 2020, 700),
        "quality": 86,
    },
    {
        "source": "builtin-ai-assistant.webp",
        "output": "ai-palette.webp",
        "width": 567,
        "quality": 88,
    },
    {
        "source": "typst-ieee-conference-paper.webp",
        "output": "typst-pages.webp",
        "width": 2000,
        "quality": 84,
    },
    {
        "source": "typography-presets-proposal.png",
        "output": "typography-presets.webp",
        "width": 1500,
        "quality": 86,
    },
    {
        "source": "typography-presets-implemented.png",
        "output": "typography-settings.webp",
        "width": 1400,
        "quality": 84,
    },
    {
        "source": "math-light.png",
        "output": "math-light.webp",
        "width": 1400,
        "quality": 84,
    },
    {
        "source": "math-dark.png",
        "output": "math-dark.webp",
        "width": 1400,
        "quality": 84,
    },
    {
        "source": "statusbar-p2.png",
        "output": "statusbar-tokens.webp",
        "width": None,
        "crop": (1325, 0, 1771, 46),
        "quality": 90,
    },
]


def expected_size(source: Image.Image, entry: dict) -> tuple[int, int]:
    image = source
    if entry.get("crop"):
        image = image.crop(entry["crop"])
    target_width = entry.get("width")
    if target_width and target_width < image.width:
        height = round(image.height * target_width / image.width)
        return target_width, height
    return image.width, image.height


def build(entry: dict) -> tuple[int, int, int, int]:
    source_path = SOURCE / entry["source"]
    output_path = OUTPUT / entry["output"]
    if not source_path.exists():
        raise SystemExit(f"missing source: {source_path}")

    with Image.open(source_path) as opened:
        source = opened.convert("RGBA" if opened.mode in ("RGBA", "LA") else "RGB")
        width, height = expected_size(source, entry)
        image = source
        if entry.get("crop"):
            image = image.crop(entry["crop"])
        if width != image.width:
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        # Screenshots are opaque; flattening avoids a surprise alpha channel and
        # keeps the WebP encoder on its smallest path.
        if image.mode != "RGB":
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.getchannel("A"))
            image = background
        image.save(
            output_path,
            "WEBP",
            quality=entry["quality"],
            method=6,
        )

    return (
        source_path.stat().st_size,
        output_path.stat().st_size,
        width,
        height,
    )


def check(entry: dict) -> tuple[bool, str]:
    output_path = OUTPUT / entry["output"]
    if not output_path.exists():
        return False, f"missing output: {output_path}"
    source_path = SOURCE / entry["source"]
    if not source_path.exists():
        return False, f"missing source: {source_path}"

    with Image.open(source_path) as opened:
        source = opened.convert("RGB")
        cropped = source.crop(entry["crop"]) if entry.get("crop") else source
        expected = expected_size(source, entry)
        source_width = cropped.width

    with Image.open(output_path) as image:
        if image.format != "WEBP":
            return False, f"{output_path.name}: format is {image.format}, not WEBP"
        if image.size != expected:
            return False, f"{output_path.name}: {image.size} != expected {expected}"

    if entry.get("width") and entry["width"] > source_width:
        return False, f"{output_path.name}: target is wider than the source"
    return True, f"{output_path.name}: {output_path.stat().st_size:,} bytes"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate every WebP")
    group.add_argument("--check", action="store_true", help="verify committed WebP files")
    args = parser.parse_args()

    if args.write:
        total_before = total_after = 0
        print(f"{'output':32} {'dimensions':>12} {'before':>10} {'after':>10} {'saved':>7}")
        for entry in IMAGES:
            before, after, width, height = build(entry)
            total_before += before
            total_after += after
            saved = 1 - after / before if before else 0
            print(
                f"{entry['output']:32} {width:>5}×{height:<6} "
                f"{before / 1024:>9.0f}K {after / 1024:>9.0f}K {saved:>6.0%}"
            )
        print(
            f"\ntotal: {total_before / 1024:.0f}K → {total_after / 1024:.0f}K "
            f"({1 - total_after / total_before:.0%} smaller)"
        )
        return 0

    failed = 0
    for entry in IMAGES:
        ok, message = check(entry)
        print(f"  {'PASS' if ok else 'FAIL'}  {message}")
        failed += 0 if ok else 1
    print(f"\n{len(IMAGES) - failed}/{len(IMAGES)} images passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
