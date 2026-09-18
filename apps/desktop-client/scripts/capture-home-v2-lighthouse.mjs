import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _electron as electron } from "@playwright/test";
import "./load-capture-env.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const reviewRoot = resolve(appRoot, "../../.impeccable/review/home-v2-lighthouse-runtime-v1");
const installedElectron = resolve(appRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const ignoredElectron = resolve(appRoot, "node_modules/.ignored/electron/dist/Electron.app/Contents/MacOS/Electron");
const workspaceElectron = resolve(appRoot, "../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const executablePath = [installedElectron, ignoredElectron, workspaceElectron].find(existsSync);
const credentialsAvailable = Boolean(process.env.OWNER_EMAIL?.trim() && process.env.OWNER_PASSWORD);
const fixturePairingKeyId = "home-v2-capture-key";
const fixturePairingSecret = Buffer.alloc(32, 17);
const fixtureSchemaRevision = "home-v2-capture-domain-v1";
const fixtureInstanceId = "home-v2-capture-api";
const fixtureUserId = "10000000-0000-4000-8000-000000000001";
const fixtureWorkspaceId = "10000000-0000-4000-8000-000000000002";
const fixtureToken = "home-v2-capture-token";

if (!credentialsAvailable) throw new Error("OWNER_EMAIL and OWNER_PASSWORD are required for the Home V2 runtime capture");
if (!executablePath) throw new Error("No installed Electron executable was found");
await mkdir(reviewRoot, { recursive: true });

const fixtureWorkspace = {
  workspaceId: fixtureWorkspaceId,
  workspaceName: "首页视觉验收空间",
  role: "owner",
  workspaceType: "personal",
  isPersonal: true,
  leftAt: null,
};
const fixtureAuthResponse = {
  token: fixtureToken,
  ctx: { userId: fixtureUserId, workspaceId: fixtureWorkspaceId, membershipRole: "owner" },
  workspaces: [fixtureWorkspace],
};
const fixtureAuthMe = {
  userId: fixtureUserId,
  workspaceId: fixtureWorkspaceId,
  email: "owner@ailearn.local",
  role: "owner",
  displayName: "首页验收",
  avatarUrl: null,
  workspaceName: fixtureWorkspace.workspaceName,
  workspaceType: "personal",
  isPersonal: true,
  personalWorkspaceId: fixtureWorkspaceId,
};
const fixtureDashboard = {
  version: 2,
  snapshotAt: "2026-09-15T01:00:00.000Z",
  dashboardRevision: "home-v2-capture-dashboard-v1",
  counts: { notes: 3, activeObjectives: 1, activeRuns: 0, reviewsDue: 2, needsRepair: 0 },
  mode: "review_due",
  primaryFocus: null,
  queue: [],
  recentObjectives: [],
  suggestedNote: null,
  degradation: null,
};
const fixtureRoomProfile = {
  version: 1,
  revision: 1,
  unlockedDecorIds: [],
  equippedDecorBySlot: { desk: null, shelf: null, window: null, rest: null },
  unlockedEffectIds: [],
  equippedEffectId: null,
  updatedAt: "2026-09-15T01:00:00.000Z",
};
const fixtureCompanionHome = {
  version: 1,
  snapshotAt: "2026-09-15T01:00:00.000Z",
  profileSummary: {
    name: "小岚",
    activeness: "moderate",
    boundaries: {
      allowPlayful: true,
      allowNudgeLearning: true,
      allowVoiceTags: false,
      catchphrase: "慢慢来。",
    },
    familiarity: 0.45,
    interactionCount: 3,
    source: "saved_profile",
  },
  memorySummary: { confirmedCount: 0, candidateCount: 0, updatedAt: null },
  proactiveCue: null,
  roomProfile: fixtureRoomProfile,
};

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(body === null ? "" : JSON.stringify(body));
}

async function createCaptureApiFixture() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/_ailearn/desktop/trust/v1/challenge") {
      const input = await readRequestJson(request);
      const unsigned = {
        version: 1,
        nonce: input?.nonce,
        serviceId: "ailearn-api",
        ipcContractVersion: "desktop-ipc-v1",
        domainSchemaRevision: fixtureSchemaRevision,
        pairingKeyId: fixturePairingKeyId,
        instanceId: fixtureInstanceId,
        algorithm: "HMAC-SHA256",
      };
      const message = [
        "ailearn-local-api-trust-v1",
        unsigned.nonce,
        unsigned.serviceId,
        unsigned.ipcContractVersion,
        unsigned.domainSchemaRevision,
        unsigned.pairingKeyId,
        unsigned.instanceId,
      ].join("\n");
      sendJson(response, 200, {
        ...unsigned,
        signature: createHmac("sha256", fixturePairingSecret).update(message, "ascii").digest("hex"),
      });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "api", timestamp: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/ready") {
      sendJson(response, 200, { status: "ready", service: "api", timestamp: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/auth/login") {
      await readRequestJson(request);
      sendJson(response, 200, fixtureAuthResponse);
      return;
    }
    if (url.pathname === "/auth/me") {
      sendJson(response, 200, fixtureAuthMe);
      return;
    }
    if (url.pathname === "/auth/workspaces") {
      sendJson(response, 200, { workspaces: [fixtureWorkspace] });
      return;
    }
    if (url.pathname === "/auth/switch-workspace") {
      await readRequestJson(request);
      sendJson(response, 200, fixtureAuthResponse);
      return;
    }
    if (url.pathname === "/auth/capabilities/v1") {
      sendJson(response, 503, { error: "fixture capability intentionally unavailable" });
      return;
    }
    if (url.pathname === "/v2/learning-dashboard") {
      sendJson(response, 200, fixtureDashboard, { ETag: '"home-v2-capture-dashboard-v1"' });
      return;
    }
    if (url.pathname === "/companion/home-projection") {
      sendJson(response, 200, fixtureCompanionHome);
      return;
    }
    if (url.pathname === "/companion/room-profile") {
      sendJson(response, 200, fixtureRoomProfile);
      return;
    }
    sendJson(response, 404, { error: "capture fixture route not found" });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Capture API fixture did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

const captureApi = await createCaptureApiFixture();

async function setViewport(electronApp, width, height, zoomFactor = 1) {
  await electronApp.evaluate(({ BrowserWindow }, input) => {
    const target = BrowserWindow.getAllWindows()[0];
    target?.setMinimumSize(1, 1);
    target?.webContents.setZoomFactor(input.zoomFactor);
    target?.setContentSize(input.width, input.height);
    target?.center();
  }, { width, height, zoomFactor });
}

async function captureElectronViewport(electronApp, outputPath) {
  const pngBase64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("Home V2 capture window is unavailable");
    const snapshot = await target.capturePage();
    return snapshot.toPNG().toString("base64");
  });
  await writeFile(outputPath, Buffer.from(pngBase64, "base64"));
}

