#!/usr/bin/env python3
"""Extract the eight character poses from the supplied action reference sheet.

The reference PNG has a baked checkerboard preview background. The background
colors are removed only when they are connected to the tile boundary, so light
parts of the character (coat, skin highlights, and stars) remain opaque.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image


POSES = (
    "dormant",
    "invite_once",
    "navigate",
    "present_evidence",
    "listen",
    "uncertain_or_retry",
    "committed_change",
    "co_manipulate",
)


def is_checker_pixel(pixel: tuple[int, int, int]) -> bool:
    return pixel in {(255, 255, 255), (238, 238, 238)}


def remove_connected_checkerboard(tile: Image.Image) -> Image.Image:
    rgb = tile.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    background: set[tuple[int, int]] = set()
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        queue.extend(((0, y), (width - 1, y)))

    while queue:
        x, y = queue.popleft()
        if (x, y) in background or not is_checker_pixel(pixels[x, y]):
            continue
        background.add((x, y))
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    output = rgb.convert("RGBA")
    alpha = Image.new("L", (width, height), 255)
    alpha_pixels = alpha.load()
    for x, y in background:
        alpha_pixels[x, y] = 0
    output.putalpha(alpha)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    sheet = Image.open(args.input).convert("RGB")
    if sheet.size != (700, 1880):
        raise SystemExit(f"unexpected reference size: {sheet.size}")

    tile_width = 350
    tile_height = 470
    content_height = 430
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for index, pose in enumerate(POSES):
        row, column = divmod(index, 2)
        left = column * tile_width
        top = row * tile_height
        tile = sheet.crop((left, top, left + tile_width, top + content_height))
        transparent = remove_connected_checkerboard(tile)
        transparent.save(args.output_dir / f"{pose}.png", optimize=True)


if __name__ == "__main__":
    main()
