/**
 * 卡组轮播 UI 契约测试（docs/plans/card-set-carousel-ui.md §9.2 硬门禁）。
 *
 * readFileSync 静态断言硬性验收项：
 * - G-1 reduced-motion 专属块显式清零 stagger delay
 * - G-3 轮播/展开元素 content-visibility 显式 visible，无 auto
 * - G-4 舞台裁切用 overflow-x: clip，祖先无 overflow: hidden
 * - G-5 纯 2D transform（无 perspective / rotateY / preserve-3d）
 * - G-6 无 box-shadow / filter 动画；无新增动效 token
 * - G-9 列表页不内嵌 lifecycle 操作；非 active 封面只导航详情页
 * - G-11 swipe 阈值单一来源（组件不硬编码 84 / 0.5）
 * - 展开态成员卡为普通 Link 到 /cards/[id]，全量渲染不发牌截断
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const read = (path: string) =>
  readFileSync(resolve(WEB_ROOT, path), "utf8");

const cssSource = read("app/styles/card-set-carousel.css");
const cardsListCss = read("app/styles/cards-list.css");
const baseCss = read("app/styles/base.css");
const carouselSource = read("components/study/CardSetCarousel.tsx");
const coverSource = read("components/study/DeckCover.tsx");
const deckPageSource = read("components/study/CardSetDeckPage.tsx");
const expandedSource = read("components/study/DeckExpandedView.tsx");
const drawerSource = read("components/study/DeckMemberDrawer.tsx");
const cardsPageSource = read("app/(workspace)/(default)/cards/page.tsx");
const pureSource = read("lib/card-set-carousel.ts");

/** 提取 `selector { ... }` 第一个 CSS 块（到首个 `}` 为止），避免跨块误匹配。 */
function blockSource(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) return "";
  const brace = source.indexOf("{", start);
  const end = source.indexOf("}", brace);
  return source.slice(start, end + 1);
}

