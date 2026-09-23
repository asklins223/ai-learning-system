/**
 * 证据预览的唯一读点（doc 34 L21 §2）。
 *
 * 候选 reveal 与卡片 reveal 以前各有一份"按快照 id 切 `note_blocks.content`"的代码，
 * 两份都不复算哈希——于是自动保存把那段文字改掉之后，界面上显示的仍然是
 * "原文依据"，而 keep/reject 是照它定的。这里把两半合掉：落点状态与切片只算一次。
 */
import { and, eq, inArray } from "drizzle-orm";
import { evidenceSnapshotsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { noteBlocks } from "@ailearn/shared/db-schema/note";
import { evidenceQuoteCopiesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { classifyEvidencePreviewV2 } from "@ailearn/shared/card-generation-v2-hashing";
import type { ApiTransaction } from "../../db/client.ts";

export interface EvidencePreviewItem {
  evidenceSnapshotId: string;
  preview: string;
  sourceLabel: string | null;
  sourceState: "located" | "drifted" | "missing";
  /**
   * 密封时冻住的原文（0275）。落点还在时它是 null——那时"当初那段"就是现在这段。
   * drifted/missing 时为 null 只有两种可能：这条证据是 0275 之前的存量，或副本行缺失。
   * 副本为空串与没有副本都归一到 null：0275 之前的存量一律 null，界面不能说"没有原文"，只能说"这段没被冻住"。
   */
  originalPreview: string | null;
}

const MAX_PREVIEWS = 20;
const MAX_PREVIEW_CHARS = 2000;

export async function loadEvidencePreviewItems(
  tx: ApiTransaction,
  workspaceId: string,
  refIds: string[],
): Promise<EvidencePreviewItem[]> {
  const ids = [...new Set(refIds)].slice(0, MAX_PREVIEWS);
  if (ids.length === 0) return [];

  const rows = await tx.select().from(evidenceSnapshotsV2)
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, workspaceId),
      inArray(evidenceSnapshotsV2.evidenceSnapshotId, ids),
    ))
    .limit(MAX_PREVIEWS);
  if (rows.length === 0) return [];

  const blockIds = [...new Set(
    rows.map((r) => r.blockId).filter((b): b is string => Boolean(b)),
  )];
  const blockTextById = new Map<string, string>();
  if (blockIds.length > 0) {
    const blockRows = await tx.select({ id: noteBlocks.id, content: noteBlocks.content })
      .from(noteBlocks)
      .where(and(
        eq(noteBlocks.workspaceId, workspaceId),
        inArray(noteBlocks.id, blockIds),
      ));
    for (const b of blockRows) blockTextById.set(b.id, b.content);
  }

  // 副本按 (workspace, evidence_snapshot_id) 取——**不是**按 protected_quote_ref 里那个号：
  // 0275 之前的行 ref 里装的是凭空抽的随机号（L21 §1 那个缺陷本身），按它查永远查不到。
  const copyTextById = new Map<string, string>();
  const copyRows = await tx
    .select({
      evidenceSnapshotId: evidenceQuoteCopiesV2.evidenceSnapshotId,
      quoteText: evidenceQuoteCopiesV2.quoteText,
    })
    .from(evidenceQuoteCopiesV2)
    .where(and(
      eq(evidenceQuoteCopiesV2.workspaceId, workspaceId),
      inArray(evidenceQuoteCopiesV2.evidenceSnapshotId, rows.map((r) => r.evidenceSnapshotId)),
    ));
  for (const c of copyRows) copyTextById.set(c.evidenceSnapshotId, c.quoteText);

  const items: EvidencePreviewItem[] = [];
  for (const row of rows) {
    const blockContent = row.blockId ? blockTextById.get(row.blockId) ?? null : null;
    const { state, quote } = classifyEvidencePreviewV2({
      blockContent,
      blockContentHash: row.blockContentHash,
      quoteHash: row.quoteHash,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
    });
    const preview = quote.trim().slice(0, MAX_PREVIEW_CHARS);
    // 落点还在、文字也没变，却切出个空串——那是这条证据本身没有正文，
    // 和"找不到原文"是两件事，不该占用后者的位置。
    if (state === "located" && !preview) continue;
    items.push({
      evidenceSnapshotId: row.evidenceSnapshotId,
      preview,
      sourceLabel: null,
      sourceState: state,
      originalPreview: state === "located"
        ? null
        : (copyTextById.get(row.evidenceSnapshotId) ?? "").trim().slice(0, MAX_PREVIEW_CHARS) || null,
    });
  }
  return items;
}
