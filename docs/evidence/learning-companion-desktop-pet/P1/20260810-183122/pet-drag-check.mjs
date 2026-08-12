/**
 * 拖动 IPC 链路验证（真实 Electron）：
 * 1. 角色区域 pointer down → move → up；
 * 2. 主进程 dragBy 处理（窗口 setPosition + 持久化）；
 * 3. 窗口位置发生变化；locked=true 时拖动被忽略。
 */
import { _electron as electron } from "playwright";
import { readFileSync } from "node:fs";

const EMAIL = readFileSync("/tmp/pet-p1-user.env", "utf8").trim().split("\n")[0].replace("EMAIL=", "");
const PASSWORD = "PetDemoPass123!";

const electronApp = await electron.launch({
  executablePath: "/Users/asklins/Documents/study/apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  args: [".", "--no-sandbox", "--user-data-dir=/tmp/pet-p1-userdata-drag"],
  cwd: "/Users/asklins/Documents/study/apps/desktop",
  env: { ...process.env, AILEARN_DESKTOP_PET_SPIKE: "true", NEXT_PUBLIC_COMPANION_PET_ENABLED: "true" },
});

const mainWindow = await electronApp.firstWindow();
await mainWindow.waitForLoadState("domcontentloaded");
await mainWindow.getByPlaceholder("name@example.com").fill(EMAIL);
await mainWindow.getByPlaceholder("请输入密码").fill(PASSWORD);
await mainWindow.locator("button.login-submit").click();
await mainWindow.waitForTimeout(2500);

let petWindow = electronApp.windows().find((w) => w.url().includes("/companion/pet"));
for (let i = 0; i < 30 && !petWindow; i++) {
  await mainWindow.waitForTimeout(1000);
  petWindow = electronApp.windows().find((w) => w.url().includes("/companion/pet"));
}
if (!petWindow) { console.error("no pet window"); process.exit(1); }
await petWindow.reload();
await petWindow.waitForLoadState("domcontentloaded");
await petWindow.waitForSelector(".pet-character-hit-zone", { timeout: 30000 });
await petWindow.waitForTimeout(1500);

const getPetPos = () => electronApp.evaluate(({ BrowserWindow }) => {
  const wins = BrowserWindow.getAllWindows();
  const pet = wins.find((w) => w.webContents.getURL().includes("/companion/pet"));
  return pet ? pet.getPosition() : null;
});

const before = await getPetPos();
console.log("position before drag:", before);

// 记录 renderer 侧事件（诊断）
await petWindow.evaluate(() => {
  window.__ptrLog = [];
  document.addEventListener("pointerdown", (e) => window.__ptrLog.push({ t: "down", x: Math.round(e.clientX), y: Math.round(e.clientY), cls: e.target?.className?.slice?.(0, 40) ?? "?" }));
  document.addEventListener("pointerup", (e) => window.__ptrLog.push({ t: "up", x: Math.round(e.clientX), y: Math.round(e.clientY) }));
});

// 在角色区域执行拖动手势（角色 hit zone 中心）。
// 注：Playwright CDP 鼠标不更新 native 光标，主进程 poll 依据 native 光标判定
// 穿透；这里先强制 interactive 模拟“真实光标已在角色区域”的主进程判定。
await petWindow.evaluate(() => window.desktopAPI?.setInteractionMode("interactive"));
await petWindow.waitForTimeout(400);
const rect = await petWindow.evaluate(() => {
  const zone = document.querySelector(".pet-character-hit-zone");
  const r = zone.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await petWindow.mouse.move(rect.x, rect.y);
await petWindow.waitForTimeout(1200); // 等待主进程 poll 进入 interactive
await petWindow.mouse.down();
for (let i = 1; i <= 8; i++) {
  await petWindow.mouse.move(rect.x + i * 12, rect.y + i * 10);
  await petWindow.waitForTimeout(60);
}
await petWindow.mouse.up();
await petWindow.waitForTimeout(800);

const after = await getPetPos();
console.log("position after drag:", after);

const moved = before && after && (Math.abs(after[0] - before[0]) > 20 || Math.abs(after[1] - before[1]) > 20);
console.log(moved ? "PASS window moved via drag gesture" : "FAIL window did not move");

// 直接调用 desktopAPI.dragBy 验证 IPC → 主进程 setPosition 链路
const directBefore = await getPetPos();
await petWindow.evaluate(() => window.desktopAPI?.dragBy(80, 50));
await petWindow.waitForTimeout(800);
const directAfter = await getPetPos();
console.log("direct dragBy before/after:", JSON.stringify(directBefore), JSON.stringify(directAfter));
const directMoved = directBefore && directAfter && (Math.abs(directAfter[0] - directBefore[0]) >= 60 || Math.abs(directAfter[1] - directBefore[1]) >= 30);
console.log(directMoved ? "PASS direct dragBy moves window" : "FAIL direct dragBy did not move window");

// locked 时拖动被忽略
await petWindow.evaluate(() => window.desktopAPI?.setLocked(true));
await petWindow.waitForTimeout(500);
const lockedBefore = await getPetPos();
await petWindow.mouse.move(rect.x, rect.y);
await petWindow.waitForTimeout(1000);
await petWindow.mouse.down();
for (let i = 1; i <= 5; i++) {
  await petWindow.mouse.move(rect.x + i * 10, rect.y);
  await petWindow.waitForTimeout(60);
}
await petWindow.mouse.up();
await petWindow.waitForTimeout(600);
const lockedAfter = await getPetPos();
const lockedOk = lockedBefore && lockedAfter && lockedBefore[0] === lockedAfter[0] && lockedBefore[1] === lockedAfter[1];
console.log(lockedOk ? "PASS locked ignores drag" : "FAIL locked did not ignore drag");
await petWindow.evaluate(() => window.desktopAPI?.setLocked(false));

await electronApp.close();
process.exit(moved && lockedOk ? 0 : 1);
