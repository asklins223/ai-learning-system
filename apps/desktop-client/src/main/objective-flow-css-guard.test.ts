/**
 * 结算页 outcome 视觉契约的静态守卫（31 号文档 P2/P32，批次 B2）。
 *
 * 为什么要有这一条：`data-outcome` 与 `data-tone` 从 JSX 发出去、全仓**没有任何一条
 * CSS 接手**，于是「已理解」和「无法评估」是像素级相同的一张纸，而所有单元测试照样
 * 全绿——因为它们断言的是文字，不是"有没有人接"。这种"属性发出去了没人接"的毛病，
 * 靠实机截图能发现，但发现成本太高；这里用静态扫描把它变成一条会红的测试。
 *
 * 放在 main 侧的理由和 renderer-copy-guard.test.ts 一样：读文件要用 `node:fs`，
 * 而 `tsconfig.web.json` 的编译图里没有 Node 类型。
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

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("结算页的 outcome 必须真的驱动视觉", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));
  const outcomes = ["demonstrated", "partial", "practice_completed", "not_assessable", "needs_repair", "skipped", "declared_unable"];

  it("data-outcome 有 CSS 接手，而且不是一条通吃", () => {
    const selectors = [...css.matchAll(/[^{}]*\[data-outcome="([a-z_]+)"\][^{}]*\{/g)]
      .map((match) => match[1]);
    expect(selectors.length).toBeGreaterThanOrEqual(3);
    // 成立 / 练习 / 不成立 至少各占一档；只写一条 `.learning-run-result-board` 不算驱动视觉。
    const tiers = new Set(selectors);
    expect(tiers.has("demonstrated")).toBe(true);
    expect(tiers.has("practice_completed")).toBe(true);
    expect([...tiers].some((outcome) => ["not_assessable", "needs_repair", "skipped", "declared_unable"].includes(outcome))).toBe(true);
  });

  it("每个 outcome 的印章文案都还在表里——分档不许把谁漏成空白", () => {
    const source = read("src/renderer/src/components/surfaces/learning-run-surface.tsx");
    const sealBlock = source.slice(
      source.indexOf("const outcomeSeal"),
      source.indexOf("const outcomeHeadline"),
    );
    for (const outcome of outcomes) {
      expect(sealBlock, `outcomeSeal 少了 ${outcome}`).toContain(`${outcome}:`);
    }
  });

  it("跳过与「暂时不会」被列进不渲染印章的那张表（DESIGN.md:152）", () => {
    const source = read("src/renderer/src/components/surfaces/learning-run-surface.tsx");
    expect(source).toMatch(/SEALLESS_OUTCOMES[^;]*"skipped"[^;]*"declared_unable"/s);
  });
});

describe("一次性压印的动效预算", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  it("印章压印只动 transform 与 opacity（DESIGN.md:148）", () => {
    const keyframe = css.match(/@keyframes objective-seal-press\s*\{([\s\S]*?)\n\}/);
    expect(keyframe, "@keyframes objective-seal-press 找不到了").not.toBeNull();
    const properties = [...(keyframe as RegExpMatchArray)[1].matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
    expect(properties.length).toBeGreaterThan(0);
    expect(new Set(properties)).toEqual(new Set(["opacity", "transform"]));
  });

  it("动效挂在 data-acknowledgement 上，不是挂在 outcome 上——否则回看历史结果会再庆祝一次", () => {
    const rule = css.match(/\.learning-run-result-board\[data-acknowledgement="active"\][^{]*\{[^}]*animation:/);
    expect(rule, "压印动画必须由 data-acknowledgement 触发").not.toBeNull();
    expect(css).not.toMatch(/\[data-outcome="demonstrated"\][^{]*\{[^}]*animation:/);
  });

  it("off 档与 prefers-reduced-motion 都把它关掉", () => {
    expect(css).toMatch(/data-motion-mode="off"[^{]*\{[^}]*animation:\s*none/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/animation:\s*none/);
  });
});

describe("修正层的加载顺序", () => {
  it("objective-flow.css 排在 hud-surface.css 之后——它覆盖的是同文件更早处的规则", () => {
    const main = read("src/renderer/src/main.tsx");
    const imports = [...main.matchAll(/import\s+"([^"]*\.css)"/g)].map((match) => match[1]);
    const flow = imports.findIndex((spec) => spec.includes("objective-flow.css"));
    const hud = imports.findIndex((spec) => spec.includes("hud-surface.css"));
    expect(flow, "main.tsx 里没有引入 objective-flow.css").toBeGreaterThan(-1);
    expect(flow).toBeGreaterThan(hud);
  });
});
