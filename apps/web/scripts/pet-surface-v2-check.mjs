import { _electron as electron } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/asklins/Documents/study";
const OUT = process.env.PET_EVIDENCE_OUT ?? "/tmp/pet-surface-v2-check";
const USER_DATA_DIR = process.env.PET_USER_DATA_DIR ?? "/tmp/pet-surface-v2-userdata";
const EMAIL = readFileSync("/tmp/pet-p1-user.env", "utf8")
  .trim()
  .split("\n")[0]
  .replace("EMAIL=", "");
const PASSWORD = "PetDemoPass123!";

mkdirSync(OUT, { recursive: true });

const report = {
  checkedAt: new Date().toISOString(),
  checks: {},
  positions: {},
  rendererErrors: [],
};

let electronApp;

function passed(name, value) {
  report.checks[name] = Boolean(value);
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
}

async function findPetWindow(mainWindow) {
  let petWindow = electronApp.windows().find((window) => window.url().includes("/companion/pet"));
  for (let index = 0; index < 30 && !petWindow; index += 1) {
    await mainWindow.waitForTimeout(1_000);
    petWindow = electronApp.windows().find((window) => window.url().includes("/companion/pet"));
  }
  if (!petWindow) throw new Error("Pet window not found");
  return petWindow;
}

async function getPetPosition() {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("/companion/pet"),
    );
    return pet?.getPosition() ?? null;
  });
}

async function forceInteractive(petWindow) {
  await petWindow.evaluate(() => window.desktopAPI?.setInteractionMode("interactive"));
  await petWindow.waitForTimeout(250);
}

async function characterCenter(petWindow) {
  return petWindow.locator(".pet-character-hit-zone").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
}

async function shortCharacterClick(petWindow) {
  await forceInteractive(petWindow);
  const point = await characterCenter(petWindow);
  await petWindow.mouse.move(point.x, point.y);
  await petWindow.mouse.down();
  await petWindow.waitForTimeout(70);
  await petWindow.mouse.up();
}

async function dragCharacter(petWindow, deltaX, deltaY) {
  await forceInteractive(petWindow);
  const point = await characterCenter(petWindow);
  await petWindow.mouse.move(point.x, point.y);
  await petWindow.mouse.down();
  for (let index = 1; index <= 8; index += 1) {
    await petWindow.mouse.move(
      point.x + (deltaX * index) / 8,
      point.y + (deltaY * index) / 8,
    );
    await petWindow.waitForTimeout(55);
  }
  await petWindow.mouse.up();
  await petWindow.waitForTimeout(650);
}

