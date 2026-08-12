import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const defaultExecutable = process.platform === "darwin"
  ? path.join(repoRoot, "apps/desktop/release/mac-arm64/AI Learn.app/Contents/MacOS/AI Learn")
  : process.platform === "win32"
    ? path.join(repoRoot, "apps/desktop/release/win-unpacked/AI Learn.exe")
    : path.join(repoRoot, "apps/desktop/release/linux-unpacked/AI Learn");

const executable = process.env.AILEARN_PACKAGED_APP?.trim() || defaultExecutable;
const durationSeconds = Number(process.env.AILEARN_SOAK_DURATION_SECONDS || "86400");
const intervalMs = Number(process.env.AILEARN_SOAK_INTERVAL_MS || String(30 * 60 * 1000));
const logPath = path.resolve(
  process.env.AILEARN_SOAK_LOG_PATH?.trim() || path.join(repoRoot, "outputs/desktop-soak-24h/soak.jsonl"),
);

if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1) {
  throw new Error("AILEARN_SOAK_DURATION_SECONDS must be a positive integer");
}
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
  throw new Error("AILEARN_SOAK_INTERVAL_MS must be an integer >= 1000");
}

mkdirSync(path.dirname(logPath), { recursive: true });
const child = spawn(executable, process.platform === "win32" ? [] : ["--no-sandbox"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    AILEARN_SOAK_LOG_PATH: logPath,
    AILEARN_SOAK_INTERVAL_MS: String(intervalMs),
  },
  stdio: "inherit",
});

let stopping = false;
const finish = (code) => {
  if (stopping) return;
  stopping = true;
  clearTimeout(stopTimer);
  if (!child.killed) child.kill("SIGTERM");
  process.exitCode = code;
};

const stopTimer = setTimeout(() => {
  console.log(`[desktop-soak] duration reached: ${durationSeconds}s; stopping app`);
  finish(0);
}, durationSeconds * 1_000);
stopTimer.unref?.();

child.once("error", (error) => {
  console.error(`[desktop-soak] failed to start ${executable}: ${error.message}`);
  finish(1);
});
child.once("exit", (code, signal) => {
  if (stopping) return;
  console.error(`[desktop-soak] app exited early: code=${code ?? "null"} signal=${signal ?? "none"}`);
  finish(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => finish(130));
}

console.log(`[desktop-soak] started for ${durationSeconds}s`);
console.log(`[desktop-soak] executable=${executable}`);
console.log(`[desktop-soak] log=${logPath}`);
