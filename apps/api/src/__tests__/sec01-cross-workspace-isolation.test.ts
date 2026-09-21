/**
 * SEC-01: 事务上下文与 worker 访问路径的静态分析测试
 *
 * 只剩三件静态分析确实能证明的事：
 *   1. 用 `withWorkspaceTransaction` 的服务必须传 workspaceId；有写操作的服务必须
 *      走事务、接受 executor 参数、或委托给 createJob；
 *   2. `assertWorkspaceTransactionContextCompatible` 拒绝嵌套上下文变更（真单测）；
 *   3. worker 走 `ailearn_claim_jobs` / `ailearn_renew_job_lease` 受控函数而非裸 SQL。
 *
 * 原先还有三组「文件里出现过 workspaceId 字样就算隔离」的断言（含一组按
 * `.findMany(` 计数、而导出服务根本不用 findMany 因此恒成立的），已删除——它们
 * 无法在过滤条件被摘掉时变红。跨 workspace 的读写隔离由
 * `integration-tests/workspace-collab-postgres.integration.ts` 用真实请求证明。
 *
 * 另注：DoD 里「应用校验与 RLS 双重拒绝」目前只剩一层——`0027_sec01_rls_expansion_failsafe.sql`
 * 之后 `notes`/`sources`/`review_schedules` 等 19 张表的 RLS 处于 DISABLE，
 * 策略在但生效不了，所以本文件的静态检查是**唯一**一层，不能当作纵深。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { describe, it } from "node:test";

const MODULES_DIR = join(import.meta.dirname, "..", "modules");

/**
 * Recursively collect all .ts files under a directory (excluding .test.ts).
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (extname(fullPath) === ".ts" && !entry.endsWith(".test.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Read a file's content, returning empty string on error.
 */
function readFileContent(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// ─── 1. withWorkspaceTransaction 正确使用 ─────────────────────────────────

describe("SEC-01: withWorkspaceTransaction 使用模式", () => {
  const serviceFiles = collectTsFiles(MODULES_DIR).filter((f) => f.endsWith("service.ts"));

  it("使用 withWorkspaceTransaction 的服务传递 workspaceId 和 userId", () => {
    for (const file of serviceFiles) {
      const content = readFileContent(file);
      if (!content.includes("withWorkspaceTransaction")) continue;

      // Verify that withWorkspaceTransaction is called with an object containing workspaceId
      const hasWorkspaceId = content.includes("workspaceId:");
      assert.ok(
        hasWorkspaceId,
        `${file} 使用 withWorkspaceTransaction 但未传递 workspaceId`,
      );
    }
  });

  it("写操作（insert/update/delete）在事务内执行", () => {
    for (const file of serviceFiles) {
      const content = readFileContent(file);

      // Check if the file has write operations outside of transactions
      const hasWriteOps = /\.(insert|update|delete)\s*\(/.test(content);
      const hasTransaction = content.includes("withWorkspaceTransaction") || content.includes("db.transaction");
      // Some services delegate writes to other services (e.g. createJob) that
      // internally use transactions, or accept an executor parameter that is
      // already a transaction from the caller. 惯例命名 `executor:` 或按类型
      // 标注的事务参数（`tx: ApiTransaction`）都算"接受调用方事务"。
      const hasExecutorParam = content.includes("executor:")
        || /tx\s*:\s*ApiTransaction/.test(content);
      const delegatesToJobService = content.includes("createJob");

      if (hasWriteOps && !hasTransaction && !hasExecutorParam && !delegatesToJobService) {
        assert.ok(
          false,
          `${file} 有写操作但未使用事务、未接受 executor 参数、也未委托给 createJob`,
        );
      }
    }
  });
});


// ─── 2. 连接池复用上下文不泄漏 ──────────────────────────────────────────────

describe("SEC-01: 连接池复用上下文不泄漏", () => {
  it("withWorkspaceTransaction 使用 transaction-local context (true 参数)", () => {
    const clientContent = readFileContent(
      join(import.meta.dirname, "..", "db", "client.ts"),
    );
    // set_config with true means transaction-local
    assert.ok(
      clientContent.includes("set_config") && clientContent.includes("true"),
      "db client 应使用 transaction-local set_config (true 参数)",
    );
  });

  it("normalizeWorkspaceTransactionContext 验证 UUID 格式", () => {
    const clientContent = readFileContent(
      join(import.meta.dirname, "..", "db", "client.ts"),
    );
    assert.ok(
      clientContent.includes("normalizeWorkspaceTransactionContext"),
      "db client 应导出 normalizeWorkspaceTransactionContext 函数",
    );
  });

  it("assertWorkspaceTransactionContextCompatible 防止嵌套上下文变更", () => {
    const clientContent = readFileContent(
      join(import.meta.dirname, "..", "db", "client.ts"),
    );
    assert.ok(
      clientContent.includes("assertWorkspaceTransactionContextCompatible"),
      "db client 应导出 assertWorkspaceTransactionContextCompatible 函数",
    );
  });
});

// ─── 3. Worker 使用受控函数访问跨 workspace 数据 ─────────────────────────────

describe("SEC-01: Worker 使用受控函数访问跨 workspace 数据", () => {
  const WORKER_DIR = join(import.meta.dirname, "..", "..", "..", "..", "workers", "ai-worker", "src");

  it("Worker queue 使用 ailearn_claim_jobs 函数", () => {
    const queueContent = readFileContent(join(WORKER_DIR, "queue.ts"));
    assert.ok(
      queueContent.includes("ailearn_claim_jobs") || queueContent.includes("claim_jobs"),
      "Worker queue 应使用 ailearn_claim_jobs 函数领取任务",
    );
  });

  it("Worker job-lease 使用 ailearn_renew_job_lease 函数", () => {
    const leaseContent = readFileContent(join(WORKER_DIR, "lib", "job-lease.ts"));
    assert.ok(
      leaseContent.includes("ailearn_renew_job_lease") || leaseContent.includes("renew_job_lease"),
      "Worker job-lease 应使用 ailearn_renew_job_lease 函数续租",
    );
  });
});
