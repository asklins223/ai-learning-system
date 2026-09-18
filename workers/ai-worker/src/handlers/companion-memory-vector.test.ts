import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractQueryKeywords,
  retrieveCompanionMemoriesKeyword,
  retrieveCompanionMemoriesVector,
  retrieveCompanionMemories,
  toTextArrayLiteral,
  type EmbeddingProviderLike,
} from "./companion-memory-vector.ts";

function fakeTx(rows: unknown[]) {
  return {
    execute: async () => rows,
  };
}

/** 捕获 SQL 文本的假事务（验证 keyword fallback 生成的查询形态）。 */
function capturingTx(rows: unknown[]) {
  const queries: string[] = [];
  return {
    queries,
    execute: async (query: unknown) => {
      queries.push(sqlTemplateText(query));
      return rows;
    },
  };
}

/** 提取 drizzle sql`` 模板的静态文本（递归展开嵌套 SQL 块）。 */
function sqlTemplateText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((c) => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object") {
      if (Array.isArray((c as { value?: unknown }).value)) {
        return (c as { value: unknown[] }).value.map(String).join("");
      }
      if (Array.isArray((c as { queryChunks?: unknown[] }).queryChunks)) {
        return sqlTemplateText(c);
      }
    }
    return "";
  }).join("");
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

test("extractQueryKeywords 拉丁词整体保留、过滤单字母", () => {
  const keywords = extractQueryKeywords("light reaction 怎么理解？a I");
  assert.ok(keywords.includes("light"));
  assert.ok(keywords.includes("reaction"));
  assert.ok(!keywords.includes("a"));
  assert.ok(!keywords.includes("I"));
});

test("extractQueryKeywords 长 CJK 段切重叠 bigram（无词边界兜底）", () => {
  // 整句"今天我们聊聊光合作用吧"作为单个关键词永远匹配不到记忆
  // "这周掌握光合作用"；bigram 必须产出"光合"这类可命中子串。
  const keywords = extractQueryKeywords("今天我们聊聊光合作用吧");
  assert.ok(keywords.includes("光合"), `bigrams: ${keywords.join(",")}`);
  assert.ok(keywords.includes("作用"));
  assert.ok(!keywords.includes("今天我们聊聊光合作用吧"));
});

test("extractQueryKeywords bigram 超预算时头尾采样，不丢句尾语义重心", () => {
  // 16 字 run → 15 个 bigram > 默认 12：顺序截断会恰好丢掉句尾的"有机化学"。
  const keywords = extractQueryKeywords("我上周说过这周想重点突破有机化学");
  assert.ok(keywords.length <= 12);
  assert.ok(keywords.includes("有机"), `head+tail sample: ${keywords.join(",")}`);
  assert.ok(keywords.includes("化学"), `head+tail sample: ${keywords.join(",")}`);
  assert.ok(keywords.includes("这周"));
});

test("extractQueryKeywords 无边界的 CJK 长串切 bigram（短串整段保留）", () => {
  // "复习光合作用" 是单个无边界 token：>4 字切 bigram（含可命中的"光合"/"作用"）。
  const longRun = extractQueryKeywords("复习光合作用");
  assert.ok(longRun.includes("复习"));
  assert.ok(longRun.includes("光合"));
  assert.ok(longRun.includes("作用"));
  // ≤4 字的 Han 段整体保留（子串匹配短语比 bigram 精准）。
  const short = extractQueryKeywords("细胞呼吸");
  assert.deepEqual(short, ["细胞呼吸"]);
});

test("extractQueryKeywords 混排 token 拆出拉丁与 Han", () => {
  const keywords = extractQueryKeywords("DNA复制过程");
  assert.ok(keywords.includes("DNA"));
  // "复制过程" 为 4 字 Han 段，整体保留。
  assert.ok(keywords.includes("复制过程"));
});

test("extractQueryKeywords 封顶 maxKeywords 且去重", () => {
  const keywords = extractQueryKeywords("光合作用光反应类囊体基质", 5);
  assert.ok(keywords.length <= 5);
  assert.equal(new Set(keywords).size, keywords.length);
});

test("extractQueryKeywords 空白/标点输入返回空数组", () => {
  assert.deepEqual(extractQueryKeywords("？！。，"), []);
  assert.deepEqual(extractQueryKeywords(""), []);
});

test("toTextArrayLiteral 序列化转义引号与反斜杠", () => {
  assert.equal(toTextArrayLiteral(["光合"]), '{"光合"}');
  assert.equal(toTextArrayLiteral(['a"b', "c\\d"]), '{"a\\"b","c\\\\d"}');
});

test("keyword fallback 无关键词时不加 ILIKE 过滤（规则排序兜底）", async () => {
  const tx = capturingTx([ROW]);
  await retrieveCompanionMemoriesKeyword(tx as never, { workspaceId: "w", userId: "u" }, "？！。", 8);
  assert.equal(tx.queries.length, 1);
  assert.ok(!tx.queries[0].includes("ILIKE ANY"));
});

test("keyword fallback 有关键词时生成 ILIKE ANY 匹配", async () => {
  const tx = capturingTx([ROW]);
  await retrieveCompanionMemoriesKeyword(tx as never, { workspaceId: "w", userId: "u" }, "光合作用 light reaction", 8);
  assert.equal(tx.queries.length, 1);
  assert.ok(tx.queries[0].includes("ILIKE ANY"));
});

