/**
 * Question Safety Assessment (计划 §7.7 / §10.2)
 *
 * 版本化 hard gate：每条 active question 在写成前必须通过此检查。
 *
 * 至少检查：
 * - 规范化 quote/claim/expectedConcept 的直接或高重合片段
 * - 答案式结论
 * - meta/prompt-injection 痕迹
 * - 非法题型与长度边界
 *
 * 命中稳定 reason code 时丢弃 AI 题并转安全的 deterministic template。
 */

import {
  QuestionSafetyReasonCode,
  type QuestionSafetyReasonCode as ReasonCode,
} from "./enums.ts";
import type { QuestionSafetyReport as SafetyReport } from "./types.ts";
import type { GenerateValidationQuestionOutput } from "./schemas.ts";

// ─── Constants ────────────────────────────────────────────────────────────

export const QUESTION_SAFETY_ASSESSOR_VERSION = "question-safety-v1" as const;

/** Minimum question length (characters) */
export const MIN_QUESTION_LENGTH = 5;

/** Maximum question length (characters) */
export const MAX_QUESTION_LENGTH = 500;

/** Overlap threshold for leak detection (0-1) */
export const LEAK_OVERLAP_THRESHOLD = 0.6;

/** Minimum fragment length to check for direct leaks (characters) */
export const MIN_FRAGMENT_LENGTH = 8;

// ─── Types ────────────────────────────────────────────────────────────────

export interface QuestionSafetyInput {
  /** The AI-generated question output to assess */
  output: GenerateValidationQuestionOutput;
  /** The claim that must not be leaked */
  claim: string;
  /** The quote that must not be directly referenced */
  quote: string;
  /** Allowed evidence ref IDs from the server allowlist */
  allowedEvidenceRefIds: string[];
}

