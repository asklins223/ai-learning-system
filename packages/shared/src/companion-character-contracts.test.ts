import assert from "node:assert/strict";
import test from "node:test";
import {
  characterCueV1Schema,
  evaluateSpriteLicense,
  isCharacterCueAllowed,
  SPRITE_POSE_BY_PRESENTATION,
  SPRITE_POSE_ORDER_V1,
  spriteLicenseV1Schema,
  spriteManifestV1Schema,
  validateSpriteManifestShape,
} from "./companion-character-contracts.js";

const SOURCE_SHA = "159f23153339db24815fcd9f8ed700907f55652ac15e859957c05e9b85dba2e5";

function validManifest() {
  const makePose = (name: string) => ({
    image: `${name}.png`,
    imageSha256: "a".repeat(64),
    naturalSize: { width: 700, height: 860 },
    footAnchor: { x: 350, y: 824 },
    opaqueBounds: { x: 100, y: 90, width: 460, height: 730 },
    hitMask: `hit-masks/${name}.bin`,
    hitMaskSize: { width: 128, height: 128 },
    hitMaskSha256: "b".repeat(64),
    semanticPose: name,
  });
  return {
    schemaVersion: 1,
    characterId: "learning-companion-owner-reference-v1",
    sourceReference: { path: "docs/image/source.png", sha256: SOURCE_SHA },
    canvas: { width: 700, height: 860 },
    poseOrder: [...SPRITE_POSE_ORDER_V1],
    poses: Object.fromEntries(
      SPRITE_POSE_ORDER_V1.map((pose) => [pose, makePose(pose)]),
    ),
  };
}

test("sprite manifest schema parses the frozen shape", () => {
  const parsed = spriteManifestV1Schema.safeParse(validManifest());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(validateSpriteManifestShape(parsed.data), { ok: true });
  }
});

test("manifest schema rejects extra keys and invalid foot anchors", () => {
  const manifest = validManifest() as Record<string, unknown>;
  manifest.extraKey = 1;
  assert.equal(spriteManifestV1Schema.safeParse(manifest).success, false);

  const valid = validManifest();
  valid.poses.idle.footAnchor = { x: 100, y: 100 };
  const parsed = spriteManifestV1Schema.safeParse(valid);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    const result = validateSpriteManifestShape(parsed.data);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reasons.join(","), /footAnchor/);
    }
  }
});

test("manifest schema rejects missing poses and placeholder markers", () => {
  const valid = validManifest();
  delete valid.poses.celebrate;
  const parsed = spriteManifestV1Schema.safeParse(valid);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    const result = validateSpriteManifestShape(parsed.data);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reasons.join(","), /missing pose: celebrate/);
    }
  }

  const withPlaceholder = validManifest() as unknown as {
    poses: Record<string, { image: string }>;
  };
  withPlaceholder.poses.idle.image = "<measure>.png";
  assert.equal(spriteManifestV1Schema.safeParse(withPlaceholder).success, false);
});

function validLicense() {
  return {
    schemaVersion: 1,
    characterId: "learning-companion-owner-reference-v1",
    sourceOwner: "Owner Legal Name",
    sourceReferenceSha256: SOURCE_SHA,
    permissions: {
      modify: true,
      commercialUse: true,
      redistributeDerivedAssets: true,
    },
    approvedBy: "Owner",
    approvedAt: "2026-08-09T00:00:00Z",
    notes: "Approved production asset.",
  };
}

test("license evaluation is production when fully approved", () => {
  const license = spriteLicenseV1Schema.parse(validLicense());
  const result = evaluateSpriteLicense(license, SOURCE_SHA);
  assert.equal(result.mode, "production");
  assert.deepEqual(result.reasons, []);
});

test("license evaluation is fail-closed (prototype) for the draft pack", () => {
  const draft = validLicense();
  draft.sourceOwner = "PENDING_OWNER_CONFIRMATION";
  draft.approvedBy = "PENDING_OWNER_APPROVAL";
  draft.approvedAt = "";
  draft.permissions.modify = false;
  const license = spriteLicenseV1Schema.parse(draft);
  const result = evaluateSpriteLicense(license, SOURCE_SHA);
  assert.equal(result.mode, "prototype");
  assert.ok(result.reasons.length > 0);
});

test("license evaluation rejects on source hash mismatch", () => {
  const license = spriteLicenseV1Schema.parse(validLicense());
  const result = evaluateSpriteLicense(license, "f".repeat(64));
  assert.equal(result.mode, "rejected");
});

test("license schema rejects a missing permission key", () => {
  const draft = validLicense() as Record<string, unknown>;
  delete (draft.permissions as Record<string, unknown>).commercialUse;
  assert.equal(spriteLicenseV1Schema.safeParse(draft).success, false);
});

test("presentation to sprite pose mapping is fail-closed for hidden", () => {
  assert.equal(SPRITE_POSE_BY_PRESENTATION.hidden, null);
  assert.equal(SPRITE_POSE_BY_PRESENTATION.idle, "idle");
  assert.equal(SPRITE_POSE_BY_PRESENTATION.listen, "listen");
  assert.equal(SPRITE_POSE_BY_PRESENTATION.think, "think");
  assert.equal(SPRITE_POSE_BY_PRESENTATION.speak, "analyze");
  assert.equal(SPRITE_POSE_BY_PRESENTATION.uncertain, "think");
});

test("cue validation parses and clamps intensity", () => {
  const cue = characterCueV1Schema.parse({
    generation: 3,
    intent: "encourage",
    emotion: "happy",
    intensity: 0.6,
  });
  assert.equal(cue.intent, "encourage");
  assert.equal(characterCueV1Schema.safeParse({ ...cue, intensity: 1.5 }).success, false);
});

test("isCharacterCueAllowed gates celebrate behind a real celebration state", () => {
  assert.equal(
    isCharacterCueAllowed(
      { generation: 1, intent: "celebrate", emotion: "happy", intensity: 1 },
      "idle",
    ),
    false,
  );
  assert.equal(
    isCharacterCueAllowed(
      { generation: 1, intent: "celebrate", emotion: "happy", intensity: 1 },
      "celebrate",
    ),
    true,
  );
});
