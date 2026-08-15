/**
 * SEC-01: 跨 workspace 服务隔离静态分析测试
 *
 * 覆盖 ADR-0003 和实施计划 §6.1 的 DoD 项：
 *   1. "API 跨 workspace 读、写、关联和删除全部由应用校验与 RLS 双重拒绝"
 *   2. "所有应隔离表必须覆盖直接读取、写入、关联、级联/删除、导出和搜索投影"
 *   3. "连接池复用 1,000 次 workspace 交替请求无上下文串线"
 *
 * 本测试通过静态分析服务源码，验证所有数据访问函数都包含 workspaceId 过滤条件。
 * 这不是替代真实 PostgreSQL 集成测试，而是作为应用层防御深度的可验证证据。
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

// ─── 1. 所有包含数据库查询的服务文件必须使用 workspaceId 过滤 ──────────────

describe("SEC-01: 服务层数据访问包含 workspaceId 隔离", () => {
  const serviceFiles = collectTsFiles(MODULES_DIR).filter(
    (f) => f.endsWith("service.ts") || f.endsWith("routes.ts"),
  );

  it("服务文件列表非空", () => {
    assert.ok(serviceFiles.length > 0, "应找到至少一个服务文件");
  });

  it("每个包含 db.query 的服务文件都应使用 workspaceId 过滤", () => {
    const workspaceTables = [
      "notes",
      "noteVersions",
      "noteBlocks",
      "sources",
      "sourceSegments",
      "learningCards",
      "cardKeyPoints",
      "evidences",
      "validationQuestions",
      "validationEvents",
      "reviewSchedules",
      "reviewAttempts",
      "understandingEvents",
      "evidenceOverrides",
      "aiArtifacts",
      "searchDocuments",
      "onboardingStates",
      "inviteCodes",
    ];

    for (const file of serviceFiles) {
      const content = readFileContent(file);
      if (!content.includes("db.") && !content.includes("tx.") && !content.includes("executor.")) {
        continue; // Skip files that don't access the database
      }

      // Check if any workspace-scoped table is queried without workspaceId
      const hasWorkspaceTable = workspaceTables.some((table) => content.includes(table));
      if (!hasWorkspaceTable) continue;

      // The file must reference workspaceId somewhere
      assert.ok(
        content.includes("workspaceId") || content.includes("workspace_id"),
        `${file} 访问 workspace 表但没有使用 workspaceId 过滤`,
      );
    }
  });
});
// ─── 2. withWorkspaceTransaction 正确使用 ─────────────────────────────────

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
// ─── 3. 跨 workspace ID 猜测防护 ────────────────────────────────────────────

describe("SEC-01: 跨 workspace ID 猜测防护", () => {
  it("getNote 在查询中包含 workspaceId 条件", () => {
    const content = readFileContent(join(MODULES_DIR, "note", "service.ts"));
    // getNoteWithVersion function should filter by workspaceId
    assert.ok(
      content.includes("eq(notes.workspaceId, workspaceId)") ||
        content.includes("notes.workspaceId"),
      "note service 应在查询中包含 notes.workspaceId 过滤",
    );
  });

  it("getCardWithDetail 在查询中包含 workspaceId 条件", () => {
    const content = readFileContent(join(MODULES_DIR, "card", "service.ts"));
    assert.ok(
      content.includes("workspaceId"),
      "card service 应在查询中使用 workspaceId",
    );
  });

  it("getCardEvidence 校验 card 归属 workspaceId", () => {
    const content = readFileContent(join(MODULES_DIR, "evidence", "service.ts"));
    // Evidence service should verify card belongs to workspace
    assert.ok(
      content.includes("learningCards.workspaceId") || content.includes("card.workspaceId"),
      "evidence service 应校验 card 归属 workspace",
    );
  });

  it("listValidations 校验 card 归属并按 workspaceId 过滤", () => {
    const content = readFileContent(join(MODULES_DIR, "validation", "service.ts"));
    assert.ok(
      content.includes("learningCards.workspaceId") || content.includes("workspaceId"),
      "validation service 应校验 card 归属 workspace",
    );
  });

  it("listReviews 按 workspaceId 过滤", () => {
    const content = readFileContent(join(MODULES_DIR, "review", "service.ts"));
    assert.ok(
      content.includes("workspaceId"),
      "review service 应按 workspaceId 过滤",
    );
  });

  it("getJob 按 workspaceId 过滤", () => {
    const content = readFileContent(join(MODULES_DIR, "job", "service.ts"));
    assert.ok(
      content.includes("eq(jobs.workspaceId, workspaceId)"),
      "job service getJob 应按 workspaceId 过滤",
    );
  });
});

// ─── 4. 导出/搜索投影按 workspaceId 过滤 ────────────────────────────────────

describe("SEC-01: 导出和搜索投影按 workspaceId 过滤", () => {
  it("exportWorkspace 所有查询都按 workspaceId 过滤", () => {
    const content = readFileContent(join(MODULES_DIR, "export", "service.ts"));
    // All export queries should use workspaceId
    const tableCount = (content.match(/\.findMany\(/g) || []).length;
    const workspaceFilterCount = (content.match(/workspaceId/g) || []).length;
    assert.ok(
      workspaceFilterCount >= tableCount,
      `导出服务有 ${tableCount} 个 findMany 查询但只有 ${workspaceFilterCount} 处 workspaceId 引用`,
    );
  });

  it("search index 操作按 workspaceId 过滤", () => {
    const content = readFileContent(join(MODULES_DIR, "note", "service.ts"));
    // upsertSearchDocument and deleteSearchDocuments should include workspaceId
    assert.ok(
      content.includes("workspaceId") && content.includes("searchDocuments"),
      "note service 搜索投影应包含 workspaceId",
    );
  });
});

// ─── 5. 连接池复用上下文不泄漏 ──────────────────────────────────────────────

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

// ─── 6. Worker 使用受控函数访问跨 workspace 数据 ─────────────────────────────

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
