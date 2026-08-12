"use client";

import { useEffect, useMemo, useState } from "react";
import { createPetAdapter } from "../desktop/desktop-pet-adapter";
import { PetRuntimeProvider, usePetRuntime } from "../runtime/PetRuntimeProvider";
import { PetSurface } from "../surfaces/PetSurface";
import { PetBubble } from "../surfaces/PetBubble";
import { PetComposer } from "../surfaces/PetComposer";
import { PetConfirmationCard } from "../surfaces/PetConfirmationCard";
import { PetMenu } from "../surfaces/PetMenu";
import { PetIcon } from "../surfaces/PetIcon";
import {
  COMPANION_BOOTSTRAP_POLL_MS,
  fetchCompanionBootstrap,
  openCompanionAccountEventStream,
} from "../bootstrap";

/**
 * Browser fallback (01 §2.4): no Electron APIs. Standard mode reuses the
 * 560×520 surface pinned to the viewport bottom-right; compact mode (below
 * 600×560 CSS px, including 200% page zoom) collapses to a 96×132 character
 * button with a bottom popover. The root never blocks the page — only the
 * interactive sub-regions capture pointer events.
 */

const STANDARD_MIN_WIDTH = 600;
const STANDARD_MIN_HEIGHT = 560;

function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState<{ width: number; height: number }>(() => ({
    width: typeof window === "undefined" ? 1280 : window.visualViewport?.width ?? window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.visualViewport?.height ?? window.innerHeight,
  }));
  useEffect(() => {
    // 2026-08-11（性能专项）：rAF 合并——移动端滚动/缩放时 visualViewport
    // scroll/resize 高频触发，逐事件 setSize 会整棵 Provider 树重渲染。
    let rafHandle = 0;
    const update = () => {
      if (rafHandle !== 0) return;
      rafHandle = window.requestAnimationFrame(() => {
        rafHandle = 0;
        setSize({
          width: window.visualViewport?.width ?? window.innerWidth,
          height: window.visualViewport?.height ?? window.innerHeight,
        });
      });
    };
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      if (rafHandle !== 0) window.cancelAnimationFrame(rafHandle);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return size;
}

export function InAppPetHost() {
  const { width, height } = useViewportSize();
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [temporarilyHidden, setTemporarilyHidden] = useState(false);
  const adapter = useMemo(() => createPetAdapter(undefined, {
    onDragBy(deltaX, deltaY) {
      setPosition((current) => {
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const minX = Math.min(0, 576 - viewportWidth);
        const minY = Math.min(0, 536 - viewportHeight);
        return {
          x: Math.max(minX, Math.min(0, current.x + deltaX)),
          y: Math.max(minY, Math.min(0, current.y + deltaY)),
        };
      });
    },
    onHide() {
      setTemporarilyHidden(true);
    },
    onMoveToSafePosition() {
      setPosition({ x: 0, y: 0 });
    },
  }), []);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [account, setAccount] = useState<
    | {
        userId: string;
        workspaceId: string;
        globalEnabled: boolean;
        accountEpoch: number;
        animationOff?: boolean;
        voiceOff?: boolean;
      }
    | undefined
    | null
  >(null);
  const [textConversationEnabled, setTextConversationEnabled] = useState(false);
  const [voiceDialogueEnabled, setVoiceDialogueEnabled] = useState(false);
  const [live2dEnabled, setLive2dEnabled] = useState(false);
  const [learningActionsEnabled, setLearningActionsEnabled] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(media.matches);
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Browser fallback bootstraps the same account projection; without a login
  // session the fallback stays hidden (it is a companion, not a page widget).
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const syncAccount = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const body = await fetchCompanionBootstrap();
        if (cancelled) return;
        setTextConversationEnabled(body.features.textConversation);
        setVoiceDialogueEnabled(body.features.voiceDialogue);
        setLive2dEnabled(body.features.live2d);
        setLearningActionsEnabled(body.features.learningActions);
        if (body.account?.globalEnabled === false) {
          setAccount(undefined);
          return;
        }
        setAccount({
          userId: body.userId,
          workspaceId: body.workspaceId,
          globalEnabled: body.account?.globalEnabled ?? true,
          accountEpoch: body.account?.epoch ?? 0,
          animationOff: body.account?.animationOff,
          voiceOff: body.account?.voiceOff,
        });
      } catch (error) {
        void error;
        if (!cancelled) setAccount(undefined);
      } finally {
        inFlight = false;
      }
    };
    void syncAccount();
    const pollTimer = window.setInterval(() => void syncAccount(), COMPANION_BOOTSTRAP_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
    };
  }, []);

  const accountUserId = account?.userId;
  const accountEpoch = account?.accountEpoch;

  useEffect(() => {
    if (!accountUserId || accountEpoch === undefined) return;
    return openCompanionAccountEventStream({
      userId: accountUserId,
      after: accountEpoch,
      onGlobalOff: (epoch) => {
        setAccount((current) => {
          if (!current || epoch < current.accountEpoch) return current;
          return undefined;
        });
      },
    });
  }, [accountEpoch, accountUserId]);

  if (account === null || account === undefined) return null;

  if (temporarilyHidden) {
    return (
      <button
        type="button"
        className="in-app-pet-restore"
        onClick={() => setTemporarilyHidden(false)}
        aria-label="唤回学习伴星"
      >
        <PetIcon name="sparkles" />
        <span>唤回伴星</span>
      </button>
    );
  }

  const compact = width < STANDARD_MIN_WIDTH || height < STANDARD_MIN_HEIGHT;
  const exposeDemoApi = process.env.NODE_ENV !== "production";

  return (
    <PetRuntimeProvider
      adapter={adapter}
      surfaceKind="web_fallback"
      reducedMotion={reducedMotion}
      animationOff={false}
      account={account}
      textConversationEnabled={textConversationEnabled}
      voiceDialogueEnabled={voiceDialogueEnabled}
    >
      {compact ? (
        <CompactPetHost
          exposeDemoApi={exposeDemoApi}
          learningActionsEnabled={learningActionsEnabled}
          voiceAvailable={voiceDialogueEnabled || !textConversationEnabled}
        />
      ) : (
        <div
          className="in-app-pet-host"
          data-mode="standard"
          aria-label="学习伴星"
          style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
        >
          <PetSurface
            side="bubble-left"
            petScale={1}
            reducedMotion={reducedMotion}
            animationOff={account.animationOff ?? false}
            live2dEnabled={live2dEnabled}
            exposeDemoApi={exposeDemoApi}
            textConversationEnabled={textConversationEnabled}
            voiceDialogueEnabled={voiceDialogueEnabled}
            learningActionsEnabled={learningActionsEnabled}
          />
        </div>
      )}
    </PetRuntimeProvider>
  );
}

