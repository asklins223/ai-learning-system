export const COMPANION_MOUTH_NOISE_GATE = 0.012;
export const COMPANION_MOUTH_NORMALIZATION_CEILING = 0.18;
export const COMPANION_MOUTH_ATTACK_MS = 45;
export const COMPANION_MOUTH_RELEASE_MS = 120;

export function companionAudioRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function companionMouthTarget(samples: Float32Array): number {
  const rms = companionAudioRms(samples);
  if (rms <= COMPANION_MOUTH_NOISE_GATE) return 0;
  const normalized = Math.min(1, (rms - COMPANION_MOUTH_NOISE_GATE)
    / (COMPANION_MOUTH_NORMALIZATION_CEILING - COMPANION_MOUTH_NOISE_GATE));
  return Math.sqrt(normalized);
}

/** Time-based envelope, stable across 60/120Hz displays. */
export function smoothCompanionMouthLevel(previous: number, target: number, deltaMs: number): number {
  const safePrevious = Math.min(1, Math.max(0, previous));
  const safeTarget = Math.min(1, Math.max(0, target));
  const tau = safeTarget > safePrevious ? COMPANION_MOUTH_ATTACK_MS : COMPANION_MOUTH_RELEASE_MS;
  const alpha = 1 - Math.exp(-Math.max(0, deltaMs) / tau);
  return safePrevious + (safeTarget - safePrevious) * alpha;
}
