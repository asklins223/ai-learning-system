/**
 * Model output sanitization layer.
 *
 * LLMs occasionally produce JSON that is structurally close to the expected
 * schema but violates it in predictable ways:
 *  - Missing optional fields (contentType, decorative, etc.)
 *  - Wrong enum values (importance value "detail" in cognitiveType field)
 *  - Wrong types (relationHints as strings instead of objects)
 *  - Array length violations (evidenceRefIds with > 12 elements)
 *  - region as [x, y, w, h] array instead of {x, y, width, height} object
 *
 * Instead of failing the job and wasting retries, these functions attempt to
 * repair the output before schema validation. If repair is impossible the
 * original parse error surfaces as before.
 *
 * QUAL-17 修复：添加修复指标追踪，记录每次修复的类型和次数。
 */

import {
  cardMapOutputSchema,
  imageInsightOutputSchema,
  type CardMapOutput,
  type ImageInsightOutput,
} from "./schemas.ts";

// ─── QUAL-17 修复指标追踪 ──────────────────────────────────────────────

/** 修复类型枚举 */
export type SanitizerRepairType =
  | "enum_swap"           // importance/cognitiveType 字段交换
  | "enum_default"        // 枚举值不合法，使用默认值
  | "array_truncate"      // 数组超长截断
  | "field_default"       // 缺失字段补默认值
  | "region_array_to_obj" // region 从数组转换为对象
  | "unresolved_reason"   // 补充 unresolvedReason
  ;

/** 修复指标快照 */
export interface SanitizerMetrics {
  /** 各修复类型的累计计数 */
  counts: Record<SanitizerRepairType, number>;
  /** 总修复次数 */
  totalRepairs: number;
  /** 被修复的输出总数（一次输出可能触发多种修复） */
  repairedOutputs: number;
}

// 模块级修复计数器
const repairCounts: Record<SanitizerRepairType, number> = {
  enum_swap: 0,
  enum_default: 0,
  array_truncate: 0,
  field_default: 0,
  region_array_to_obj: 0,
  unresolved_reason: 0,
};
let totalRepairs = 0;
let repairedOutputs = 0;

/** 记录一次修复 */
function recordRepair(type: SanitizerRepairType): void {
  repairCounts[type]++;
  totalRepairs++;
}

/** 标记一次输出被修复 */
function markOutputRepaired(): void {
  repairedOutputs++;
}

/** 获取并重置修复指标（用于定期上报） */
export function collectAndResetSanitizerMetrics(): SanitizerMetrics {
  const snapshot: SanitizerMetrics = {
    counts: { ...repairCounts },
    totalRepairs,
    repairedOutputs,
  };
  // 重置计数器
  for (const key of Object.keys(repairCounts) as SanitizerRepairType[]) {
    repairCounts[key] = 0;
  }
  totalRepairs = 0;
  repairedOutputs = 0;
  return snapshot;
}

/** 获取当前修复指标（不重置） */
export function peekSanitizerMetrics(): SanitizerMetrics {
  return {
    counts: { ...repairCounts },
    totalRepairs,
    repairedOutputs,
  };
}

// ─── CardMap output sanitization ──────────────────────────────────────────

const VALID_COGNITIVE_TYPES = new Set(["concept", "comparison", "causal", "procedure", "boundary", "code", "formula"]);
const VALID_IMPORTANCE = new Set(["core", "supporting", "detail"]);
const VALID_DIFFICULTY = new Set(["basic", "intermediate", "advanced"]);
const VALID_NOCANDIDATE_REASONS = new Set(["metadata", "duplicate", "example_only", "decorative", "no_learnable_fact"]);

/**
 * Repair common LLM output violations for card map candidates.
 * Returns a sanitized copy; never mutates the input.
 */
