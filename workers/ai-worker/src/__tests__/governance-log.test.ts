/**
 * governance.ts 补充测试：logAICall
 *
 * logAICall 通过 dependencies 参数支持依赖注入，无需数据库。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { logAICall, type AICallAuditParams } from "../lib/governance.ts";

function baseParams(overrides: Partial<AICallAuditParams> = {}): AICallAuditParams {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    provider: "mock",
    modelId: "mock-v1",
    operation: "card_generate",
    ...overrides,
  };
}

// ─── logAICall: auditLogging=true 时写入审计日志 ──────────────────────────

test("logAICall: policy.auditLogging=true 时调用 write 并返回 true", async () => {
  let writtenRow: any = null;
  const result = await logAICall(baseParams(), {
    getPolicy: async () => ({
      sendToExternal: false,
      piiDetection: true,
      auditLogging: true,
    }),
    write: async (row) => {
      writtenRow = row;
    },
  });

  assert.equal(result, true);
  assert.ok(writtenRow);
  assert.equal(writtenRow.workspaceId, "ws-1");
  assert.equal(writtenRow.userId, "user-1");
  assert.equal(writtenRow.provider, "mock");
  assert.equal(writtenRow.modelId, "mock-v1");
  assert.equal(writtenRow.operation, "card_generate");
});

// ─── logAICall: auditLogging=false 时跳过写入 ─────────────────────────────

test("logAICall: policy.auditLogging=false 时跳过写入并返回 false", async () => {
  let writeCalled = false;
  const result = await logAICall(baseParams(), {
    getPolicy: async () => ({
      sendToExternal: false,
      piiDetection: true,
      auditLogging: false,
    }),
    write: async () => {
      writeCalled = true;
    },
  });

  assert.equal(result, false);
  assert.equal(writeCalled, false);
});

// ─── logAICall: 默认值正确填充 ────────────────────────────────────────────

test("logAICall: 可选字段使用默认值", async () => {
  let writtenRow: any = null;
  await logAICall(
    {
      workspaceId: "ws-1",
      userId: "user-1",
      provider: "dashscope",
      modelId: "qwen-plus",
      operation: "companion_agent",
    },
    {
      getPolicy: async () => ({
        sendToExternal: true,
        piiDetection: true,
        auditLogging: true,
      }),
      write: async (row) => {
        writtenRow = row;
      },
    },
  );

  assert.ok(writtenRow);
  assert.equal(writtenRow.jobId, null);
  assert.deepEqual(writtenRow.dataCategories, []);
  assert.equal(writtenRow.dataSizeBytes, null);
  assert.equal(writtenRow.costTokens, null);
  assert.equal(writtenRow.durationMs, null);
  assert.equal(writtenRow.status, "success");
  assert.equal(writtenRow.errorMessage, null);
});

// ─── logAICall: 自定义字段正确传递 ────────────────────────────────────────

test("logAICall: 所有字段正确传递且错误信息安全化", async () => {
  let writtenRow: any = null;
  await logAICall(
    {
      workspaceId: "ws-2",
      userId: "user-2",
      jobId: "job-123",
      provider: "openai_compatible",
      modelId: "gpt-4o",
      operation: "card_generate",
      dataCategories: ["note_content", "note_title"],
      dataSizeBytes: 1024,
      costTokens: 500,
      durationMs: 2000,
      status: "failed",
      errorMessage: "provider timeout",
    },
    {
      getPolicy: async () => ({
        sendToExternal: true,
        piiDetection: false,
        auditLogging: true,
      }),
      write: async (row) => {
        writtenRow = row;
      },
    },
  );

  assert.ok(writtenRow);
  assert.equal(writtenRow.workspaceId, "ws-2");
  assert.equal(writtenRow.userId, "user-2");
  assert.equal(writtenRow.jobId, "job-123");
  assert.equal(writtenRow.provider, "openai_compatible");
  assert.equal(writtenRow.modelId, "gpt-4o");
  assert.equal(writtenRow.operation, "card_generate");
  assert.deepEqual(writtenRow.dataCategories, ["note_content", "note_title"]);
  assert.equal(writtenRow.dataSizeBytes, 1024);
  assert.equal(writtenRow.costTokens, 500);
  assert.equal(writtenRow.durationMs, 2000);
  assert.equal(writtenRow.status, "failed");
  assert.equal(writtenRow.errorMessage, "operational_error:timeout:Error");
});

// ─── logAICall: write 抛异常时不传播，返回 false ─────────────────────────

test("logAICall: write 抛异常时返回 false 而非传播错误", async () => {
  const result = await logAICall(baseParams(), {
    getPolicy: async () => ({
      sendToExternal: false,
      piiDetection: true,
      auditLogging: true,
    }),
    write: async () => {
      throw new Error("database connection failed");
    },
  });

  assert.equal(result, false);
});

// ─── logAICall: getPolicy 抛异常时不传播，返回 false ──────────────────────

test("logAICall: getPolicy 抛异常时返回 false 而非传播错误", async () => {
  const result = await logAICall(baseParams(), {
    getPolicy: async () => {
      throw new Error("policy lookup failed");
    },
    write: async () => {},
  });

  assert.equal(result, false);
});

// ─── logAICall: jobId 为 undefined 时填充 null ───────────────────────────

test("logAICall: jobId 为 undefined 时填充为 null", async () => {
  let writtenRow: any = null;
  await logAICall(
    {
      workspaceId: "ws-1",
      userId: "user-1",
      provider: "mock",
      modelId: "mock-v1",
      operation: "card_generate",
      // jobId 不提供
    },
    {
      getPolicy: async () => ({
        sendToExternal: false,
        piiDetection: true,
        auditLogging: true,
      }),
      write: async (row) => {
        writtenRow = row;
      },
    },
  );

  assert.equal(writtenRow.jobId, null);
});

// ─── logAICall: jobId 为 null 时保持 null ────────────────────────────────

test("logAICall: jobId 显式为 null 时保持 null", async () => {
  let writtenRow: any = null;
  await logAICall(
    {
      workspaceId: "ws-1",
      userId: "user-1",
      jobId: null,
      provider: "mock",
      modelId: "mock-v1",
      operation: "card_generate",
    },
    {
      getPolicy: async () => ({
        sendToExternal: false,
        piiDetection: true,
        auditLogging: true,
      }),
      write: async (row) => {
        writtenRow = row;
      },
    },
  );

  assert.equal(writtenRow.jobId, null);
});