try {
  electronApp = await electron.launch({
    executablePath: join(ROOT, "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    args: [".", "--no-sandbox", `--user-data-dir=${USER_DATA_DIR}`],
    cwd: join(ROOT, "apps/desktop"),
    env: {
      ...process.env,
      AILEARN_DESKTOP_PET_SPIKE: "true",
      NEXT_PUBLIC_COMPANION_PET_ENABLED: "true",
    },
  });

  const mainWindow = await electronApp.firstWindow();
  await mainWindow.waitForLoadState("domcontentloaded");
  await mainWindow.waitForTimeout(2_500);
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

  const petWindow = await findPetWindow(mainWindow);
  petWindow.on("pageerror", (error) => report.rendererErrors.push(String(error)));
  petWindow.on("console", (message) => {
    if (message.type() === "error") report.rendererErrors.push(message.text());
  });
  await petWindow.reload();
  await petWindow.waitForLoadState("domcontentloaded");
  await petWindow.waitForSelector(".pet-character-hit-zone", { timeout: 30_000 });
  await petWindow.waitForTimeout(1_500);
  await petWindow.evaluate(() => window.__PET_DEMO__?.reset());

  await shortCharacterClick(petWindow);
  await petWindow.waitForSelector(".pet-composer", { state: "visible" });
  passed("character_short_click_opens_composer", true);
  await petWindow.screenshot({ path: join(OUT, "I01_character_click.png") });
  await petWindow.getByRole("button", { name: "关闭输入框" }).click();
  await petWindow.waitForSelector(".pet-composer", { state: "detached" });

  const beforeDrag = await getPetPosition();
  await dragCharacter(petWindow, -96, -64);
  const afterDrag = await getPetPosition();
  await petWindow.waitForTimeout(800);
  const afterDragSettled = await getPetPosition();
  report.positions.unlocked = { before: beforeDrag, after: afterDrag, settled: afterDragSettled };
  const moved = beforeDrag && afterDrag && (
    Math.abs(afterDrag[0] - beforeDrag[0]) > 20 ||
    Math.abs(afterDrag[1] - beforeDrag[1]) > 20
  );
  passed("character_direct_drag_moves_native_window", moved);
  passed("character_drag_does_not_recoil_after_release", afterDrag && afterDragSettled &&
    Math.abs(afterDragSettled[0] - afterDrag[0]) <= 2 &&
    Math.abs(afterDragSettled[1] - afterDrag[1]) <= 2);
  passed("character_drag_suppresses_click", await petWindow.locator(".pet-composer").count() === 0);
  await petWindow.screenshot({ path: join(OUT, "I02_character_dragged.png") });

  const directBefore = await getPetPosition();
  await petWindow.evaluate(() => window.desktopAPI?.dragBy(48, 32));
  await petWindow.waitForTimeout(500);
  const directAfter = await getPetPosition();
  report.positions.directBridge = { before: directBefore, after: directAfter };
  passed("typed_drag_bridge_moves_native_window", directBefore && directAfter && (
    Math.abs(directAfter[0] - directBefore[0]) >= 30 ||
    Math.abs(directAfter[1] - directBefore[1]) >= 20
  ));

  await petWindow.evaluate(() => window.desktopAPI?.setLocked(true));
  await petWindow.waitForFunction(() =>
    document.querySelector(".pet-surface-root")?.getAttribute("data-locked") === "true",
  );
  const lockedBefore = await getPetPosition();
  await dragCharacter(petWindow, -80, 0);
  const lockedAfter = await getPetPosition();
  report.positions.locked = { before: lockedBefore, after: lockedAfter };
  passed("locked_character_ignores_drag", lockedBefore && lockedAfter &&
    lockedBefore[0] === lockedAfter[0] && lockedBefore[1] === lockedAfter[1]);
  passed("locked_drag_attempt_suppresses_click", await petWindow.locator(".pet-composer").count() === 0);

  await petWindow.waitForTimeout(400);
  await shortCharacterClick(petWindow);
  await petWindow.waitForSelector(".pet-composer", { state: "visible" });
  passed("locked_character_short_click_still_works", true);
  await petWindow.screenshot({ path: join(OUT, "I03_locked_click.png") });
  await petWindow.getByRole("button", { name: "关闭输入框" }).click();
  await petWindow.waitForSelector(".pet-composer", { state: "detached" });
  await petWindow.evaluate(() => window.desktopAPI?.setLocked(false));

  await forceInteractive(petWindow);
  const menuPoint = await characterCenter(petWindow);
  await petWindow.mouse.click(menuPoint.x, menuPoint.y, { button: "right" });
  await petWindow.waitForSelector(".pet-menu", { state: "visible" });
  passed("character_context_click_opens_menu", true);
  await petWindow.screenshot({ path: join(OUT, "I04_character_menu.png") });

  await petWindow.getByRole("button", { name: "关闭菜单" }).click();
  await petWindow.getByRole("button", { name: "开始语音录入" }).click();
  await petWindow.waitForFunction(() =>
    document.querySelector(".pet-surface-root")?.getAttribute("data-voice-phase") === "listening",
  );
  passed("voice_single_tap_starts_listening", true);
  await petWindow.screenshot({ path: join(OUT, "I05_voice_listening.png") });

  // Companion ASR rejects clips shorter than 200ms. Leave a margin for
  // recorder/browser scheduling so the real Electron check is deterministic.
  await petWindow.waitForTimeout(350);
  await petWindow.getByRole("button", { name: "结束语音录入并开始识别" }).click();
  await petWindow.waitForFunction(() =>
    document.querySelector(".pet-surface-root")?.getAttribute("data-voice-phase") === "transcribing",
  );
  passed("voice_second_tap_stops_and_transcribes", true);
  await petWindow.screenshot({ path: join(OUT, "I06_voice_recognizing.png") });

  // ffprobe is bounded to 3s and the external ASR provider may add network
  // latency; give the real integration check enough room to observe a valid
  // response without treating a slow provider as a renderer failure.
  await petWindow.waitForSelector(".pet-composer", { state: "visible", timeout: 20_000 });
  const transcript = await petWindow.locator(".pet-composer-input").inputValue();
  passed("voice_transcript_returns_to_editable_composer", transcript.length > 0);
  const overlap = await petWindow.evaluate(() => {
    const composer = document.querySelector(".pet-composer")?.getBoundingClientRect();
    const voice = document.querySelector(".pet-voice-control-button")?.getBoundingClientRect();
    if (!composer || !voice) return null;
    return Math.max(0, Math.min(composer.right, voice.right) - Math.max(composer.left, voice.left)) *
      Math.max(0, Math.min(composer.bottom, voice.bottom) - Math.max(composer.top, voice.top));
  });
  passed("external_voice_button_does_not_cover_composer", overlap === 0);
  await petWindow.waitForTimeout(350);
  await petWindow.screenshot({ path: join(OUT, "I07_voice_transcript.png") });

  await petWindow.waitForTimeout(500);
  passed("renderer_has_no_runtime_errors", report.rendererErrors.length === 0);
  writeFileSync(join(OUT, "interaction-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const failed = Object.values(report.checks).some((value) => !value);
  if (failed) process.exitCode = 1;
} catch (error) {
  report.fatalError = String(error?.stack ?? error);
  writeFileSync(join(OUT, "interaction-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (electronApp) await electronApp.close();
}
