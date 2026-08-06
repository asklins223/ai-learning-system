/**
 * Utility process worker — runs the Next.js server in-process as an
 * Electron Helper service.
 *
 * This avoids spawning the Electron binary as a separate Node.js process
 * (which would appear in the macOS Dock as a second app instance).
 *
 * The worker receives configuration via environment variables and
 * communicates with the parent process via `process.parentPort`.
 *
 * Standalone compatibility:
 *   Next.js standalone output doesn't include `next/dist/compiled/webpack/webpack`
 *   (only needed for config loading at build time). The standalone `server.js`
 *   works around this by setting `__NEXT_PRIVATE_STANDALONE_CONFIG` with a
 *   pre-serialized config, which makes `config.js` skip the webpack-dependent
 *   code path. We replicate the same approach here.
 *
 * Lifecycle:
 *  1. Parent sets env vars and calls `utilityProcess.fork(__dirname + "/web-worker.cjs")`
 *  2. Worker reads the pre-built config from standalone `server.js`
 *  3. Worker sets `__NEXT_PRIVATE_STANDALONE_CONFIG` to bypass webpack loading
 *  4. Worker loads Next.js via `createRequire` and starts an HTTP server
 *  5. Worker sends `{ type: "ready" }` to parent
 *  6. Parent polls `/__desktop_health` to verify identity
 *  7. On shutdown, parent sends `{ type: "shutdown" }` and worker exits
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────

interface WorkerConfig {
  webDir: string;
  port: number;
  token: string;
  nodeEnv: string;
}

interface ParentMessage {
  type: string;
  [key: string]: unknown;
}

// Utility process provides `process.parentPort` (Electron augmentation).
// We access it via a minimal interface to avoid importing the full
// Electron type definitions in this worker module.
interface ParentPortLike {
  on(event: "message", listener: (event: { data: ParentMessage }) => void): unknown;
  postMessage(message: unknown): void;
}

function getParentPort(): ParentPortLike | null {
  const p = (process as typeof process & { parentPort?: ParentPortLike }).parentPort;
  return p ?? null;
}

// ─── Config ─────────────────────────────────────────────────────────

function getConfig(): WorkerConfig {
  const webDir = process.env.AILEARN_WEB_DIR;
  const portStr = process.env.AILEARN_WEB_PORT;
  const token = process.env.AILEARN_WEB_TOKEN;

  if (!webDir || !portStr || !token) {
    throw new Error(
      "Missing required env vars (AILEARN_WEB_DIR, AILEARN_WEB_PORT, AILEARN_WEB_TOKEN)",
    );
  }

  return {
    webDir,
    port: parseInt(portStr, 10),
    token,
    nodeEnv: process.env.AILEARN_NODE_ENV || "production",
  };
}

/**
 * Extract the pre-serialized Next.js config from the standalone `server.js`.
 *
 * The standalone `server.js` contains a line like:
 *   const nextConfig = {...}
 *   process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)
 *
 * We read the file, extract the JSON config object, and set the env var
 * ourselves. This bypasses the webpack-dependent config loading path.
 */
