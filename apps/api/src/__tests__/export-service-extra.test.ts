/**
 * export/service.ts 补充测试
 *
 * 覆盖 restoreWorkspace 的验证逻辑、dry-run 模式、
 * 引用完整性校验和错误处理路径。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreWorkspace } from "../modules/export/service.ts";

type RestoreDatabase = NonNullable<Parameters<typeof restoreWorkspace>[3]>;

function createEmptyMockDatabase(): RestoreDatabase {
  const tx = {
    insert() {
      return {
        values(data: any) {
          const returning = () => Promise.resolve(data ? [data] : [{ id: "mock-insert-id" }]);
          const onConflict = () => ({
            returning,
            then: (resolve: any) => Promise.resolve(undefined).then(resolve),
          });
          return {
            returning,
            onConflictDoNothing: onConflict,
            then: (resolve: any) => Promise.resolve(undefined).then(resolve),
          };
        },
      };
    },
    update() {
      return {
        set() {
          return { async where() {} };
        },
      };
    },
  };
  return {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      // V2 卡片表：V1 learning_cards 已退役，服务用 learningCardsV2 检测冲突
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction(callback: (t: typeof tx) => Promise<unknown>) {
      return callback(tx);
    },
  } as unknown as RestoreDatabase;
}

function createConflictMockDatabase(): RestoreDatabase {
  const tx = {
    insert() {
      return {
        values(data: any) {
          const returning = () => Promise.resolve(data ? [data] : [{ id: "mock-insert-id" }]);
          const onConflict = () => ({
            returning,
            then: (resolve: any) => Promise.resolve(undefined).then(resolve),
          });
          return {
            returning,
            onConflictDoNothing: onConflict,
            then: (resolve: any) => Promise.resolve(undefined).then(resolve),
          };
        },
      };
    },
    update() {
      return {
        set() {
          return { async where() {} };
        },
      };
    },
  };
  return {
    query: {
      notes: { async findMany() { return [{ id: "existing" }]; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction(callback: (t: typeof tx) => Promise<unknown>) {
      return callback(tx);
    },
  } as unknown as RestoreDatabase;
}

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";

function validExportData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace: { id: "source-workspace", name: "测试", ownerId: USER_ID },
    exportManifest: {
      version: "2.0",
      included: [
        "workspace", "users", "workspaceMembers", "notes", "noteVersions",
        "noteBlocks", "sources", "sourceSegments", "evidences",
        "evidenceOverrides", "validationQuestions", "validationEvents",
        "reviewSchedules", "reviewAttempts", "understandingEvents",
        "aiArtifacts", "onboardingStates",
      ],
      excluded: {
        searchDocuments: "可重建",
        benchmarkReports: "运行态",
        benchmarkLabels: "运行态",
        jobs: "运行态",
        sessions: "安全敏感",
        passwordHashes: "安全敏感",
        aiAuditLog: "运行态",
        inviteCodes: "安全敏感",
      },
      notes: [],
    },
    users: [{ id: USER_ID, email: "test@example.com", role: "owner" }],
    workspaceMembers: [],
    notes: [],
    noteVersions: [],
    noteBlocks: [],
    sources: [],
    sourceSegments: [],
    evidences: [],
    evidenceOverrides: [],
    validationQuestions: [],
    validationEvents: [],
    reviewSchedules: [],
    reviewAttempts: [],
    understandingEvents: [],
    aiArtifacts: [],
    onboardingStates: [],
    ...overrides,
  };
}

// ─── 输入验证 ────────────────────────────────────────────────────────────

test("restoreWorkspace 缺少 workspace 字段时返回失败", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    { exportManifest: { version: "2.0" } },
    false,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("workspace"));
});

test("restoreWorkspace 缺少 exportManifest 字段时返回失败", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    { workspace: { id: "ws" } },
    false,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("exportManifest"));
});

test("restoreWorkspace manifest 版本不是 2.0 时返回失败", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData({ exportManifest: { version: "1.0" } }),
    false,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("版本"));
});

test("restoreWorkspace manifest 版本为 3.0 时返回失败", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData({ exportManifest: { version: "3.0" } }),
    false,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
});

// ─── 冲突检测 ────────────────────────────────────────────────────────────

test("restoreWorkspace 目标已有 notes 时返回冲突", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    createConflictMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("已有数据") || result.message.includes("合并"));
});

// ─── Dry-run 模式 ────────────────────────────────────────────────────────

test("dry-run 模式返回计数但不写入", async () => {
  const data = validExportData({
    users: [
      { id: USER_ID, email: "a@test.com", role: "owner" },
      { id: "30000000-0000-4000-8000-000000000001", email: "b@test.com", role: "member" },
    ],
    notes: [
      { id: "n1", title: "笔记1", titleSource: "auto", currentVersionId: null, sourceId: null, createdBy: USER_ID },
    ],
    sources: [
      { id: "s1", type: "text", title: "来源1", origin: null, status: "ready", metadata: {}, createdBy: USER_ID },
    ],
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.ok(result.counts);
  assert.equal(result.counts!.users, 2);
  assert.equal(result.counts!.notes, 1);
  assert.equal(result.counts!.sources, 1);
});

test("dry-run 模式空数据返回零计数", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.counts!.users, 1);
  assert.equal(result.counts!.notes, 0);
  assert.equal(result.counts!.sources, 0);
  assert.equal(result.counts!.reviewAttempts, 0);
});

// ─── Dry-run 引用完整性校验 ──────────────────────────────────────────────

test("dry-run 检测到 evidence_override 引用不存在的 evidence 时失败", async () => {
  const data = validExportData({
    evidenceOverrides: [
      { id: "eo1", evidenceId: "nonexistent-evidence", userId: USER_ID, alignment: "aligned" },
    ],
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("引用完整性") || result.message.includes("missing evidence"));
});

// ── V1 退役：以下两个用例整体只测已删的 V1 恢复行为 ──
// validation_event / validation_question 的 cardId 列已随 V1 卡表删除，
// dry-run 引用完整性校验不再检查 card/keyPoint 引用（服务只校验 questionId）。
// 故删除这两个「引用不存在的 card 时失败」的 V1 用例。

test("dry-run 引用完整性通过时返回成功", async () => {
  const qId = "60000000-0000-4000-8000-000000000001";
  const data = validExportData({
    validationQuestions: [
      { id: qId, questionType: "explain", question: "Q?" },
    ],
    validationEvents: [
      { id: "ve1", userId: USER_ID, artifactId: null, question: "Q?", questionType: "explain", userAnswer: "A", outcome: "preliminary_understanding", confidence: 80, jobId: null, questionId: qId },
    ],
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
});

test("dry-run 多个引用完整性错误时截断显示前5个", async () => {
  const data = validExportData({
    evidenceOverrides: Array.from({ length: 7 }, (_, i) => ({
      id: `eo${i}`,
      evidenceId: `nonexistent-${i}`,
      userId: USER_ID,
      alignment: "aligned",
    })),
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("共 7"));
});

// ─── 导出清单结构验证 ────────────────────────────────────────────────────

test("导出清单包含所有 LOOP-01/02 必需表", () => {
  const manifest = validExportData().exportManifest as Record<string, unknown>;
  const included = manifest.included as string[];
  assert.ok(included.includes("reviewAttempts"), "reviewAttempts 必须在导出清单中");
  assert.ok(included.includes("reviewSchedules"));
  assert.ok(included.includes("validationEvents"));
  assert.ok(included.includes("understandingEvents"));
});

test("导出清单排除安全敏感数据", () => {
  const manifest = validExportData().exportManifest as Record<string, unknown>;
  const excluded = manifest.excluded as Record<string, string>;
  assert.ok(excluded.passwordHashes, "passwordHashes 应被排除");
  assert.ok(excluded.sessions, "sessions 应被排除");
  assert.ok(excluded.inviteCodes, "inviteCodes 应被排除");
});

test("导出清单版本为 2.0", () => {
  const manifest = validExportData().exportManifest as Record<string, unknown>;
  assert.equal(manifest.version, "2.0");
});

// ─── 非 dry-run 恢复路径 ──────────────────────────────────────────────────

test("非 dry-run 恢复成功时返回 counts 和成功消息", async () => {
  const data = validExportData({
    users: [{ id: USER_ID, email: "restore@test.com", role: "owner" }],
    workspaceMembers: [
      { userId: USER_ID, role: "owner", joinedAt: "2026-07-18T00:00:00.000Z" },
    ],
    notes: [
      { id: "n1", title: "笔记", titleSource: "auto", currentVersionId: null, sourceId: null, createdBy: USER_ID },
    ],
    sources: [
      { id: "s1", type: "text", title: "来源", origin: null, status: "ready", metadata: {}, createdBy: USER_ID },
    ],
    reviewAttempts: [
      {
        id: "ra1", userId: USER_ID, reviewScheduleId: "rs1",
        subjectType: "card", subjectId: "c1",
        validationEventId: null, validationQuestionId: null,
        keyPointId: null, evidenceId: null, noteVersionId: null,
        answerType: "recall", answerText: "答案", outcome: "correct",
        confidence: 90, skipReason: null,
        scheduleBeforeIntervalDays: 1, scheduleAfterIntervalDays: 3,
        scheduleReasonCode: "correct_advance", understandingEffect: "upgrade",
        nextReviewAt: "2026-07-21T00:00:00.000Z", idempotencyKey: "k1",
        status: "completed", startedAt: "2026-07-18T00:00:00.000Z",
        completedAt: "2026-07-18T00:01:00.000Z",
        createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:01:00.000Z",
      },
    ],
    onboardingStates: [
      { id: "os1", userId: USER_ID, version: "v1", steps: { ai_consent: true }, status: "in_progress" },
    ],
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    false,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
  assert.equal(result.dryRun, undefined);
  assert.ok(result.counts);
  assert.equal(result.counts!.users, 1);
  assert.equal(result.counts!.workspaceMembers, 1);
  assert.equal(result.counts!.notes, 1);
  assert.equal(result.counts!.sources, 1);
  assert.equal(result.counts!.reviewAttempts, 1);
  assert.equal(result.counts!.onboardingStates, 1);
  assert.ok(result.message.includes("恢复成功"));
});

test("非 dry-run 恢复事务失败时返回错误", async () => {
  const failingDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction() {
      throw new Error("connection lost");
    },
  } as unknown as RestoreDatabase;

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    failingDb,
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("恢复失败"));
});

test("非 dry-run 恢复空数据返回零计数但成功", async () => {
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
  assert.ok(result.counts);
  // Empty arrays are still arrays, so counts are set to 0
  assert.equal(result.counts!.users, 1); // validExportData has 1 user
  assert.equal(result.counts!.notes, 0);
  assert.equal(result.counts!.sources, 0);
});

test("非 dry-run 恢复 note 带 currentVersionId 时执行 update 回填", async () => {
  const versionId = "40000000-0000-4000-8000-000000000001";
  const updates: Record<string, unknown>[] = [];
  const recordingDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        insert() {
          return {
            values(vals: Record<string, unknown>) {
              const returning = () => Promise.resolve([vals ?? { id: "mock-id" }]);
              const onConflict = () => ({
                returning,
                then: (resolve: any) => Promise.resolve(undefined).then(resolve),
              });
              return {
                returning,
                onConflictDoNothing: onConflict,
                then: (resolve: any) => Promise.resolve(undefined).then(resolve),
              };
            },
          };
        },
        update() {
          return {
            set(values: Record<string, unknown>) {
              return {
                async where() {
                  updates.push(values);
                },
              };
            },
          };
        },
      };
      return callback(tx as never);
    },
  } as unknown as RestoreDatabase;

  const data = validExportData({
    notes: [
      {
        id: "n1", title: "笔记", titleSource: "auto",
        currentVersionId: versionId, sourceId: null, createdBy: USER_ID,
      },
    ],
    noteVersions: [
      { id: versionId, noteId: "n1", versionNo: 1, contentJson: {}, createdBy: USER_ID },
    ],
  });

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    false,
    recordingDb,
  );
  assert.equal(result.success, true);
  // The update should have been called with currentVersionId
  const noteUpdate = updates.find((u) => "currentVersionId" in u);
  assert.ok(noteUpdate, "应执行 update 回填 currentVersionId");
  assert.equal(noteUpdate!.currentVersionId, versionId);
});

test("非 dry-run 恢复 note 不带 currentVersionId 时不执行 update", async () => {
  const updates: Record<string, unknown>[] = [];
  const recordingDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        insert() {
          return {
            values(vals: Record<string, unknown>) {
              const returning = () => Promise.resolve([vals ?? { id: "mock-id" }]);
              const onConflict = () => ({
                returning,
                then: (resolve: any) => Promise.resolve(undefined).then(resolve),
              });
              return {
                returning,
                onConflictDoNothing: onConflict,
                then: (resolve: any) => Promise.resolve(undefined).then(resolve),
              };
            },
          };
        },
        update() {
          return {
            set(values: Record<string, unknown>) {
              return {
                async where() {
                  updates.push(values);
                },
              };
            },
          };
        },
      };
      return callback(tx as never);
    },
  } as unknown as RestoreDatabase;

  const data = validExportData({
    notes: [
      {
        id: "n1", title: "笔记", titleSource: "auto",
        currentVersionId: null, sourceId: null, createdBy: USER_ID,
      },
    ],
  });

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    false,
    recordingDb,
  );
  assert.equal(result.success, true);
  // No update should have currentVersionId since the note doesn't have one
  const noteUpdate = updates.find((u) => "currentVersionId" in u);
  assert.equal(noteUpdate, undefined);
});

// ─── dry-run 全字段计数验证 ────────────────────────────────────────────────

test("dry-run 正确统计所有数据类型计数", async () => {
  const data = validExportData({
    users: [
      { id: USER_ID, email: "a@test.com", role: "owner" },
      { id: "u2", email: "b@test.com", role: "member" },
    ],
    workspaceMembers: [
      { userId: USER_ID, role: "owner" },
      { userId: "u2", role: "member" },
    ],
    notes: [{ id: "n1", title: "N", titleSource: "auto", currentVersionId: null, sourceId: null, createdBy: USER_ID }],
    noteVersions: [{ id: "nv1", noteId: "n1", versionNo: 1, contentJson: {}, createdBy: USER_ID }],
    noteBlocks: [{ id: "nb1", versionId: "nv1", ordinal: 0, type: "paragraph", content: "text" }],
    sources: [{ id: "s1", type: "text", title: "S", origin: null, status: "ready", metadata: {}, createdBy: USER_ID }],
    sourceSegments: [{ id: "ss1", sourceId: "s1", ordinal: 0, text: "seg", charStart: 0, charEnd: 3 }],
    // V1 退役：learning_cards / card_key_points 表已删除，不再统计其计数
    evidences: [{ id: "e1", blockId: null, blockOrdinal: null, quoteText: "Q", alignment: "aligned" }],
    evidenceOverrides: [{ id: "eo1", evidenceId: "e1", userId: USER_ID, override: "confirmed" }],
    validationQuestions: [{ id: "vq1", cardId: "c1", keyPointId: null, questionType: "explain", question: "Q?" }],
    validationEvents: [{ id: "ve1", userId: USER_ID, cardId: "c1", artifactId: null, question: "Q?", questionType: "explain", userAnswer: "A", outcome: "preliminary_understanding", confidence: 80, jobId: null }],
    reviewSchedules: [{ id: "rs1", userId: USER_ID, subjectType: "card", subjectId: "c1", validationEventId: null, status: "pending", nextReviewAt: "2026-07-18T00:00:00.000Z", intervalDays: 1 }],
    reviewAttempts: [{ id: "ra1", userId: USER_ID, reviewScheduleId: "rs1", subjectType: "card", subjectId: "c1", idempotencyKey: "k1", status: "completed" }],
    understandingEvents: [{ id: "ue1", userId: USER_ID, subjectType: "card", subjectId: "c1", eventType: "validated", payload: {} }],
    aiArtifacts: [{ id: "aa1", type: "learning_card", inputRefs: {}, output: {}, modelId: "m", promptVersion: "v1" }],
  });

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
  assert.equal(result.counts!.users, 2);
  assert.equal(result.counts!.workspaceMembers, 2);
  assert.equal(result.counts!.notes, 1);
  assert.equal(result.counts!.noteVersions, 1);
  assert.equal(result.counts!.noteBlocks, 1);
  assert.equal(result.counts!.sources, 1);
  assert.equal(result.counts!.sourceSegments, 1);
  assert.equal(result.counts!.evidences, 1);
  assert.equal(result.counts!.evidenceOverrides, 1);
  assert.equal(result.counts!.validationQuestions, 1);
  assert.equal(result.counts!.validationEvents, 1);
  assert.equal(result.counts!.reviewSchedules, 1);
  assert.equal(result.counts!.reviewAttempts, 1);
  assert.equal(result.counts!.understandingEvents, 1);
  assert.equal(result.counts!.aiArtifacts, 1);
});

// ─── dry-run 非数组字段安全处理 ───────────────────────────────────────────

test("dry-run 对非数组字段安全处理返回零计数", async () => {
  const data = validExportData({
    users: "not an array",
    notes: null,
    sources: undefined,
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
  assert.equal(result.counts!.users, 0);
  assert.equal(result.counts!.notes, 0);
  assert.equal(result.counts!.sources, 0);
});

// ─── 冲突检测细化 ────────────────────────────────────────────────────────

test("目标已有 sources 时返回冲突", async () => {
  const conflictDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return [{ id: "existing" }]; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction(callback: (t: never) => Promise<unknown>) {
      return callback({} as never);
    },
  } as unknown as RestoreDatabase;

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    conflictDb,
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("已有数据"));
});

test("目标已有 learningCardsV2 时返回冲突", async () => {
  const conflictDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return [{ id: "existing" }]; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction(callback: (t: never) => Promise<unknown>) {
      return callback({} as never);
    },
  } as unknown as RestoreDatabase;

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    conflictDb,
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("已有数据"));
});

test("目标已有 jobs 时返回冲突", async () => {
  const conflictDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return [{ id: "existing" }]; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction(callback: (t: never) => Promise<unknown>) {
      return callback({} as never);
    },
  } as unknown as RestoreDatabase;

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    conflictDb,
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("已有数据"));
});

test("目标已有 aiArtifacts 时返回冲突", async () => {
  const conflictDb: RestoreDatabase = {
    query: {
      notes: { async findMany() { return []; } },
      sources: { async findMany() { return []; } },
      learningCardsV2: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return [{ id: "existing" }]; } },
    },
    async transaction(callback: (t: never) => Promise<unknown>) {
      return callback({} as never);
    },
  } as unknown as RestoreDatabase;

  const result = await restoreWorkspace(
    WORKSPACE_ID,
    validExportData(),
    false,
    conflictDb,
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("已有数据"));
});

// ─── dry-run 引用完整性细化 ───────────────────────────────────────────────
// V1 退役：validation_event / validation_question 的 cardId/keyPointId 引用
// 完整性校验已移除（列随 V1 卡表删除），以下仅保留仍然有效的 question 引用校验。

test("dry-run 检测到 validation_event 引用不存在的 question 时失败", async () => {
  const data = validExportData({
    validationQuestions: [
      { id: "vq-001", questionType: "explain", question: "Q?" },
    ],
    validationEvents: [
      {
        id: "ve1", userId: USER_ID, artifactId: null,
        question: "Q?", questionType: "explain", userAnswer: "A",
        outcome: "preliminary_understanding", confidence: 80, jobId: null,
        questionId: "nonexistent-question",
      },
    ],
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, false);
  assert.ok(result.message.includes("引用完整性") || result.message.includes("missing question"));
});

test("dry-run 引用完整性校验通过（validation_event 引用存在的 question）", async () => {
  const qId = "vq-001";
  const data = validExportData({
    validationQuestions: [
      { id: qId, questionType: "explain", question: "Q?" },
    ],
    validationEvents: [
      {
        id: "ve1", userId: USER_ID, artifactId: null,
        question: "Q?", questionType: "explain", userAnswer: "A",
        outcome: "preliminary_understanding", confidence: 80, jobId: null,
        questionId: qId,
      },
    ],
  });
  const result = await restoreWorkspace(
    WORKSPACE_ID,
    data,
    true,
    createEmptyMockDatabase(),
  );
  assert.equal(result.success, true);
});
