/** 临时探针：真实 CSS + 真实排版下，验证「气泡让位」的 CSS 接线与落点。
 *  背景：dev 实例被另一会话正在编辑的 settings-surface.tsx 挡住（vite 500），起不来，
 *  所以按 hud-visual-probe 的路子用最小 DOM + 真样式表量。让位数值由真的
 *  `companionBubbleClearance`（--experimental-strip-types 直接加载 TS）算出。 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { companionBubbleClearance } from "../src/renderer/src/components/companion/companion-bubble-clearance.ts";

const ROOT = new URL("../src/renderer/src/", import.meta.url).pathname;
const CSS_FILES = [
  "styles.css",
  "components/home-room.css",
  "components/home-room-life.css",
  "components/approved-surfaces.css",
  "components/hud/hud-pages.css",
  "components/hud/hud-surface.css",
  "components/hud/hud-controls.css",
  "components/companion/companion-hud.css",
  "components/companion/companion-root.css",
];
const fonts = [
  "../node_modules/@fontsource-variable/noto-sans-sc/index.css",
  "../node_modules/@fontsource-variable/noto-serif-sc/index.css",
].map((p) => pathToFileURL(new URL(p, import.meta.url).pathname).href);

const chips = ["首页", "来源", "笔记", "理解", "星图", "今日学习", "复习", "查找", "伴星", "设置"]
  .map((label) => `<button type="button" class="nav-chip" aria-label="${label}"><span></span></button>`).join("");

const shell = (railState) => `
<div class="desktop-app hud-surface comp-left ${railState}" data-directory-rail="${railState === "nav-collapsed" ? "collapsed" : "expanded"}" data-hud-page="queue">
  <div class="hud-surface bg-review page-15">
    <nav class="hud-rail" aria-label="书房目录">${chips}
      <button type="button" class="nav-collapse" aria-label="收起目录"><svg viewBox="0 0 24 24"></svg></button>
      <span class="nav-island-copy">书房目录</span>
    </nav>
    <div class="companion-presence" data-policy-mode="ambient">
      <div class="companion-scene-anchor" id="anchor" style="left:102px;top:472px">
        <div class="companion-visual-shell"></div>
        <div class="companion-hud" id="hud">
          <div class="companion-hud__output" data-tone="note"><p>麦克风不可用或未授权</p></div>
          <div class="companion-hud__controls">
            <button type="button" aria-label="语音输入"></button>
            <button type="button" aria-label="文字输入"></button>
            <button type="button" aria-label="更多功能"></button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
${fonts.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
${CSS_FILES.map((f) => `<link rel="stylesheet" href="${pathToFileURL(ROOT + f).href}">`).join("\n")}
<style>
  html, body { margin: 0; }
  /* 真实外壳的定位由 gsap 写进内联样式，这里按 1440×810 的实测值原样摆放。
     锚点自带 420ms 座位迁移过渡（hud-surface.css），与让位无关，关掉免得量到中间帧。 */
  .companion-scene-anchor { width: 245px; height: 324px; transform: none !important; transition: none !important; }
  .companion-hud__output, .companion-hud__rail { animation: none !important; }
