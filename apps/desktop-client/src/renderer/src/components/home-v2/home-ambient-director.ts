import type {
  HomeAmbientCueProfile,
  HomeSceneRegionId,
  HomeSceneTimeV1,
} from "./home-scene-profile";

export type HomeAmbientContextV1 = Readonly<{
  motionMode: "full" | "lite" | "off";
  time: HomeSceneTimeV1;
  paused: boolean;
  priorityRegion: HomeSceneRegionId | null;
}>;

export interface HomeAmbientRegionRuntime {
  play(cueId: string): boolean;
  settle(): void;
  setTime(time: HomeSceneTimeV1): void;
  destroy(): void;
}

export interface HomeAmbientRuntime {
  setContext(context: HomeAmbientContextV1): void;
  trigger(region: HomeSceneRegionId, cueId: string): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

export interface HomeAmbientTickRuntime extends HomeAmbientRuntime {
  tick(deltaMs: number): void;
}

type DirectorOptions = Readonly<{
  regions: Readonly<Record<HomeSceneRegionId, HomeAmbientRegionRuntime>>;
  cues: Readonly<Record<HomeSceneRegionId, readonly HomeAmbientCueProfile[]>>;
  random?: () => number;
}>;

const REGIONS: readonly HomeSceneRegionId[] = ["window", "desk", "shelf", "rest"];
export const HOME_V2_COMPANION_DRAG_EVENT = "ailearn:home-v2-companion-drag";
export const HOME_AMBIENT_INTERACTION_CUE: Readonly<Record<HomeSceneRegionId, string>> = {
  window: "telescope-calibrate",
  desk: "page-lift",
  shelf: "catalog-breathe",
  rest: "cup-steam",
};
const MIN_DELAY_MS = 6_000;
const DELAY_RANGE_MS = 8_000;
const STARVATION_MS = 42_000;
const MAX_ACTIVE_REGIONS = 2;

export function requestHomeAmbientRegionFeedback(region: HomeSceneRegionId): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ailearn:home-v2-ambient-cue", {
    detail: { region, cueId: HOME_AMBIENT_INTERACTION_CUE[region] },
  }));
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.999_999, Math.max(0, value));
}

export function createHomeAmbientDirector(options: DirectorOptions): HomeAmbientTickRuntime {
  const random = options.random ?? Math.random;
  let context: HomeAmbientContextV1 = {
    motionMode: "off",
    time: "day",
    paused: true,
    priorityRegion: null,
  };
  let destroyed = false;
  let explicitlyPaused = false;
  let elapsedMs = 0;
  let nextCueAtMs = MIN_DELAY_MS + clampRandom(random()) * DELAY_RANGE_MS;
  let lastRegion: HomeSceneRegionId | null = null;
  let activeRegionOrder: HomeSceneRegionId[] = [];
  const lastPlayedAt = new Map<HomeSceneRegionId, number>(REGIONS.map((region) => [region, 0]));

  const scheduleNext = () => {
    nextCueAtMs = elapsedMs + MIN_DELAY_MS + clampRandom(random()) * DELAY_RANGE_MS;
  };

  const ambientEnabled = () => !destroyed
    && !explicitlyPaused
    && !context.paused
    && context.motionMode === "full";

  const playableCue = (region: HomeSceneRegionId, requested?: string) => {
    const candidates = (options.cues[region] ?? []).filter((cue) => !cue.baseline);
    return requested
      ? candidates.find((cue) => cue.id === requested) ?? null
      : candidates[0] ?? null;
  };

  const chooseRegion = (): HomeSceneRegionId | null => {
    const candidates = REGIONS.filter((region) => region !== lastRegion && playableCue(region));
    if (!candidates.length) return null;
    const starved = candidates
      .filter((region) => elapsedMs - (lastPlayedAt.get(region) ?? 0) >= STARVATION_MS)
      .sort((left, right) => (lastPlayedAt.get(left) ?? 0) - (lastPlayedAt.get(right) ?? 0));
    if (starved.length) return starved[0];
    const weighted = candidates.flatMap((region) => (
      Array.from({ length: context.priorityRegion === region ? 3 : 1 }, () => region)
    ));
    return weighted[Math.floor(clampRandom(random()) * weighted.length)] ?? candidates[0];
  };

  const play = (region: HomeSceneRegionId, cue: HomeAmbientCueProfile | null): boolean => {
    if (!cue || context.motionMode === "off" || context.paused || explicitlyPaused) return false;
    activeRegionOrder = activeRegionOrder.filter((activeRegion) => activeRegion !== region);
    while (activeRegionOrder.length >= MAX_ACTIVE_REGIONS) {
      const oldest = activeRegionOrder.shift();
      if (oldest) options.regions[oldest].settle();
    }
    options.regions[region].settle();
    const accepted = options.regions[region].play(cue.id);
    if (accepted) {
      lastRegion = region;
      lastPlayedAt.set(region, elapsedMs);
      activeRegionOrder.push(region);
    }
    return accepted;
  };

  return {
    tick(deltaMs) {
      if (!ambientEnabled() || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
      elapsedMs += Math.min(deltaMs, 100);
      if (elapsedMs < nextCueAtMs) return;
      const region = chooseRegion();
      if (region) play(region, playableCue(region));
      scheduleNext();
    },
    setContext(next) {
      if (destroyed) return;
      const timeChanged = context.time !== next.time;
      const disabled = next.motionMode === "off" || next.paused;
      context = next;
      if (timeChanged) REGIONS.forEach((region) => options.regions[region].setTime(next.time));
      if (disabled) {
        REGIONS.forEach((region) => options.regions[region].settle());
        activeRegionOrder = [];
      }
      scheduleNext();
    },
    trigger(region, cueId) {
      if (destroyed) return;
      play(region, playableCue(region, cueId));
      scheduleNext();
    },
    pause() {
      if (destroyed) return;
      explicitlyPaused = true;
      REGIONS.forEach((region) => options.regions[region].settle());
      activeRegionOrder = [];
    },
    resume() {
      if (destroyed) return;
      explicitlyPaused = false;
      scheduleNext();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      REGIONS.forEach((region) => options.regions[region].destroy());
      activeRegionOrder = [];
    },
  };
}