export type QuestionSafetyResult = SafetyReport & {
  /** The reason codes hit (empty if passed) */
  reasonCodes: ReasonCode[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize text for comparison:
 * - trim
 * - collapse whitespace
 * - lowercase
 */
function normalize(text: string): string {
  return (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Tokenize text into word-level tokens for overlap calculation.
 */
function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[\s,.，。；;!?！？、（）()「」『』""'']+/)
    .filter((t) => t.length > 0);
}

/**
 * Calculate the overlap ratio between two texts.
 * Returns the fraction of textB's tokens that appear in textA.
 */
function tokenOverlap(textA: string, textB: string): number {
  const tokensA = new Set(tokenize(textA));
  const tokensB = tokenize(textB);
  if (tokensB.length === 0) return 0;
  let hits = 0;
  for (const token of tokensB) {
    if (tokensA.has(token)) hits++;
  }
  return hits / tokensB.length;
}

/**
 * Check if any contiguous fragment of `source` (>= minLength chars)
 * appears in `target`.
 */
function hasDirectFragment(source: string, target: string, minLength: number): boolean {
  const normSource = normalize(source);
  const normTarget = normalize(target);
  if (normSource.length < minLength || normTarget.length < minLength) return false;

  // Check for direct substring of fragments
  for (let i = 0; i <= normSource.length - minLength; i++) {
    // Find the end of the current word/phrase
    let end = i + minLength;
    // Extend to next word boundary for better matching
    while (end < normSource.length && !/\s/.test(normSource[end])) {
      end++;
    }
    const fragment = normSource.slice(i, end);
    if (fragment.length >= minLength && normTarget.includes(fragment)) {
      return true;
    }
  }
  return false;
}

/**
 * Patterns that suggest prompt injection attempts.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(?:the\s+)?(?:above|previous|all)\s+instructions/i,
  /disregard\s+(?:the\s+)?(?:above|previous|all)\s+instructions/i,
  /you\s+are\s+(?:now|actually)\s+/i,
  /system\s*:\s*/i,
  /<\s*(?:system|admin|developer)\s*>/i,
  /(?:reveal|show|tell|give)\s+(?:me\s+)?(?:the\s+)?(?:answer|claim|quote|expected)/i,
  /(?:I\s+am|I'm)\s+(?:the|an?)\s+(?:admin|developer|system)/i,
];

// ─── Assessment ───────────────────────────────────────────────────────────

/**
 * Assess a question output for safety violations.
 *
 * This is the hard gate that every AI-generated question must pass before
 * being persisted as `active`. If it fails, the question is discarded and
 * a deterministic fallback is used instead.
 *
 * The assessment is deterministic and versioned — same input always
 * produces the same result.
 */
export function assessQuestionOutput(input: QuestionSafetyInput): QuestionSafetyResult {
  const { output, claim, quote, allowedEvidenceRefIds } = input;
  const reasonCodes: ReasonCode[] = [];

  // 1. Check question type validity
  const validTypes = ["explain", "example", "apply"];
  if (!validTypes.includes(output.questionType)) {
    reasonCodes.push(QuestionSafetyReasonCode.INVALID_TYPE);
  }

  // 2. Check question length boundaries
  if (
    output.question.length < MIN_QUESTION_LENGTH ||
    output.question.length > MAX_QUESTION_LENGTH
  ) {
    reasonCodes.push(QuestionSafetyReasonCode.LENGTH_BOUNDARY);
  }

  // 3. Check for claim leakage
  // Direct fragment check: does the question contain a significant portion of the claim?
  if (hasDirectFragment(claim, output.question, MIN_FRAGMENT_LENGTH)) {
    reasonCodes.push(QuestionSafetyReasonCode.LEAKS_CLAIM);
  }

  // Overlap check: high token overlap suggests the question is too close to the claim
  if (tokenOverlap(output.question, claim) >= LEAK_OVERLAP_THRESHOLD) {
    reasonCodes.push(QuestionSafetyReasonCode.LEAKS_CLAIM);
  }

  // 4. Check for quote leakage
  if (hasDirectFragment(quote, output.question, MIN_FRAGMENT_LENGTH)) {
    reasonCodes.push(QuestionSafetyReasonCode.LEAKS_QUOTE);
  }

  if (tokenOverlap(output.question, quote) >= LEAK_OVERLAP_THRESHOLD) {
    reasonCodes.push(QuestionSafetyReasonCode.LEAKS_QUOTE);
  }

  // 5. Check for expectedConcept leakage in the question
  for (const item of output.rubricItems) {
    if (hasDirectFragment(item.expectedConcept, output.question, MIN_FRAGMENT_LENGTH)) {
      reasonCodes.push(QuestionSafetyReasonCode.LEAKS_EXPECTED_CONCEPT);
      break;
    }
    if (tokenOverlap(output.question, item.expectedConcept) >= LEAK_OVERLAP_THRESHOLD) {
      reasonCodes.push(QuestionSafetyReasonCode.LEAKS_EXPECTED_CONCEPT);
      break;
    }
  }

  // 6. Check for prompt injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(output.question)) {
      reasonCodes.push(QuestionSafetyReasonCode.PROMPT_INJECTION);
      break;
    }
  }

  // Also check rubric items for injection
  for (const item of output.rubricItems) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(item.criterion) || pattern.test(item.expectedConcept)) {
        reasonCodes.push(QuestionSafetyReasonCode.PROMPT_INJECTION);
        break;
      }
    }
    if (reasonCodes.includes(QuestionSafetyReasonCode.PROMPT_INJECTION)) break;
  }

  // 7. Validate evidence ref IDs
  for (const item of output.rubricItems) {
    if (!allowedEvidenceRefIds.includes(item.evidenceRefId)) {
      // Invalid evidence ref — this is a contract violation, not prompt injection
      reasonCodes.push(QuestionSafetyReasonCode.INVALID_EVIDENCE_REF);
      break;
    }
  }

  // Deduplicate reason codes
  const uniqueReasonCodes = [...new Set(reasonCodes)];

  return {
    passed: uniqueReasonCodes.length === 0,
    reasonCodes: uniqueReasonCodes,
    assessorVersion: QUESTION_SAFETY_ASSESSOR_VERSION,
    assessedAt: new Date().toISOString(),
  };
}

/**
 * Quick check: does the question pass the safety gate?
 */
export function isQuestionSafe(input: QuestionSafetyInput): boolean {
  return assessQuestionOutput(input).passed;
}
