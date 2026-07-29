/**
 * Docker lifecycle manager for the AI Learn desktop app.
 *
 * Responsibilities:
 * - Resolve the Docker CLI binary on macOS (including non-standard install paths)
 * - Fix the PATH for GUI-app context (which lacks /usr/local/bin etc.)
 * - Check whether Docker Desktop is running (and launch it if not)
 * - Start / stop the desktop compose stack
 * - Wait for the web service to become healthy
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { logger } from "./logger";

// Fixed desktop credentials — local-only, never exposed to the network.
// Bind addresses default to 127.0.0.1 so nothing is reachable remotely.
const DESKTOP_COMPOSE_FILE = "docker-compose.desktop.yml";
const PROJECT_NAME = "ailearn-desktop";
const WEB_PORT = 3000;
const API_PORT = 4000;
const MAX_HEALTH_RETRIES = 90; // 90 × 2s = 3 min timeout
const HEALTH_INTERVAL_MS = 2000;

// ─── PATH fix for macOS GUI apps ────────────────────────────────────
//
// When an Electron app is launched from Finder/Spotlight, the process
// PATH is the minimal macOS default (/usr/bin:/bin:/usr/sbin:/sbin).
// Docker CLI symlinks typically live in /usr/local/bin (Intel) or
// inside the Docker.app bundle.  We augment PATH before any spawn().

const EXTRA_PATH_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  `${process.env.HOME}/.docker/bin`,
];

// Try to discover the Docker.app bundle path so we can add its bin dir.
function discoverDockerAppBinDirs(): string[] {
  const dirs: string[] = [];

  // 1. Check standard /Applications/Docker.app
  const standard = "/Applications/Docker.app/Contents/Resources/bin";
  if (existsSync(standard)) dirs.push(standard);

  // 2. Scan /Volumes for a mounted Docker.app (user's case)
  try {
    const volumes = fs.readdirSync("/Volumes");
    for (const vol of volumes) {
      // Check /Volumes/<vol>/Docker.app and /Volumes/<vol>/app/Docker.app
      const candidates = [
        path.join("/Volumes", vol, "Docker.app", "Contents", "Resources", "bin"),
        path.join("/Volumes", vol, "app", "Docker.app", "Contents", "Resources", "bin"),
        path.join("/Volumes", vol, "Applications", "Docker.app", "Contents", "Resources", "bin"),
      ];
      for (const c of candidates) {
        if (existsSync(path.join(c, "docker")) && !dirs.includes(c)) {
          dirs.push(c);
        }
      }
    }
  } catch {
    // /Volumes not readable — ignore.
  }

  // 3. Check common Home cask locations
  const homeCask = path.join(process.env.HOME ?? "", "Applications", "Docker.app", "Contents", "Resources", "bin");
  if (existsSync(homeCask)) dirs.push(homeCask);

  return dirs;
}

/** Augment process.env.PATH with common macOS bin directories. */
function fixPath(): void {
  const extra = [...EXTRA_PATH_DIRS, ...discoverDockerAppBinDirs()];
  const currentPath = process.env.PATH ?? "";
  const parts = currentPath.split(":").filter(Boolean);
  for (const dir of extra) {
    if (!parts.includes(dir) && existsSync(dir)) {
      parts.push(dir);
    }
  }
  process.env.PATH = parts.join(":");
  logger.info(`[path] PATH = ${process.env.PATH}`);
}

/** Resolve the Docker binary path. Returns "docker" if no explicit path found. */
function resolveDockerBinary(): string {
  // Candidate locations in priority order.
  const candidates = [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    `${process.env.HOME}/.docker/bin/docker`,
    ...discoverDockerAppBinDirs().map((d) => path.join(d, "docker")),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];

  for (const candidate of candidates) {
    // Resolve symlinks — the real binary may be inside the Docker.app bundle.
    try {
      const real = fs.realpathSync(candidate);
      if (existsSync(real)) {
        logger.info(`[docker] Found Docker binary: ${candidate} → ${real}`);
        return candidate; // Return the symlink path (more stable across updates)
      }
    } catch {
      // Not found — try next.
    }
  }

  // Fallback: just "docker" and hope PATH (after fixPath) resolves it.
  logger.warn("[docker] Could not find docker binary at known paths — falling back to PATH lookup.");
  return "docker";
}

