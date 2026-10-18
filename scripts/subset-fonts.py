#!/usr/bin/env python3
"""Instance and subset one source font into one woff2 file.

This is font-maintenance tooling, not part of the application build. It is
called by ``scripts/fetch-fonts.ps1`` for each ``kind: "google"`` output in
``scripts/font-sources.json``; ordinary builds use the committed woff2 files and
need neither Python nor the network.

The subset keeps exactly the OpenType features the Typography panel can ask
for — common/contextual ligatures, oldstyle and tabular figures, and the slashed
zero — and drops the decorative sets, so the switches stay real without paying
for glyphs the UI never requests. It refuses to write a file whose Latin probe
or required features are missing.

    python scripts/subset-fonts.py \
        --source EBGaramond[wght].ttf \
        --output src/assets/fonts/EBGaramond-Variable.woff2 \
        --instance '{"wght": 600}' \
        --require onum,tnum,liga

Requires Python 3, fonttools and brotli.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# Basic Latin through Latin Extended-B, then Latin Extended Additional
# (Vietnamese), IPA, combining marks, punctuation, currency, letterlike,
# arrows, maths, technical, box drawing, blocks, geometric shapes and the
# Latin ligature block. Greek and Cyrillic are deliberately out of the default
# subsets; the Serif preset remains the full-coverage one.
UNICODE_RANGES = [
    (0x0000, 0x024F),
    (0x1E00, 0x1EFF),
    (0x0250, 0x02FF),
    (0x0300, 0x036F),
    (0x2000, 0x206F),
    (0x20A0, 0x20CF),
    (0x2100, 0x214F),
    (0x2190, 0x21FF),
    (0x2200, 0x22FF),
    (0x2300, 0x23FF),
    (0x2500, 0x257F),
    (0x2580, 0x259F),
    (0x25A0, 0x25FF),
    (0xFB00, 0xFB06),
]

DEFAULT_LAYOUT_FEATURES = [
    "ccmp",
    "locl",
    "rlig",
    "rvrn",
    "liga",
    "calt",
    "onum",
    "tnum",
    "zero",
    # Positioning is not optional: without kern the text loses its spacing,
    # and without mark/mkmk the combining accents lose their anchors.
    "kern",
    "mark",
    "mkmk",
]

# Every text face in the catalogue must at least cover Portuguese. The probe is
# deliberately not the full symbol list: Jost and Bodoni do not carry arrows,
# and those fall back through the stack as intended.
LATIN_PROBE = "ãõçáéíóúâêôàüñÃÕÇÁÉÍÓÚÂÊÔÀÜÑ"


def fail(message: str) -> None:
    print(f"subset-fonts: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--instance", default="", help="JSON object of axis values")
    parser.add_argument(
        "--features",
        default="",
        help="comma-separated layout features to keep (default: the full UI set)",
    )
    parser.add_argument(
        "--require",
        default="",
        help="comma-separated OpenType feature tags that must survive",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.source.is_file():
        fail(f"source not found: {args.source}")

    font = TTFont(args.source)
    if args.instance.strip():
        try:
            axes = json.loads(args.instance)
        except json.JSONDecodeError as error:
            fail(f"--instance is not JSON: {error}")
        if not isinstance(axes, dict) or not axes:
            fail("--instance must be a non-empty JSON object")
        font = instantiateVariableFont(font, axes, updateFontNames=False)

    required = [tag.strip() for tag in args.require.split(",") if tag.strip()]
    wanted = [tag.strip() for tag in args.features.split(",") if tag.strip()]
    if not wanted:
        wanted = DEFAULT_LAYOUT_FEATURES

    options = subset.Options()
    options.layout_features = wanted
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.hinting = True
    options.recalc_bounds = True
    options.drop_tables = []
    options.passthrough_tables = False

    subsetter = subset.Subsetter(options=options)
    unicodes = set()
    for start, end in UNICODE_RANGES:
        unicodes.update(range(start, end + 1))
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)

    cmap = font.getBestCmap() or {}
    missing = [character for character in LATIN_PROBE if ord(character) not in cmap]
    if missing:
        fail("Latin probe missing after subset: " + " ".join(missing))

    features = set()
    if "GSUB" in font:
        features = {
            record.FeatureTag
            for record in font["GSUB"].table.FeatureList.FeatureRecord
        }
    absent = [tag for tag in required if tag not in features]
    if absent:
        fail(
            "required feature(s) missing after subset: "
            + ", ".join(absent)
            + f" (present: {', '.join(sorted(features)) or 'none'})"
        )

    font.flavor = "woff2"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    font.save(buffer)
    data = buffer.getvalue()
    args.output.write_bytes(data)

    digest = hashlib.sha256(data).hexdigest()
    print(
        f"    {args.output.name:<38} {len(data) / 1024:7.1f} KB  "
        f"{len(font.getGlyphOrder()):4d} glyphs  {digest[:12]}"
    )


if __name__ == "__main__":
    main()