async function enterOwnerRoom(page) {
  await page.waitForFunction(
    () => Boolean(document.querySelector(".scene-stage"))
      || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined,
    { timeout: 20_000 },
  );
  if (await page.locator(".scene-stage").count()) return;
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL);
  await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && await page.locator(".scene-stage").count() === 0) {
    const error = page.locator(".desktop-access-gate__form-error");
    if (await error.count()) throw new Error(`Owner login failed: ${await error.innerText()}`);
    const workspaces = page.locator(".desktop-access-gate__workspace-list button");
    if (await workspaces.count()) {
      const owner = workspaces.filter({ hasText: "所有者" }).first();
      await (await owner.count() ? owner : workspaces.first()).click();
    }
    await page.waitForTimeout(250);
  }
  await page.locator(".scene-stage").waitFor({ state: "visible", timeout: 2_000 });
}

async function readContract(page) {
  return page.evaluate(() => {
    const frame = document.querySelector(".room-reference-frame");
    const canvasHost = document.querySelector(".room-pixi-canvas");
    const companion = document.querySelector(".companion-presence");
    const companionRenderer = document.querySelector(".window-live2d");
    const companionVisual = document.querySelector("[data-companion-live2d-target='true']");
    const companionRect = companionVisual?.getBoundingClientRect() ?? null;
    const hud = document.querySelector(".home-v2-hud");
    const hudTrigger = document.querySelector(".home-v2-hud__trigger");
    const hudStyle = hud ? getComputedStyle(hud) : null;
    const hudRect = hud?.getBoundingClientRect() ?? null;
    const hudTriggerRect = hudTrigger?.getBoundingClientRect() ?? null;
    const hudButtons = [...(hud?.querySelectorAll("button") ?? [])];
    const hudButtonRects = hudButtons.map((node) => node.getBoundingClientRect());
    const controlIsland = document.querySelector(".immersive-island--home-v2");
    const controlTrigger = controlIsland?.querySelector(".island-trigger");
    const controlStyle = controlIsland ? getComputedStyle(controlIsland) : null;
    const controlRect = controlIsland?.getBoundingClientRect() ?? null;
    const controlTriggerRect = controlTrigger?.getBoundingClientRect() ?? null;
    const controlButtons = [...(controlIsland?.querySelectorAll("button") ?? [])];
    const controlButtonRects = controlButtons.map((node) => node.getBoundingClientRect());
    const homePosters = [...document.querySelectorAll(".room-backplate--home-day, .room-backplate--home-dusk, .room-backplate--home-night")];
    const visibleHomePosters = homePosters.filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity) > 0.5;
    });
    const hotspots = [...document.querySelectorAll(".home-v2-object")];
    const hotspotRects = hotspots.map((node) => node.getBoundingClientRect());
    const compactNav = document.querySelector(".home-v2-compact-nav");
    const compactButtons = [...(compactNav?.querySelectorAll("button") ?? [])];
    const compactButtonRects = compactButtons.map((node) => node.getBoundingClientRect());
    const compactNavStyle = compactNav ? getComputedStyle(compactNav) : null;
    const compactNavRect = compactNav?.getBoundingClientRect() ?? null;
    const compactNavCenter = compactNavRect
      ? [compactNavRect.left + compactNavRect.width / 2, compactNavRect.top + compactNavRect.height / 2]
      : null;
    const compactTopElement = compactNavCenter
      ? document.elementFromPoint(compactNavCenter[0], compactNavCenter[1])
      : null;
    return {
      sceneTime: frame?.getAttribute("data-home-scene-time") ?? null,
      sceneRenderer: frame?.getAttribute("data-scene-renderer") ?? null,
      rendererState: canvasHost?.getAttribute("data-scene-renderer-state") ?? "missing",
      rendererReason: canvasHost?.getAttribute("data-scene-renderer-reason") ?? null,
      rendererName: canvasHost?.getAttribute("data-scene-renderer-name") ?? null,
      rendererWorld: canvasHost?.getAttribute("data-scene-renderer-world") ?? null,
      rendererDepths: canvasHost?.getAttribute("data-scene-renderer-depth-order") ?? null,
      declaredLayerCount: Number.parseInt(frame?.getAttribute("data-scene-room-layer-count") ?? "0", 10),
      canvasCount: canvasHost?.querySelectorAll("canvas").length ?? 0,
      tickerHosts: document.querySelectorAll(".room-pixi-canvas").length,
      independentLayers: Number.parseInt(canvasHost?.getAttribute("data-scene-renderer-independent-layers") ?? "0", 10),
      blockedLayers: Number.parseInt(canvasHost?.getAttribute("data-scene-renderer-layer-blocked") ?? "0", 10),
      failedLayers: Number.parseInt(canvasHost?.getAttribute("data-scene-renderer-layer-failed") ?? "0", 10),
      foregroundLayers: document.querySelectorAll(".home-v2-foreground-occlusion img").length,
      visiblePosterCount: visibleHomePosters.length,
      visiblePosterClass: visibleHomePosters[0]?.className ?? null,
      companionWorldAnchor: companion?.getAttribute("data-world-anchor") ?? null,
      companionRenderer: companionRenderer?.getAttribute("data-companion-renderer") ?? null,
      companionStatus: companionRenderer?.getAttribute("data-companion-status") ?? null,
      companionRect: companionRect ? {
        left: companionRect.left,
        top: companionRect.top,
        width: companionRect.width,
        height: companionRect.height,
      } : null,
      hudVisible: Boolean(
        hudStyle
        && hudStyle.display !== "none"
        && hudStyle.visibility !== "hidden"
        && Number.parseFloat(hudStyle.opacity) > 0
        && hudRect?.width
        && hudRect.height
      ),
      hudRect: hudRect ? {
        left: hudRect.left,
        top: hudRect.top,
        width: hudRect.width,
        height: hudRect.height,
      } : null,
      hudExpanded: hud?.classList.contains("home-v2-hud--expanded") ?? false,
      hudTriggerRect: hudTriggerRect ? {
        left: hudTriggerRect.left,
        top: hudTriggerRect.top,
        width: hudTriggerRect.width,
        height: hudTriggerRect.height,
      } : null,
      hudButtonCount: hudButtons.length,
      hudButtonMinWidth: hudButtonRects.length ? Math.min(...hudButtonRects.map((rect) => rect.width)) : null,
      hudButtonMinHeight: hudButtonRects.length ? Math.min(...hudButtonRects.map((rect) => rect.height)) : null,
      controlVisible: Boolean(
        controlStyle
        && controlStyle.display !== "none"
        && controlStyle.visibility !== "hidden"
        && controlTriggerRect?.width
        && controlTriggerRect.height
      ),
      controlExpanded: controlIsland?.classList.contains("immersive-island--expanded") ?? false,
      controlRect: controlRect ? {
        left: controlRect.left,
        top: controlRect.top,
        width: controlRect.width,
        height: controlRect.height,
      } : null,
      controlTriggerRect: controlTriggerRect ? {
        left: controlTriggerRect.left,
        top: controlTriggerRect.top,
        width: controlTriggerRect.width,
        height: controlTriggerRect.height,
      } : null,
      controlButtonCount: controlButtons.length,
      controlButtonMinWidth: controlButtonRects.length ? Math.min(...controlButtonRects.map((rect) => rect.width)) : null,
      controlButtonMinHeight: controlButtonRects.length ? Math.min(...controlButtonRects.map((rect) => rect.height)) : null,
      hotspotCount: hotspots.length,
      hotspotMinWidth: hotspotRects.length ? Math.min(...hotspotRects.map((rect) => rect.width)) : null,
      hotspotMinHeight: hotspotRects.length ? Math.min(...hotspotRects.map((rect) => rect.height)) : null,
      compactMedia: matchMedia("(max-width: 720px), (max-height: 480px)").matches,
      compactNavVisible: Boolean(
        compactNavStyle
        && compactNavStyle.display !== "none"
        && compactNavStyle.visibility !== "hidden"
        && Number.parseFloat(compactNavStyle.opacity) > 0
        && compactNav?.getBoundingClientRect().width
        && compactNav.getBoundingClientRect().height
      ),
      compactNavRect: compactNavRect ? {
        left: compactNavRect.left,
        top: compactNavRect.top,
        width: compactNavRect.width,
        height: compactNavRect.height,
      } : null,
      compactNavOpacity: compactNavStyle?.opacity ?? null,
      compactNavZIndex: compactNavStyle?.zIndex ?? null,
      compactNavIsTopLayer: Boolean(compactTopElement && compactNav?.contains(compactTopElement)),
      compactTopElement: compactTopElement
        ? `${compactTopElement.tagName.toLowerCase()}.${[...compactTopElement.classList].join(".")}`
        : null,
      compactButtonCount: compactButtons.length,
      compactButtonMinWidth: compactButtonRects.length ? Math.min(...compactButtonRects.map((rect) => rect.width)) : null,
      compactButtonMinHeight: compactButtonRects.length ? Math.min(...compactButtonRects.map((rect) => rect.height)) : null,
      viewport: { width: window.innerWidth, height: window.innerHeight, scale: window.visualViewport?.scale ?? 1 },
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
    };
  });
}

