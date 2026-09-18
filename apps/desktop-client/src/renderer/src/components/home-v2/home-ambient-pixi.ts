import { Container, Graphics, TilingSprite, type Application } from "pixi.js";
import type { ScenePixiNodeRegistry } from "../../scene/scene-node-pixi";
import {
  createHomeAmbientDirector,
  type HomeAmbientContextV1,
  type HomeAmbientRegionRuntime,
  type HomeAmbientRuntime,
} from "./home-ambient-director";
import type {
  HomeAmbientCueProfile,
  HomeSceneProfileV1,
  HomeSceneRegionId,
  HomeSceneTimeV1,
} from "./home-scene-profile";

type RegionRuntime = HomeAmbientRegionRuntime & Readonly<{
  tick(deltaMs: number, context: HomeAmbientContextV1): void;
  active(): boolean;
}>;

type ActiveCue = { cue: HomeAmbientCueProfile; elapsedMs: number };

function degrees(value: number): number {
  return value * Math.PI / 180;
}

/** Smooth rest → peak → rest curve with zero velocity at both ends. */
export function homeAmbientPulse(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 0.5 - 0.5 * Math.cos(Math.PI * 2 * clamped);
}

function steamColor(time: HomeSceneTimeV1): number {
  if (time === "night") return 0xc6d5df;
  if (time === "dusk") return 0xf2ddd0;
  return 0xf7f0df;
}

function createSteam(origin: readonly [number, number]): Container {
  const root = new Container({ label: "home-ambient:rest:steam", eventMode: "none", interactiveChildren: false });
  root.position.set(origin[0], origin[1]);
  const left = new Graphics()
    .moveTo(-5, 4)
    .bezierCurveTo(-12, -5, 2, -12, -5, -22)
    .bezierCurveTo(-10, -29, -2, -34, -4, -40)
    .stroke({ color: steamColor("day"), alpha: 0.62, width: 2.2, cap: "round" });
  const right = new Graphics()
    .moveTo(5, 5)
    .bezierCurveTo(13, -4, 0, -13, 8, -22)
    .bezierCurveTo(14, -29, 5, -35, 8, -42)
    .stroke({ color: steamColor("day"), alpha: 0.5, width: 1.8, cap: "round" });
  left.label = "home-ambient:steam:left";
  right.label = "home-ambient:steam:right";
  root.addChild(left, right);
  root.alpha = 0;
  return root;
}

function setSteamTint(root: Container, time: HomeSceneTimeV1): void {
  const tint = steamColor(time);
  for (const child of root.children) child.tint = tint;
}

function createRegionRuntime(input: Readonly<{
  id: HomeSceneRegionId;
  cues: readonly HomeAmbientCueProfile[];
  nodeRegistry: ScenePixiNodeRegistry;
  steamRoot: Container | null;
}>): RegionRuntime {
  let activeCue: ActiveCue | null = null;
  let destroyed = false;
  let time: HomeSceneTimeV1 = "day";
  const restState = new WeakMap<Container, Readonly<{
    x: number;
    y: number;
    rotation: number;
    alpha: number;
    scaleX: number;
    scaleY: number;
  }>>();

  const cueById = new Map(input.cues.map((cue) => [cue.id, cue]));
  const nodeForCue = (cue: HomeAmbientCueProfile) => cue.assetId
    ? input.nodeRegistry.get(cue.assetId)
      ?? input.nodeRegistry.get(`${cue.assetId}-${time.toUpperCase()}`)
    : cue.kind === "steam" ? input.steamRoot : null;

  const restFor = (node: Container) => {
    const existing = restState.get(node);
    if (existing) return existing;
    const created = {
      x: node.x,
      y: node.y,
      rotation: node.rotation,
      alpha: node.alpha,
      scaleX: node.scale.x,
      scaleY: node.scale.y,
    } as const;
    restState.set(node, created);
    return created;
  };

  const resetCue = (cue: HomeAmbientCueProfile): void => {
    const node = nodeForCue(cue);
    if (!node || node.destroyed) return;
    if (cue.kind === "drift-x") return;
    const rest = restFor(node);
    node.rotation = rest.rotation;
    node.position.set(rest.x, rest.y);
    node.alpha = cue.kind === "steam" ? 0 : rest.alpha;
    node.scale.set(rest.scaleX, rest.scaleY);
  };

  return {
    play(cueId) {
      if (destroyed) return false;
      const cue = cueById.get(cueId);
      if (!cue || cue.baseline || !nodeForCue(cue)) return false;
      if (activeCue) resetCue(activeCue.cue);
      activeCue = { cue, elapsedMs: 0 };
      return true;
    },
    settle() {
      if (activeCue) resetCue(activeCue.cue);
      activeCue = null;
    },
    setTime(nextTime) {
      time = nextTime;
      if (input.steamRoot) setSteamTint(input.steamRoot, time);
      const drift = input.cues.find((cue) => cue.kind === "drift-x" && cue.assetId);
      const water = drift ? nodeForCue(drift) : null;
      if (water) water.alpha = time === "night" ? 0.025 : time === "dusk" ? 0.045 : 0.065;
      const telescopeCue = input.cues.find((cue) => cue.assetId === "HOME-LIGHTHOUSE-TELESCOPE");
      const telescope = telescopeCue ? nodeForCue(telescopeCue) : null;
      if (telescope) {
        telescope.tint = time === "night" ? 0xaeb9cc : time === "dusk" ? 0xf1c9ae : 0xffffff;
        telescope.alpha = time === "night" ? 0.72 : time === "dusk" ? 0.88 : 1;
      }
    },
    tick(deltaMs, context) {
      if (destroyed || context.paused || context.motionMode === "off") return;
      if (context.motionMode === "full") {
        const baseline = input.cues.find((cue) => cue.kind === "drift-x" && cue.baseline);
        const node = baseline ? nodeForCue(baseline) : null;
        if (node instanceof TilingSprite) {
          node.tilePosition.x = (node.tilePosition.x - deltaMs * 0.007) % Math.max(1, node.texture.width);
        }
      }
      if (!activeCue) return;
      activeCue.elapsedMs += deltaMs;
      const progress = Math.min(1, activeCue.elapsedMs / activeCue.cue.durationMs);
      const pulse = homeAmbientPulse(progress);
      const node = nodeForCue(activeCue.cue);
      if (!node || node.destroyed) {
        activeCue = null;
        return;
      }
      const rest = restFor(node);
      if (activeCue.cue.kind === "rotate") {
        node.rotation = rest.rotation + degrees(activeCue.cue.amplitude) * pulse;
      } else if (activeCue.cue.kind === "page-lift") {
        node.y = rest.y - activeCue.cue.amplitude * pulse;
        node.rotation = rest.rotation + degrees(1.2) * pulse;
      } else if (activeCue.cue.kind === "steam") {
        node.alpha = Math.min(0.52, pulse * 0.52);
        node.y = rest.y - activeCue.cue.amplitude * pulse;
      }
      if (progress >= 1) {
        resetCue(activeCue.cue);
        activeCue = null;
      }
    },
    active() {
      return activeCue !== null;
    },
    destroy() {
      if (destroyed) return;
      if (activeCue) resetCue(activeCue.cue);
      activeCue = null;
      destroyed = true;
    },
  };
}

