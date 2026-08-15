/**
 * governance.ts DB 依赖函数补充测试
 *
 * 通过 mock db 对象的 transaction/query 属性，
 * 测试 checkAIConsent / getWorkspaceAIPolicy / enforcePrivacyGovernance / logAICall 的核心业务逻辑分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  checkAIConsent,
  getWorkspaceAIPolicy,
  enforcePrivacyGovernance,
  logAICall,
  DEFAULT_AI_DATA_POLICY,
  type AICallAuditParams,
} from "../lib/governance.ts";
import { db } from "../db.ts";
import { setPlatformConfig, resetPlatformConfigCache } from "@ailearn/shared/platform-config-node";

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

let originalTransaction: typeof db.transaction;
let originalInsert: typeof db.insert;
let originalWorkspacesFindFirst: any;

before(() => {
  setPlatformConfig(null);
  originalTransaction = db.transaction;
  originalInsert = db.insert;
  if (db.query?.workspaces?.findFirst) {
    originalWorkspacesFindFirst = db.query.workspaces.findFirst;
  }
});

after(() => {
  db.transaction = originalTransaction;
  db.insert = originalInsert;
  if (originalWorkspacesFindFirst && db.query?.workspaces) {
    db.query.workspaces.findFirst = originalWorkspacesFindFirst;
  }
  resetPlatformConfigCache();
});

function setupDbMock(opts: {
  workspace?: any;
  insertShouldThrow?: boolean;
}) {
  if (db.query?.workspaces) {
    (db.query.workspaces.findFirst as any) = async () => opts.workspace ?? undefined;
  }

  let insertCallCount = 0;
  db.insert = ((_table: any) => ({
    values: (_data: any) => {
      insertCallCount++;
      if (opts.insertShouldThrow) {
        return Promise.reject(new Error("db write failed"));
      }
      return chainable(undefined);
    },
  })) as typeof db.insert;
}

// Chainable helper
// Mock execute for setWorkerTransactionContext
function chainable(value: any): any {
  const obj: any = {
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
    catch: (fn: any) => Promise.resolve(value).catch(fn),
    finally: (fn: any) => Promise.resolve(value).finally(fn),
  };
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive) return () => String(value);
      return () => chainable(value);
    },
  });
}

// ─── checkAIConsent ─────────────────────────────────────────────────────

describe("governance checkAIConsent (DB mock)", () => {
  it("mock provider 总是返回 true", async () => {
    setupDbMock({ workspace: undefined });
    const result = await checkAIConsent(WS_ID, "mock");
    assert.equal(result, true);
  });

  it("工作区不存在时返回 false", async () => {
    setupDbMock({ workspace: undefined });
    const result = await checkAIConsent(WS_ID, "dashscope");
    assert.equal(result, false);
  });

  it("非 mock provider 且已签署同意时返回 true", async () => {
    setupDbMock({
      workspace: {
        id: WS_ID,
        aiConsentVersion: "v1",
        aiConsentAt: new Date(),
      },
    });
    const result = await checkAIConsent(WS_ID, "dashscope");
    assert.equal(result, true);
  });

  it("非 mock provider 且未签署同意时返回 false", async () => {
    setupDbMock({
      workspace: {
        id: WS_ID,
        aiConsentVersion: null,
        aiConsentAt: null,
      },
    });
    const result = await checkAIConsent(WS_ID, "dashscope");
    assert.equal(result, false);
  });

  it("部分同意（version 有但 time 无）返回 false", async () => {
    setupDbMock({
      workspace: {
        id: WS_ID,
        aiConsentVersion: "v1",
        aiConsentAt: null,
      },
    });
    const result = await checkAIConsent(WS_ID, "openai_compatible");
    assert.equal(result, false);
  });
});

// ─── getWorkspaceAIPolicy ──────────────────────────────────────────────

describe("governance getWorkspaceAIPolicy (DB mock)", () => {
  it("工作区不存在时返回默认策略", async () => {
    setupDbMock({ workspace: undefined });
    const result = await getWorkspaceAIPolicy(WS_ID);
    assert.deepEqual(result, DEFAULT_AI_DATA_POLICY);
  });

  it("工作区有策略时返回规范化策略", async () => {
    setupDbMock({
      workspace: {
        id: WS_ID,
        aiDataPolicy: {
          sendToExternal: true,
          piiDetection: false,
          auditLogging: true,
        },
      },
    });
    const result = await getWorkspaceAIPolicy(WS_ID);
    assert.equal(result.sendToExternal, true);
    assert.equal(result.piiDetection, false);
    assert.equal(result.auditLogging, true);
  });

  it("工作区策略为 null 时返回默认策略", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: null },
    });
    const result = await getWorkspaceAIPolicy(WS_ID);
    assert.deepEqual(result, DEFAULT_AI_DATA_POLICY);
  });
});

// ─── enforcePrivacyGovernance ───────────────────────────────────────────

describe("governance enforcePrivacyGovernance (DB mock)", () => {
  it("mock provider 总是允许", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: false, piiDetection: true, auditLogging: true } },
    });
    const result = await enforcePrivacyGovernance(
      WS_ID, ["note_content"], { text: "some data" }, "mock",
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(result.sanitizedData, { text: "some data" });
    assert.equal(result.piiDetectedTypes.length, 0);
  });

  it("非 mock provider + sendToExternal=false 时拒绝", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: false, piiDetection: true, auditLogging: true } },
    });
    const result = await enforcePrivacyGovernance(
      WS_ID, ["note_content"], { text: "some data" }, "dashscope",
    );
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("sendToExternal"));
  });

  it("非 mock provider + sendToExternal=true + 无 PII 时允许", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: true } },
    });
    const result = await enforcePrivacyGovernance(
      WS_ID, ["note_content"], { text: "no pii here" }, "dashscope",
    );
    assert.equal(result.allowed, true);
    assert.equal(result.piiDetectedTypes.length, 0);
  });

  it("非 mock provider + sendToExternal=true + 有 PII 时脱敏", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: true } },
    });
    const result = await enforcePrivacyGovernance(
      WS_ID, ["note_content"], { text: "联系邮箱 test@example.com" }, "dashscope",
    );
    assert.equal(result.allowed, true);
    assert.ok(result.piiDetectedTypes.length > 0);
    assert.ok(result.piiDetectedTypes.includes("email"));
  });

  it("非 mock provider + piiDetection=false 时不检测 PII", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: true, piiDetection: false, auditLogging: true } },
    });
    const result = await enforcePrivacyGovernance(
      WS_ID, ["note_content"], { text: "联系邮箱 test@example.com" }, "dashscope",
    );
    assert.equal(result.allowed, true);
    assert.equal(result.piiDetectedTypes.length, 0);
    // Data should not be sanitized
    assert.deepEqual(result.sanitizedData, { text: "联系邮箱 test@example.com" });
  });
});

// ─── logAICall ──────────────────────────────────────────────────────────

describe("governance logAICall (DB mock)", () => {
  it("auditLogging=true 时写入审计日志", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: true } },
    });
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "execute_card_agent_turn",
    };
    const result = await logAICall(params);
    assert.equal(result, true);
  });

  it("auditLogging=false 时跳过写入", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: false } },
    });
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "execute_card_agent_turn",
    };
    const result = await logAICall(params);
    assert.equal(result, false);
  });

  it("使用注入的 getPolicy 依赖", async () => {
    setupDbMock({});
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "mock",
      modelId: "mock-model",
      operation: "execute_card_agent_turn",
    };
    let written = false;
    const result = await logAICall(params, {
      getPolicy: async () => ({ sendToExternal: true, piiDetection: true, auditLogging: true }),
      write: async () => { written = true; },
    });
    assert.equal(result, true);
    assert.equal(written, true);
  });

  it("写入失败时返回 false（不抛错）", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiDataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: true } },
      insertShouldThrow: true,
    });
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "execute_card_agent_turn",
    };
    const result = await logAICall(params);
    assert.equal(result, false);
  });

  it("使用注入的 write 依赖抛错时也返回 false", async () => {
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "execute_card_agent_turn",
    };
    const result = await logAICall(params, {
      getPolicy: async () => ({ sendToExternal: true, piiDetection: true, auditLogging: true }),
      write: async () => { throw new Error("write failed"); },
    });
    assert.equal(result, false);
  });
});
