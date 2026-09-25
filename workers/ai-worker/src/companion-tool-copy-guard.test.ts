/**
 * 伴星工具回执文案守卫（静态，不连库、不调模型）。
 *
 * 为什么要有：库里留着五条英文回执（`companion_agent_tool_calls.result_safe_summary`，
 * 09-19…09-22）——`agent action payload failed domain validation`、
 * `card not found in current workspace`、`tool arguments failed schema validation`。
 * 那一列会进她看得见的轨迹，界面上长成「正在看到期复习 ｜ tool arguments failed schema
 * validation ｜ 失败」。文案翻译已经把这批换成了中文，但换掉不等于换不回来：
 * 抛错点就在工具执行体里，随手一句英文调试信息就会又印到屏上。
 *
 * 判据只看**会产生回执的两类字面量**：
 *   ① `new CompanionToolError("…")`（失败路径上被拿去当回执的那句）
 *   ② `safeSummary: "…"` / `safeSummary: \`…\``（成功路径的回执）
 * 每条都必须含汉字。注释先剥掉——注册表里有一句正是**引用**旧英文串来解释这件事，
 * 不剥注释就会把说明当成缺陷。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HANDLERS_DIR = new URL("./handlers", import.meta.url).pathname;

const CJK = /[\u4e00-\u9fff]/;

const COPY_SHAPES: { name: string; re: RegExp }[] = [
  { name: "CompanionToolError", re: /new\s+CompanionToolError\(\s*(?:"([^"]*)"|`([^`]*)`)/g },
  { name: "safeSummary", re: /safeSummary:\s*(?:"([^"]*)"|`([^`]*)`)/g },
];

/** 剥掉行注释与块注释，再把源码切成「文案字面量」清单。 */
function copyLiterals(source: string): { shape: string; text: string }[] {
  const withoutLineComments = source.replace(/^[ \t]*\/\/.*$/gm, "");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: { shape: string; text: string }[] = [];
  for (const { name, re } of COPY_SHAPES) {
    // 每次现取一个新 lastIndex：这几个正则带 /g，跨调用共享 lastIndex 会漏读。
    const scanner = new RegExp(re.source, "g");
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(withoutBlockComments)) !== null) {
      const raw = match[1] ?? match[2] ?? "";
      // 模板串里 ${…} 是运行时插值，判据只看静态那几段文字。
      const staticText = raw.replace(/\$\{[^}]*\}/g, "");
      if (staticText.trim() === "") continue;
      found.push({ shape: name, text: staticText });
    }
  }
  return found;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [full] : [];
  });
}

test("伴星工具回执的两句字面量都得是中文（失败回执也会上屏）", () => {
  const files = tsFiles(HANDLERS_DIR);
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个 handler 文件，判据可能扫空了`);

  const all = files.flatMap((file) => copyLiterals(readFileSync(file, "utf8")).map((entry) => ({
    ...entry, file: file.slice(HANDLERS_DIR.length + 1),
  })));
  assert.ok(all.length >= 20, `只读到 ${all.length} 条回执字面量，判据可能扫空了`);

  const offenders = all
    .filter((entry) => !CJK.test(entry.text))
    .map((entry) => `${entry.file}  ${entry.shape}: ${entry.text.slice(0, 40)}`);
  assert.deepEqual(offenders, [], "这些回执会原样进她看得见的轨迹（这一列会上屏）");

  // 两类都得真扫到东西：少了任何一类，上面那句就等于只守了半面。
  for (const shape of ["CompanionToolError", "safeSummary"]) {
    assert.ok(all.some((entry) => entry.shape === shape), `${shape} 这一类一条都没读到，判据在空跑`);
  }
});

test("正负对照：认得出英文回执，也不会把注释里的引用当成缺陷", () => {
  const synthetic = [
    `if (!x) throw new CompanionToolError("card not found in current workspace");`,
    `return { value: v, safeSummary: "tool arguments failed schema validation" };`,
    `// 旧文案是 new CompanionToolError("memory not found in current workspace")，已翻`,
    `/* safeSummary: "note not found in current workspace" 这句写在块注释里 */`,
    `return { value: v, safeSummary: \`找到 ${"${tasks.length}"} 个待办任务\` };`,
  ].join("\n");
  const hits = copyLiterals(synthetic);
  assert.deepEqual(
    hits.filter((entry) => !CJK.test(entry.text)).map((entry) => entry.shape).sort(),
    ["CompanionToolError", "safeSummary"],
    "两条该报的没都报出来（或者把注释里的引用误报了）",
  );
  // 正控制第二半：合规那条（模板串带汉字）必须被读进来且不算违规。
  assert.ok(hits.some((entry) => entry.shape === "safeSummary" && CJK.test(entry.text)),
    "模板串形状没被读到");
});
