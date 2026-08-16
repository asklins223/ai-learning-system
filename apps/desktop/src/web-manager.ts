/**
 * Next.js web server manager for the AI Learn desktop app.
 *
 * In dev mode: spawns `next dev -p <port>` from the source directory
 *   using the system Node.js binary.
 *
 * In packaged mode: uses `utilityProcess.fork()` to run the Next.js
 *   server as an Electron Helper process. This avoids spawning the
 *   Electron binary with ELECTRON_RUN_AS_NODE=1, which would create a
 *   second app instance in the macOS Dock (displaying a black "exec"
 *   icon and bouncing indefinitely).
 *
 * Port allocation:
 *   The manager scans for a free port starting from 3000. If port 3000
 *   is already responding (e.g. Docker web service), it tries the next
 *   port up to 3019. This prevents accidental connection to an external
 *   service on the same port.
 *
 * Identity verification:
 *   A random token is generated on each start. The utility-process worker
 *   exposes a `/__desktop_health` endpoint that requires the token via
 *   `Authorization: Bearer` and returns only `service`/`port` (SEC-14 后
 *   不再回显 token)。The health check sends the token header and verifies
 *   `service` before considering the server ready, ensuring we connected
 *   to our own service and not a stale process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { app, utilityProcess, type UtilityProcess } from "electron";
import { logger } from "./logger";

const DEFAULT_WEB_PORT = 3000;
const PORT_SCAN_RANGE = 20; // Try ports 3000–3019
const MAX_WEB_HEALTH_RETRIES = 30; // 30 × 2s = 60s
const HEALTH_INTERVAL_MS = 2000;

// ─── Process handle ─────────────────────────────────────────────────

type ManagedProcess = ChildProcess | UtilityProcess;

let webProcess: ManagedProcess | null = null;
let webPort: number | null = null;

/** Type guard: check if a process is a UtilityProcess (has postMessage). */
function isUtility(proc: ManagedProcess): proc is UtilityProcess {
  return typeof (proc as UtilityProcess).postMessage === "function";
}

// ─── Path resolution ────────────────────────────────────────────────