export function sanitizeCardMapOutput(raw: unknown): CardMapOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const sectionSummary = typeof obj.sectionSummary === "string" ? obj.sectionSummary.slice(0, 1000) : "";
  const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates as unknown[] : [];
  const candidates = rawCandidates.map(sanitizeCandidate).filter(isPresent);
  const rawNoCandidateUnitIds = Array.isArray(obj.noCandidateUnitIds)
    ? obj.noCandidateUnitIds as unknown[]
    : [];
  const noCandidateUnitIds = rawNoCandidateUnitIds.map(sanitizeNoCandidate).filter(isPresent);

  // Required semantic entries must never disappear during repair. Turning an
  // invalid candidate into a valid-looking empty response only moves the
  // failure downstream and obscures the provider contract violation.
  if (
    candidates.length !== rawCandidates.length
    || noCandidateUnitIds.length !== rawNoCandidateUnitIds.length
  ) {
    return null;
  }

  const repaired = {
    sectionSummary,
    candidates: candidates.slice(0, 80),
    noCandidateUnitIds: noCandidateUnitIds.slice(0, 200),
  };

  // Validate localId uniqueness
  const seen = new Set<string>();
  for (const c of repaired.candidates) {
    if (seen.has(c.localId)) return null; // give up if duplicates
    seen.add(c.localId);
  }

  const parsed = cardMapOutputSchema.safeParse(repaired);
  return parsed.success ? parsed.data : null;
}

function sanitizeCandidate(raw: unknown): CardMapOutput["candidates"][number] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;

  const localId = typeof c.localId === "string" ? c.localId.slice(0, 100) : "";
  const claim = typeof c.claim === "string" ? c.claim.slice(0, 500) : "";
  if (!localId || !claim) return null;

  // evidenceRefIds: ensure array of strings, truncate to 12
  let evidenceRefIds: string[] = [];
  if (Array.isArray(c.evidenceRefIds)) {
    evidenceRefIds = (c.evidenceRefIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => id.slice(0, 160))
      .slice(0, 12);
  }
  if (evidenceRefIds.length === 0) return null;

  const topic = typeof c.topic === "string" && c.topic.trim()
    ? c.topic.slice(0, 200)
    : claim.slice(0, 200);

  let cognitiveType = typeof c.cognitiveType === "string"
    ? c.cognitiveType.toLowerCase()
    : "";
  let importance = typeof c.importance === "string"
    ? c.importance.toLowerCase()
    : "";
  // A common provider mistake is swapping these adjacent enum fields. This is
  // lossless to repair; unknown/missing semantic values are not guessed.
  if (VALID_IMPORTANCE.has(cognitiveType) && VALID_COGNITIVE_TYPES.has(importance)) {
    [cognitiveType, importance] = [importance, cognitiveType];
    recordRepair("enum_swap");
    markOutputRepaired();
  }
  // Some models put an importance value (e.g. "detail") into cognitiveType
  // while leaving importance correct or also invalid. In that case the
  // bidirectional swap above does not trigger. Default cognitiveType to
  // "concept" — importance is the higher-signal field for deck planning, and
  // cognitiveType is rarely actionable downstream.
  if (!VALID_COGNITIVE_TYPES.has(cognitiveType) && VALID_IMPORTANCE.has(cognitiveType)) {
    cognitiveType = "concept";
    recordRepair("enum_default");
    markOutputRepaired();
  }
  // Same logic in reverse: a cognitive type value in importance.
  if (!VALID_IMPORTANCE.has(importance) && VALID_COGNITIVE_TYPES.has(importance)) {
    importance = "supporting";
    recordRepair("enum_default");
    markOutputRepaired();
  }
  // Final fallback: if either field is still invalid after the targeted
  // repairs above, default rather than discard. A candidate with a guessed
  // enum is still more valuable than a dropped one (which breaks coverage
  // accounting and fails the entire map chunk).
  if (!VALID_COGNITIVE_TYPES.has(cognitiveType)) {
    cognitiveType = "concept";
    recordRepair("enum_default");
    markOutputRepaired();
  }
  if (!VALID_IMPORTANCE.has(importance)) {
    importance = "supporting";
    recordRepair("enum_default");
    markOutputRepaired();
  }

  // difficulty: default to "intermediate" if missing or invalid
  let difficulty = typeof c.difficulty === "string" ? c.difficulty.toLowerCase() : "";
  if (!VALID_DIFFICULTY.has(difficulty)) {
    difficulty = "intermediate";
    recordRepair("enum_default");
    markOutputRepaired();
  }

  // relationHints: strip if malformed (optional field)
  let relationHints: CardMapOutput["candidates"][number]["relationHints"];
  if (Array.isArray(c.relationHints)) {
    const valid = (c.relationHints as unknown[])
      .filter((h): h is Record<string, unknown> => !!h && typeof h === "object" && !Array.isArray(h))
      .filter((h) => {
        const type = h.type;
        return type === "supports" || type === "contrasts" || type === "depends_on";
      })
      .map((h) => ({
        type: h.type as "supports" | "contrasts" | "depends_on",
        localTargetId: typeof h.localTargetId === "string" ? h.localTargetId.slice(0, 100) : "",
      }))
      .filter((h) => h.localTargetId.length > 0)
      .slice(0, 20);
    if (valid.length > 0) relationHints = valid;
  }

  const result: CardMapOutput["candidates"][number] = {
    localId,
    claim,
    evidenceRefIds,
    topic,
    cognitiveType: cognitiveType as CardMapOutput["candidates"][number]["cognitiveType"],
    importance: importance as CardMapOutput["candidates"][number]["importance"],
    difficulty: difficulty as CardMapOutput["candidates"][number]["difficulty"],
    ...(relationHints ? { relationHints } : {}),
  };

  return result;
}

