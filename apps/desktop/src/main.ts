/**
 * Electron main process for the AI Learn desktop app.
 *
 * Lifecycle (frontend-only):
 *  1. Start Next.js web server (utility process in packaged mode,
 *     child process in dev mode) on a dynamically-allocated port
 *  2. Wait for the web server to become healthy (with identity verification)
 *  3. Open the main BrowserWindow loading http://127.0.0.1:<port>
 *  4. On quit: stop the Next.js process
 *
 * The backend (Docker / API / Postgres / Worker) is managed externally.
 */

// Critical: ensure we run as Electron, not plain Node.
// This runs via esbuild banner before require("electron") — see esbuild.mjs.

import { app, BrowserWindow, shell, dialog } from "electron";
import { logger } from "./logger";
import {
  startWebServer,
  stopWebServer,
} from "./web-manager";

// ─── Window management ──────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    // Treat the configured bounds as renderer bounds. The web shell has
    // viewport-locked workbenches, so subtracting native chrome from these
    // dimensions would create a different layout in the packaged app.
    useContentSize: true,
    show: false,
    title: "AI Learn",
    // Keep the native macOS traffic lights while letting the existing web
    // headers become the title bar. titleBarOverlay exposes the
    // env(titlebar-area-*) safe-area variables used by the renderer.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          titleBarOverlay: { height: 56 },
        }
      : {}),
    // Match the web app's canvas color so there's no flash of dark
    // before the CSS variables load.
    backgroundColor: "#f5f3ee",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // Open external links in the system browser, not a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  return win;
}

// ─── Startup sequence ───────────────────────────────────────────────

async function startupSequence(): Promise<void> {
  try {
    // 1. Start the Next.js web server.
    //    Returns the dynamically-allocated port (avoids Docker conflicts
    //    on 3000). Uses utilityProcess in packaged mode (no Dock icon).
    logger.info("[startup] Starting Next.js web server…");
    const port = await startWebServer((line) => {
      logger.info(`[web] ${line.trimEnd()}`);
    });
    if (port === null) {
      showWebError();
      return;
    }

    // 2. Open the main window.
    logger.info(`[startup] Web ready on port ${port} — opening main window.`);
    mainWindow = createMainWindow();
    // BUG-49 修复：单独处理 loadURL 失败，区分页面加载错误和其他启动错误。
    try {
      await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    } catch (loadErr) {
      logger.error("[startup] Failed to load web page:", loadErr);
      showWebError(
        `前端页面加载失败: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}\n` +
        "Web 服务已启动但页面无法加载，可能是 SSR 编译错误或运行时异常。"
      );
      return;
    }

  } catch (err) {
    logger.error("[startup] Unexpected error:", err);
    showWebError(err instanceof Error ? err.message : String(err));
  }
}

// ─── Error dialogs ──────────────────────────────────────────────────

function showWebError(detail?: string): void {
  void dialog.showMessageBox({
    type: "error",
    title: "前端启动失败",
    message: "无法启动 Next.js 前端服务",
    detail:
      (detail ? `${detail}\n\n` : "") +
      "可能原因:\n" +
      "• apps/web 目录下未安装依赖 (npm install)\n" +
      "• 端口 3000–3019 均被其他程序占用\n" +
      "• Node.js 运行时不可用\n\n" +
      "请查看日志文件获取详细信息，然后重试。",
    buttons: ["退出"],
  }).then(() => app.quit());
}

// ─── App lifecycle ──────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    logger.info(`[app] AI Learn Desktop v${app.getVersion()} starting…`);
    startupSequence().catch((err) => {
      logger.error("[app] Startup sequence crashed:", err);
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  // BUG-06 修复：添加 shuttingDown 标志防止重复执行退出逻辑
  let shuttingDown = false;
  app.on("before-quit", async (event) => {
    // 防止快连退出导致重复执行清理逻辑
    if (shuttingDown) {
      event.preventDefault();
      return;
    }
    shuttingDown = true;
    event.preventDefault();
    logger.info("[app] Stopping web server before quit…");
    // SEC-04: Await stopWebServer to give the Next.js process time to
    // shut down gracefully before app.exit(0). Without this, the child
    // process could become an orphan occupying the port.
    // SEC-06 修复：添加 5 秒超时保护，防止 Next.js 进程挂起导致应用无法退出
    try {
      await Promise.race([
        stopWebServer(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("stopWebServer timeout")), 5_000),
        ),
      ]);
    } catch (err) {
      logger.error("[app] Error stopping web server:", err);
    }
    app.exit(0);
  });
}
