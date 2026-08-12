"use client";

import { useEffect, useMemo, useState } from "react";
import type { DesktopPetScaleV1 } from "@ailearn/shared";
import { createPetAdapter, type PetAdapterV1 } from "@/features/companion-pet/desktop/desktop-pet-adapter";
import { PetRuntimeProvider } from "@/features/companion-pet/runtime/PetRuntimeProvider";
import { PetSurface } from "@/features/companion-pet/surfaces/PetSurface";
import { InAppPetHost } from "@/features/companion-pet/web-fallback/InAppPetHost";
import {
  COMPANION_BOOTSTRAP_POLL_MS,
  CompanionBootstrapError,
  fetchCompanionBootstrap,
  openCompanionAccountEventStream,
} from "@/features/companion-pet/bootstrap";
import { isCompanionPetV1Enabled } from "@/lib/feature-flags";
import "@/features/companion-pet/web-fallback/in-app-pet.css";
import "./pet.css";

/**
 * Pet Window route: transparent Pet surface with server capability bootstrap.
 * Text dialogue and Live2D are enabled only when the server grants their
 * independent capabilities; voice/learning remain independently fail-closed.
 */

type BootstrapViewV1 =
  | "checking"
  | "ready"
  | "auth_required"
  | "global_off"
  | "browser"
  | "error";

