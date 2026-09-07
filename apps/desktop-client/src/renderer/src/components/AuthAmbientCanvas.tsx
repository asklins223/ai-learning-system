import { useEffect, useRef, useState } from "react";
import { Application, Container, FillGradient, Graphics } from "pixi.js";
import { sceneMotionDuration, type SceneMotionMode } from "../scene/scene-motion";
import {
  AUTH_AMBIENT_PERFORMANCE_BUDGET,
  resolveAuthAmbientPolicy,
} from "./auth-ambient-policy";

export type AuthAmbientLampCue = Readonly<{
  id: number;
  direction: "to-day" | "to-dusk" | "to-night";
}>;

type AuthAmbientCanvasProps = Readonly<{
  theme: "day" | "dusk" | "night";
  variant: "default" | "register";
  motionMode: SceneMotionMode;
  lampCue?: AuthAmbientLampCue | null;
}>;

type AmbientState = "disabled" | "loading" | "playing" | "settled" | "quiet" | "failed";

type AmbientLeaf = Readonly<{
  node: Graphics;
  normalizedX: number;
  cycleOffset: number;
  size: number;
  swayX: number;
  fallSpeed: number;
  phase: number;
  baseRotation: number;
  spin: number;
  targetAlpha: number;
  paletteIndex: number;
}>;

type AmbientParticle = Readonly<{
  node: Graphics;
  normalizedX: number;
  normalizedY: number;
  radius: number;
  stretch: number;
  driftX: number;
  driftY: number;
  floatX: number;
  floatY: number;
  phase: number;
  tempo: number;
  targetAlpha: number;
  paletteIndex: number;
}>;

type LampMote = Readonly<{
  node: Graphics;
  angleOffset: number;
  distance: number;
  lift: number;
  size: number;
  delay: number;
}>;

type ActiveLampEffect = {
  cue: AuthAmbientLampCue;
  elapsedMs: number;
  durationMs: number;
};

type AmbientFrameCaptureController = {
  seek: (time: number) => void;
  finish: () => void;
  timing: () => { duration: number };
};

type AmbientRuntime = Readonly<{
  trigger: (cue: AuthAmbientLampCue) => void;
  updateTheme: (nextTheme: "day" | "dusk" | "night") => void;
}>;

const COMPACT_MEDIA_QUERY = "(max-width: 760px), (max-height: 620px)";
const LAMP_EFFECT_DURATION_MS = 520;
const lampFrameCaptureStorageKey = "ailearn:auth-lamp-frame-capture";

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutCubic(progress: number): number {
  return 1 - ((1 - progress) ** 3);
}

function easeOutQuart(progress: number): number {
  return 1 - ((1 - progress) ** 4);
}

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // The canvas is decorative; a failed renderer must never block sign-in.
  }
}

function isLampFrameCaptureEnabled(): boolean {
  return window.localStorage.getItem(lampFrameCaptureStorageKey) === "paused";
}

function captureWindow(): Window & { __ailearnAuthAmbientCapture?: AmbientFrameCaptureController } {
  return window as Window & { __ailearnAuthAmbientCapture?: AmbientFrameCaptureController };
}

function clearAmbientFrameCapture(controller?: AmbientFrameCaptureController | null): void {
  const target = captureWindow();
  if (!controller || target.__ailearnAuthAmbientCapture === controller) {
    delete target.__ailearnAuthAmbientCapture;
  }
}

function lampAnchor(variant: "default" | "register", width: number, height: number): { x: number; y: number } {
  return variant === "register"
    ? { x: width * 0.33, y: height * 0.42 }
    : { x: width * 0.69, y: height * 0.57 };
}

function leafPalette(theme: "day" | "dusk" | "night"): readonly number[] {
  if (theme === "day") return [0xa64d24, 0xcb742f, 0xe0a050];
  if (theme === "dusk") return [0xc36a37, 0xe19a56, 0xa84c2c];
  return [0xad7748, 0xd7a46b, 0x758f8a];
}

function particlePalette(theme: "day" | "dusk" | "night"): readonly number[] {
  if (theme === "day") return [0xe6ae5f, 0xffe0aa, 0xfff1ca];
  if (theme === "dusk") return [0xf0a05c, 0xffcc91, 0xffebbf];
  return [0xffc66e, 0xffdda1, 0x8fd3df];
}

