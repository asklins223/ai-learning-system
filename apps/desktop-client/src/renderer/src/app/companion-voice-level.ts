/**
 * Voice amplitude channel for the companion.
 *
 * The audio owner (HomeV2AudioController) produces a normalized amplitude while
 * a synthesized cue is playing; the Live2D face consumes it for mouth
 * parameters. It is deliberately a tiny imperative channel instead of React
 * state: amplitude changes every animation frame, and re-rendering the room at
 * that rate would be pure waste.
 */

export type HomeV2VoiceLevelListener = (level: number) => void;

const LEVEL_EPSILON = 0.02;

let currentLevel = 0;
const listeners = new Set<HomeV2VoiceLevelListener>();

export function getHomeV2VoiceLevel(): number {
  return currentLevel;
}

export function setHomeV2VoiceLevel(level: number): void {
  const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  // Ignore sub-perceptual changes so a quiet passage does not spam subscribers.
  if (Math.abs(next - currentLevel) < LEVEL_EPSILON && !(next === 0 && currentLevel !== 0)) return;
  currentLevel = next;
  for (const listener of listeners) listener(currentLevel);
}

export function subscribeHomeV2VoiceLevel(listener: HomeV2VoiceLevelListener): () => void {
  listeners.add(listener);
  listener(currentLevel);
  return () => { listeners.delete(listener); };
}

/** Test seam: drops subscribers and the current amplitude. */
export function resetHomeV2VoiceLevel(): void {
  currentLevel = 0;
  listeners.clear();
}