function sanitizeNoCandidate(raw: unknown): CardMapOutput["noCandidateUnitIds"][number] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;

  const unitId = typeof n.unitId === "string" ? n.unitId.slice(0, 160) : "";
  if (!unitId) return null;

  const rawReason = typeof n.reason === "string" ? n.reason.toLowerCase() : "";
  // Models sometimes leak an importance value (e.g. "detail") or a cognitive
  // type value into the reason field. Map the most common confusion to a
  // sensible default rather than discarding the entry.
  // QUAL-52 修复：将嵌套三元表达式改为 Set 查找，提高可读性和可维护性。
  const IMPORTANCE_VALUES = new Set(["detail", "core", "supporting"]);
  const COGNITIVE_VALUES = new Set(["concept", "comparison", "causal", "procedure", "boundary"]);
  const reason = VALID_NOCANDIDATE_REASONS.has(rawReason)
    ? rawReason
    : (IMPORTANCE_VALUES.has(rawReason) || COGNITIVE_VALUES.has(rawReason))
      ? "no_learnable_fact"
      : "";
  if (reason !== rawReason && reason !== "") {
    recordRepair("enum_default");
    markOutputRepaired();
  }
  // Final fallback: if the reason is still unrecognized, default rather than
  // discard — dropping a noCandidate entry breaks coverage accounting for the
  // entire map chunk.
  const finalReason = VALID_NOCANDIDATE_REASONS.has(reason) ? reason : "no_learnable_fact";

  return {
    unitId,
    reason: finalReason as CardMapOutput["noCandidateUnitIds"][number]["reason"],
  };
}

// ─── ImageInsight output sanitization ─────────────────────────────────────

const VALID_CONTENT_TYPES = new Set([
  "screenshot", "document", "table", "chart", "flowchart",
  "formula", "photo", "illustration", "decorative", "unknown",
]);
const VALID_FACT_KINDS = new Set(["table", "chart", "diagram", "formula", "document", "other"]);

/**
 * Repair common LLM output violations for image insight.
 * Returns a sanitized copy; never mutates the input.
 */
