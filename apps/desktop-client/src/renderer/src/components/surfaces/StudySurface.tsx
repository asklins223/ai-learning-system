import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpenText, RotateCcw, Sparkles } from "lucide-react";
import type { RoomPrimaryActionV1, RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import { useRoomStore } from "../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { SurfaceReturnControl } from "./SurfaceReturnControl";
import {
  roomActionReasonLabel,
  studyActionDescription,
  studyActionLabel,
  studyStatusLabel,
} from "./room-primary-action-presentation";
import { learningRunOriginForRoomAction } from "./study-run-origin";
import { StudyNotebookCanvas } from "../StudyNotebookCanvas";
import { mediaAssetUrl, useLearningRoomManifest } from "../../media/learning-room-manifest";
import { SceneReferenceFrame } from "../../scene/SceneReferenceFrame";
import { SurfaceCalibrator } from "../../scene/SurfaceCalibrator";
import {
  STUDY_NOTEBOOK_STYLE,
  STUDY_SURFACE_REGISTRY,
  STUDY_SURFACE_STYLES,
} from "../../scene/scene-surfaces";
import {
  useSceneSurfaceProjections,
  type SceneSurfaceProjectionTarget,
  type SceneSurfaceQuadOverrides,
} from "../../scene/useSceneSurfaceProjection";
import {
  useSceneSurfaceInputRuntime,
  writeSceneInputDiagnostics,
  type SceneSurfacePointerResolution,
} from "../../scene/scene-input-runtime";
import { resolveSceneMotionMode } from "../../scene/scene-motion";

type AvailableRoomAction = Extract<RoomPrimaryActionV1, { availability: "available" }>;
type StudyBoundaryTone = "loading" | "empty" | "error";
const STUDY_CALIBRATION_SURFACES = Object.freeze(Object.values(STUDY_SURFACE_REGISTRY.surfaces));

function StudyBoundaryReading({
  heading,
  message,
}: {
  readonly heading: string;
  readonly message: string;
}) {
  return (
    <>
      <BookOpenText size={25} aria-hidden="true" />
      <h2 id="study-surface-title">{heading}</h2>
      <p>{message}</p>
    </>
  );
}

function StudyBoundaryRecovery({
  tone,
  onRetry,
}: {
  readonly tone: StudyBoundaryTone;
  readonly onRetry?: () => void;
}) {
  if (tone === "loading") {
    return <div className="study-boundary__lines" aria-hidden="true"><span /><span /><span /></div>;
  }
  return (
    <>
      <p>{tone === "empty" ? "重新读取后，这一页只会出现服务端确认的下一步。" : "先恢复可信数据，再继续学习或验证。"}</p>
      <button type="button" className="surface-primary" onClick={onRetry}>
        <RotateCcw size={16} aria-hidden="true" />重新读取主焦点
      </button>
    </>
  );
}

export function StudySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const theme = useRoomStore((state) => state.theme);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const scenePhase = useRoomStore((state) => state.scenePhase);
  const windowState = useRoomStore((state) => state.windowState);
  const setTheme = useRoomStore((state) => state.setTheme);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const epochRef = useRef<number | undefined>(undefined);
  const studyReferenceFrameRef = useRef<HTMLDivElement>(null);
  const leftPageSurfaceRef = useRef<HTMLDivElement>(null);
  const rightPageSurfaceRef = useRef<HTMLDivElement>(null);
  const sourceSlipSurfaceRef = useRef<HTMLElement>(null);
  const [projection, setProjection] = useState<RoomProjectionV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [surfaceQuadOverrides, setSurfaceQuadOverrides] = useState<SceneSurfaceQuadOverrides | undefined>();
  const [studyCanvasReady, setStudyCanvasReady] = useState(false);
  const { manifest } = useLearningRoomManifest();
  const studyProjectionTargets = useMemo<readonly SceneSurfaceProjectionTarget[]>(() => [
    { ref: leftPageSurfaceRef, surface: STUDY_SURFACE_REGISTRY.surfaces.notebookLeft },
    { ref: rightPageSurfaceRef, surface: STUDY_SURFACE_REGISTRY.surfaces.notebookRight },
    { ref: sourceSlipSurfaceRef, surface: STUDY_SURFACE_REGISTRY.surfaces.sourceSlip },
  ], []);
  const observeStudySurfaceInput = useCallback((input: SceneSurfacePointerResolution) => {
    const frame = studyReferenceFrameRef.current;
    if (!frame) return;
    writeSceneInputDiagnostics(frame, input);
  }, []);

  const loadProjection = useCallback(async () => {
    if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取真实学习目标。");
    const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (sessionResponse.workspaceEpoch) epochRef.current = sessionResponse.workspaceEpoch;
    const session = unwrapGatewayResult(sessionResponse);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    const projectionResponse = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
    if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
    setProjection(unwrapGatewayResult(projectionResponse));
    setFailure(null);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadProjection()
      .catch((error) => active && setFailure(gatewayErrorMessage(error)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadProjection]);

  const reload = () => {
    setLoading(true);
    setFailure(null);
    void loadProjection()
      .catch((error) => setFailure(gatewayErrorMessage(error)))
      .finally(() => setLoading(false));
  };

  const focus = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data : null;
  const objective = focus?.objective ?? null;
  const action = focus?.action ?? null;
  const title = objective?.content.conceptLabel ?? objective?.sources.primaryNote?.title ?? "继续学习";
  const sourceLabel = objective?.content.sourceLabel ?? objective?.sources.primaryNote?.title ?? "来源标签未公开";
  const reviewDueCount = projection?.sanitizedReviewSummary.state === "data" ? projection.sanitizedReviewSummary.data.dueCount : 0;

  const startPrimaryAction = async () => {
    if (!action || action.availability !== "available" || !window.ailearn || starting) return;
    const typedAction: AvailableRoomAction["action"] = action.action;
    setStarting(true);
    setFailure(null);
    try {
      if (typedAction.kind === "resume_run") {
        setActiveRunId(typedAction.runId);
        invoke("validate");
        return;
      }
      if (typedAction.kind !== "create_run" && typedAction.kind !== "create_review_run") return;
      const originV2 = learningRunOriginForRoomAction(typedAction);
      if (!originV2) throw new Error(typedAction.kind === "create_run"
        ? "服务端没有提供可验证的学习卡身份，未启动学习运行。"
        : "服务端返回的复习版本不可用，未启动学习运行。");
      const response = await window.ailearn.learningRun.start({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId(typedAction.kind === "create_review_run" ? "start-focus-review" : "start-focus-run"),
        request: {
          version: 2,
          originV2,
          goal: "stabilize",
          requestedTimeBudgetSeconds: 180,
          responsePreference: "adaptive",
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const snapshot = unwrapGatewayResult(response);
      setActiveRunId(snapshot.runId);
      invoke("validate");
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setStarting(false);
    }
  };

  const boundary = loading
    ? { heading: "正在读取真实学习目标…", message: "正在确认身份、工作区与当前主焦点。", tone: "loading" as const }
    : failure
      ? { heading: "当前学习目标暂时不可用", message: failure, tone: "error" as const }
      : projection?.primaryFocus.state === "empty"
        ? { heading: "还没有可继续的学习目标", message: "服务端暂时没有提供主焦点；这里不会用本机样本填满空白页。", tone: "empty" as const }
        : projection?.primaryFocus.state === "error"
          ? { heading: "主焦点读取未完成", message: "服务端主焦点暂时不可用，请稍后重新读取。", tone: "error" as const }
          : null;
  const missingStartIdentity = action?.availability === "available"
    && action.action.kind === "create_run"
    && !action.action.cardId;
  const hasReadyContent = Boolean(!boundary && objective && action);
  const notebookAssetPath = manifest?.objects.studyOpenNotebook ?? null;
  const notebookAssetUrl = manifest && notebookAssetPath ? mediaAssetUrl(manifest, notebookAssetPath) : null;

  useSceneSurfaceProjections(studyProjectionTargets, {
    active: true,
    compactMediaQuery: STUDY_SURFACE_REGISTRY.compactMediaQuery,
    quadOverrides: surfaceQuadOverrides,
  });

  useSceneSurfaceInputRuntime({
    active: import.meta.env.DEV,
    compactMediaQuery: STUDY_SURFACE_REGISTRY.compactMediaQuery,
    referenceFrameRef: studyReferenceFrameRef,
    targets: studyProjectionTargets,
    quadOverrides: surfaceQuadOverrides,
    onInput: observeStudySurfaceInput,
  });

  return (
    <section
      className={`study-object-surface study-workbench task-artifact${boundary ? ` study-workbench--${boundary.tone}` : " study-workbench--ready"}`}
      aria-labelledby="study-surface-title"
    >
      <SurfaceReturnControl className="study-workbench__bookmark" />
      <SceneReferenceFrame
        ref={studyReferenceFrameRef}
        className="study-reference-frame"
        data-scene-input-runtime={import.meta.env.DEV ? "observer" : "disabled"}
      >
        <div
          className="study-notebook"
          style={STUDY_NOTEBOOK_STYLE}
          data-scene-canvas-state={studyCanvasReady ? "ready" : "fallback"}
          data-scene-canvas-renderer={studyCanvasReady ? "pixi-study-notebook-base" : "poster"}
          data-scene-canvas-active={studyCanvasReady && scenePhase === "task" ? "true" : "false"}
        >
          <StudyNotebookCanvas
            assetUrl={notebookAssetUrl}
            compactMediaQuery={STUDY_SURFACE_REGISTRY.compactMediaQuery}
            motionMode={motionMode}
            scenePhase={scenePhase}
            windowState={windowState}
            onReady={setStudyCanvasReady}
          />
          <img
            className="study-notebook__object"
            src={notebookAssetUrl ?? "/assets/learning-room/v1/objects/study-open-notebook-v1.png"}
            data-scene-surface-base="true"
            alt=""
            aria-hidden="true"
            draggable="false"
          />

          <div
            ref={leftPageSurfaceRef}
            className="study-notebook__surface study-notebook__surface--reading"
            style={STUDY_SURFACE_STYLES.notebookLeft}
            data-scene-surface={STUDY_SURFACE_REGISTRY.surfaces.notebookLeft.id}
          >
            <article
              className="study-notebook__page study-notebook__page--reading"
              role={boundary?.tone === "error" ? "alert" : boundary ? "status" : undefined}
            >
              <div
                className={`study-notebook__ink study-notebook__ink--reading${boundary ? " study-boundary" : ""}`}
                data-scene-surface-layer="ink"
              >
                {boundary ? (
                  <StudyBoundaryReading heading={boundary.heading} message={boundary.message} />
                ) : objective && action ? (
                  <>
                    <header className="study-objective">
                      <h2 id="study-surface-title">{title}</h2>
                    </header>
                    <blockquote>{objective.content.publicSummary}</blockquote>
                    <footer className="study-objective__status">
                      <strong>{studyStatusLabel(objective)}</strong>
                      <span>内容版本 {objective.surfaceRevision}</span>
                    </footer>
                  </>
                ) : null}
              </div>
              <span className="study-notebook__material study-notebook__material--left" data-scene-surface-layer="material" aria-hidden="true" />
            </article>
          </div>

          <div
            ref={rightPageSurfaceRef}
            className="study-notebook__surface study-notebook__surface--next"
            style={STUDY_SURFACE_STYLES.notebookRight}
            data-scene-surface={STUDY_SURFACE_REGISTRY.surfaces.notebookRight.id}
          >
            <section className="study-notebook__page study-notebook__page--next" aria-labelledby={boundary ? undefined : "study-next-action-title"}>
              <div
                className={`study-notebook__ink study-notebook__ink--next${boundary ? " study-boundary__recovery" : ""}`}
                data-scene-surface-layer="ink"
              >
                {boundary ? (
                  <StudyBoundaryRecovery {...boundary} onRetry={boundary.tone === "loading" ? undefined : reload} />
                ) : objective && action ? (
                  <>
                    <div className="study-next-action">
                      <Sparkles size={18} aria-hidden="true" />
                      <div>
                        <h3 id="study-next-action-title">{studyActionLabel(action.action)}</h3>
                        <p>{studyActionDescription(action.action)}</p>
                      </div>
                    </div>
                    {roomActionReasonLabel(action) ? <p className="study-next-action__unavailable">{roomActionReasonLabel(action)}</p> : null}
                    {missingStartIdentity ? <p className="study-next-action__unavailable">服务端尚未提供可验证的学习卡身份，本次学习保持关闭。</p> : null}
                    <div className="study-notebook__actions">
                      <button className="surface-primary" type="button" disabled={action.availability !== "available" || missingStartIdentity || starting} onClick={() => void startPrimaryAction()}>
                        {starting ? "正在准备…" : studyActionLabel(action.action)}<ArrowRight size={17} aria-hidden="true" />
                      </button>
                      {objective.sources.primaryNote ? (
                        <button className="surface-secondary" type="button" onClick={() => invoke("open-notebook")}>
                          <BookOpenText size={17} aria-hidden="true" />进入研究册
                        </button>
                      ) : reviewDueCount > 0 ? (
                        <button className="surface-secondary" type="button" onClick={() => invoke("review")}>打开今日复习队列</button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
              <span className="study-notebook__material study-notebook__material--right" data-scene-surface-layer="material" aria-hidden="true" />
            </section>
          </div>

          <aside
            ref={sourceSlipSurfaceRef}
            className={`study-source-slip study-notebook__surface${hasReadyContent ? "" : " study-source-slip--empty"}`}
            style={STUDY_SURFACE_STYLES.sourceSlip}
            data-scene-surface={STUDY_SURFACE_REGISTRY.surfaces.sourceSlip.id}
            aria-label={hasReadyContent ? "学习目标来源" : undefined}
            aria-hidden={hasReadyContent ? undefined : "true"}
          >
            <div className="study-source-slip__plane">
              <div className="study-source-slip__ink" data-scene-surface-layer="ink">
                {hasReadyContent ? <><span>来源</span><strong>{sourceLabel}</strong></> : null}
              </div>
              <span className="study-source-slip__material" data-scene-surface-layer="material" aria-hidden="true" />
            </div>
          </aside>

          <span className="study-notebook__spine" data-scene-surface-layer="occluder" aria-hidden="true" />
        </div>

        {import.meta.env.DEV ? (
          <SurfaceCalibrator
            referenceFrameRef={studyReferenceFrameRef}
            registry={STUDY_SURFACE_REGISTRY}
            surfaces={STUDY_CALIBRATION_SURFACES}
            theme={theme}
            onThemeChange={setTheme}
            onQuadOverridesChange={setSurfaceQuadOverrides}
          />
        ) : null}
      </SceneReferenceFrame>
    </section>
  );
}
