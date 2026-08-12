"use client";

import { useEffect, useRef, useState } from "react";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import type { PetAdapterV1 } from "../desktop/desktop-pet-adapter";
import { PetIcon, type PetIconNameV1 } from "./PetIcon";
import { createLearningMenuProposal, fetchLearningContext } from "../learning-actions";
import { api } from "@/lib/api";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";

interface MenuItemV1 {
  id: string;
  label: string;
  description?: string;
  icon: PetIconNameV1;
  stage?: "P3" | "P5";
  candidateId?: "resume_current" | "start_short";
  disabled?: boolean;
  disabledNote?: string;
  danger?: boolean;
  action:
    | "say"
    | "voice"
    | "learning"
    | "study"
    | "more"
    | "back"
    | "full_conversation"
    | "auto_voice"
    | "privacy"
    | "lock"
    | "always_on_top"
    | "hide"
    | "settings"
    | "quit_pet";
}

const ROOT_ITEMS: readonly MenuItemV1[] = [
  { id: "say", label: "说句话", description: "打开快捷输入", icon: "message", action: "say" },
  { id: "voice", label: "语音对话", description: "点按开始，再点结束", icon: "microphone", action: "voice", stage: "P3" },
  { id: "study", label: "学习", description: "继续与复习", icon: "study", action: "study" },
  { id: "more", label: "更多", description: "历史与设置", icon: "more", action: "more" },
];

const STUDY_ITEMS: readonly MenuItemV1[] = [
  { id: "resume", label: "继续当前学习", icon: "study", action: "learning", candidateId: "resume_current", stage: "P5", disabledNote: "当前没有可继续的学习" },
  { id: "start", label: "开始一小段学习", icon: "sparkles", action: "learning", candidateId: "start_short", stage: "P5", disabledNote: "当前没有可开始的学习" },
  { id: "review", label: "今日复习", icon: "review", action: "say", stage: "P5", disabled: true, disabledNote: "将在学习能力阶段开放" },
  { id: "card", label: "回到当前卡片", icon: "card", action: "say", stage: "P5", disabled: true, disabledNote: "将在学习能力阶段开放" },
  { id: "study-back", label: "返回", icon: "back", action: "back" },
];

const MORE_ITEMS: readonly MenuItemV1[] = [
  { id: "full_conversation", label: "完整对话", description: "查看全部历史", icon: "history", action: "full_conversation" },
  { id: "auto_voice", label: "自动播报", description: "回复自动朗读，可随时关闭", icon: "volume", action: "auto_voice" },
  { id: "privacy", label: "隐私模式", description: "主动消息只提示、不显示正文", icon: "shield", action: "privacy" },
  { id: "lock", label: "锁定位置", icon: "lock", action: "lock" },
  { id: "always_on_top", label: "窗口置顶", icon: "pin", action: "always_on_top" },
  { id: "hide", label: "暂时隐藏", icon: "hide", action: "hide" },
  { id: "settings", label: "伴星设置", icon: "settings", action: "settings" },
  { id: "quit_pet", label: "退出桌宠模式", icon: "power", action: "quit_pet", danger: true },
  { id: "more-back", label: "返回", icon: "back", action: "back" },
];

