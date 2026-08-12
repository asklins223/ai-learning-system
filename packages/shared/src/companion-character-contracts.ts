import { z } from "zod";

/**
 * Shared V1 contracts for the companion character layer (Sprite Level A and
 * the high-level semantic cue contract). The LLM may only ever suggest a
 * bounded `CharacterCueV1`; local presentation derives from runtime state via
 * `deriveCharacterPresentation` and never from arbitrary model parameters.
 */

// ─── 1. Character presentation state (derived projection, never a fifth truth) ───

export const characterPresentationStateV1Schema = z.enum([
  "hidden",
  "idle",
  "invite",
  "listen",
  "think",
  "analyze",
  "speak",
  "navigate",
  "encourage",
  "celebrate",
  "uncertain",
]);
export type CharacterPresentationStateV1 = z.infer<
  typeof characterPresentationStateV1Schema
>;

// ─── 2. High-level semantic cue (the only thing a model may suggest) ───

export const characterCueIntentV1Schema = z.enum([
  "acknowledge",
  "listen",
  "think",
  "explain",
  "encourage",
  "celebrate",
  "uncertain",
  "warn",
  "sleep",
]);
export type CharacterCueIntentV1 = z.infer<typeof characterCueIntentV1Schema>;

export const characterCueEmotionV1Schema = z.enum([
  "neutral",
  "happy",
  "curious",
  "concerned",
  "surprised",
]);
export type CharacterCueEmotionV1 = z.infer<typeof characterCueEmotionV1Schema>;

export const characterCueV1Schema = z
  .object({
    generation: z.number().int().nonnegative(),
    intent: characterCueIntentV1Schema,
    emotion: characterCueEmotionV1Schema,
    /** 0..1, clamped on both server and client. */
    intensity: z.number().min(0).max(1),
    durationMs: z.number().int().positive().optional(),
  })
  .strict();
export type CharacterCueV1 = z.infer<typeof characterCueV1Schema>;

/**
 * Client-side re-validation of a suggested cue. A cue is only applied when the
 * real runtime state authorizes its intent (e.g. `celebrate` requires a real
 * system event); this check never promotes an unauthorized cue.
 */
export function isCharacterCueAllowed(
  cue: CharacterCueV1,
  presentation: CharacterPresentationStateV1,
): boolean {
  switch (cue.intent) {
    case "celebrate":
      // Celebrate can only reinforce a real allowed celebration state.
      return presentation === "celebrate";
    case "listen":
      return presentation === "listen";
    case "sleep":
      return presentation === "hidden";
    default:
      return presentation !== "hidden";
  }
}

// ─── 3. Level A sprite manifest (frozen 700×860 runtime exports) ───

export const spritePoseV1Schema = z.enum([
  "idle",
  "invite",
  "navigate",
  "analyze",
  "listen",
  "think",
  "encourage",
  "celebrate",
]);
export type SpritePoseV1 = z.infer<typeof spritePoseV1Schema>;

export const SPRITE_POSE_ORDER_V1: readonly SpritePoseV1[] = [
  "idle",
  "invite",
  "navigate",
  "analyze",
  "listen",
  "think",
  "encourage",
  "celebrate",
];

const spritePointV1Schema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();

const spriteSizeV1Schema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const spriteBoundsV1Schema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const spritePoseEntryV1Schema = z
  .object({
    image: z.string().regex(/^[a-z0-9-]+\.png$/),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    naturalSize: spriteSizeV1Schema,
    footAnchor: spritePointV1Schema,
    opaqueBounds: spriteBoundsV1Schema,
    hitMask: z.string().regex(/^hit-masks\/[a-z0-9-]+\.bin$/),
    hitMaskSize: spriteSizeV1Schema,
    hitMaskSha256: z.string().regex(/^[a-f0-9]{64}$/),
    semanticPose: spritePoseV1Schema,
  })
  .strict();

export const spriteManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    characterId: z.string().min(1).max(120),
    sourceReference: z
      .object({
        path: z.string().min(1).max(400),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    canvas: z
      .object({
        width: z.literal(700),
        height: z.literal(860),
      })
      .strict(),
    poseOrder: z
      .array(spritePoseV1Schema)
      .length(SPRITE_POSE_ORDER_V1.length),
    poses: z.record(spritePoseV1Schema, spritePoseEntryV1Schema),
  })
  .strict();
export type SpriteManifestV1 = z.infer<typeof spriteManifestV1Schema>;

