---
phase: P1
result: blocked
scope: "Level A draft asset extraction only; Surface Prototype runtime was not started"
ownerApproval: "docs/plans/learning-companion/desktop-pet-handoff/README.md §4: approvalStatus=approved, approvedPhases=[P1]"
previousEvidence: "/Users/asklins/Documents/study/docs/evidence/learning-companion-desktop-pet/P0/20260809-190137/phase-report.md"
implementedScope:
  - "Deterministic extraction from the frozen owner-reference source"
  - "Eight 700x860 RGBA runtime PNGs with fixed footAnchor (350,824)"
  - "Eight independent 128x128 MSB-first hit masks, 2048 bytes each"
  - "Strict manifest hashes, natural sizes, opaque bounds and semantic pose mapping"
  - "Fail-closed draft LICENSE.json with no invented owner or approval"
deferredScope:
  - "P1 Sprite Driver, reducer, PetSurface, Bubble, Composer, Menu and browser fallback"
  - "P1 visual approval G01-G12"
  - "Production installation or runtime asset enablement"
source:
  path: "docs/image/learning-companion-character-action-reference.png"
  sha256: "159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5"
testsPassed:
  - "Draft asset structural validation: 8/8 images present, RGBA 700x860"
  - "Draft hit-mask validation: 8/8 masks present, 2048 bytes each"
  - "Manifest image and hit-mask hashes match generated files"
  - "Transparent pixels have cleared hidden RGB"
  - "Four-background contact sheet reviewed: white, dark, red and green"
  - "apps/web npm run build: passed and includes /companion/pet"
  - "apps/web npm run typecheck: passed after the build completed"
testsFailed:
  - "P0 previous phase is still blocked and has not received Owner gate_passed acceptance"
  - "License gate remains blocked: source owner, permissions, approver and approval timestamp are not supplied"
  - "P1 visual approval YAML is not owner-approved"
ownerReviewRequired:
  - "Confirm source ownership and modify/commercial-use/redistribution rights"
  - "Fill and approve LICENSE.json with real Owner identity and UTC timestamp"
  - "Accept P0 evidence before P1 Surface Prototype starts"
  - "Freeze and approve P1 visual G01-G12 evidence"
---

本次只补齐了可由 Agent 确定性完成的 Level A 资产工程部分。`sprite-v1` 是 draft，不会被当作已批准生产资产；`LICENSE.json` 的权限字段保持 false，运行时必须继续 fail closed。