function activate(
  item: MenuItemV1,
  runtime: ReturnType<typeof usePetRuntime>,
  adapter: PetAdapterV1,
  onError?: (message: string) => void,
): void {
  if (item.disabled) return;
  const { dispatch, state } = runtime;
  switch (item.action) {
    case "say":
      dispatch({ type: "composer.opened" });
      dispatch({ type: "menu.closed" });
      break;
    case "voice":
      dispatch({ type: "menu.closed" });
      dispatch({ type: "voice.toggle_requested" });
      break;
    case "learning":
      break;
    case "study":
      dispatch({ type: "menu.navigated", target: "study" });
      break;
    case "more":
      dispatch({ type: "menu.navigated", target: "more" });
      break;
    case "back":
      dispatch({ type: "menu.navigated", target: "root" });
      break;
    case "full_conversation":
      dispatch({ type: "menu.closed" });
      void adapter.openMainRoute({ kind: "conversation" });
      break;
    case "auto_voice":
      // P6 §13.4：自动播报 = 账号级 voiceOff 开关（合同 01 §3.3）。
      // PATCH 前先取最新 revision（CAS 乐观锁）；成功后本地收敛
      // （reducer 会停掉正在播放的语音），bootstrap 轮询随后幂等对齐。
      void (async () => {
        try {
          const overview = await api.getCompanionOverview();
          const nextVoiceOff = !state.context.voiceOff;
          const updated = await api.updateCompanionAccount({
            revision: overview.account.revision,
            voiceOff: nextVoiceOff,
          });
          dispatch({
            type: "account.preferences_changed",
            accountEpoch: updated.epoch,
            animationOff: updated.animationOff ?? false,
            voiceOff: updated.voiceOff ?? false,
          });
        } catch {
          onError?.("播报设置保存失败，请稍后重试");
        }
      })();
      break;
    case "privacy":
      void adapter.setPrivacyMode(!state.context.privacyMode);
      break;
    case "lock":
      void adapter.setLocked(!(runtime.windowState?.locked ?? false));
      break;
    case "always_on_top":
      void adapter.setAlwaysOnTop(!(runtime.windowState?.alwaysOnTop ?? false));
      break;
    case "hide":
      dispatch({ type: "menu.closed" });
      void adapter.hidePet();
      break;
    case "settings":
      dispatch({ type: "menu.closed" });
      void adapter.openMainRoute({ kind: "settings", section: "pet" });
      break;
    case "quit_pet":
      void adapter.setPetModeEnabled(false);
      break;
  }
}

function itemState(item: MenuItemV1, runtime: ReturnType<typeof usePetRuntime>): boolean | null {
  switch (item.action) {
    case "auto_voice":
      return !runtime.state.context.voiceOff;
    case "privacy":
      return runtime.state.context.privacyMode;
    case "lock":
      return runtime.windowState?.locked ?? false;
    case "always_on_top":
      return runtime.adapter.kind === "electron" ? runtime.windowState?.alwaysOnTop ?? false : null;
    default:
      return null;
  }
}

