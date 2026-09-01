#!/usr/bin/env python3
"""Derive the Search archive-wall foreground rails from the reviewed posters.

The source poster remains the canonical scene.  This script only copies the
six manufactured walnut slot fronts into a same-size RGBA layer so live DOM
paper cards can sit behind those fronts without duplicating a second scene.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


WORLD_SIZE = (1672, 941)
ASSET_ROOT = Path(__file__).resolve().parent.parent / "src/renderer/public/assets/learning-room/v1"
POSTER_ROOT = ASSET_ROOT / "posters"
OUTPUT_ROOT = ASSET_ROOT / "foreground"

# These are the six straight manufactured fronts visible in the approved
# Search reference wall.  The slight endpoint offsets preserve the poster's
# hand-painted perspective while excluding the paper faces and side shelving.
RAIL_POLYGONS = (
    ((548, 515), (823, 515), (825, 548), (547, 548)),
    ((845, 515), (1133, 515), (1134, 548), (845, 548)),
    ((548, 640), (823, 640), (825, 673), (547, 673)),
    ((845, 640), (1133, 640), (1134, 673), (845, 673)),
    ((548, 764), (823, 764), (825, 797), (547, 797)),
    ((845, 764), (1133, 764), (1134, 797), (845, 797)),
)


def derive(theme: str) -> dict[str, object]:
    source_path = POSTER_ROOT / f"search-reference-{theme}-v1.png"
    output_path = OUTPUT_ROOT / f"search-foreground-{theme}-v1.png"
    source = Image.open(source_path).convert("RGBA")
    if source.size != WORLD_SIZE:
        raise ValueError(f"{source_path} must be {WORLD_SIZE}, got {source.size}")

    wood_mask = Image.new("L", WORLD_SIZE, 0)
    draw = ImageDraw.Draw(wood_mask)
    for polygon in RAIL_POLYGONS:
        draw.polygon(polygon, fill=255)

    # A small feather keeps the extracted anti-aliased wood edge from producing
    # a light seam at DPR 1/2.  The mask remains opaque across the rail faces.
    alpha = wood_mask.filter(ImageFilter.GaussianBlur(radius=0.7))

    # Keep a restrained portion of the poster's existing contact shadow below
    # each rail.  It is derived from the same pixels, so it follows day/night
    # lighting and does not invent a second light direction.
    shadow = Image.new("L", WORLD_SIZE, 0)
    shadow_draw = ImageDraw.Draw(shadow)
    for left, right, bottom in ((547, 1134, 558), (547, 1134, 683), (547, 1134, 807)):
        shadow_draw.rectangle((left, bottom - 7, right, bottom), fill=54)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=3.5))
    alpha = ImageChops.lighter(alpha, shadow)

    source.putalpha(alpha)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    source.save(output_path, format="PNG", optimize=True)
    digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
    return {
        "theme": theme,
        "path": str(output_path),
        "width": source.width,
        "height": source.height,
        "sha256": digest,
        "source": str(source_path),
        "alpha": "six central walnut slot fronts plus derived contact shadow",
    }


if __name__ == "__main__":
    print(json.dumps([derive("day"), derive("night")], ensure_ascii=False, indent=2))
