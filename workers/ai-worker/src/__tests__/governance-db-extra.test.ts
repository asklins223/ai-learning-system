/**
 * governance.ts DB 依赖函数补充测试
 *
 * 通过 mock db 对象的 transaction/query 属性，
 * 测试 getAccountAIPolicy / enforcePrivacyGovernanceWithPolicy / logAICall 的核心业务逻辑分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  getAccountAIPolicy,
  enforcePrivacyGovernanceWithPolicy,
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

/**
 * `user_ai_settings` 开了 RLS，读它必须走带 `app.user_id` 的事务，所以这里桩掉
 * `db.transaction`，并把 `applyContext` 的回读校验一并喂平 —— 少这一步，生产上
 * 就是"静默 0 行 = 永远没同意"（0237 注释里点过的坑），测试要让它可见。
 */
function mockSettingsQuery(row: any) {
  const fakeTransaction: any = {
    query: { userAiSettings: { findFirst: async () => row } },
    execute: async () => [{ workspace_id: WS_ID, user_id: USER_ID }],
    // 审计写入自 F07 起走工作区/actor 事务（`logAICall` 在事务里 `tx.insert(...)`，
    // 因为 ai_audit_log 的两条 RESTRICTIVE 守卫要 app.workspace_id / app.user_id）。
    // 桩要接住这条真实形状：转发给当前的 `db.insert` 桩，`insertShouldThrow` 那些
    // 用例测的仍是同一条失败路径。
    insert: (table: any) => db.insert(table as never),
  };
  let opened = 0;
  db.transaction = (async (fn: any) => { opened += 1; return fn(fakeTransaction); }) as typeof db.transaction;
  return () => opened > 0;
}

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

function setupDbMock(opts: {
  settings?: any;
  insertShouldThrow?: boolean;
}) {
  mockSettingsQuery(opts.settings);
  db.insert = ((_table: any) => ({
    values: (_data: any) => {
      if (opts.insertShouldThrow) return Promise.reject(new Error("db write failed"));
      return chainable(undefined);
    },
  })) as typeof db.insert;
}

describe("governance getAccountAIPolicy (DB mock)", () => {
  it("没有 userId 时不查库，直接回落到拒绝默认", async () => {
    const usedTransaction = mockSettingsQuery(undefined);
    const result = await getAccountAIPolicy(WS_ID, null);
    assert.deepEqual(result, DEFAULT_AI_DATA_POLICY);
    assert.equal(usedTransaction(), false, "无 userId 就不该开带 RLS 身份的事务");
  });

  it("账号策略按规范化返回", async () => {
    mockSettingsQuery({
      userId: USER_ID,
      dataPolicy: { sendToExternal: true, piiDetection: false, auditLogging: true },
    });
    const result = await getAccountAIPolicy(WS_ID, USER_ID);
    assert.equal(result.sendToExternal, true);
    assert.equal(result.piiDetection, false);
    assert.equal(result.auditLogging, true);
  });

  it("没有设置行时 fail closed（默认不允许外发），且确实走了带身份的事务", async () => {
    const usedTransaction = mockSettingsQuery(undefined);
    const result = await getAccountAIPolicy(WS_ID, USER_ID);
    assert.equal(result.sendToExternal, false);
    assert.equal(usedTransaction(), true);
  });
});

// ─── enforcePrivacyGovernanceWithPolicy ───────────────────────────────

describe("governance enforcePrivacyGovernanceWithPolicy", () => {
  const policy = { sendToExternal: false, piiDetection: true, auditLogging: true };

  it("mock provider 总是允许", () => {
    const result = enforcePrivacyGovernanceWithPolicy(
      policy, WS_ID, ["note_content"], { text: "some data" }, "mock",
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(result.sanitizedData, { text: "some data" });
    assert.equal(result.piiDetectedTypes.length, 0);
  });

  it("非 mock provider + sendToExternal=false 时拒绝", () => {
    const result = enforcePrivacyGovernanceWithPolicy(
      policy, WS_ID, ["note_content"], { text: "some data" }, "dashscope",
    );
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("sendToExternal"));
  });

  it("非 mock provider + sendToExternal=true + 无 PII 时允许", () => {
    const openPolicy = { sendToExternal: true, piiDetection: true, auditLogging: true };
    const result = enforcePrivacyGovernanceWithPolicy(
      openPolicy, WS_ID, ["note_content"], { text: "no pii here" }, "dashscope",
    );
    assert.equal(result.allowed, true);
    assert.equal(result.piiDetectedTypes.length, 0);
  });

  it("非 mock provider + sendToExternal=true + 有 PII 时脱敏", () => {
    const openPolicy = { sendToExternal: true, piiDetection: true, auditLogging: true };
    const result = enforcePrivacyGovernanceWithPolicy(
      openPolicy, WS_ID, ["note_content"], { text: "联系邮箱 test@example.com" }, "dashscope",
    );
    assert.equal(result.allowed, true);
    assert.ok(result.piiDetectedTypes.length > 0);
    assert.ok(result.piiDetectedTypes.includes("email"));
  });

  it("非 mock provider + piiDetection=false 时不检测 PII", () => {
    const noPiiPolicy = { sendToExternal: true, piiDetection: false, auditLogging: true };
    const result = enforcePrivacyGovernanceWithPolicy(
      noPiiPolicy, WS_ID, ["note_content"], { text: "联系邮箱 test@example.com" }, "dashscope",
    );
    assert.equal(result.allowed, true);
    assert.equal(result.piiDetectedTypes.length, 0);
    assert.deepEqual(result.sanitizedData, { text: "联系邮箱 test@example.com" });
  });
});

// ─── logAICall ──────────────────────────────────────────────────────────

describe("governance logAICall (DB mock)", () => {
  it("auditLogging=true 时写入审计日志", async () => {
    setupDbMock({
      settings: { userId: USER_ID, dataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: true } },
    });
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "companion_agent",
    };
    const result = await logAICall(params);
    assert.equal(result, true);
  });

  it("auditLogging=false 时跳过写入", async () => {
    setupDbMock({
      settings: { userId: USER_ID, dataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: false } },
    });
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "companion_agent",
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
      operation: "companion_agent",
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
      settings: { userId: USER_ID, dataPolicy: { sendToExternal: true, piiDetection: true, auditLogging: true } },
      insertShouldThrow: true,
    });
    const params: AICallAuditParams = {
      workspaceId: WS_ID,
      userId: USER_ID,
      provider: "dashscope",
      modelId: "qwen-turbo",
      operation: "companion_agent",
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
      operation: "companion_agent",
    };
    const result = await logAICall(params, {
      getPolicy: async () => ({ sendToExternal: true, piiDetection: true, auditLogging: true }),
      write: async () => { throw new Error("write failed"); },
    });
    assert.equal(result, false);
  });
});