</style></head><body>${shell("")}</body></html>`;

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
});
// 必须落成 file:// 再打开：about:blank 的文档加载不了本地样式表，量出来的是裸 DOM。
const probePath = new URL("../../../.impeccable/tmp-bubble-clearance-probe.html", import.meta.url).pathname;
await mkdir(dirname(probePath), { recursive: true });
await writeFile(probePath, html);
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(probePath).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

const measure = () => page.evaluate(`(() => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
  const round = (b) => b ? { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) } : null;
  const hit = (a, b) => (a && b) ? !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) : false;
  const rail = box(document.querySelector('.hud-rail'));
  const bubble = box(document.querySelector('.companion-hud__output'));
  return { rail: round(rail), bubble: round(bubble), hit: hit(bubble, rail) };
})()`);

let failures = 0;
const report = (ok, label, extra) => {
  if (!ok) failures += 1;
  console.log(` ${ok ? " ok " : "FAIL"} ${label}${extra ? `  ${extra}` : ""}`);
};

// ① 未让位的基线必须先复现缺陷，否则后面全是空断言。
const baseline = await measure();
report(baseline.hit, "基线：座位左 + 目录栏展开，气泡确实压住目录栏",
  `气泡=${JSON.stringify(baseline.bubble)} 目录栏=${JSON.stringify(baseline.rail)}`);

const offset = companionBubbleClearance({
  bubble: baseline.bubble ? { left: baseline.bubble.l, right: baseline.bubble.r, top: baseline.bubble.t, bottom: baseline.bubble.b } : { left: 0, right: 0, top: 0, bottom: 0 },
  frame: { left: 0, top: 0, right: 1440, bottom: 810 },
  rail: baseline.rail ? { left: baseline.rail.l, right: baseline.rail.r, top: baseline.rail.t, bottom: baseline.rail.b } : null,
});
await page.evaluate(({ x, y }) => {
  const hud = document.getElementById("hud");
  hud.style.setProperty("--companion-bubble-dx", `${x}px`);
  hud.style.setProperty("--companion-bubble-dy", `${y}px`);
}, offset);
report(offset.x > 0 && offset.y === 0, "让位计算给出纯水平偏移", `offset=${offset.x},${offset.y}`);

const cleared = await measure();
report(!cleared.hit, "落点：气泡左缘在目录栏右缘之外", `气泡=${JSON.stringify(cleared.bubble)}`);
report(cleared.bubble.l >= cleared.rail.r + 12, "并留出 12px 间距", `间距=${cleared.bubble.l - cleared.rail.r}`);
report(cleared.bubble.r <= 1440 && cleared.bubble.t >= 0 && cleared.bubble.b <= 810, "让位没有把气泡顶出窗口另一侧");
await page.screenshot({ path: "../../outputs/气泡让位-展开态-1440x810.png", clip: { x: 0, y: 0, width: 720, height: 810 } });

// ② 收起成左下角小岛：让位应归零，气泡回到原位且不压小岛。
await page.evaluate(() => {
  const app = document.querySelector(".desktop-app");
  app.classList.add("nav-collapsed");
  app.dataset.directoryRail = "collapsed";
});
await page.waitForTimeout(120);
const collapsedBase = await measure();
const collapsedOffset = companionBubbleClearance({
  bubble: { left: collapsedBase.bubble.l, right: collapsedBase.bubble.r, top: collapsedBase.bubble.t, bottom: collapsedBase.bubble.b },
  frame: { left: 0, top: 0, right: 1440, bottom: 810 },
  rail: { left: collapsedBase.rail.l, right: collapsedBase.rail.r, top: collapsedBase.rail.t, bottom: collapsedBase.rail.b },
});
report(collapsedBase.rail.t > collapsedBase.bubble.b, "收起态：小岛在气泡下方（垂直不相交是这个判据的前提）",
  `小岛=${JSON.stringify(collapsedBase.rail)}`);
report(collapsedOffset.x === 0 && collapsedOffset.y === 0, "收起后不再让位", `offset=${collapsedOffset.x},${collapsedOffset.y}`);

// ③ 座位在右：不经过目录栏，但右缘超出窗口，应被钳回窗口内。
await page.evaluate(() => {
  const app = document.querySelector(".desktop-app");
  app.classList.remove("nav-collapsed");
  app.classList.remove("comp-left");
  app.dataset.directoryRail = "expanded";
  document.getElementById("hud").style.setProperty("--companion-bubble-dx", "0px");
  document.getElementById("hud").style.setProperty("--companion-bubble-dy", "0px");
  const anchor = document.getElementById("anchor");
  anchor.style.left = "1173px";
});
await page.waitForTimeout(120);
const rightSeat = await measure();
const rightOffset = companionBubbleClearance({
  bubble: { left: rightSeat.bubble.l, right: rightSeat.bubble.r, top: rightSeat.bubble.t, bottom: rightSeat.bubble.b },
  frame: { left: 0, top: 0, right: 1440, bottom: 810 },
  rail: { left: rightSeat.rail.l, right: rightSeat.rail.r, top: rightSeat.rail.t, bottom: rightSeat.rail.b },
});
report(rightSeat.bubble.r > 1440, "右座位基线：气泡右缘确实超出窗口", `右缘=${rightSeat.bubble.r}`);
report(rightOffset.x < 0, "钳位给出向内的负偏移", `offset=${rightOffset.x},${rightOffset.y}`);
await page.evaluate(({ x, y }) => {
  document.getElementById("hud").style.setProperty("--companion-bubble-dx", `${x}px`);
  document.getElementById("hud").style.setProperty("--companion-bubble-dy", `${y}px`);
}, rightOffset);
const rightCleared = await measure();
report(rightCleared.bubble.r <= 1440 - 8, "右座位落点：气泡完整落在窗口内", `右缘=${rightCleared.bubble.r}`);
report(!rightCleared.hit, "右座位落点不压目录栏");

await page.screenshot({ path: "../../outputs/气泡让位-静态探针-1440x810.png", clip: { x: 0, y: 0, width: 1440, height: 810 } });
await browser.close();
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