export default function PetPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapViewV1>("checking");
  const [petScale, setPetScale] = useState<DesktopPetScaleV1>(1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [textConversationEnabled, setTextConversationEnabled] = useState(false);
  const [voiceDialogueEnabled, setVoiceDialogueEnabled] = useState(false);
  const [streamingVoiceEnabled, setStreamingVoiceEnabled] = useState(false);
  const [live2dEnabled, setLive2dEnabled] = useState(false);
  const [learningActionsEnabled, setLearningActionsEnabled] = useState(false);
  // §13.1 companion_pet_v1：服务端账号 capability，控制用户是否可见新 Pet
  // surface。默认 fail-closed；Electron 路径以 bootstrap 投影为准，不再
  // 由 build-time flag 单独决定。
  const [petSurfaceEnabled, setPetSurfaceEnabled] = useState(false);
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
  >(undefined);
  const api = typeof window === "undefined" ? undefined : window.desktopAPI;
  const adapter = useMemo<PetAdapterV1>(() => createPetAdapter(api), [api]);

  useEffect(() => {
    setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!api) {
      setBootstrap("browser");
      return;
    }
    const desktopApi = api;
    const unsubscribe = desktopApi.onWindowStateChanged((state) => {
      setPetScale(state.petScale);
    });
    void desktopApi.getWindowState().then((state) => {
      setPetScale(state.petScale);
    });

    let cancelled = false;
    let inFlight = false;
    let lastReported: string | null = null;
    async function reportBootstrap(result: Parameters<typeof desktopApi.reportBootstrap>[0]) {
      if (lastReported === result.kind) return;
      lastReported = result.kind;
      try {
        await desktopApi.reportBootstrap(result);
      } catch {
        // Reporting is telemetry; it must not turn a valid bootstrap into an error.
      }
    }
    async function syncBootstrap() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const body = await fetchCompanionBootstrap();
        if (cancelled) return;
        if (body.account?.globalEnabled === false) {
          setAccount(undefined);
          setBootstrap("global_off");
          void reportBootstrap({ version: 1, kind: "global_off" });
          return;
        }
        setTextConversationEnabled(body.features.textConversation);
        setVoiceDialogueEnabled(body.features.voiceDialogue);
        setStreamingVoiceEnabled(body.features.streamingVoice);
        setLive2dEnabled(body.features.live2d);
        setLearningActionsEnabled(body.features.learningActions);
        setPetSurfaceEnabled(body.features.petSurface);
        setAccount({
          userId: body.userId,
          workspaceId: body.workspaceId,
          globalEnabled: body.account?.globalEnabled ?? true,
          accountEpoch: body.account?.epoch ?? 0,
          animationOff: body.account?.animationOff,
          voiceOff: body.account?.voiceOff,
        });
        setBootstrap("ready");
        void reportBootstrap({ version: 1, kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof CompanionBootstrapError && (error.status === 401 || error.status === 403)) {
          setBootstrap("auth_required");
          void reportBootstrap({ version: 1, kind: "auth_required" });
          return;
        }
        setBootstrap("error");
        void reportBootstrap({
          version: 1,
          kind: "fatal",
          code: "PET_BOOTSTRAP_FAILED",
        });
      } finally {
        inFlight = false;
      }
    }
    void syncBootstrap();
    const pollTimer = window.setInterval(() => void syncBootstrap(), COMPANION_BOOTSTRAP_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      unsubscribe();
    };
  }, [api]);

  const accountUserId = account?.userId;
  const accountEpoch = account?.accountEpoch;
  useEffect(() => {
    if (!api || !accountUserId) return;
    return openCompanionAccountEventStream({
      userId: accountUserId,
      after: accountEpoch ?? 0,
      onGlobalOff: (epoch) => {
        setAccount((current) => {
          if (!current || epoch < current.accountEpoch) return current;
          return undefined;
        });
        setBootstrap("global_off");
      },
    });
  }, [api, accountEpoch, accountUserId]);

  // Evidence-capture override: ?petSide=right renders the mirrored layout.
  const sideOverride = useMemo(() => {
    if (typeof window === "undefined") return null;
    const param = new URLSearchParams(window.location.search).get("petSide");
    return param === "right" ? ("bubble-right" as const) : null;
  }, []);

  if (bootstrap === "checking") {
    return <div className="pet-bootstrap" aria-live="polite">正在验证桌面会话…</div>;
  }
  if (bootstrap === "auth_required") {
    return (
      <div className="pet-bootstrap" role="status">
        需要先登录主窗口，再使用学习伴星。
      </div>
    );
  }
  if (bootstrap === "global_off") {
    return (
      <div className="pet-bootstrap" role="status">
        桌宠已由账号设置关闭。
      </div>
    );
  }
  if (bootstrap === "error") {
    return (
      <div className="pet-bootstrap" role="alert">
        桌宠初始化失败，请重新启动应用。
      </div>
    );
  }

  // P1 flag (runbook §13.1): fail-closed — surface only renders when the
  // build-time fallback switch is explicitly enabled.
  if (!isCompanionPetV1Enabled()) {
    return (
      <div className="pet-bootstrap" role="status">
        桌宠功能未启用。
      </div>
    );
  }

  // §13.1 companion_pet_v1：服务端 capability 未授予时（Electron 路径
  // bootstrap 投影 petSurface=false，或浏览器路径无能力），渲染占位而非
  // 角色表面。回滚语义：关闭开关即销毁 Pet surface，恢复普通 Main Window。
  if (api && !petSurfaceEnabled && bootstrap === "ready") {
    return (
      <div className="pet-bootstrap" role="status">
        桌宠功能未启用。
      </div>
    );
  }

  // Browser (no preload bridge): in-app fixed fallback, same surface code.
  if (bootstrap === "browser") {
    return <InAppPetHost />;
  }

  const surfaceKind = api ? "pet" : "web_fallback";
  const exposeDemoApi = process.env.NODE_ENV !== "production";
  return (
    <PetRuntimeProvider
      adapter={adapter}
      surfaceKind={surfaceKind}
      reducedMotion={reducedMotion}
      animationOff={false}
      account={account}
      textConversationEnabled={textConversationEnabled}
      voiceDialogueEnabled={voiceDialogueEnabled}
      streamingVoiceEnabled={streamingVoiceEnabled}
    >
      <PetSurface
        side={sideOverride ?? "bubble-left"}
        petScale={petScale}
        reducedMotion={reducedMotion}
        animationOff={account?.animationOff ?? false}
        live2dEnabled={live2dEnabled}
        exposeDemoApi={exposeDemoApi}
        textConversationEnabled={textConversationEnabled}
        voiceDialogueEnabled={voiceDialogueEnabled}
        learningActionsEnabled={learningActionsEnabled}
      />
    </PetRuntimeProvider>
  );
}