/** Resolve the web app directory (contains package.json + next.config.mjs). */
export function resolveWebDir(): string {
  // In packaged mode, prefer the standalone output (traced node_modules)
  // which is much smaller than the full node_modules.
  if (app.isPackaged) {
    // Next.js standalone preserves monorepo structure: standalone/apps/web/
    const standaloneApp = path.join(
      process.resourcesPath, "web", ".next", "standalone", "apps", "web",
    );
    if (existsSync(path.join(standaloneApp, "package.json"))) {
      return standaloneApp;
    }
    // Fallback to full web directory (non-standalone build)
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

// ─── Port allocation ────────────────────────────────────────────────

/** Check if a port is already responding to HTTP requests. */
async function isPortResponding(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(1000),
    });
    // Any HTTP response (even non-200) means something is listening.
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Check if a port is free to bind (no process listening). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find a free port starting from `startPort`.
 *
 * Skips ports that are already responding to HTTP (e.g. Docker) or
 * already bound by another process. This prevents the desktop app
 * from accidentally connecting to an external service.
 *
 * QUAL-42 安全注释：此函数存在 TOCTOU（Time-of-Check to Time-of-Use）竞态——
 * isPortFree 检查端口可用后到 next dev 实际绑定的短暂窗口内，
 * 其他进程可能抢占该端口。这在实践中风险极低：
 *   1. 端口扫描范围 3000-3019，同机多服务同时抢占同一端口的概率极小
 *   2. next dev 启动失败会通过 health check 检测到（waitForWebHealthy）
 *   3. 即使端口冲突，用户可通过重启应用恢复
 * 如未来需要更严格的保证，可改用 SO_REUSEADDR + bind 后再传 fd 给 next dev。
 */
async function findFreePort(startPort: number): Promise<number> {
  const maxExtension = 10;

  const probeRange = async (from: number, count: number, label: string): Promise<number | null> => {
    const ports = Array.from({ length: count }, (_, i) => from + i);
    // 并行探测候选端口，避免串行 isPortResponding（最坏每端口 1s 超时）
    // 累积成几十秒的启动阻塞。仍按升序取第一个空闲端口，保证确定性。
    const results = await Promise.all(ports.map(async (port) => {
      // If something is already responding on this port, skip it —
      // it's likely Docker or another service.
      if (await isPortResponding(port)) {
        logger.info(`[web] Port ${port} is already responding — skipping${label ? ` (${label})` : ""}.`);
        return null;
      }
      // Verify the port is actually free to bind.
      if (await isPortFree(port)) {
        return port;
      }
      logger.info(`[web] Port ${port} is bound but not responding — skipping${label ? ` (${label})` : ""}.`);
      return null;
    }));
    return results.find((p) => p !== null) ?? null;
  };

  // 首次扫描：指定范围 3000-3019
  const primary = await probeRange(startPort, PORT_SCAN_RANGE, "");
  if (primary !== null) return primary;

  // SEC-05 修复：自动重试，扩大搜索范围到 3020-3029
  const extended = await probeRange(startPort + PORT_SCAN_RANGE, maxExtension, "retry");
  if (extended !== null) {
    logger.info(`[web] Found free port ${extended} after extension`);
    return extended;
  }

  throw new Error(
    `No free port found in range ${startPort}–${startPort + PORT_SCAN_RANGE + maxExtension - 1}`,
  );
}

// ─── Dev mode: spawn with system Node.js ────────────────────────────

/**
 * Resolve the system Node.js binary (dev mode only).
 *
 * QUAL-22: This function is only used in dev mode (packaged mode uses
 * utilityProcess.fork). It checks common Homebrew locations first for
 * a faster resolution, then falls back to `"node"` which relies on PATH.
 * Users with nvm/fnm/volta will hit the fallback, which is correct but
 * slower. The function intentionally does not spawn `which node` to avoid
 * the overhead of a child process on every dev-mode startup.
 */
function resolveNodeBinary(): string {
  const nodeCandidates = [
    "/opt/homebrew/bin/node",   // macOS Apple Silicon (Homebrew)
    "/usr/local/bin/node",       // macOS Intel (Homebrew)
  ];
  for (const candidate of nodeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: rely on PATH (works for nvm/fnm/volta users)
  return "node";
}

/**
 * Start Next.js in dev mode using `spawn` with the system Node.js.
 *
 * In dev mode there is no Dock issue because we spawn the system `node`
 * binary (not the Electron app binary).
 */
async function startWebServerDev(
  webDir: string,
  port: number,
  onProgress?: (line: string) => void,
): Promise<number | null> {
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
    return null;
  }

  logger.info(`[web] Node binary: ${nodeBin}`);
  logger.info(`[web] Next CLI: ${nextBin}`);

  const webEnv: Record<string, string> = {
    ...process.env,
    INTERNAL_API_URL: "http://127.0.0.1:4000",
    NODE_ENV: "development",
    PORT: String(port),
    NEXT_PUBLIC_COMPANION_PET_ENABLED: "true",
    NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: "true",
    NEXT_PUBLIC_AI_QUESTION_V1_ENABLED: "true",
    NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED: "true",
    // R36+ 放行：与 apps/web/lib/feature-flags.ts 全开关对齐（方案 20 V2 核心）。
    NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED: "true",
    NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: "true",
    NEXT_PUBLIC_LEARNING_RUN_V1: "true",
    NEXT_PUBLIC_STAR_MAP_ACTION_V1: "true",
    NEXT_PUBLIC_COMPANION_JOURNEY_V2: "true",
    NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED: "true",
  };

  const args = ["dev", "-p", String(port)];
  logger.info(`[web] Spawning (dev): ${nodeBin} ${nextBin} ${args.join(" ")}`);

  const child = spawn(nodeBin, [nextBin, ...args], {
    cwd: webDir,
    env: webEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  webProcess = child;

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onProgress?.(text);
    logger.info(`[web:out] ${text.trimEnd()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onProgress?.(text);
    logger.warn(`[web:err] ${text.trimEnd()}`);
  });

  child.on("error", (err) => {
    logger.error("[web] Spawn error:", err);
    webProcess = null;
  });

  child.on("close", (code) => {
    logger.info(`[web] Process exited with code ${code}`);
    webProcess = null;
  });

  // SEC-17 安全注释：dev 模式健康检查不验证身份（token 为 null）。
  // 风险：如果 isPortResponding 检测失败但 waitForWebHealthy 发现了其他开发服务，
  //   桌面端可能连接到非本应用的其他本地服务。
  // 缓解措施：
  //   1. isPortResponding 会先检测端口占用，若已被占用则跳过该端口
  //   2. dev 模式仅用于本地开发，不暴露给外部
  //   3. 产生风险需要：其他开发服务恰好占用同端口 + isPortResponding 超时失败
  //   4. 未来可考虑在 dev 模式也注入身份验证中间件
  const healthy = await waitForWebHealthy(port, null, onProgress);
  return healthy ? port : null;
}

// ─── Packaged mode: utilityProcess.fork() ───────────────────────────

/**
 * Start Next.js in packaged mode using `utilityProcess.fork()`.
 *
 * The utility process runs as an Electron Helper (with LSUIElement=true
 * in its Info.plist), so it does NOT appear in the macOS Dock. This
 * replaces the old approach of spawning the Electron binary with
 * ELECTRON_RUN_AS_NODE=1, which created a second Dock icon.
 */
async function startWebServerPackaged(
  webDir: string,
  port: number,
  token: string,
  onProgress?: (line: string) => void,
): Promise<number | null> {
  // The worker module is bundled alongside main.cjs in dist/.
  const workerPath = path.join(__dirname, "web-worker.cjs");

  if (!existsSync(workerPath)) {
    logger.error(`[web] Worker module not found: ${workerPath}`);
    onProgress?.("错误: web-worker.cjs 不存在，请重新构建桌面端");
    return null;
  }

  logger.info(`[web] Worker module: ${workerPath}`);

  const workerEnv: Record<string, string> = {
    ...process.env,
    // SEC-15 安全注释：token 通过环境变量传递给 utility process。
    // 风险：环境变量在 /proc/<pid>/environ 中可被同用户的其他进程读取。
    // 缓解措施：
    //   1. 仅在父子进程间传递，token 使用 randomBytes 运行时生成
    //   2. 限制在 127.0.0.1 本地通信
    //   3. worker 进程退出后环境变量随之销毁
    //   4. 未来可改为通过 stdio 管道传递，避免环境变量暴露
    // Worker configuration
    AILEARN_WEB_DIR: webDir,
    AILEARN_WEB_PORT: String(port),
    AILEARN_WEB_TOKEN: token,
    AILEARN_NODE_ENV: "production",
    // Next.js env — INTERNAL_API_URL is read by next.config.mjs rewrites
    INTERNAL_API_URL: "http://127.0.0.1:4000",
    NODE_ENV: "production",
    PORT: String(port),
  };

  logger.info(`[web] Forking utility process on port ${port}…`);

  const child = utilityProcess.fork(workerPath, [], {
    env: workerEnv,
    serviceName: "ailearn-web",
    stdio: "pipe",
  });

  webProcess = child;

  // Capture worker stdout/stderr for logging.
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onProgress?.(text);
    logger.info(`[web:out] ${text.trimEnd()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    onProgress?.(text);
    logger.warn(`[web:err] ${text.trimEnd()}`);
  });

  child.on("message", (data: unknown) => {
    const msg = data as { type?: string; port?: number; message?: string };
    if (msg?.type === "ready") {
      logger.info(`[web] Worker reported ready on port ${msg.port ?? port}.`);
    } else if (msg?.type === "error") {
      logger.error(`[web] Worker error: ${msg.message ?? "unknown"}`);
    }
  });

  child.on("exit", (code: number) => {
    logger.info(`[web] Utility process exited with code ${code}`);
    webProcess = null;
  });

  // Packaged mode health check: verify identity via /__desktop_health.
  const healthy = await waitForWebHealthy(port, token, onProgress);
  return healthy ? port : null;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Start the Next.js web server.
 *
 * - Dev mode: spawns `next dev` with system Node.js
 * - Packaged mode: uses `utilityProcess.fork()` to run Next.js as a
 *   Helper process (no Dock icon, no ELECTRON_RUN_AS_NODE)
 *
 * Returns the port number on success, or `null` on failure.
 */
export async function startWebServer(
  onProgress?: (line: string) => void,
): Promise<number | null> {
  if (webProcess) {
    logger.info("[web] Server already running — skipping start.");
    return webPort;
  }

  const webDir = resolveWebDir();
  logger.info(`[web] Web directory: ${webDir}`);

  if (!existsSync(path.join(webDir, "package.json"))) {
    logger.error(`[web] package.json not found in ${webDir}`);
    return null;
  }

  // Find a free port (avoids conflicts with Docker on 3000).
  let port: number;
  try {
    port = await findFreePort(DEFAULT_WEB_PORT);
  } catch (err) {
    logger.error("[web] Failed to find a free port:", err);
    onProgress?.(`错误: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  logger.info(`[web] Using port ${port}`);
  webPort = port;

  const isDev = !app.isPackaged;

  if (isDev) {
    return startWebServerDev(webDir, port, onProgress);
  }

  // Packaged mode: generate identity token for service verification.
  const token = randomBytes(16).toString("hex");
  return startWebServerPackaged(webDir, port, token, onProgress);
}

/**
 * Poll the web service until it is healthy.
 *
 * - With `token` (packaged mode): verifies identity via `/__desktop_health`
 * - Without `token` (dev mode): just checks if the root URL returns 200
 */
async function waitForWebHealthy(
  port: number,
  token: string | null,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const healthUrl = token ? `${baseUrl}/__desktop_health` : baseUrl;

  for (let i = 0; i < MAX_WEB_HEALTH_RETRIES; i++) {
    if (!webProcess) {
      logger.error("[web] Process died during health check.");
      return false;
    }

    try {
      // 2026-08-11 修复：SEC-22/29 与 SEC-14 互斥——worker 端 /__desktop_health
      // 要求 Bearer token（否则 403），且响应不再返回 token（父进程此前校验
      // body.token !== token 永远失败）。修复：请求带头 + 身份只比对 service。
      const res = await fetch(healthUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        if (token) {
          // Verify identity to ensure we're talking to our own service.
          // SEC-14 之后响应只含 service/port，不再返回 token。
          const body = (await res.json()) as { service?: string };
          if (body.service !== "ailearn-desktop") {
            logger.warn("[web] Health endpoint responded but identity mismatch — not our service.");
            // Keep polling — our server might still be starting.
          } else {
            logger.info(`[web] Healthy after ${(i + 1) * 2}s (identity verified).`);
            onProgress?.(`前端服务已就绪 (${(i + 1) * 2}s)`);
            return true;
          }
        } else {
          logger.info(`[web] Healthy after ${(i + 1) * 2}s.`);
          onProgress?.(`前端服务已就绪 (${(i + 1) * 2}s)`);
          return true;
        }
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

/**
 * Stop the Next.js web server.
 *
 * QUAL-23: UtilityProcess and ChildProcess now have consistent kill
 * behavior — both send a graceful signal first, then force-kill after
 * a timeout. Both paths log the force-kill if it occurs.
 *
 * SEC-04: Returns a Promise that resolves after the process has been
 * signaled and given a brief grace period to exit. Callers (especially
 * before-quit) should await this to avoid orphan processes.
 */
export function stopWebServer(): Promise<void> {
  if (!webProcess) {
    logger.info("[web] No process to stop.");
    return Promise.resolve();
  }

  logger.info("[web] Stopping Next.js server…");

  const proc = webProcess;
  webProcess = null;
  webPort = null;

  return new Promise<void>((resolve) => {
    const KILL_TIMEOUT_MS = 5000;
    let settled = false;

    const onExit = () => {
      if (settled) return;
      settled = true;
      logger.info("[web] Server stopped.");
      resolve();
    };

    if (isUtility(proc)) {
      // UtilityProcess: send shutdown message for graceful exit.
      proc.postMessage({ type: "shutdown" });
      // Listen for exit
      proc.on("exit", onExit);
      // Force-kill after timeout (UtilityProcess.kill() has no signal arg)
      setTimeout(() => {
        if (!settled) {
          logger.warn("[web] Force killing utility process after timeout.");
          try {
            proc.kill();
          } catch {
            // Already exited.
          }
          onExit();
        }
      }, KILL_TIMEOUT_MS).unref();
    } else {
      // Child process (dev mode): SIGTERM → SIGKILL
      proc.once("exit", onExit);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!settled && !proc.killed) {
          logger.warn("[web] Force killing child process after timeout.");
          proc.kill("SIGKILL");
        }
      }, KILL_TIMEOUT_MS).unref();
    }

    // Safety net: resolve after timeout even if exit event doesn't fire
    setTimeout(onExit, KILL_TIMEOUT_MS + 500).unref();
  });
}

/** Get the port the web server is running on (or null if not started). */
export function getWebPort(): number | null {
  return webPort;
}
