import { useCallback, useEffect, useRef, useState } from "react";
import {
  BlurFilter,
  Application,
  Container,
  Graphics,
  PerspectiveMesh,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  doorEntryMotionProfile,
  doorEntryPlaybackState,
  type SceneMotionMode,
} from "../scene/scene-motion";
import {
  resolveDoorEntryAssetUrls,
  type LearningRoomManifest,
} from "../media/learning-room-manifest";
import { loadSceneImageTexture } from "../scene/scene-texture-loader";

gsap.registerPlugin(useGSAP);

export type DoorTheme = "day" | "night";

const WORLD = { width: 1672, height: 941 } as const;
const HOME_WORLD = { width: 3344, height: 1882 } as const;

// These are the visual registration points in the closed threshold poster.
// The right edge is the hinge: the slab rotates from that edge into the room.
const DOOR = {
  left: 946,
  top: 0,
  right: 1492,
  bottom: 880,
  hingeX: 1492,
  interiorLeft: 920,
  interiorRight: 1088,
} as const;

type DoorAnimationState = {
  latch: number;
  swing: number;
  interior: number;
  light: number;
  camera: number;
  exit: number;
};

type SceneTransform = {
  scale: number;
  x: number;
  y: number;
};

type DoorScene = {
  app: Application;
  root: Container;
  state: DoorAnimationState;
  resize: () => void;
  render: () => void;
  destroy: () => void;
};

function coverTransform(width: number, height: number, world: { width: number; height: number } = WORLD): SceneTransform {
  const scale = Math.max(width / world.width, height / world.height);
  return {
    scale,
    x: (width - world.width * scale) / 2,
    y: (height - world.height * scale) / 2,
  };
}

function placeWorldSprite(sprite: Sprite, transform: SceneTransform, world: { width: number; height: number } = WORLD) {
  const ratio = world.width / sprite.texture.width;
  sprite.position.set(transform.x, transform.y);
  sprite.scale.set(transform.scale * ratio);
}

function mapX(value: number, transform: SceneTransform) {
  return transform.x + value * transform.scale;
}

function mapY(value: number, transform: SceneTransform) {
  return transform.y + value * transform.scale;
}

