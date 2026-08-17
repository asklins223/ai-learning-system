/**
 * Plan 23 W2-01/W2-02：Objective Origin 写/读 repository。
 *
 * - 写：幂等 create/bind（(workspace_id, origin_id) 唯一；ON CONFLICT DO NOTHING），
 *   写入前用 shared 合同 objectiveOriginV3Schema 校验 kind 条件字段（W1-02 的
 *   DB CHECK 是第二道防线），并校验 objective revision 属于当前 workspace。
 * - 读：按 objective / note / source 双向查询，结果按 bound_at 稳定排序。
 *
 * 权限边界：所有查询/写入都带 workspaceId 条件（RLS 兜底 FORCE）。
 */
import { and, eq, asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectiveOriginsV2,
  learningObjectiveRevisionsV2,
  type ObjectiveOriginKindV3,
} from "../../db/schema/card-generation-v2.ts";
import { noteVersions } from "../../db/schema/note.ts";
import {
  objectiveOriginV3Schema,
  type ObjectiveOriginV3,
} from "@ailearn/shared";

// ─── 写（W2-01）──────────────────────────────────────────────────────────

export interface OriginWriteInput {
  originId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  kind: ObjectiveOriginKindV3;
  noteId?: string | null;
  noteVersionId?: string | null;
  sourceSnapshotId?: string | null;
  evidenceSnapshotIds?: string[];
  importBatchRef?: string | null;
  legacyCardId?: string | null;
  legacyKeyPointId?: string | null;
  integrity?: "verified" | "legacy_unreviewed";
  provenance?: Record<string, unknown>;
}

export class OriginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginValidationError";
  }
}

export class ObjectiveRevisionNotFoundError extends Error {
  constructor(objectiveRevisionId: string, workspaceId: string) {
    super(
      "objective revision " + objectiveRevisionId + " does not exist in workspace " + workspaceId,
    );
    this.name = "ObjectiveRevisionNotFoundError";
  }
}

type OriginInsertRow = typeof learningObjectiveOriginsV2.$inferInsert;

/** 构造 wire 形态并过 shared 合同（校验 kind 条件字段），返回 { wire, row }。 */
function buildRow(
  workspaceId: string,
  input: OriginWriteInput,
): { wire: ObjectiveOriginV3; row: OriginInsertRow } {
  const wireInput: Record<string, unknown> = {
    originId: input.originId,
    kind: input.kind,
    noteId: input.noteId ?? null,
    noteVersionId: input.noteVersionId ?? null,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    evidenceSnapshotIds: input.evidenceSnapshotIds ?? [],
    integrity: input.integrity ?? "verified",
  };
  if (input.kind === "imported") {
    if (!input.importBatchRef) {
      throw new OriginValidationError("imported origin requires importBatchRef");
    }
    wireInput.importBatchRef = input.importBatchRef;
  }
  if (input.kind === "legacy_migrated") {
    if (!input.legacyKeyPointId) {
      throw new OriginValidationError("legacy_migrated origin requires legacyKeyPointId");
    }
    wireInput.legacyCardId = input.legacyCardId ?? null;
    wireInput.legacyKeyPointId = input.legacyKeyPointId;
  }
  const wire = objectiveOriginV3Schema.parse(wireInput);
  return {
    wire,
    row: {
      workspaceId,
      originId: input.originId,
      objectiveId: input.objectiveId,
      objectiveRevisionId: input.objectiveRevisionId,
      originKind: input.kind,
      noteId: wire.kind === "note" ? wire.noteId : null,
      noteVersionId: wire.kind === "note" ? wire.noteVersionId : null,
      sourceSnapshotId: wire.sourceSnapshotId,
      evidenceSnapshotIds: wire.evidenceSnapshotIds,
      importBatchRef: wire.kind === "imported" ? wire.importBatchRef : null,
      legacyCardId: wire.kind === "legacy_migrated" ? wire.legacyCardId : null,
      legacyKeyPointId: wire.kind === "legacy_migrated" ? wire.legacyKeyPointId : null,
      integrity: wire.integrity,
      provenance: (input.provenance ?? {}) as never,
    },
  };
}

