import { createHash } from "node:crypto";
import {
  CARD_GENERATION_MAX_BLOCKS,
  CARD_GENERATION_MAX_IMAGES,
  CARD_GENERATION_MAX_SOURCE_CHARS,
} from "@ailearn/shared";

/**
 * Conservative token estimate for the system prompt overhead in the map
 * input budget. The old CARD_MAP_SYSTEM_PROMPT was removed with the
 * Pipeline V2 engine; this constant preserves the budget arithmetic
 * without depending on a deleted prompt.
 */
const MAP_PROMPT_TOKEN_ESTIMATE = 2000;

export const SOURCE_PLANNER_VERSION = "source-unit-planner-v1";
export const MAX_GENERATION_SOURCE_CHARS = CARD_GENERATION_MAX_SOURCE_CHARS;
export const MAX_GENERATION_BLOCKS = CARD_GENERATION_MAX_BLOCKS;
export const MAX_GENERATION_IMAGES = CARD_GENERATION_MAX_IMAGES;

export type PlannableBlock = {
  id: string;
  ordinal: number;
  type: string;
  content: string;
};

export type SourceUnitKind = "text" | "list" | "code";

export type PlannedSourceSpan = {
  unitKey: string;
  kind: SourceUnitKind;
  blockId: string;
  blockOrdinal: number;
  charStart: number;
  charEnd: number;
  exactText: string;
  textHash: string;
  sectionPath: string[];
  tokenEstimate: number;
  required: true;
};

export type PlannedMapChunk = {
  ordinal: number;
  unitKeys: string[];
  tokenEstimate: number;
  sectionKeys: string[];
};

export type ImageSectionPath = {
  blockId: string;
  sectionPath: string[];
};

export type SourcePlan = {
  plannerVersion: string;
  spans: PlannedSourceSpan[];
  chunks: PlannedMapChunk[];
  imageBlockIds: string[];
  imageSectionPaths: ImageSectionPath[];
  totalSourceChars: number;
  totalTokenEstimate: number;
  mapInputBudgetTokens: number;
  maxSourceUnitTokens: number;
};

export type ProviderCapability = {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  schemaOverheadTokens: number;
  safetyMarginTokens: number;
  targetChunkTokens: number;
  maxSourceUnitTokens: number;
};

export class SourcePlanningError extends Error {
  readonly code: "input_limit_exceeded" | "planner_coverage_gap" | "planner_budget_invalid";
  readonly details: Record<string, number>;