export type HomeAmbientPixiRuntime = HomeAmbientRuntime & Readonly<{
  setContext(context: HomeAmbientContextV1): void;
}>;

export function createHomeAmbientPixiRuntime(input: Readonly<{
  app: Application;
  nodeRegistry: ScenePixiNodeRegistry;
  d4: Container;
  profile: HomeSceneProfileV1;
  random?: () => number;
}>): HomeAmbientPixiRuntime {
  const steamCue = input.profile.ambientCues.rest.find((cue) => cue.kind === "steam");
  const steamRoot = steamCue?.origin ? createSteam(steamCue.origin) : null;
  if (steamRoot) {
    steamRoot.zIndex = 60;
    input.d4.addChild(steamRoot);
    input.d4.sortChildren();
  }

  const regions = Object.fromEntries(
    (["window", "desk", "shelf", "rest"] as const).map((id) => [
      id,
      createRegionRuntime({
        id,
        cues: input.profile.ambientCues[id],
        nodeRegistry: input.nodeRegistry,
        steamRoot: id === "rest" ? steamRoot : null,
      }),
    ]),
  ) as Record<HomeSceneRegionId, RegionRuntime>;
  const director = createHomeAmbientDirector({ regions, cues: input.profile.ambientCues, random: input.random });
  let context: HomeAmbientContextV1 = { motionMode: "off", time: "day", paused: true, priorityRegion: null };
  let destroyed = false;

  const tick = (ticker: import("pixi.js").Ticker) => {
    if (destroyed) return;
    const deltaMs = Math.min(100, Math.max(0, ticker.deltaMS));
    for (const region of Object.values(regions)) region.tick(deltaMs, context);
    director.tick(deltaMs);
    if (context.motionMode === "lite" && !Object.values(regions).some((region) => region.active())) {
      input.app.stop();
      input.app.render();
    }
  };

  input.app.ticker.maxFPS = 30;
  input.app.ticker.add(tick);

  const syncTicker = () => {
    if (destroyed || context.paused || context.motionMode === "off") input.app.stop();
    else if (context.motionMode === "full") input.app.start();
  };

  return {
    setContext(next) {
      if (destroyed) return;
      context = next;
      director.setContext(next);
      syncTicker();
      input.app.render();
    },
    trigger(region, cueId) {
      if (destroyed || context.paused || context.motionMode === "off") return;
      director.trigger(region, cueId);
      input.app.start();
    },
    pause() {
      if (destroyed) return;
      director.pause();
      input.app.stop();
      input.app.render();
    },
    resume() {
      if (destroyed) return;
      director.resume();
      syncTicker();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      input.app.ticker?.remove(tick);
      input.app.ticker?.stop();
      director.destroy();
      if (steamRoot && !steamRoot.destroyed) {
        steamRoot.removeFromParent();
        steamRoot.destroy({ children: true });
      }
    },
  };
}
