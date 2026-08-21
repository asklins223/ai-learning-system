import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { probeAudioDurationMs } from "./ffprobe.ts";

const hasAudioToolchain = ["ffmpeg", "ffprobe"].every((command) =>
  spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);

/** 用宿主 ffmpeg 生成真实音频（mp3 有帧填充最小时长 ~216ms；wav 时长精确）。 */
function makeAudio(format: "mp3" | "wav", durationSeconds: number): Buffer {
  const args = [
    "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
    "-t", String(durationSeconds),
  ];
  if (format === "mp3") args.push("-c:a", "libmp3lame", "-q:a", "9", "-f", "mp3", "pipe:1");
  else args.push("-c:a", "pcm_s16le", "-f", "wav", "pipe:1");
  return execFileSync("ffmpeg", args);
}

test("ffprobe：合法时长（0.5s → ~500ms，200..60000 内）", {
  skip: hasAudioToolchain ? false : "requires the ffmpeg/ffprobe toolchain provided by the API container",
}, async () => {
  const result = await probeAudioDurationMs(makeAudio("mp3", 0.5));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.durationMs >= 400 && result.durationMs <= 700, `durationMs=${result.durationMs}`);
  }
});

test("ffprobe：过短（0.1s wav → 100ms < 200ms → too_short）", {
  skip: hasAudioToolchain ? false : "requires the ffmpeg/ffprobe toolchain provided by the API container",
}, async () => {
  const result = await probeAudioDurationMs(makeAudio("wav", 0.1));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "too_short");
});

test("ffprobe：不可探测（垃圾字节 → probe_failed）", async () => {
  const result = await probeAudioDurationMs(Buffer.from("not-an-audio-file-at-all-".repeat(20)));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "probe_failed");
});

test("crash cleanup：>1h 残留删除、新鲜文件保留、非本模块文件不动", async () => {
  const { mkdtemp, writeFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cleanupStaleTempAudio } = await import("./ffprobe.ts");
  const dir = await mkdtemp(join(tmpdir(), "ffprobe-cleanup-"));
  const oldFile = join(dir, "companion-ffprobe-old.bin");
  const freshFile = join(dir, "companion-ffprobe-fresh.bin");
  const other = join(dir, "not-ours.txt");
  await writeFile(oldFile, "x");
  await writeFile(freshFile, "y");
  await writeFile(other, "z");
  // 把 oldFile 的 mtime 拨到 2h 前
  const { utimes } = await import("node:fs/promises");
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(oldFile, past, past);

  const removed = await cleanupStaleTempAudio(60 * 60 * 1000, dir);
  assert.equal(removed, 1, "只删 1 个过期文件");
  const remaining = await readdir(dir);
  assert.deepEqual(remaining.sort(), ["companion-ffprobe-fresh.bin", "not-ours.txt"]);
});
