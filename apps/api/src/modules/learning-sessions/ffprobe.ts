/**
 * P3 ffprobe 音频探测（§11.2：duration 200..60000ms 校验）。
 * 依赖 API image 的 Alpine ffmpeg/ffprobe（Owner 2026-08-11 批准）。
 */

import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type FfprobeResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: "probe_failed" | "no_duration" | "too_short" | "too_long" };

const MIN_DURATION_MS = 200;
const MAX_DURATION_MS = 60_000;

export async function probeAudioDurationMs(audio: Buffer): Promise<FfprobeResult> {
  // pipe 输入对 mp3 无法获取 duration（无头部时长，需 seek）；写临时文件探测，
  // finally 删除（P3 步骤 11：临时音频文件 1h 上限的本地探测文件同样即时清理）。
  const tmpPath = `/tmp/companion-ffprobe-${randomUUID()}.bin`;
  try {
    await writeFile(tmpPath, audio);
    return await new Promise<FfprobeResult>((resolve) => {
      const ffprobe = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_packets",
        // MediaRecorder WebM often has no container duration until finalized.
        // Keep format/stream duration when present, and expose packet timing
        // as a fallback for those browser-produced files.
        "-show_entries", "format=duration:stream=duration:packet=pts_time,duration_time",
        "-of", "json",
        tmpPath,
      ]);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: FfprobeResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      ffprobe.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      ffprobe.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const timeout = setTimeout(() => {
        ffprobe.kill("SIGKILL");
        finish({ ok: false, reason: "probe_failed" });
      }, 3_000);
      ffprobe.on("error", () => {
        clearTimeout(timeout);
        finish({ ok: false, reason: "probe_failed" });
      });
      ffprobe.on("close", (code) => {
        clearTimeout(timeout);
        if (settled) return;
        if (code !== 0 || stderr.trim() !== "") {
          finish({ ok: false, reason: "probe_failed" });
          return;
        }
        let parsed: {
          format?: { duration?: string };
          streams?: Array<{ duration?: string }>;
          packets?: Array<{ pts_time?: string; duration_time?: string }>;
        };
        try {
          parsed = JSON.parse(stdout) as typeof parsed;
        } catch {
          finish({ ok: false, reason: "probe_failed" });
          return;
        }
        const containerDurations = [
          Number(parsed.format?.duration),
          ...(parsed.streams ?? []).map((stream) => Number(stream.duration)),
        ].filter((value) => Number.isFinite(value) && value > 0);
        const packetDurations = (parsed.packets ?? [])
          .map((packet) => Number(packet.pts_time) + Number(packet.duration_time || 0))
          .filter((value) => Number.isFinite(value) && value > 0);
        // Prefer an explicit container/stream duration. Packet timing is only
        // a fallback for MediaRecorder files whose WebM duration is unset.
        const seconds = Math.max(...(containerDurations.length > 0 ? containerDurations : packetDurations), 0);
        if (seconds <= 0) {
          finish({ ok: false, reason: "no_duration" });
          return;
        }
        const durationMs = Math.round(seconds * 1000);
        if (durationMs < MIN_DURATION_MS) finish({ ok: false, reason: "too_short" });
        else if (durationMs > MAX_DURATION_MS) finish({ ok: false, reason: "too_long" });
        else finish({ ok: true, durationMs });
      });
    });
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/**
 * §11.6 crash cleanup：进程崩溃后残留的临时探测文件 hard cap 1 小时。
 * 调用方（api/server.ts 启动、worker 启动）定期执行，只删超过 maxAgeMs 的
 * `companion-ffprobe-*.bin`，随机文件名不含 user/conversation。
 */
export async function cleanupStaleTempAudio(
  maxAgeMs = 60 * 60 * 1000,
  dir = "/tmp",
): Promise<number> {
  const { readdir, stat } = await import("node:fs/promises");
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // 目录不存在——无残留可清
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith("companion-ffprobe-") || !name.endsWith(".bin")) continue;
    try {
      const st = await stat(`${dir}/${name}`);
      if (now - st.mtimeMs > maxAgeMs) {
        await rm(`${dir}/${name}`, { force: true });
        removed += 1;
      }
    } catch {
      // 单个文件 stat/删除失败不影响其余
    }
  }
  return removed;
}
