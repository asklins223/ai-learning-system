/**
 * Live2D vendor 失败 → Sprite 回退验证（dev server :3010）。
 * 拦截 vendor 脚本请求使其失败，期望最终 data-renderer="sprite"（用户角色）。
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const EMAIL = readFileSync("/tmp/pet-p1-user.env", "utf8").trim().split("\n")[0].replace("EMAIL=", "");
const PASSWORD = "PetDemoPass123!";
const BASE = "http://127.0.0.1:3010/companion/pet";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 900, height: 700 } });

// 拦截 Live2D vendor 脚本 → 加载失败
await context.route("**/live2d-dev/vendor/*", (route) => route.abort());
await context.route("**/live2d-dev/mao-pro/runtime/mao_pro.model3.json", (route) => route.abort());

const loginPage = await context.newPage();
await loginPage.goto("http://127.0.0.1:3010/login", { waitUntil: "domcontentloaded" });
await loginPage.getByPlaceholder("name@example.com").fill(EMAIL);
await loginPage.getByPlaceholder("请输入密码").fill(PASSWORD);
await loginPage.locator("button.login-submit").click();
await loginPage.waitForTimeout(2500);
await loginPage.close();

const page = await context.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
// 等待 Sprite fallback（Sprite 资产加载完成）
await page.waitForSelector("[data-renderer='sprite']", { timeout: 30000 });
await page.waitForTimeout(1500);

const result = await page.evaluate(() => ({
  renderer: document.querySelector(".pet-character-renderer")?.getAttribute("data-renderer"),
  canvasSize: (() => {
    const c = document.querySelector(".pet-character-canvas");
    return c ? `${c.width}x${c.height}` : null;
  })(),
  hasFallbackLabel: document.querySelector(".pet-character-renderer")?.getAttribute("aria-label"),
}));
console.log("fallback result:", JSON.stringify(result));
const ok = result.renderer === "sprite" && result.canvasSize && result.canvasSize !== "0x0";
console.log(ok ? "PASS fallback to Sprite" : "FAIL fallback");
await page.screenshot({ path: "/tmp/pet-p1-evidence/live2d_fallback_sprite_check.png" });
await browser.close();
process.exit(ok ? 0 : 1);
