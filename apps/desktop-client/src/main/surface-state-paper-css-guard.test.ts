/**
 * 空/加载/失败状态纸面的静态守卫（笔记库空占位，2026-09-23）。
 *
 * 为什么要有这一条：`.surface-data-state` 是全站共用的状态块，它自带母本的
 * `.pinboard` 纸张；`hud-surface.css` 却无条件把这张纸剥掉（padding/border/
 * background/box-shadow 清零），理由写在注释里——"这些状态永远画在某一页纸
 * 之内"。这个前提当时就不成立：11 个调用点把状态当**整页正文**直接挂在
 * `.content` 下面，剥掉之后字就落在房间壁纸上。笔记库空态实测
 * `background-color: rgba(0,0,0,0)`、`padding: 0px`、无阴影，就是这么来的。
 *
 * 组件测试断言的是文字（"还没有任何笔记"在不在），剥纸这条它们全绿。
 * 所以这里钉三件事：剥纸规则必须绕开整页正文那两种形态；明示条必须留在
 * `.actions` 那条 flex 行之外；`.space-sharing-notice` 只准有一处基础声明。
 *
 * 放在 main 侧的理由和 objective-flow-css-guard.test.ts 一样：读文件要用
 * `node:fs`，而 `tsconfig.web.json` 的编译图里没有 Node 类型。
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

const CSS_RELATIVE = "src/renderer/src/components/hud/hud-surface.css";
const NOTE_LIBRARY = "src/renderer/src/components/surfaces/note-library-surface.tsx";

describe("状态纸面只在真有纸可落的时候才剥", () => {
  const css = stripComments(read(CSS_RELATIVE));

  // 起手先证明读到了东西：找不到任何 .surface-data-state 规则就是文件搬家了。
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((rule) => ({
    selector: (rule[1] as string).trim(),
    body: rule[2] as string,
  }));
  const stateRules = rules.filter((rule) => rule.selector.includes(".surface-data-state"));
  expect(stateRules.length, "hud-surface.css 里一条 .surface-data-state 规则都没有").toBeGreaterThan(0);

  it("剥掉纸张的那条规则带 :not() 例外，不再无条件命中整页正文", () => {
    // 判据不是"选择器里有没有 :not()"，而是"这条规则是不是只点名状态块、
    // 并且真的在剥纸"。`.note-index .surface-data-state` 那种已经站在另一张
    // 纸里，剥得对，不该被算进来。
    const namesOnlyTheStateBlock = (selector: string) => {
      const flattened = selector.replace(/:not\([^()]*\)/g, ":not()");
      const classes = [...flattened.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
      return classes.length > 0 && classes.every((name) => name === "hud-surface" || name.startsWith("surface-data-state"));
    };
    const stripsPaper = (body: string) => /background:\s*transparent/.test(body) && /padding:\s*0/.test(body);

    const blanket = stateRules.filter((rule) => namesOnlyTheStateBlock(rule.selector) && stripsPaper(rule.body));
    expect(blanket.length, "没有任何一条剥纸规则了——选择器改名了？").toBeGreaterThan(0);
    for (const rule of blanket) {
      expect(rule.selector, "剥纸规则又变回无条件了：\n" + rule.selector).toContain(":not(");
      // 两种"整页正文"形态都要在例外里：版心与崩溃外壳。少一个就还有一页是裸字。
      for (const body of [".content > *", ".render-error-boundary--shell > *"]) {
        expect(rule.selector, `例外清单里漏了 ${body}：\n${rule.selector}`).toContain(body);
      }
    }
  });

  it("例外写的是父元素，不是状态块自己——否则任何后代都躲得开", () => {
    // `:not(.surface-data-state)` 这种写法看着像修好了，实际永远为真。
    const guarded = stateRules.filter((rule) => rule.selector.includes(":not("));
    expect(guarded.length, "没有任何带 :not() 的规则了").toBeGreaterThan(0);
    for (const rule of guarded) {
      expect(rule.selector).toMatch(/:not\(\.content > \*/);
    }
  });

  it("整页正文那张纸用同页正文的 cream，不用母本 pinboard 的 tan", () => {
    // 六张页面纸实测五张是 cream rgb(255,242,207)，只有 `.pinboard` 是 tan
    // #c49b6d；边框/圆角/阴影六者逐字相同，所以纸面只需要重写背景。
    const paper = css.match(/\.hud-surface \.content > \.surface-data-state\s*,\s*\.hud-surface \.render-error-boundary--shell > \.surface-data-state\s*\{([^}]*)\}/);
    expect(paper, "没有规则接手整页正文的状态纸面").not.toBeNull();
    expect(paper?.[1], "整页正文的纸面没有用 --hud-cream").toMatch(/var\(--hud-cream\)/);
    expect(paper?.[1]).not.toMatch(/c49b6d/i);
  });

  it("墨色对两种形态是同一套，不写进带例外的剥纸规则里", () => {
    // `--hud-soft` 在 cream 上实测 5.61:1，站得住，所以它该是一条无条件规则。
    // 一旦跟着 :not() 走，整页正文就继承不到它——上一版就是这么错的。
    const inks = stateRules.filter((rule) => rule.selector === ".hud-surface .surface-data-state");
    expect(inks.length, "没有一条无条件的 .surface-data-state 墨色规则").toBeGreaterThan(0);
    expect(inks.some((rule) => /color:\s*var\(--hud-soft\)/.test(rule.body)), "无条件那条没写 --hud-soft").toBe(true);
    for (const rule of stateRules.filter((r) => r.selector.includes(":not(") && /padding:\s*0/.test(r.body))) {
      expect(rule.body, "剥纸规则又顺手改起墨色来了：\n" + rule.selector).not.toMatch(/(?:^|;)\s*color:/);
    }
  });

  it("明示条在状态块里只有一处基础声明，且带折行宽度", () => {
    const base = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((rule) => (rule[1] as string).split(",").map((s) => s.trim()).includes(".hud-surface .space-sharing-notice"));
    expect(base.length, "`.space-sharing-notice` 的基础声明数量不对").toBe(1);

    const scoped = css.match(/\.hud-surface \.surface-data-state \.space-sharing-notice\s*\{([^}]*)\}/);
    expect(scoped, "没有规则接手状态块里的 .space-sharing-notice").not.toBeNull();
    // 状态块是 place-content:center 的网格，列宽取 max-content：不封顶就永远不折行。
    expect(Number(/max-width:\s*([0-9.]+)em/.exec(scoped?.[1] ?? "")?.[1]), "折行宽度没写或读不出来").toBeGreaterThan(0);
    // 板子是 #c49b6d，原来那套浅色字实测只有 1.83:1。
    expect(scoped?.[1]).toMatch(/color:\s*var\(--hud-ink\)/);
  });
});

