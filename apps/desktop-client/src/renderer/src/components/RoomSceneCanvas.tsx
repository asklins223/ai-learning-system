import { useEffect, useRef, useState } from "react";
import type { RoomSceneLayerManifestEntry } from "../media/learning-room-manifest";
import type { SceneMotionMode, SceneMotionPhase } from "../scene/scene-motion";
import type { WindowState, ViewPresetId } from "../app/room-machine";
import { createScenePixiApplication, type ScenePixiApplication } from "../scene/scene-application-pixi";
import { isRoomSceneAnchorId, ROOM_SCENE_ANCHORS } from "../scene/scene-depth";
import { SCENE_PIXI_DEPTH_ORDER_SIGNATURE } from "../scene/scene-depth-pixi";
import { SCENE_WORLD } from "../scene/scene-geometry";
import { loadSceneImageTexture } from "../scene/scene-texture-loader";
import { sceneCameraPreset } from "../scene/scene-camera";
import { createRoomScenePosterNode } from "../scene/room-scene-renderer";
import {
  compareRoomSceneLayerEntries,
  serializeRoomSceneLayerIdentities,
  serializeRoomSceneLayerAudit,
  summarizeRoomSceneLayerAudit,
  type RoomSceneLayerAuditReason,
  type RoomSceneLayerAuditRecord,
  type RoomSceneLayerAuditStatus,
} from "../scene/room-scene-layer-audit";
import {
  ROOM_SCENE_LAYER_POLICY,
  createRoomSceneLayerNode,
  resolveRoomSceneLayerEligibility,
  resolveRoomSceneLayerRegistrationEligibility,
  resolveRoomSceneLayerUploadAlphaMode,
  type RoomSceneLayerSource,
} from "../scene/room-scene-layer-policy";

type RoomSceneCanvasLayer = Readonly<{
  readonly entry: RoomSceneLayerManifestEntry;
  readonly url: string;
}>;

const EMPTY_ROOM_SCENE_LAYERS: readonly RoomSceneCanvasLayer[] = [];

type RoomSceneCanvasProps = Readonly<{
  readonly assetUrl: string | null;
  readonly layers?: readonly RoomSceneCanvasLayer[];
  readonly motionMode: SceneMotionMode;
  readonly scenePhase: SceneMotionPhase;
  readonly viewPreset: ViewPresetId;
  readonly windowState: WindowState;
  readonly active: boolean;
  readonly onReady: (ready: boolean) => void;
}>;

type CanvasState = "fallback" | "loading" | "ready";
type CanvasReason =
  | "not-started"
  | "inactive"
  | "compact"
  | "motion-off"
  | "window-hidden"
  | "initializing"
  | "ready"
  | "context-lost"
  | "initialization-failed";

const COMPACT_MEDIA_QUERY = "(max-width: 900px), (max-height: 660px)";

type RoomSceneLayerLoadResult = Readonly<{
  readonly mounted: boolean;
  readonly audit: RoomSceneLayerAuditRecord;
}>;

function readFrameBounds(host: HTMLElement) {
  const bounds = host.getBoundingClientRect();
  if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) return null;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
}

