// @vitest-environment node

/**
 * 一屏之上，同一个量词不许既表示**序号**又表示**计数**（39d §19，2026-09-25 两处实伤）。
 *
 * 病形状：笔记页资料卡片写 `来源片段 00`（那是首段序号 0 基补零），页眉写 `来源片段 72`
 * （那是条数）——伴星在真窗口照着念出「来源片段屏上只挂了 1 段（标着「来源片段 00」）」；
 * 来源详情页是同一族（批注 `片段 02` 与页签 `片段 72` 同屏）。
 *
 * 两条判据都带**合成正控制**：这条判据第一版只认模板字符串，JSX 那一种写法看不见，
 * 于是我拿它得出过"全仓 0 命中"——那是探针瞎，不是没有；`\b` 包中日韩词同样永远不成立。
 * 所以"0 命中"这两个字必须有正控制背书才算读数。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = fileURLToPath(new URL("../renderer/src", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "out"]);
const MEASURE = /(片段|段|条|项|张|个|篇|次)/;
/** 模板字符串里：名词紧贴一个 ordinal/index 插值。 */
const TEMPLATE_ORDINAL = /`[^`]*\$\{[^}]*(ordinal|index|idx)\b[^}]*\}[^`]*`/g;
/** JSX 里：`片段 {String(x.ordinal + 1)…}`，没有反引号，上一版就是漏在这里。 */
const JSX_ORDINAL = /([一-鿿]{2,6})\s*\{[^}]*\b(ordinal|index|idx)\b[^}]*\}/g;
/** 计数那一面：同名词跟着 `.length`／`count`／`Total`。 */
const JSX_COUNT = (noun: string) => new RegExp(`${noun}\\s*\\{[^}]*\\b(length|count|Total)\\b`, "g");

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...sources(path));
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

/** 屏上把序号标成计数的文件（JSX 与模板两种写法都看）。 */
function collidingFiles(): string[] {
  const hits: string[] = [];
  for (const file of sources(RENDERER_ROOT)) {
    const text = readFileSync(file, "utf8");
    const nouns = new Set<string>();
    for (const match of text.matchAll(JSX_ORDINAL)) {
      const noun = match[1].replace(/[：:，。\s]/g, "");
      // 「第 N 段」这种写法自己就带序数标记，不算撞。
      if (MEASURE.test(noun) && !/第/.test(match[0])) nouns.add(noun);
    }
    for (const match of text.matchAll(TEMPLATE_ORDINAL)) {
      const before = match[0].slice(1, match[0].indexOf("${")).trim().slice(-6);
      if (MEASURE.test(before) && !/第\s*$/.test(before)) nouns.add(before.replace(/[^一-鿿]/g, ""));
    }
    for (const noun of nouns) {
      if (JSX_COUNT(noun).test(text)) hits.push(`${file.replace(RENDERER_ROOT + "/", "")} —— 「${noun}」既当序号又当计数`);
    }
  }
  return [...new Set(hits)].sort();
}

describe("同一个量词在一屏上只许有一个含义", () => {
  it("正控制：JSX 与模板两种旧写法都要被判成撞号（判据瞎时「0 命中」是假绿）", () => {
    const jsx = ["<b>片段 {String(focusSegment.ordinal + 1).padStart(2, \"0\")}</b>",
      "<span>片段 {segments.length}</span>"].join("\n");
    const template = ["`来源片段 ${String(firstSegment.ordinal).padStart(2, \"0\")}`",
      "<span>来源片段 {segments.length}</span>"].join("\n");
    const nouns = new Set<string>();
    for (const match of jsx.matchAll(JSX_ORDINAL)) nouns.add(match[1]);
    for (const match of template.matchAll(TEMPLATE_ORDINAL)) {
      nouns.add(match[0].slice(1, match[0].indexOf("${")).replace(/[^一-鿿]/g, ""));
    }
    expect([...nouns]).toEqual(expect.arrayContaining(["片段", "来源片段"]));
    for (const noun of nouns) expect(JSX_COUNT(noun).test(jsx) || JSX_COUNT(noun).test(template)).toBe(true);
  });

  it("今天全仓没有一处把序号标成计数（新增要先过这条）", () => {
    expect(collidingFiles()).toEqual([]);
  });
});
