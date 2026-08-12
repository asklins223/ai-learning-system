/**
 * P1 browser fallback smoke test（runbook 5.5）：
 * - standard（≥600×560）与 compact（<600×560）模式切换；
 * - 200% zoom 等效视口 → compact；
 * - 透明 root pointer-events:none，仅交互子元素 auto；
 * - 页面点击不被 pet root 截获（穿透验证）；
 * - reduced motion 下 dots 动画关闭。
 *
 * 运行：node scripts/pet-fallback-smoke.mjs（需宿主 next dev -p 3010 已启动）
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3010/companion/pet";
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch({ headless: true });

// ── 1. Standard mode（900×700） ─────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const standard = await page.evaluate(() => {
    const host = document.querySelector(".in-app-pet-host");
    const root = document.querySelector(".pet-surface-root");
    const compact = document.querySelector(".in-app-pet-character-btn");
    return {
      hostMode: host?.getAttribute("data-mode"),
      rootSize: root ? { w: root.getBoundingClientRect().width, h: root.getBoundingClientRect().height } : null,
      rootRight: root ? root.getBoundingClientRect().right : null,
      rootBottom: root ? root.getBoundingClientRect().bottom : null,
      compact,
      rootPointer: root ? getComputedStyle(root).pointerEvents : null,
      hitZonePointer: document.querySelector(".pet-character-hit-zone") ? getComputedStyle(document.querySelector(".pet-character-hit-zone")).pointerEvents : null,
    };
  });
  check("standard mode host", standard.hostMode === "standard", `mode=${standard.hostMode}`);
  check("standard 560×520 root", standard.rootSize && Math.abs(standard.rootSize.w - 560) < 1 && Math.abs(standard.rootSize.h - 520) < 1, JSON.stringify(standard.rootSize));
  check("standard pinned bottom-right 8px", standard.rootBottom !== null && standard.rootBottom > 690 && standard.rootRight > 890, `right=${standard.rootRight} bottom=${standard.rootBottom}`);
  check("no compact button in standard", standard.compact === null);
  check("root pointer-events none", standard.rootPointer === "none", `got ${standard.rootPointer}`);
  check("hit zone pointer-events auto", standard.hitZonePointer === "auto", `got ${standard.hitZonePointer}`);

  // 穿透：在 pet root 透明区内放置页面按钮，点击必须触发页面 handler。
  await page.evaluate(() => {
    const btn = document.createElement("button");
    btn.id = "under-pet-btn";
    btn.textContent = "under";
    btn.style.cssText = "position:fixed;left:340px;top:190px;width:60px;height:60px;z-index:1;";
    document.body.appendChild(btn);
    btn.addEventListener("click", () => {
      window.__underClicked = true;
    });
  });
  // 用真实鼠标点击 root 左上透明区（位于 root 内但不在交互子元素上，
  // 且落在测试按钮 #under-pet-btn 的 340-400/190-250 范围内）
  const pt = await page.evaluate(() => {
    const root = document.querySelector(".pet-surface-root");
    const r = root.getBoundingClientRect();
    return { x: r.left + 24, y: r.top + 24 };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  const afterClick = await page.evaluate(() => ({
    clicked: window.__underClicked ?? false,
  }));
  check("page click passes through transparent root", afterClick.clicked, JSON.stringify(afterClick));
  await context.close();
}

// ── 2. Compact mode（400×500 < 600×560） ────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 400, height: 500 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const compact = await page.evaluate(() => {
    const btn = document.querySelector(".in-app-pet-character-btn");
    const root = document.querySelector(".pet-surface-root");
    return {
      hasBtn: !!btn,
      btnSize: btn ? { w: btn.getBoundingClientRect().width, h: btn.getBoundingClientRect().height } : null,
      root,
    };
  });
  check("compact button present", compact.hasBtn, JSON.stringify(compact.btnSize));
  check("compact button 96×132", compact.btnSize && Math.abs(compact.btnSize.w - 96) < 2 && Math.abs(compact.btnSize.h - 132) < 2, JSON.stringify(compact.btnSize));
  check("no standard root in compact", compact.root === null);
  // 点击 compact 按钮 → popover 打开
  await page.locator(".in-app-pet-character-btn").click();
  await page.waitForTimeout(500);
  const popover = await page.evaluate(() => !!document.querySelector(".in-app-pet-popover"));
  check("compact popover opens on click", popover);
  await context.close();
}

// ── 3. 200% zoom 等效视口（400×280 = 800×560 的一半 → compact） ──
{
  const context = await browser.newContext({ viewport: { width: 400, height: 280 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const isCompact = await page.evaluate(() => !!document.querySelector(".in-app-pet-character-btn"));
  check("200% zoom → compact", isCompact);
  await context.close();
}

// ── 4. visualViewport resize 切换模式 ──────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 400, height: 500 });
  await page.waitForTimeout(1200);
  const afterShrink = await page.evaluate(() => !!document.querySelector(".in-app-pet-character-btn"));
  check("resize 900→400 switches to compact", afterShrink);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(1200);
  const afterGrow = await page.evaluate(() => !!document.querySelector(".pet-surface-root"));
  check("resize 400→900 switches back to standard", afterGrow);
  await context.close();
}

// ── 5. reduced motion：dots 动画关闭 ───────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const dots = await page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "pet-bubble-dots";
    el.innerHTML = "<i></i><i></i><i></i>";
    document.body.appendChild(el);
    const name = getComputedStyle(el.querySelector("i")).animationName;
    el.remove();
    return name;
  });
  check("reduced motion disables dots animation", dots === "none", `animationName=${dots}`);
  await context.close();
}

await browser.close();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
