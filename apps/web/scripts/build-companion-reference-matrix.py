#!/usr/bin/env python3
"""Build a review-only matrix for the owner-supplied Companion reference poses.

This is deliberately not a spritesheet packager. The supplied reference image
contains eight authored poses, while the runtime contract names eleven states.
The matrix makes reused and contract-suppressed states visible to reviewers
instead of silently presenting reused art as dedicated production artwork.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


FRAME_SIZE = (220, 270)
CARD_SIZE = (260, 330)
MARGIN = 20
COLS = 3

STATES = [
    ("dormant", "authored", "dormant.png"),
    ("invite_once", "authored", "invite_once.png"),
    ("navigate", "authored", "navigate.png"),
    ("explain", "reused", "present_evidence.png"),
    ("present_evidence", "authored", "present_evidence.png"),
    ("assessment_handoff", "reused", "uncertain_or_retry.png"),
    ("listen", "authored", "listen.png"),
    ("uncertain_or_retry", "authored", "uncertain_or_retry.png"),
    ("committed_change", "authored", "committed_change.png"),
    ("co_manipulate", "authored", "co_manipulate.png"),
    ("exit_or_hidden", "suppressed", None),
]


def font(size: int):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def checkerboard(size: tuple[int, int]) -> Image.Image:
    image = Image.new("RGBA", size, (248, 250, 252, 255))
    draw = ImageDraw.Draw(image)
    tile = 16
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            if (x // tile + y // tile) % 2 == 0:
                draw.rectangle((x, y, x + tile, y + tile), fill=(238, 242, 247, 255))
    return image


def fit_frame(source: Image.Image) -> Image.Image:
    source = source.convert("RGBA")
    bbox = source.getbbox()
    if bbox:
        source = source.crop(bbox)
    source.thumbnail((FRAME_SIZE[0] - 24, FRAME_SIZE[1] - 24), Image.Resampling.LANCZOS)
    frame = checkerboard(FRAME_SIZE)
    frame.alpha_composite(source, ((FRAME_SIZE[0] - source.width) // 2, (FRAME_SIZE[1] - source.height) // 2))
    return frame


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    args = parser.parse_args()

    title_font = font(22)
    body_font = font(16)
    width = MARGIN * 2 + COLS * CARD_SIZE[0] + (COLS - 1) * MARGIN
    rows = (len(STATES) + COLS - 1) // COLS
    height = MARGIN * 2 + rows * CARD_SIZE[1] + (rows - 1) * MARGIN
    canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    entries = []

    for index, (state, status, filename) in enumerate(STATES):
        row, col = divmod(index, COLS)
        x = MARGIN + col * (CARD_SIZE[0] + MARGIN)
        y = MARGIN + row * (CARD_SIZE[1] + MARGIN)
        draw.rounded_rectangle((x, y, x + CARD_SIZE[0], y + CARD_SIZE[1]), radius=14, fill=(248, 250, 252, 255), outline=(218, 225, 234, 255), width=2)
        if filename:
            source_path = args.asset_dir / filename
            if not source_path.exists():
                raise SystemExit(f"missing asset: {source_path}")
            frame = fit_frame(Image.open(source_path))
            canvas.alpha_composite(frame, (x + (CARD_SIZE[0] - FRAME_SIZE[0]) // 2, y + 16))
        else:
            empty = (x + 20, y + 16, x + CARD_SIZE[0] - 20, y + 16 + FRAME_SIZE[1])
            draw.rounded_rectangle(empty, radius=10, fill=(239, 243, 247, 255), outline=(190, 199, 211, 255), width=2)
            draw.text((x + 66, y + 130), "专用帧缺失", font=title_font, fill=(100, 113, 128, 255))

        badge = {
            "authored": (224, 244, 234, 255),
            "reused": (255, 242, 204, 255),
            "suppressed": (229, 235, 242, 255),
        }[status]
        badge_text = {"authored": "AUTHORED", "reused": "REUSED", "suppressed": "HIDDEN"}[status]
        badge_x = x + 16
        badge_y = y + CARD_SIZE[1] - 58
        draw.rounded_rectangle((badge_x, badge_y, badge_x + 92, badge_y + 25), radius=8, fill=badge)
        draw.text((badge_x + 9, badge_y + 5), badge_text, font=body_font, fill=(38, 48, 61, 255))
        draw.text((x + 16, badge_y + 31), state, font=body_font, fill=(38, 48, 61, 255))
        entries.append({"state": state, "status": status, "source": filename})

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(args.output, format="PNG", optimize=True)
    args.manifest_output.write_text(json.dumps({
        "kind": "companion_reference_asset_matrix",
        "source": "owner-supplied learning-companion-character-action-reference.png",
        "authoredPoseCount": sum(status == "authored" for _, status, _ in STATES),
        "stateCount": len(STATES),
        "entries": entries,
        "qualification": "review_only_pending_owner_asset_signoff",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