/**
 * 幂等创建 Origin 绑定。返回 { created, origin }：
 * - created=true：新绑定；
 * - created=false：已存在（同一 (workspace_id, origin_id)），返回既有行。
 * 校验：objective revision 必须存在于当前 workspace（防跨 workspace 绑定）。
 */
export async function createObjectiveOrigin(
  tx: ApiTransaction,
  workspaceId: string,
  input: OriginWriteInput,
): Promise<{ created: boolean; origin: ObjectiveOriginV3 }> {
  const revision = await tx
    .select({ objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId })
    .from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
      eq(learningObjectiveRevisionsV2.objectiveRevisionId, input.objectiveRevisionId),
    ))
    .limit(1);
  if (!revision[0]) {
    throw new ObjectiveRevisionNotFoundError(input.objectiveRevisionId, workspaceId);
  }

  const { row } = buildRow(workspaceId, input);
  // 无 target 的 ON CONFLICT DO NOTHING：originId 唯一 与
  // (objective_revision_id, note_version_id) 唯一绑定 任一冲突都不报错，
  // 之后按 originId 读取既有行判定 created=false。
  const inserted = await tx
    .insert(learningObjectiveOriginsV2)
    .values(row)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return { created: true, origin: rowToWire(inserted[0]) };
  }
  // 冲突可能命中 originId 唯一 或 note 绑定唯一（同 revision+noteVersion 已存在）。
  // 先按 originId 找；kind=note 时再按 note 绑定找，返回既有行。
  let existing = await tx
    .select()
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
      eq(learningObjectiveOriginsV2.originId, input.originId),
    ))
    .limit(1);
  if (!existing[0] && input.kind === "note" && input.noteVersionId) {
    existing = await tx
      .select()
      .from(learningObjectiveOriginsV2)
      .where(and(
        eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
        eq(learningObjectiveOriginsV2.objectiveRevisionId, input.objectiveRevisionId),
        eq(learningObjectiveOriginsV2.noteVersionId, input.noteVersionId),
      ))
      .limit(1);
  }
  if (!existing[0]) {
    throw new OriginValidationError("conflict resolution failed for origin " + input.originId);
  }
  return { created: false, origin: rowToWire(existing[0]) };
}

// ─── 读（W2-02）──────────────────────────────────────────────────────────

type OriginRow = typeof learningObjectiveOriginsV2.$inferSelect;

export function rowToWire(row: OriginRow): ObjectiveOriginV3 {
  const base = {
    originId: row.originId,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    sourceSnapshotId: row.sourceSnapshotId,
    evidenceSnapshotIds: row.evidenceSnapshotIds ?? [],
    integrity: row.integrity as "verified" | "legacy_unreviewed",
  };
  switch (row.originKind) {
    case "note":
      return objectiveOriginV3Schema.parse({ ...base, kind: "note" });
    case "manual":
      return objectiveOriginV3Schema.parse({ ...base, kind: "manual" });
    case "imported":
      return objectiveOriginV3Schema.parse({ ...base, kind: "imported", importBatchRef: row.importBatchRef });
    case "legacy_migrated":
      return objectiveOriginV3Schema.parse({
        ...base,
        kind: "legacy_migrated",
        legacyCardId: row.legacyCardId,
        legacyKeyPointId: row.legacyKeyPointId,
      });
    default:
      throw new OriginValidationError("unknown origin_kind: " + String(row.originKind));
  }
}

/** 按 objective 查询（含 archived/superseded 历史；按 bound_at 稳定排序）。 */
export async function listOriginsByObjective(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveId: string,
): Promise<ObjectiveOriginV3[]> {
  const rows = await tx
    .select()
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
      eq(learningObjectiveOriginsV2.objectiveId, objectiveId),
    ))
    .orderBy(asc(learningObjectiveOriginsV2.boundAt), asc(learningObjectiveOriginsV2.id));
  return rows.map(rowToWire);
}

