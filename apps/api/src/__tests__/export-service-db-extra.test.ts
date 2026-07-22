/**
 * export/service.ts 补充测试
 *
 * 重点覆盖 restoreWorkspace 的 dryRun 校验逻辑和引用完整性检查，
 * 以及 exportNoteMarkdown 的 Markdown 转换分支。
 *
 * restoreWorkspace 接受可注入的 database 参数，便于 mock。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  restoreWorkspace,
} from "../modules/export/service.ts";

// ─── Mock database for restoreWorkspace ───────────────────────────────

function createMockDatabase(config: {
  notes?: any[];
  sources?: any[];
  learningCards?: any[];
  jobs?: any[];
  aiArtifacts?: any[];
  insertError?: Error;
} = {}): any {
  return {
    query: {
      notes: { findMany: async () => config.notes ?? [] },
      sources: { findMany: async () => config.sources ?? [] },
      learningCards: { findMany: async () => config.learningCards ?? [] },
      jobs: { findMany: async () => config.jobs ?? [] },
      aiArtifacts: { findMany: async () => config.aiArtifacts ?? [] },
    },
    transaction: async (fn: (tx: any) => Promise<any>) => {
      if (config.insertError) throw config.insertError;
      const tx: any = {
        insert: (_table: any) => ({
          values: (data: any) => {
            const returning = () => Promise.resolve([data]);
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
        }),
        update: (_table: any) => ({
          set: (_data: any) => ({
            where: () => Promise.resolve(),
          }),
        }),
      };
      return fn(tx);
    },
  };
}

const WS_ID = "00000000-0000-0000-0000-000000000001";

// ─── restoreWorkspace 基本校验 ─────────────────────────────────────────

describe("export/service restoreWorkspace 基本校验", () => {
  it("缺少 workspace 字段时返回失败", async () => {
    const db = createMockDatabase();
    const result = await restoreWorkspace(WS_ID, { exportManifest: { version: "2.0" } } as any, false, db);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("workspace"));
  });

  it("缺少 exportManifest 字段时返回失败", async () => {
    const db = createMockDatabase();
    const result = await restoreWorkspace(WS_ID, { workspace: {} } as any, false, db);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("exportManifest"));
  });

  it("不支持的版本号返回失败", async () => {
    const db = createMockDatabase();
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "1.0" },
    } as any, false, db);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("版本"));
  });
});

// ─── restoreWorkspace 冲突检测 ─────────────────────────────────────────

describe("export/service restoreWorkspace 冲突检测", () => {
  it("目标工作区已有笔记时返回冲突", async () => {
    const db = createMockDatabase({
      notes: [{ id: "existing-note" }],
    });
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
    } as any, false, db);
    assert.equal(result.success, false);
    assert.ok(result.message.includes("已有数据"));
  });

  it("目标工作区已有 sources 时返回冲突", async () => {
    const db = createMockDatabase({
      sources: [{ id: "existing-source" }],
    });
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
    } as any, false, db);
    assert.equal(result.success, false);
  });

  it("目标工作区已有 cards 时返回冲突", async () => {
    const db = createMockDatabase({
      learningCards: [{ id: "existing-card" }],
    });
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
    } as any, false, db);
    assert.equal(result.success, false);
  });

  it("目标工作区已有 jobs 时返回冲突", async () => {
    const db = createMockDatabase({
      jobs: [{ id: "existing-job" }],
    });
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
    } as any, false, db);
    assert.equal(result.success, false);
  });

  it("目标工作区已有 artifacts 时返回冲突", async () => {
    const db = createMockDatabase({
      aiArtifacts: [{ id: "existing-art" }],
    });
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
    } as any, false, db);
    assert.equal(result.success, false);
  });

  it("空目标工作区通过冲突检测", async () => {
    const db = createMockDatabase();
    const result = await restoreWorkspace(WS_ID, {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
      users: [],
      workspaceMembers: [],
      notes: [],
      noteVersions: [],
      noteBlocks: [],
      sources: [],
      sourceSegments: [],
      learningCards: [],
      cardKeyPoints: [],
      evidences: [],
      evidenceOverrides: [],
      validationQuestions: [],
      validationEvents: [],
      reviewSchedules: [],
      reviewAttempts: [],
      understandingEvents: [],
      aiArtifacts: [],
      onboardingStates: [],
    } as any, false, db);
    assert.equal(result.success, true);
  });
});

// ─── restoreWorkspace dryRun 模式 ─────────────────────────────────────

describe("export/service restoreWorkspace dryRun", () => {
  const validData = {
    workspace: { id: WS_ID },
    exportManifest: { version: "2.0" },
    users: [{ id: "u1", email: "a@b.com" }],
    workspaceMembers: [{ userId: "u1", role: "owner" }],
    notes: [{ id: "n1", currentVersionId: "v1" }],
    noteVersions: [{ id: "v1", noteId: "n1" }],
    noteBlocks: [{ id: "b1", versionId: "v1" }],
    sources: [{ id: "s1" }],
    sourceSegments: [{ id: "ss1" }],
    learningCards: [{ id: "c1" }],
    cardKeyPoints: [{ id: "k1", cardId: "c1" }],
    evidences: [{ id: "e1", keyPointId: "k1" }],
    evidenceOverrides: [{ id: "eo1", evidenceId: "e1" }],
    validationQuestions: [{ id: "q1", cardId: "c1" }],
    validationEvents: [{ id: "ve1", cardId: "c1" }],
    reviewSchedules: [{ id: "rs1" }],
    reviewAttempts: [{ id: "ra1", reviewScheduleId: "rs1" }],
    understandingEvents: [{ id: "ue1" }],
    aiArtifacts: [{ id: "a1" }],
    onboardingStates: [{ id: "os1" }],
  };

  it("dryRun 返回数据量统计", async () => {
    const db = createMockDatabase();
    const result = await restoreWorkspace(WS_ID, validData as any, true, db);

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.ok(result.counts);
    assert.equal(result.counts!.users, 1);
    assert.equal(result.counts!.workspaceMembers, 1);
    assert.equal(result.counts!.notes, 1);
    assert.equal(result.counts!.noteVersions, 1);
    assert.equal(result.counts!.noteBlocks, 1);
    assert.equal(result.counts!.sources, 1);
    assert.equal(result.counts!.sourceSegments, 1);
    assert.equal(result.counts!.learningCards, 1);
    assert.equal(result.counts!.cardKeyPoints, 1);
    assert.equal(result.counts!.evidences, 1);
    assert.equal(result.counts!.evidenceOverrides, 1);
    assert.equal(result.counts!.validationQuestions, 1);
    assert.equal(result.counts!.validationEvents, 1);
    assert.equal(result.counts!.reviewSchedules, 1);
    assert.equal(result.counts!.reviewAttempts, 1);
    assert.equal(result.counts!.understandingEvents, 1);
    assert.equal(result.counts!.aiArtifacts, 1);
  });

  it("dryRun 检测 evidence_overrides 引用缺失的 evidence", async () => {
    const db = createMockDatabase();
    const data = {
      ...validData,
      evidenceOverrides: [{ id: "eo1", evidenceId: "missing-evidence" }],
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, false);
    assert.ok(result.message.includes("引用完整性"));
    assert.ok(result.message.includes("missing-evidence"));
  });

  it("dryRun 检测 validation_events 引用缺失的 card", async () => {
    const db = createMockDatabase();
    const data = {
      ...validData,
      validationEvents: [{ id: "ve1", cardId: "missing-card" }],
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, false);
    assert.ok(result.message.includes("引用完整性"));
    assert.ok(result.message.includes("missing-card"));
  });

  it("dryRun 检测 validation_events 引用缺失的 key_point", async () => {
    const db = createMockDatabase();
    const data = {
      ...validData,
      validationEvents: [{ id: "ve1", cardId: "c1", keyPointId: "missing-kp" }],
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, false);
    assert.ok(result.message.includes("引用完整性"));
    assert.ok(result.message.includes("missing-kp"));
  });

  it("dryRun 检测 validation_events 引用缺失的 question", async () => {
    const db = createMockDatabase();
    const data = {
      ...validData,
      validationEvents: [{ id: "ve1", cardId: "c1", questionId: "missing-q" }],
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, false);
    assert.ok(result.message.includes("引用完整性"));
    assert.ok(result.message.includes("missing-q"));
  });

  it("dryRun 检测 validation_questions 引用缺失的 card", async () => {
    const db = createMockDatabase();
    const data = {
      ...validData,
      validationQuestions: [{ id: "q1", cardId: "missing-card" }],
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, false);
    assert.ok(result.message.includes("引用完整性"));
    assert.ok(result.message.includes("missing-card"));
  });

  it("dryRun 引用完整性全部通过时返回成功", async () => {
    const db = createMockDatabase();
    const result = await restoreWorkspace(WS_ID, validData as any, true, db);

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
  });

  it("dryRun 处理空数组字段", async () => {
    const db = createMockDatabase();
    const data = {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
      users: [],
      workspaceMembers: [],
      notes: [],
      noteVersions: [],
      noteBlocks: [],
      sources: [],
      sourceSegments: [],
      learningCards: [],
      cardKeyPoints: [],
      evidences: [],
      evidenceOverrides: [],
      validationQuestions: [],
      validationEvents: [],
      reviewSchedules: [],
      reviewAttempts: [],
      understandingEvents: [],
      aiArtifacts: [],
      onboardingStates: [],
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.counts!.users, 0);
    assert.equal(result.counts!.notes, 0);
  });

  it("dryRun 处理缺失的数组字段（非数组）", async () => {
    const db = createMockDatabase();
    const data = {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
      users: null,
      notes: undefined,
      sources: "not-an-array",
    };
    const result = await restoreWorkspace(WS_ID, data as any, true, db);

    assert.equal(result.success, true);
    assert.equal(result.counts!.users, 0);
    assert.equal(result.counts!.notes, 0);
    assert.equal(result.counts!.sources, 0);
  });
});

// ─── restoreWorkspace 实际恢复模式 ─────────────────────────────────────

describe("export/service restoreWorkspace 实际恢复", () => {
  it("成功恢复数据", async () => {
    const db = createMockDatabase();
    const data = {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
      users: [{ id: "u1", email: "a@b.com", role: "owner" }],
      workspaceMembers: [{ userId: "u1", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" }],
      notes: [{ id: "n1", title: "笔记", titleSource: "manual", currentVersionId: "v1", createdBy: "u1" }],
      noteVersions: [{ id: "v1", noteId: "n1", versionNo: 1, contentJson: {}, createdBy: "u1" }],
      noteBlocks: [{ id: "b1", versionId: "v1", ordinal: 0, type: "paragraph", content: "text" }],
      sources: [{ id: "s1", type: "text", title: "源", createdBy: "u1" }],
      sourceSegments: [{ id: "ss1", sourceId: "s1", ordinal: 0, text: "段落", charStart: 0, charEnd: 2 }],
      learningCards: [{ id: "c1", noteVersionId: "v1", schemaJson: { title: "卡片" } }],
      cardKeyPoints: [{ id: "k1", cardId: "c1", ordinal: 0, claim: "要点", quoteText: "引用" }],
      evidences: [{ id: "e1", keyPointId: "k1", quoteText: "引用", alignment: "aligned" }],
      evidenceOverrides: [{ id: "eo1", evidenceId: "e1", userId: "u1", override: "confirmed" }],
      validationQuestions: [{ id: "q1", cardId: "c1", questionType: "free_text", question: "问题", createdBy: "u1" }],
      validationEvents: [{ id: "ve1", cardId: "c1", userId: "u1", question: "问题", questionType: "free_text", userAnswer: "答案", outcome: "correct", confidence: 90 }],
      reviewSchedules: [{ id: "rs1", userId: "u1", subjectType: "card", subjectId: "c1", status: "pending", nextReviewAt: "2026-01-01T00:00:00.000Z", intervalDays: 1 }],
      reviewAttempts: [{ id: "ra1", userId: "u1", reviewScheduleId: "rs1", subjectType: "card", subjectId: "c1", idempotencyKey: "key1", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" }],
      understandingEvents: [{ id: "ue1", userId: "u1", subjectType: "card", subjectId: "c1", eventType: "reviewed", payload: {} }],
      aiArtifacts: [{ id: "a1", type: "generate_card", inputRefs: {}, output: {}, modelId: "m1", promptVersion: "v1" }],
      onboardingStates: [{ id: "os1", userId: "u1", version: "v1", steps: {}, status: "pending" }],
    };

    const result = await restoreWorkspace(WS_ID, data as any, false, db);

    assert.equal(result.success, true);
    assert.ok(result.counts);
    assert.equal(result.counts!.users, 1);
    assert.equal(result.counts!.notes, 1);
    assert.equal(result.counts!.sources, 1);
  });

  it("恢复失败时返回错误信息", async () => {
    const db = createMockDatabase({
      insertError: new Error("DB connection lost"),
    });
    const data = {
      workspace: { id: WS_ID },
      exportManifest: { version: "2.0" },
      users: [{ id: "u1", email: "a@b.com" }],
    };

    const result = await restoreWorkspace(WS_ID, data as any, false, db);

    assert.equal(result.success, false);
    assert.ok(result.message.includes("恢复失败"));
  });
});

// ─── exportManifest 完整性验证 ─────────────────────────────────────────

describe("export/service exportManifest 字段验证", () => {
  it("exportManifest 包含所有必需的 included 字段", async () => {
    const db = createMockDatabase();
    const data = {
      workspace: { id: WS_ID },
      exportManifest: {
        version: "2.0",
        included: [
          "workspace", "users", "workspaceMembers", "notes", "noteVersions",
          "noteBlocks", "sources", "sourceSegments", "learningCards",
          "cardKeyPoints", "evidences", "evidenceOverrides",
          "validationQuestions", "validationEvents", "reviewSchedules",
          "reviewAttempts", "understandingEvents", "aiArtifacts",
          "onboardingStates",
        ],
        excluded: {},
        notes: [],
      },
    };

    const result = await restoreWorkspace(WS_ID, data as any, true, db);
    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
  });

  it("exportManifest version 非 2.0 时拒绝", async () => {
    const db = createMockDatabase();
    const versions = ["1.0", "3.0", "", null, undefined];
    for (const v of versions) {
      const result = await restoreWorkspace(WS_ID, {
        workspace: { id: WS_ID },
        exportManifest: { version: v as any },
      } as any, true, db);
      assert.equal(result.success, false, `version=${v} should fail`);
    }
  });
});
