import { useCallback, useEffect, useRef, useState } from "react";
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

type AvailableRoomAction = Extract<RoomPrimaryActionV1, { availability: "available" }>;
type StudyBoundaryTone = "loading" | "empty" | "error";

function StudyBoundary({
  heading,
  message,
  tone,
  onRetry,
}: {
  readonly heading: string;
  readonly message: string;
  readonly tone: StudyBoundaryTone;
  readonly onRetry?: () => void;
}) {
  const role = tone === "error" ? "alert" : "status";

  return (
    <>
      <article className="study-notebook__page study-notebook__page--reading study-boundary" role={role}>
        <BookOpenText size={25} aria-hidden="true" />
        <h2 id="study-surface-title">{heading}</h2>
        <p>{message}</p>
      </article>
      <section className="study-notebook__page study-notebook__page--next study-boundary__recovery" aria-label="恢复操作">
        {tone === "loading" ? (
          <div className="study-boundary__lines" aria-hidden="true"><span /><span /><span /></div>
        ) : (
          <>
            <p>{tone === "empty" ? "重新读取后，这一页只会出现服务端确认的下一步。" : "先恢复可信数据，再继续学习或验证。"}</p>
            <button type="button" className="surface-primary" onClick={onRetry}>
              <RotateCcw size={16} aria-hidden="true" />重新读取主焦点
            </button>
          </>
        )}
      </section>
    </>
  );
}

export function StudySurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const epochRef = useRef<number | undefined>(undefined);
  const [projection, setProjection] = useState<RoomProjectionV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
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

  return (
    <section
      className={`study-object-surface study-workbench task-artifact${boundary ? ` study-workbench--${boundary.tone}` : " study-workbench--ready"}`}
      aria-labelledby="study-surface-title"
    >
      <SurfaceReturnControl className="study-workbench__bookmark" />
      <div className="study-notebook">
        <img
          className="study-notebook__object"
          src="/assets/learning-room/v1/objects/study-open-notebook-v1.png"
          alt=""
          aria-hidden="true"
          draggable="false"
        />
        {boundary ? (
          <StudyBoundary {...boundary} onRetry={boundary.tone === "loading" ? undefined : reload} />
        ) : objective && action ? (
          <>
            <article className="study-notebook__page study-notebook__page--reading">
              <header className="study-objective">
                <h2 id="study-surface-title">{title}</h2>
              </header>
              <blockquote>{objective.content.publicSummary}</blockquote>
              <footer className="study-objective__status">
                <strong>{studyStatusLabel(objective)}</strong>
                <span>内容版本 {objective.surfaceRevision}</span>
              </footer>
            </article>
            <section className="study-notebook__page study-notebook__page--next" aria-labelledby="study-next-action-title">
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
            </section>
            <aside className="study-source-slip" aria-label="学习目标来源">
              <span>来源</span>
              <strong>{sourceLabel}</strong>
            </aside>
          </>
        ) : null}
      </div>
    </section>
  );
}
