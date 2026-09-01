import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  isConvexSceneQuad,
  sceneQuadArea,
  SCENE_WORLD,
  type ScenePoint,
  type SceneQuad,
} from "./scene-geometry";
import { clientPointToReferenceWorld, projectSurfacePoint } from "./scene-input";
import {
  clearStoredSurfaceCalibration,
  createSurfaceCalibrationArtifact,
  getSessionSurfaceCalibrationStorage,
  readStoredSurfaceCalibration,
  serializeSurfaceCalibrationArtifact,
  surfaceCalibrationStorageKey,
  writeStoredSurfaceCalibration,
  type SurfaceCalibrationMode,
  type SurfaceCalibrationStorage,
  type SurfaceQuadMap,
} from "./scene-calibration";
import {
  type SceneSurfaceRegistryMetadata,
  type SceneSurfaceRegistration,
} from "./scene-surfaces";

export type SurfaceCalibrationTheme = "day" | "night";
export type SurfaceCalibrationRenderer = "poster" | "canvas";
export type SurfaceCalibrationMotion = "full" | "off";

type SurfaceCalibratorProps = {
  readonly referenceFrameRef: RefObject<HTMLDivElement | null>;
  readonly registry: SceneSurfaceRegistryMetadata;
  readonly surfaces: readonly SceneSurfaceRegistration[];
  readonly theme: SurfaceCalibrationTheme;
  readonly onThemeChange: (theme: SurfaceCalibrationTheme) => void;
  readonly onQuadOverridesChange: (overrides: SurfaceQuadMap | undefined) => void;
  readonly storage?: SurfaceCalibrationStorage;
};

type CalibrationLayers = {
  readonly base: boolean;
  readonly ink: boolean;
  readonly material: boolean;
  readonly occluder: boolean;
};

const DEFAULT_LAYERS: CalibrationLayers = Object.freeze({
  base: true,
  ink: true,
  material: true,
  occluder: true,
});

function copyQuad(quad: SceneQuad): SceneQuad {
  return quad.map(([x, y]) => [x, y] as ScenePoint) as unknown as SceneQuad;
}

function createQuadMap(surfaces: readonly SceneSurfaceRegistration[]): SurfaceQuadMap {
  return Object.fromEntries(surfaces.map((surface) => [surface.id, copyQuad(surface.quad)]));
}

