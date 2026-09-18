"""Convert the generated eight-direction checker preview into clean game sprites.

The generator preview is RGB-composited over a grayscale checker.  This tool
flood-fills only checker-coloured pixels connected to the canvas edge, so white
parts of the costume enclosed by ink remain intact.  Transparent edge pixels
are colour-padded to prevent gray seams during GPU texture filtering.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image


DIRECTIONS = (
    "front",
    "front-right",
    "right",
    "back-right",
    "back",
    "back-left",
    "left",
    "front-left",
)


def is_checker(pixel: tuple[int, int, int]) -> bool:
    low = min(pixel)
    high = max(pixel)
    return low >= 184 and high - low <= 12


def connected_background(image: Image.Image) -> bytearray:
    width, height = image.size
    pixels = image.load()
    mask = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        offset = y * width + x
        if mask[offset] or not is_checker(pixels[x, y]):
            return
        mask[offset] = 1
        queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        if x > 0:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y > 0:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)
    return mask


def clean_rgba(source: Image.Image) -> Image.Image:
    rgb = source.convert("RGB")
    width, height = rgb.size
    background = connected_background(rgb)
    source_pixels = rgb.load()
    output = Image.new("RGBA", rgb.size)
    output_pixels = output.load()
    for y in range(height):
        for x in range(width):
            red, green, blue = source_pixels[x, y]
            output_pixels[x, y] = (red, green, blue, 0 if background[y * width + x] else 255)

    # Extend nearby foreground RGB underneath fully transparent pixels. This
    # keeps bilinear filtering from pulling the removed gray checker into hair.
    for _ in range(4):
        previous = output.copy()
        previous_pixels = previous.load()
        for y in range(1, height - 1):
            for x in range(1, width - 1):
                if output_pixels[x, y][3] != 0:
                    continue
                neighbours = [
                    previous_pixels[x - 1, y], previous_pixels[x + 1, y],
                    previous_pixels[x, y - 1], previous_pixels[x, y + 1],
                ]
                opaque = [pixel for pixel in neighbours if pixel[3] != 0]
                if not opaque:
                    continue
                output_pixels[x, y] = (
                    sum(pixel[0] for pixel in opaque) // len(opaque),
                    sum(pixel[1] for pixel in opaque) // len(opaque),
                    sum(pixel[2] for pixel in opaque) // len(opaque),
                    0,
                )
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--outfit", choices=("day", "night"), default="day")
    args = parser.parse_args()

    source = Image.open(args.source)
    if source.size != (1536, 1024):
        raise SystemExit(f"Expected a 1536x1024 4x2 sheet, got {source.size}")
    cleaned = clean_rgba(source)
    args.output.mkdir(parents=True, exist_ok=True)
    atlas_path = args.output / f"companion-{args.outfit}-directions-v2.png"
    cleaned.save(atlas_path, optimize=True)

    cell_width, cell_height = 384, 512
    for index, direction in enumerate(DIRECTIONS):
        column = index % 4
        row = index // 4
        cell = cleaned.crop((
            column * cell_width,
            row * cell_height,
            (column + 1) * cell_width,
            (row + 1) * cell_height,
        ))
        cell.save(args.output / f"companion-{args.outfit}-{direction}-v2.png", optimize=True)

    print(f"wrote {atlas_path} and {len(DIRECTIONS)} directional sprites")


if __name__ == "__main__":
    main()