export function sanitizeImageInsightOutput(raw: unknown): ImageInsightOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // contentType: default to "unknown" if missing or invalid
  let contentType = typeof obj.contentType === "string" ? obj.contentType.toLowerCase() : "unknown";
  if (!VALID_CONTENT_TYPES.has(contentType)) {
    contentType = "unknown";
    recordRepair("field_default");
    markOutputRepaired();
  }

  // Safety/semantic decisions are never guessed by the sanitizer.
  if (
    typeof obj.decorative !== "boolean"
    || typeof obj.promptInjectionDetected !== "boolean"
  ) {
    return null;
  }
  const decorative = obj.decorative;

  // caption: default to empty string
  const caption = typeof obj.caption === "string" ? obj.caption.slice(0, 1000) : "";

  // OCR items
  const ocr = Array.isArray(obj.ocr)
    ? (obj.ocr as unknown[]).map(sanitizeOcrItem).filter(isPresent).slice(0, 500)
    : [];

  // Facts
  const facts = Array.isArray(obj.facts)
    ? (obj.facts as unknown[]).map(sanitizeFactItem).filter(isPresent).slice(0, 200)
    : [];

  const promptInjectionDetected = obj.promptInjectionDetected;
  const safetyFlags = Array.isArray(obj.safetyFlags)
    ? (obj.safetyFlags as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0).map((s) => s.slice(0, 100)).slice(0, 30)
    : [];

  let unresolvedReason: string | null = null;
  if (typeof obj.unresolvedReason === "string") {
    const r = obj.unresolvedReason.toLowerCase();
    if (r === "low_quality" || r === "unsupported" || r === "no_learnable_content") {
      unresolvedReason = r;
    }
  }

  // Apply superRefine logic:
  // - non-decorative with no OCR/facts and no unresolvedReason → set unresolvedReason
  // - contradictory decorative/evidence or decorative/unresolved outputs are
  //   semantic conflicts and must be repaired by the model, not guessed here.
  if (!decorative && ocr.length === 0 && facts.length === 0 && !unresolvedReason) {
    unresolvedReason = "no_learnable_content";
    recordRepair("unresolved_reason");
    markOutputRepaired();
  }
  if (decorative && (unresolvedReason !== null || ocr.length > 0 || facts.length > 0)) {
    return null;
  }

  const parsed = imageInsightOutputSchema.safeParse({
    contentType: contentType as ImageInsightOutput["contentType"],
    decorative,
    caption,
    ocr,
    facts,
    promptInjectionDetected,
    safetyFlags,
    unresolvedReason: unresolvedReason as ImageInsightOutput["unresolvedReason"],
  });
  return parsed.success ? parsed.data : null;
}

function sanitizeRegion(raw: unknown): { x: number; y: number; width: number; height: number; page?: number } | null {
  if (!raw) return null;

  // Case 1: already an object {x, y, width, height, page?}
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (![r.x, r.y, r.width, r.height].every(isNumeric)) return null;
    const x = clampInt(r.x, 0, 9999);
    const y = clampInt(r.y, 0, 9999);
    const width = clampInt(r.width, 1, 10000);
    const height = clampInt(r.height, 1, 10000);
    if (x + width > 10000) return null;
    if (y + height > 10000) return null;
    const page = clampInt(r.page, 0, 10000);
    return page > 0 ? { x, y, width, height, page } : { x, y, width, height };
  }

  // Case 2: array [x, y, width, height]
  if (Array.isArray(raw) && raw.length >= 4) {
    if (!raw.slice(0, 4).every(isNumeric)) return null;
    const x = clampInt(raw[0], 0, 9999);
    const y = clampInt(raw[1], 0, 9999);
    const width = clampInt(raw[2], 1, 10000);
    const height = clampInt(raw[3], 1, 10000);
    if (x + width > 10000) return null;
    if (y + height > 10000) return null;
    recordRepair("region_array_to_obj");
    markOutputRepaired();
    return { x, y, width, height };
  }

  return null;
}

function sanitizeOcrItem(raw: unknown): ImageInsightOutput["ocr"][number] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;

  const text = typeof item.text === "string" ? item.text.slice(0, 5000) : "";
  if (!text) return null;

  const region = sanitizeRegion(item.region);
  if (!region) return null;

  const confidence = clampNumber(item.confidence, 0, 1);

  return { text, region, confidence };
}

function sanitizeFactItem(raw: unknown): ImageInsightOutput["facts"][number] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;

  const text = typeof item.text === "string" ? item.text.slice(0, 2000) : "";
  if (!text) return null;

  const region = sanitizeRegion(item.region);
  if (!region) return null;

  const confidence = clampNumber(item.confidence, 0, 1);

  let kind = typeof item.kind === "string" ? item.kind.toLowerCase() : "other";
  if (!VALID_FACT_KINDS.has(kind)) kind = "other";

  return {
    text,
    region,
    confidence,
    kind: kind as ImageInsightOutput["facts"][number]["kind"],
  };
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
