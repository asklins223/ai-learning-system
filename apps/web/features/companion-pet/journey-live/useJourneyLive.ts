/**
 * Journey V2 前端状态 hook（文档 16 §10.1）。
 *
 * 消费 /companion/journey/bootstrap 与 invitation/journey actions；
 * 30 秒轮询 bootstrap（轻量；服务端权威投影 + 惰性 drain 已保证幂等）。
 * 只暴露用户意图动作，不暴露 next_step/complete/update_refs。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionInvitationV2, CompanionJourneyV2 } from "@ailearn/shared";
import {
  deferredUntilDefault,
  fetchJourneyBootstrap,
  journeyIdempotencyKey,
  sendInvitationAction,
  sendJourneyAction,
} from "./journey-live-client";

export const JOURNEY_BOOTSTRAP_POLL_MS = 30_000;

export type JourneyLiveStatus = "idle" | "loading" | "ready" | "error";

export interface JourneyLiveState {
  status: JourneyLiveStatus;
  invitation: CompanionInvitationV2 | null;
  journey: CompanionJourneyV2 | null;
  resumableJourney: CompanionJourneyV2 | null;
  error: string | null;
}

const INITIAL: JourneyLiveState = {
  status: "idle",
  invitation: null,
  journey: null,
  resumableJourney: null,
  error: null,
};

export interface UseJourneyLiveResult extends JourneyLiveState {
  refresh: () => Promise<void>;
  startJourney: (branch: "own_material" | "sandbox_sample" | "blank_note") => Promise<boolean>;
  deferInvitation: () => Promise<boolean>;
  skipInvitation: () => Promise<boolean>;
  pauseJourney: () => Promise<boolean>;
  resumeJourney: () => Promise<boolean>;
  dismissStepNarration: (step: CompanionJourneyV2["currentStep"]) => Promise<boolean>;
  skipJourney: () => Promise<boolean>;
  retryJourney: () => Promise<boolean>;
  switchBranch: (branch: "own_material" | "sandbox_sample" | "blank_note") => Promise<boolean>;
}

export function useJourneyLive(enabled: boolean, workspaceId?: string | null): UseJourneyLiveResult {
  const [state, setState] = useState<JourneyLiveState>(INITIAL);
  const inFlightRef = useRef(false);

  const apply = useCallback((next: Partial<JourneyLiveState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const bootstrap = await fetchJourneyBootstrap();
      apply({
        status: "ready",
        invitation: bootstrap.invitation,
        journey: bootstrap.journey,
        resumableJourney: bootstrap.resumableJourney,
        error: null,
      });
    } catch (err) {
      apply({
        status: err instanceof Error ? "error" : "error",
        error: err instanceof Error ? err.message : "旅程状态加载失败",
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [apply]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), JOURNEY_BOOTSTRAP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  const runInvitationAction = useCallback(async (
    action: Parameters<typeof sendInvitationAction>[0]["action"],
    label: string,
  ): Promise<boolean> => {
    const invitation = state.invitation;
    if (!invitation) return false;
    try {
      const updated = await sendInvitationAction({
        expectedRevision: invitation.revision,
        action,
        idempotencyKey: journeyIdempotencyKey(`invitation:${label}`),
      });
      apply({ invitation: updated });
      if (updated.journey) {
        // start_journey 成功：服务端已创建旅程，拉取权威投影。
        await refresh();
      }
      return true;
    } catch (err) {
      apply({ error: err instanceof Error ? err.message : `${label}失败` });
      return false;
    }
  }, [state.invitation, apply, refresh]);

  const runJourneyAction = useCallback(async (
    action: Parameters<typeof sendJourneyAction>[1]["action"],
    label: string,
  ): Promise<boolean> => {
    const journey = state.journey;
    if (!journey) return false;
    try {
      const updated = await sendJourneyAction(journey.journeyId, {
        expectedRevision: journey.revision,
        action,
        idempotencyKey: journeyIdempotencyKey(`journey:${label}`),
      });
      apply({ journey: updated });
      return true;
    } catch (err) {
      apply({ error: err instanceof Error ? err.message : `${label}失败` });
      return false;
    }
  }, [state.journey, apply]);

  return {
    ...state,
    refresh,
    startJourney: (branch) => {
      if (!workspaceId) return Promise.resolve(false);
      return runInvitationAction(
        { kind: "start_journey", workspaceId, branch },
        "start",
      );
    },
    deferInvitation: () => runInvitationAction(
      { kind: "defer", deferredUntil: deferredUntilDefault() },
      "defer",
    ),
    skipInvitation: () => runInvitationAction({ kind: "skip" }, "skip"),
    pauseJourney: () => runJourneyAction({ kind: "pause" }, "pause"),
    resumeJourney: () => runJourneyAction({ kind: "resume", resumeToken: null }, "resume"),
    dismissStepNarration: (step) =>
      step ? runJourneyAction({ kind: "dismiss_step_narration", step }, "dismiss") : Promise.resolve(false),
    skipJourney: () => runJourneyAction({ kind: "skip" }, "skip"),
    retryJourney: () => runJourneyAction({ kind: "retry" }, "retry"),
    switchBranch: (branch) => runJourneyAction({ kind: "switch_branch", branch }, "switch_branch"),
  };
}