describe("card set carousel UI contract", () => {
  it("G-3: 轮播/展开元素 content-visibility 显式 visible，无 auto", () => {
    for (const selector of [".deck-stage", ".deck-cover", ".deck-member-tile", ".deck-expanded"]) {
      assert.match(
        cssSource,
        new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[\\s\\S]*?content-visibility:\\s*visible;`),
        `${selector} 必须显式 content-visibility: visible`,
      );
    }
    // 整个 deck CSS 不允许出现 content-visibility: auto
    assert.ok(
      !/content-visibility:\s*auto/.test(cssSource),
      "deck CSS 不得出现 content-visibility: auto",
    );
  });

  it("G-4: 舞台裁切用 overflow-x: clip，祖先链无 overflow: hidden", () => {
    assert.match(
      cssSource,
      /\.deck-stage-clip\s*\{[\s\S]*?overflow-x:\s*clip;/,
      ".deck-stage-clip 必须用 overflow-x: clip 裁切",
    );
    assert.ok(!/overflow-x:\s*hidden;/.test(cssSource), "不得声明 overflow-x: hidden");
    // 舞台/裁切盒/轮播容器不得用 overflow: hidden 隐藏越界（base.css 红线）；
    // 封面纸面子元素的 overflow: hidden 只用于行截断，属合法裁剪。
    for (const selector of [".deck-carousel", ".deck-stage-clip", ".deck-stage"]) {
      const block = blockSource(cssSource, selector);
      assert.ok(block.length > 0, `找不到 ${selector} 的 CSS 块`);
      assert.ok(!block.includes("overflow: hidden"), `${selector} 不得用 overflow: hidden`);
    }
    // 真实祖先链（跨文件）：.cards-page / .cards-library(.deck-library) /
    // .cards-toolbar-wrap / body 不得引入 overflow:hidden 把侧翼卡裁掉（§10 风险）。
    const ancestorBlocks: Array<[string, string, string]> = [
      [".cards-page", cardsListCss, "cards-list.css"],
      [".cards-library", cardsListCss, "cards-list.css"],
      [".cards-toolbar-wrap", cardsListCss, "cards-list.css"],
      ["body", baseCss, "base.css"],
    ];
    for (const [selector, source, file] of ancestorBlocks) {
      const block = blockSource(source, selector);
      assert.ok(block.length > 0, `${file} 找不到 ${selector}`);
      // 剥离注释（base.css 的 §13.2 红线注释本身含 "overflow" 字样）后只匹配声明形式
      const clean = block.replace(/\/\*[\s\S]*?\*\//g, "");
      assert.ok(
        !/\boverflow(?:-x|-y)?\s*:/.test(clean),
        `${file} ${selector} 不得声明 overflow`,
      );
    }
  });

  it("G-5: 纯 2D transform，无 perspective / rotate3d / preserve-3d 声明", () => {
    // 同时扫属性形式（perspective: N）与 transform 函数形式（perspective(N)），
    // 并覆盖整簇轮播相关文件（含展开态与 drawer）。
    const tokens = [
      /\bperspective\s*:/,
      /\bperspective\s*\(/,
      /\brotateX\s*\(/,
      /\brotateY\s*\(/,
      /\brotate3d\s*\(/,
      /\btranslate3d\s*\(/,
      /\bscale3d\s*\(/,
      /transform-style:\s*preserve-3d/,
    ];
    const sources: Array<[string, string]> = [
      ["CSS", cssSource],
      ["DeckCover", coverSource],
      ["CardSetCarousel", carouselSource],
      ["DeckExpandedView", expandedSource],
      ["DeckMemberDrawer", drawerSource],
      ["lib/card-set-carousel.ts", pureSource],
    ];
    for (const token of tokens) {
      for (const [name, source] of sources) {
        assert.ok(!token.test(source), `${name} 不得包含 ${token}`);
      }
    }
  });

  it("G-6: 无 box-shadow / filter 动画；无新增动效 token", () => {
    // transition 列表里不得出现 box-shadow / filter
    assert.ok(!/transition[^;{}]*\bbox-shadow\b/.test(cssSource));
    assert.ok(!/transition[^;{}]*\bfilter\b/.test(cssSource));
    // 不新增动效 token（tokens.css 只有 --motion-fast/base/slow 三档）
    assert.ok(!/--motion-[a-z-]+\s*:\s*[^;]*ms/.test(cssSource));
  });

  it("G-1: reduced-motion 专属块显式清零 stagger delay（motion.css 不清 delay）", () => {
    const reduceIndex = cssSource.indexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(reduceIndex >= 0, "必须有 prefers-reduced-motion 专属块");
    const reduceBlock = cssSource.slice(reduceIndex);
    assert.ok(reduceBlock.includes("transition-delay: 0ms !important"));
    assert.ok(reduceBlock.includes("animation-delay: 0ms !important"));
  });

  it("G-9: 列表页不内嵌 lifecycle 操作；非 active 封面只导航详情页", () => {
    assert.ok(!deckPageSource.includes("acceptCardSet"));
    assert.ok(!deckPageSource.includes("dismissCardSet"));
    assert.ok(!deckPageSource.includes("regenerateCardSet"));
    assert.ok(!deckPageSource.includes("api.listCards"), "卡组页不得消费 listCards（单一数据源）");
    assert.ok(deckPageSource.includes("api.listCardSets"));
    assert.ok(deckPageSource.includes("api.listCardSetCards"));
  });

  it("G-11: swipe 阈值单一来源（shouldCommit/commitDirection 来自 lib 纯函数）", () => {
    assert.ok(pureSource.includes("export function shouldCommit"));
    assert.ok(pureSource.includes("export function commitDirection"));
    assert.ok(carouselSource.includes("commitDirection("));
    // 组件内不得硬编码提交阈值 84 / 0.5
    assert.ok(!carouselSource.includes("maxDragPx"));
    assert.ok(!carouselSource.includes("84"));
    assert.ok(!carouselSource.includes("0.5"));
  });

  it("data-ui 测试钩子齐全（§7.1）", () => {
    const hookSources: Record<string, string[]> = {
      "card-set-carousel": [carouselSource],
      "deck-cover": [coverSource, carouselSource],
      "carousel-prev": [carouselSource],
      "carousel-next": [carouselSource],
      "carousel-indicator": [carouselSource],
      "deck-expanded": [expandedSource],
      "deck-member": [read("components/study/DeckMemberDrawer.tsx")],
    };
    for (const [hook, sources] of Object.entries(hookSources)) {
      assert.ok(
        sources.some((source) => source.includes(`"${hook}"`)),
        `缺少 data-ui="${hook}"`,
      );
    }
  });

  it("/cards 已退出卡组轮播，固定呈现单个学习目标", () => {
    assert.ok(!cardsPageSource.includes("isCardSetDeckUIEnabled()"));
    assert.ok(!cardsPageSource.includes("<CardSetDeckPage"));
    assert.ok(!cardsPageSource.includes("api.listCardSets"));
    assert.ok(cardsPageSource.includes("api.listCards"));
    assert.ok(cardsPageSource.includes('data-ui="learning-objective-row"'));
    assert.ok(deckPageSource.includes("statusMap.cardSetStatus"));
  });

  it("展开态成员卡为普通 Link 到 /cards/[id]，不发牌截断（全量渲染）", () => {
    assert.ok(expandedSource.includes('href={`/cards/${card.id}`}'));
    assert.ok(expandedSource.includes("sections.map"));
    // 不允许 "+N 截断" 或 slice(0, N) 截断成员
    assert.ok(!expandedSource.includes("+N 截断"));
    assert.ok(!expandedSource.includes("slice(0, "));
  });
});
