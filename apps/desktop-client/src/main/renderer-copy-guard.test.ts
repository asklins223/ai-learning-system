/**
 * 生成界面的用户可见串里不能出现工程术语（2026-09-20 实走复盘 #14）。
 *
 * 这条为什么放在 main 侧：读源码要用 `node:fs`，而 `tsconfig.web.json` 的编译图里
 * 没有 Node 类型——放进 renderer 的测试文件里，typecheck 会报
 * `Cannot find module 'node:fs'` / `Cannot find name 'process'`（同一个仓库里踩过多次的
 * 那条 Node-only 坑）。这里只做静态扫描，测的仍然是渲染层那份文件。
 *
 * 只守 `CardGenerationSurface.tsx` 一个文件：全仓清扫归那次清扫的负责人，
 * 这条守卫不去拦别人正在改的界面。
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BANNED = ["服务端", "血缘", "投影", "快照", "曝光", "兜底", "收口", "签发", "契约", "未确认"];
const TARGET = "src/renderer/src/components/CardGenerationSurface.tsx";

describe("生成界面的文案", () => {
  it("用户可见串里没有内部词", () => {
    const fromCwd = TARGET;
    const fromRoot = `apps/desktop-client/${TARGET}`;
    const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
    // 读不到就必须喊：静默跳过等于一条永远绿的空守卫。
    expect(path, `找不到被测界面源码（cwd=${process.cwd()}）`).not.toBeNull();
    const source = readFileSync(path as string, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 只看引号/反引号里的字面量（那是给用户读的句子）；注释与标识符不算。
    const visible = [...source.matchAll(/["'`]([^"'`\n]{4,})["'`]/g)].map((match) => match[1]);
    const dirty = visible.filter((text) => BANNED.some((word) => text.includes(word)));
    expect(dirty, "这些用户可见串里还有内部词").toEqual([]);
  });
});