// ─── Initialize ─────────────────────────────────────────────────────

fixPath();
const DOCKER_BIN = resolveDockerBinary();

// ─── Project root resolution ────────────────────────────────────────

/** Resolve the project root that contains docker-compose.desktop.yml */
export function resolveProjectRoot(): string {
  // In packaged mode, the compose file lives in resources/docker/
  if (app.isPackaged) {
    const packaged = path.join(
      process.resourcesPath,
      "docker",
      DESKTOP_COMPOSE_FILE,
    );
    if (existsSync(packaged)) {
      return path.dirname(packaged);
    }
  }
  // In dev mode, walk up from the current working directory to find it.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, DESKTOP_COMPOSE_FILE);
    if (existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume repo root is two levels up from apps/desktop/
  return path.resolve(__dirname, "..", "..", "..");
}

// ─── Command execution ──────────────────────────────────────────────

/** Run a command and return {stdout, stderr, exitCode}. */
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

/** Convenience: run a Docker CLI command. */
function docker(args: string[], cwd?: string, env?: Record<string, string>): Promise<ExecResult> {
  return runCommand(DOCKER_BIN, args, cwd ?? process.cwd(), env);
}

// ─── Docker daemon checks ───────────────────────────────────────────

/** Check whether Docker daemon is responding. */
export async function isDockerRunning(): Promise<boolean> {
  const result = await docker(["info", "--format", "{{.ServerVersion}}"]);
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    return true;
  }
  return false;
}

