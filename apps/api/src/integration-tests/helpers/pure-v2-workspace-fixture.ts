/**
 * 自播种"纯 V2 工作区"夹具（多 Objective + Note 血缘完整）。
 *
 * 背景（2026-08-23）：learning-dashboard / learning-objective-parity /
 * understanding-topology-v3 三个集成测试此前依赖硬编码 UUID 的手工开发
 * 工作区（4f825f38-…，方案 23 附录 A.2 的 Phase 0 现场数据），迁移 0176
 * 清库后该工作区已不存在，测试在干净 PG 上必然失败。现改为运行时自建：
 * 复用 v2-card-fixture 助手（含不可变触发器受控旁路的 cleanup），
 * 使三个套件可在任何干净 PG 上独立运行（CI 友好）。
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { seedV2Fixture, addV2ObjectiveToWorkspace } from "./v2-card-fixture.ts";

export interface PureV2WorkspaceFixture {
  workspaceId: string;
  userId: string;
  objectiveIds: string[];
  cleanup: () => Promise<void>;
}

/**
 * 创建含 objectiveCount 个 active Objective（各带 Note + Card + note_version_id）
 * 的独立工作区。cleanup 清空整个 workspace（复用 seedV2Fixture 的清理）。
 */
export async function seedPureV2Workspace(
  sql: postgres.Sql,
  opts: { objectiveCount?: number; statementPrefix?: string } = {},
): Promise<PureV2WorkspaceFixture> {
  const count = Math.max(1, opts.objectiveCount ?? 3);
  const prefix = opts.statementPrefix ?? "纯V2夹具目标";
  const first = await seedV2Fixture(sql, {
    objectiveStatement: `${prefix} 1`,
    publicSummary: `${prefix}一`,
    front: { cue: `${prefix}一`, prompt: `${prefix} 1 的练习题面？` },
  });
  const objectiveIds = [first.objectiveId];
  for (let i = 1; i < count; i += 1) {
    const added = await addV2ObjectiveToWorkspace(sql, first.workspaceId, first.userId, {
      objectiveStatement: `${prefix} ${i + 1}`,
      publicSummary: `${prefix}${["二", "三", "四", "五", "六"][i - 1] ?? i + 1}`,
      front: { cue: `${prefix}${i + 1}`, prompt: `${prefix} ${i + 1} 的练习题面？` },
    });
    objectiveIds.push(added.objectiveId);
  }
  return {
    workspaceId: first.workspaceId,
    userId: first.userId,
    objectiveIds,
    cleanup: first.cleanup,
  };
}

export interface NotesOnlyWorkspaceFixture {
  workspaceId: string;
  userId: string;
  noteIds: string[];
  cleanup: () => Promise<void>;
}

/**
 * 创建只有 Note、没有任何 Objective 的工作区（Dashboard notes_without_objectives 模式）。
 */
export async function seedNotesOnlyWorkspace(
  sql: postgres.Sql,
  opts: { noteCount?: number } = {},
): Promise<NotesOnlyWorkspaceFixture> {
  const noteCount = Math.max(1, opts.noteCount ?? 1);
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteIds: string[] = [];
  const versionIds: string[] = [];
  for (let i = 0; i < noteCount; i += 1) {
    noteIds.push(randomUUID());
    versionIds.push(randomUUID());
  }
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`notesonly-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId}, 'v1', now(), ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    for (let i = 0; i < noteCount; i += 1) {
      await tx`INSERT INTO notes (id, workspace_id, title, created_by)
        VALUES (${noteIds[i]}, ${workspaceId}, ${`notes-only-${i}`}, ${userId})`;
      await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionIds[i]}, ${noteIds[i]}, ${workspaceId}, 1,
          ${tx.json({ blocks: [{ type: "paragraph", content: "只有笔记没有目标" }] })},
          'fixture-hash', ${userId})`;
    }
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, noteIds, cleanup };
}
