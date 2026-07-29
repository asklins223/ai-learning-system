/**
 * Next.js web server manager for the AI Learn desktop app.
 *
 * In dev mode: spawns `next dev -p 3000` from the source directory.
 * In packaged mode: spawns `next start -p 3000` from the bundled
 *   pre-built app (`.next/` + `node_modules/` included in resources).
 *
 * The Next.js process runs natively (not in Docker) for faster startup
 * and better integration with the Electron BrowserWindow.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "./logger";

const WEB_PORT = 3000;
const MAX_WEB_HEALTH_RETRIES = 30; // 30 × 2s = 60s
const HEALTH_INTERVAL_MS = 2000;

let webProcess: ChildProcess | null = null;

/** Resolve the web app directory (contains package.json + next.config.mjs). */
export function resolveWebDir(): string {
  // In packaged mode, the pre-built web app lives in resources/web/
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, "web");
    if (existsSync(path.join(packaged, "package.json"))) {
      return packaged;
    }
  }

  // In dev mode, find apps/web relative to the project root.
  // Walk up from cwd or __dirname to find the repo root.
  const searchRoots = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."),  // apps/desktop/dist → apps → repo root
    path.resolve(__dirname, "..", "..", ".."),
  ];

  for (const root of searchRoots) {
    const candidate = path.join(root, "apps", "web");
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  // Fallback: assume apps/web is two levels up from apps/desktop/
  return path.resolve(__dirname, "..", "..", "web");
}

/** Resolve the Node.js binary to use for spawning Next.js. */
function resolveNodeBinary(): string {
  // 1. Try ELECTRON_RUN_AS_NODE — use Electron's bundled Node.js.
  //    This works for `next start` (production mode).
  // 2. Fall back to system `node` from PATH (after fixPath).

  // For dev mode, we need the system `node` because `next dev` uses
  // tsx/esbuild which may have issues with ELECTRON_RUN_AS_NODE.
  if (!app.isPackaged) {
    // Try to find system node.
    const nodeCandidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
    ];
    for (const candidate of nodeCandidates) {
      if (existsSync(candidate)) return candidate;
    }
    return "node"; // Rely on PATH
  }

  // For packaged mode, use Electron's Node.js.
  // The `process.execPath` is the Electron binary.
  // Setting ELECTRON_RUN_AS_NODE=1 makes it behave as plain Node.js.
  return process.execPath;
}

/**
 * Start the Next.js web server as a child process.
 *
 * - Dev mode: `next dev -p 3000`
 * - Packaged mode: `next start -p 3000` (uses pre-built .next/)
 *
 * Returns true if the server started and became healthy.
 */
export async function startWebServer(
  onProgress?: (line: string) => void,
): Promise<boolean> {
  if (webProcess) {
    logger.info("[web] Server already running — skipping start.");
    return true;
  }

  const webDir = resolveWebDir();
  logger.info(`[web] Web directory: ${webDir}`);

  if (!existsSync(path.join(webDir, "package.json"))) {
    logger.error(`[web] package.json not found in ${webDir}`);
    return false;
  }

  // Determine command + args.
  const isDev = !app.isPackaged;
  const nodeBin = resolveNodeBinary();

  // Find the `next` CLI binary.
  const nextBinCandidates = [
    path.join(webDir, "node_modules", ".bin", "next"),
    path.join(webDir, "node_modules", "next", "dist", "bin", "next"),
  ];
  let nextBin = "";
  for (const candidate of nextBinCandidates) {
    if (existsSync(candidate)) {
      nextBin = candidate;
      break;
    }
  }
  if (!nextBin) {
    logger.error("[web] next CLI not found — node_modules may not be installed.");
    onProgress?.("错误: 未找到 next CLI，请先在 apps/web 运行 npm install");
    return false;
  }

  logger.info(`[web] Node binary: ${nodeBin}`);
  logger.info(`[web] Next CLI: ${nextBin}`);

  // Environment for the Next.js process.
  // INTERNAL_API_URL tells Next.js where the API server is (127.0.0.1:4000).
  // NEXT_PUBLIC_* flags must be set at build time, so in packaged mode they're
  // already baked into .next/. In dev mode, we pass them as env vars.
  const webEnv: Record<string, string> = {
    ...process.env,
    INTERNAL_API_URL: "http://127.0.0.1:4000",
    NODE_ENV: isDev ? "development" : "production",
    PORT: String(WEB_PORT),
  };

  if (isDev) {
    webEnv.NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED = "true";
    webEnv.NEXT_PUBLIC_AI_QUESTION_V1_ENABLED = "true";
    webEnv.NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED = "true";
    webEnv.NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED = "true";
  }

  // In packaged mode, use ELECTRON_RUN_AS_NODE=1 so the Electron binary
  // acts as a plain Node.js runtime.
  if (!isDev) {
    webEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  const args = isDev ? ["dev", "-p", String(WEB_PORT)] : ["start", "-p", String(WEB_PORT)];

  logger.info(`[web] Spawning: ${nodeBin} ${nextBin} ${args.join(" ")}`);

  webProcess = spawn(nodeBin, [nextBin, ...args], {
    cwd: webDir,
    env: webEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect output for progress and logging.
  webProcess.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onProgress?.(text);
    logger.info(`[web:out] ${text.trimEnd()}`);
  });

  webProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onProgress?.(text);
    logger.warn(`[web:err] ${text.trimEnd()}`);
  });

  webProcess.on("error", (err) => {
    logger.error("[web] Spawn error:", err);
    webProcess = null;
  });

  webProcess.on("close", (code) => {
    logger.info(`[web] Process exited with code ${code}`);
    webProcess = null;
  });

  // Wait for the web server to become healthy.
  return waitForWebHealthy(onProgress);
}

/** Poll the web service until it responds with 200. */
async function waitForWebHealthy(onProgress?: (msg: string) => void): Promise<boolean> {
  const url = `http://127.0.0.1:${WEB_PORT}`;

  for (let i = 0; i < MAX_WEB_HEALTH_RETRIES; i++) {
    if (!webProcess) {
      logger.error("[web] Process died during health check.");
      return false;
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        logger.info(`[web] Healthy after ${(i + 1) * 2}s.`);
        onProgress?.(`前端服务已就绪 (${(i + 1) * 2}s)`);
        return true;
      }
    } catch {
      // Not ready yet.
    }

    const elapsed = (i + 1) * 2;
    onProgress?.(`启动前端服务… (${elapsed}s)`);
    await sleep(HEALTH_INTERVAL_MS);
  }

  logger.error(`[web] Did not become healthy within ${MAX_WEB_HEALTH_RETRIES * 2}s.`);
  return false;
}

/** Stop the Next.js web server. */
export function stopWebServer(): void {
  if (!webProcess) {
    logger.info("[web] No process to stop.");
    return;
  }

  logger.info("[web] Stopping Next.js server…");

  // Send SIGTERM for graceful shutdown.
  webProcess.kill("SIGTERM");

  // Force kill after 5 seconds if still alive.
  const proc = webProcess;
  setTimeout(() => {
    if (webProcess === proc && !proc.killed) {
      logger.warn("[web] Force killing after timeout.");
      proc.kill("SIGKILL");
    }
  }, 5000).unref();

  webProcess = null;
  logger.info("[web] Server stopped.");
}

export { WEB_PORT };
