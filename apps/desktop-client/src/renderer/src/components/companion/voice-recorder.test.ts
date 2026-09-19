import { describe, expect, it } from "vitest";
import { companionVoiceLevel } from "./voice-recorder";
import { COMPANION_VAD_TUNING } from "./companion-voice-vad";

function constant(value: number, length: number): Float32Array {
  return Float32Array.from({ length }, () => value);
}

describe("companionVoiceLevel", () => {
  it("reads silence as zero and a full-scale square as one", () => {
    expect(companionVoiceLevel(constant(0, 512))).toBe(0);
    expect(companionVoiceLevel(Float32Array.from({ length: 512 }, (_, index) => (index % 2 === 0 ? 1 : -1)))).toBe(1);
    expect(companionVoiceLevel(new Float32Array(0))).toBe(0);
  });

  it("puts an ordinary speaking level above the VAD threshold and room tone below it", () => {
    expect(companionVoiceLevel(constant(0.12, 512))).toBeGreaterThan(COMPANION_VAD_TUNING.threshold);
    expect(companionVoiceLevel(constant(0.004, 512))).toBeLessThan(COMPANION_VAD_TUNING.threshold);
  });
});
