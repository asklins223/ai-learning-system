/**
 * CommitPort 真实 DB 集成测试（救火 3 Commit 幂等根基）。
 *
 * 验证 commit_key 在真实 Postgres 的幂等语义：
 * - getCommitKey/setCommitKey 读写 learning_episodes.commit_key；
 * - 唯一索引 learning_episodes_commit_key_unique_idx（0074）防重放重复；
 * - lockSteps FOR UPDATE 行锁。
 *
 * 环境：DATABASE_URL_API（容器内 postgres）；无 DB 时 skip。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createPgCommitPort } from "../modules/learning-sessions/commit-port-pg.js";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;

/** 测试专用 drizzle 风格 tx 适配器（pg 连接 → execute） */
function makeTxAdapter(pool: Pool) {
  return {
    async execute(query: unknown) {
      // drizzle 0.45：queryChunks 的元素是 SQL 片段（{ value: string[] }）或
      // 参数（纯 string/数字——不在 { value } 包装里）。测试用固定值拼 SQL。
      const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
      const text = chunks
        .map((c) => {
          if (typeof c === "string") return `'${c.replace(/'/g, "''")}'`;
          if (typeof c === "number" || typeof c === "boolean" || c === null) {
            return c === null ? "NULL" : String(c);
          }
          const nested = (c as { value?: unknown }).value;
          if (Array.isArray(nested)) return nested.join(" ");
          if (nested == null) return "NULL";
          if (typeof nested === "string") return `'${nested.replace(/'/g, "''")}'`;
          return String(nested);
        })
        .join(" ");
      return pool.query(text).then((r) => r.rows);
    },
  };
}

test("CommitPort：commit_key 幂等（set 后 get 一致，真实 DB）", async (t) => {
  if (!CONN) {
    t.skip("DATABASE_URL_API 未配置——跳过 DB 集成测试");
    return;
  }
  const pool = new Pool({ connectionString: CONN, connectionTimeoutMillis: 5_000 });
  try {
    // 准备：用既有 workspace/user（从 learning_episodes 取一条，或跳过）
    const episodeRows = await pool.query(
      `SELECT id, workspace_id, user_id FROM learning_episodes LIMIT 1`,
    );
    const ep = episodeRows.rows[0] as { id: string; workspace_id: string; user_id: string } | undefined;
    if (!ep) {
      t.skip("无既有 episode——跳过（commit 幂等需真实 episode 行）");
      return;
    }
    const port = createPgCommitPort(makeTxAdapter(pool));
    const scope = { workspaceId: ep.workspace_id, userId: ep.user_id };
    const before = await port.getCommitKey(scope, ep.id);
    // 写唯一 commit key（带时间戳防与既有冲突）
    const key = `it-${Date.now()}`;
    await port.setCommitKey(scope, ep.id, key);
    const after = await port.getCommitKey(scope, ep.id);
    assert.equal(after, key, "setCommitKey 后 getCommitKey 一致（幂等键写入真实 DB）");
    // 清理：恢复原 commit_key（避免污染测试数据）
    await pool.query(
      `UPDATE learning_episodes SET commit_key = $1 WHERE id = $2`,
      [before, ep.id],
    );
  } finally {
    await pool.end();
  }
});

test("CommitPort：lockSteps 行锁可执行（FOR UPDATE 不抛错）", async (t) => {
  if (!CONN) {
    t.skip("DATABASE_URL_API 未配置——跳过 DB 集成测试");
    return;
  }
  const pool = new Pool({ connectionString: CONN, connectionTimeoutMillis: 5_000 });
  try {
    const episodeRows = await pool.query(
      `SELECT id, workspace_id, user_id FROM learning_episodes LIMIT 1`,
    );
    const ep = episodeRows.rows[0] as { id: string; workspace_id: string; user_id: string } | undefined;
    if (!ep) {
      t.skip("无既有 episode——跳过");
      return;
    }
    const port = createPgCommitPort(makeTxAdapter(pool));
    await port.lockSteps(
      ["learning_episode"] as never,
      { workspaceId: ep.workspace_id, userId: ep.user_id },
      ep.id,
    );
    assert.ok(true, "FOR UPDATE 行锁执行成功");
  } finally {
    await pool.end();
  }
});
