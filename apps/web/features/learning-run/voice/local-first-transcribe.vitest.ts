import { describe, it, expect, vi } from "vitest";
import {
  transcribeVoiceLocalFirstWith,
  BUILTIN_ASR_TEST_AUDIO,
  type LocalFirstTranscribeDeps,
} from "./local-first-transcribe";

function baseDeps(overrides: Partial<LocalFirstTranscribeDeps> = {}): LocalFirstTranscribeDeps {
  return {
    getCapability: vi.fn(async () => ({ available: true, arch: "arm64" } as const)),
    probe: vi.fn(async () => ({ ok: true as const, probe: { coldStartMs: 800, warmRtf: 0.2 } })),
    recognize: vi.fn(async () => ({ ok: true as const, text: "本地识别的回答内容。" })),
    decode: vi.fn(async () => new Float32Array(16000)),
    cloudTranscribe: vi.fn(async () => ({ text: "云端识别的回答内容。" })),
    ...overrides,
  };
}

describe("transcribeVoiceLocalFirstWith", () => {
  it("本地可用且识别成功 → 本地结果，不碰云端", async () => {
    const deps = baseDeps();
    const result = await transcribeVoiceLocalFirstWith(new Blob(["x"]), deps);
    expect(result).toEqual({ text: "本地识别的回答内容。", route: "local_sensevoice" });
    expect(deps.recognize).toHaveBeenCalledOnce();
    expect(deps.cloudTranscribe).not.toHaveBeenCalled();
  });

  it("本地识别空文本 → 云端兜底", async () => {
    const deps = baseDeps({
      recognize: vi.fn(async () => ({ ok: true as const, text: "  " })),
    });
    const result = await transcribeVoiceLocalFirstWith(new Blob(["x"]), deps);
    expect(result).toEqual({ text: "云端识别的回答内容。", route: "cloud_siliconflow" });
    expect(deps.cloudTranscribe).toHaveBeenCalledOnce();
  });

  it("本地识别失败 → 云端兜底", async () => {
    const deps = baseDeps({
      recognize: vi.fn(async () => ({ ok: false as const, error: "model crashed", recoverable: true })),
    });
    const result = await transcribeVoiceLocalFirstWith(new Blob(["x"]), deps);
    expect(result.route).toBe("cloud_siliconflow");
  });

  it("探测失败 → 直接云端，不尝试本地识别", async () => {
    const deps = baseDeps({
      probe: vi.fn(async () => ({ ok: false as const, error: "model_unavailable" })),
    });
    const result = await transcribeVoiceLocalFirstWith(new Blob(["x"]), deps);
    expect(result.route).toBe("cloud_siliconflow");
    expect(deps.recognize).not.toHaveBeenCalled();
  });

  it("静态 Gate 不过（arch=other）→ 云端", async () => {
    const deps = baseDeps({
      getCapability: vi.fn(async () => ({ available: true, arch: "other" })),
    });
    const result = await transcribeVoiceLocalFirstWith(new Blob(["x"]), deps);
    expect(result.route).toBe("cloud_siliconflow");
    expect(deps.recognize).not.toHaveBeenCalled();
  });

  it("无本地能力（浏览器）→ 直接云端", async () => {
    const deps = baseDeps({
      getCapability: vi.fn(async () => ({ available: false, reason: "no-electron" })),
    });
    const result = await transcribeVoiceLocalFirstWith(new Blob(["x"]), deps);
    expect(result.route).toBe("cloud_siliconflow");
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it("云端也失败 → 错误向上抛", async () => {
    const deps = baseDeps({
      recognize: vi.fn(async () => ({ ok: false as const, error: "crashed", recoverable: false })),
      cloudTranscribe: vi.fn(async () => {
        throw new Error("语音转写服务暂不可用，请稍后重试");
      }),
    });
    await expect(transcribeVoiceLocalFirstWith(new Blob(["x"]), deps)).rejects.toThrow(
      "语音转写服务暂不可用",
    );
  });

  it("内置探测音频为 3 秒 16kHz 低振幅正弦", () => {
    expect(BUILTIN_ASR_TEST_AUDIO.length).toBe(16000 * 3);
    const peak = Math.max(...BUILTIN_ASR_TEST_AUDIO);
    expect(peak).toBeLessThan(0.1);
  });
});
