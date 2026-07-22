/**
 * ai-provider.ts DB 依赖函数补充测试
 *
 * 通过 mock db 对象的 transaction/query 属性，
 * 测试 resolveProviderSelection 的核心业务逻辑分支。
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { resolveProviderSelection } from "../lib/ai-provider.ts";
import { encryptAiCredential } from "@ailearn/shared/ai-credentials";
import { db } from "../db.ts";

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";
const TEST_ENC_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

let originalTransaction: typeof db.transaction;
let originalUserAIModelConfigsFindFirst: any;
let originalWorkspacesFindFirst: any;
let originalEncKey: string | undefined;

before(() => {
  originalTransaction = db.transaction;
  if (db.query?.userAIModelConfigs?.findFirst) {
    originalUserAIModelConfigsFindFirst = db.query.userAIModelConfigs.findFirst;
  }
  if (db.query?.workspaces?.findFirst) {
    originalWorkspacesFindFirst = db.query.workspaces.findFirst;
  }
  originalEncKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
});

after(() => {
  db.transaction = originalTransaction;
  if (originalUserAIModelConfigsFindFirst && db.query?.userAIModelConfigs) {
    db.query.userAIModelConfigs.findFirst = originalUserAIModelConfigsFindFirst;
  }
  if (originalWorkspacesFindFirst && db.query?.workspaces) {
    db.query.workspaces.findFirst = originalWorkspacesFindFirst;
  }
  if (originalEncKey === undefined) {
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = originalEncKey;
  }
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
      userAIModelConfigs: {
        findFirst: async () => undefined,
        findMany: async () => [],
      },
      workspaces: {
        findFirst: async () => undefined,
        findMany: async () => [],
      },
    },
  };
}

function setupDbMock(hasPersonalConfig: boolean = false, hasWorkspaceProvider: boolean = false) {
  const mockTx = createMockTx();
  db.transaction = (async (fn: any) => fn(mockTx)) as typeof db.transaction;

  if (hasPersonalConfig) {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENC_KEY;
    const encryptedKey = encryptAiCredential("test-api-key-value", USER_ID, TEST_ENC_KEY);
    (db.query!.userAIModelConfigs!.findFirst as any) = async () => ({
      provider: "openai_compatible",
      baseUrl: "https://api.openai.com",
      model: "gpt-4",
      apiKeyEncrypted: encryptedKey,
    });
  }

  if (hasWorkspaceProvider) {
    (db.query!.workspaces!.findFirst as any) = async () => ({
      aiProvider: "dashscope",
    });
  }
}

describe("ai-provider resolveProviderSelection (DB mock)", () => {
  it("有 userId 优先使用个人配置", async () => {
    setupDbMock(true, false);
    const result = await resolveProviderSelection(WS_ID, USER_ID);
    assert.equal(result.providerName, "openai_compatible");
    assert.ok(result.config);
    assert.equal((result.config as any).provider, "openai_compatible");
  });

  it("无 userId 有 workspaceId 时使用 workspace 配置", async () => {
    setupDbMock(false, true);
    const result = await resolveProviderSelection(WS_ID, undefined);
    assert.equal(result.providerName, "dashscope");
    assert.deepEqual(result.config, {});
  });

  it("无 userId 且无 workspaceId 时使用环境变量", async () => {
    setupDbMock(false, false);
    const oldEnv = process.env.AI_PROVIDER_CARD;
    process.env.AI_PROVIDER_CARD = "mock";
    try {
      const result = await resolveProviderSelection(undefined, undefined);
      assert.equal(result.providerName, "mock");
    } finally {
      if (oldEnv === undefined) delete process.env.AI_PROVIDER_CARD;
      else process.env.AI_PROVIDER_CARD = oldEnv;
    }
  });

  it("无 userId 且无 workspaceId 且无环境变量时默认为 mock", async () => {
    const oldEnv = process.env.AI_PROVIDER_CARD;
    delete process.env.AI_PROVIDER_CARD;
    try {
      setupDbMock(false, false);
      const result = await resolveProviderSelection(undefined, undefined);
      assert.equal(result.providerName, "mock");
    } finally {
      if (oldEnv !== undefined) process.env.AI_PROVIDER_CARD = oldEnv;
    }
  });
});