test("keyword fallback scope 过滤包含 global（scope 死维度修复）", async () => {
  const tx = capturingTx([ROW]);
  await retrieveCompanionMemoriesKeyword(
    tx as never,
    { workspaceId: "w", userId: "u" },
    "光合",
    8,
    "task",
  );
  assert.ok(tx.queries[0].includes("'workspace' OR scope = 'global' OR scope ="));
});

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

test("统一入口：事务外预计算的向量不再触发 provider.embed（外部调用不占事务）", async () => {
  const previous = process.env.COMPANION_MEMORY_VECTOR_V1;
  process.env.COMPANION_MEMORY_VECTOR_V1 = "true";
  try {
    let embedCalls = 0;
    const provider: EmbeddingProviderLike = {
      id: "mock",
      embeddingModelId: "mock-v1",
      embed: async () => {
        embedCalls += 1;
        return new Array(1024).fill(0.01);
      },
    };
    const tx = fakeTx([ROW]);
    const result = await retrieveCompanionMemories(
      tx as never,
      { workspaceId: "w", userId: "u" },
      "光合",
      { provider, precomputedEmbedding: new Array(1024).fill(0.02) },
    );
    assert.equal(result.mode, "vector");
    assert.equal(embedCalls, 0, "预计算向量必须直接使用，不得在事务内再次 embed");
  } finally {
    if (previous === undefined) delete process.env.COMPANION_MEMORY_VECTOR_V1;
    else process.env.COMPANION_MEMORY_VECTOR_V1 = previous;
  }
});

test("统一入口：预计算失败（null）直接 keyword，绝不在事务内重试外部调用", async () => {
  const previous = process.env.COMPANION_MEMORY_VECTOR_V1;
  process.env.COMPANION_MEMORY_VECTOR_V1 = "true";
  try {
    let embedCalls = 0;
    const provider: EmbeddingProviderLike = {
      id: "mock",
      embeddingModelId: "mock-v1",
      embed: async () => {
        embedCalls += 1;
        return new Array(1024).fill(0.01);
      },
    };
    const tx = fakeTx([ROW]);
    const result = await retrieveCompanionMemories(
      tx as never,
      { workspaceId: "w", userId: "u" },
      "光合",
      { provider, precomputedEmbedding: null },
    );
    assert.equal(result.mode, "keyword_fallback");
    assert.equal(embedCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_MEMORY_VECTOR_V1;
    else process.env.COMPANION_MEMORY_VECTOR_V1 = previous;
  }
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

test("vector 空结果且无 ready embedding 时降级 keyword（修复零召回窗口）", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock",
    embeddingModelId: "mock-v1",
    embed: async () => new Array(1024).fill(0.01),
  };
  // 主查询返回空集；EXISTS 检查返回 false（还没有任何 ready embedding）。
  const calls: string[] = [];
  const tx = {
    execute: async (query: unknown) => {
      const text = sqlTemplateText(query);
      calls.push(text);
      if (text.includes("EXISTS")) return [{ has_ready: false }];
      return [];
    },
  };
  const result = await retrieveCompanionMemoriesVector(tx as never, { workspaceId: "w", userId: "u" }, "光合", provider, 8);
  assert.equal(result.mode, "keyword_fallback");
  assert.ok(calls.some((c) => c.includes("EXISTS")));
});

test("vector 空结果但存在 ready embedding 时保持空集（真正无相关记忆）", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock",
    embeddingModelId: "mock-v1",
    embed: async () => new Array(1024).fill(0.01),
  };
  const tx = {
    execute: async (query: unknown) => {
      const text = sqlTemplateText(query);
      if (text.includes("EXISTS")) return [{ has_ready: true }];
      return [];
    },
  };
  const result = await retrieveCompanionMemoriesVector(tx as never, { workspaceId: "w", userId: "u" }, "光合", provider, 8);
  assert.equal(result.mode, "vector");
  assert.equal(result.items.length, 0);
});

test("EXISTS 探测带 scope 过滤，与主检索一致（防跨 scope 误判 ready）", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock",
    embeddingModelId: "mock-v1",
    embed: async () => new Array(1024).fill(0.01),
  };
  // 主查询空集 + EXISTS 返回 true：探测 SQL 必须含与主查询相同的 scope 条件，
  // 否则只有其他 scope 的 ready embedding 时会误判"有 ready"而不降级 keyword。
  const calls: string[] = [];
  const tx = {
    execute: async (query: unknown) => {
      const text = sqlTemplateText(query);
      calls.push(text);
      if (text.includes("EXISTS")) return [{ has_ready: true }];
      return [];
    },
  };
  await retrieveCompanionMemoriesVector(
    tx as never,
    { workspaceId: "w", userId: "u" },
    "光合",
    provider,
    8,
    "task",
  );
  const existsSql = calls.find((c) => c.includes("EXISTS"));
  assert.ok(existsSql, "zero-recall window probe should be issued");
  assert.ok(
    existsSql.includes("m.scope = 'workspace' OR m.scope = 'global' OR m.scope ="),
    `EXISTS probe missing scope filter: ${existsSql}`,
  );
});