  constructor(
    code: SourcePlanningError["code"],
    message: string,
    details: Record<string, number> = {},
  ) {
    super(message);
    this.name = "SourcePlanningError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Conservative registry defaults. A configured capability snapshot can
 * override these values per run; unknown models never receive an optimistic
 * context-window assumption.
 */
export function resolveProviderCapability(
  override: Partial<ProviderCapability> = {},
): ProviderCapability {
  const defaults: ProviderCapability = {
    contextWindowTokens: 32_768,
    reservedOutputTokens: 4_096,
    schemaOverheadTokens: 1_024,
    safetyMarginTokens: 2_048,
    targetChunkTokens: 6_000,
    maxSourceUnitTokens: 1_500,
  };
  const capability = { ...defaults, ...override };
  const promptTokens = MAP_PROMPT_TOKEN_ESTIMATE;
  const available = capability.contextWindowTokens
    - promptTokens
    - capability.reservedOutputTokens
    - capability.schemaOverheadTokens
    - capability.safetyMarginTokens;
  if (available < 1_000) {
    throw new SourcePlanningError(
      "planner_budget_invalid",
      "provider capability leaves no safe map input budget",
      { available },
    );
  }
  return {
    ...capability,
    targetChunkTokens: Math.min(capability.targetChunkTokens, available),
    maxSourceUnitTokens: Math.min(capability.maxSourceUnitTokens, available),
  };
}

/** Conservative tokenizer fallback: CJK/symbols count as one token, ASCII runs as 4 chars/token. */
export function estimateTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceKind(type: string): SourceUnitKind {
  if (type === "code") return "code";
  if (type === "list") return "list";
  return "text";
}

/**
 * Detect decorative section markers like ────Title──── or ----Title----.
 * Returns the extracted title, or null if the content is not a section marker.
 * These patterns are common in Chinese long-form articles where sections
 * are delimited by decorative line characters instead of markdown headings.
 */
function detectSectionMarker(content: string): string | null {
  const match = /^\s*([\u2500\u2501\u2550\-=_*~]{2,})\s*(.+?)\s*([\u2500\u2501\u2550\-=_*~]{2,})\s*$/.exec(content);
  if (!match) return null;
  const title = match[2].trim();
  if (title.length === 0 || title.length > 200) return null;
  // Reject if the "title" is itself just decorative characters
  if (/^[\u2500\u2501\u2550\-=_*~\s]+$/.test(title)) return null;
  return title;
}

function headingInfo(content: string): { level: number; title: string } {
  const match = /^\s*(#{1,6})\s+([\s\S]*?)\s*$/.exec(content);
  if (match) {
    return {
      level: match[1].length,
      title: (match[2] ?? content).replace(/\s+/g, " ").trim().slice(0, 200) || "未命名章节",
    };
  }
  // 编辑器创建的笔记把标题存成 `<hN>标题</hN>`（apps/web/lib/markdown-blocks.ts），
  // 只解析 `#` 前缀会把它们全部当成 level 1 且标题带原始标签，
  // 泄漏到 sectionPath → sectionKey → 已发布卡片标题。
  const htmlMatch = /^\s*<h([1-6])>([\s\S]*?)<\/h\1>\s*$/i.exec(content);
  if (htmlMatch) {
    return {
      level: Number(htmlMatch[1]),
      title: htmlMatch[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || "未命名章节",
    };
  }
  return {
    level: 1,
    title: content.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || "未命名章节",
  };
}

function largestEndWithinTokenBudget(
  text: string,
  start: number,
  maxTokens: number,
): number {
  let low = start + 1;
  let high = text.length;
  let best = low;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(start, middle)) <= maxTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return avoidSplitSurrogatePair(text, start, best);
}

function avoidSplitSurrogatePair(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) return end;
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? end - 1 : end;
}

function preferNaturalBoundary(text: string, start: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;
  const minimum = start + Math.max(1, Math.floor((hardEnd - start) * 0.55));
  const candidate = text.slice(minimum, hardEnd);
  const patterns = [/\n\n/g, /\n/g, /[。！？.!?；;]/g, /[,，、:]\s*/g, /\s+/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    let lastEnd = -1;
    while ((match = pattern.exec(candidate)) !== null) {
      lastEnd = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
    if (lastEnd > 0) return minimum + lastEnd;
  }
  return hardEnd;
}

export function splitBlockExactly(text: string, maxTokens: number): Array<{
  charStart: number;
  charEnd: number;
  exactText: string;
  tokenEstimate: number;
}> {
  if (text.length === 0) return [];
  const spans: Array<{
    charStart: number;
    charEnd: number;
    exactText: string;
    tokenEstimate: number;
  }> = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = largestEndWithinTokenBudget(text, start, maxTokens);
    const end = avoidSplitSurrogatePair(
      text,
      start,
      preferNaturalBoundary(text, start, hardEnd),
    );
    if (end <= start) {
      throw new SourcePlanningError("planner_coverage_gap", "planner did not advance", { start, end });
    }
    const exactText = text.slice(start, end);
    const tokenEstimate = estimateTokens(exactText);
    if (tokenEstimate > maxTokens) {
      throw new SourcePlanningError(
        "planner_budget_invalid",
        "source unit exceeds its token budget",
        { tokenEstimate, maxTokens },
      );
    }
    spans.push({ charStart: start, charEnd: end, exactText, tokenEstimate });
    start = end;
  }
  return spans;
}

export function verifyExactCoverage(
  blocks: PlannableBlock[],
  spans: PlannedSourceSpan[],
): void {
  const byBlock = new Map<string, PlannedSourceSpan[]>();
  for (const span of spans) {
    const current = byBlock.get(span.blockId) ?? [];
    current.push(span);
    byBlock.set(span.blockId, current);
  }
  for (const block of blocks.filter((item) => item.type !== "image" && item.content.length > 0)) {
    const blockSpans = (byBlock.get(block.id) ?? [])
      .sort((left, right) => left.charStart - right.charStart);
    let cursor = 0;
    let reconstructed = "";
    for (const span of blockSpans) {
      if (span.charStart !== cursor || span.charEnd <= span.charStart) {
        throw new SourcePlanningError(
          "planner_coverage_gap",
          "source span manifest contains a gap or overlap",
          { blockOrdinal: block.ordinal, cursor, nextStart: span.charStart },
        );
      }
      if (block.content.slice(span.charStart, span.charEnd) !== span.exactText) {
        throw new SourcePlanningError(
          "planner_coverage_gap",
          "source span text does not match its sealed offsets",
          { blockOrdinal: block.ordinal, charStart: span.charStart, charEnd: span.charEnd },
        );
      }
      reconstructed += span.exactText;
      cursor = span.charEnd;
    }
    if (cursor !== block.content.length || reconstructed !== block.content) {
      throw new SourcePlanningError(
        "planner_coverage_gap",
        "source span manifest does not reconstruct the complete block",
        { blockOrdinal: block.ordinal, cursor, sourceLength: block.content.length },
      );
    }
  }
}

export function planSourceUnits(
  noteVersionId: string,
  blocksInput: PlannableBlock[],
  capabilityOverride: Partial<ProviderCapability> = {},
): SourcePlan {
  const blocks = [...blocksInput].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const totalSourceChars = blocks
    .filter((block) => block.type !== "image")
    .reduce((total, block) => total + block.content.length, 0);
  const imageBlockIds = blocks.filter((block) => block.type === "image").map((block) => block.id);
  if (
    blocks.length > MAX_GENERATION_BLOCKS
    || totalSourceChars > MAX_GENERATION_SOURCE_CHARS
    || imageBlockIds.length > MAX_GENERATION_IMAGES
  ) {
    throw new SourcePlanningError("input_limit_exceeded", "generation input exceeds product limits", {
      blockCount: blocks.length,
      maxBlocks: MAX_GENERATION_BLOCKS,
      sourceChars: totalSourceChars,
      maxSourceChars: MAX_GENERATION_SOURCE_CHARS,
      imageCount: imageBlockIds.length,
      maxImages: MAX_GENERATION_IMAGES,
    });
  }

  const capability = resolveProviderCapability(capabilityOverride);
  const promptTokens = MAP_PROMPT_TOKEN_ESTIMATE;
  const mapInputBudgetTokens = capability.contextWindowTokens
    - promptTokens
    - capability.reservedOutputTokens
    - capability.schemaOverheadTokens
    - capability.safetyMarginTokens;
  const sectionPath: string[] = [];
  const spans: PlannedSourceSpan[] = [];
  const imageSectionPaths: ImageSectionPath[] = [];

  for (const block of blocks) {
    if (block.type === "image") {
      // Record the current sectionPath so image evidence can be attributed
      // to the same section as the surrounding text, instead of a hardcoded
      // "图片" pseudo-section that produces dozens of duplicate cards.
      imageSectionPaths.push({ blockId: block.id, sectionPath: [...sectionPath] });
      continue;
    }
    // Detect decorative section markers like ────Title──── in paragraph blocks.
    // These are common in Chinese long-form articles and act as level-1 headings.
    if (block.type === "paragraph") {
      const marker = detectSectionMarker(block.content);
      if (marker) {
        sectionPath.splice(1);
        sectionPath[0] = marker;
      }
    }
    if (block.type === "heading") {
      const heading = headingInfo(block.content);
      sectionPath.splice(heading.level - 1);
      // 跳级标题（如 # 后直接 ###，或笔记从 ## 开始）会在稀疏赋值时留下
      // null/undefined 空洞；jsonb round-trip 后 zod 的 z.array(z.string())
      // 直接拒绝，run 永久失败。先把缺失的祖先层级补为占位标题。
      for (let level = 0; level < heading.level - 1; level++) {
        if (sectionPath[level] === undefined || sectionPath[level] === null) {
          sectionPath[level] = "未命名章节";
        }
      }
      sectionPath[heading.level - 1] = heading.title;
    }
    for (const split of splitBlockExactly(block.content, capability.maxSourceUnitTokens)) {
      const textHash = sha256(split.exactText);
      const unitKey = sha256(JSON.stringify({
        plannerVersion: SOURCE_PLANNER_VERSION,
        noteVersionId,
        blockId: block.id,
        blockOrdinal: block.ordinal,
        charStart: split.charStart,
        charEnd: split.charEnd,
        textHash,
        sectionPath,
      }));
      spans.push({
        unitKey,
        kind: sourceKind(block.type),
        blockId: block.id,
        blockOrdinal: block.ordinal,
        charStart: split.charStart,
        charEnd: split.charEnd,
        exactText: split.exactText,
        textHash,
        sectionPath: [...sectionPath],
        tokenEstimate: split.tokenEstimate,
        required: true,
      });
    }
  }

  verifyExactCoverage(blocks, spans);
  const chunks: PlannedMapChunk[] = [];
  let pending: PlannedSourceSpan[] = [];
  let pendingTokens = 0;
  const flush = () => {
    if (pending.length === 0) return;
    chunks.push({
      ordinal: chunks.length,
      unitKeys: pending.map((span) => span.unitKey),
      tokenEstimate: pendingTokens,
      sectionKeys: [...new Set(pending.map((span) => span.sectionPath.join(" > ") || "__intro__"))],
    });
    pending = [];
    pendingTokens = 0;
  };
  // The provider contract allows 200 evidence units, but asking the model to
  // echo a coverage decision for that many short units produces very large
  // JSON and materially increases truncation/schema failures. Keep each
  // request below the schema ceiling while preserving the same exact source
  // coverage across chunks.
  const MAX_CHUNK_UNITS = 50;
  for (const span of spans) {
    if (
      pending.length > 0
      && (pendingTokens + span.tokenEstimate > capability.targetChunkTokens
        || pending.length >= MAX_CHUNK_UNITS)
    ) {
      flush();
    }
    pending.push(span);
    pendingTokens += span.tokenEstimate;
  }
  flush();

  return {
    plannerVersion: SOURCE_PLANNER_VERSION,
    spans,
    chunks,
    imageBlockIds,
    imageSectionPaths,
    totalSourceChars,
    totalTokenEstimate: spans.reduce((total, span) => total + span.tokenEstimate, 0),
    mapInputBudgetTokens,
    maxSourceUnitTokens: capability.maxSourceUnitTokens,
  };
}