function createDoorScene(
  app: Application,
  host: HTMLElement,
  closedTexture: Texture,
  homeTexture: Texture,
): DoorScene {
  const root = new Container({ sortableChildren: true });
  const closedBackdrop = new Sprite(closedTexture);
  // The closed poster is the canonical registration source for this scene.
  // Reusing its exact door-leaf pixels avoids the visible snap caused by
  // compositing a separately generated slab whose rails and hinge-side edge
  // do not land on the poster's rails. This crop is still a real texture: the
  // PerspectiveMesh below deforms it continuously around the hinge.
  const doorTexture = new Texture({
    source: closedTexture.source,
    frame: new Rectangle(
      DOOR.left,
      DOOR.top,
      DOOR.right - DOOR.left,
      DOOR.bottom - DOOR.top,
    ),
    orig: new Rectangle(
      0,
      0,
      DOOR.right - DOOR.left,
      DOOR.bottom - DOOR.top,
    ),
  });
  // Keep the portal and the final handoff on the same room texture. The
  // opening therefore reveals the actual room behind the slab instead of
  // crossfading to a second, unrelated doorway poster.
  const portal = new Container({ sortableChildren: true });
  const portalTexture = new Texture({
    source: homeTexture.source,
    // The source crop has the same aspect ratio as the registered threshold,
    // so a single scale keeps the room view stable while the door rotates.
    frame: new Rectangle(1050, 0, 1230, HOME_WORLD.height),
    orig: new Rectangle(0, 0, 1230, HOME_WORLD.height),
  });
  const portalRoom = new Sprite(portalTexture);
  const finalRoom = new Sprite(homeTexture);

  const warmLight = new Graphics();
  const doorShadow = new Graphics();
  const doorThickness = new Graphics();
  const thresholdLight = new Graphics();
  const portalRevealMask = new Graphics();
  const doorApertureMask = new Graphics();
  const warmLightFilter = new BlurFilter({ strength: 54, quality: 3, kernelSize: 7 });
  const thresholdLightFilter = new BlurFilter({ strength: 18, quality: 2, kernelSize: 5 });
  // PerspectiveMesh keeps the texture's
  // UVs perspective-correct while the four registered corners are driven by
  // the hinge angle. This is a plane rotating around a vertical hinge, not a
  // CSS-sized card being faded or squashed.
  const door = new PerspectiveMesh({
    texture: doorTexture,
    verticesX: 18,
    verticesY: 18,
    x0: 0,
    y0: 0,
    x1: doorTexture.width,
    y1: 0,
    x2: doorTexture.width,
    y2: doorTexture.height,
    x3: 0,
    y3: doorTexture.height,
  });

  closedBackdrop.zIndex = 0;
  portal.zIndex = 1;
  warmLight.zIndex = 2;
  doorShadow.zIndex = 3;
  doorThickness.zIndex = 4;
  door.zIndex = 5;
  thresholdLight.zIndex = 6;
  finalRoom.zIndex = 7;

  closedBackdrop.label = "threshold-closed-backdrop";
  portal.label = "threshold-room-portal";
  portalRoom.label = "threshold-room-cropped-view";
  finalRoom.label = "threshold-final-room-handoff";
  door.label = "door-slab-hinged-mesh";
  portalRevealMask.label = "threshold-room-reveal-mask";
  doorApertureMask.label = "threshold-door-aperture-mask";
  // Stencil masks are collected by Pixi's mask pipe on demand. They must stay
  // renderable for that pass; `includeInBuild = false` is managed internally
  // by the mask effect so these Graphics do not paint as visible white shapes
  // in the normal scene pass.
  portal.mask = portalRevealMask;
  warmLight.mask = portalRevealMask;
  door.mask = doorApertureMask;
  portal.alpha = 0;
  portal.addChild(portalRoom);
  warmLight.filters = [warmLightFilter];
  thresholdLight.filters = [thresholdLightFilter];

  root.addChild(
    closedBackdrop,
    portal,
    warmLight,
    doorShadow,
    doorThickness,
    door,
    thresholdLight,
    finalRoom,
    portalRevealMask,
    doorApertureMask,
  );
  app.stage.addChild(root);

  const state: DoorAnimationState = {
    latch: 0,
    swing: 0,
    interior: 0,
    light: 0,
    camera: 0,
    exit: 0,
  };

  let transform: SceneTransform = { scale: 1, x: 0, y: 0 };
  let portalTransform: SceneTransform = { scale: 1, x: 0, y: 0 };
  let width = host.clientWidth || window.innerWidth;
  let height = host.clientHeight || window.innerHeight;

  const drawStaticLayers = () => {
    transform = coverTransform(width, height);
    placeWorldSprite(closedBackdrop, transform);
    placeWorldSprite(finalRoom, transform);

    const openingLeft = mapX(DOOR.interiorLeft, transform);
    const openingRight = mapX(DOOR.right + 5, transform);
    const openingTop = mapY(DOOR.top, transform);
    const openingBottom = mapY(DOOR.bottom + 2, transform);
    portalTransform = {
      scale: (openingBottom - openingTop) / portalTexture.height,
      x: openingLeft,
      y: openingTop,
    };
    portalRoom.scale.set(portalTransform.scale);
    portalRoom.position.set(portalTransform.x, portalTransform.y);
    const glowLeft = mapX(DOOR.interiorLeft - 14, transform);
    const glowRight = mapX(DOOR.right + 18, transform);
    const glowTop = mapY(24, transform);
    const glowBottom = mapY(DOOR.bottom + 34, transform);
    warmLight
      .clear()
      .roundRect(glowLeft, glowTop, glowRight - glowLeft, glowBottom - glowTop, transform.scale * 22)
      .fill({ color: 0xffbd63, alpha: 0.22 });
    warmLight.blendMode = "screen";
    warmLight.filterArea = new Rectangle(0, 0, width, height);

    doorApertureMask
      .clear()
      .rect(
        mapX(DOOR.interiorLeft, transform),
        mapY(DOOR.top, transform),
        mapX(DOOR.right + 8, transform) - mapX(DOOR.interiorLeft, transform),
        mapY(DOOR.bottom + 8, transform) - mapY(DOOR.top, transform),
      )
      .fill({ color: 0xffffff });

    thresholdLight
      .clear()
      .poly([
        mapX(DOOR.interiorLeft - 2, transform),
        mapY(DOOR.bottom - 8, transform),
        mapX(DOOR.right + 1, transform),
        mapY(DOOR.bottom - 8, transform),
        mapX(DOOR.right + 22, transform),
        mapY(DOOR.bottom + 30, transform),
        mapX(DOOR.interiorLeft - 22, transform),
        mapY(DOOR.bottom + 30, transform),
      ])
      .fill({ color: 0xffb85f, alpha: 0.065 });
    thresholdLight.blendMode = "screen";
    thresholdLight.filterArea = new Rectangle(0, 0, width, height);

  };

  const projectDoor = () => {
    const angle = state.swing * Math.PI * 0.42;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const focalLength = 860;
    const depthScale = 0.46;
    const points = [
      [DOOR.left, DOOR.top],
      [DOOR.right, DOOR.top],
      [DOOR.right, DOOR.bottom],
      [DOOR.left, DOOR.bottom],
    ] as const;
    const projected: Array<[number, number]> = points.map(([x, y]) => {
      const localX = x - DOOR.hingeX;
      const depth = -localX * sine * depthScale;
      const perspective = focalLength / (focalLength + depth);
      // Latch release changes the handle state, not the hinge registration.
      // Translating the whole slab here makes the hinge-side rail drift during
      // the first few frames and reads as a resized/shortened door.
      const screenX = DOOR.hingeX + localX * cosine * perspective;
      // A door rotates around a vertical hinge. Keep the top and bottom edges
      // on the same vertical rails; adding a global y drift here makes the
      // ceiling gap read like a floating card instead of a real door slab.
      // Keep the slab's real height invariant while it swings. Perspective is
      // only used to compress the horizontal distance to the hinge; applying
      // it to Y makes the far edge visibly shorter than the registered door.
      const screenY = y;
      return [mapX(screenX, transform), mapY(screenY, transform)];
    });

    door.setCorners(
      projected[0][0], projected[0][1],
      projected[1][0], projected[1][1],
      projected[2][0], projected[2][1],
      projected[3][0], projected[3][1],
    );

    const [topLeft, topRight, bottomRight, bottomLeft] = projected;
    const thickness = Math.max(2, transform.scale * 11 * state.swing);
    const hingeEdge = Math.max(2, transform.scale * 8 * state.swing);
    doorThickness
      .clear()
      .poly([
        bottomLeft[0], bottomLeft[1],
        bottomRight[0], bottomRight[1],
        bottomRight[0] + thickness, bottomRight[1] + thickness * 0.28,
        bottomLeft[0] + thickness, bottomLeft[1] + thickness * 0.28,
      ])
      .fill({ color: 0x70452a, alpha: 0.2 * state.swing });
    if (state.swing > 0) {
      doorThickness
        .poly([
          topRight[0], topRight[1],
          bottomRight[0], bottomRight[1],
          bottomRight[0] + hingeEdge, bottomRight[1] + hingeEdge * 0.18,
          topRight[0] + hingeEdge, topRight[1] + hingeEdge * 0.18,
        ])
        .fill({ color: 0x5b341f, alpha: 0.26 * state.swing });
    }

    const shadowReach = mapX(110 + 42 * state.swing, transform) - transform.x;
    doorShadow
      .clear()
      .poly([
        topLeft[0], topLeft[1],
        bottomLeft[0], bottomLeft[1],
        bottomLeft[0] - shadowReach * 0.035, bottomLeft[1] + mapY(22, transform) - transform.y,
        topLeft[0] - shadowReach * 0.035, topLeft[1] + mapY(22, transform) - transform.y,
      ])
      .fill({ color: 0x70452a, alpha: 0.045 * state.swing });

    // Reveal only the gap that the rotating leaf has actually vacated. The
    // closed poster remains underneath everywhere else, so no opaque room
    // rectangle or second full-door image can pop in at the latch phase.
    const apertureLeft = mapX(DOOR.interiorLeft, transform);
    const apertureTop = mapY(DOOR.top, transform);
    const apertureBottom = mapY(DOOR.bottom + 8, transform);
    const movingEdge = Math.min(Math.max(topLeft[0], apertureLeft), bottomLeft[0]);
    const revealWidth = Math.max(0, movingEdge - apertureLeft);
    portalRevealMask.clear();
    if (revealWidth > 0.5) {
      portalRevealMask
        .rect(apertureLeft, apertureTop, revealWidth, apertureBottom - apertureTop)
        .fill({ color: 0xffffff });
    }
  };

  const render = () => {
    projectDoor();
    host.dataset.doorLatch = state.latch.toFixed(3);
    host.dataset.doorSwing = state.swing.toFixed(3);
    host.dataset.doorLight = state.light.toFixed(3);
    // Keep the host opaque for the handoff. Once the camera has settled, the
    // same room texture takes over as one opaque frame; blending the cropped
    // portal with the full room creates a misregistered ghost image.
    host.style.opacity = "1";
    // The slab is allowed to rotate continuously from the registered closed
    // pose. The poster underneath supplies the exact resting pixels, while
    // the dynamic mask below exposes only the physical gap behind it.
    const isMoving = state.swing > 0.0001;
    const handoffActive = state.exit > 0.0001;
    closedBackdrop.alpha = handoffActive ? 0 : 1;
    finalRoom.alpha = handoffActive ? 1 : 0;
    door.alpha = isMoving && !handoffActive ? 1 : 0;
    portal.alpha = isMoving && !handoffActive ? 1 : 0;
    warmLight.alpha = isMoving && !handoffActive ? Math.max(state.light, 0.16) : 0;
    doorShadow.alpha = handoffActive ? 0 : 1;
    doorThickness.alpha = handoffActive ? 0 : 1;
    thresholdLight.alpha = handoffActive ? 0 : state.light;
    host.dataset.doorInterior = state.interior.toFixed(3);
    host.dataset.doorPortalAlpha = portal.alpha.toFixed(3);
    host.dataset.doorTextureSize = `${doorTexture.width}x${doorTexture.height}`;
    host.dataset.doorRoomTextureSize = `${homeTexture.width}x${homeTexture.height}`;
    root.alpha = 1;

    const cameraX = -state.camera * transform.scale * 18;
    const cameraY = -state.camera * transform.scale * 9;
    portalRoom.scale.set(portalTransform.scale * (1 + state.camera * 0.02));
    portalRoom.position.set(portalTransform.x + cameraX * 0.18, portalTransform.y + cameraY * 0.18);
  };

  const resize = () => {
    width = host.clientWidth || window.innerWidth;
    height = host.clientHeight || window.innerHeight;
    drawStaticLayers();
    render();
  };

  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  resizeObserver?.observe(host);
  window.addEventListener("resize", resize);
  resize();

  return {
    app,
    root,
    state,
    resize,
    render,
    destroy: () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
      portalTexture.destroy(false);
      homeTexture.destroy(false);
      doorTexture.destroy(false);
      closedTexture.destroy(false);
    },
  };
}

