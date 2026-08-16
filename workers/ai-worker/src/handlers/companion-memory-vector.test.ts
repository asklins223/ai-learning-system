import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retrieveCompanionMemoriesKeyword,
  retrieveCompanionMemoriesVector,
  retrieveCompanionMemories,
  type EmbeddingProviderLike,
} from "./companion-memory-vector.ts";

function fakeTx(rows: unknown[]) {
  return {
    execute: async () => rows,
  };
}

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "goal",
  content: "这周掌握光合作用",
  importance: 0.8,
  pinned: true,
  last_used_at: null,
  user_confirmed: true,
};

test("keyword fallback 返回 active 记忆并按 importance/pinned 排序", async () => {
  const tx = fakeTx([ROW]);
  const result = await retrieveCompanionMemoriesKeyword(
    tx as never,
    { workspaceId: "w", userId: "u" },
    "光合",
    8,
  );
  assert.equal(result.mode, "keyword_fallback");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].memoryId, ROW.id);
  assert.equal(result.items[0].kind, "goal");
});

test("vector provider 返回 null 时自动降级 keyword", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock",
    embeddingModelId: "mock-v1",
    embed: async () => null,
  };
  const tx = fakeTx([ROW]);
  const result = await retrieveCompanionMemoriesVector(
    tx as never,
    { workspaceId: "w", userId: "u" },
    "光合",
    provider,
    8,
  );
  assert.equal(result.mode, "keyword_fallback");
  assert.equal(result.items[0].content, "这周掌握光合作用");
});

test("vector 模式返回 pgvector 行并标记 mode=vector", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock",
    embeddingModelId: "mock-v1",
    embed: async () => new Array(1024).fill(0.01),
  };
  const tx = fakeTx([ROW]);
  const result = await retrieveCompanionMemoriesVector(
    tx as never,
    { workspaceId: "w", userId: "u" },
    "光合",
    provider,
    8,
  );
  assert.equal(result.mode, "vector");
  assert.equal(result.items[0].pinned, true);
});

test("统一入口：未开启 flag 或没有 provider 时走 keyword", async () => {
  const previous = process.env.COMPANION_MEMORY_VECTOR_V1;
  process.env.COMPANION_MEMORY_VECTOR_V1 = "false";
  try {
    const tx = fakeTx([ROW]);
    const result = await retrieveCompanionMemories(
      tx as never,
      { workspaceId: "w", userId: "u" },
      "光合",
      { provider: null },
    );
    assert.equal(result.mode, "keyword_fallback");
  } finally {
    if (previous === undefined) delete process.env.COMPANION_MEMORY_VECTOR_V1;
    else process.env.COMPANION_MEMORY_VECTOR_V1 = previous;
  }
});