function createAmbientLeafNode(): Graphics {
  // Keep the geometry fixed and animate only transforms. This reads as a tiny
  // falling leaf at room distance, instead of a speck of dust on the screen.
  return new Graphics()
    .moveTo(0, -5)
    .bezierCurveTo(5.2, -3.7, 5.2, 2.8, 0, 7)
    .bezierCurveTo(-5.2, 2.8, -5.2, -3.7, 0, -5)
    .fill({ color: 0xffffff, alpha: 0.96 })
    .moveTo(0, -4)
    .quadraticCurveTo(-0.38, 1.2, 0.18, 7.8)
    .stroke({ width: 0.72, color: 0x5e3219, alpha: 0.34, cap: "round" });
}

function createAmbientParticleNode(): Graphics {
  // The dusk/night treatment keeps its former soft, luminous particles. As
  // with the leaves, the Graphics geometry is static and only transforms run
  // on the bounded ticker.
  return new Graphics()
    .ellipse(0, 0, 5.8, 2.6).fill({ color: 0xffffff, alpha: 0.045 })
    .ellipse(0, 0, 2.25, 0.96).fill({ color: 0xffffff, alpha: 0.22 })
    .circle(0, 0, 0.66).fill({ color: 0xffffff, alpha: 0.98 });
}

function isTypingElement(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.matches("input, textarea, select, [contenteditable='true'], [role='textbox']");
}

