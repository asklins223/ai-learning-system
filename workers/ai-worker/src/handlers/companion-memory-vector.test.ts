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

// ─── 并集补召回（方案 29 §9.9）：取代旧的 hasReady 探测 ───────────────────
// 旧行为漏掉最常见的状态：用户已有若干 ready 向量、刚写的那条还在 pending，
// 主查询非空 → 不降级 → 新记忆结构性隐身（活体：写完"图书馆三楼"下一条就记不得）。

function memoryRow(id: string, content: string) {
  return {
    id, kind: "preference", content, importance: 0.8,
    pinned: false, last_used_at: null, user_confirmed: true,
  };
}

/** 按查询形态分流的假事务：含 `<=>` 的是向量主查询，其余是 keyword 补召回。 */
function routingTx(vectorRows: unknown[], keywordRows: unknown[]) {
  const queries: string[] = [];
  return {
    queries,
    execute: async (query: unknown) => {
      const text = sqlTemplateText(query);
      queries.push(text);
      return text.includes("<=>") ? vectorRows : keywordRows;
    },
  };
}

test("并集：向量命中的与缺向量的合并去重，向量侧优先", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock", embeddingModelId: "mock-v1", embed: async () => new Array(1024).fill(0.01),
  };
  const tx = routingTx(
    [memoryRow("11111111-1111-4111-8111-111111111111", "喜欢用语音交流")],
    [
      memoryRow("22222222-2222-4222-8222-222222222222", "习惯在图书馆三楼复习"),
      // 同一 id 两侧都出现：必须去重，不能往 prompt 里塞两遍。
      memoryRow("11111111-1111-4111-8111-111111111111", "喜欢用语音交流"),
    ],
  );
  const result = await retrieveCompanionMemoriesVector(
    tx as never, { workspaceId: "w", userId: "u" }, "在哪儿复习", provider, 8,
  );
  assert.equal(result.mode, "vector", "向量侧有命中时模式仍是 vector");
  assert.deepEqual(result.items.map((i) => i.content), [
    "喜欢用语音交流", "习惯在图书馆三楼复习",
  ], "新写的 pending 记忆必须被补召回带回来");
});

test("全部条目都有 ready 向量且向量无命中 → 仍是空集（并集不得引入乱召回）", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock", embeddingModelId: "mock-v1", embed: async () => new Array(1024).fill(0.01),
  };
  const tx = routingTx([], []);
  const result = await retrieveCompanionMemoriesVector(
    tx as never, { workspaceId: "w", userId: "u" }, "光合", provider, 8,
  );
  assert.equal(result.items.length, 0);
  assert.equal(result.mode, "keyword_fallback");
});

test("补召回 SQL 必须带与主查询一致的 scope 过滤，且只取缺 ready 向量的行", async () => {
  const provider: EmbeddingProviderLike = {
    id: "mock", embeddingModelId: "mock-v1", embed: async () => new Array(1024).fill(0.01),
  };
  const tx = routingTx([], []);
  await retrieveCompanionMemoriesVector(
    tx as never, { workspaceId: "w", userId: "u" }, "光合", provider, 8, "task",
  );
  const supplement = tx.queries.find((q) => !q.includes("<=>"));
  assert.ok(supplement, "必须发出补召回查询");
  // 2026-08-22 审查那条不变量换了宿主，不能丢：补召回的 scope 条件必须与主查询同形，
  // 否则跨 scope 的 pending 记忆会被错误召回/漏召回。
  assert.ok(
    supplement.includes("scope = 'workspace' OR scope = 'global' OR scope ="),
    `补召回缺 scope 过滤: ${supplement}`,
  );
  assert.ok(supplement.includes("NOT EXISTS"), "必须只取向量侧看不见的行");
  assert.ok(supplement.includes("embedding_status <> 'ready'"), "pending 行要被纳入");
  assert.ok(supplement.includes("mock-v1"), "必须按当前 embedding 模型判定可见性");
});

// ─── ILIKE 语义（2026-09-20 §9.9）───────────────────────────────────────
// 假事务永远评估不了 SQL，所以这类 bug 只能靠"断言生成的模式形状"兜住：
// LIKE 模式不带 % 就是**全等比较**，`'习惯在图书馆三楼复习' ILIKE '复习'` 为假——
// keyword 检索因此长期形同虚设（memory_usage_log 290 行清一色 vector 就是证据）。

test("keyword 检索：content 必须生成 %子串% 模式，kind 保持全等", async () => {
  const tx = capturingTx([]);
  await retrieveCompanionMemoriesKeyword(
    tx as never, { workspaceId: "w", userId: "u" }, "我平时都在哪儿复习来着",
  );
  assert.equal(tx.queries.length, 1);
  const sqlText = tx.queries[0];
  assert.ok(/%[^%"]*%/.test(sqlText), `content 模式必须带通配符: ${sqlText}`);
  // 两个数组字面量：content 带 %，kind 不带。
  const literals = [...sqlText.matchAll(/\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(literals.some((l) => l.includes("%")), "存在带 % 的内容模式");
  assert.ok(literals.some((l) => !l.includes("%")), "存在不带 % 的 kind 模式");
});
