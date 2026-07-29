/**
 * source_fingerprint & exposure_fingerprint (计划 §6.7)
 *
 * 纯函数：不读取数据库、不修改状态。
 *
 * source_fingerprint 覆盖：
 *   workspace, user, card, key point ID
 *   claim/quote 规范化 hash
 *   note version ID + content hash
 *   对当前用户生效的 hard evidence ID, block ID, quote hash, alignment, override
 *   question prompt version, rubric policy version
 *   不得包含用户答案
 *
 * exposure_fingerprint 覆盖：
 *   workspace/user/key point
 *   规范化 claim/quote
 *   note content hash
 *   对当前用户生效的 hard evidence 内容/alignment/override
 *   明确排除 question, prompt, model, rubric/policy version 和纯元数据
 */

import { createHash } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────

export interface SourceFingerprintInput {
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string;
  claim: string;
  quote: string;
  noteVersionId: string;
  noteContentHash: string;
  evidence: EvidenceFingerprintPart[];
  questionPromptVersion: string;
  rubricPolicyVersion: string;
}

export interface ExposureFingerprintInput {
  workspaceId: string;
  userId: string;
  keyPointId: string;
  claim: string;
  quote: string;
  noteContentHash: string;
  evidence: EvidenceFingerprintPart[];
}

export interface EvidenceFingerprintPart {
  evidenceId: string;
  blockId: string | null;
  quoteHash: string;
  alignment: string;
  override: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize text for fingerprinting:
 * - trim
 * - collapse internal whitespace to single space
 * - lowercase
 *
 * This ensures minor formatting differences don't produce different fingerprints.
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Compute SHA-256 hash of a string, returning hex digest.
 */
function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Sort evidence parts by evidenceId for deterministic ordering.
 */
function sortEvidence(evidence: EvidenceFingerprintPart[]): EvidenceFingerprintPart[] {
  return [...evidence].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

/**
 * Hash a single evidence part into a deterministic string.
 */
function hashEvidencePart(part: EvidenceFingerprintPart): string {
  return [
    part.evidenceId,
    part.blockId ?? "null",
    part.quoteHash,
    part.alignment,
    part.override ?? "null",
  ].join("|");
}

function hashEvidenceArray(evidence: EvidenceFingerprintPart[]): string {
  const sorted = sortEvidence(evidence);
  return sha256(sorted.map(hashEvidencePart).join("\n"));
}

// ─── source_fingerprint ───────────────────────────────────────────────────

/**
 * Compute the full source fingerprint.
 *
 * This fingerprint covers question/prompt/rubric/policy version, so it changes
 * when the question or scoring version is upgraded. It is used for question
 * validity checks and must be re-verified before submission, worker result
 * writing, and schedule creation.
 *
 * MUST NOT include user answer.
 */
export function computeSourceFingerprint(input: SourceFingerprintInput): string {
  const components = [
    `ws:${input.workspaceId}`,
    `u:${input.userId}`,
    `c:${input.cardId}`,
    `kp:${input.keyPointId}`,
    `claim:${sha256(normalizeText(input.claim))}`,
    `quote:${sha256(normalizeText(input.quote))}`,
    `nv:${input.noteVersionId}`,
    `nch:${input.noteContentHash}`,
    `ev:${hashEvidenceArray(input.evidence)}`,
    `qp:${input.questionPromptVersion}`,
    `rp:${input.rubricPolicyVersion}`,
  ];
  return sha256(components.join("\n"));
}

// ─── exposure_fingerprint ─────────────────────────────────────────────────

/**
 * Compute the exposure fingerprint.
 *
 * This fingerprint explicitly EXCLUDES question, prompt, model, rubric/policy
 * version, and pure metadata. Only answer-bearing content or effective evidence
 * substantive changes produce a new exposure key.
 *
 * This ensures that only upgrading the question or scoring version does NOT
 * let a user who has seen the same answer content regain unassisted eligibility
 * early.
 */
export function computeExposureFingerprint(input: ExposureFingerprintInput): string {
  const components = [
    `ws:${input.workspaceId}`,
    `u:${input.userId}`,
    `kp:${input.keyPointId}`,
    `claim:${sha256(normalizeText(input.claim))}`,
    `quote:${sha256(normalizeText(input.quote))}`,
    `nch:${input.noteContentHash}`,
    `ev:${hashEvidenceArray(input.evidence)}`,
  ];
  return sha256(components.join("\n"));
}

// ─── Verification helpers ─────────────────────────────────────────────────

/**
 * Verify that a stored fingerprint matches the recomputed one.
 * Returns true if they match, false otherwise.
 */
export function verifySourceFingerprint(
  stored: string,
  input: SourceFingerprintInput,
): boolean {
  return stored === computeSourceFingerprint(input);
}

export function verifyExposureFingerprint(
  stored: string,
  input: ExposureFingerprintInput,
): boolean {
  return stored === computeExposureFingerprint(input);
}

// ─── Cooldown helper (计划 §6.4.2) ────────────────────────────────────────

/**
 * Compute the unassisted_eligible_after timestamp given the last exposure time.
 * The cooldown is at least 24 hours after the last exposure (计划 §6.4.2).
 */
export function computeUnassistedEligibleAfter(
  lastExposedAt: Date,
  cooldownHours = 24,
): Date {
  return new Date(lastExposedAt.getTime() + cooldownHours * 60 * 60 * 1_000);
}

/**
 * Check if the unassisted cooldown has elapsed.
 * Returns true if the user is eligible for unassisted review.
 */
export function isUnassistedEligible(
  unassistedEligibleAfter: Date | null,
  now: Date,
): boolean {
  if (!unassistedEligibleAfter) return true;
  return now.getTime() >= unassistedEligibleAfter.getTime();
}