export function AuthAmbientCanvas({ theme, variant, motionMode, lampCue = null }: AuthAmbientCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<AmbientRuntime | null>(null);
  const themeRef = useRef(theme);
  const lampCueRef = useRef(lampCue);
  const consumedCueIdRef = useRef(0);
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(COMPACT_MEDIA_QUERY).matches
  ));
  const [state, setState] = useState<AmbientState>("disabled");
  const policy = resolveAuthAmbientPolicy({ motionMode, compact });
  const eligible = policy.enabled;

  themeRef.current = theme;
  lampCueRef.current = lampCue;

  useEffect(() => {
    const query = window.matchMedia(COMPACT_MEDIA_QUERY);
    const syncCompact = () => setCompact(query.matches);
    syncCompact();
    query.addEventListener("change", syncCompact);
    return () => query.removeEventListener("change", syncCompact);
  }, []);

  useEffect(() => {
    runtimeRef.current?.updateTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!eligible || !lampCue || lampCue.id <= consumedCueIdRef.current) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.trigger(lampCue);
    consumedCueIdRef.current = lampCue.id;
  }, [eligible, lampCue]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !eligible) {
      runtimeRef.current = null;
      setState("disabled");
      return undefined;
    }

    const gate = host.closest<HTMLElement>(".desktop-access-gate");
    const app = new Application();
    const leaves: AmbientLeaf[] = [];
    const particles: AmbientParticle[] = [];
    const motes: LampMote[] = [];
    const random = seededRandom((variant === "register" ? 0x2f : 0x71) + 0x51a7);
    const particleRoot = new Container();
    const leafRoot = new Container();
    const glowRoot = new Container();
    const moteRoot = new Container();
    const deskLightGradient = new FillGradient({
      type: "radial",
      center: { x: 0.42, y: 0.42 },
      innerRadius: 0.015,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.52,
      textureSpace: "local",
      colorStops: [
        { offset: 0, color: "rgba(255, 245, 213, 0.68)" },
        { offset: 0.28, color: "rgba(255, 203, 118, 0.27)" },
        { offset: 1, color: "rgba(255, 184, 92, 0)" },
      ],
    });
    const bulbGlowGradient = new FillGradient({
      type: "radial",
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0.02,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.5,
      textureSpace: "local",
      colorStops: [
        { offset: 0, color: "rgba(255, 253, 230, 0.94)" },
        { offset: 0.3, color: "rgba(255, 220, 149, 0.5)" },
        { offset: 1, color: "rgba(255, 191, 96, 0)" },
      ],
    });
    const outerGlow = new Graphics().ellipse(-14, 72, 220, 96).fill({ fill: deskLightGradient });
    const middleGlow = new Graphics().circle(0, 2, 46).fill({ fill: bulbGlowGradient });
    const coreGlow = new Graphics().circle(0, 2, 12).fill({ color: 0xfff7d9, alpha: 0.76 });
    const horizontalStart = variant === "register" ? 0.035 : 0.5;
    const horizontalSpan = variant === "register" ? 0.55 : 0.46;
    const introDurationMs = sceneMotionDuration("full", "camera") * 1_000;
    let activeLampEffect: ActiveLampEffect | null = null;
    let ambientCaptureController: AmbientFrameCaptureController | null = null;
    let cancelled = false;
    let initialized = false;
    let destroyed = false;
    let quiet = false;
    let introProgress = 0;
    let introElapsedMs = 0;
    let ambientElapsedMs = 0;
    let resizeObserver: ResizeObserver | null = null;
    let tickerUpdate: ((ticker: { deltaMS: number }) => void) | null = null;

    particleRoot.eventMode = "none";
    particleRoot.interactiveChildren = false;
    particleRoot.blendMode = "screen";
    leafRoot.eventMode = "none";
    leafRoot.interactiveChildren = false;
    leafRoot.blendMode = "normal";
    glowRoot.addChild(outerGlow, middleGlow, coreGlow);
    glowRoot.eventMode = "none";
    glowRoot.interactiveChildren = false;
    glowRoot.blendMode = "screen";
    glowRoot.alpha = 0;
    moteRoot.eventMode = "none";
    moteRoot.interactiveChildren = false;
    moteRoot.blendMode = "screen";

    const setEffectDiagnostics = (effect: ActiveLampEffect | null, progress = 0, intensity = 0) => {
      host.dataset.authAmbientEffect = effect?.cue.direction ?? "idle";
      host.dataset.authAmbientEffectProgress = String(Number(progress.toFixed(3)));
      host.dataset.authAmbientEffectIntensity = String(Number(intensity.toFixed(3)));
    };

    const applyStaticFrame = (progress: number, quietFrame = quiet) => {
      const width = host.clientWidth || app.screen.width;
      const height = host.clientHeight || app.screen.height;
      const eased = easeOutQuart(progress);
      const quietScale = quietFrame ? 0.42 : 1;
      const currentTheme = themeRef.current;
      const elapsedSeconds = ambientElapsedMs / 1_000;
      const useLeaves = currentTheme === "day";

      leafRoot.visible = useLeaves;
      particleRoot.visible = !useLeaves;

      if (useLeaves) {
        const palette = leafPalette(currentTheme);
        for (const leaf of leaves) {
          const fallProgress = (leaf.cycleOffset + elapsedSeconds * leaf.fallSpeed) % 1;
          const edgeFade = Math.min(
            1,
            clamp(fallProgress / 0.12),
            clamp((1 - fallProgress) / 0.14),
          );
          const flutter = Math.sin(elapsedSeconds * 1.14 + leaf.phase);
          const sway = Math.sin(elapsedSeconds * 0.7 + leaf.phase * 0.73) * leaf.swayX;
          const scale = leaf.size * (0.9 + (flutter + 1) * 0.07);
          leaf.node.position.set(
            leaf.normalizedX * width + sway,
            (-0.08 + fallProgress * 1.16) * height,
          );
          leaf.node.scale.set(scale, scale * (0.82 + (flutter + 1) * 0.08));
          leaf.node.rotation = leaf.baseRotation + flutter * 0.54 + elapsedSeconds * leaf.spin;
          leaf.node.alpha = leaf.targetAlpha * edgeFade * (0.14 + eased * 0.86) * quietScale;
          leaf.node.tint = palette[leaf.paletteIndex % palette.length];
        }
        return;
      }

      const palette = particlePalette(currentTheme);
      for (const particle of particles) {
        const phase = particle.phase + elapsedSeconds * particle.tempo;
        const horizontalFloat = Math.sin(phase) * particle.floatX * eased;
        const verticalFloat = Math.cos(phase * 0.74 + particle.phase * 0.37) * particle.floatY * eased;
        const breath = 0.86 + (Math.sin(phase * 0.68 + particle.phase) + 1) * 0.1;
        particle.node.position.set(
          particle.normalizedX * width - particle.driftX * (1 - eased) + horizontalFloat,
          particle.normalizedY * height - particle.driftY * (1 - eased) + verticalFloat,
        );
        const scale = particle.radius * (0.76 + eased * 0.24 + Math.sin(phase * 0.58) * 0.04);
        particle.node.scale.set(scale, scale * particle.stretch);
        particle.node.rotation = Math.sin(phase * 0.53 + particle.phase * 0.62) * 0.24;
        particle.node.alpha = particle.targetAlpha * (0.18 + eased * 0.82) * quietScale * breath;
        particle.node.tint = palette[particle.paletteIndex % palette.length];
      }
    };

    const alignLampLayers = () => {
      const width = host.clientWidth || app.screen.width;
      const height = host.clientHeight || app.screen.height;
      const anchor = lampAnchor(variant, width, height);
      glowRoot.position.set(anchor.x, anchor.y + 2);
      moteRoot.position.set(anchor.x, anchor.y + 2);
    };

    const clearLampVisuals = () => {
      glowRoot.alpha = 0;
      for (const mote of motes) {
        mote.node.alpha = 0;
        mote.node.visible = false;
      }
    };

    const applyLampEffect = () => {
      const effect = activeLampEffect;
      if (!effect) {
        clearLampVisuals();
        setEffectDiagnostics(null);
        return;
      }

      const progress = clamp(effect.elapsedMs / effect.durationMs);
      const rise = easeOutCubic(clamp(progress / 0.2));
      const fall = 1 - easeOutCubic(clamp((progress - 0.25) / 0.75));
      const intensity = rise * fall;
      const direction = effect.cue.direction;
      const warmingScene = direction === "to-night" || direction === "to-dusk";
      const daylightIgnition = warmingScene && themeRef.current !== "night";
      const moteTint = warmingScene ? 0xffd78e : 0xd5f0ee;
      const baseAngle = warmingScene ? 2.16 : -0.8;
      const travel = easeOutCubic(clamp((progress - 0.04) / 0.78));

      alignLampLayers();
      // A screen-blended lamp cannot be read against an already sunlit desk.
      // Keep the first beat of day → night as a small warm pool on the real
      // lamp/desk, then return to screen as soon as the scene reaches night.
      // This gives the click a physical cause before the image handoff without
      // introducing a page-wide darkening veil.
      glowRoot.blendMode = daylightIgnition ? "normal" : "screen";
      moteRoot.blendMode = daylightIgnition ? "normal" : "screen";
      outerGlow.alpha = daylightIgnition ? 0.22 + intensity * 0.16 : 0.68 + intensity * 0.24;
      middleGlow.alpha = daylightIgnition ? 0.34 + intensity * 0.18 : 0.7 + intensity * 0.22;
      coreGlow.alpha = daylightIgnition ? 0.5 + intensity * 0.2 : 0.68 + intensity * 0.24;
      glowRoot.alpha = intensity * (daylightIgnition ? 0.62 : 0.92);

      for (const mote of motes) {
        const localProgress = clamp((progress - mote.delay) / Math.max(0.2, 0.82 - mote.delay));
        const moteTravel = travel * easeOutCubic(localProgress);
        const angle = baseAngle + mote.angleOffset;
        mote.node.visible = localProgress > 0 && intensity > 0.01;
        mote.node.position.set(
          Math.cos(angle) * mote.distance * moteTravel,
          Math.sin(angle) * mote.distance * moteTravel - mote.lift * moteTravel * moteTravel,
        );
        const scale = mote.size * (0.72 + localProgress * 0.36);
        mote.node.scale.set(scale, scale * (0.72 + localProgress * 0.18));
        mote.node.alpha = intensity * (0.38 + localProgress * 0.58);
        mote.node.tint = moteTint;
      }
      setEffectDiagnostics(effect, progress, intensity);
    };

    const settleAmbient = (
      nextState: Extract<AmbientState, "settled" | "quiet">,
      suspendTicker = false,
    ) => {
      if (!initialized || destroyed) return;
      quiet = nextState === "quiet";
      introProgress = 1;
      applyStaticFrame(1, quiet);
      if (!activeLampEffect) clearLampVisuals();
      app.ticker.maxFPS = quiet ? 12 : AUTH_AMBIENT_PERFORMANCE_BUDGET.maxFps;
      if (suspendTicker) {
        safeCall(() => app.stop());
      } else {
        // The leaves in day and luminous motes after dusk are an environmental
        // layer, not an entry-only flourish. Typing makes them quieter and slower to render,
        // but does not make the room feel frozen; only a hidden window stops
        // the bounded ticker altogether.
        safeCall(() => app.start());
      }
      safeCall(() => app.render());
      if (!cancelled) setState(nextState);
    };

    const finishLampEffect = () => {
      activeLampEffect = null;
      clearLampVisuals();
      setEffectDiagnostics(null);
      clearAmbientFrameCapture(ambientCaptureController);
      ambientCaptureController = null;
      settleAmbient(quiet ? "quiet" : "settled");
    };

    const updateTheme = (nextTheme: "day" | "dusk" | "night") => {
      themeRef.current = nextTheme;
      if (!initialized || destroyed) return;
      applyStaticFrame(introProgress, quiet);
      applyLampEffect();
      safeCall(() => app.render());
    };

    const resumeAmbient = () => {
      if (!initialized || destroyed || activeLampEffect || document.visibilityState !== "visible") return;
      if (isTypingElement(document.activeElement)) return;
      quiet = false;
      introProgress = 1;
      applyStaticFrame(1, false);
      app.ticker.maxFPS = AUTH_AMBIENT_PERFORMANCE_BUDGET.maxFps;
      safeCall(() => app.start());
      safeCall(() => app.render());
      if (!cancelled) setState("settled");
    };

    const armFrameCapture = () => {
      const controller: AmbientFrameCaptureController = {
        seek: (time) => {
          if (!activeLampEffect || destroyed) return;
          safeCall(() => app.stop());
          activeLampEffect.elapsedMs = clamp(time * 1_000, 0, activeLampEffect.durationMs);
          applyStaticFrame(introProgress, quiet);
          applyLampEffect();
          safeCall(() => app.render());
        },
        finish: () => {
          if (destroyed || !activeLampEffect) return;
          clearAmbientFrameCapture(controller);
          ambientCaptureController = null;
          safeCall(() => app.start());
        },
        timing: () => ({ duration: LAMP_EFFECT_DURATION_MS / 1_000 }),
      };
      ambientCaptureController = controller;
      captureWindow().__ailearnAuthAmbientCapture = controller;
    };

    const triggerLampEffect = (cue: AuthAmbientLampCue) => {
      if (!initialized || destroyed) return;
      quiet = false;
      app.ticker.maxFPS = AUTH_AMBIENT_PERFORMANCE_BUDGET.maxFps;
      activeLampEffect = { cue, elapsedMs: 0, durationMs: LAMP_EFFECT_DURATION_MS };
      setState("playing");
      applyStaticFrame(introProgress, false);
      applyLampEffect();
      if (isLampFrameCaptureEnabled()) {
        armFrameCapture();
        safeCall(() => app.stop());
        safeCall(() => app.render());
      } else {
        safeCall(() => app.start());
      }
    };

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (tickerUpdate) safeCall(() => app.ticker.remove(tickerUpdate!));
      clearAmbientFrameCapture(ambientCaptureController);
      ambientCaptureController = null;
      deskLightGradient.destroy();
      bulbGlowGradient.destroy();
      if (runtimeRef.current) runtimeRef.current = null;
      safeCall(() => app.stop());
      safeCall(() => app.destroy(
        { removeView: true, releaseGlobalResources: true },
        { children: true, texture: true, textureSource: true, context: true },
      ));
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (isTypingElement(event.target) && !activeLampEffect) {
        settleAmbient("quiet");
      }
    };

    const handleFocusOut = () => {
      window.requestAnimationFrame(resumeAmbient);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" && !activeLampEffect) {
        settleAmbient("quiet", true);
      } else if (!activeLampEffect) {
        resumeAmbient();
      }
    };

    const start = async () => {
      setState("loading");
      try {
        await app.init({
          antialias: true,
          autoDensity: true,
          autoStart: false,
          backgroundAlpha: 0,
          clearBeforeRender: true,
          preference: "webgl",
          resolution: Math.min(
            Math.max(window.devicePixelRatio || 1, 1),
            AUTH_AMBIENT_PERFORMANCE_BUDGET.maxResolution,
          ),
          resizeTo: host,
        });
        initialized = true;

        if (cancelled) {
          destroy();
          return;
        }

        app.canvas.setAttribute("aria-hidden", "true");
        app.canvas.tabIndex = -1;
        app.canvas.className = "desktop-access-gate__ambient-canvas-element";
        app.canvas.dataset.authAmbientRenderer = "pixi-webgl";
        app.canvas.style.pointerEvents = "none";
        host.appendChild(app.canvas);

        for (let index = 0; index < AUTH_AMBIENT_PERFORMANCE_BUDGET.maxParticles; index += 1) {
          const node = createAmbientParticleNode();
          node.eventMode = "none";
          particleRoot.addChild(node);
          particles.push({
            node,
            normalizedX: horizontalStart + random() * horizontalSpan,
            normalizedY: 0.08 + random() * 0.72,
            radius: 1.55 + random() * 3.05,
            stretch: 0.78 + random() * 0.54,
            driftX: (variant === "register" ? 1 : -1) * (7 + random() * 16),
            driftY: 5 + random() * 14,
            floatX: 28 + random() * 42,
            floatY: 13 + random() * 25,
            phase: random() * Math.PI * 2,
            tempo: 0.29 + random() * 0.19,
            targetAlpha: 0.34 + random() * 0.24,
            paletteIndex: index,
          });
        }

        for (let index = 0; index < AUTH_AMBIENT_PERFORMANCE_BUDGET.maxDayLeaves; index += 1) {
          const node = createAmbientLeafNode();
          node.eventMode = "none";
          leafRoot.addChild(node);
          leaves.push({
            node,
            normalizedX: horizontalStart + random() * horizontalSpan,
            cycleOffset: random(),
            size: 0.64 + random() * 0.58,
            swayX: 10 + random() * 32,
            // A complete fall takes roughly 14–26 seconds: alive at a glance,
            // but never fast enough to compete with the form.
            fallSpeed: 0.038 + random() * 0.034,
            phase: random() * Math.PI * 2,
            baseRotation: random() * Math.PI * 2,
            spin: (random() - 0.5) * 0.42,
            targetAlpha: 0.42 + random() * 0.22,
            paletteIndex: index,
          });
        }

        for (let index = 0; index < AUTH_AMBIENT_PERFORMANCE_BUDGET.maxLampMotes; index += 1) {
          const node = new Graphics().circle(0, 0, 1).fill({ color: 0xffffff });
          node.eventMode = "none";
          node.visible = false;
          moteRoot.addChild(node);
          motes.push({
            node,
            angleOffset: (random() - 0.5) * 0.92,
            distance: 46 + random() * 104,
            lift: 10 + random() * 34,
            size: 1.25 + random() * 1.7,
            delay: random() * 0.16,
          });
        }

        app.stage.addChild(particleRoot, leafRoot, glowRoot, moteRoot);
        app.stage.eventMode = "none";
        app.ticker.maxFPS = AUTH_AMBIENT_PERFORMANCE_BUDGET.maxFps;
        app.ticker.minFPS = 12;
        tickerUpdate = (ticker) => {
          const elapsed = Math.min(ticker.deltaMS, 50);
          ambientElapsedMs += elapsed;
          if (activeLampEffect) {
            activeLampEffect.elapsedMs += elapsed;
            applyStaticFrame(introProgress, false);
            applyLampEffect();
            if (activeLampEffect.elapsedMs >= activeLampEffect.durationMs) finishLampEffect();
            return;
          }

          if (introProgress < 1) {
            introElapsedMs += elapsed;
            introProgress = clamp(introElapsedMs / introDurationMs);
            applyStaticFrame(introProgress);
            if (introProgress >= 1) settleAmbient("settled");
          } else {
            applyStaticFrame(1, quiet);
          }
        };
        app.ticker.add(tickerUpdate);

        resizeObserver = new ResizeObserver(() => {
          if (destroyed) return;
          safeCall(() => app.resize());
          applyStaticFrame(introProgress, quiet);
          applyLampEffect();
          safeCall(() => app.render());
        });
        resizeObserver.observe(host);
        gate?.addEventListener("focusin", handleFocusIn);
        gate?.addEventListener("focusout", handleFocusOut);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        runtimeRef.current = { trigger: triggerLampEffect, updateTheme };
        setEffectDiagnostics(null);
        alignLampLayers();
        applyStaticFrame(0);
        clearLampVisuals();
        app.render();
        setState("playing");

        const queuedCue = lampCueRef.current;
        if (queuedCue && queuedCue.id > consumedCueIdRef.current) {
          triggerLampEffect(queuedCue);
          consumedCueIdRef.current = queuedCue.id;
        } else {
          app.start();
        }
      } catch {
        if (!cancelled) setState("failed");
        destroy();
      }
    };

    void start();

    return () => {
      cancelled = true;
      gate?.removeEventListener("focusin", handleFocusIn);
      gate?.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      destroy();
    };
  }, [eligible, variant]);

  return (
    <div
      ref={hostRef}
      className="desktop-access-gate__ambient-canvas"
      data-auth-ambient-state={state}
      data-auth-ambient-motion={state === "settled" ? "persistent" : state === "playing" ? "transitioning" : state}
      data-auth-ambient-theme={theme}
      data-auth-ambient-variant={variant}
      aria-hidden="true"
    />
  );
}