describe("笔记库空态的明示条不挤在按钮行里", () => {
  const source = read(NOTE_LIBRARY);
  const start = source.indexOf("SpaceSharingNotice testId=\"note-share-notice\"");
  // 组件被改名或删掉时，下面的结构断言会全部空过——先把它读到了钉住。
  expect(start, "笔记库空态里找不到共享明示条").toBeGreaterThan(-1);

  it("它不是 .actions 那条 flex 行的成员", () => {
    // 锚在明示条**前面**那一个 .actions 块（全站还有别的 actions 块），
    // 收口取这个块自己的第一个 </div>，不是明示条之后的那一个。
    const open = source.lastIndexOf('<div className="actions">', start);
    expect(open, "明示条前面读不到 .actions 块").toBeGreaterThan(-1);
    const block = source.slice(open, source.indexOf("</div>", open));
    expect(block.length, "读不到 .actions 块").toBeGreaterThan(0);
    expect(block, "明示条又回到 .actions 里了：它会和按钮并排且拿不到折行宽度").not.toContain("SpaceSharingNotice");
  });

  it("它排在按钮行之后，而不是之前", () => {
    const createAt = source.indexOf("{createButton(true)}");
    expect(createAt).toBeGreaterThan(-1);
    expect(createAt).toBeLessThan(start);
  });
});
