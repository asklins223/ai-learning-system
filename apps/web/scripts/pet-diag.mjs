import { _electron as electron } from "playwright";
import { readFileSync } from "node:fs";
const app = await electron.launch({
  executablePath: "/Users/asklins/Documents/study/apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  args: [".", "--no-sandbox", "--user-data-dir=/tmp/pet-p1-userdata"],
  cwd: "/Users/asklins/Documents/study/apps/desktop",
  env: { ...process.env, AILEARN_DESKTOP_PET_SPIKE: "true", NEXT_PUBLIC_COMPANION_PET_ENABLED: "true" },
});
const main = await app.firstWindow();
await main.waitForLoadState("domcontentloaded");
// 登录
const userLine = readFileSync("/tmp/pet-p1-user.env","utf8").split("\n")[0];
await main.getByPlaceholder("name@example.com").fill(userLine.replace("EMAIL=",""));
await main.getByPlaceholder("请输入密码").fill("PetDemoPass123!");
await main.locator("button.login-submit").click();
await main.waitForTimeout(2500);
let pet = app.windows().find((w) => w.url().includes("/companion/pet"));
for (let i = 0; i < 30 && !pet; i++) { await main.waitForTimeout(1000); pet = app.windows().find((w) => w.url().includes("/companion/pet")); }
if (!pet) { console.log("NO PET WINDOW"); await app.close(); process.exit(1); }
await pet.reload();
await pet.waitForLoadState("domcontentloaded");
await pet.waitForTimeout(5000);
const d = await pet.evaluate(() => {
  const canvas = document.querySelector(".pet-character-renderer canvas");
  let px = null;
  if (canvas) {
    const ctx = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const w = canvas.width, h = canvas.height;
    if (ctx) {
      const buf = new Uint8Array(w * h * 4);
      ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      // 找 alpha>100 的 bbox（webgl 原点在左下）
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (buf[(y * w + x) * 4 + 3] > 100) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (maxX >= 0) px = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, canvasW: w, canvasH: h };
    }
  }
  const probe = window.__PET_LIVE2D_PROBE__;
  return {
    probe: probe ? probe() : null,
    fit: window.__PET_LIVE2D_FIT__ ?? null,
    err: window.__PET_LIVE2D_ERROR__ ?? null,
    renderer: document.querySelector(".pet-character-renderer")?.getAttribute("data-renderer") ?? null,
    canvasPx: px,
    cal: window.__PET_LIVE2D_CAL__ ?? null,
  };
});
console.log("DIAG:", JSON.stringify(d));
await app.close();
