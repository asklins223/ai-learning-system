/**
 * `jobs.status` 的过滤条件只能用"真写得出"的值（doc 34 L29）。
 *
 * `job_status` 枚举里有 `failed`，但没有任何写入者：三支队列 SQL 函数
 * （`0113` fail / `0221` reap / `0228` claim）只会写 `pending`、`running`、
 * `succeeded`、`dead`。于是 `inArray(jobs.status, ["failed", "dead"])` 这种写法
 * 不会报错，只会让人以为"失败的任务也被算进来了"——而那半条谓词永远为空。
 * 这跟本审计一路在抓的形状是同一个：**读侧引用了写侧产不出的值**。
 *
 * 断言落在源码上（跟着 api 单元 job 跑），因为库里的枚举值本身没有测试会去碰它。
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

// 本文件在 apps/api/src/__tests__ 下：向上三层是 apps/api（grep 的工作目录），
// 再向上一层才是仓库根。两个目录各用各的，别拿仓库根去 grep `src`——那样永远零命中，
// 而零命中会被下面的元断言抓住（这次就是它先报的）。
const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

/** 队列函数真写得出的状态（对着上面那三支迁移核过）。 */
const WRITABLE = new Set(["pending", "running", "succeeded", "dead"]);

function sources(): string[] {
  try {
    return execSync(
      "grep -rln --exclude-dir=node_modules --exclude=*.test.ts 'jobs.status' src | sort",
      { cwd: packageRoot, encoding: "utf8" },
    ).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("jobs.status 的过滤值都必须写得出", () => {
  const files = sources();

  it("扫到了引用点（空集不算通过）", () => {
    assert.ok(files.length > 0, "一条 `jobs.status` 引用都没扫到，八成是路径或 grep 坏了");
  });

  for (const file of files) {
    const path = join(packageRoot, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    // 只看数组形态的过滤条件：inArray(jobs.status, [...]) / eq(jobs.status, "...")
    // 必须绑在同一个 `inArray(jobs.status, [...])` 上：宽一点的跨行匹配会把
    // 别的表的数组（如 cardGenerationRunsV2.status 的 needs_attention/failed/stale）
    // 一起吞进来，那不是我这条断言要管的东西。
    for (const match of text.matchAll(/inArray\(\s*jobs\.status\s*,\s*\[([^\]]*)\]/g)) {
      const values = [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "");
      if (values.length === 0) continue;
      it(`${file} 用了 ${values.join("/")}`, () => {
        for (const value of values) {
          assert.ok(
            WRITABLE.has(value),
            `\`${value}\` 没有任何写入者：队列函数只写 ${[...WRITABLE].join("/")}——`
            + "这一半谓词永远为空，读出来却像是已经算上了",
          );
        }
      });
    }
    for (const match of text.matchAll(/jobs\.status,\s*"([a-z_]+)"/g)) {
      const value = match[1] ?? "";
      if (!value) continue;
      it(`${file} 等值比较 ${value}`, () => {
        assert.ok(WRITABLE.has(value), `\`${value}\` 写不出来，等值判断永远假`);
      });
    }
  }
});
