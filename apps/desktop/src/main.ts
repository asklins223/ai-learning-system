/**
 * Electron main process for the AI Learn desktop app.
 *
 * Lifecycle (frontend-only):
 *  1. Show splash/loading window
 *  2. Start Next.js web server as a child process
 *  3. Wait for the web server to become healthy
 *  4. Switch to the main BrowserWindow loading http://localhost:3000
 *  5. On quit: stop the Next.js process
 *
 * The backend (Docker / API / Postgres / Worker) is managed externally.
 */

// Critical: ensure we run as Electron, not plain Node.
// This runs via esbuild banner before require("electron") — see esbuild.mjs.

import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import * as path from "node:path";
import { logger } from "./logger";
import {
  startWebServer,
  stopWebServer,
  WEB_PORT,
} from "./web-manager";

// ─── Window management ──────────────────────────────────────────────

let splashWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let startupAborted = false;

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 680,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    frame: true,
    title: "AI Learn",
    show: false,
    backgroundColor: "#1a1a2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    splashWindow = null;
    // If the user closes the splash before the app started, quit.
    if (!mainWindow) {
      startupAborted = true;
      app.quit();
    }
  });

  return win;
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: "AI Learn",
    backgroundColor: "#1a1a2e",
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

// ─── Status / log broadcasting ──────────────────────────────────────

function sendStatus(status: string, detail?: string) {
  splashWindow?.webContents.send("desktop:status", status, detail);
  logger.info(`[status] ${status}${detail ? ` — ${detail}` : ""}`);
}

function sendLog(line: string) {
  splashWindow?.webContents.send("desktop:log", line);
}

// ─── Startup sequence ───────────────────────────────────────────────

async function startupSequence(): Promise<void> {
  try {
    // 1. Start the Next.js web server.
    sendStatus("starting-web", "启动前端服务…");
    const started = await startWebServer((line) => sendLog(line));
    if (!started) {
      sendStatus("error-web");
      showWebError();
      return;
    }

    // 2. Switch to the main window.
    sendStatus("ready", "前端已就绪，正在打开…");
    await openMainWindow();

  } catch (err) {
    logger.error("[startup] Unexpected error:", err);
    sendStatus("error-unknown", err instanceof Error ? err.message : String(err));
  }
}

async function openMainWindow(): Promise<void> {
  if (startupAborted) return;

  mainWindow = createMainWindow();
  await mainWindow.loadURL(`http://127.0.0.1:${WEB_PORT}`);

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

// ─── Error dialogs ──────────────────────────────────────────────────

function showWebError(): void {
  void dialog.showMessageBox({
    type: "error",
    title: "前端启动失败",
    message: "无法启动 Next.js 前端服务",
    detail:
      "前端服务启动失败。可能原因:\n" +
      "• apps/web 目录下未安装依赖 (npm install)\n" +
      "• 端口 3000 被其他程序占用\n" +
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
    splashWindow = createSplashWindow();

    setTimeout(() => {
      startupSequence().catch((err) => {
        logger.error("[app] Startup sequence crashed:", err);
      });
    }, 500);

    // IPC handlers
    ipcMain.handle("desktop:get-version", () => app.getVersion());

    ipcMain.on("desktop:retry", () => {
      logger.info("[app] User requested retry — restarting app…");
      app.relaunch();
      app.quit();
    });

    ipcMain.on("desktop:open-external", (_event, url: string) => {
      void shell.openExternal(url);
    });

    ipcMain.on("desktop:quit", () => {
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    if (mainWindow) {
      app.quit();
    }
  });

  app.on("before-quit", (event) => {
    event.preventDefault();

    logger.info("[app] Stopping web server before quit…");
    sendStatus("stopping", "正在停止前端服务…");

    // Stop the Next.js process synchronously (it's fast — SIGTERM).
    stopWebServer();

    app.exit(0);
  });
}

// ─── Splash window HTML ─────────────────────────────────────────────

const SPLASH_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Learn</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
    background: linear-gradient(145deg, #0f0f1e 0%, #1a1a2e 50%, #16213e 100%);
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 48px 32px;
    overflow: hidden;
    -webkit-user-select: none;
  }
  .header { text-align: center; }
  .logo {
    font-size: 48px;
    font-weight: 700;
    background: linear-gradient(135deg, #6c5ce7, #a29bfe, #74b9ff);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -1px;
  }
  .subtitle { font-size: 14px; color: #888; margin-top: 8px; }
  .status-area {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(108, 92, 231, 0.2);
    border-top-color: #6c5ce7;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-text { font-size: 14px; color: #b0b0b0; text-align: center; min-height: 20px; }
  .status-detail { font-size: 12px; color: #666; text-align: center; min-height: 18px; }
  .log-area {
    width: 100%;
    max-height: 140px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: "SF Mono", "Monaco", monospace;
    font-size: 11px;
    line-height: 1.6;
    color: #555;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .footer { font-size: 11px; color: #444; text-align: center; }
  .error-icon { font-size: 48px; margin-bottom: 16px; }
  .btn {
    background: #6c5ce7;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 10px 24px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .btn:hover { background: #5a4bd1; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">AI Learn</div>
    <div class="subtitle">智能学习系统 · 桌面版</div>
  </div>

  <div class="status-area" id="statusArea">
    <div class="spinner" id="spinner"></div>
    <div class="status-text" id="statusText">正在初始化…</div>
    <div class="status-detail" id="statusDetail"></div>
  </div>

  <div class="log-area" id="logArea" style="display:none;"></div>

  <div class="footer">AI Learn Desktop v0.5.0</div>

<script>
  const { desktopAPI } = window;
  const statusText = document.getElementById("statusText");
  const statusDetail = document.getElementById("statusDetail");
  const spinner = document.getElementById("spinner");
  const logArea = document.getElementById("logArea");
  const statusArea = document.getElementById("statusArea");

  const STATUS_MESSAGES = {
    "starting-web": "启动前端服务…",
    "ready": "服务已就绪！",
    "stopping": "正在停止服务…",
    "error-web": "前端启动失败",
    "error-unknown": "发生未知错误",
  };

  let logLines = [];

  desktopAPI.onStatus((status, detail) => {
    const msg = STATUS_MESSAGES[status] || status;
    statusText.textContent = msg;
    statusDetail.textContent = detail || "";

    if (status.startsWith("error")) {
      spinner.style.display = "none";
      statusArea.innerHTML = '<div class="error-icon">⚠️</div>' +
        '<div class="status-text">' + msg + '</div>' +
        '<div class="status-detail">' + (detail || "") + '</div>' +
        '<button class="btn" onclick="desktopAPI.retry()">重试</button>' +
        '<button class="btn" style="margin-left:8px;background:#444;" onclick="desktopAPI.quit()">退出</button>';
    }

    if (status === "starting-web" && logArea.style.display === "none") {
      logArea.style.display = "block";
    }
  });

  desktopAPI.onLog((line) => {
    logLines.push(line);
    if (logLines.length > 200) logLines = logLines.slice(-200);
    logArea.textContent = logLines.join("");
    logArea.scrollTop = logArea.scrollHeight;
  });

  desktopAPI.getVersion().then(v => {
    document.querySelector(".footer").textContent = "AI Learn Desktop v" + v;
  });
</script>
</body>
</html>`;