/** 按 note 双向查询（生成/来源侧使用）。 */
export async function listOriginsByNote(
  tx: ApiTransaction,
  workspaceId: string,
  noteId: string,
): Promise<ObjectiveOriginV3[]> {
  const rows = await tx
    .select()
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
      eq(learningObjectiveOriginsV2.noteId, noteId),
    ))
    .orderBy(asc(learningObjectiveOriginsV2.boundAt), asc(learningObjectiveOriginsV2.id));
  return rows.map(rowToWire);
}

// ─── W2-07：activation 事务内绑定已 seal 来源 ────────────────────────────

/**
 * 激活事务内为「已 seal 的 noteVersion」写 note Origin（失败整体回滚，保证
 * 0 canonical Objective/Card 或 0 无来源绑定，§30 W2-07）。
 * - noteVersionId 缺失（早期/测试卡）→ 不写，missing_origin 由 W2-06 队列处理；
 * - noteVersion 找不到 → 不写（来源不可证明，禁止猜测，§21.3）。
 */
export async function writeActivationNoteOrigin(
  tx: ApiTransaction,
  workspaceId: string,
  input: {
    originId: string;
    objectiveId: string;
    objectiveRevisionId: string;
    noteVersionId: string | null;
  },
): Promise<{ written: boolean; origin: ObjectiveOriginV3 | null }> {
  if (!input.noteVersionId) return { written: false, origin: null };
  const versionRows = await tx
    .select({ noteId: noteVersions.noteId })
    .from(noteVersions)
    .where(eq(noteVersions.id, input.noteVersionId))
    .limit(1);
  if (!versionRows[0]) return { written: false, origin: null };
  const { created, origin } = await createObjectiveOrigin(tx, workspaceId, {
    originId: input.originId,
    objectiveId: input.objectiveId,
    objectiveRevisionId: input.objectiveRevisionId,
    kind: "note",
    noteId: versionRows[0].noteId,
    noteVersionId: input.noteVersionId,
    integrity: "verified",
  });
  return { written: created, origin };
}

/**
 * target-equivalent revision 发布时把旧 revision 的 Origin 复制到新 revision
 * （§18.2：Origin 按 exact revision 复制或重新封存；旧行不改写）。
 */
export async function copyOriginsToRevision(
  tx: ApiTransaction,
  workspaceId: string,
  input: {
    fromRevisionId: string;
    toRevisionId: string;
    objectiveId: string;
  },
): Promise<number> {
  const rows = await tx
    .select()
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
      eq(learningObjectiveOriginsV2.objectiveRevisionId, input.fromRevisionId),
    ));
  let copied = 0;
  for (const row of rows) {
    const wire = rowToWire(row);
    const { created } = await createObjectiveOrigin(tx, workspaceId, {
      originId: randomUUID(),
      objectiveId: input.objectiveId,
      objectiveRevisionId: input.toRevisionId,
      kind: wire.kind,
      noteId: wire.kind === "note" ? wire.noteId : null,
      noteVersionId: wire.kind === "note" ? wire.noteVersionId : null,
      sourceSnapshotId: wire.sourceSnapshotId,
      evidenceSnapshotIds: wire.evidenceSnapshotIds,
      importBatchRef: wire.kind === "imported" ? wire.importBatchRef : null,
      legacyCardId: wire.kind === "legacy_migrated" ? wire.legacyCardId : null,
      legacyKeyPointId: wire.kind === "legacy_migrated" ? wire.legacyKeyPointId : null,
      integrity: wire.integrity,
    });
    if (created) copied += 1;
  }
  return copied;
}

/** 按 source snapshot 查询。 */
export async function listOriginsBySourceSnapshot(
  tx: ApiTransaction,
  workspaceId: string,
  sourceSnapshotId: string,
): Promise<ObjectiveOriginV3[]> {
  const rows = await tx
    .select()
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
      eq(learningObjectiveOriginsV2.sourceSnapshotId, sourceSnapshotId),
    ))
    .orderBy(asc(learningObjectiveOriginsV2.boundAt), asc(learningObjectiveOriginsV2.id));
  return rows.map(rowToWire);
}
