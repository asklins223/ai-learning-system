/**
 * v0.6 导出新表验证测试 (计划 §6.9, §10.7)
 *
 * 计划 §6.9 要求：
 *   "所有新增表和字段同步进入 workspace export、
 *    账号删除、note/card 删除级联和 fresh/upgrade migration 验证"
 *
 * 计划 §10.7 DoD：
 *   "新表 RLS、导出、删除和隐私扫描通过"
 *
 * 本测试验证 exportWorkspace 覆盖当前仍使用的冷却账本：
 *   - validation_assistance_exposures
 *   以及现有表 v0.6 字段扩展
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Path resolution: relative to this test file ─────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Navigate from src/__tests__/ up to workspace root
const WORKSPACE_ROOT = join(__dirname, "../../../..");

// ─── Helper: Read export service source ───────────────────────────────────

function readExportService(): string {
  const exportPath = join(
    WORKSPACE_ROOT,
    "apps/api/src/modules/export/service.ts",
  );
  if (!existsSync(exportPath)) {
    throw new Error(`Export service not found at ${exportPath}`);
  }
  return readFileSync(exportPath, "utf8");
}

// ─── v0.6 新表列表 (计划 §6.9) ───────────────────────────────────────────

const V06_NEW_TABLES = [
  "validationAssistanceExposures",
];

const V2_EVIDENCE_EXPORTS = [
  "evidenceSnapshotsV2",
  "evidenceRedactionsV2",
  "semanticSupportReportsV2",
  "learningObjectiveEvidenceBindingsV2",
  "evidenceEligibilityStatesV2",
] as const;
// ─── Tests ────────────────────────────────────────────────────────────────

test("v0.6 导出：exportWorkspace 导出所有 v0.6 新表数据", () => {
  const source = readExportService();

  for (const table of V06_NEW_TABLES) {
    assert.ok(
      source.includes(table),
      `Export service should reference ${table}`,
    );
  }
});

test("v0.6 导出：exportManifest 包含所有 v0.6 新表", () => {
  const source = readExportService();

  // Check exportManifest.included array contains all v0.6 tables
  const manifestSection = source.match(/included:\s*\[([\s\S]*?)\]/);
  assert.ok(manifestSection, "Export service should have exportManifest.included");

  const manifestContent = manifestSection![1];
  for (const table of V06_NEW_TABLES) {
    assert.ok(
      manifestContent.includes(`"${table}"`),
      `exportManifest.included should contain "${table}"`,
    );
  }
});

test("v0.6 导出：exportWorkspace 查询所有 v0.6 新表", () => {
  const source = readExportService();

  // B#1（round-5 审计）：导出查询已从 `tx.query.X.findMany` 全量加载改为 keyset 分批
  // `tx.select().from(X)...limit(batch)`（见 modules/export/service.ts）。原断言检查
  // `tx.query.${table}`/`.query.${table}` 是旧全量 findMany 机制的实现细节，随 B#1 失效。
  // 现改为断言每张仍在用的 v0.6 表仍在导出内被查询：大表走 keyset 分批。
  for (const table of V06_NEW_TABLES) {
    assert.ok(
      source.includes(`select().from(${table})`) || source.includes(`query.${table}`),
      `Export service should query ${table}`,
    );
  }
});

test("V2 evidence 导出：不再读取已删除的 V1 evidences 表", () => {
  const source = readExportService();

  for (const table of V2_EVIDENCE_EXPORTS) {
    assert.ok(source.includes(table), `Export service should reference ${table}`);
  }
  assert.doesNotMatch(source, /from\(evidences\)|from\(evidenceOverrides\)/);
  assert.doesNotMatch(source, /["']evidences["']|["']evidenceOverrides["']/);
});

test("v0.6 导出：导出文件不包含密码哈希", () => {
  const source = readExportService();

  // passwordHash should not be in the export
  const userExportSection = source.match(/users:\s*userRows\.map[\s\S]*?\)/);
  if (userExportSection) {
    assert.ok(
      !userExportSection[0].includes("passwordHash"),
      "Export should NOT include passwordHash",
    );
  }
});

test("v0.6 导出：导出文件不包含敏感会话数据", () => {
  const source = readExportService();

  // excluded list should mention sessions
  const excludedSection = source.match(/excluded:\s*\{([\s\S]*?)\}/);
  if (excludedSection) {
    assert.ok(
      excludedSection[1].includes("sessions"),
      "Export manifest should exclude sessions",
    );
    assert.ok(
      excludedSection[1].includes("passwordHashes") || excludedSection[1].includes("password"),
      "Export manifest should exclude password hashes",
    );
    assert.ok(
      excludedSection[1].includes("inviteCodes") || excludedSection[1].includes("invite"),
      "Export manifest should exclude invite codes",
    );
  }
});

test("v0.6 导出：导出文件版本号为 2.0", () => {
  const source = readExportService();

  assert.ok(
    source.includes('version: "2.0"'),
    "Export manifest version should be 2.0",
  );
});

// ─── 隐私扫描测试 (计划 §4.1, §6.9) ───────────────────────────────────────

test("v0.6 隐私：exportWorkspace 不导出 jobs 表（运行态）", () => {
  const source = readExportService();

  // jobs should be in excluded, not in the actual export queries
  const excludedSection = source.match(/excluded:\s*\{([\s\S]*?)\}/);
  if (excludedSection) {
    assert.ok(
      excludedSection[1].includes("jobs"),
      "Export manifest should exclude jobs (runtime state)",
    );
  }
});

test("v0.6 隐私：exportWorkspace 不导出 aiAuditLog（运行态）", () => {
  const source = readExportService();

  const excludedSection = source.match(/excluded:\s*\{([\s\S]*?)\}/);
  if (excludedSection) {
    assert.ok(
      excludedSection[1].includes("aiAuditLog") || excludedSection[1].includes("audit"),
      "Export manifest should exclude AI audit logs",
    );
  }
});

test("v0.6 隐私：exportWorkspace 不导出 searchDocuments（可重建）", () => {
  const source = readExportService();

  const excludedSection = source.match(/excluded:\s*\{([\s\S]*?)\}/);
  if (excludedSection) {
    assert.ok(
      excludedSection[1].includes("searchDocuments") || excludedSection[1].includes("search"),
      "Export manifest should exclude search documents (rebuildable)",
    );
  }
});

// ─── 账号删除级联验证 (计划 §6.9) ────────────────────────────────────────

test("v0.6 删除：validation_assistance_exposures 有 ON DELETE CASCADE 关联 user 和 key_point", () => {
  const schemaPath = join(
    WORKSPACE_ROOT,
    "packages/shared/src/db-schema/validation-v2.ts",
  );
  if (!existsSync(schemaPath)) return;

  const source = readFileSync(schemaPath, "utf8");
  // 0176 将 key_point_id 改指 V2 objective_id；该 NOT NULL 列仍是当前
  // assistance cooldown 的业务维度，不能从 ORM 映射中遗漏。
  assert.ok(
    source.includes('userId: uuid("user_id")') && source.includes("onDelete: \"cascade\""),
    "validation_assistance_exposures should cascade on user deletion",
  );
  assert.ok(source.includes('keyPointId: uuid("key_point_id")'));
});

// ─── 当前复习/证据字段验证 ────────────────────────────────────────────────

test("当前导出包含复习计划和 AI artifact", () => {
  const source = readExportService();
  assert.ok(
    source.includes("reviewSchedules") || source.includes("review_schedules"),
    "Export should include review_schedules",
  );
  assert.ok(
    source.includes("aiArtifacts") || source.includes("ai_artifacts"),
    "Export should include ai_artifacts",
  );
});
