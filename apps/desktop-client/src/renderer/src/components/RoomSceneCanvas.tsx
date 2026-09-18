import { useEffect, useRef, useState } from "react";
import { TilingSprite } from "pixi.js";
import type { RoomSceneLayerManifestEntry } from "../media/learning-room-manifest";
import type { SceneMotionPhase } from "../scene/scene-motion";
import type { ViewPresetId } from "../app/room-machine";
import { createScenePixiApplication, type ScenePixiApplication } from "../scene/scene-application-pixi";
import {
  isRoomSceneAnchorId,
  ROOM_SCENE_ANCHORS,
  type SceneDepthBandId,
} from "../scene/scene-depth";
import { SCENE_PIXI_DEPTH_ORDER_SIGNATURE } from "../scene/scene-depth-pixi";
import { SCENE_WORLD } from "../scene/scene-geometry";
import { loadSceneImageTexture } from "../scene/scene-texture-loader";
import { sceneCameraPreset } from "../scene/scene-camera";
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
import {
  createHomeAmbientPixiRuntime,
  type HomeAmbientPixiRuntime,
} from "./home-v2/home-ambient-pixi";
import type { HomeAmbientContextV1 } from "./home-v2/home-ambient-director";
import type {
  HomeSceneProfileV1,
  HomeSceneRegionId,
} from "./home-v2/home-scene-profile";

type RoomSceneCanvasLayer = Readonly<{
  readonly entry: RoomSceneLayerManifestEntry;
  readonly url: string;
}>;

const EMPTY_ROOM_SCENE_LAYERS: readonly RoomSceneCanvasLayer[] = [];
const EMPTY_REQUIRED_LAYER_DEPTHS: readonly SceneDepthBandId[] = [];

type RoomSceneCanvasProps = Readonly<{
  readonly baseLayer: RoomSceneCanvasLayer | null;
  readonly layers?: readonly RoomSceneCanvasLayer[];
  readonly requiredLayerDepths?: readonly SceneDepthBandId[];
  readonly scenePhase: SceneMotionPhase;
  readonly viewPreset: ViewPresetId;
  readonly active: boolean;
  readonly onReady: (ready: boolean) => void;
  readonly homeSceneProfile?: HomeSceneProfileV1;
  readonly ambientContext?: HomeAmbientContextV1;
}>;

type CanvasState = "fallback" | "loading" | "ready";
type CanvasReason =
  | "not-started"
  | "inactive"
  | "compact"
  | "initializing"
  | "ready"
  | "context-lost"
  | "initialization-failed";

const COMPACT_MEDIA_QUERY = "(max-width: 720px), (max-height: 480px)";

type RoomSceneLayerLoadResult = Readonly<{
  readonly mounted: boolean;
  readonly audit: RoomSceneLayerAuditRecord;
}>;

