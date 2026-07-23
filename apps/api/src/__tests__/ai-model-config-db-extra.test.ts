import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { db } from "../db/client.ts";
import {
  getPersonalAIModelConfig,
  savePersonalAIModelConfig,
} from "../modules/identity/ai-model-config.ts";

const originalDelete = db.delete;
const originalFindFirst = db.query.userAIModelConfigs.findFirst;

afterEach(() => {
  (db as any).delete = originalDelete;
  (db.query.userAIModelConfigs as any).findFirst = originalFindFirst;
});

describe("system default AI model configuration", () => {
  it("treats a legacy mock row as system default rather than a personal override", async () => {
    (db.query.userAIModelConfigs as any).findFirst = async () => ({
      provider: "mock",
      baseUrl: null,
      model: null,
      apiKeyHint: null,
      updatedAt: new Date("2026-07-23T00:00:00Z"),
    });

    const result = await getPersonalAIModelConfig("user-1");
    assert.equal(result.configured, false);
    assert.equal(result.provider, "mock");
  });

  it("removes the personal override when the user selects system default", async () => {
    let deleted = false;
    (db as any).delete = () => ({
      where: async () => {
        deleted = true;
      },
    });
    (db.query.userAIModelConfigs as any).findFirst = async () => undefined;

    const result = await savePersonalAIModelConfig("user-1", { provider: "mock" });
    assert.equal(deleted, true);
    assert.equal(result.configured, false);
    assert.equal(result.provider, null);
  });
});
