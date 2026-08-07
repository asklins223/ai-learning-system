import { createHash } from "node:crypto";

/**
 * P5-4: Note Version Diff(实施计划 §5.5)。
 *
 * 快照 diff:比较两个 note_versions 的 block 级内容,把变化范围定位到
 * Span(block)级,并按 bundle 的 section 归属映射到 Bundle 级。
 *
 * - spanKey = block.id(内容寻址:同一 block 内容变化 → 新的 contentHash,
 *   但 spanKey 不变,diff 报告其为 changed span)
 * - 纯函数、无副作用,输入为结构化 blocks(与 block_manifest 同形)。
 */

export interface NoteBlockLike {
  id: string;
  ordinal: number;
  type: string;
  content: string;
  imageAssetId?: string | null;
}

export interface SpanChange {
  spanKey: string;
  /** changed|added|removed */
  change: "changed" | "added" | "removed";
  prevContentHash?: string;
  nextContentHash?: string;
}

export interface NoteDiffResult {
  /** 变化 span(按 spanKey 定位) */
  changedSpans: SpanChange[];
  /** 未变化 span(供缓存命中判断) */
  unchangedSpans: string[];
  /** 整个快照的 contentHash(新版本) */
  nextContentHash: string;
  /** 是否有任何变化 */
  hasChanges: boolean;
}

/** 单 block 内容 hash(B1 规则:sha256(JSON.stringify())) */
export function blockContentHash(block: NoteBlockLike): string {
  return createHash("sha256")
    .update(JSON.stringify({ type: block.type, content: block.content, imageAssetId: block.imageAssetId ?? null }), "utf8")
    .digest("hex");
}

/**
 * diff 两个版本的 blocks。
 * 按 id 对齐;id 相同的比较 contentHash;新增/删除的 block 记入变化。
 */
export function diffNoteVersions(prevBlocks: NoteBlockLike[], nextBlocks: NoteBlockLike[]): NoteDiffResult {
  const prevById = new Map(prevBlocks.map((b) => [b.id, b]));
  const nextById = new Map(nextBlocks.map((b) => [b.id, b]));
  const changedSpans: SpanChange[] = [];
  const unchangedSpans: string[] = [];

  for (const b of nextBlocks) {
    const prev = prevById.get(b.id);
    if (!prev) {
      changedSpans.push({ spanKey: b.id, change: "added", nextContentHash: blockContentHash(b) });
      continue;
    }
    const prevHash = blockContentHash(prev);
    const nextHash = blockContentHash(b);
    if (prevHash !== nextHash) {
      changedSpans.push({ spanKey: b.id, change: "changed", prevContentHash: prevHash, nextContentHash: nextHash });
    } else {
      unchangedSpans.push(b.id);
    }
  }
  for (const b of prevBlocks) {
    if (!nextById.has(b.id)) {
      changedSpans.push({ spanKey: b.id, change: "removed", prevContentHash: blockContentHash(b) });
    }
  }

  const nextContentHash = createHash("sha256")
    .update(JSON.stringify(nextBlocks.map((b) => ({ id: b.id, hash: blockContentHash(b) }))), "utf8")
    .digest("hex");

  return { changedSpans, unchangedSpans, nextContentHash, hasChanges: changedSpans.length > 0 };
}

/**
 * 把 Span 级变化归属到 Bundle 级。
 * 输入 bundle 的 section 覆盖(哪些 sectionKey 属于该 bundle),
 * 输出:变化 span 中属于该 bundle 的子集。
 * 归属失败的变化 span 进入 leftovers(由 Gap Detection 识别,与 P3-7 一致)。
 */
export function attributeSpansToBundles(
  diff: NoteDiffResult,
  sectionByBundle: Record<string, string[]>,
  spanSectionKey: (spanKey: string) => string | null,
): { byBundle: Record<string, SpanChange[]>; leftovers: SpanChange[] } {
  const byBundle: Record<string, SpanChange[]> = {};
  const leftovers: SpanChange[] = [];
  const sectionToBundle = new Map<string, string>();
  for (const [bundleId, sections] of Object.entries(sectionByBundle)) {
    for (const s of sections) sectionToBundle.set(s, bundleId);
  }

  for (const span of diff.changedSpans) {
    const section = spanSectionKey(span.spanKey);
    const bundleId = section ? sectionToBundle.get(section) : undefined;
    if (bundleId) {
      (byBundle[bundleId] ??= []).push(span);
    } else {
      leftovers.push(span);
    }
  }
  return { byBundle, leftovers };
}