export function hasExactRoomSceneLayerDepths(
  layers: readonly Readonly<{ readonly depth: SceneDepthBandId }>[] | null | undefined,
  requiredDepths: readonly SceneDepthBandId[] | null | undefined,
): boolean {
  if (!requiredDepths?.length) return true;
  if (!layers) return false;
  const actualDepths = layers.map((layer) => layer.depth);
  return requiredDepths.every((depth) => actualDepths.includes(depth))
    && actualDepths.every((depth) => requiredDepths.includes(depth));
}

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
  baseLayer,
  layers = EMPTY_ROOM_SCENE_LAYERS,
  requiredLayerDepths = EMPTY_REQUIRED_LAYER_DEPTHS,
  scenePhase,
  viewPreset,
  active,
  onReady,
  homeSceneProfile,
  ambientContext,
}: RoomSceneCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const ambientRuntimeRef = useRef<HomeAmbientPixiRuntime | null>(null);
  const ambientContextRef = useRef(ambientContext);
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(COMPACT_MEDIA_QUERY).matches
  ));
  const [state, setState] = useState<CanvasState>("fallback");
  const [reason, setReason] = useState<CanvasReason>("not-started");
  const [rendererName, setRendererName] = useState<string | null>(null);
  const [depthOrderValid, setDepthOrderValid] = useState(false);
  const [independentLayerCount, setIndependentLayerCount] = useState(0);
  const [baseLayerAudit, setBaseLayerAudit] = useState<RoomSceneLayerAuditRecord | null>(null);
  const [layerAudit, setLayerAudit] = useState<readonly RoomSceneLayerAuditRecord[]>([]);
  const layerAuditSummary = summarizeRoomSceneLayerAudit(layerAudit);
  const orderedLayers = layers.length > 1
    ? [...layers].sort((left, right) => compareRoomSceneLayerEntries(left.entry, right.entry))
    : layers;

  onReadyRef.current = onReady;
  ambientContextRef.current = ambientContext;

  useEffect(() => {
    if (ambientContext) ambientRuntimeRef.current?.setContext(ambientContext);
  }, [ambientContext]);

  useEffect(() => {
    const onCue = (event: Event) => {
      const detail = (event as CustomEvent<{ region?: HomeSceneRegionId; cueId?: string }>).detail;
      if (!detail?.region || !detail.cueId) return;
      ambientRuntimeRef.current?.trigger(detail.region, detail.cueId);
    };
    window.addEventListener("ailearn:home-v2-ambient-cue", onCue);
    return () => window.removeEventListener("ailearn:home-v2-ambient-cue", onCue);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(COMPACT_MEDIA_QUERY);
    const syncCompact = () => setCompact(query.matches);
    syncCompact();
    query.addEventListener("change", syncCompact);
    return () => query.removeEventListener("change", syncCompact);
  }, []);

  const eligible = active
    && Boolean(baseLayer)
    && scenePhase === "idle"
    && viewPreset === "room"
    && !compact;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    let scene: ScenePixiApplication | null = null;
    let ambientRuntime: HomeAmbientPixiRuntime | null = null;
    const layerTextures: import("pixi.js").Texture[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let contextLost = false;
    const abortController = new AbortController();

    const releaseLayerTextures = (): void => {
      while (layerTextures.length > 0) {
        layerTextures.pop()?.destroy(true);
      }
    };

    const releaseRuntime = (): void => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      ambientRuntime?.destroy();
      if (ambientRuntimeRef.current === ambientRuntime) ambientRuntimeRef.current = null;
      ambientRuntime = null;
      scene?.destroy();
      scene = null;
      releaseLayerTextures();
    };

    const block = (nextReason: CanvasReason) => {
      setState("fallback");
      setReason(nextReason);
      setRendererName(null);
      setDepthOrderValid(false);
      setIndependentLayerCount(0);
      setBaseLayerAudit(null);
      setLayerAudit([]);
      onReadyRef.current(false);
    };

    if (!eligible || !baseLayer) {
      if (!active) block("inactive");
      else if (compact) block("compact");
      else block("inactive");
      return () => undefined;
    }

    setState("loading");
    setReason("initializing");
    setRendererName(null);
    setDepthOrderValid(false);
    setIndependentLayerCount(0);
    setBaseLayerAudit(null);
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
      releaseRuntime();
      abortController.abort();
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
        layerTexture.destroy(true);
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
      const eligibility = resolveRoomSceneLayerEligibility(source, {
        allowOpaque: layer.entry.depth === "D0",
      });
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
        const cue = homeSceneProfile
          ? Object.values(homeSceneProfile.ambientCues).flat().find((candidate) => (
              candidate.assetId === source.assetId
              || Boolean(candidate.assetId && source.assetId.startsWith(`${candidate.assetId}-`))
            ))
          : null;
        const result = createRoomSceneLayerNode({
          source,
          depth: layer.entry.depth,
          texture: layerTexture,
          node: { visible: true },
          registration: layer.entry.registration,
        });
        layerNode = result.node;
        if (layerNode && cue?.kind === "drift-x") {
          layerNode.destroy({ children: true });
          const tile = new TilingSprite({
            texture: layerTexture,
            width: layer.entry.registration.size.width,
            height: layer.entry.registration.size.height,
          });
          tile.label = `home-ambient:${cue.id}`;
          tile.anchor.set(layer.entry.registration.anchor[0], layer.entry.registration.anchor[1]);
          tile.position.set(layer.entry.registration.position[0], layer.entry.registration.position[1]);
          tile.alpha = 0.065;
          tile.eventMode = "none";
          tile.interactiveChildren = false;
          layerNode = tile;
        }
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
        scene = await createScenePixiApplication({
          host,
          registry: ROOM_SCENE_ANCHORS,
          label: "pixi-room-scene",
          preference: "webgl",
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          signal: abortController.signal,
          onContextLost: handleContextLost,
        });
        if (cancelled || contextLost) {
          releaseRuntime();
          return;
        }

        if (baseLayer.entry.depth !== "D0") {
          throw new Error("The Room scene base layer must be registered at D0.");
        }
        if (!hasExactRoomSceneLayerDepths(
          orderedLayers.map(({ entry }) => entry),
          requiredLayerDepths,
        )) {
          throw new Error("The required Home V2 layer depths are incomplete or unexpected.");
        }

        const [baseResult, ...layerResults] = await Promise.allSettled([
          loadAndMountLayer(baseLayer),
          ...orderedLayers.map(loadAndMountLayer),
        ]);
        if (cancelled || contextLost || !scene) {
          releaseRuntime();
          return;
        }
        const resolvedBaseAudit = baseResult.status === "fulfilled"
          ? baseResult.value.audit
          : makeLayerAudit(baseLayer, "failed", "runtime-failed");
        const baseMounted = baseResult.status === "fulfilled" && baseResult.value.mounted;
        if (!baseMounted) {
          throw new Error("The required Home V2 D0 base layer is unavailable.");
        }
        const resolvedLayerAudit = layerResults.map((result, index) => {
          if (result.status === "fulfilled") return result.value.audit;
          return makeLayerAudit(orderedLayers[index], "failed", "runtime-failed");
        });
        const mountedLayerCount = layerResults.filter(
          (result) => result.status === "fulfilled" && result.value.mounted,
        ).length;
        const mountedDepths = new Set(layerResults.flatMap((result, index) => (
          result.status === "fulfilled" && result.value.mounted
            ? [orderedLayers[index].entry.depth]
            : []
        )));
        if (!requiredLayerDepths.every((depth) => mountedDepths.has(depth))) {
          throw new Error("The required Home V2 layer pack is incomplete.");
        }
        if (!updateFrame()) throw new Error("Room scene frame is unavailable.");

        if (homeSceneProfile) {
          ambientRuntime = createHomeAmbientPixiRuntime({
            app: scene.app,
            nodeRegistry: scene.rendererHost.nodeRegistry,
            d4: scene.rendererHost.depthLayers.D4,
            profile: homeSceneProfile,
          });
          ambientRuntimeRef.current = ambientRuntime;
          if (ambientContextRef.current) ambientRuntime.setContext(ambientContextRef.current);
        }

        resizeObserver = typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => { updateFrame(); });
        resizeObserver?.observe(host);

        if (cancelled) return;
        setState("ready");
        setReason("ready");
        setRendererName(scene.rendererName);
        setIndependentLayerCount(mountedLayerCount);
        setBaseLayerAudit(resolvedBaseAudit);
        setLayerAudit(resolvedLayerAudit);
        onReadyRef.current(true);
      } catch (error) {
        if (!cancelled && !contextLost) {
          releaseRuntime();
          abortController.abort();
          block(error instanceof Error && error.name === "AbortError" ? "inactive" : "initialization-failed");
        }
      }
    })();

    return () => {
      cancelled = true;
      releaseRuntime();
      abortController.abort();
      onReadyRef.current(false);
    };
  }, [active, baseLayer, compact, eligible, homeSceneProfile, layers, requiredLayerDepths, scenePhase, viewPreset]);

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
      data-home-scene-profile={homeSceneProfile?.id}
      data-scene-renderer-base-identity={serializeRoomSceneLayerIdentities(baseLayer ? [baseLayer.entry] : [])}
      data-scene-renderer-base-audit={serializeRoomSceneLayerAudit(baseLayerAudit ? [baseLayerAudit] : [])}
      data-scene-renderer-layer-identities={serializeRoomSceneLayerIdentities(orderedLayers.map(({ entry }) => entry))}
      data-scene-renderer-layer-audit={serializeRoomSceneLayerAudit(layerAudit)}
      aria-hidden="true"
    />
  );
}
