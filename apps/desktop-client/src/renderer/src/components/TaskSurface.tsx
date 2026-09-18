import { useCallback, useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  CornerDownLeft,
  FileSearch,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { useRoomStore } from "../app/room-store";
import { createRequestMeta, gatewayErrorMessage, RendererGatewayError, unwrapGatewayResult } from "../app/desktop-client";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { GraphSurface } from "./surfaces/graph-surface";
import { ReviewSurface } from "./surfaces/ReviewSurface";
import { StudySurface } from "./surfaces/StudySurface";
import { LearningRunSurface } from "./surfaces/learning-run-surface";
import { SurfaceReturnControl } from "./surfaces/SurfaceReturnControl";
import {
  ObjectiveDetailSurface,
  ObjectiveLibrarySurface,
} from "./surfaces/WorkspaceLibrarySurface";
import { CompanionCenterSurface } from "./surfaces/companion-center-surface";
import { NoteLibrarySurface } from "./surfaces/note-library-surface";
import { NotebookSurface } from "./surfaces/notebook-surface";
import { SearchSurface } from "./surfaces/search-surface";
import { SettingsSurface } from "./surfaces/settings-surface";
import { SourceDetailSurface } from "./surfaces/source-detail-surface";
import { SourceLibrarySurface } from "./surfaces/source-library-surface";
import { resolveSceneMotionMode, sceneMotionDuration } from "../scene/scene-motion";
import {
  roomActionReasonLabel,
  studyActionDescription,
  studyActionLabel,
  studyStatusLabel,
} from "./surfaces/room-primary-action-presentation";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";

gsap.registerPlugin(useGSAP);

type ResolvedMotionMode = "full" | "lite" | "off";

function useResolvedMotionMode(): ResolvedMotionMode {
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  return resolveSceneMotionMode(motionPreference, reducedMotion);
}

function PanelHeader({ title, detail }: { title: string; detail: string }) {
  const invoke = useRoomStore((state) => state.invoke);
  return (
    <header className="task-surface__header task-artifact task-artifact--header">
      <div className="task-surface__header-copy">
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      <button className="surface-close" type="button" onClick={() => invoke("home")} aria-label="关闭任务面并返回房间" data-surface-initial-focus="true">
        <ArrowLeft size={17} aria-hidden="true" />
        <span>返回书房</span>
      </button>
    </header>
  );
}

async function navigateThroughMainResolver(route: DesktopRouteV1, learningRunId?: string): Promise<DesktopRouteV1> {
  if (!window.ailearn) throw new Error("desktop API is unavailable");
  const resolveResponse = await window.ailearn.navigation.resolve({
    meta: createRequestMeta(),
    route,
    ...(learningRunId ? { learningRunId } : {}),
  });
  const resolved = unwrapGatewayResult(resolveResponse);
  if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
  const goResponse = await window.ailearn.navigation.go({
    meta: createRequestMeta(resolved.current.workspaceEpoch),
    route: resolved.current.route,
    entryKind: "user",
    ...(learningRunId ? { learningRunId } : {}),
  });
  const navigated = unwrapGatewayResult(goResponse);
  if (navigated.current.scope !== "workspace") throw new Error("navigation did not commit to the current workspace");
  return navigated.current.route;
}

function LearningCardSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const epochRef = useRef<number | undefined>(undefined);
  const [projection, setProjection] = useState<RoomProjectionV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

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

  const focus = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data : null;
  const objective = focus?.objective ?? null;
  const action = focus?.action ?? null;
  const title = objective?.content.conceptLabel ?? objective?.sources.primaryNote?.title ?? "学习目标详情";
  const sourceLabel = objective?.content.sourceLabel ?? objective?.sources.primaryNote?.title ?? "来源标签未公开";
  const lifecycleLabel = objective ? {
    active: "活跃",
    archived: "已归档",
    superseded: "已被替代",
    blocked_content_upgrade: "等待内容更新",
  }[objective.lifecycle.status] : null;
  const knowledgeFormLabel = objective ? {
    fact: "事实",
    definition: "定义",
    relationship: "关系",
    comparison: "比较",
    sequence: "顺序",
    procedure: "步骤",
    causal_model: "因果模型",
    boundary: "边界",
    application_rule: "应用规则",
  }[objective.content.knowledgeForm] ?? objective.content.knowledgeForm : null;

  const reload = () => {
    setLoading(true);
    void loadProjection().catch((error) => setFailure(gatewayErrorMessage(error))).finally(() => setLoading(false));
  };

  return (
    <>
      <PanelHeader title={title} detail={objective ? `服务端 Objective · ${studyStatusLabel(objective)}` : "读取服务端 Objective projection"} />
      <div className="card-editor objective-detail task-artifact task-artifact--objective">
        <div className="objective-detail__content">
          {loading ? <div className="objective-detail__state" role="status"><BookOpenText size={26} aria-hidden="true" /><strong>正在读取真实学习目标…</strong><p>先确认身份、工作区与主焦点。</p></div> : null}
          {!loading && failure ? <div className="objective-detail__state objective-detail__state--error" role="alert"><BookOpenText size={26} aria-hidden="true" /><strong>学习目标暂时不可用</strong><p>{failure}</p><button type="button" className="surface-primary" onClick={reload}><RotateCcw size={16} aria-hidden="true" />重新读取</button></div> : null}
          {!loading && !failure && projection?.primaryFocus.state === "empty" ? <div className="objective-detail__state" role="status"><BookOpenText size={26} aria-hidden="true" /><strong>当前没有服务端主焦点</strong><p>桌面不会用本机草稿填充学习目标详情。</p><button type="button" className="surface-primary" onClick={reload}>重新读取</button></div> : null}
          {!loading && !failure && projection?.primaryFocus.state === "error" ? <div className="objective-detail__state objective-detail__state--error" role="alert"><BookOpenText size={26} aria-hidden="true" /><strong>主焦点读取未完成</strong><p>服务端 projection 暂时不可用，请稍后重试。</p><button type="button" className="surface-primary" onClick={reload}>重新读取</button></div> : null}
          {!loading && !failure && objective && action && lifecycleLabel && knowledgeFormLabel ? (
            <>
              <div className="objective-detail__main">
                <h3>{title}</h3>
                <p className="objective-detail__summary">{objective.content.publicSummary}</p>
                <blockquote>
                  <strong>服务端主行动</strong>
                  <span>{studyActionLabel(action.action)}</span>
                  <small>{studyActionDescription(action.action)}</small>
                </blockquote>
              </div>
              <aside className="objective-detail__facts" aria-label="学习目标公开信息">
                <dl>
                  <div><dt>来源</dt><dd>{sourceLabel}</dd></div>
                  <div><dt>知识形态</dt><dd>{knowledgeFormLabel}</dd></div>
                  <div><dt>生命周期</dt><dd>{lifecycleLabel}</dd></div>
                  <div><dt>目标状态</dt><dd>服务端已确认</dd></div>
                </dl>
                {roomActionReasonLabel(action) ? <p className="objective-detail__unavailable">{roomActionReasonLabel(action)}</p> : null}
                <div className="surface-action-pair">
                  <button type="button" className="surface-primary" disabled={action.availability !== "available"} onClick={() => invoke("continue")}>{studyActionLabel(action.action)}<ArrowRight size={16} aria-hidden="true" /></button>
                  {objective.sources.primaryNote ? <button type="button" className="surface-secondary" onClick={() => invoke("open-notebook")}><BookOpenText size={16} aria-hidden="true" />回研究册</button> : null}
                  {action.action.kind === "refresh" ? <button type="button" className="text-action" onClick={reload}>重新读取 projection</button> : null}
                </div>
              </aside>
            </>
          ) : null}
        </div>
      </div>
      <p className="prototype-note task-artifact task-artifact--provenance">详情只显示服务端公开 Objective projection；canonical answer、rubric 与完整证据不会进入桌面渲染边界。</p>
    </>
  );
}

function ValidationSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const clearActiveRun = useRoomStore((state) => state.setActiveRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setNavigationGuard = useRoomStore((state) => state.setNavigationGuard);
  const handleRunExit = useCallback(async (runId: string, request?: { route: DesktopRouteV1; objectiveId?: string }) => {
    // Remove the sensitive Player tree before asking main to resolve the
    // return route. Main may then complete FormalAssessmentGuard release only
    // after the renderer has yielded a frame with the task context unmounted.
    clearActiveRun(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    let resolvedRoute: DesktopRouteV1 = request?.route ?? { kind: "review.queue" };
    try {
      resolvedRoute = await navigateThroughMainResolver(resolvedRoute, runId);
    } catch {
      // A deleted, forbidden, disabled, or otherwise unresolvable server target
      // must not be replayed by the renderer. Resolve the current Room route
      // through main as the single safe fallback.
      try {
        resolvedRoute = await navigateThroughMainResolver({ kind: "room.home" });
      } catch {
        resolvedRoute = { kind: "room.home" };
      }
    }
    invoke(resolvedRoute.kind === "review.queue" ? "review" : "home");
    if (request?.objectiveId) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      setActiveObjectiveId(request.objectiveId);
      invoke("open-objective");
    }
  }, [clearActiveRun, invoke, setActiveObjectiveId]);

  useEffect(() => {
    if (!activeRunId) {
      setNavigationGuard(null);
      return;
    }
    const runId = activeRunId;
    setNavigationGuard(() => { void handleRunExit(runId); });
    return () => setNavigationGuard(null);
  }, [activeRunId, handleRunExit, setNavigationGuard]);

  return (
    <LearningRunSurface onExit={activeRunId ? (request) => { void handleRunExit(activeRunId, request); } : undefined} />
  );
}