/** All eight entries must be present and share the frozen foot anchor. */
export function validateSpriteManifestShape(
  manifest: SpriteManifestV1,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (manifest.schemaVersion !== 1) reasons.push("schemaVersion must be 1");
  if (
    manifest.poseOrder.length !== SPRITE_POSE_ORDER_V1.length ||
    manifest.poseOrder.some((pose, index) => pose !== SPRITE_POSE_ORDER_V1[index])
  ) {
    reasons.push("poseOrder must match the frozen eight-pose order");
  }
  for (const pose of SPRITE_POSE_ORDER_V1) {
    const entry = manifest.poses[pose];
    if (!entry) {
      reasons.push(`missing pose: ${pose}`);
      continue;
    }
    if (entry.naturalSize.width !== 700 || entry.naturalSize.height !== 860) {
      reasons.push(`${pose}: naturalSize must be 700x860`);
    }
    if (entry.footAnchor.x !== 350 || entry.footAnchor.y !== 824) {
      reasons.push(`${pose}: footAnchor must be (350,824)`);
    }
    if (entry.semanticPose !== pose) {
      reasons.push(`${pose}: semanticPose must equal its key`);
    }
    const b = entry.opaqueBounds;
    if (
      b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 ||
      b.x + b.width > 700 || b.y + b.height > 860
    ) {
      reasons.push(`${pose}: opaqueBounds outside 700x860 canvas`);
    }
    const m = entry.hitMaskSize;
    if (m.width !== 128 || m.height !== 128) {
      reasons.push(`${pose}: hitMaskSize must be 128x128`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ─── 4. Level A license (fail-closed until the Owner approves) ───

export const spriteLicenseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    characterId: z.string().min(1).max(120),
    sourceOwner: z.string().min(1).max(200),
    sourceReferenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    permissions: z
      .object({
        modify: z.boolean(),
        commercialUse: z.boolean(),
        redistributeDerivedAssets: z.boolean(),
      })
      .strict(),
    approvedBy: z.string().min(1).max(200),
    approvedAt: z.string().max(64),
    notes: z.string().max(2000),
  })
  .strict();
export type SpriteLicenseV1 = z.infer<typeof spriteLicenseV1Schema>;

/**
 * Fail-closed evaluation of the draft asset pack.
 *
 * - `production`: every permission true, approver/approval timestamp present,
 *   no placeholder markers, and the referenced source hash matches.
 * - `prototype`: structurally valid draft usable only for the P1 Surface
 *   Prototype (visual demo with explicit `Surface Prototype` labeling).
 * - `rejected`: schema-invalid, hash mismatch, or unparseable.
 */
export type SpriteLicenseMode = "production" | "prototype" | "rejected";

const LICENSE_PLACEHOLDER_PATTERN = /<[^>]*>|PENDING_OWNER/;

export function evaluateSpriteLicense(
  license: SpriteLicenseV1,
  expectedSourceSha256: string,
): { mode: SpriteLicenseMode; reasons: string[] } {
  const reasons: string[] = [];
  if (license.schemaVersion !== 1) {
    reasons.push("schemaVersion must be 1");
  }
  if (license.sourceReferenceSha256 !== expectedSourceSha256) {
    reasons.push("sourceReferenceSha256 does not match the manifest source");
  }
  if (
    LICENSE_PLACEHOLDER_PATTERN.test(license.sourceOwner) ||
    LICENSE_PLACEHOLDER_PATTERN.test(license.approvedBy)
  ) {
    reasons.push("owner or approver still contains a placeholder marker");
  }
  if (license.approvedAt.length === 0) {
    reasons.push("approval timestamp is empty");
  }
  const permissionsOk =
    license.permissions.modify === true &&
    license.permissions.commercialUse === true &&
    license.permissions.redistributeDerivedAssets === true;
  if (!permissionsOk) {
    reasons.push("not all redistribution permissions are granted");
  }
  if (reasons.length > 0) {
    return { mode: reasons.includes("sourceReferenceSha256 does not match the manifest source") ? "rejected" : "prototype", reasons };
  }
  return { mode: "production", reasons: [] };
}

// ─── 5. Presentation → sprite pose mapping (01 §7.4) ───

export const SPRITE_POSE_BY_PRESENTATION: Record<
  CharacterPresentationStateV1,
  SpritePoseV1 | null
> = {
  hidden: null,
  idle: "idle",
  invite: "invite",
  listen: "listen",
  think: "think",
  analyze: "analyze",
  speak: "analyze",
  navigate: "navigate",
  encourage: "encourage",
  celebrate: "celebrate",
  uncertain: "think",
};