/** Resolve the Docker Desktop.app bundle path (for `open -a`). */
function resolveDockerAppPath(): string {
  // If we found the binary inside a Docker.app bundle, derive the .app path.
  const binMatch = DOCKER_BIN.match(/^(.+?\.app)\/Contents\/Resources\/bin\/docker$/);
  if (binMatch) return binMatch[1];

  // Standard locations.
  if (existsSync("/Applications/Docker.app")) return "/Applications/Docker.app";

  // Scan /Volumes (user's case: /Volumes/asklins/app/Docker.app)
  try {
    const volumes = fs.readdirSync("/Volumes");
    for (const vol of volumes) {
      const candidates = [
        path.join("/Volumes", vol, "Docker.app"),
        path.join("/Volumes", vol, "app", "Docker.app"),
        path.join("/Volumes", vol, "Applications", "Docker.app"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  } catch {
    // ignore
  }

  // Home cask.
  const homeCask = path.join(process.env.HOME ?? "", "Applications", "Docker.app");
  if (existsSync(homeCask)) return homeCask;

  // Fall back to the app name (relies on LaunchServices registry).
  return "Docker";
}

/** Try to start Docker Desktop.app on macOS. */
export async function ensureDockerRunning(): Promise<boolean> {
  const running = await isDockerRunning();
  if (running) return true;

  logger.info("[docker] Docker Desktop not running — attempting to start…");

  // Use `open` to launch Docker.app. We try the full path first, then fall
  // back to the app name so LaunchServices resolves it.
  const dockerApp = resolveDockerAppPath();
  logger.info(`[docker] Docker.app path: ${dockerApp}`);

  // Try opening with the full path; if that fails, try by app name.
  let openResult = await runCommand("open", ["-a", dockerApp], process.cwd());

  if (openResult.exitCode !== 0) {
    logger.warn(`[docker] open -a "${dockerApp}" failed, trying "Docker"…`);
    openResult = await runCommand("open", ["-a", "Docker"], process.cwd());
  }

  if (openResult.exitCode !== 0) {
    logger.error("[docker] Failed to open Docker Desktop:", openResult.stderr);
    return false;
  }

  // Wait up to 90 seconds for Docker to become ready (first start can be slow).
  for (let i = 0; i < 45; i++) {
    await sleep(HEALTH_INTERVAL_MS);
    if (await isDockerRunning()) {
      logger.info(`[docker] Docker Desktop is ready (after ${(i + 1) * 2}s).`);
      return true;
    }
  }

  logger.error("[docker] Docker Desktop did not become ready within 90s.");
  return false;
}

// ─── Stack management ───────────────────────────────────────────────

/** Build all desktop images (run before first start or after Dockerfile changes). */
export async function buildDesktopStack(onProgress?: (line: string) => void): Promise<boolean> {
  const root = resolveProjectRoot();
  logger.info(`[docker] Building desktop stack in ${root}…`);

  const child = spawn(
    DOCKER_BIN,
    [
      "compose",
      "-f", DESKTOP_COMPOSE_FILE,
      "-p", PROJECT_NAME,
      "build",
      "--progress=plain",
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Stream build output for progress display.
  for await (const chunk of child.stdout ?? []) {
    const text = chunk.toString();
    onProgress?.(text);
    logger.debug(`[docker-build] ${text.trimEnd()}`);
  }
  for await (const chunk of child.stderr ?? []) {
    const text = chunk.toString();
    onProgress?.(text);
    logger.debug(`[docker-build] ${text.trimEnd()}`);
  }

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  if (exitCode !== 0) {
    logger.error(`[docker] Build failed (exit ${exitCode}).`);
    return false;
  }

  logger.info("[docker] Build succeeded.");
  return true;
}

/** Start the desktop compose stack in detached mode. */
export async function startDesktopStack(onProgress?: (line: string) => void): Promise<boolean> {
  const root = resolveProjectRoot();
  logger.info(`[docker] Starting desktop stack in ${root}…`);

  const child = spawn(
    DOCKER_BIN,
    [
      "compose",
      "-f", DESKTOP_COMPOSE_FILE,
      "-p", PROJECT_NAME,
      "up",
      "-d",
      "--build",
    ],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Collect output for progress and logging.
  for await (const chunk of child.stdout ?? []) {
    const text = chunk.toString();
    onProgress?.(text);
    logger.info(`[docker-up] ${text.trimEnd()}`);
  }
  for await (const chunk of child.stderr ?? []) {
    const text = chunk.toString();
    onProgress?.(text);
    logger.info(`[docker-up] ${text.trimEnd()}`);
  }

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });

  if (exitCode !== 0) {
    logger.error(`[docker] Stack start failed (exit ${exitCode}).`);
    return false;
  }

  logger.info("[docker] Stack started.");
  return true;
}

/** Stop the desktop compose stack (called on app quit). */
export async function stopDesktopStack(): Promise<void> {
  const root = resolveProjectRoot();
  logger.info("[docker] Stopping desktop stack…");

  const result = await docker(
    ["compose", "-f", DESKTOP_COMPOSE_FILE, "-p", PROJECT_NAME, "down"],
    root,
  );

  if (result.exitCode !== 0) {
    logger.warn(`[docker] Stop returned exit ${result.exitCode}:`, result.stderr);
  } else {
    logger.info("[docker] Stack stopped.");
  }
}

/** Poll the API service until /ready responds with 200. */
export async function waitForApiHealthy(onProgress?: (msg: string) => void): Promise<boolean> {
  const url = `http://127.0.0.1:${API_PORT}/ready`;

  for (let i = 0; i < MAX_HEALTH_RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        logger.info(`[health] API is healthy after ${(i + 1) * 2}s.`);
        onProgress?.(`API 服务已就绪 (${(i + 1) * 2}s)`);
        return true;
      }
    } catch {
      // Not ready yet.
    }

    const elapsed = (i + 1) * 2;
    onProgress?.(`等待后端服务就绪… (${elapsed}s)`);
    await sleep(HEALTH_INTERVAL_MS);
  }

  logger.error(`[health] API did not become healthy within ${MAX_HEALTH_RETRIES * 2}s.`);
  return false;
}

/** Check whether the desktop stack is already running. */
export async function isStackRunning(): Promise<boolean> {
  const root = resolveProjectRoot();
  const result = await docker(
    ["compose", "-f", DESKTOP_COMPOSE_FILE, "-p", PROJECT_NAME, "ps", "--format", "json"],
    root,
  );
  if (result.exitCode !== 0) return false;
  try {
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    return lines.length > 0;
  } catch {
    return false;
  }
}

/** Restart the desktop stack (stop + start). */
export async function restartDesktopStack(onProgress?: (line: string) => void): Promise<boolean> {
  await stopDesktopStack();
  return startDesktopStack(onProgress);
}

export { WEB_PORT, API_PORT, PROJECT_NAME, DESKTOP_COMPOSE_FILE };
