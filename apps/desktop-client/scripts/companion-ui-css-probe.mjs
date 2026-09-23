#!/usr/bin/env node
/**
 * 伴星界面的 CSS 层几何探针（2026-09-22，方案 35 批次 0）。
 *
 * 为什么需要它：`jsdom` 没有布局引擎，`vitest` 里 `offsetHeight` 恒为 0，
 * 所以「按钮盒子塌成 0×0、可见气泡点不到」这一类缺陷**只有真布局能证**。
 * 本脚本把仓库里的真实 CSS 原样喂给 Chromium，量三件事：
 *   1. 交互元素自己的盒子有多大；
 *   2. 用户眼睛看到的那块东西的中心，`elementFromPoint` 命中到谁；
 *   3. 在那一点打一次真鼠标，click handler 到底会不会触发。
 *
 * 它不是端到端测试（不跑 React、不起整套应用），也不进 CI——
 * 它是改这类缺陷时的裁判：修之前必须能红，修完必须能绿。
 *
 * 用法：`node apps/desktop-client/scripts/companion-ui-css-probe.mjs`
 * 退出码 0 = 全部判据通过；1 = 有判据红（打印具体数字）。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/src");
const cssOf = (rel) => readFileSync(join(SRC, rel), "utf8");

/** 用例：一段真实祖先链 + 被测片段 + 判据。 */
const CASES = [
  {
    name: "念头气泡（CompanionPresence.tsx:1604 的 button.companion-cue-open）",
    // 祖先链的规则逐条抄自 styles.css:347-374 与 companion-root.css:5-24，
    // 剩下的是 companion-bubble.css 原文。
    shellCss: `
      /* 应用有全局 border-box（styles.css:33-35）。探针不抄这条就会量出一个虚构的
         盒模型：气泡的 padding 会额外撑到按钮外面，报出"按钮比可见块窄"这种假缺陷。 */
      *,*::before,*::after{box-sizing:border-box}
      html,body{margin:0;height:100%}
      .desktop-app{position:relative;height:100vh}
      .companion-presence{position:absolute;inset:0;z-index:26;overflow:hidden;pointer-events:none}
      .companion-scene-anchor{position:absolute;top:31%;left:53%;width:clamp(220px,16vw,280px);height:clamp(310px,40vh,380px)}
      .companion-visual-shell{position:absolute;right:0;bottom:0;width:100%;height:100%;pointer-events:auto}
    `,
    cssFiles: ["components/companion/companion-bubble.css"],
    html: `
      <div class="companion-scene-anchor">
        <div class="companion-visual-shell"></div>
        <button type="button" class="companion-cue-open" data-probe-actor
                aria-label="这条念头——点开和她聊">
          <div class="companion-bubble companion-bubble--cue" data-probe-visible role="status">
            <span class="companion-bubble__text">这篇笔记你已经三天没打开过了，要不要我看一眼？</span>
          </div>
        </button>
      </div>
    `,
  },
];

async function launchChromium() {
  try {
    return await chromium.launch();
  } catch {
    // 这台机器上装的 playwright 版本与缓存里的修订号不一定对得上（本仓库就撞过），
    // 所以退回缓存里能找到的最新一个 Chromium 可执行文件。
    const cache = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
    const revisions = existsSync(cache)
      ? readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()
      : [];
    for (const revision of revisions) {
      const binary = join(cache, revision, "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
      if (existsSync(binary)) return await chromium.launch({ executablePath: binary });
    }
    throw new Error("找不到可用的 Chromium：playwright 缓存里没有 chromium-*/chrome-mac/Chromium.app");
  }
}

const probe = async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const failures = [];
  const measurements = [];

  for (const testCase of CASES) {
    const css = testCase.shellCss + testCase.cssFiles.map(cssOf).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>`
      + `<div class="desktop-app hud-surface"><div class="companion-presence" data-policy-mode="ambient">${testCase.html}</div></div>`;
    await page.setContent(html);

    const result = await page.evaluate(async () => {
      const actor = document.querySelector("[data-probe-actor]");
      const visible = document.querySelector("[data-probe-visible]");
      const box = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const actorBox = box(actor);
      const visibleBox = box(visible);
      const point = { x: visibleBox.x + visibleBox.width / 2, y: visibleBox.y + visibleBox.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      actor.__probeClicked = false;
      actor.addEventListener("click", () => { actor.__probeClicked = true; });
      return { actorBox, visibleBox, point, hitLabel: hit ? `${hit.tagName}.${hit.className}` : null, hitInActor: actor.contains(hit) };
    });

    await page.mouse.click(result.point.x, result.point.y);
    const clicked = await page.evaluate(() => {
      const actor = document.querySelector("[data-probe-actor]");
      return Boolean(actor?.__probeClicked);
    });

    const area = Math.round(result.actorBox.width * result.actorBox.height);
    const coversVisible = result.actorBox.width >= result.visibleBox.width - 1
      && result.actorBox.height >= result.visibleBox.height - 1;
    const checks = [
      { label: "交互元素自身有面积", ok: area > 0, value: `${result.actorBox.width}×${result.actorBox.height} = ${area}px²` },
      { label: "交互盒罩得住可见那块", ok: coversVisible, value: `actor ${result.actorBox.width}×${result.actorBox.height} vs visible ${result.visibleBox.width}×${result.visibleBox.height}` },
      { label: "可见中心的命中落在交互元素里", ok: result.hitInActor, value: `elementFromPoint → ${result.hitLabel}` },
      { label: "在该点真点击能触发 handler", ok: clicked, value: `click fired = ${clicked}` },
    ];
    measurements.push({ name: testCase.name, checks });
    failures.push(...checks.filter((check) => !check.ok).map((check) => `${testCase.name}\n  ✗ ${check.label}（${check.value}）`));  }

  await browser.close();
  for (const item of measurements) {
    console.log(`\n${item.name}`);
    for (const check of item.checks) console.log(`  ${check.ok ? "✓" : "✗"} ${check.label} — ${check.value}`);
  }
  if (failures.length > 0) {
    console.log(`\n判据未通过 ${failures.length} 条：`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exit(1);
  }
  console.log(`\n全部判据通过（${measurements.reduce((sum, item) => sum + item.checks.length, 0)} 条）。`);
};

await probe();