function assertWideContract(contract, expectedTime) {
  if (
    contract.sceneTime !== expectedTime
    || contract.sceneRenderer !== "poster-live2d"
    || contract.rendererState !== "missing"
    || contract.declaredLayerCount !== 0
    || contract.canvasCount !== 0
    || contract.tickerHosts !== 0
    || contract.independentLayers !== 0
    || contract.blockedLayers !== 0
    || contract.failedLayers !== 0
    || contract.foregroundLayers !== 0
    || contract.visiblePosterCount !== 1
    || contract.companionRenderer !== "live2d"
    || contract.companionStatus !== "ready"
    || !contract.companionRect
    || contract.companionRect.width < 180
    || contract.companionRect.height < 260
    || !contract.hudVisible
    || !contract.hudTriggerRect
    || contract.hudTriggerRect.width < 220
    || contract.hudTriggerRect.height < 44
    || contract.hudButtonCount !== 3
    || contract.hudButtonMinWidth < 44
    || contract.hudButtonMinHeight < 44
    || !contract.controlVisible
    || !contract.controlRect
    || !contract.controlTriggerRect
    || contract.controlTriggerRect.width < 44
    || contract.controlTriggerRect.height < 44
    || contract.controlButtonCount !== 8
    || contract.controlButtonMinWidth < 44
    || contract.controlButtonMinHeight < 44
    || contract.hudTriggerRect.left >= contract.viewport.width / 2
    || contract.hudTriggerRect.top <= contract.viewport.height / 2
    || contract.controlTriggerRect.left <= contract.viewport.width / 2
    || contract.controlTriggerRect.top >= 80
    || contract.horizontalOverflow > 1
    || (contract.hotspotMinWidth !== null && contract.hotspotMinWidth < 44)
    || (contract.hotspotMinHeight !== null && contract.hotspotMinHeight < 44)
  ) throw new Error(`Home V2 wide runtime contract failed: ${JSON.stringify(contract)}`);
}

