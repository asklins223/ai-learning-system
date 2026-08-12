import { _electron as electron } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.PET_EVIDENCE_OUT ?? "/tmp/pet-p1-evidence";
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

  await mainWindow.waitForTimeout(2500);
  const emailInput = mainWindow.getByPlaceholder("name@example.com");
  if (mainWindow.url().includes("/login") || await emailInput.count()) {
    await emailInput.waitFor({ state: "visible", timeout: 15_000 });
    await emailInput.fill(EMAIL);
    await mainWindow.getByPlaceholder("请输入密码").fill(PASSWORD);
    const rememberInput = mainWindow.locator(".login-remember input");
    if (await rememberInput.count() && !(await rememberInput.isChecked())) {
      await mainWindow.locator(".login-remember").click();
    }
    await mainWindow.locator("button.login-submit").click();
    await mainWindow.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 });
  }
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
  await petWindow.waitForTimeout(7000);
  const diag = await petWindow.evaluate(async () => {
    const renderer = document.querySelector(".pet-character-renderer");
    const rendererMode = renderer?.getAttribute("data-renderer") ?? null;
    const canvas = document.querySelector(".pet-character-canvas");
    let opaque = -1;
    if (canvas && rendererMode === "sprite") {
      const ctx = canvas.getContext("2d");
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let o = 0;
      for (let i = 3; i < d.length; i += 64) if (d[i] > 200) o++;
      opaque = o;
    }
    const f = await fetch("/images/companion/pet/sprite-v1/idle.png", { cache: "no-store" });
    const bytes = (await f.arrayBuffer()).byteLength;
    const canvasDim = canvas ? { w: canvas.width, h: canvas.height } : null;
    return { rendererMode, opaque, idleStatus: f.status, idleBytes: bytes, canvasDim };
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

  await petWindow.evaluate(() => window.__PET_DEMO__.submitDemoMessage("请给我详细讲一下光合作用的光反应阶段和暗反应阶段的完整过程，包括光系统II、电子传递链、ATP合成、Calvin循环、RuBP再生等每一个环节的分子机制和能量变化"));
  await petWindow.waitForTimeout(400);
  await shot("G04_thinking");
  await petWindow.waitForTimeout(1050);
  await shot("G05_streaming");

  // 滚动验证：长文本气泡应出现滚动区并自动滚到底（跟随最新内容）
  const scroll = await petWindow.evaluate(() => {
    const el = document.querySelector("[data-bubble-scroll]");
    if (!el) return null;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollable: el.scrollHeight > el.clientHeight, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
  });
  console.log("SCROLL_CHECK:", JSON.stringify(scroll));

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
  await petWindow.evaluate(() => window.__PET_DEMO__.showTranscribing());
  await petWindow.waitForTimeout(850);
  await shot("G08_recognizing");
  await petWindow.waitForTimeout(1_300);
  await shot("G08_transcript_review");

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
