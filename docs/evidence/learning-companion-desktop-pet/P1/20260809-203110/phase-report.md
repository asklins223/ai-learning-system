---
phase: P1
result: blocked
scope: "Repair of draft Level A raster edges only; Surface Prototype runtime was not started"
previousEvidence: "/Users/asklins/Documents/study/docs/evidence/learning-companion-desktop-pet/P1/20260809-200304/phase-report.md"
repairReason: "Owner reported conspicuous fringe and jagged edges in the first draft asset pack"
repairMethod:
  - "Re-extract from the frozen 700x1880 RGB source, not from the already-resampled draft"
  - "Boundary-connected checker removal with a controlled near-key edge trim"
  - "Clear hidden RGB before resampling"
  - "Premultiplied-alpha LANCZOS resize, exactly once"
  - "Re-align fixed footAnchor (350,824) and regenerate independent hit masks"
testsPassed:
  - "8/8 outputs are RGBA 700x860"
  - "8/8 hit masks are 2048 bytes and manifest hashes match"
  - "Hidden RGB is cleared for transparent pixels"
  - "Four-background contact sheet reviewed"
  - "Near-checker boundary pixel count decreased for all 8 poses versus the previous draft"
testsFailed:
  - "License and Owner approval remain fail-closed"
  - "P0 previous phase remains blocked"
ownerReviewRequired:
  - "Review repaired contact sheet at normal runtime size"
  - "Confirm whether the remaining thin bright contour is intentional source artwork or requires an approved clean source"
  - "Provide/approve legal metadata before any runtime enablement"
---

旧版备份：`/tmp/companion-sprite-v1-before-repair`。修复后的可视证据见 `contact-sheet.png`，前后边缘指标见 `asset-validation.json`。
