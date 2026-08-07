import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { diffNoteVersions, type NoteBlockLike, type NoteDiffResult } from "./note-diff.ts";

/**
 * P5 增量复用接入(全量审计缺口:P5 组件此前零生产调用点)。
 *
 * prepare 阶段运行 Note Version Diff(P5-4):对比当前 noteVersion 与同 note 的
 * 上一版本 content,产出变化 span。真实版本迭代场景(用户在旧版本上再次生成)
 * 下,未变化 span 可复用既有提取/审查(供后续阶段读取 provider_snapshot.incremental);
 * 无上一版本(新 note)时 hasPrevious=false,走全量路径。
 *
 * 输出写入 run.provider_snapshot.incremental,与 execution_mode 同层。
 */

export interface IncrementalReuseInfo {
  hasPrevious: boolean;
  prevVersionNo: number | null;
  changedSpanCount: number;
  unchangedSpanCount: number;
  /** 可复用比例(unchanged / total,0-1);全量场景为 0 */
  reuseRatio: number;
  hasChanges: boolean;
}

interface NoteVersionRow {
  id: string;
  versionNo: number;
  contentJson: unknown;
}

/** 读取同 note 的上一版本(version_no 小于当前且最大) */
async function loadPreviousNoteVersion(
  workspaceId: string,
  noteId: string,
  currentVersionId: string,
): Promise<NoteVersionRow | null> {
  const rows = await db
    .select({
      id: schema.noteVersions.id,
      versionNo: schema.noteVersions.versionNo,
      contentJson: schema.noteVersions.contentJson,
    })
    .from(schema.noteVersions)
    .where(and(
      eq(schema.noteVersions.noteId, noteId),
      eq(schema.noteVersions.workspaceId, workspaceId),
      lt(schema.noteVersions.versionNo, (await db
        .select({ versionNo: schema.noteVersions.versionNo })
        .from(schema.noteVersions)
        .where(eq(schema.noteVersions.id, currentVersionId))
        .limit(1))[0]?.versionNo ?? 0),
    ))
    .orderBy(desc(schema.noteVersions.versionNo))
    .limit(1);
  return rows[0] ?? null;
}

/** 从 note version content_json 提取 blocks(与 block_manifest 同形) */
function blocksFromContent(contentJson: unknown): NoteBlockLike[] {
  const content = contentJson as { blocks?: Array<Record<string, unknown>> } | null;
  if (!content || !Array.isArray(content.blocks)) return [];
  return content.blocks
    .map((b, index) => ({
      id: String(b.id ?? `blk-${index}`),
      ordinal: Number(b.ordinal ?? index),
      type: String(b.type ?? "paragraph"),
      content: String(b.content ?? ""),
      imageAssetId: (b.imageAssetId as string | null | undefined) ?? null,
    }));
}

/** 对指定 run 做增量复用检查(无上一版本 → hasPrevious=false) */
export async function checkIncrementalReuse(
  workspaceId: string,
  runId: string,
): Promise<IncrementalReuseInfo> {
  const [run] = await db
    .select({
      noteId: schema.cardGenerationRuns.noteId,
      noteVersionId: schema.cardGenerationRuns.noteVersionId,
    })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, runId),
      eq(schema.cardGenerationRuns.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!run) return { hasPrevious: false, prevVersionNo: null, changedSpanCount: 0, unchangedSpanCount: 0, reuseRatio: 0, hasChanges: false };

  const [currentVersion] = await db
    .select({ contentJson: schema.noteVersions.contentJson })
    .from(schema.noteVersions)
    .where(eq(schema.noteVersions.id, run.noteVersionId))
    .limit(1);
  const prev = await loadPreviousNoteVersion(workspaceId, run.noteId, run.noteVersionId);
  if (!prev || !currentVersion) {
    return { hasPrevious: false, prevVersionNo: null, changedSpanCount: 0, unchangedSpanCount: 0, reuseRatio: 0, hasChanges: false };
  }

  const diff: NoteDiffResult = diffNoteVersions(
    blocksFromContent(prev.contentJson),
    blocksFromContent(currentVersion.contentJson),
  );
  const total = diff.changedSpans.length + diff.unchangedSpans.length;
  return {
    hasPrevious: true,
    prevVersionNo: prev.versionNo,
    changedSpanCount: diff.changedSpans.length,
    unchangedSpanCount: diff.unchangedSpans.length,
    reuseRatio: total > 0 ? diff.unchangedSpans.length / total : 0,
    hasChanges: diff.hasChanges,
  };
}

export { diffNoteVersions };