function loadStandaloneConfig(webDir: string): void {
  const serverJsPath = path.join(webDir, "server.js");

  let serverJsContent: string;
  try {
    serverJsContent = readFileSync(serverJsPath, "utf8");
  } catch {
    throw new Error(`Standalone server.js not found at ${serverJsPath}`);
  }

  // Extract the JSON config object from the `const nextConfig = {...}` line.
  // The config is a large JSON object on a single line.
  const configMatch = serverJsContent.match(
    /const nextConfig = (\{[\s\S]*?\})\n\nprocess\.env\.__NEXT_PRIVATE_STANDALONE_CONFIG/,
  );

  if (!configMatch) {
    throw new Error("Failed to extract nextConfig from standalone server.js");
  }

  // Validate that the extracted string is valid JSON.
  const configJson = configMatch[1];
  JSON.parse(configJson); // Throws if invalid

  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = configJson;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = getConfig();
  const parentPort = getParentPort();

  const log = (msg: string): void => {
    console.log(`[web-worker] ${msg}`);
  };

  log(`Starting Next.js in ${config.nodeEnv} mode on port ${config.port}`);
  log(`Web directory: ${config.webDir}`);

  // Load the pre-built config from standalone server.js to bypass
  // webpack-dependent config loading (not included in standalone trace).
  loadStandaloneConfig(config.webDir);
  log("Standalone config loaded.");

  // Create a require function that resolves modules from the web directory.
  const webRequire = createRequire(path.join(config.webDir, "package.json"));

  // Load the Next.js factory function.
  const nextModule = webRequire("next") as unknown;
  const next = typeof nextModule === "function"
    ? nextModule
    : (nextModule as { default?: unknown }).default;

  if (typeof next !== "function") {
    throw new Error("Failed to load Next.js: 'next' export is not a function");
  }

  log("Next.js module loaded, preparing app…");

  const app = next({
    dev: config.nodeEnv === "development",
    dir: config.webDir,
    hostname: "127.0.0.1",
    port: config.port,
  });

  const handle = app.getRequestHandler();

  await app.prepare();

  log("Next.js prepared, starting HTTP server…");

  // Create HTTP server with:
  // 1. A `/__desktop_health` endpoint for identity verification
  // 2. All other requests handled by Next.js
  // SEC-22/29 修复：健康检查端点要求 Bearer token 认证，防止未授权方获取身份令牌
  const server = createServer((req, res) => {
    if (req.url === "/__desktop_health" || req.url === "/__desktop_health/") {
      // 验证请求方持有正确的 Bearer token
      const authHeader = req.headers["authorization"];
      const providedToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;
      if (providedToken !== config.token) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      // SEC-14 修复：健康检查端点不再返回 token，只返回 service 和 port。
      // 父进程通过 Authorization header 验证身份，不需要从响应中获取 token。
      // 这防止了同机器上的恶意进程通过扫描端口获取身份令牌。
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "ailearn-desktop",
          port: config.port,
        }),
      );
      return;
    }

    handle(req, res);
  });

  server.listen(config.port, "127.0.0.1", () => {
    log(`Server listening on http://127.0.0.1:${config.port}`);
    parentPort?.postMessage({ type: "ready", port: config.port });
  });

  server.on("error", (err: Error) => {
    log(`Server error: ${err.message}`);
    parentPort?.postMessage({ type: "error", message: err.message });
    process.exit(1);
  });

  // Handle shutdown from parent.
  // BUG-53 修复：添加强制退出超时，防止 server.close() 或 app.close() 挂起
  // 导致 worker 进程无法退出。5 秒后强制 exit(1)。
  parentPort?.on("message", (event: { data: ParentMessage }) => {
    if (event.data?.type === "shutdown") {
      log("Shutting down…");
      // 强制退出超时：5 秒后如果优雅关闭未完成，直接强制退出
      const forceExitTimer = setTimeout(() => {
        log("Shutdown timeout reached, forcing exit.");
        process.exit(1);
      }, 5_000);
      // 防止超时定时器阻止进程退出
      forceExitTimer.unref();

      server.close(() => {
        app
          .close()
          .then(() => {
            log("Server closed gracefully.");
            clearTimeout(forceExitTimer);
            process.exit(0);
          })
          .catch((err: unknown) => {
            log(`Error during close: ${err instanceof Error ? err.message : String(err)}`);
            clearTimeout(forceExitTimer);
            process.exit(1);
          });
      });
    }
  });

  // Handle unexpected errors.
  process.on("uncaughtException", (err: Error) => {
    log(`Uncaught exception: ${err.message}`);
    parentPort?.postMessage({ type: "error", message: err.message });
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[web-worker] Failed to start: ${msg}`);
  getParentPort()?.postMessage({ type: "error", message: msg });
  process.exit(1);
});
