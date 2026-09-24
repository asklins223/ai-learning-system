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

describe("夜间结算纸面的可读性", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  it("浅色反馈卡与对照卡使用深色墨迹，深色明细保留浅色文字", () => {
    for (const selector of [
      "learning-run-arrival-evidence p",
      "learning-run-arrival-evidence span",
      "learning-run-result-evidence > div",
      "learning-run-result-comparison p",
    ]) {
      expect(css, `${selector} 缺少夜间文字覆盖`).toMatch(
        new RegExp(`data-theme="night"\\] \\.${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    }
    expect(css).toMatch(/data-theme="night"\] \.learning-run-arrival-evidence p,[\s\S]*?\{ color: #44382f; \}/);
    expect(css).toMatch(/data-theme="night"\] \.learning-run-result-rubric li\[data-verdict="missing"\][\s\S]*?\{ color: #9b472f; \}/);
  });
});

describe("远征册与四站场景", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));
  const source = read("src/renderer/src/components/surfaces/WorkspaceLibrarySurface.tsx");

  it("展开后有明确的关闭文案，列表独占剩余高度并滚动", () => {
    expect(source).toContain("关闭远征册");
    expect(css).toMatch(/\.objective-expedition__index-body\s*\{[^}]*flex:\s*1 1 0/);
    expect(css).toMatch(/\.v3-goal-list\s*\{[^}]*flex:\s*1 1 0[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.objective-expedition__index\[data-open="true"\]\s*\{[^}]*height:\s*calc\(100% - 24px\)/);
    expect(source).toContain("aria-expanded={indexOpen}");
  });

  it("夜间索引用暖纸深墨，搜索框不再继承缩成一小块", () => {
    expect(css).toMatch(/\.objective-expedition__index\s*\{[^}]*--quest-ink:\s*#44382f[^}]*--quest-paper:\s*#fff9e9/);
    expect(css).toMatch(/\.v3-goal-search\s*\{[^}]*width:\s*100%[^}]*min-height:\s*44px/);
  });

  it("地图、简报、作答、结果分别使用不同的真实素材", () => {
    for (const asset of ["expedition-map-v1", "challenge-clearing-v1", "focus-study-desk-v1", "result-arrival-v1"]) {
      const path = `src/renderer/public/assets/objective-flow/${asset}.png`;
      expect(existsSync(path) || existsSync(`apps/desktop-client/${path}`)).toBe(true);
      expect(css).toContain(`${asset}.png`);
    }
    for (const asset of ["expedition-map-night-v1", "challenge-clearing-night-v1", "focus-study-desk-night-v1", "result-arrival-night-v1"]) {
      const path = `src/renderer/public/assets/objective-flow/${asset}.png`;
      expect(existsSync(path) || existsSync(`apps/desktop-client/${path}`)).toBe(true);
      expect(css).toContain(`${asset}.png`);
    }
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

describe("详情页主行动块（P15）", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  it("两个紧凑档都不许再给这块降字号", () => {
    // 实机就是在这里量到动词 9px：那条档按**高度**生效，而 B4 的地板清单是按
    // :181-254 那段无条件规则挑的，紧凑档没照着列——于是 strong 整个漏在外面。
    // 现在整块自己就是按钮，字号只写在无条件那一处。
    const mediaBodies = [...css.matchAll(/@media[^{]*\{([\s\S]*?\n\})/g)].map((match) => match[1]);
    expect(mediaBodies.length, "@media 块解析不出来").toBeGreaterThan(1);
    const shrinkers = mediaBodies
      .flatMap((body) => body.split("\n"))
      .filter((line) => /\.objective-brief__launch/.test(line) && /font-size/.test(line));
    expect(shrinkers, `紧凑档还在降主行动块的字号：\n${shrinkers.join("\n")}`).toEqual([]);
  });

  it("无条件那一处给动词与说明各自定了字号", () => {
    const verb = css.match(/\.objective-brief__launch strong\s*\{([^}]*)\}/);
    expect(verb, "动词没有规则接手").not.toBeNull();
    expect(Number(/([0-9.]+)px/.exec(verb?.[1] ?? "")?.[1]), "动词字号读不出来").toBeGreaterThanOrEqual(14);
    const why = css.match(/\.objective-brief__launchpad small\s*\{([^}]*)\}/);
    expect(Number(/font-size:\s*([0-9.]+)px/.exec(why?.[1] ?? "")?.[1])).toBeGreaterThanOrEqual(12);
  });
});

describe("复习队列的成句文字有地板（§11 收尾）", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  // 这一屏住在 hud-surface.css（别的会话正在改那份文件），所以地板只能落在修正层。
  // 组件测试断言的是文字，CSS 掉了它们照样全绿——B2 那次就是这么漏过去的。
  for (const sel of ["deck-foot__hint", "queue-reason > p", "queue-reason__order"]) {
    it(`.${sel} 有 ≥11px 的接手规则`, () => {
      const needle = sel.replace(/\s+/g, " ");
      const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((rule) => {
        const selectors = (rule[1] as string).split(",").map((s) => s.replace(/\s+/g, " ").trim());
        return selectors.some((s) => s.endsWith(needle) || s === `.hud-surface .${needle}`);
      });
      expect(blocks.length, `没有规则接手 .${sel}`).toBeGreaterThan(0);
      const size = Number(/font-size:\s*([0-9.]+)px/.exec(blocks[0]?.[2] ?? "")?.[1]);
      expect(size, `.${sel} 的接手规则没写 font-size`).toBeGreaterThanOrEqual(11);
    });
  }
});

describe("作答页题面的字号层级", () => {
  const css = stripComments(read("src/renderer/src/components/objective-flow.css"));

  // 组件测试钉的是"哪句话进 h2"，这里钉的是"进了 h2 的那句到底大不大"。
  // 两边各缺一半：JSX 换回来那边不红，CSS 掉档这边不红。
  const largestPx = (selector: string) => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((rule) =>
      (rule[1] as string).split(",").some((s) => s.trim() === selector));
    expect(blocks.length, `没有规则接手 ${selector}`).toBeGreaterThan(0);
    const body = blocks[blocks.length - 1]![2];
    const decl = /(?:^|;)\s*(?:font-size|font):\s*([^;]+)/.exec(body);
    expect(decl, `${selector} 的接手规则没写 font/font-size`).not.toBeNull();
    const px = [...decl![1].matchAll(/([0-9.]+)px/g)].map((m) => Number(m[1]));
    expect(px.length, `${selector} 的 font 声明里量不到 px：${decl![1]}`).toBeGreaterThan(0);
    return Math.max(...px);
  };

  const heading = largestPx(".hud-surface .learning-run-paper__question h2");
  const instruction = largestPx(".hud-surface .learning-run-paper__question p");
  const railTopic = largestPx(".hud-surface .learning-run-focus__target strong");

  it("题面主位至少是副行的两倍——36:14 那种倒挂不许回来", () => {
    expect(heading).toBeGreaterThanOrEqual(instruction * 2);
  });

  it("绿栏那句重复的主题，得比题面副行还小", () => {
    // 它和题面主位是同一句话（rail 与题面都取 publicSummary），
    // 两处都做大字号等于同一屏把标题读两遍。
    expect(railTopic).toBeLessThan(instruction);
  });
});
