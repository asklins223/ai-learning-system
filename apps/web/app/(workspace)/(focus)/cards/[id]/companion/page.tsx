"use client";

import "@/app/styles/companion-stage.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { learningSessionClient } from "@/features/companion/api/learning-session-client";
import type {
  LearningEpisodeProcessingPhase,
  LearningSessionEpisode,
  LearningSessionPublicView,
} from "@/features/companion/api/contracts";
import { resolvePracticeModeSelect } from "@/features/companion/answer-modes/practice-mode-select";
import { VoiceTeachBackScene } from "@/components/learning-companion/scenes/VoiceTeachBackScene";
import { SilentProofScene } from "@/components/learning-companion/scenes/SilentProofScene";
import type { LearningScene } from "@ailearn/shared";
import { transcribePlain } from "@/lib/learning-companion/voice-api";
import { ApiError, api } from "@/lib/api";
import { isCompanionV2InternalEnabled } from "@/lib/feature-flags";
import { Icon } from "@/components/ui/icons";

type StageState =
  | "creating"
  | "modeSelect"
  | "ready"
  | "submitting"
  | "assessing"
  | "result"
  | "timeout"
  | "error";

type ErrorView = {
  title: string;
  detail: string;
  settingsAction: boolean;
};

const ASSESSMENT_POLL_INTERVAL_MS = 1_200;
const ASSESSMENT_POLL_LIMIT = 40;

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ASSESSMENT_POLL_INTERVAL_MS);
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Polling aborted", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function normalizeErrorCode(code: string | null): string | null {
  return code?.trim().toUpperCase() || null;
}

function readApiError(error: unknown): {
  code: string | null;
  message: string | null;
  activeSessionId: string | null;
} {
  if (error instanceof ApiError) {
    const dataCode = typeof error.data?.code === "string"
      ? error.data.code
      : typeof error.data?.error === "string"
        ? error.data.error
        : null;
    const activeSessionId = typeof error.data?.activeSessionId === "string"
      ? error.data.activeSessionId
      : null;
    return {
      code: error.code ?? dataCode,
      message: error.message || null,
      activeSessionId,
    };
  }
  return {
    code: null,
    message: error instanceof Error && error.message ? error.message : null,
    activeSessionId: null,
  };
}

function getErrorView(code: string | null, fallback: string | null): ErrorView {
  switch (normalizeErrorCode(code)) {
    case "AI_CONSENT_REQUIRED":
      return {
        title: "需要先签署 AI 使用协议",
        detail: "完成协议确认后，再回来开始这次巩固练习。",
        settingsAction: true,
      };
    case "SESSION_LIMIT_REACHED":
      return {
        title: "已有巩固练习进行中",
        detail: "当前账号已有一项未结束的练习。请先返回原练习并结束，再开始新的练习。",
        settingsAction: false,
      };
    case "LEARNING_SESSION_V2_DISABLED":
      return {
        title: "巩固练习暂未开放",
        detail: "当前环境尚未启用这项练习，学习卡内容与复习安排不受影响。",
        settingsAction: false,
      };
    default:
      return {
        title: "练习暂时无法开始",
        detail: fallback ?? "系统没有准备好这次练习，请稍后再试。",
        settingsAction: false,
      };
  }
}

function findEpisode(
  view: LearningSessionPublicView,
  episodeId?: string | null,
  keyPointId?: string | null,
): LearningSessionEpisode | null {
  if (episodeId) {
    const exact = view.episodes.find((item) => item.episodeId === episodeId);
    if (exact) return exact;
  }
  if (keyPointId) {
    const target = view.episodes.find((item) => item.keyPointId === keyPointId);
    if (target) return target;
  }
  return view.activeEpisode ?? view.episodes.at(-1) ?? null;
}

function stateForPhase(phase: LearningEpisodeProcessingPhase): StageState {
  if (phase === "assessment_pending" || phase === "assessment_complete" || phase === "commit_pending") {
    return "assessing";
  }
  if (phase === "committed") return "result";
  if (phase === "cancelled" || phase === "stale") return "error";
  return "ready";
}

