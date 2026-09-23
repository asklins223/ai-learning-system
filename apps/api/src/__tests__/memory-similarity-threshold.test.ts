/**
 * `similarity()` 这一族判据只准有一个数（doc 34 L14 的守卫）。
 *
 * 为什么要静态拦：冲突分组（api 侧）与"忽略过的候选别再抽出来"（worker 抽取器）
 * 读的是同一个常量，而它们分属两个进程、两份 import。谁在 SQL 里顺手写一个 `> 0.85`，
 * 两边就会悄悄分叉——同一句话在一边算重复、另一边算新事，而 typecheck 与单测都不会红。
 *
 * 只管 SQL 的 `similarity(`。`companion-thought.ts` 里的 `embeddingDuplicateThreshold: 0.85`
 * 是**向量余弦**的另一套判据，数值相同纯属巧合，不要为了"统一"把它们并成一个常量。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const CONSTANT_NAME = "MEMORY_CONTENT_SIMILARITY_THRESHOLD";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "integration-tests") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const scanned = [
  ...sourceFiles(join(REPO_ROOT, "apps", "api", "src")),
  ...sourceFiles(join(REPO_ROOT, "workers", "ai-worker", "src")),
];

const sites = scanned
  .map((file) => ({ file: relative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
  .filter((entry) => /\bsimilarity\(/.test(entry.source));

test("扫描确实读到了东西（读不到时这条门禁就是假绿）", () => {
  assert.ok(sites.length >= 2, `只找到 ${sites.length} 处 similarity() 调用，判据可能已经搬家`);
  assert.ok(
    sites.every((entry) => entry.source.includes(CONSTANT_NAME)),
    `这些文件调用了 similarity() 却没引用共用常量：${sites
      .filter((entry) => !entry.source.includes(CONSTANT_NAME))
      .map((entry) => entry.file)
      .join(", ")}`,
  );
});

test("阈值不许在 SQL 里被重写成第二个数", () => {
  for (const entry of sites) {
    const hardcoded = entry.source.match(/similarity\([^)]*\)\s*[><]=?\s*\d+(\.\d+)?/g) ?? [];
    assert.deepEqual(hardcoded, [], `${entry.file} 里写了字面量阈值：${hardcoded.join(" / ")}`);
  }
});

// ─── 语义（向量余弦）那一族：同一个仓库里只准有一处把 `<=>` 和阈值拼起来 ───

const vectorSites = scanned
  .map((file) => ({ file: relative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
  .filter((entry) => /<=>/.test(entry.source));
const sharedBuilder = join(REPO_ROOT, "packages", "shared", "src", "db-schema", "assistant-memory.ts");
const rawThresholdSites = vectorSites.filter(
  (entry) =>
    !/semanticTwinPredicateSql\(|MEMORY_SEMANTIC_SIMILARITY_THRESHOLD/.test(entry.source)
    && /(>\s*0\.\d+|MEMORY_SEMANTIC_SIMILARITY_THRESHOLD)/.test(entry.source),
);

test("共享表达式真的有两个进程在用（只剩一个用就等于没去重）", () => {
  const users = scanned
    .map((file) => relative(REPO_ROOT, file))
    .filter((name) => readFileSync(join(REPO_ROOT, name), "utf8").match(/semanticTwinPredicateSql\(|MEMORY_SEMANTIC_SIMILARITY_THRESHOLD/));
  assert.deepEqual(
    users.filter((name) => name.startsWith("packages/")),
    [],
    "shared 自己不该出现在这份清单里",
  );
  const inWorker = users.some((name) => name.startsWith("workers/"));
  const inApi = users.some((name) => name.startsWith("apps/api/"));
  assert.ok(
    inWorker && inApi,
    `两侧都要引用共享判据（常量或表达式），实际：${users.join(", ") || "0 处"}`,
  );
});

test("所有 <=> 比较都走共享的 semanticTwinPredicateSql，不许自己写阈值", () => {
  assert.deepEqual(
    rawThresholdSites.map((entry) => entry.file),
    [],
    `这些文件自带了语义阈值：${rawThresholdSites.map((entry) => entry.file).join(", ")}。` +
      "阈值只准出现在 MEMORY_SEMANTIC_SIMILARITY_THRESHOLD 一处。",
  );
});

test("共享表达式真的带着那个常量（不是退化成空字符串）", async () => {
  const source = readFileSync(sharedBuilder, "utf8");
  const { semanticTwinPredicateSql, MEMORY_SEMANTIC_SIMILARITY_THRESHOLD } = await import(
    "@ailearn/shared/db-schema/assistant-memory"
  );
  const built = semanticTwinPredicateSql("a.embedding", "b.embedding::vector");
  assert.match(built, /a\.embedding <=> b\.embedding::vector/);
  assert.ok(built.includes(String(MEMORY_SEMANTIC_SIMILARITY_THRESHOLD)), built);
  assert.ok(source.includes("MEMORY_SEMANTIC_SIMILARITY_THRESHOLD"));
});