function readViewport(host: HTMLElement, scene: ScenePixiApplication) {
  const width = host.clientWidth || scene.app.screen.width;
  const height = host.clientHeight || scene.app.screen.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export function RoomSceneCanvas({
  assetUrl,
  layers = EMPTY_ROOM_SCENE_LAYERS,
  motionMode,
  scenePhase,
  viewPreset,
  windowState,
  active,
  onReady,
}: RoomSceneCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(COMPACT_MEDIA_QUERY).matches
  ));
  const [state, setState] = useState<CanvasState>("fallback");
  const [reason, setReason] = useState<CanvasReason>("not-started");
  const [rendererName, setRendererName] = useState<string | null>(null);
  const [depthOrderValid, setDepthOrderValid] = useState(false);
  const [independentLayerCount, setIndependentLayerCount] = useState(0);
  const [layerAudit, setLayerAudit] = useState<readonly RoomSceneLayerAuditRecord[]>([]);
  const layerAuditSummary = summarizeRoomSceneLayerAudit(layerAudit);
  const orderedLayers = layers.length > 1
    ? [...layers].sort((left, right) => compareRoomSceneLayerEntries(left.entry, right.entry))
    : layers;

  onReadyRef.current = onReady;

  useEffect(() => {
    const query = window.matchMedia(COMPACT_MEDIA_QUERY);
    const syncCompact = () => setCompact(query.matches);
    syncCompact();
    query.addEventListener("change", syncCompact);
    return () => query.removeEventListener("change", syncCompact);
  }, []);

  const eligible = active
    && Boolean(assetUrl)
    && motionMode === "full"
    && scenePhase === "idle"
    && viewPreset === "room"
    && windowState === "visible"
    && !compact;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    let scene: ScenePixiApplication | null = null;
    let texture: import("pixi.js").Texture | null = null;
    const layerTextures: import("pixi.js").Texture[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let contextLost = false;
    const abortController = new AbortController();

    const releaseLayerTextures = (): void => {
      while (layerTextures.length > 0) {
        layerTextures.pop()?.destroy(false);
      }
    };

    const releasePosterTexture = (): void => {
      texture?.destroy(false);
      texture = null;
    };

    const releaseRuntime = (): void => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      scene?.destroy();
      scene = null;
      releaseLayerTextures();
      releasePosterTexture();
    };

    const block = (nextReason: CanvasReason) => {
      setState("fallback");
      setReason(nextReason);
      setRendererName(null);
      setDepthOrderValid(false);
      setIndependentLayerCount(0);
      setLayerAudit([]);
      onReadyRef.current(false);
    };

    if (!eligible || !assetUrl) {
      if (!active) block("inactive");
      else if (compact) block("compact");
      else if (motionMode === "off") block("motion-off");
      else if (windowState !== "visible") block("window-hidden");
      else block("inactive");
      return () => undefined;
    }

    setState("loading");
    setReason("initializing");
    setRendererName(null);
    setDepthOrderValid(false);
    setIndependentLayerCount(0);
    setLayerAudit([]);
    onReadyRef.current(false);

    const updateFrame = (): boolean => {
      if (cancelled || !scene) return false;
      try {
        scene.resize();
        const viewport = readViewport(host, scene);
        const frameBounds = readFrameBounds(host);
        if (!viewport || !frameBounds) return false;
        const accepted = scene.updateViewport({
          viewport,
          frameBounds,
          cameraPreset: sceneCameraPreset("room"),
        });
        setDepthOrderValid(accepted && scene.rendererHost.isDepthOrderIntact());
        return accepted;
      } catch {
        setDepthOrderValid(false);
        return false;
      }
    };

    const handleContextLost = () => {
      contextLost = true;
      abortController.abort();
      releaseRuntime();
      if (!cancelled) block("context-lost");
    };

    const sourceForLayer = (entry: RoomSceneLayerManifestEntry): RoomSceneLayerSource => ({
      assetId: entry.assetId,
      path: entry.path,
      sourceSize: entry.sourceSize,
      alphaMode: entry.alphaMode,
      reviewStatus: entry.reviewStatus,
      releaseApproval: entry.releaseApproval,
    });

    const makeLayerAudit = (
      layer: RoomSceneCanvasLayer,
      status: RoomSceneLayerAuditStatus,
      auditReason: RoomSceneLayerAuditReason,
    ): RoomSceneLayerAuditRecord => ({
      assetId: layer.entry.assetId,
      theme: layer.entry.theme,
      depth: layer.entry.depth,
      order: layer.entry.order,
      status,
      reason: auditReason,
    });

    const toAuditBlockReason = (
      policyReason: ReturnType<typeof resolveRoomSceneLayerEligibility>["reason"],
    ): RoomSceneLayerAuditReason => policyReason === "eligible" ? "runtime-failed" : policyReason;

    const releaseLayerNode = (node: import("pixi.js").Container | null): void => {
      if (!node || node.destroyed) return;
      try {
        node.destroy({ children: true });
      } catch {
        // A broken presentation node must not hide the layer audit result.
      }
    };

    const releaseLayerTexture = (layerTexture: import("pixi.js").Texture | null): void => {
      if (!layerTexture || layerTexture.destroyed) return;
      try {
        layerTexture.destroy(false);
      } catch {
        // Texture cleanup is best effort after a failed layer attempt.
      }
    };

    const loadAndMountLayer = async (layer: RoomSceneCanvasLayer): Promise<RoomSceneLayerLoadResult> => {
      if (layer.entry.anchorId !== null && !isRoomSceneAnchorId(layer.entry.anchorId)) {
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "blocked", "unsupported-anchor"),
        };
      }
      const registrationEligibility = resolveRoomSceneLayerRegistrationEligibility(
        layer.entry.registration,
      );
      if (!registrationEligibility.enabled) {
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "blocked", toAuditBlockReason(registrationEligibility.reason)),
        };
      }
      const source = sourceForLayer(layer.entry);
      const eligibility = resolveRoomSceneLayerEligibility(source);
      const uploadAlphaMode = resolveRoomSceneLayerUploadAlphaMode(source.alphaMode);
      if (!eligibility.enabled) {
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "blocked", toAuditBlockReason(eligibility.reason)),
        };
      }
      if (!uploadAlphaMode) {
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "blocked", "upload-mode-unavailable"),
        };
      }

      let layerTexture: import("pixi.js").Texture | null = null;
      let layerNode: import("pixi.js").Container | null = null;
      try {
        layerTexture = await loadSceneImageTexture(layer.url, abortController.signal, {
          alphaMode: uploadAlphaMode,
        });
      } catch {
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "failed", "texture-load-failed"),
        };
      }

      if (cancelled || contextLost || !scene) {
        releaseLayerTexture(layerTexture);
        const cancellationReason: RoomSceneLayerAuditReason = cancelled || contextLost
          ? "cancelled"
          : "runtime-failed";
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "failed", cancellationReason),
        };
      }

      try {
        if (!scene.rendererHost.ensureDepthOrder()) {
          releaseLayerTexture(layerTexture);
          return {
            mounted: false,
            audit: makeLayerAudit(layer, "failed", "node-mount-failed"),
          };
        }
        const result = createRoomSceneLayerNode({
          source,
          depth: layer.entry.depth,
          texture: layerTexture,
          node: {
            visible: true,
          },
          registration: layer.entry.registration,
        });
        layerNode = result.node;
        if (!layerNode) {
          releaseLayerTexture(layerTexture);
          return {
            mounted: false,
            audit: makeLayerAudit(layer, "blocked", toAuditBlockReason(result.eligibility.reason)),
          };
        }

        const mounted = scene.rendererHost.nodeRegistry.mount({
          id: source.assetId,
          depth: layer.entry.depth,
          order: layer.entry.order,
          anchorId: layer.entry.anchorId,
          node: layerNode,
        });
        if (!mounted) {
          releaseLayerNode(layerNode);
          releaseLayerTexture(layerTexture);
          return {
            mounted: false,
            audit: makeLayerAudit(layer, "failed", "node-mount-failed"),
          };
        }

        layerTextures.push(layerTexture);
        return {
          mounted: true,
          audit: makeLayerAudit(layer, "mounted", "mounted"),
        };
      } catch {
        releaseLayerNode(layerNode);
        releaseLayerTexture(layerTexture);
        return {
          mounted: false,
          audit: makeLayerAudit(layer, "failed", "runtime-failed"),
        };
      }
    };

    void (async () => {
      try {
        texture = await loadSceneImageTexture(assetUrl, abortController.signal);
        if (cancelled || contextLost) {
          releaseRuntime();
          return;
        }

        const pointerTarget = document.documentElement;
        scene = await createScenePixiApplication({
          host,
          registry: ROOM_SCENE_ANCHORS,
          label: "pixi-room-scene",
          preference: "webgl",
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          signal: abortController.signal,
          onContextLost: handleContextLost,
          pointerRuntime: pointerTarget ? {
            target: pointerTarget,
            enabled: true,
            getFrameBounds: () => readFrameBounds(host),
          } : undefined,
        });
        if (cancelled || contextLost) {
          releaseRuntime();
          return;
        }

        const poster = createRoomScenePosterNode(texture);
        if (!scene.rendererHost.ensureDepthOrder()) {
          poster.root.destroy({ children: true });
          throw new Error("Room scene depth order is unavailable.");
        }
        scene.rendererHost.depthLayers.D0.addChild(poster.root);
        const layerResults = await Promise.allSettled(orderedLayers.map(loadAndMountLayer));
        if (cancelled || contextLost || !scene) {
          releaseRuntime();
          return;
        }
        const resolvedLayerAudit = layerResults.map((result, index) => {
          if (result.status === "fulfilled") return result.value.audit;
          return makeLayerAudit(orderedLayers[index], "failed", "runtime-failed");
        });
        const mountedLayerCount = layerResults.filter(
          (result) => result.status === "fulfilled" && result.value.mounted,
        ).length;
        if (!updateFrame()) throw new Error("Room scene frame is unavailable.");

        resizeObserver = typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => { updateFrame(); });
        resizeObserver?.observe(host);

        if (cancelled) return;
        setState("ready");
        setReason("ready");
        setRendererName(scene.rendererName);
        setIndependentLayerCount(mountedLayerCount);
        setLayerAudit(resolvedLayerAudit);
        onReadyRef.current(true);
      } catch (error) {
        if (!cancelled && !contextLost) {
          abortController.abort();
          releaseRuntime();
          block(error instanceof Error && error.name === "AbortError" ? "inactive" : "initialization-failed");
        }
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
      releaseRuntime();
      onReadyRef.current(false);
    };
  }, [active, assetUrl, compact, eligible, layers, motionMode, scenePhase, viewPreset, windowState]);

  return (
    <div
      ref={hostRef}
      className="room-pixi-canvas"
      data-scene-renderer="pixi-room-scene"
      data-scene-renderer-state={state}
      data-scene-renderer-reason={reason}
      data-scene-renderer-name={rendererName ?? undefined}
      data-scene-renderer-depth-order={SCENE_PIXI_DEPTH_ORDER_SIGNATURE}
      data-scene-renderer-depth-order-valid={depthOrderValid ? "true" : "false"}
      data-scene-renderer-active={state === "ready" && eligible ? "true" : "false"}
      data-scene-renderer-phase={scenePhase}
      data-scene-renderer-world={`${SCENE_WORLD.width}x${SCENE_WORLD.height}`}
      data-scene-renderer-layer-policy={ROOM_SCENE_LAYER_POLICY}
      data-scene-renderer-independent-layers={String(independentLayerCount)}
      data-scene-renderer-layer-candidates={String(layerAuditSummary.candidates)}
      data-scene-renderer-layer-blocked={String(layerAuditSummary.blocked)}
      data-scene-renderer-layer-failed={String(layerAuditSummary.failed)}
      data-scene-renderer-layer-identities={serializeRoomSceneLayerIdentities(orderedLayers.map(({ entry }) => entry))}
      data-scene-renderer-layer-audit={serializeRoomSceneLayerAudit(layerAudit)}
      aria-hidden="true"
    />
  );
}
