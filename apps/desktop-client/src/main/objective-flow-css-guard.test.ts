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

describe("列表行的事实句不许长成 chip（P10）", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));
  const source = read("src/renderer/src/components/surfaces/WorkspaceLibrarySurface.tsx");

  // 病根在 `approved-surfaces.css:246` 的 `.v3-objective-tags span`——它把容器里
  // **每一个**后代 span 都刷成带底小药丸。所以只断言 JSX 结构不够，必须同时钉住
  // "有人把这个容器拿掉了"；两边任缺一条，22 种同权重 chip 就回来了。
  it("chip 容器（padding / background / border-radius）被显式拿掉", () => {
    const facts = css.match(/\.hud-surface \.v3-goal-row__facts[^{]*\{([^}]*)\}/);
    expect(facts, "没有规则接手 .v3-goal-row__facts").not.toBeNull();
    const body = facts?.[1] ?? "";
    expect(body).toMatch(/background:\s*none/);
    expect(body).toMatch(/border-radius:\s*0/);
    expect(body).toMatch(/padding:\s*0/);
  });

  it("字号地板在紧凑档里也不给 tag 开后门——上一版我自己写错了这一条", () => {
    // 地板写在一条多选择器规则里，所以按"哪个规则块接手了这个选择器"来找。
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
      (rule) => /(^|,)\s*\.hud-surface \.v3-objective-tags span\s*(,|$|\n)/.test(rule[1] as string),
    );
    expect(blocks.length, "没有规则接手 .v3-objective-tags span 的字号").toBeGreaterThan(0);
    const floor = Number(/font-size:\s*([0-9.]+)px/.exec(blocks[0]?.[2] ?? "")?.[1]);
    expect(floor, "接手的那条规则没写 font-size").toBeGreaterThanOrEqual(11);
    // 紧凑档不得再出现一条只给 tag 降字号的规则。地板本身是不是无条件的那一条，
    // 静态扫只做到"挪进 @media 就找不到接手规则"这一步；真正的判据是实机算出来的
    // 字号，所以 tmp-objflow-v-b8.mjs 在两个断点档各量一次。
    const compact = css.slice(css.indexOf("@media (max-width: 760px)"));
    expect(compact).not.toMatch(/\.v3-objective-tags[^{]*\{[^}]*font-size/);
  });

  it("知识形态与作答进展落在事实句里，不再各自成一个 chip", () => {
    const facts = source.slice(
      source.indexOf("v3-goal-row__facts"),
      source.indexOf("v3-goal-row__meta"),
    );
    expect(facts).toContain("formatKnowledgeForm");
    expect(facts).toContain("objectiveProgressChips");
    // map 出来的是列表项，用 Fragment 简写会漏 key（React 每条都喊一次警告）。
    expect(facts).toMatch(/<Fragment key=\{chip\}/);
  });
});
