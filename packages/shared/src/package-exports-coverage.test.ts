/**
 * `@ailearn/shared/<sub>` 的深导入必须都在 `packages/shared/package.json` 的 `exports` 里登记。
 *
 * 为什么要有这条（39d #28，2026-09-25 实测）：宿主上 tsconfig 的 `paths` 把
 * `@ailearn/shared/*` 直接映射到 `packages/shared/src/*.ts`，所以**新加一个没登记的子路径
 * 在本机 typecheck 与全部用例里都是绿的**；而 dev 容器里那条映射不生效，运行时按
 * package exports 解析 ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED` ⇒ api 与 worker 两个进程一起崩，
 * 桌面端整屏落到「学习服务暂时不可用」。那一轮我把两个 dev 服务打挂了 46 分钟才发。
 *
 * 两个方向都核：代码导出了但没登记（会崩），登记了但文件不在（假出口）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHARED = join(REPO, "packages", "shared");
const SCAN_ROOTS = [
  join(REPO, "apps", "api", "src"),
  join(REPO, "apps", "desktop-client", "src"),
  join(REPO, "workers", "ai-worker", "src"),
  join(REPO, "workers", "ai-worker", "scripts"),
  SHARED,
];
const SKIP = new Set(["node_modules", "dist", "out", "coverage"]);
const DEEP_IMPORT = /@ailearn\/shared\/([A-Za-z0-9._/-]+)/g;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) found.push(path);
  }
  return found;
}

interface ExportEntry {
  sub: string;
  target: string;
}

function readExports(): ExportEntry[] {
  const manifest = JSON.parse(readFileSync(join(SHARED, "package.json"), "utf8")) as {
    exports: Record<string, { import?: string; default?: string }>;
  };
  return Object.entries(manifest.exports).map(([sub, map]) => ({
    sub: sub.replace(/^\.\//, ""),
    // 目录式出口（`./db-schema` → `./src/db-schema/index.ts`）是合法形状，不能按同名 .ts 找
    target: map.import ?? map.default ?? "",
  }));
}

/** 收集"代码里出现过的子路径 → 出现在哪些文件"。 */
function collectImports(): Map<string, string[]> {
  const bySub = new Map<string, string[]>();
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(DEEP_IMPORT)) {
        const list = bySub.get(match[1]) ?? [];
        list.push(file.slice(REPO.length + 1));
        bySub.set(match[1], list);
      }
    }
  }
  return bySub;
}

function unregisteredImports(exports: ExportEntry[], imports: Map<string, string[]>): string[] {
  const declared = new Set(exports.map((e) => e.sub));
  return [...imports.keys()].filter((sub) => !declared.has(sub)).sort();
}

function danglingExports(exports: ExportEntry[]): string[] {
  return exports
    .filter((entry) => entry.target && !existsSync(join(SHARED, entry.target)))
    .map((entry) => `./${entry.sub} → ${entry.target}`)
    .sort();
}

test("深导入与 exports 对得上：两边都不许有孤儿", () => {
  const exports = readExports();
  const imports = collectImports();
  // 分母自证：这条判据要是读不到任何深导入，"0 个未登记"就是假绿。
  assert.ok(imports.size >= 20, `读到的深导入太少（${imports.size}），这条判据没在读东西`);
  assert.deepEqual(unregisteredImports(exports, imports), [],
    `这些 @ailearn/shared/* 子路径被代码导出了，但没登记进 packages/shared/package.json 的 exports`
    + `（宿主靠 tsconfig paths 能跑，dev 容器按 exports 解析会 ERR_PACKAGE_PATH_NOT_EXPORTED 把 api/worker 打挂）`);
  assert.deepEqual(danglingExports(exports), [],
    "exports 指到的文件不存在（出口是假的）");
});

test("自证：这两条判据读得到东西，也会在被破坏时红", () => {
  const exports = readExports();
  const base = new Map([["companion-leak-gates", ["apps/api/src/x.ts"]]]);
  assert.deepEqual(unregisteredImports(exports, base), [],
    "已登记的那条不该被点名——否则分母判的是名字而不是登记");
  assert.deepEqual(unregisteredImports(exports, new Map([["definitely-not-declared-subpath", ["a.ts"]]])),
    ["definitely-not-declared-subpath"], "没登记的必须点名");
  assert.deepEqual(danglingExports([{ sub: "companion-leak-gates", target: "./src/no-such-file.ts" }]),
    ["./companion-leak-gates → ./src/no-such-file.ts"], "指向不存在文件的必须点名");
  // 目录式出口是合法形状：不能被这条判据误伤（第一版就把它报成了孤儿）
  const dirStyle = exports.find((entry) => entry.target.endsWith("index.ts"));
  assert.ok(dirStyle, "这份 manifest 里应该有目录式出口");
  assert.ok(!danglingExports([dirStyle]).length, `目录式出口 ${dirStyle.sub} 不该被报成悬空`);
});