async function captureTime(name, hour, minute, captureMatrix = false) {
  const userDataDir = await mkdtemp(resolve(tmpdir(), `ailearn-home-v2-${name}-`));
  const errors = [];
  const electronApp = await electron.launch({
    args: [".", "--lang=zh-CN", `--user-data-dir=${userDataDir}`],
    cwd: appRoot,
    executablePath,
    env: {
      ...process.env,
      DESKTOP_API_ORIGIN: captureApi.origin,
      AILEARN_DESKTOP_PAIRING_KEY_ID: fixturePairingKeyId,
      AILEARN_DESKTOP_PAIRING_SECRET: fixturePairingSecret.toString("base64url"),
      AILEARN_DOMAIN_SCHEMA_REVISION: fixtureSchemaRevision,
      DESKTOP_DEPLOYMENT_CONFIG_REVISION: "home-v2-capture-v1",
    },
  });
  try {
    const page = await electronApp.firstWindow();
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    await page.addInitScript(({ fixedHour, fixedMinute }) => {
      Date.prototype.getHours = () => fixedHour;
      Date.prototype.getMinutes = () => fixedMinute;
    }, { fixedHour: hour, fixedMinute: minute });
    await page.reload();
    await setViewport(electronApp, 1672, 941, 1);
    try {
      await enterOwnerRoom(page);
    } catch (error) {
      await page.screenshot({ path: resolve(reviewRoot, `home-v2-${name}-startup-failure.png`) }).catch(() => undefined);
      const state = await page.evaluate(() => ({
        title: document.title,
        readyState: document.readyState,
        bodyText: document.body?.innerText.slice(0, 800) ?? "",
        bodyClasses: document.body?.className ?? "",
        rootHtml: document.querySelector("#root")?.innerHTML.slice(0, 1_200) ?? "",
      })).catch(() => null);
      throw new Error(`Home V2 startup failed: ${error instanceof Error ? error.message : String(error)}; ${JSON.stringify({ state, errors })}`);
    }
    await page.waitForFunction(
      () => document.querySelector(".window-live2d")?.getAttribute("data-companion-status") !== "loading",
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(6_300);
    await page.waitForFunction(
      () => document.querySelector(".desktop-app")?.hasAttribute("data-home-v2-intro") !== true,
      undefined,
      { timeout: 8_000 },
    );
    await page.waitForTimeout(450);

    const primaryContract = await readContract(page);
    assertWideContract(primaryContract, name);
    await writeFile(resolve(reviewRoot, `home-v2-${name}-1672x941.json`), `${JSON.stringify(primaryContract, null, 2)}\n`);
    await page.screenshot({ path: resolve(reviewRoot, `home-v2-${name}-1672x941.png`) });

    if (captureMatrix) {
      await page.locator(".home-v2-hud__trigger").click();
      await page.waitForTimeout(420);
      const expandedHudContract = await readContract(page);
      if (!expandedHudContract.hudExpanded || !expandedHudContract.hudVisible) {
        throw new Error(`Home V2 HUD did not expand: ${JSON.stringify(expandedHudContract)}`);
      }
      await writeFile(resolve(reviewRoot, `home-v2-${name}-hud-expanded.json`), `${JSON.stringify(expandedHudContract, null, 2)}\n`);
      await page.screenshot({ path: resolve(reviewRoot, `home-v2-${name}-hud-expanded.png`) });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(260);
      await page.locator(".immersive-island--home-v2 .island-trigger").click();
      await page.waitForTimeout(360);
      const expandedControlContract = await readContract(page);
      if (!expandedControlContract.controlExpanded || !expandedControlContract.controlVisible) {
        throw new Error(`Home V2 control island did not expand: ${JSON.stringify(expandedControlContract)}`);
      }
      await writeFile(resolve(reviewRoot, `home-v2-${name}-controls-expanded.json`), `${JSON.stringify(expandedControlContract, null, 2)}\n`);
      await page.screenshot({ path: resolve(reviewRoot, `home-v2-${name}-controls-expanded.png`) });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(260);

      for (const [region, objectId] of [
        ["desk", "desk-book"],
        ["shelf", "magic-catalog"],
        ["window", "window-stars"],
        ["rest", "rest-cushion"],
      ]) {
        await page.locator(`[data-room-object="${objectId}"]`).click();
        await page.waitForFunction(
          (expectedRegion) => document.querySelector(".home-v2-objects")?.getAttribute("data-active-zone") === expectedRegion
            && document.querySelector(".home-v2-region-menu")?.getAttribute("data-region") === expectedRegion
            && document.querySelector(".desktop-app")?.getAttribute("data-home-v2-camera-state") !== "moving"
            && document.querySelector(".companion-presence")?.getAttribute("data-companion-motion-phase") === "settled",
          region,
          { timeout: 5_000 },
        );
        const regionContract = await page.evaluate(() => ({
          featureCount: document.querySelectorAll(".home-v2-region-menu [data-feature]").length,
          minTarget: Math.min(...[...document.querySelectorAll(".home-v2-region-menu button")].map((button) => Math.min(button.getBoundingClientRect().width, button.getBoundingClientRect().height))),
          taskSurface: document.querySelector(".task-surface")?.textContent?.trim() ?? null,
          companionWorldAnchor: document.querySelector(".companion-presence")?.getAttribute("data-world-anchor") ?? null,
        }));
        if (regionContract.featureCount < 3 || regionContract.minTarget < 44 || regionContract.taskSurface || regionContract.companionWorldAnchor !== primaryContract.companionWorldAnchor) {
          throw new Error(`Home V2 ${region} navigation contract failed: ${JSON.stringify(regionContract)}`);
        }
        await page.screenshot({ path: resolve(reviewRoot, `home-v2-day-region-${region}.png`) });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector(".home-v2-objects")?.getAttribute("data-active-zone") === "wide");
      }

      const companionDragTarget = page.locator(".companion-presence .window-live2d > button");
      const companionDragBox = await companionDragTarget.boundingBox();
      if (!companionDragBox) throw new Error("Home V2 companion drag target is unavailable");
      const dragStart = {
        x: companionDragBox.x + companionDragBox.width / 2,
        y: companionDragBox.y + companionDragBox.height / 2,
      };
      await page.mouse.move(dragStart.x, dragStart.y);
      await page.mouse.down();
      await page.mouse.move(dragStart.x + 72, dragStart.y + 18, { steps: 3 });
      const movingOrientation = await page.evaluate(() => {
        const pose = document.querySelector(".companion-character-motion");
        if (!pose) return null;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(pose).transform);
        return {
          mirrored: matrix.a * matrix.d - matrix.b * matrix.c < 0,
          rotation: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI,
          scaleX: Math.hypot(matrix.a, matrix.b),
        };
      });
      await page.mouse.up();
      if (
        !movingOrientation
        || movingOrientation.mirrored
        || movingOrientation.scaleX < 0.999
        || Math.abs(movingOrientation.rotation) > 0.01
      ) {
        throw new Error(`Home V2 companion changed facing while moving: ${JSON.stringify(movingOrientation)}`);
      }

      await page.locator('[data-room-object="desk-book"]').click();
      await page.locator('.home-v2-region-menu [data-feature="continue"]').click();
      await page.locator(".home-v2-feature-notice[open]").waitFor({ state: "visible" });
      await page.waitForTimeout(360);
      const noticeContract = await page.evaluate(() => ({
        taskSurface: document.querySelector(".task-surface")?.textContent?.trim() ?? null,
        actionLabels: [...document.querySelectorAll(".home-v2-feature-notice button")].map((button) => button.textContent?.trim()),
        live2dPaused: document.querySelector(".window-live2d")?.getAttribute("data-paused") === "true",
      }));
      if (noticeContract.taskSurface || !noticeContract.live2dPaused || !noticeContract.actionLabels.includes("知道了") || !noticeContract.actionLabels.includes("查看全部功能")) {
        throw new Error(`Home V2 pending sheet contract failed: ${JSON.stringify(noticeContract)}`);
      }
      await page.screenshot({ path: resolve(reviewRoot, "home-v2-day-feature-notice.png") });
      await page.getByRole("button", { name: "查看全部功能" }).click();
      await page.locator(".home-v2-catalog[open]").waitFor({ state: "visible" });
      await page.waitForTimeout(420);
      const catalogContract = await page.evaluate(() => ({
        groups: [...document.querySelectorAll(".home-v2-catalog__group")].map((group) => group.querySelector("h3")?.textContent?.trim()),
        featureIds: [...document.querySelectorAll(".home-v2-catalog [data-feature]")].map((feature) => feature.getAttribute("data-feature")),
        horizontalOverflow: document.querySelector(".home-v2-catalog__scroll")
          ? document.querySelector(".home-v2-catalog__scroll").scrollWidth - document.querySelector(".home-v2-catalog__scroll").clientWidth
          : null,
      }));
      if (catalogContract.groups.length !== 5 || catalogContract.featureIds.length !== 19 || new Set(catalogContract.featureIds).size !== 19 || catalogContract.horizontalOverflow > 1) {
        throw new Error(`Home V2 catalog contract failed: ${JSON.stringify(catalogContract)}`);
      }
      await writeFile(resolve(reviewRoot, "home-v2-day-catalog.json"), `${JSON.stringify(catalogContract, null, 2)}\n`);
      await page.screenshot({ path: resolve(reviewRoot, "home-v2-day-catalog.png") });

      await page.locator('.home-v2-catalog [data-feature="all-notes"]').click();
      await page.locator(".home-v2-feature-notice[open]").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".home-v2-feature-notice")?.hasAttribute("open") && document.querySelector(".home-v2-catalog")?.hasAttribute("open"));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".home-v2-catalog")?.hasAttribute("open") && document.querySelector(".home-v2-objects")?.getAttribute("data-active-zone") === "desk");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector(".home-v2-objects")?.getAttribute("data-active-zone") === "wide");

      for (const [width, height] of [[1440, 810], [1280, 720]]) {
        await setViewport(electronApp, width, height, 1);
        await page.waitForTimeout(650);
        const contract = await readContract(page);
        assertWideContract(contract, name);
        await writeFile(resolve(reviewRoot, `home-v2-${name}-${width}x${height}.json`), `${JSON.stringify(contract, null, 2)}\n`);
        await page.screenshot({ path: resolve(reviewRoot, `home-v2-${name}-${width}x${height}.png`) });
      }
      await setViewport(electronApp, 1672, 941, 1);
      for (const zoomFactor of [1.25, 1.5, 2]) {
        await setViewport(electronApp, 1440, 810, zoomFactor);
        await page.waitForTimeout(650);
        const contract = await readContract(page);
        if (contract.horizontalOverflow > 1) throw new Error(`Home V2 overflowed at ${zoomFactor * 100}%: ${JSON.stringify(contract)}`);
        if (
          zoomFactor === 2
          && (
            !contract.compactMedia
            || !contract.compactNavVisible
            || !contract.compactNavIsTopLayer
            || contract.compactButtonCount < 4
            || contract.compactButtonMinWidth < 44
            || contract.compactButtonMinHeight < 44
          )
        ) {
          throw new Error(`Home V2 did not expose its compact semantic room at 200%: ${JSON.stringify(contract)}`);
        }
        if (zoomFactor === 2) {
          await page.locator(".home-v2-compact-nav").screenshot({
            path: resolve(reviewRoot, `home-v2-${name}-zoom-200-compact-nav.png`),
          });
          await page.evaluate(() => new Promise((resolveFrame) => {
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
          }));
          await page.evaluate(() => window.dispatchEvent(new CustomEvent("ailearn:home-v2-run-feature", { detail: { featureId: "catalog" } })));
          await page.locator(".home-v2-catalog[open]").waitFor({ state: "visible" });
          await page.waitForTimeout(420);
          const compactCatalogOverflow = await page.locator(".home-v2-catalog__scroll").evaluate((node) => node.scrollWidth - node.clientWidth);
          if (compactCatalogOverflow > 1) throw new Error(`Home V2 compact catalog overflowed: ${compactCatalogOverflow}`);
          const compactCatalogContract = await page.evaluate(() => {
            const rectOf = (node) => {
              const rect = node.getBoundingClientRect();
              return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
            };
            const catalog = document.querySelector(".home-v2-catalog[open]");
            const header = catalog?.querySelector(".home-v2-catalog__header");
            const buttons = [...(header?.querySelectorAll("button") ?? [])];
            return {
              viewport: { width: window.innerWidth, height: window.innerHeight },
              catalog: catalog ? rectOf(catalog) : null,
              header: header ? rectOf(header) : null,
              buttons: buttons.map(rectOf),
              horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          const compactRects = [compactCatalogContract.catalog, compactCatalogContract.header, ...compactCatalogContract.buttons];
          if (
            compactCatalogContract.horizontalOverflow > 1
            || compactRects.some((rect) => !rect
              || rect.left < -1
              || rect.top < -1
              || rect.right > compactCatalogContract.viewport.width + 1
              || rect.bottom > compactCatalogContract.viewport.height + 1)
            || compactCatalogContract.buttons.some((rect) => rect.width < 44 || rect.height < 44)
          ) {
            throw new Error(`Home V2 compact catalog escaped the visible viewport: ${JSON.stringify(compactCatalogContract)}`);
          }
          await writeFile(resolve(reviewRoot, `home-v2-${name}-zoom-200-catalog.json`), `${JSON.stringify(compactCatalogContract, null, 2)}\n`);
          await captureElectronViewport(electronApp, resolve(reviewRoot, `home-v2-${name}-zoom-200-catalog.png`));
          await page.getByRole("button", { name: "关闭魔法目录" }).click();
        }
        await writeFile(resolve(reviewRoot, `home-v2-${name}-zoom-${zoomFactor * 100}.json`), `${JSON.stringify(contract, null, 2)}\n`);
        if (zoomFactor === 2) {
          await captureElectronViewport(electronApp, resolve(reviewRoot, `home-v2-${name}-zoom-${zoomFactor * 100}.png`));
        } else {
          await page.screenshot({ path: resolve(reviewRoot, `home-v2-${name}-zoom-${zoomFactor * 100}.png`) });
        }
      }
    }

    const normalizedErrors = errors.filter((message) => !message.includes("ResizeObserver loop"));
    if (normalizedErrors.length) throw new Error(`Renderer errors:\n${normalizedErrors.join("\n")}`);
  } finally {
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

try {
  await captureTime("day", 10, 0, true);
  await captureTime("dusk", 18, 30);
  await captureTime("night", 23, 0);
  await writeFile(resolve(reviewRoot, "capture-fixture.json"), `${JSON.stringify({
    schemaVersion: 1,
    evidenceKind: "visual-runtime-fixture",
    realBusinessData: false,
    rendererPath: "real-electron-ipc-react-static-poster-live2d",
    requestedRoutes: [...new Set(captureApi.requests)],
  }, null, 2)}\n`);
  console.log(`Captured Home V2 lighthouse runtime evidence in ${reviewRoot}`);
} finally {
  await captureApi.close();
}
