/**
 * 目标链路（列表 → 详情 → 作答 → 结算）的用户可见文案守卫（31 号文档 P34 / B9）。
 *
 * 先有一条这样的守卫，是因为实机走到「稍后再做」时弹出来的那句话是
 * 「当前已输入内容会按服务端合同处理。」——工程内部词直接印在了给学习者看的界面上，
 * 而所有测试照样全绿：没有一条断言看过那串字。
 *
 * 放在 main 侧的理由同 renderer-copy-guard.test.ts：读文件要 `node:fs`，
 * `tsconfig.web.json` 的编译图里没有 Node 类型。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => {
  const fromCwd = relative;
  const fromRoot = `apps/desktop-client/${relative}`;
  const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
  // 读不到就必须喊：静默跳过等于一条永远绿的空守卫。
  expect(path, `找不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
};

const BASE = "src/renderer/src/components";
const FLOW_FILES = [
  `${BASE}/surfaces/learning-run-surface.tsx`,
  `${BASE}/surfaces/WorkspaceLibrarySurface.tsx`,
  `${BASE}/surfaces/objective-state-copy.ts`,
  `${BASE}/surfaces/run-voice-input.tsx`,
  `${BASE}/hud/HudPage.tsx`,
];

/** 这些词描述的是系统内部怎么运作，不是学习者当下的处境。 */
const INTERNAL = ["服务端", "客户端", "合同", "渲染边界", "投影", "快照", "契约", "兜底", "签发", "未确认"];

/** 抽出引号与单行模板串里的字面量；注释与标识符不算给用户读的东西。 */
const visibleLiterals = (source: string) => {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...stripped.matchAll(/["'`]([^"'`\n]{4,})["'`]/g)].map((match) => match[1]);
};

describe("目标链路的用户可见文案", () => {
  it.each(FLOW_FILES)("%s 的可见串里没有内部词", (file) => {
    const dirty = visibleLiterals(read(file)).filter(
      (text) => INTERNAL.some((word) => text.includes(word)),
    );
    expect(dirty, `${file} 里这些串会直接印在界面上：${JSON.stringify(dirty)}`).toEqual([]);
  });

  it("「稍后再做」的确认框回答的是「我写的东西还在不在」", () => {
    const source = read(`${BASE}/surfaces/learning-run-surface.tsx`);
    const dialog = source.slice(
      source.indexOf('id="learning-run-confirmation-title"'),
      source.indexOf("closeConfirmation}>"),
    );
    expect(dialog).not.toBe("");
    expect(dialog).toContain("替你留着");
    // 只有 skip_run 与 end 需要确认，两者都是离开，所以这句承诺成立；
    // 若哪天给别的动作加了 confirmationRequired，这条会逼人来重核这句话。
    expect(dialog).not.toMatch(/服务端|合同/);
  });

  it("返回胶囊不再念成「返回返回书房」（P26）", () => {
    const source = read(`${BASE}/hud/HudPage.tsx`);
    expect(source).toContain("aria-label={label}");
    expect(source).not.toMatch(/aria-label=\{`返回\$\{label\}`\}/);
  });

  it("所有 returnTarget 的 label 自带「返回」，所以那个前缀不该回来", () => {
    for (const file of [`${BASE}/surfaces/graph-surface.tsx`, `${BASE}/surfaces/notebook-surface.tsx`, `${BASE}/CardGenerationSurface.tsx`]) {
      const found = [...read(file).matchAll(/label:\s*"(返回[^"]*)"/g)].map((match) => match[1]);
      expect(found.length, `${file} 里没找到带「返回」的 label，这条守卫的前提变了`).toBeGreaterThan(0);
    }
    // App.tsx 的默认值也算一个 label 来源。
    const app = read("src/renderer/src/App.tsx");
    expect(app).toMatch(/returnTarget\?\.label \?\? "返回书房"/);
  });
});