export function PetMenu({ learningActionsEnabled = false }: { learningActionsEnabled?: boolean }) {
  const runtime = usePetRuntime();
  const { state, dispatch, adapter } = runtime;
  const level = state.menu.kind;
  const [focusIndex, setFocusIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);
  const [learningContext, setLearningContext] = useState<CompanionLearningContextV1 | null>(null);
  const [learningContextStatus, setLearningContextStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [learningProposalBusy, setLearningProposalBusy] = useState(false);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const learningAttemptRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
    clientMessageId: string;
  } | null>(null);
  const previousLevelRef = useRef(level);

  const items = level === "root" ? ROOT_ITEMS : level === "study" ? STUDY_ITEMS : level === "more" ? MORE_ITEMS : [];

  useEffect(() => {
    if (level === "closed") {
      if (previousLevelRef.current !== "closed") {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(".pet-character-menu-button, .pet-character-hit-zone")?.focus();
        });
      }
      previousLevelRef.current = level;
      return;
    }
    setFocusIndex(0);
    setStatusMessage("");
    setConfirmExit(false);
    itemRefs.current = [];
    window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
    previousLevelRef.current = level;
  }, [level]);

  useEffect(() => {
    if (level !== "closed") itemRefs.current[focusIndex]?.focus();
  }, [focusIndex, level]);

  useEffect(() => {
    if (level !== "study" || !learningActionsEnabled) {
      setLearningContext(null);
      setLearningContextStatus("idle");
      return;
    }
    let cancelled = false;
    setLearningContextStatus("loading");
    void fetchLearningContext()
      .then((context) => {
        if (cancelled) return;
        setLearningContext(context);
        setLearningContextStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setLearningContext(null);
        setLearningContextStatus("error");
        setStatusMessage("学习状态暂时无法读取，请稍后再试");
      });
    return () => {
      cancelled = true;
    };
  }, [level, learningActionsEnabled]);

  if (level === "closed") return null;

  const title = level === "root" ? "和伴星一起" : level === "study" ? "学习快捷方式" : "伴星与桌面";
  const subtitle = level === "root" ? "选择接下来要做的事" : level === "study" ? "先确认，再改变学习状态" : "历史、隐私和窗口偏好";

  const learningCandidateFor = (item: MenuItemV1) => {
    if (!item.candidateId || !learningContext) return null;
    return item.candidateId === "resume_current"
      ? learningContext.resumeCandidate
      : learningContext.startCandidate;
  };

  const runLearningItem = async (item: MenuItemV1) => {
    if (!learningActionsEnabled || !item.candidateId) {
      setStatusMessage("学习动作暂未开放");
      return;
    }
    const candidate = learningCandidateFor(item);
    if (!candidate || !learningContext) {
      setStatusMessage(item.disabledNote ?? "当前没有可用的学习动作");
      return;
    }
    const context = learningContext;
    const sourceSurface = adapter.kind === "browser" ? "web_fallback" : "pet";
    const fingerprint = [
      item.candidateId,
      context.contextRevision,
      candidate.payloadSha256,
      sourceSurface,
      runtime.state.context.conversationId ?? "",
    ].join("|");
    const attempt = learningAttemptRef.current?.fingerprint === fingerprint
      ? learningAttemptRef.current
      : {
          fingerprint,
          idempotencyKey: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
        };
    learningAttemptRef.current = attempt;
    setLearningProposalBusy(true);
    setStatusMessage("正在确认当前学习状态…");
    try {
      const response = await createLearningMenuProposal({
        candidateId: item.candidateId,
        contextRevision: context.contextRevision,
        payloadSha256: candidate.payloadSha256,
        sourceSurface,
        conversationId: runtime.state.context.conversationId ?? undefined,
        idempotencyKey: attempt.idempotencyKey,
        clientMessageId: attempt.clientMessageId,
      });
      learningAttemptRef.current = null;
      dispatch({
        type: "bubble.learning_proposal_received",
        proposalId: response.proposal.proposalId,
        actionName: response.proposal.title,
        target: response.proposal.targetSummary,
        impact: response.proposal.impactSummary,
      });
    } catch {
      setStatusMessage("提交失败，可重试");
    } finally {
      setLearningProposalBusy(false);
    }
  };

  const runItem = (item: MenuItemV1) => {
    const candidate = learningCandidateFor(item);
    const learningDisabled = item.action === "learning" && (
      learningProposalBusy ||
      !learningActionsEnabled ||
      learningContextStatus !== "ready" ||
      !candidate
    );
    if (item.disabled || learningDisabled) {
      if (item.action === "learning" && learningContextStatus === "loading") {
        setStatusMessage("正在读取学习状态…");
        return;
      }
      setStatusMessage(item.disabledNote ?? "此功能暂未开放");
      return;
    }
    if (item.action === "quit_pet" && !confirmExit) {
      setConfirmExit(true);
      setStatusMessage("再次选择“确认退出桌宠”才会关闭桌宠模式");
      return;
    }
    if (item.action === "learning") {
      void runLearningItem(item);
      return;
    }
    activate(item, runtime, adapter, setStatusMessage);
  };

  const moveFocus = (key: string) => {
    if (key === "Home") return 0;
    if (key === "End") return items.length - 1;
    if (level === "root") {
      if (key === "ArrowRight") return Math.min(items.length - 1, focusIndex + 1);
      if (key === "ArrowLeft") return Math.max(0, focusIndex - 1);
      if (key === "ArrowDown") return Math.min(items.length - 1, focusIndex + 2);
      if (key === "ArrowUp") return Math.max(0, focusIndex - 2);
    }
    if (key === "ArrowDown") return (focusIndex + 1) % items.length;
    if (key === "ArrowUp") return (focusIndex - 1 + items.length) % items.length;
    return focusIndex;
  };

  return (
    <section
      className={`pet-menu pet-menu-${level}`}
      data-pet-region="menu"
      data-menu-level={level}
      aria-label="伴星菜单"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (level === "root") dispatch({ type: "menu.closed" });
          else dispatch({ type: "menu.navigated", target: "root" });
          return;
        }
        if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          setFocusIndex(moveFocus(event.key));
        }
      }}
    >
      <header className="pet-menu-header">
        <span className="pet-menu-emblem"><PetIcon name={level === "study" ? "study" : level === "more" ? "settings" : "sparkles"} /></span>
        <span className="pet-menu-heading">
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </span>
        <button type="button" className="pet-icon-button" aria-label="关闭菜单" onClick={() => dispatch({ type: "menu.closed" })}>
          <PetIcon name="close" />
        </button>
      </header>

      <div className={`pet-menu-list${level === "root" ? " is-grid" : ""}`} role="menu">
        {items.map((item, index) => {
          const stateValue = itemState(item, runtime);
          const isBrowserOnlyUnsupported = adapter.kind === "browser" && item.action === "always_on_top";
          const candidate = learningCandidateFor(item);
          const learningDisabled = item.action === "learning" && (
            learningProposalBusy ||
            !learningActionsEnabled ||
            learningContextStatus !== "ready" ||
            !candidate
          );
          const disabled = item.disabled || learningDisabled || isBrowserOnlyUnsupported;
          const disabledNote = item.action === "learning" && !learningActionsEnabled
            ? "将在学习能力阶段开放"
            : item.action === "learning" && learningContextStatus === "loading"
              ? "正在读取学习状态"
              : item.disabledNote;
          const exitArmed = item.action === "quit_pet" && confirmExit;
          const role = stateValue === null ? "menuitem" : "menuitemcheckbox";
          return (
            <button
              key={item.id}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role={role}
              tabIndex={index === focusIndex ? 0 : -1}
              className={`pet-menu-item${disabled ? " is-disabled" : ""}${item.danger ? " is-danger" : ""}${exitArmed ? " is-armed" : ""}`}
              aria-disabled={disabled || undefined}
              aria-checked={stateValue === null ? undefined : stateValue}
              title={disabled ? (isBrowserOnlyUnsupported ? "仅桌面应用支持" : disabledNote) : undefined}
              onFocus={() => setFocusIndex(index)}
              onClick={() => {
                if (isBrowserOnlyUnsupported) {
                  setStatusMessage("窗口置顶只在桌面应用中可用");
                  return;
                }
                runItem(item);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (isBrowserOnlyUnsupported) setStatusMessage("窗口置顶只在桌面应用中可用");
                  else runItem(item);
                }
              }}
            >
              <span className="pet-menu-item-icon"><PetIcon name={item.icon} /></span>
              <span className="pet-menu-item-copy">
                <strong>{exitArmed ? "确认退出桌宠" : item.label}</strong>
                {level === "root" && item.description ? <small>{item.description}</small> : null}
                {level !== "root" && item.description ? <small>{item.description}</small> : null}
              </span>
              {item.stage ? <span className="pet-stage-chip">{item.stage}</span> : null}
              {stateValue !== null ? (
                <span className={`pet-toggle${stateValue ? " is-on" : ""}`} aria-hidden="true"><i /></span>
              ) : item.action === "study" || item.action === "more" || item.action === "full_conversation" ? (
                <PetIcon name="chevron" className="pet-menu-chevron" />
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="pet-menu-status" role="status" aria-live="polite">
        {statusMessage || (level === "root" ? "右键或长按角色也能再次打开这里" : "Esc 返回上一层")}
      </p>
    </section>
  );
}
