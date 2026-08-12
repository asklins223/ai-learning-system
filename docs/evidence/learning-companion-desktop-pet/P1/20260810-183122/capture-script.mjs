import { _electron as electron } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "/tmp/pet-p1-evidence";
mkdirSync(OUT, { recursive: true });

const userLine = readFileSync("/tmp/pet-p1-user.env", "utf8").trim().split("\n")[0];
const EMAIL = userLine.replace("EMAIL=", "");
const PASSWORD = "PetDemoPass123!";

async function main() {
  const electronApp = await electron.launch({
    executablePath: "/Users/asklins/Documents/study/apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    args: [".", "--no-sandbox", "--user-data-dir=/tmp/pet-p1-userdata"],
    cwd: "/Users/asklins/Documents/study/apps/desktop",
    env: { ...process.env, AILEARN_DESKTOP_PET_SPIKE: "true", NEXT_PUBLIC_COMPANION_PET_ENABLED: "true", ELECTRON_ENABLE_LOGGING: "1" },
  });

  const mainWindow = await electronApp.firstWindow();
  await mainWindow.waitForLoadState("domcontentloaded");
  console.log("main window:", mainWindow.url());

  await mainWindow.getByPlaceholder("name@example.com").fill(EMAIL);
  await mainWindow.getByPlaceholder("请输入密码").fill(PASSWORD);
  await mainWindow.locator("button.login-submit").click();
  await mainWindow.waitForTimeout(2500);
  console.log("after login url:", mainWindow.url());

  let petWindow = electronApp.windows().find((w) => w.url().includes("/companion/pet"));
  for (let i = 0; i < 30 && !petWindow; i++) {
    await mainWindow.waitForTimeout(1000);
    petWindow = electronApp.windows().find((w) => w.url().includes("/companion/pet"));
  }
  if (!petWindow) {
    console.error("Pet window not found:", electronApp.windows().map((w) => w.url()));
    await electronApp.close();
    process.exit(1);
  }
  console.log("pet window:", petWindow.url());

  await petWindow.addInitScript(() => {
    window.addEventListener("unhandledrejection", (e) => {
      console.error("[unhandledrejection]", String(e.reason && e.reason.stack ? e.reason.stack : e.reason).slice(0, 1200));
    });
  });
  await petWindow.reload();
  await petWindow.waitForLoadState("domcontentloaded");
  await petWindow.waitForTimeout(4500);
  const diag = await petWindow.evaluate(async () => {
    const canvas = document.querySelector(".pet-character-canvas");
    let opaque = -1;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let o = 0;
      for (let i = 3; i < d.length; i += 64) if (d[i] > 200) o++;
      opaque = o;
    }
    const f = await fetch("/images/companion/pet/sprite-v1/idle.png", { cache: "no-store" });
    const bytes = (await f.arrayBuffer()).byteLength;
    const loadstate = canvas ? canvas.getAttribute("data-loadstate") : null;
    const canvasDim = canvas ? { w: canvas.width, h: canvas.height } : null;
    // 手动绘制（不含 mirror）验证 canvas 环境
    let manualOpaque = -1;
    let blobUrlOpaque = -1;
    let driverCloneOpaque = -1;
    if (canvas) {
      try {
        const blob = await (await fetch("/images/companion/pet/sprite-v1/idle.png", { cache: "no-store" })).blob();
        const url = URL.createObjectURL(blob);
        const img3 = new Image();
        img3.src = url;
        await img3.decode();
        const ctx3 = canvas.getContext("2d");
        const rect3 = { x: 300, y: 216.777, width: 244, height: 299.771 };
        const foot3 = { x: 422, y: 504 };
        const cssW = 244, cssH = 299.771;
        const localFoot = { x: foot3.x - rect3.x, y: foot3.y - rect3.y };
        ctx3.setTransform(2, 0, 0, 2, 0, 0);
        ctx3.clearRect(0, 0, cssW, cssH);
        ctx3.save();
        ctx3.translate(localFoot.x, localFoot.y);
        ctx3.scale(1, 1.003);
        ctx3.translate(-localFoot.x, -localFoot.y);
        ctx3.scale(-1, 1);
        ctx3.translate(-cssW, 0);
        ctx3.drawImage(img3, 0, 0, cssW, cssH);
        ctx3.restore();
        const d3 = ctx3.getImageData(0, 0, 244, 300).data;
        let o3 = 0;
        for (let i = 3; i < d3.length; i += 64) if (d3[i] > 200) o3++;
        driverCloneOpaque = o3;
      } catch (e) { driverCloneOpaque = -2; }
    }
    if (canvas) {
      try {
        const blob = await (await fetch("/images/companion/pet/sprite-v1/idle.png", { cache: "no-store" })).blob();
        const url = URL.createObjectURL(blob);
        const img2 = new Image();
        img2.src = url;
        await img2.decode();
        const ctx2 = canvas.getContext("2d");
        ctx2.setTransform(2, 0, 0, 2, 0, 0);
        ctx2.clearRect(0, 0, 244, 300);
        ctx2.drawImage(img2, 0, 0, 244, 299.77);
        const d2 = ctx2.getImageData(0, 0, 244, 300).data;
        let o2 = 0;
        for (let i = 3; i < d2.length; i += 64) if (d2[i] > 200) o2++;
        blobUrlOpaque = o2;
      } catch (e) { blobUrlOpaque = -2; }
    }
    if (canvas) {
      const ctx = canvas.getContext("2d");
      const img = new Image();
      img.src = "/images/companion/pet/sprite-v1/idle.png";
      await img.decode();
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, 244, 300);
      ctx.drawImage(img, 0, 0, 244, 299.77);
      const d = ctx.getImageData(0, 0, 244, 300).data;
      let o = 0;
      for (let i = 3; i < d.length; i += 64) if (d[i] > 200) o++;
      manualOpaque = o;
    }
    return { opaque, idleStatus: f.status, idleBytes: bytes, loadstate, canvasDim, manualOpaque, blobUrlOpaque, driverCloneOpaque };
  });
  console.log("DIAG:", JSON.stringify(diag));
  const boot = await petWindow.evaluate(() => (document.querySelector(".pet-surface-root") ? "surface" : "no-surface"));
  console.log("pet surface present:", boot);
  if (boot === "no-surface") {
    console.log("pet page text:", (await petWindow.evaluate(() => document.body.innerText.slice(0, 200))).trim());
  }
  console.log("demo api present:", await petWindow.evaluate(() => Boolean(window.__PET_DEMO__)));

  const shot = async (name) => {
    await petWindow.waitForTimeout(700);
    await petWindow.screenshot({ path: join(OUT, `${name}.png`) });
    console.log("saved", name);
  };

  await shot("G01_idle");

  await petWindow.evaluate(() => window.__PET_DEMO__.showIncoming());
  await shot("G02_incoming");

  await petWindow.evaluate(() => window.__PET_DEMO__.showComposer());
  await shot("G03_composer");

  await petWindow.evaluate(() => window.__PET_DEMO__.submitDemoMessage("请给我讲一下光合作用的过程"));
  await petWindow.waitForTimeout(400);
  await shot("G04_thinking");
  await petWindow.waitForTimeout(1050);
  await shot("G05_streaming");
  await petWindow.waitForTimeout(3000);
  await shot("G05_final");

  await petWindow.evaluate(() => window.__PET_DEMO__.showMenu("root"));
  await shot("G06_root_menu");
  await petWindow.evaluate(() => window.__PET_DEMO__.showMenu("study"));
  await shot("G07_study_menu");
  await petWindow.evaluate(() => window.__PET_DEMO__.showMenu("more"));
  await shot("G07_more_menu");

  await petWindow.evaluate(() => window.__PET_DEMO__.reset());
  await petWindow.evaluate(() => window.__PET_DEMO__.showVoiceStatus());
  await petWindow.waitForTimeout(900);
  await shot("G08_listening");

  await petWindow.evaluate(() => window.__PET_DEMO__.reset());
  await petWindow.evaluate(() => window.__PET_DEMO__.showSpeaking());
  await shot("G09_speaking");

  await petWindow.evaluate(() => window.__PET_DEMO__.reset());
  await petWindow.evaluate(() => window.__PET_DEMO__.showConfirmation());
  await shot("G10_confirmation");

  await petWindow.evaluate(() => window.__PET_DEMO__.reset());
  await petWindow.evaluate(() => window.__PET_DEMO__.showError());
  await shot("G11_error");

  await petWindow.evaluate(() => window.__PET_DEMO__.reset());
  await shot("G12_edges_default");

  await electronApp.close();
  console.log("done; evidence in", OUT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
