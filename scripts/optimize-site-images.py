#!/usr/bin/env python3
"""Resize and encode the landing-page screenshots as WebP.

Reviewed outputs in `site/assets/img/` are the public source of truth. Original
captures live outside this checkout. Writing requires an explicit --source
directory (or MDRAFT_CAPTURE_DIR) and Pillow; checking needs only Python.

    python scripts/optimize-site-images.py --write
    python scripts/optimize-site-images.py --check

The second form is the one that fails when a committed image is missing, is not
WebP, has the wrong dimensions, or was upscaled from its source.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
from pathlib import Path

Image = None

ROOT = Path(__file__).resolve().parent.parent
SOURCE = None
OUTPUT = ROOT / "site" / "assets" / "img"
EXPECTED_SIZES = {
    "scroll-sync.webp": (1800, 1033),
    "sync-source.webp": (920, 420),
    "sync-preview.webp": (1020, 360),
    "ai-palette.webp": (567, 946),
    "typst-pages.webp": (2000, 867),
    "html-editor.webp": (1800, 985),
    "typography-presets.webp": (1500, 1160),
    "typography-settings.webp": (1400, 1412),
    "math-light.webp": (1400, 902),
    "math-dark.webp": (1400, 902),
    "statusbar-tokens.webp": (446, 46),
}

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
        "source": "html-editor.webp",
        "output": "html-editor.webp",
        "width": 1800,
        "quality": 86,
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
    data = output_path.read_bytes()
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return False, f"{output_path.name}: not a WebP container"
    if struct.unpack_from("<I", data, 4)[0] + 8 != len(data):
        return False, f"{output_path.name}: incomplete WebP container"
    size = None
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            return False, f"{output_path.name}: truncated chunk header"
        kind = data[offset : offset + 4]
        length = struct.unpack_from("<I", data, offset + 4)[0]
        chunk = data[offset + 8 : offset + 8 + length]
        if len(chunk) != length:
            return False, f"{output_path.name}: truncated chunk"
        if kind in (b"EXIF", b"XMP "):
            return False, f"{output_path.name}: remove publication metadata"
        if kind == b"VP8X" and length >= 10:
            size = (int.from_bytes(chunk[4:7], "little") + 1, int.from_bytes(chunk[7:10], "little") + 1)
        elif kind == b"VP8 " and length >= 10 and chunk[3:6] == b"\x9d\x01\x2a":
            size = (int.from_bytes(chunk[6:8], "little") & 0x3FFF, int.from_bytes(chunk[8:10], "little") & 0x3FFF)
        elif kind == b"VP8L" and length >= 5 and chunk[0] == 0x2F:
            packed = int.from_bytes(chunk[1:5], "little")
            size = ((packed & 0x3FFF) + 1, ((packed >> 14) & 0x3FFF) + 1)
        offset += 8 + length + (length & 1)
    expected = EXPECTED_SIZES[entry["output"]]
    if offset != len(data) or size != expected:
        return False, f"{output_path.name}: {size} != expected {expected}"
    if SOURCE is not None:
        source_path = SOURCE / entry["source"]
        if not source_path.is_file():
            return False, f"missing private original: {entry['source']}"
        with Image.open(source_path) as opened:
            source = opened.convert("RGB")
            if expected_size(source, entry) != expected:
                return False, f"{output_path.name}: original requires an inventory size update"
            width = source.crop(entry["crop"]).width if entry.get("crop") else source.width
            if entry.get("width") and entry["width"] > width:
                return False, f"{output_path.name}: target is wider than the original"
    return True, f"{output_path.name}: {output_path.stat().st_size:,} bytes"


def main() -> int:
    global SOURCE, Image
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="regenerate every WebP")
    group.add_argument("--check", action="store_true", help="verify committed WebP files")
    parser.add_argument("--source", type=Path, default=os.environ.get("MDRAFT_CAPTURE_DIR"), help="optional private original-capture directory")
    args = parser.parse_args()

    SOURCE = Path(args.source).resolve() if args.source else None
    if args.write and SOURCE is None:
        parser.error("--write needs --source or MDRAFT_CAPTURE_DIR; raw captures belong outside this checkout")
    if args.write or SOURCE is not None:
        try:
            from PIL import Image as PillowImage
        except ImportError:
            parser.error("Pillow is required only for writing or comparing private originals")
        Image = PillowImage

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
