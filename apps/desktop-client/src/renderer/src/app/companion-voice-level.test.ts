import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetHomeV2VoiceLevel,
  setHomeV2VoiceLevel,
  subscribeHomeV2VoiceLevel,
} from "./companion-voice-level";

afterEach(resetHomeV2VoiceLevel);

describe("Home V2 companion voice amplitude", () => {
  it("clamps samples and publishes a final zero without per-frame React state", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHomeV2VoiceLevel(listener);

    setHomeV2VoiceLevel(4);
    setHomeV2VoiceLevel(0.99); // below the perceptual delta from the clamped 1
    setHomeV2VoiceLevel(Number.NaN);

    expect(listener.mock.calls.map(([level]) => level)).toEqual([0, 1, 0]);
    unsubscribe();
    setHomeV2VoiceLevel(0.5);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
