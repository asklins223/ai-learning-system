import {
  formalAssessmentGuardV1Schema,
  type FormalAssessmentGuardV1,
} from "@ailearn/shared/formal-assessment-guard-contracts";
import { learningRunPublicSnapshotV2Schema } from "@ailearn/shared/learning-run-v2-contracts";

type GuardKey = { runId: string; runtimeEpoch: number };

export const companionDeliveryKindValues = ["prompt", "proposal", "voice"] as const;
export type CompanionDeliveryKind = (typeof companionDeliveryKindValues)[number];

export type CompanionDeliveryDecision =
  | { allowed: true; kind: CompanionDeliveryKind }
  | { allowed: false; kind: CompanionDeliveryKind; reason: "formal_assessment_silence" | "guard_fail_closed" };

const TERMINAL_PHASES = new Set(["completed", "ended", "skipped", "cancelled", "stale"]);

function sameKey(left: GuardKey | null, right: GuardKey): boolean {
  return left?.runId === right.runId && left.runtimeEpoch === right.runtimeEpoch;
}

/**
 * Main-owned formal-assessment broker gate. It intentionally exposes no
 * renderer payload: callers can only ask whether proactive Companion
 * delivery is allowed, and unknown state always returns false.
 */
export class FormalAssessmentGuard {
  private state: FormalAssessmentGuardV1 = formalAssessmentGuardV1Schema.parse({
    version: 1,
    runId: null,
    runtimeEpoch: null,
    state: "fail_closed_silent",
    reason: "unknown",
  });

  getSnapshot(): FormalAssessmentGuardV1 {
    return formalAssessmentGuardV1Schema.parse(this.state);
  }

  allowsCompanionDelivery(): boolean {
    return this.state.state === "inactive";
  }

  /**
   * Main broker entry for every proactive Companion channel. It returns only
   * an authorization decision; prompt/proposal/voice payloads never cross
   * this guard and all non-inactive states remain silent.
   */
  authorizeCompanionDelivery(kind: CompanionDeliveryKind): CompanionDeliveryDecision {
    if (this.state.state === "inactive") return { allowed: true, kind };
    return {
      allowed: false,
      kind,
      reason: this.state.state === "fail_closed_silent" ? "guard_fail_closed" : "formal_assessment_silence",
    };
  }

  failClosed(reason: Extract<FormalAssessmentGuardV1["reason"], "unknown" | "stale" | "disconnected" | "epoch_mismatch" | "sensitivity_missing">, key?: GuardKey): FormalAssessmentGuardV1 {
    this.state = formalAssessmentGuardV1Schema.parse({
      version: 1,
      runId: key?.runId ?? null,
      runtimeEpoch: key?.runtimeEpoch ?? null,
      state: "fail_closed_silent",
      reason,
    });
    return this.getSnapshot();
  }

  arm(key: GuardKey, sensitivityAvailable: boolean): FormalAssessmentGuardV1 {
    if (!sensitivityAvailable) return this.failClosed("sensitivity_missing", key);
    this.state = formalAssessmentGuardV1Schema.parse({
      version: 1,
      ...key,
      state: "armed",
      reason: "awaiting_activation",
    });
    return this.getSnapshot();
  }

  activate(key: GuardKey): FormalAssessmentGuardV1 {
    if (this.state.state !== "armed" || !sameKey(this.state.runId && this.state.runtimeEpoch !== null ? { runId: this.state.runId, runtimeEpoch: this.state.runtimeEpoch } : null, key)) {
      return this.failClosed("stale", key);
    }
    this.state = formalAssessmentGuardV1Schema.parse({
      version: 1,
      ...key,
      state: "active",
      reason: "assessment_active",
    });
    return this.getSnapshot();
  }

  beginRelease(key: GuardKey, terminalProof: boolean): FormalAssessmentGuardV1 {
    if (!terminalProof || this.state.state !== "active" || !sameKey(this.state.runId && this.state.runtimeEpoch !== null ? { runId: this.state.runId, runtimeEpoch: this.state.runtimeEpoch } : null, key)) {
      return this.failClosed("stale", key);
    }
    this.state = formalAssessmentGuardV1Schema.parse({
      version: 1,
      ...key,
      state: "releasing",
      reason: "terminal_cleanup",
    });
    return this.getSnapshot();
  }

  completeRelease(key: GuardKey, sensitiveContextCleared: boolean): FormalAssessmentGuardV1 {
    if (!sensitiveContextCleared || this.state.state !== "releasing" || !sameKey(this.state.runId && this.state.runtimeEpoch !== null ? { runId: this.state.runId, runtimeEpoch: this.state.runtimeEpoch } : null, key)) {
      return this.failClosed("stale", key);
    }
    this.state = formalAssessmentGuardV1Schema.parse({
      version: 1,
      ...key,
      state: "inactive",
      reason: "cleared",
    });
    return this.getSnapshot();
  }

  /** Syncs a server public snapshot before it is handed to renderer code. */
  syncFromSnapshot(snapshot: unknown, connectionReady = true): FormalAssessmentGuardV1 {
    if (!connectionReady) return this.failClosed("disconnected");
    const parsed = learningRunPublicSnapshotV2Schema.safeParse(snapshot);
    if (!parsed.success) return this.failClosed("unknown");

    const key = { runId: parsed.data.runId, runtimeEpoch: parsed.data.runtimeEpoch };
    const existingKey = this.state.runId && this.state.runtimeEpoch !== null
      ? { runId: this.state.runId, runtimeEpoch: this.state.runtimeEpoch }
      : null;
    if (existingKey && existingKey.runId === key.runId && existingKey.runtimeEpoch !== key.runtimeEpoch) {
      return this.failClosed("epoch_mismatch", key);
    }
    if (existingKey && existingKey.runId !== key.runId && this.state.state !== "inactive") {
      return this.failClosed("stale", key);
    }

    const formalSensitive = parsed.data.phase === "assessing"
      || parsed.data.phase === "committing"
      || parsed.data.activeTask?.activeVariant.purpose === "formal";
    if (formalSensitive) {
      if (this.state.state === "active" && sameKey(existingKey, key)) return this.getSnapshot();
      this.arm(key, true);
      return this.activate(key);
    }

    if (TERMINAL_PHASES.has(parsed.data.phase)) {
      if (this.state.state === "active" && sameKey(existingKey, key)) return this.beginRelease(key, true);
      if (this.state.state === "releasing" && sameKey(existingKey, key)) return this.getSnapshot();
    }

    if (this.state.state === "active" || this.state.state === "armed" || this.state.state === "releasing") {
      return this.failClosed("stale", key);
    }
    this.state = formalAssessmentGuardV1Schema.parse({
      version: 1,
      ...key,
      state: "inactive",
      reason: "cleared",
    });
    return this.getSnapshot();
  }
}
