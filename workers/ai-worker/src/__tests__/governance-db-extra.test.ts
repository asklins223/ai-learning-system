/**
 * governance.ts DB 依赖函数补充测试
 *
 * 通过 mock db 对象的 transaction/query 属性，
 * 测试 checkAIConsent / getWorkspaceAIProvider / getPersonalAIProviderRuntimeConfig /
 * getWorkspaceAIPolicy / enforcePrivacyGovernance / logAICall 的核心业务逻辑分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  checkAIConsent,
  getWorkspaceAIProvider,
  getPersonalAIProviderRuntimeConfig,
  getWorkspaceAIPolicy,
  enforcePrivacyGovernance,
  logAICall,
  DEFAULT_AI_DATA_POLICY,
  type AICallAuditParams,
} from "../lib/governance.ts";
import { db } from "../db.ts";

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

let originalTransaction: typeof db.transaction;
let originalInsert: typeof db.insert;
let originalWorkspacesFindFirst: any;
let originalUserAIModelConfigsFindFirst: any;

before(() => {
  originalTransaction = db.transaction;
  originalInsert = db.insert;
  if (db.query?.workspaces?.findFirst) {
    originalWorkspacesFindFirst = db.query.workspaces.findFirst;
  }
  if (db.query?.userAIModelConfigs?.findFirst) {
    originalUserAIModelConfigsFindFirst = db.query.userAIModelConfigs.findFirst;
  }
});

after(() => {
  db.transaction = originalTransaction;
  db.insert = originalInsert;
  if (originalWorkspacesFindFirst && db.query?.workspaces) {
    db.query.workspaces.findFirst = originalWorkspacesFindFirst;
  }
  if (originalUserAIModelConfigsFindFirst && db.query?.userAIModelConfigs) {
    db.query.userAIModelConfigs.findFirst = originalUserAIModelConfigsFindFirst;
  }
});

function setupDbMock(opts: {
  workspace?: any;
  userAIModelConfig?: any;
  insertShouldThrow?: boolean;
}) {
  if (db.query?.workspaces) {
    (db.query.workspaces.findFirst as any) = async () => opts.workspace ?? undefined;
  }
  if (db.query?.userAIModelConfigs) {
    (db.query.userAIModelConfigs.findFirst as any) = async () => opts.userAIModelConfig ?? undefined;
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

// ─── getWorkspaceAIProvider ─────────────────────────────────────────────

describe("governance getWorkspaceAIProvider (DB mock)", () => {
  it("工作区有 aiProvider 时返回小写", async () => {
    setupDbMock({
      workspace: { id: WS_ID, aiProvider: "DashScope" },
    });
    const result = await getWorkspaceAIProvider(WS_ID);
    assert.equal(result, "dashscope");
  });

  it("工作区无 aiProvider 时回退到环境变量", async () => {
    const oldEnv = process.env.AI_PROVIDER_CARD;
    process.env.AI_PROVIDER_CARD = "openai_compatible";
    try {
      setupDbMock({ workspace: { id: WS_ID, aiProvider: null } });
      const result = await getWorkspaceAIProvider(WS_ID);
      assert.equal(result, "openai_compatible");
    } finally {
      if (oldEnv === undefined) delete process.env.AI_PROVIDER_CARD;
      else process.env.AI_PROVIDER_CARD = oldEnv;
    }
  });

  it("工作区不存在时回退到 mock", async () => {
    const oldEnv = process.env.AI_PROVIDER_CARD;
    delete process.env.AI_PROVIDER_CARD;
    try {
      setupDbMock({ workspace: undefined });
      const result = await getWorkspaceAIProvider(WS_ID);
      assert.equal(result, "mock");
    } finally {
      if (oldEnv !== undefined) process.env.AI_PROVIDER_CARD = oldEnv;
    }
  });
});

// ─── getPersonalAIProviderRuntimeConfig ─────────────────────────────────

describe("governance getPersonalAIProviderRuntimeConfig (DB mock)", () => {
  it("用户无个人配置时返回 null", async () => {
    setupDbMock({ userAIModelConfig: undefined });
    const result = await getPersonalAIProviderRuntimeConfig(USER_ID);
    assert.equal(result, null);
  });

  it("旧 mock 记录按系统默认处理，不再形成个人覆盖", async () => {
    setupDbMock({
      userAIModelConfig: { provider: "mock", baseUrl: null, model: null, apiKeyEncrypted: null },
    });
    const result = await getPersonalAIProviderRuntimeConfig(USER_ID);
    assert.equal(result, null);
  });

  it("用户配置不完整时抛错", async () => {
    setupDbMock({
      userAIModelConfig: {
        provider: "dashscope",
        baseUrl: null,
        model: "qwen-turbo",
        apiKeyEncrypted: "encrypted-key",
      },
    });
    await assert.rejects(
      () => getPersonalAIProviderRuntimeConfig(USER_ID),
      /incomplete/,
    );
  });

  it("用户配置为 openai_compatible 时抛错（因为需要 decryptAiCredential）", async () => {
    setupDbMock({
      userAIModelConfig: {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com",
        model: "gpt-4",
        apiKeyEncrypted: "encrypted-key-data",
      },
    });
    // decryptAiCredential requires a specific format that we can't easily mock
    // This test just verifies the flow reaches the decryption point
    await assert.rejects(
      () => getPersonalAIProviderRuntimeConfig(USER_ID),
      /unsupported AI credential ciphertext format|could not be decrypted/,
    );
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
      operation: "generate_card",
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
      operation: "generate_card",
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
      operation: "generate_card",
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
      operation: "generate_card",
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
      operation: "generate_card",
    };
    const result = await logAICall(params, {
      getPolicy: async () => ({ sendToExternal: true, piiDetection: true, auditLogging: true }),
      write: async () => { throw new Error("write failed"); },
    });
    assert.equal(result, false);
  });
});