function CompactPetHost({
  exposeDemoApi,
  learningActionsEnabled,
  voiceAvailable,
}: {
  exposeDemoApi: boolean;
  learningActionsEnabled: boolean;
  voiceAvailable: boolean;
}) {
  const runtime = usePetRuntime();
  const [open, setOpen] = useState(false);
  const { state, dispatch } = runtime;
  const voiceListening = state.voice.kind === "listening";
  const voiceProcessing = state.voice.kind === "finalizing" || state.voice.kind === "transcribing";

  useEffect(() => {
    if (!exposeDemoApi) return;
    (window as unknown as Record<string, unknown>).__PET_DEMO__ = runtime.demo;
    return () => {
      delete (window as unknown as Record<string, unknown>).__PET_DEMO__;
    };
  }, [runtime.demo, exposeDemoApi]);

  const activeSurface = state.bubble.kind !== "hidden" || state.composer.kind !== "closed" || state.menu.kind !== "closed";

  return (
    <div className="in-app-pet-compact" data-open={open || activeSurface ? "true" : "false"}>
      {open && (
        <div className="in-app-pet-popover" role="dialog" aria-label="学习伴星">
          <PetBubble />
          <PetConfirmationCard />
          <PetComposer />
          <PetMenu learningActionsEnabled={learningActionsEnabled} />
          <button
            type="button"
            className="in-app-pet-popover-close"
            aria-label="收起伴星"
            onClick={() => {
              setOpen(false);
              dispatch({ type: "menu.closed" });
              dispatch({ type: "composer.closed" });
              dispatch({ type: "bubble.dismissed" });
            }}
          >
            收起
          </button>
        </div>
      )}
      <div className="in-app-pet-compact-controls">
        <button
          type="button"
          className={`in-app-pet-voice-btn${voiceListening ? " is-listening" : ""}`}
          aria-label={voiceListening ? "结束语音录入并开始识别" : "开始语音录入"}
          aria-pressed={voiceListening}
          disabled={voiceProcessing || state.context.voiceOff || !voiceAvailable}
          onClick={() => {
            setOpen(true);
            dispatch({ type: "voice.toggle_requested" });
          }}
        >
          <PetIcon name={voiceListening ? "stop" : voiceProcessing ? "sparkles" : "microphone"} />
        </button>
        <button
          type="button"
          className="in-app-pet-character-btn"
          aria-label="学习伴星（点按打开）"
          aria-expanded={open || undefined}
          onClick={() => {
            setOpen((value) => !value);
            if (!open) dispatch({ type: "composer.opened" });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setOpen(true);
            dispatch({ type: "menu.opened" });
          }}
        >
          <span className="in-app-pet-character-btn-pose" aria-hidden="true">
            <img src="/images/companion/pet/sprite-v1/idle.png" alt="" />
          </span>
          <span className="in-app-pet-character-btn-label">伴星</span>
        </button>
      </div>
    </div>
  );
}