function fallbackIntentForSurface(surface: NonNullable<ReturnType<typeof useRoomStore.getState>["surface"]>) {
  if (surface === "review") return "review";
  if (surface === "search") return "search";
  if (surface === "graph") return "graph";
  if (surface === "source-library" || surface === "source-detail") return "open-sources";
  if (surface === "note-library") return "open-notes";
  if (surface === "objective-library" || surface === "objective-detail") return "open-objectives";
  if (surface === "companion-center") return "open-companion-center";
  if (surface === "settings") return "open-settings";
  return "continue";
}

export function TaskSurface() {
  const surface = useRoomStore((state) => state.surface);
  const scenePhase = useRoomStore((state) => state.scenePhase);
  const motionMode = useResolvedMotionMode();
  const [renderedSurface, setRenderedSurface] = useState(surface);
  const [transition, setTransition] = useState<"entering" | "entered" | "leaving">(surface ? "entering" : "entered");
  const surfaceRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<{ element: HTMLElement; fallbackSelector: string } | null>(null);
  const lastSurfaceRef = useRef(surface);

  useEffect(() => {
    if (surface && !renderedSurface) {
      setRenderedSurface(surface);
      setTransition("entering");
    }
  }, [renderedSurface, surface]);

  useEffect(() => {
    if (surface) {
      lastSurfaceRef.current = surface;
      if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
        const element = document.activeElement;
        const fallbackIntent = fallbackIntentForSurface(surface);
        returnFocusRef.current = {
          element,
          fallbackSelector: `[data-focus-return="${element.dataset.focusReturn ?? fallbackIntent}"]`,
        };
      }
    }
  }, [surface]);

  useEffect(() => {
    if (renderedSurface) {
      if (renderedSurface !== surface || transition !== "entered" || scenePhase !== "task") return;
      const frame = window.requestAnimationFrame(() => {
        const selector = renderedSurface === "search"
          ? ".search-field input"
          : renderedSurface === "review"
            ? "[data-review-return-focus='true'], [data-surface-initial-focus], .surface-close"
            : "[data-surface-initial-focus], .surface-close";
        // The shared "return to study" pill is the close control of every HUD
        // page and lives outside the surface element, so the surface is searched
        // first and the document is the fallback — without it a page opened from
        // the rail kept focus on the rail chip and the surface was never entered.
        const target = surfaceRef.current?.querySelector<HTMLElement>(selector)
          ?? document.querySelector<HTMLElement>(selector);
        target?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const lastSurface = lastSurfaceRef.current;
    if (!lastSurface || scenePhase !== "idle") return;
    const returnFocus = returnFocusRef.current;
    const fallbackSelector = returnFocus?.fallbackSelector ?? `[data-focus-return="${fallbackIntentForSurface(lastSurface)}"]`;
    returnFocusRef.current = null;
    lastSurfaceRef.current = null;
    window.requestAnimationFrame(() => {
      const element = returnFocus?.element;
      const canRestoreElement = element
        && element.isConnected
        && element !== document.body
        && element !== document.documentElement
        && !element.closest("[inert], [aria-hidden='true']");
      const target = canRestoreElement ? element : document.querySelector<HTMLElement>(fallbackSelector);
      target?.focus();
    });
  }, [renderedSurface, surface, transition, scenePhase]);

  useGSAP(
    (_context, contextSafe) => {
      const root = surfaceRef.current;
      if (!root || !renderedSurface) return;

      const content = root.querySelector<HTMLElement>(".surface-content");
      const header = root.querySelector<HTMLElement>(".task-artifact--header");
      const artifacts = root.querySelectorAll<HTMLElement>(".task-artifact:not(.task-artifact--header)");
      const allAnimated = [content, header, ...artifacts].filter((target): target is HTMLElement => Boolean(target));
      const lite = motionMode === "lite";
      const surfaceEnterDuration = sceneMotionDuration(motionMode, "surfaceEnter");
      const surfaceExitDuration = sceneMotionDuration(motionMode, "surfaceExit");
      const isObjectSurface = renderedSurface === "study" || renderedSurface === "review" || renderedSurface === "search";

      if (surface !== renderedSurface) {
        setTransition("leaving");
        const finishExit = contextSafe?.(() => {
          setRenderedSurface(surface);
          setTransition(surface ? "entering" : "entered");
        }) ?? (() => {
          setRenderedSurface(surface);
          setTransition(surface ? "entering" : "entered");
        });

        if (motionMode === "off") {
          gsap.set(allAnimated, { autoAlpha: 0 });
          finishExit();
          return;
        }

        const exitTimeline = gsap.timeline({
          defaults: {
            duration: surfaceExitDuration,
            ease: "power2.out",
          },
          onComplete: finishExit,
        });
        if (artifacts.length) {
          exitTimeline.to(
            artifacts,
            {
              autoAlpha: 0,
              y: lite ? 4 : 13,
              scale: lite ? 1 : 0.99,
              stagger: lite ? 0 : { each: 0.025, from: "end" },
            },
            0,
          );
        }
        if (header) {
          exitTimeline.to(header, { autoAlpha: 0, y: lite ? -3 : -9 }, 0);
        }
        if (content) {
          exitTimeline.to(content, { autoAlpha: 0, scale: lite ? 1 : 0.992 }, lite ? 0.04 : 0.1);
        }
        return;
      }

      setTransition("entering");
      const finishEnter = contextSafe?.(() => setTransition("entered")) ?? (() => setTransition("entered"));
      if (motionMode === "off") {
        gsap.set(allAnimated, { autoAlpha: 1, clearProps: "transform" });
        finishEnter();
        return;
      }

      const enterTimeline = gsap.timeline({
        defaults: {
          duration: surfaceEnterDuration,
          ease: "power3.out",
        },
        onComplete: finishEnter,
      });
      enterTimeline.addLabel("artifact-rise", 0);
      if (content) {
        enterTimeline.fromTo(
          content,
          { autoAlpha: 0, y: lite ? 5 : 18, scale: lite ? 1 : 0.988 },
          { autoAlpha: 1, y: 0, scale: 1 },
          "artifact-rise",
        );
      }
      if (header) {
        enterTimeline.fromTo(
          header,
          { autoAlpha: 0, y: lite ? -4 : -12 },
          { autoAlpha: 1, y: 0, duration: lite ? 0.16 : 0.34 },
          "artifact-rise",
        );
      }
      if (artifacts.length && isObjectSurface) {
        const studyEntrance = renderedSurface === "study";
        enterTimeline.fromTo(
          artifacts,
          studyEntrance
            ? {
                autoAlpha: 0,
                y: lite ? 6 : 26,
                scale: lite ? 1 : 0.955,
                rotateX: lite ? 0 : -3.2,
                transformOrigin: "50% 100%",
                clipPath: lite ? "inset(0% 0% 0% 0% round 0px)" : "inset(7% 2% 0% 2% round 28px)",
              }
            : {
                autoAlpha: 0,
                x: lite ? -5 : -22,
                y: lite ? 5 : 18,
                scale: lite ? 1 : 0.97,
                rotateZ: lite ? 0 : -1.2,
                transformOrigin: "20% 100%",
                clipPath: lite ? "inset(0% 0% 0% 0% round 0px)" : "inset(0% 7% 5% 4% round 24px)",
              },
          {
            autoAlpha: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotateX: 0,
            rotateZ: 0,
            clipPath: "inset(0% 0% 0% 0% round 0px)",
            duration: surfaceEnterDuration * (lite ? 0.82 : studyEntrance ? 1 : 0.91),
          },
          lite ? "artifact-rise" : "artifact-rise+=0.05",
        );
      } else if (artifacts.length) {
        enterTimeline.fromTo(
          artifacts,
          { autoAlpha: 0, y: lite ? 6 : 22, scale: lite ? 1 : 0.982 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: surfaceEnterDuration * (lite ? 0.82 : 0.91),
            stagger: lite ? 0 : 0.055,
          },
          lite ? "artifact-rise" : "artifact-rise+=0.08",
        );
      }
    },
    {
      scope: surfaceRef,
      dependencies: [motionMode, renderedSurface, surface],
      revertOnUpdate: true,
    },
  );

  if (!renderedSurface) return null;

  return (
    <section
      ref={surfaceRef}
      className={`task-surface task-surface--spatial task-surface--${renderedSurface}`}
      data-surface={renderedSurface}
      data-transition={transition}
      data-scene-phase={scenePhase}
      data-motion-mode={motionMode}
      role="region"
      aria-label="当前学习任务"
      aria-hidden={transition === "leaving" || undefined}
      inert={transition === "leaving" || undefined}
      tabIndex={-1}
    >
      <div className="surface-content task-surface__spatial-layer" key={renderedSurface}>
        {renderedSurface === "study" ? <StudySurface /> : null}
        {renderedSurface === "notebook" ? <NotebookSurface /> : null}
        {renderedSurface === "card" ? <LearningCardSurface /> : null}
        {renderedSurface === "card-generation" ? <CardGenerationSurface /> : null}
        {renderedSurface === "review" ? <ReviewSurface /> : null}
        {renderedSurface === "search" ? <SearchSurface /> : null}
        {renderedSurface === "graph" ? <GraphSurface /> : null}
        {renderedSurface === "validation" ? <ValidationSurface /> : null}
        {renderedSurface === "source-library" ? <SourceLibrarySurface /> : null}
        {renderedSurface === "source-detail" ? <SourceDetailSurface /> : null}
        {renderedSurface === "note-library" ? <NoteLibrarySurface /> : null}
        {renderedSurface === "objective-library" ? <ObjectiveLibrarySurface /> : null}
        {renderedSurface === "objective-detail" ? <ObjectiveDetailSurface /> : null}
        {renderedSurface === "companion-center" ? <CompanionCenterSurface /> : null}
        {renderedSurface === "settings" ? <SettingsSurface /> : null}
      </div>
    </section>
  );
}