function replaceCorner(quad: SceneQuad, cornerIndex: number, point: ScenePoint): SceneQuad {
  return quad.map((corner, index) => (
    index === cornerIndex ? point : corner
  )) as unknown as SceneQuad;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function quadIssues(quad: SceneQuad): readonly string[] {
  const issues: string[] = [];
  if (!isConvexSceneQuad(quad)) issues.push("四角顺序错误、自交或已经塌缩");
  if (sceneQuadArea(quad) < 16) issues.push("面积小于 16 个世界像素");
  if (quad.some(([x, y]) => x < 0 || x > SCENE_WORLD.width || y < 0 || y > SCENE_WORLD.height)) {
    issues.push("存在超出 1672×941 世界边界的角点");
  }
  return issues;
}

function polygonPoints(quad: readonly ScenePoint[]): string {
  return quad.map(([x, y]) => `${x},${y}`).join(" ");
}

function projectedClipPolygon(surface: SceneSurfaceRegistration, quad: SceneQuad): readonly ScenePoint[] {
  return surface.clipPolygon.flatMap((point) => {
    const projected = projectSurfacePoint(surface, point, quad);
    return projected ? [projected] : [];
  });
}

export function SurfaceCalibrator({
  referenceFrameRef,
  registry,
  surfaces,
  theme,
  onThemeChange,
  onQuadOverridesChange,
  storage,
}: SurfaceCalibratorProps) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [selectedSurfaceId, setSelectedSurfaceId] = useState(surfaces[0]?.id ?? "");
  const [selectedCorner, setSelectedCorner] = useState<number | null>(null);
  const [draftQuads, setDraftQuads] = useState<SurfaceQuadMap>(() => createQuadMap(surfaces));
  const [layers, setLayers] = useState<CalibrationLayers>(DEFAULT_LAYERS);
  const [renderer, setRenderer] = useState<SurfaceCalibrationRenderer>("poster");
  const [motion, setMotion] = useState<SurfaceCalibrationMotion>("full");
  const [copyStatus, setCopyStatus] = useState("");
  const [committedQuads, setCommittedQuads] = useState<SurfaceQuadMap | undefined>();
  const [hasStoredCalibration, setHasStoredCalibration] = useState(false);
  const calibrationStorage = useMemo(() => storage ?? getSessionSurfaceCalibrationStorage(), [storage]);
  const calibrationStorageKey = useMemo(
    () => surfaceCalibrationStorageKey(registry, surfaces),
    [registry, surfaces],
  );

  const selectedSurface = surfaces.find((surface) => surface.id === selectedSurfaceId) ?? surfaces[0];
  const selectedQuad = selectedSurface
    ? draftQuads[selectedSurface.id] ?? selectedSurface.quad
    : null;
  const allIssues = useMemo(() => surfaces.flatMap((surface) => (
    quadIssues(draftQuads[surface.id] ?? surface.quad).map((issue) => `${surface.id}: ${issue}`)
  )), [draftQuads, surfaces]);
  const selectedIssues = selectedQuad ? quadIssues(selectedQuad) : [];

  useEffect(() => {
    const mediaQuery = window.matchMedia(registry.compactMediaQuery);
    const updateCompact = () => setCompact(mediaQuery.matches);
    updateCompact();
    mediaQuery.addEventListener("change", updateCompact);
    return () => mediaQuery.removeEventListener("change", updateCompact);
  }, [registry.compactMediaQuery]);

  useEffect(() => {
    if (compact) setOpen(false);
  }, [compact]);

  useEffect(() => {
    const stored = readStoredSurfaceCalibration(calibrationStorage, calibrationStorageKey, registry, surfaces);
    setHasStoredCalibration(stored.status !== "missing" && stored.status !== "unavailable");
    if (stored.status === "valid" && stored.overrides) {
      setDraftQuads(stored.overrides);
      setCommittedQuads(stored.overrides);
      setCopyStatus("已载入当前开发会话的有效校准；预览模式不会自动切换。");
      return;
    }
    setCommittedQuads(undefined);
    setDraftQuads(createQuadMap(surfaces));
    if (stored.status === "stale" || stored.status === "invalid") {
      setCopyStatus(`已忽略已保存校准：${stored.message}`);
    }
  }, [calibrationStorage, calibrationStorageKey, registry, surfaces]);

  useEffect(() => {
    onQuadOverridesChange(open ? draftQuads : committedQuads);
  }, [committedQuads, draftQuads, onQuadOverridesChange, open]);

  useEffect(() => {
    const toggleCalibrator = (event: globalThis.KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.code === "KeyC") {
        event.preventDefault();
        if (!compact) setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", toggleCalibrator);
    return () => window.removeEventListener("keydown", toggleCalibrator);
  }, [compact]);

  useEffect(() => {
    const frame = referenceFrameRef.current;
    const documentRoot = document.documentElement;
    if (open && frame) {
      frame.dataset.surfaceCalibration = "true";
      frame.dataset.surfaceCalibrationTheme = theme;
      frame.dataset.surfaceCalibrationRenderer = renderer;
      frame.dataset.surfaceCalibrationMotion = motion;
      frame.dataset.surfaceCalibrationInk = String(layers.ink);
      frame.dataset.surfaceCalibrationMaterial = String(layers.material);
      frame.dataset.surfaceCalibrationOccluder = String(layers.occluder);
      documentRoot.dataset.surfaceCalibrationBase = String(layers.base);
      documentRoot.dataset.surfaceCalibrationTheme = theme;
      documentRoot.dataset.surfaceCalibrationRenderer = renderer;
      documentRoot.dataset.surfaceCalibrationMotion = motion;
    }

    return () => {
      if (frame) {
        delete frame.dataset.surfaceCalibration;
        delete frame.dataset.surfaceCalibrationTheme;
        delete frame.dataset.surfaceCalibrationRenderer;
        delete frame.dataset.surfaceCalibrationMotion;
        delete frame.dataset.surfaceCalibrationInk;
        delete frame.dataset.surfaceCalibrationMaterial;
        delete frame.dataset.surfaceCalibrationOccluder;
      }
      delete documentRoot.dataset.surfaceCalibrationBase;
      delete documentRoot.dataset.surfaceCalibrationTheme;
      delete documentRoot.dataset.surfaceCalibrationRenderer;
      delete documentRoot.dataset.surfaceCalibrationMotion;
    };
  }, [layers, motion, open, referenceFrameRef, renderer, theme]);

  const commitCorner = useCallback((surfaceId: string, cornerIndex: number, point: ScenePoint) => {
    setDraftQuads((current) => ({
      ...current,
      [surfaceId]: replaceCorner(
        current[surfaceId] ?? surfaces.find((surface) => surface.id === surfaceId)?.quad ?? [[0, 0], [1, 0], [1, 1], [0, 1]],
        cornerIndex,
        point,
      ),
    }));
    setCopyStatus("");
  }, [surfaces]);

  const worldPointFromPointer = useCallback((event: PointerEvent<HTMLButtonElement>): ScenePoint | null => {
    const frame = referenceFrameRef.current;
    if (!frame) return null;
    const bounds = frame.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const worldPoint = clientPointToReferenceWorld([event.clientX, event.clientY], bounds);
    if (!worldPoint) return null;
    return [
      rounded(clamp(worldPoint[0], 0, SCENE_WORLD.width)),
      rounded(clamp(worldPoint[1], 0, SCENE_WORLD.height)),
    ];
  }, [referenceFrameRef]);

  const movePointerCorner = useCallback((event: PointerEvent<HTMLButtonElement>, cornerIndex: number) => {
    if (!selectedSurface) return;
    const point = worldPointFromPointer(event);
    if (point) commitCorner(selectedSurface.id, cornerIndex, point);
  }, [commitCorner, selectedSurface, worldPointFromPointer]);

  const nudgeCorner = useCallback((event: KeyboardEvent<HTMLButtonElement>, cornerIndex: number) => {
    if (!selectedSurface || !selectedQuad) return;
    const directions: Partial<Record<string, ScenePoint>> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const [x, y] = selectedQuad[cornerIndex];
    commitCorner(selectedSurface.id, cornerIndex, [
      rounded(clamp(x + direction[0] * step, 0, SCENE_WORLD.width)),
      rounded(clamp(y + direction[1] * step, 0, SCENE_WORLD.height)),
    ]);
  }, [commitCorner, selectedQuad, selectedSurface]);

  const resetSelected = () => {
    if (!selectedSurface) return;
    setDraftQuads((current) => ({ ...current, [selectedSurface.id]: copyQuad(selectedSurface.quad) }));
    setCopyStatus("当前 Surface 已恢复登记值");
  };

  const resetAll = () => {
    setDraftQuads(createQuadMap(surfaces));
    setCopyStatus("全部 Surface 已恢复登记值");
  };

  const copyJson = async () => {
    if (allIssues.length) return;
    try {
      const artifact = createSurfaceCalibrationArtifact(registry, surfaces, draftQuads, { theme, renderer, motion });
      await navigator.clipboard.writeText(serializeSurfaceCalibrationArtifact(artifact));
      setCopyStatus("稳定排序的校准 JSON 已复制");
    } catch {
      setCopyStatus("复制失败，请检查开发环境的剪贴板权限");
    }
  };

  const applyCalibration = () => {
    if (allIssues.length) return;
    const artifact = createSurfaceCalibrationArtifact(registry, surfaces, draftQuads, { theme, renderer, motion });
    const result = writeStoredSurfaceCalibration(calibrationStorage, calibrationStorageKey, artifact);
    setCommittedQuads(draftQuads);
    setHasStoredCalibration(result.status === "written");
    setCopyStatus(result.message);
  };

  const clearSavedCalibration = () => {
    const result = clearStoredSurfaceCalibration(calibrationStorage, calibrationStorageKey);
    if (result.status === "written") {
      setCommittedQuads(undefined);
      setDraftQuads(createQuadMap(surfaces));
      setHasStoredCalibration(false);
    }
    setCopyStatus(result.message);
  };

  if (compact) {
    return (
      <button
        type="button"
        className="surface-calibrator__launcher"
        disabled
        title="Surface 校准只在桌面世界坐标视图中启用"
      >
        校准器需桌面视图
      </button>
    );
  }

  if (!open || !selectedSurface || !selectedQuad) {
    return (
      <button
        type="button"
        className="surface-calibrator__launcher"
        onClick={() => setOpen(true)}
        title="打开 Surface 四角校准器（Option/Alt + Shift + C）"
      >
        校准 Surface
      </button>
    );
  }

  const clipPolygon = projectedClipPolygon(selectedSurface, selectedQuad);
  const centerLine = [
    projectSurfacePoint(selectedSurface, [0.5, 0], selectedQuad),
    projectSurfacePoint(selectedSurface, [0.5, 1], selectedQuad),
  ].filter((point): point is ScenePoint => Boolean(point));
  const baselineV = selectedSurface.contentInsets.top
    + (1 - selectedSurface.contentInsets.top - selectedSurface.contentInsets.bottom) * 0.28;
  const baseline = [
    projectSurfacePoint(selectedSurface, [selectedSurface.contentInsets.left, baselineV], selectedQuad),
    projectSurfacePoint(selectedSurface, [1 - selectedSurface.contentInsets.right, baselineV], selectedQuad),
  ].filter((point): point is ScenePoint => Boolean(point));

  return (
    <div
      className="surface-calibrator"
      data-selected-surface={selectedSurface.id}
      data-calibration-theme={theme}
      data-calibration-renderer={renderer}
      data-calibration-motion={motion}
    >
      <svg
        className="surface-calibrator__geometry"
        viewBox={`0 0 ${SCENE_WORLD.width} ${SCENE_WORLD.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {surfaces.map((surface) => (
          <polygon
            key={surface.id}
            className={surface.id === selectedSurface.id
              ? "surface-calibrator__quad surface-calibrator__quad--selected"
              : "surface-calibrator__quad"}
            points={polygonPoints(draftQuads[surface.id] ?? surface.quad)}
          />
        ))}
        {clipPolygon.length === 4 ? <polygon className="surface-calibrator__clip" points={polygonPoints(clipPolygon)} /> : null}
        {centerLine.length === 2 ? <polyline className="surface-calibrator__centerline" points={polygonPoints(centerLine)} /> : null}
        {baseline.length === 2 ? <polyline className="surface-calibrator__baseline" points={polygonPoints(baseline)} /> : null}
      </svg>

      {selectedQuad.map(([x, y], cornerIndex) => (
        <button
          key={`${selectedSurface.id}-${cornerIndex}`}
          type="button"
          className={`surface-calibrator__handle${selectedCorner === cornerIndex ? " surface-calibrator__handle--active" : ""}`}
          style={{
            left: `${(x / SCENE_WORLD.width) * 100}%`,
            top: `${(y / SCENE_WORLD.height) * 100}%`,
          } as CSSProperties}
          aria-label={`${selectedSurface.id} 的 P${cornerIndex}，世界坐标 ${rounded(x)}, ${rounded(y)}`}
          onFocus={() => setSelectedCorner(cornerIndex)}
          onBlur={() => setSelectedCorner(null)}
          onKeyDown={(event) => nudgeCorner(event, cornerIndex)}
          onPointerDown={(event) => {
            event.preventDefault();
            setSelectedCorner(cornerIndex);
            event.currentTarget.setPointerCapture(event.pointerId);
            movePointerCorner(event, cornerIndex);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) movePointerCorner(event, cornerIndex);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          P{cornerIndex}
        </button>
      ))}

      <aside className="surface-calibrator__panel" aria-label="Surface 四角校准器">
        <header className="surface-calibrator__panel-header">
          <div>
            <strong>Surface 校准</strong>
            <span>{SCENE_WORLD.width} × {SCENE_WORLD.height} 世界坐标</span>
          </div>
          <button type="button" onClick={() => setOpen(false)}>关闭</button>
        </header>

        <label className="surface-calibrator__field">
          <span>当前表面</span>
          <select
            value={selectedSurface.id}
            onChange={(event) => {
              setSelectedSurfaceId(event.target.value);
              setSelectedCorner(null);
              setCopyStatus("");
            }}
          >
            {surfaces.map((surface) => <option key={surface.id} value={surface.id}>{surface.id}</option>)}
          </select>
        </label>

        <fieldset className="surface-calibrator__modes">
          <legend>校准预览</legend>
          <label>
            <span>主题</span>
            <select
              aria-label="校准主题"
              value={theme}
              onChange={(event) => onThemeChange(event.target.value === "night" ? "night" : "day")}
            >
              <option value="day">Day 日间</option>
              <option value="night">Night 夜间</option>
            </select>
          </label>
          <label>
            <span>渲染目标</span>
            <select
              aria-label="校准渲染目标"
              value={renderer}
              onChange={(event) => setRenderer(event.target.value === "canvas" ? "canvas" : "poster")}
            >
              <option value="poster">Poster 背板</option>
              <option value="canvas">Canvas 目标</option>
            </select>
          </label>
          <label>
            <span>动效</span>
            <select
              aria-label="校准动效模式"
              value={motion}
              onChange={(event) => setMotion(event.target.value === "off" ? "off" : "full")}
            >
              <option value="full">Full 完整</option>
              <option value="off">Off 静态</option>
            </select>
          </label>
        </fieldset>

        <p className="surface-calibrator__mode-note" role="status">
          {renderer === "canvas"
            ? "Canvas 目标已登记；当前运行时仍以 poster 作为稳定预览。"
            : "Poster 背板是当前运行时的稳定预览。"}
          {motion === "off" ? " 已关闭校准范围内的过渡与循环动效。" : ""}
        </p>

        <fieldset className="surface-calibrator__layers">
          <legend>合成层</legend>
          {(Object.keys(DEFAULT_LAYERS) as (keyof CalibrationLayers)[]).map((layer) => {
            const labels: Record<keyof CalibrationLayers, string> = {
              base: "底图",
              ink: "油墨",
              material: "材质",
              occluder: "遮挡",
            };
            return (
              <label key={layer}>
                <input
                  type="checkbox"
                  checked={layers[layer]}
                  onChange={(event) => setLayers((current) => ({ ...current, [layer]: event.target.checked }))}
                />
                <span>{labels[layer]}</span>
              </label>
            );
          })}
        </fieldset>

        <div className="surface-calibrator__coordinates" aria-label="当前四角世界坐标">
          {selectedQuad.map(([x, y], cornerIndex) => (
            <p key={cornerIndex} data-active={selectedCorner === cornerIndex ? "true" : undefined}>
              <strong>P{cornerIndex}</strong>
              <span>X {rounded(x)}</span>
              <span>Y {rounded(y)}</span>
            </p>
          ))}
        </div>

        <p className={`surface-calibrator__validation${selectedIssues.length ? " surface-calibrator__validation--error" : ""}`} role="status">
          {selectedIssues.length
            ? selectedIssues.join("；")
            : "四角有效。拖拽角点，方向键微调 1px，Shift + 方向键微调 10px。"}
        </p>

        <div className="surface-calibrator__actions">
          <button type="button" onClick={resetSelected}>恢复当前</button>
          <button type="button" onClick={resetAll}>恢复全部</button>
          <button type="button" className="surface-calibrator__apply" onClick={applyCalibration} disabled={allIssues.length > 0}>
            应用并记住
          </button>
          <button type="button" onClick={clearSavedCalibration} disabled={!hasStoredCalibration}>
            清除已保存
          </button>
          <button type="button" className="surface-calibrator__copy" onClick={() => void copyJson()} disabled={allIssues.length > 0}>
            复制 JSON
          </button>
        </div>
        {copyStatus ? <p className="surface-calibrator__copy-status" role="status">{copyStatus}</p> : null}
      </aside>
    </div>
  );
}
