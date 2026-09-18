/**
 * ai-provider.ts DB 依赖函数补充测试
 *
 * v0.6 单一配置源重构：平台解析完全收敛到 config/ai-platforms.json，
 * 不再有 personal BYOK 或 workspace.aiProvider 分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import { resolveProviderSelection, createProvider } from "../lib/ai-provider.ts";
import { resolveSystemProviderForCapability } from "@ailearn/shared/task-router";
import { setPlatformConfig, resetPlatformConfigCache, resolveSystemPlatform } from "@ailearn/shared/platform-config-node";
import { db } from "../db.ts";

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

let originalTransaction: typeof db.transaction;
let originalWorkspacesFindFirst: any;

before(() => {
  setPlatformConfig(null);
  originalTransaction = db.transaction;
  if (db.query?.workspaces?.findFirst) {
    originalWorkspacesFindFirst = db.query.workspaces.findFirst;
  }
});

after(() => {
  db.transaction = originalTransaction;
  if (originalWorkspacesFindFirst && db.query?.workspaces) {
    db.query.workspaces.findFirst = originalWorkspacesFindFirst;
  }
  resetPlatformConfigCache();
});

// Mock execute for setWorkerTransactionContext
function createMockTx(): any {
  return {
    execute: async () => [
      { workspace_id: WS_ID, user_id: USER_ID },
    ],
    insert: (_table: any) => ({
      values: (_data: any) => ({
        returning: () => ({
          then: (fn: any) => Promise.resolve(undefined).then(fn),
        }),
      }),
    }),
    update: (_table: any) => ({
      set: (_data: any) => ({
        where: () => ({
          then: (fn: any) => Promise.resolve(undefined).then(fn),
        }),
      }),
    }),
    delete: (_table: any) => ({
      where: () => ({
        then: (fn: any) => Promise.resolve(undefined).then(fn),
      }),
    }),
    select: (_fields: any) => ({
      from: (_table: any) => ({
        then: (fn: any) => Promise.resolve([]).then(fn),
      }),
    }),
    query: {
      workspaces: {
        findFirst: async () => undefined,
        findMany: async () => [],
      },
    },
  };
}

function setupDbMock() {
  const mockTx = createMockTx();
  db.transaction = (async (fn: any) => fn(mockTx)) as typeof db.transaction;
  if (db.query?.workspaces) {
    (db.query.workspaces.findFirst as any) = async () => undefined;
  }
}

describe("ai-provider resolveProviderSelection (DB mock)", () => {
  it("无配置文件时使用 mock", async () => {
    setupDbMock();
    const result = await resolveProviderSelection(WS_ID, USER_ID);
    assert.equal(result.providerName, "mock");
  });

  it("无配置文件时使用 mock", async () => {
    setupDbMock();
    const result = await resolveProviderSelection(undefined, undefined);
    assert.equal(result.providerName, "mock");
  });

  it("有配置文件时使用平台配置", async () => {
    setupDbMock();
    setPlatformConfig({
      platforms: {
        myopenai: {
          type: "openai_compatible",
          apiKey: "sk-fixture",
          baseUrl: "https://fixture.example.com/v1",
        },
      },
      capabilities: {
        agent_turn: { platform: "myopenai", model: "glm-5.2" },
      },
    });
    try {
      const result = await resolveProviderSelection(WS_ID, USER_ID);
      assert.equal(result.providerName, "openai_compatible");
      const cfg = result.config as any;
      assert.equal(cfg.apiKey, "sk-fixture");
      assert.equal(cfg.baseUrl, "https://fixture.example.com/v1");
      assert.equal(cfg.model, "glm-5.2");
    } finally {
      setPlatformConfig(null);
    }
  });
});

describe("§2.3 缺 key 判定", () => {
  afterEach(() => {
    setPlatformConfig(null);
    resetPlatformConfigCache();
  });

  it("非 mock 平台 apiKey 含未解析的 ${VAR} 时 resolveSystemPlatform 返回 null", () => {
    setPlatformConfig({
      platforms: {
        bigmodel: {
          type: "openai_compatible",
          apiKey: "${BIGMODEL_API_KEY}",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        },
      },
      capabilities: {
        agent_turn: { platform: "bigmodel", model: "glm-4.1V" },
      },
    });
    const result = resolveSystemPlatform("agent_turn");
    assert.equal(result, null, "unresolved ${VAR} apiKey should yield null (→ mock fallback)");
  });

  it("非 mock 平台 apiKey 为空时 resolveSystemPlatform 返回 null", () => {
    setPlatformConfig({
      platforms: {
        nokey: {
          type: "openai_compatible",
          apiKey: "",
          baseUrl: "https://example.com/v1",
        },
      },
      capabilities: {
        agent_turn: { platform: "nokey", model: "test-model" },
      },
    });
    const result = resolveSystemPlatform("agent_turn");
    assert.equal(result, null, "empty apiKey should yield null (→ mock fallback)");
  });

  it("非 mock 平台 apiKey 缺失时 resolveSystemPlatform 返回 null", () => {
    setPlatformConfig({
      platforms: {
        missingkey: {
          type: "dashscope",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        },
      },
      capabilities: {
        agent_turn: { platform: "missingkey", model: "qwen-plus" },
      },
    });
    const result = resolveSystemPlatform("agent_turn");
    assert.equal(result, null, "missing apiKey should yield null (→ mock fallback)");
  });

  it("缺 key 时 resolveSystemProviderForCapability 返回 mock（豁免 consent）", () => {
    setPlatformConfig({
      platforms: {
        bigmodel: {
          type: "openai_compatible",
          apiKey: "${UNSET_VAR}",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        },
      },
      capabilities: {
        agent_turn: { platform: "bigmodel", model: "glm-4.1V" },
      },
    });
    const providerType = resolveSystemProviderForCapability("agent_turn");
    assert.equal(providerType, "mock", "unresolved apiKey should resolve to mock for consent exemption");
  });

  it("mock 平台无需 apiKey 检查", () => {
    setPlatformConfig({
      platforms: {
        mymock: { type: "mock" },
      },
      capabilities: {
        agent_turn: { platform: "mymock", model: "mock-v1" },
      },
    });
    const result = resolveSystemPlatform("agent_turn");
    assert.ok(result, "mock platform should resolve even without apiKey");
    assert.equal(result!.type, "mock");
  });

  it("createProvider 对含 ${VAR} 的 apiKey fail-fast 报错", () => {
    assert.throws(
      () => createProvider("openai_compatible", { apiKey: "${MISSING_KEY}", baseUrl: "https://example.com", model: "test" }),
      /unresolved env var reference/i,
      "createProvider should fail-fast on literal ${VAR} apiKey",
    );
  });

  it("createProvider 对正常 apiKey 不报错", () => {
    // mock provider always works
    const provider = createProvider("mock", {});
    assert.ok(provider, "mock provider should be created without issues");
  });
});