function phaseLabel(state: StageState, phase: LearningEpisodeProcessingPhase | null): string {
  if (state === "creating") return "准备中";
  if (state === "modeSelect") return "选择作答方式";
  if (state === "submitting") return "保存中";
  if (state === "timeout") return "仍在处理";
  if (state === "error") return "需要处理";
  if (phase === "assessment_pending") return "等待评估";
  if (phase === "assessment_complete" || phase === "commit_pending") return "写入结果";
  if (phase === "committed") return "已完成";
  return "可以作答";
}

export default function CompanionCardStagePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const cardId = params.id;
  const keyPointId = searchParams.get("keyPoint");
  const sessionId = searchParams.get("session");
  const requestedOrigin = searchParams.get("origin");
  const origin = requestedOrigin === "star_map" || requestedOrigin === "now" || requestedOrigin === "review"
    ? requestedOrigin
    : "card";
  const originLabel = origin === "star_map"
    ? "理解星图"
    : origin === "review"
      ? "到期复习"
      : origin === "now"
        ? "今日学习"
        : "学习卡";

  const [session, setSession] = useState<LearningSessionPublicView | null>(null);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [cardTitle, setCardTitle] = useState("当前学习卡");
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<StageState>("creating");
  const [selectedMode, setSelectedMode] = useState<"voice" | "text" | "silent">("text");
  const [activeJourneyPlan, setActiveJourneyPlan] = useState<LearningSessionEpisode["journeyPlan"] | null>(null);
  const [processingPhase, setProcessingPhase] = useState<LearningEpisodeProcessingPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [blockedSessionId, setBlockedSessionId] = useState<string | null>(null);
  const [recoveringSession, setRecoveringSession] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const sessionRef = useRef<LearningSessionPublicView | null>(null);
  const assessmentAbortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const leavingRef = useRef(false);
  sessionRef.current = session;

  const setFailure = useCallback((cause: unknown, fallback: string) => {
    const parsed = readApiError(cause);
    setErrorCode(parsed.code);
    setError(parsed.code ? null : fallback);
    setBlockedSessionId(parsed.activeSessionId);
    setState("error");
  }, []);

  const pollAssessment = useCallback(async (
    targetSessionId: string,
    targetEpisodeId: string,
  ) => {
    assessmentAbortRef.current?.abort();
    const controller = new AbortController();
    assessmentAbortRef.current = controller;
    setState("assessing");

    try {
      for (let attempt = 0; attempt < ASSESSMENT_POLL_LIMIT; attempt += 1) {
        if (attempt > 0) await waitForPoll(controller.signal);
        const updated = await learningSessionClient.get(targetSessionId, controller.signal);
        if (controller.signal.aborted) return;
        const updatedEpisode = findEpisode(updated, targetEpisodeId, keyPointId);
        setSession(updated);
        if (!updatedEpisode) {
          throw new Error("没有找到这次练习的处理记录。");
        }

        setProcessingPhase(updatedEpisode.processingPhase);
        if (updatedEpisode.processingPhase === "committed") {
          setState("result");
          return;
        }
        if (updatedEpisode.processingPhase === "cancelled" || updatedEpisode.processingPhase === "stale") {
          setErrorCode(updatedEpisode.processingPhase.toUpperCase());
          setError("这次练习已经结束，未生成新的评估结论。");
          setState("error");
          return;
        }
      }
      setState("timeout");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setFailure(cause, "评估进度暂时无法读取。你的回答已经保存，可以稍后再查看。");
    } finally {
      if (assessmentAbortRef.current === controller) assessmentAbortRef.current = null;
    }
  }, [keyPointId, setFailure]);

  useEffect(() => () => {
    assessmentAbortRef.current?.abort();
    assessmentAbortRef.current = null;
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (!isCompanionV2InternalEnabled() || !keyPointId) {
      setErrorCode("LEARNING_SESSION_V2_DISABLED");
      setError(null);
      setState("error");
      return;
    }

    void api.getCard(cardId)
      .then((card) => {
        setCardTitle(card.card.schemaJson.title?.trim() || "当前学习卡");
      })
      .catch(() => undefined);

    const sessionRequest = sessionId
      ? learningSessionClient.get(sessionId)
      : learningSessionClient.create({ origin, keyPointId, intent: "stabilize" });

    void sessionRequest
      .then((created) => {
        const createdEpisode = findEpisode(created, null, keyPointId);
        if (!createdEpisode) throw new Error("当前学习卡还没有可用的巩固练习。");

        setSession(created);
        setEpisodeId(createdEpisode.episodeId);
        setProcessingPhase(createdEpisode.processingPhase);
        setError(null);
        setErrorCode(null);
        setBlockedSessionId(null);

        if (!sessionId) {
          router.replace(
            `/cards/${encodeURIComponent(cardId)}/companion?keyPoint=${encodeURIComponent(keyPointId)}&session=${encodeURIComponent(created.sessionId)}&origin=${encodeURIComponent(origin)}`,
            { scroll: false },
          );
        }

        const nextState = stateForPhase(createdEpisode.processingPhase);
        if (nextState === "ready") {
          // 任务 14 接线：episode 就绪后先进入 modeSelect——服务端 PREPARE 已
          // 下发 journeyPlan（模态 + scenePlan + trustCeiling），前端直接消费
          // 编排结果（不再自行 fail-closed，§3.6）。
          const select = resolvePracticeModeSelect({
            journeyPlan: createdEpisode.journeyPlan,
            voiceAvailable: true,
            inCooldown: false,
          });
          setActiveJourneyPlan(createdEpisode.journeyPlan);
          // transfer 是服务端编排的记录型模态，练习页先落 text 作答区
          //（transfer 场景由后续 Scene 渲染承接）。
          setSelectedMode(select.defaultOption === "silent" ? "silent" : select.defaultOption === "voice" ? "voice" : "text");
          setState(select.options.length > 1 ? "modeSelect" : "ready");
        } else {
          setState(nextState);
        }
        if (nextState === "assessing") {
          void pollAssessment(created.sessionId, createdEpisode.episodeId);
        } else if (nextState === "error") {
          setError("这次练习已经结束，未生成新的评估结论。");
          setErrorCode(createdEpisode.processingPhase.toUpperCase());
        }
      })
      .catch((cause) => {
        setFailure(cause, "系统没有准备好这次练习，请稍后再试。");
      });
  }, [cardId, keyPointId, origin, pollAssessment, router, sessionId, setFailure]);

  async function submitAnswer() {
    const activeSession = sessionRef.current;
    if (!activeSession || !episodeId || answer.trim() === "") return;
    setState("submitting");
    setError(null);
    setErrorCode(null);

    try {
      const locked = await learningSessionClient.answer(
        activeSession.sessionId,
        episodeId,
        answer.trim(),
      );
      try {
        sessionStorage.setItem(
          `companion-artifact:${activeSession.sessionId}`,
          locked.artifact.artifactId,
        );
      } catch {
        // The locked server artifact remains authoritative.
      }
      setProcessingPhase(locked.processingPhase);
      void pollAssessment(activeSession.sessionId, episodeId);
    } catch (cause) {
      setFailure(cause, "这次回答没有保存成功。请返回学习卡后再试。 ");
    }
  }

  const [voiceSubmitting, setVoiceSubmitting] = useState(false);

  async function submitSilentProof(payload: unknown) {
    const activeSession = sessionRef.current;
    if (!activeSession || !episodeId) return;
    setError(null);
    setErrorCode(null);
    try {
      // silent 场景的 canonical answer = 用户完成的场景操作序列（05-1），
      // 走同一 answer 端点（modality=text_or_mixed），评估/commit 链不变（§3.6）。
      const text = JSON.stringify(payload);
      const locked = await learningSessionClient.answer(
        activeSession.sessionId,
        episodeId,
        text,
      );
      try {
        sessionStorage.setItem(
          `companion-artifact:${activeSession.sessionId}`,
          locked.artifact.artifactId,
        );
      } catch {
        // The locked server artifact remains authoritative.
      }
      setProcessingPhase(locked.processingPhase);
      void pollAssessment(activeSession.sessionId, episodeId);
    } catch (cause) {
      setFailure(cause, "这次结构式证明没有保存成功。请返回学习卡后再试。");
    }
  }

  async function submitVoiceTranscript(transcript: string) {
    const activeSession = sessionRef.current;
    if (!activeSession || !episodeId || transcript.trim() === "") return;
    setVoiceSubmitting(true);
    setError(null);
    setErrorCode(null);
    try {
      // voice 的 canonical answer = 用户确认的逐字 transcript（04-1/04-2），
      // 走同一 answer 端点（服务端 modality=voice），评估/commit 链不变（§3.6）。
      const locked = await learningSessionClient.answerWithModality(
        activeSession.sessionId,
        episodeId,
        transcript.trim(),
        "voice",
      );
      try {
        sessionStorage.setItem(
          `companion-artifact:${activeSession.sessionId}`,
          locked.artifact.artifactId,
        );
      } catch {
        // The locked server artifact remains authoritative.
      }
      setProcessingPhase(locked.processingPhase);
      void pollAssessment(activeSession.sessionId, episodeId);
    } catch (cause) {
      setFailure(cause, "这次语音回答没有保存成功。请返回学习卡后再试。");
    } finally {
      setVoiceSubmitting(false);
    }
  }

  async function replaceBlockedSession() {
    if (!blockedSessionId || recoveringSession) return;
    setRecoveringSession(true);
    try {
      await learningSessionClient.end(blockedSessionId);
      const nextUrl = `/cards/${encodeURIComponent(cardId)}/companion?keyPoint=${encodeURIComponent(keyPointId ?? "")}&origin=${encodeURIComponent(origin)}`;
      window.location.assign(nextUrl);
    } catch {
      setBlockedSessionId(null);
      setErrorCode(null);
      setError("旧练习暂时无法结束，请稍后再试或返回学习卡。");
      setState("error");
      setRecoveringSession(false);
    }
  }

  function defaultReturnPath(): string {
    if (origin === "star_map") return "/graph";
    if (origin === "now") return "/today";
    if (origin === "review") return "/review";
    return `/cards/${encodeURIComponent(cardId)}`;
  }

  async function endStage(destination?: string) {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    assessmentAbortRef.current?.abort();
    assessmentAbortRef.current = null;

    const activeSession = sessionRef.current;
    if (activeSession) {
      await learningSessionClient.end(activeSession.sessionId).catch(() => undefined);
    }

    let scrollY = 0;
    try {
      const originSnapshot = JSON.parse(
        sessionStorage.getItem(`companion-origin:${origin}:${cardId}`)
          ?? sessionStorage.getItem(`companion-origin:${cardId}`)
          ?? "null",
      ) as { scrollY?: number } | null;
      scrollY = typeof originSnapshot?.scrollY === "number" ? originSnapshot.scrollY : 0;
      if (activeSession) {
        sessionStorage.removeItem(`companion-artifact:${activeSession.sessionId}`);
      }
    } catch {
      // Origin restoration is best effort.
    }

    router.push(destination ?? defaultReturnPath());
    if (!destination) {
      window.setTimeout(() => window.scrollTo({ top: scrollY, behavior: "auto" }), 0);
    }
  }

  const currentError = getErrorView(errorCode, error);
  const currentPhaseLabel = phaseLabel(state, processingPhase);

  return (
    <main
      className="companion-stage-page"
      data-ui="companion-practice-page"
      data-stage-state={state}
      data-processing-phase={processingPhase ?? "none"}
      data-error-code={errorCode ?? undefined}
    >
      <header className="companion-stage-topbar">
        <button
          type="button"
          className="companion-stage-back"
          onClick={() => void endStage(`/cards/${encodeURIComponent(cardId)}`)}
          disabled={leaving}
        >
          <Icon.Chevron aria-hidden="true" />
          <span>返回学习卡</span>
        </button>

        <div className="companion-stage-brand" aria-label="巩固练习">
          <i aria-hidden="true">理</i>
          <div>
            <span>学习卡练习</span>
            <strong>巩固练习</strong>
          </div>
        </div>

        <div className="companion-stage-topbar-actions">
          <span className="companion-stage-phase"><i aria-hidden="true" />{currentPhaseLabel}</span>
          <button
            type="button"
            onClick={() => void endStage()}
            className="companion-stage-exit"
            disabled={leaving}
          >
            <span>{leaving ? "正在退出…" : "退出练习"}</span>
            <Icon.X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="companion-stage-content">
        <section className="companion-stage-context" aria-labelledby="companion-stage-title">
          <div className="companion-stage-context-main">
            <div className="companion-stage-source">
              <span className="companion-stage-kicker">来自{originLabel}</span>
              <i aria-hidden="true" />
              <strong>{cardTitle}</strong>
            </div>
            <span className="companion-stage-task-label">当前任务</span>
            <h1 id="companion-stage-title">不看原文，写下你对这个要点的理解</h1>
            <p>不需要复述标准答案。先从记忆中提取最确定的内容，系统会在提交后独立评估。</p>
          </div>
          <div className="companion-stage-progress-wrap">
            <span>本轮进度</span>
            <ol className="companion-stage-progress" aria-label="巩固练习进度">
              <li className="is-complete">
                <span><Icon.Check aria-hidden="true" /></span>
                <div><strong>定位内容</strong><small>已选定当前要点</small></div>
              </li>
              <li
                className={state === "ready" || state === "submitting" || state === "modeSelect" ? "is-active" : state === "creating" || state === "error" ? "" : "is-complete"}
                aria-current={state === "ready" || state === "submitting" || state === "modeSelect" ? "step" : undefined}
              >
                <span>{state === "assessing" || state === "timeout" || state === "result" ? <Icon.Check aria-hidden="true" /> : "2"}</span>
                <div><strong>独立回答</strong><small>{state === "submitting" ? "正在安全保存" : state === "creating" ? "等待开始" : "用自己的话"}</small></div>
              </li>
              <li
                className={state === "assessing" || state === "timeout" ? "is-active" : state === "result" ? "is-complete" : ""}
                aria-current={state === "assessing" || state === "timeout" ? "step" : undefined}
              >
                <span>{state === "result" ? <Icon.Check aria-hidden="true" /> : "3"}</span>
                <div><strong>评估与写入</strong><small>{currentPhaseLabel}</small></div>
              </li>
            </ol>
          </div>
        </section>

        <section className="companion-stage-card" aria-labelledby="practice-task-title">
          <h2 id="practice-task-title" className="companion-stage-visually-hidden">巩固练习作答区</h2>

          <div className="companion-stage-card-body">
            {state === "creating" && (
              <div className="companion-stage-status is-preparing" role="status" aria-live="polite">
                <span className="companion-stage-status-icon"><Icon.Sparkle aria-hidden="true" /></span>
                <div className="companion-stage-status-copy">
                  <span>正在建立本轮练习</span>
                  <strong>正在准备练习…</strong>
                  <p>正在锁定当前要点与评估范围，很快就可以开始作答。</p>
                </div>
                <div className="companion-stage-activity" aria-hidden="true"><i /><i /><i /></div>
              </div>
            )}

            {state === "modeSelect" && (
              <div className="companion-stage-answer-workspace">
                <div className="companion-stage-answer-guidance">
                  <div>
                    <span className="companion-stage-answer-mode">本轮安排</span>
                    <p className="companion-stage-prompt">伴星已为这个要点选好作答方式，你也可以换成文字回答。</p>
                  </div>
                  <span className="companion-stage-answer-privacy"><Icon.Lock aria-hidden="true" />原文暂时隐藏</span>
                </div>
                <div className="companion-stage-mode-options" role="radiogroup" aria-label="选择作答方式">
                  {activeJourneyPlan?.mode === "silent" ? (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selectedMode === "silent"}
                      onClick={() => setSelectedMode("silent")}
                      className="companion-stage-mode-option"
                      disabled={voiceSubmitting || leaving}
                    >
                      <Icon.Edit aria-hidden="true" />
                      <span>
                        <strong>结构式证明</strong>
                        <small>排序 + 修复练习，不强制打字</small>
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selectedMode === "voice"}
                    onClick={() => setSelectedMode("voice")}
                    className="companion-stage-mode-option"
                    disabled={voiceSubmitting || leaving}
                  >
                    <Icon.Bolt aria-hidden="true" />
                    <span>
                      <strong>语音回答</strong>
                      <small>按住说话，确认逐字转写后提交</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selectedMode === "text"}
                    onClick={() => setSelectedMode("text")}
                    className="companion-stage-mode-option"
                    disabled={voiceSubmitting || leaving}
                  >
                    <Icon.Arrow aria-hidden="true" />
                    <span>
                      <strong>文字回答</strong>
                      <small>用自己的话写下理解（默认兜底）</small>
                    </span>
                  </button>
                </div>
                <div className="companion-stage-answer-footer">
                  <div className="companion-stage-answer-meta">
                    <span>{selectedMode === "voice" ? "语音转写将逐字确认后再提交" : "不需要复述标准答案"}</span>
                  </div>
                  <div className="companion-stage-actions">
                    {selectedMode === "voice" ? (
                      <VoiceTeachBackScene
                        voiceUnavailable={false}
                        language="zh-CN"
                        onTranscribe={async (audio, meta) =>
                          (await transcribePlain(audio, {
                            language: meta.language ?? "zh-CN",
                          })).text
                        }
                        onSubmit={(transcript) => void submitVoiceTranscript(transcript)}
                        ariaLabel="语音回答（练习页）"
                      />
                    ) : selectedMode === "silent" && activeJourneyPlan?.scenes?.length ? (
                      <SilentProofSceneList
                        scenes={activeJourneyPlan.scenes}
                        onSubmit={(payload) => void submitSilentProof(payload)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setState("ready")}
                        className="companion-stage-primary"
                        disabled={leaving}
                      >
                        使用文字作答
                        <Icon.Arrow aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {state === "ready" && (
              <div className="companion-stage-answer-workspace">
                <div className="companion-stage-answer-guidance">
                  <div>
                    <span className="companion-stage-answer-mode">闭卷回忆</span>
                    <p className="companion-stage-prompt">不必追求标准表述，先写出你现在最确定的部分。</p>
                  </div>
                  <span className="companion-stage-answer-privacy"><Icon.Lock aria-hidden="true" />原文暂时隐藏</span>
                </div>
                <div className="companion-stage-answer-field">
                  <label className="companion-stage-field-label" htmlFor="companion-answer">你的回答</label>
                  <textarea
                    id="companion-answer"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    className="companion-stage-answer"
                    placeholder="例如：我认为这个概念的关键在于……"
                    maxLength={8_000}
                    autoFocus
                  />
                </div>
                <div className="companion-stage-answer-footer">
                  <div className="companion-stage-answer-meta">
                    <span>{answer.trim().length} 字</span>
                    <span>写下关键关系或自己的例子就足够了</span>
                  </div>
                  <div className="companion-stage-actions">
                    <button type="button" onClick={() => void endStage()} className="companion-stage-secondary" disabled={leaving}>暂不练习</button>
                    <button
                      type="button"
                      onClick={() => void submitAnswer()}
                      disabled={answer.trim() === ""}
                      className="companion-stage-primary"
                    >
                      提交回答
                      <Icon.Arrow aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {state === "submitting" && (
              <div className="companion-stage-status is-saving" role="status" aria-live="polite">
                <span className="companion-stage-status-icon"><Icon.Lock aria-hidden="true" /></span>
                <div className="companion-stage-status-copy">
                  <span>锁定回答</span>
                  <strong>正在保存你的回答…</strong>
                  <p>保存完成后才会开始独立评估，期间不再展示或补充原文。</p>
                </div>
                <div className="companion-stage-activity" aria-hidden="true"><i /><i /><i /></div>
              </div>
            )}

            {state === "assessing" && (
              <div className="companion-stage-assessment" role="status" aria-live="polite">
                <div className="companion-stage-status">
                  <span className="companion-stage-status-icon"><Icon.Sparkle aria-hidden="true" /></span>
                  <div className="companion-stage-status-copy">
                    <span>{processingPhase === "assessment_complete" || processingPhase === "commit_pending" ? "整理结果" : "独立评估"}</span>
                    <strong>
                      {processingPhase === "assessment_complete" || processingPhase === "commit_pending"
                        ? "评估已完成，正在写入结果…"
                        : "回答已保存，正在等待独立评估…"}
                    </strong>
                    <p>{processingPhase === "assessment_complete" || processingPhase === "commit_pending"
                      ? "评估已经完成，最后一步会把本轮结果同步到你的学习记录。"
                      : "系统正在单独检查这次回答。在结果写入前，本轮不会提前标记为完成。"}</p>
                  </div>
                  <div className="companion-stage-activity" aria-hidden="true"><i /><i /><i /></div>
                </div>
                <AssessmentProgress phase={processingPhase} />
                <p className="companion-stage-processing-note"><Icon.Lock aria-hidden="true" />你的回答已经安全保存，可以留在这里查看进度。</p>
              </div>
            )}

            {state === "result" && processingPhase === "committed" && (
              <div className="companion-stage-result" role="status" aria-live="polite">
                <span className="companion-stage-result-icon"><Icon.Check aria-hidden="true" /></span>
                <div className="companion-stage-state-copy">
                  <span>本轮完成</span>
                  <strong>巩固练习已完成</strong>
                  <p>回答、独立评估和学习记录都已保存。你可以回到学习卡继续阅读，或稍后查看新的复习安排。</p>
                </div>
                <AssessmentProgress phase={processingPhase} />
                <div className="companion-stage-actions">
                  <button type="button" onClick={() => void endStage()} className="companion-stage-primary" disabled={leaving}>
                    返回学习卡 <Icon.Arrow aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            {state === "timeout" && (
              <div className="companion-stage-timeout" role="status" aria-live="polite">
                <span className="companion-stage-result-icon is-pending"><Icon.Refresh aria-hidden="true" /></span>
                <div className="companion-stage-state-copy">
                  <span>等待时间较长</span>
                  <strong>评估仍在处理中</strong>
                  <p>等待时间超过预期，当前没有可展示的评估结论。你可以继续等待，或结束练习后返回学习卡。</p>
                </div>
                <AssessmentProgress phase={processingPhase} />
                <div className="companion-stage-actions">
                  <button
                    type="button"
                    className="companion-stage-secondary"
                    onClick={() => session && episodeId && void pollAssessment(session.sessionId, episodeId)}
                  >
                    继续等待
                  </button>
                  <button type="button" onClick={() => void endStage()} className="companion-stage-primary" disabled={leaving}>结束并返回</button>
                </div>
              </div>
            )}

            {state === "error" && (
              <div className="companion-stage-error" role="alert" data-error-kind={normalizeErrorCode(errorCode) ?? "UNKNOWN"}>
                <span className="companion-stage-error-icon"><Icon.Warn aria-hidden="true" /></span>
                <div className="companion-stage-state-copy">
                  <span>{currentError.settingsAction ? "需要一次确认" : normalizeErrorCode(errorCode) === "SESSION_LIMIT_REACHED" ? "检测到进行中的练习" : "本轮无法继续"}</span>
                  <strong>{currentError.title}</strong>
                  <p>{currentError.detail}</p>
                </div>
                <div className="companion-stage-actions">
                  {normalizeErrorCode(errorCode) === "SESSION_LIMIT_REACHED" && blockedSessionId && (
                    <button
                      type="button"
                      onClick={() => void replaceBlockedSession()}
                      className="companion-stage-primary"
                      disabled={recoveringSession || leaving}
                    >
                      {recoveringSession ? "正在结束旧练习…" : "结束旧练习并重新开始"}
                      {!recoveringSession && <Icon.Refresh aria-hidden="true" />}
                    </button>
                  )}
                  {currentError.settingsAction && (
                    <button
                      type="button"
                      onClick={() => void endStage("/settings#model")}
                      className="companion-stage-primary"
                      disabled={leaving}
                    >
                      前往协议设置 <Icon.Arrow aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void endStage(`/cards/${encodeURIComponent(cardId)}`)}
                    className={currentError.settingsAction || blockedSessionId ? "companion-stage-secondary" : "companion-stage-primary"}
                    disabled={leaving}
                  >
                    回到学习卡
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <p className="companion-stage-footer-note">
          <Icon.Lock aria-hidden="true" />
          系统只会在评估写入完成后标记本轮完成。
        </p>
      </div>
    </main>
  );
}

function AssessmentProgress({
  phase,
}: {
  phase: LearningEpisodeProcessingPhase | null;
}) {
  const assessmentDone = phase === "assessment_complete" || phase === "commit_pending" || phase === "committed";
  const commitDone = phase === "committed";
  return (
    <ol className="companion-stage-assessment-progress" aria-label="评估处理进度">
      <li className="is-complete"><Icon.Check aria-hidden="true" /><span>回答已保存</span></li>
      <li className={assessmentDone ? "is-complete" : "is-active"}>
        {assessmentDone ? <Icon.Check aria-hidden="true" /> : <i aria-hidden="true" />}
        <span>独立评估</span>
      </li>
      <li className={commitDone ? "is-complete" : assessmentDone ? "is-active" : ""}>
        {commitDone ? <Icon.Check aria-hidden="true" /> : <i aria-hidden="true" />}
        <span>写入结果</span>
      </li>
    </ol>
  );
}

/**
 * 任务 14 接线：silent 场景列表渲染（journeyPlan.scenes → SilentProofScene）。
 * 场景 public 数据由服务端 createSession 时确定性生成并随 journeyPlan 下发，
 * 前端直接消费（不再 fail-closed，§3.6）。
 */
function SilentProofSceneList({
  scenes,
  onSubmit,
}: {
  scenes: NonNullable<LearningSessionEpisode["journeyPlan"]["scenes"]>;
  onSubmit: (payload: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="silent-proof-scene-list">
      {scenes.map((scene) => {
        // journeyPlan.scenes 的 publicPayload 对齐 SilentProofScene 的
        // tap-select 适配输入（ordering/repair）；secret 由服务端持有，
        // 前端渲染只读 public（01-2 §3.2 物理分离）。
        const adapted = {
          sceneId: scene.sceneId,
          sceneType: scene.sceneType,
          public: scene.publicPayload,
          // 前端不接触 secret：给最小占位让类型满足 LearningScene 形状
          //（secret 只在服务端存在，此处不会被读取）。
          secret: {
            correctOrderIds: [],
            distractorItemIds: [],
            acceptPermutedGroups: [],
            rationaleRefs: [],
          },
        } as unknown as LearningScene;
        return (
          <SilentProofScene
            key={scene.sceneId}
            scene={adapted}
            onSubmit={(payload) => onSubmit({ sceneId: scene.sceneId, ...(payload as object) })}
            ariaLabel={`结构式证明：${scene.sceneType === "ordering" ? "排序" : "修复"}`}
          />
        );
      })}
    </div>
  );
}
