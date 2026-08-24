/**
 * Quality evidence contracts for the desktop Golden Slice.
 *
 * Evidence is deliberately separate from product/domain state.  It records
 * the environment and the files that prove a gate; it must never become a
 * second source of truth for runtime success.
 */

import { z } from "zod";

const controlCharacters = /[\u0000-\u001f\u007f]/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const nonEmptyTextSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !controlCharacters.test(value), "control characters are not allowed");

export const sha256Schema = z.string().regex(sha256Pattern, "expected a lowercase SHA-256 digest");

/** Evidence paths are workspace-relative and cannot escape the evidence root. */
export const qualityEvidenceRelativePathV1Schema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !controlCharacters.test(value), "control characters are not allowed")
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), "evidence paths must be relative")
  .refine((value) => !/^[A-Za-z]:[\\/]/.test(value), "evidence paths must not contain a drive prefix")
  .refine((value) => !value.split(/[\\/]+/).includes(".."), "evidence paths must not escape the root")
  .refine((value) => !value.split(/[\\/]+/).includes("node_modules"), "node_modules cannot be evidence")
  .transform((value) => value.split("\\").join("/"));
export type QualityEvidenceRelativePathV1 = z.infer<typeof qualityEvidenceRelativePathV1Schema>;

export const qualityEnvironmentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  artifactSha256: sha256Schema,
  electronVersion: nonEmptyTextSchema,
  chromiumVersion: nonEmptyTextSchema,
  nodeVersion: nonEmptyTextSchema,
  os: z.enum(["macos", "windows", "linux"]),
  osVersion: nonEmptyTextSchema,
  arch: z.enum(["arm64", "x64"]),
  viewport: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  deviceScaleFactor: z.number().positive(),
  zoomFactor: z.number().positive(),
  locale: z.literal("zh-CN"),
  timezone: z.literal("Asia/Shanghai"),
  theme: z.enum(["day", "night"]),
  motionMode: z.enum(["full", "lite", "off"]),
  mediaMode: z.enum(["enabled", "poster-only"]),
  fontManifestSha256: sha256Schema,
  assetManifestSha256: sha256Schema,
  seedRevision: nonEmptyTextSchema,
  apiBuildRevision: nonEmptyTextSchema,
  domainSchemaRevision: nonEmptyTextSchema,
});
export type QualityEnvironmentV1 = z.infer<typeof qualityEnvironmentV1Schema>;

export const qualityEvidenceFileV1Schema = z.strictObject({
  path: qualityEvidenceRelativePathV1Schema,
  sha256: sha256Schema,
});
export type QualityEvidenceFileV1 = z.infer<typeof qualityEvidenceFileV1Schema>;

export const qualityGateEvidenceV1Schema = z.strictObject({
  id: nonEmptyTextSchema,
  status: z.enum([
    "passed",
    "failed",
    "blocked",
    "not_applicable",
    "advisory_passed",
    "advisory_failed",
  ]),
  evidenceFiles: z.array(qualityEvidenceFileV1Schema).max(200),
  reason: nonEmptyTextSchema.optional(),
});
export type QualityGateEvidenceV1 = z.infer<typeof qualityGateEvidenceV1Schema>;

export const qualityKnownIssueV1Schema = z.strictObject({
  id: nonEmptyTextSchema,
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  owner: nonEmptyTextSchema,
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type QualityKnownIssueV1 = z.infer<typeof qualityKnownIssueV1Schema>;

export const qualityEvidenceManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    suiteRevision: nonEmptyTextSchema,
    environment: qualityEnvironmentV1Schema,
    gates: z.array(qualityGateEvidenceV1Schema).max(200),
    visualBaselines: z.array(qualityEvidenceRelativePathV1Schema).max(200),
    knownIssues: z.array(qualityKnownIssueV1Schema).max(200),
    redactionsApplied: z.array(nonEmptyTextSchema).max(100),
  })
  .superRefine((value, context) => {
    const gateIds = new Set<string>();
    for (const [index, gate] of value.gates.entries()) {
      if (gateIds.has(gate.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["gates", index, "id"], message: "duplicate gate id" });
      }
      gateIds.add(gate.id);
      if (
        ["failed", "blocked", "not_applicable", "advisory_failed"].includes(gate.status)
        && !gate.reason
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["gates", index, "reason"], message: "non-passing gates require a reason" });
      }
    }

    const baselinePaths = new Set<string>();
    for (const [index, path] of value.visualBaselines.entries()) {
      if (baselinePaths.has(path)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["visualBaselines", index], message: "duplicate visual baseline" });
      }
      baselinePaths.add(path);
    }
  });
export type QualityEvidenceManifestV1 = z.infer<typeof qualityEvidenceManifestV1Schema>;
