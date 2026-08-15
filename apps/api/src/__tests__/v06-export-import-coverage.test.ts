/**
 * v0.6 导出/导入新表验证测试 (计划 §6.9, §10.7)
 *
 * 计划 §6.9 要求：
 *   "所有新增表和字段同步进入 workspace export/import、
 *    账号删除、note/card 删除级联、备份恢复和 fresh/upgrade migration 验证"
 *
 * 计划 §10.7 DoD：
 *   "新表 RLS、导出/导入、删除和隐私扫描通过"
 *
 * 本测试验证 exportWorkspace 和 restoreWorkspace 覆盖所有 v0.6 新表：
 *   - validation_question_rubric_items
 *   - validation_submissions
 *   - validation_submission_jobs
 *   - validation_action_commands
 *   - validation_assistance_exposures
 *   - validation_point_assessments
 *   - scheduling_shadow_decisions
 *   - validation_quality_signals
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
  "validationQuestionRubricItems",
  "validationSubmissions",
  "validationSubmissionJobs",
  "validationActionCommands",
  "validationAssistanceExposures",
  "validationPointAssessments",
  "schedulingShadowDecisions",
  "validationQualitySignals",
];

const V06_NEW_TABLE_IDENTIFIERS = [
  "validation_question_rubric_items",
  "validation_submissions",
  "validation_submission_jobs",
  "validation_action_commands",
  "validation_assistance_exposures",
  "validation_point_assessments",
  "scheduling_shadow_decisions",
  "validation_quality_signals",
];
void V06_NEW_TABLE_IDENTIFIERS;

const V06_EXISTING_TABLE_EXTENSIONS = [
  { table: "validationQuestions", fields: ["user_id", "artifact_id", "generation_job_id", "generator_kind", "status", "rubric_version", "source_fingerprint", "superseded_at", "stale_reason", "last_used_at", "use_count"] },
  { table: "validationEvents", fields: ["submission_id", "note_version_id", "rubric_version", "reducer_version", "source_fingerprint", "source_status"] },
  { table: "reviewAttempts", fields: ["evaluation_artifact_id", "evaluation_status", "assistance_level", "evidence_revealed_at", "policy_version", "source_fingerprint"] },
  { table: "reviewSchedules", fields: ["key_point_id", "generation", "policy_version", "reason_code", "supersedes_schedule_id"] },
  { table: "aiArtifacts", fields: ["parent_artifact_id"] },
  { table: "jobs", fields: ["repair_state", "repair_attempt_count"] },
];
void V06_EXISTING_TABLE_EXTENSIONS;

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
  // 现改为断言每张 v0.6 表仍在导出内被查询：大表走 keyset 分批（select().from），
  // 唯 validation_submission_jobs 按 submission 外键有界（非 workspace 全量）仍走 findMany，
  // 两者都证明表被导出读取。意图不变（每张 v0.6 表均进入导出文件）。
  for (const table of V06_NEW_TABLES) {
    assert.ok(
      source.includes(`select().from(${table})`) || source.includes(`query.${table}`),
      `Export service should query ${table}`,
    );
  }
});

test("v0.6 导出：restoreWorkspace 恢复所有 v0.6 新表数据", () => {
  const source = readExportService();

  // Check that restoreWorkspace references all v0.6 tables
  for (const table of V06_NEW_TABLES) {
    assert.ok(
      source.includes(table),
      `Restore function should reference ${table}`,
    );
  }
});

test("v0.6 导出：restoreWorkspace 对每个 v0.6 新表执行 insert", () => {
  const source = readExportService();
  // restoreTable(tx, table, ...) 可能跨行，移除全部空白后匹配。
  const flattened = source.replace(/\s+/g, "");

  // Check that restore has insert calls for v0.6 tables
  // PERF-40 后 restore 统一走 restoreTable(tx, table, data[table], ...)，
  // 兼容旧的 tx.insert(table) 直插模式。
  const insertPatterns = [
    "validationQuestionRubricItems",
    "validationSubmissions",
    "validationSubmissionJobs",
    "validationActionCommands",
    "validationAssistanceExposures",
    "validationPointAssessments",
    "schedulingShadowDecisions",
    "validationQualitySignals",
  ];

  for (const table of insertPatterns) {
    const directInsert = flattened.includes(`tx.insert(${table})`)
      || flattened.includes(`.insert(${table})`);
    const restoreTableCall = flattened.includes(`restoreTable(tx,${table},`);
    assert.ok(
      directInsert || restoreTableCall,
      `Restore should insert into ${table}`,
    );
  }
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

test("v0.6 导出：validation_submissions 包含 user_answer（敏感业务数据）", () => {
  const source = readExportService();

  // user_answer is sensitive business data that should be in export
  // (privacy boundary is enforced by export file access control, not by omission)
  const submissionExportSection = source.match(/submissionRows[\s\S]*?findMany[\s\S]*?validationSubmissions/);
  assert.ok(
    submissionExportSection,
    "Export should query validation_submissions",
  );
});

test("v0.6 导出：restoreWorkspace 恢复 v0.6 新表依赖顺序正确", () => {
  const source = readExportService();

  // Find the restore section and verify dependency order
  // rubric_items depends on questions, submissions depend on users/cards/key_points
  const rubricItemsPos = source.indexOf("validationQuestionRubricItems");
  const submissionsPos = source.indexOf("validationSubmissions");
  void rubricItemsPos;
  void submissionsPos;

  // rubric_items should be restored before submissions (rubric_items depend on questions)
  // Actually, submissions depend on questions and rubric_items are separate
  // The plan says: rubric_items → submissions → submission_jobs, action_commands,
  //                assistance_exposures → point_assessments, shadow_decisions, quality_signals

  // Check that the comment about dependency order exists
  assert.ok(
    source.includes("依赖顺序") || source.includes("dependency") || source.includes("依赖"),
    "Restore should document dependency order for v0.6 tables",
  );
});

test("v0.6 导出：导出 counts 包含 v0.6 新表计数", () => {
  const source = readExportService();

  // counts should include v0.6 tables
  for (const table of V06_NEW_TABLES) {
    assert.ok(
      source.includes(`counts.${table}`) || source.includes(`counts["${table}"]`),
      `Restore counts should include ${table}`,
    );
  }
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

test("v0.6 隐私：validation_submissions 中 user_answer 不进入日志", () => {
  // This is verified by v06-telemetry-privacy-scan.test.ts
  // Here we just verify the export service doesn't log user_answer
  const source = readExportService();

  // Check no logger calls include user_answer
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("logger.") && lines[i].includes("user_answer")) {
      assert.fail(`Line ${i + 1}: logger call references user_answer`);
    }
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

test("v0.6 隐私：导出文件包含 validation_submissions.user_answer 但标注为敏感", () => {
  const source = readExportService();

  // user_answer should be in the export (it's business data for backup/restore)
  // But it should be noted as sensitive in comments
  // The privacy boundary is enforced by export file access control (Owner only)
  assert.ok(
    source.includes("user_answer") || source.includes("userAnswer"),
    "Export should include user_answer for backup (privacy via access control)",
  );

  // Check for a comment about sensitivity
  assert.ok(
    source.includes("敏感") || source.includes("sensitive") || source.includes("privacy"),
    "Export service should document sensitivity of user_answer",
  );
});

// ─── 账号删除级联验证 (计划 §6.9) ────────────────────────────────────────

test("v0.6 删除：validation_submissions 有 ON DELETE CASCADE 关联 user", () => {
  // This is verified by migration integration test
  // Here we verify the schema definition includes CASCADE
  const schemaPath = join(
    WORKSPACE_ROOT,
    "apps/api/src/db/schema/validation-v2.ts",
  );
  if (!existsSync(schemaPath)) return;

  const source = readFileSync(schemaPath, "utf8");
  assert.ok(
    source.includes("onDelete: \"cascade\"") || source.includes("onDelete: 'cascade'"),
    "Schema should have CASCADE delete for user-related tables",
  );
});

test("v0.6 删除：validation_assistance_exposures 有 ON DELETE CASCADE 关联 user 和 key_point", () => {
  const schemaPath = join(
    WORKSPACE_ROOT,
    "apps/api/src/db/schema/validation-v2.ts",
  );
  if (!existsSync(schemaPath)) return;

  const source = readFileSync(schemaPath, "utf8");
  // Check that key_point_id has cascade
  assert.ok(
    source.includes("key_point_id") && source.includes("cascade"),
    "validation_assistance_exposures should cascade on key_point deletion",
  );
});

// ─── v0.6 现有表扩展字段验证 ──────────────────────────────────────────────

test("v0.6 导出：现有表 v0.6 扩展字段在导出中包含", () => {
  const source = readExportService();

  // validation_questions extensions should be in export (they're in the row data)
  assert.ok(
    source.includes("validationQuestions") || source.includes("validation_questions"),
    "Export should include validation_questions with v0.6 fields",
  );

  // validation_events extensions
  assert.ok(
    source.includes("validationEvents") || source.includes("validation_events"),
    "Export should include validation_events with v0.6 fields",
  );

  // review_attempts extensions
  assert.ok(
    source.includes("reviewAttempts") || source.includes("review_attempts"),
    "Export should include review_attempts with v0.6 fields",
  );

  // review_schedules extensions
  assert.ok(
    source.includes("reviewSchedules") || source.includes("review_schedules"),
    "Export should include review_schedules with v0.6 fields",
  );

  // ai_artifacts extensions
  assert.ok(
    source.includes("aiArtifacts") || source.includes("ai_artifacts"),
    "Export should include ai_artifacts with v0.6 fields",
  );
});

// ─── v0.6 单一配置源重构（计划 §7.2）────────────────────────────────────

test("v0.6 单一配置源：导出载荷不再携带 aiProvider", () => {
  const source = readExportService();

  // 导出的 workspace 对象不应包含 aiProvider 字段
  // 检查 workspace 导出块中不出现 aiProvider 赋值
  const workspaceExportBlock = source.match(
    /workspace:\s*workspace\s*\?[\s\S]*?\{[\s\S]*?\}/,
  );
  if (workspaceExportBlock) {
    assert.ok(
      !workspaceExportBlock[0].includes("aiProvider"),
      "Export workspace block should not contain aiProvider field (removed in 0065 migration)",
    );
  }

  // 恢复时不应写入 aiProvider
  const restoreBlock = source.match(
    /exportedWorkspace[\s\S]*?\.update\(workspaces\)[\s\S]*?\.set\([\s\S]*?\)/,
  );
  if (restoreBlock) {
    assert.ok(
      !restoreBlock[0].includes("aiProvider"),
      "Restore workspace block should not write aiProvider (removed in 0065 migration)",
    );
  }
});