export function DoorOpeningTransition({
  theme,
  motionMode,
  manifest,
  manifestError,
  onComplete,
}: {
  theme: DoorTheme;
  motionMode: SceneMotionMode;
  manifest: LearningRoomManifest | null;
  manifestError: string | null;
  onComplete: () => void;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<DoorScene | null>(null);
  const onCompleteRef = useRef(onComplete);
  const completedRef = useRef(false);
  const [sceneReady, setSceneReady] = useState(false);
  onCompleteRef.current = onComplete;

  const finishTransition = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current();
  }, []);

  useEffect(() => {
    if (motionMode === "off") finishTransition();
  }, [finishTransition, motionMode]);

  useEffect(() => {
    if (motionMode === "off" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishTransition();
      return;
    }

    const host = scopeRef.current;
    if (!host) return;
    if (!manifest) {
      if (manifestError) {
        host.dataset.doorFallback = "manifest";
        finishTransition();
      }
      return;
    }
    let cancelled = false;
    let canvas: HTMLCanvasElement | null = null;
    let ownedTextures: Texture[] = [];
    let sceneOwnsTextures = false;
    const textureAbortController = new AbortController();
    const releaseOwnedTextures = () => {
      ownedTextures.forEach((texture) => texture.destroy(false));
      ownedTextures = [];
    };
    const handleContextLost = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      if (host) host.dataset.doorFallback = "context-loss";
      textureAbortController.abort();
      finishTransition();
    };
    let assetUrls: { closed: string; home: string };
    try {
      assetUrls = resolveDoorEntryAssetUrls(manifest, theme);
    } catch {
      host.dataset.doorFallback = "manifest";
      finishTransition();
      return;
    }
    host.dataset.doorAssetSource = "manifest";
    host.dataset.doorResourceState = "loading";
    host.dataset.doorClosedAsset = manifest.entryPosters.closed[theme].id;
    host.dataset.doorHomeAsset = manifest.posters[theme].id;
    const app = new Application();

    const initialize = async () => {
      try {
        await app.init({
          antialias: true,
          autoDensity: true,
          backgroundAlpha: 0,
          backgroundColor: theme === "night" ? 0x090d15 : 0x28170f,
          autoStart: false,
          preference: "webgl",
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          resizeTo: host,
        });
        if (cancelled) {
          app.destroy({ removeView: true });
          return;
        }
        host.appendChild(app.canvas);
        canvas = app.canvas;
        canvas.addEventListener("webglcontextlost", handleContextLost, { passive: false });
        const textureResults = await Promise.allSettled([
          loadSceneImageTexture(assetUrls.closed, textureAbortController.signal),
          loadSceneImageTexture(assetUrls.home, textureAbortController.signal),
        ]);
        ownedTextures = textureResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        if (cancelled) {
          releaseOwnedTextures();
          host.dataset.doorResourceState = "released";
          app.destroy({ removeView: true });
          return;
        }
        const failedTexture = textureResults.find((result) => result.status === "rejected");
        if (failedTexture?.status === "rejected") throw failedTexture.reason;
        const [closedTexture, homeTexture] = textureResults.map((result) => result.status === "fulfilled" ? result.value : null);
        if (!closedTexture || !homeTexture) throw new Error("Door transition textures were incomplete");
        if (cancelled) {
          releaseOwnedTextures();
          host.dataset.doorResourceState = "released";
          app.destroy({ removeView: true });
          return;
        }
        sceneRef.current = createDoorScene(app, host, closedTexture, homeTexture);
        sceneOwnsTextures = true;
        ownedTextures = [];
        host.dataset.doorResourceState = "ready";
        setSceneReady(true);
      } catch {
        if (!sceneOwnsTextures) releaseOwnedTextures();
        host.dataset.doorResourceState = "released";
        if (!cancelled) {
          if (!host.dataset.doorFallback) host.dataset.doorFallback = "asset";
          finishTransition();
        }
        app.destroy({ removeView: true });
      }
    };

    void initialize();
    return () => {
      cancelled = true;
      textureAbortController.abort();
      if (!sceneOwnsTextures) releaseOwnedTextures();
      canvas?.removeEventListener("webglcontextlost", handleContextLost);
      sceneRef.current?.destroy();
      sceneRef.current = null;
      host.dataset.doorResourceState = "released";
      setSceneReady(false);
    };
  }, [finishTransition, manifest, manifestError, motionMode, theme]);

  useGSAP(() => {
    const scene = sceneRef.current;
    if (!scene || !sceneReady) return;

    const state = scene.state;
    const host = scopeRef.current;
    const profile = doorEntryMotionProfile(motionMode);
    if (profile.durationScale === 0) {
      finishTransition();
      return;
    }
    const durationFor = (seconds: number) => seconds * profile.durationScale;
    const captureMode = document.documentElement.dataset.captureDoorTransition === "true";
    if (host) {
      host.dataset.doorCaptureMode = captureMode ? "paused" : "playing";
      host.dataset.doorMotionMode = motionMode;
    }
    const timeline = gsap.timeline({
      paused: captureMode || document.visibilityState !== "visible",
      defaults: { ease: "power3.inOut" },
      onUpdate: scene.render,
      onComplete: finishTransition,
    });

    const syncVisibility = () => {
      const visibility = document.visibilityState === "visible" ? "visible" : "hidden";
      const playback = doorEntryPlaybackState(visibility, captureMode);
      if (playback.rendererRunning) scene.app.start();
      else scene.app.stop();
      if (playback.timelinePaused) timeline.pause();
      else timeline.play();
      if (host) {
        host.dataset.doorVisibility = visibility;
        host.dataset.doorTimeline = playback.timelinePaused ? "paused" : "playing";
        host.dataset.doorRenderer = playback.rendererRunning ? "running" : "stopped";
      }
    };
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();

    const handleCaptureCommand = (event: Event) => {
      if (!captureMode) return;
      const detail = (event as CustomEvent<{ action?: "seek" | "play"; progress?: number }>).detail;
      if (detail?.action === "seek" && typeof detail.progress === "number") {
        timeline.pause();
        timeline.progress(Math.max(0, Math.min(1, detail.progress)));
        scene.render();
        if (host) host.dataset.doorCapturePaused = "true";
      } else if (detail?.action === "play") {
        if (host) host.dataset.doorCapturePaused = "false";
        timeline.play();
      }
    };
    host?.addEventListener("door-capture-command", handleCaptureCommand);

    timeline.addLabel("latch_release", 0);
    timeline.to(state, { latch: 1, duration: durationFor(0.2), ease: "power2.out" }, "latch_release");
    timeline.to(state, { swing: 0.12 * profile.swing, duration: durationFor(0.24), ease: "power2.inOut" }, `latch_release+=${durationFor(0.1)}`);
    timeline.addLabel("hinge_swing", `latch_release+=${durationFor(0.24)}`);
    timeline.to(state, { swing: profile.swing, duration: durationFor(1.36), ease: "power3.inOut" }, "hinge_swing");
    timeline.to(state, { interior: profile.interior, light: profile.interior, duration: durationFor(0.96), ease: "sine.out" }, `hinge_swing+=${durationFor(0.1)}`);
    timeline.addLabel("step_inside", `hinge_swing+=${durationFor(0.46)}`);
    timeline.to(state, { camera: profile.camera, duration: durationFor(0.9), ease: "power2.inOut" }, "step_inside");
    // Hold the fully open threshold for a beat. At handoff the final room
    // texture replaces the threshold in this same Pixi scene; the DOM Room
    // remains inert until the transition has fully completed.
    timeline.addLabel("handoff", `hinge_swing+=${durationFor(1.58)}`);
    timeline.to(state, { exit: 1, duration: durationFor(0.26), ease: "power2.out" }, "handoff");

    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      host?.removeEventListener("door-capture-command", handleCaptureCommand);
      scene.app.stop();
      timeline.kill();
    };
  }, { scope: scopeRef, dependencies: [finishTransition, motionMode, sceneReady], revertOnUpdate: true });

  return (
    <div
      ref={scopeRef}
      className="desktop-door-transition"
      data-transition-engine="pixijs-gsap"
      data-transition-theme={theme}
      data-door-motion-mode={motionMode}
      data-door-resource-state="loading"
      aria-hidden="true"
    />
  );
}
