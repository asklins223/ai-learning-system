/**
 * Journey V2 Reducer（文档 16 §10.1 状态机）。
 *
 * 纯函数：current journey 状态 + 权威领域事件 → 新状态。只有本 Reducer
 * 更新 currentStep/refs/completionKind；Pet/主窗口不得自行宣布完成。
 * 以 (journeyId, domainEventId) 幂等（由 service 层 pending_events 保证）。
 *
 * P6 范围：learning_run.completed（含 scheduleImpact）→ first_run/first_schedule/
 * completed(real_first_loop)；其余事件类型入 pending 不推进（骨架预留）。
 */

import { DomainError } from "@ailearn/shared";
import type { CompanionJourneyStepV2, CompanionJourneyV2 } from "@ailearn/shared";

export interface JourneyReducerState {
  status: CompanionJourneyV2["status"];
  branch: CompanionJourneyV2["branch"];
  currentStep: CompanionJourneyStepV2 | null;
  stepRevision: number;
  dismissedNarrationSteps: CompanionJourneyStepV2[];
  refs: CompanionJourneyV2["refs"];
  lastDomainEventId: string | null;
  completionKind: CompanionJourneyV2["completionKind"];
  pausedAt: string | null;
  pauseReason: CompanionJourneyV2["pauseReason"];
  error: CompanionJourneyV2["error"];
}

export interface JourneyDomainEventInput {
  domainEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** 领域事件 → reducer 动作分类。 */
export type ReducerCommand =
  | { kind: "noop"; reason: string }
  | {
      kind: "advance";
      toStep: CompanionJourneyStepV2;
      refs: Partial<CompanionJourneyV2["refs"]>;
      completionKind?: CompanionJourneyV2["completionKind"];
      terminalStatus?: "completed";
    }
  | { kind: "pause"; reason: "object_unavailable" | "workspace_changed"; error?: CompanionJourneyV2["error"] };

/** 里程碑事件 → 步骤映射（顺序守卫：材料链只在该步等待时推进，不越级）。 */
const MILESTONE_STEPS: Record<string, CompanionJourneyStepV2> = {
  "source.created": "first_source",
  "note.created": "first_note",
  "card.created": "first_card",
  "evidence.created": "first_evidence",
};

/**
 * 把单个领域事件归约为 reducer 命令（P6：learning_run.completed 全链 +
 * source/note/card/evidence 里程碑）。未知事件 → noop（不越级推进）。
 */
export function classifyJourneyEvent(event: JourneyDomainEventInput): ReducerCommand {
  if (event.eventType === "learning_run.completed") {
    const result = event.payload.result as
      | { outcome?: string; scheduleImpact?: { kind?: string } }
      | undefined;
    const scheduleImpactKind = result?.scheduleImpact?.kind;
    if (scheduleImpactKind === "created" || scheduleImpactKind === "rescheduled") {
      return {
        kind: "advance",
        toStep: "closing",
        refs: { runId: typeof event.payload.runId === "string" ? event.payload.runId : undefined },
        completionKind: "real_first_loop",
        terminalStatus: "completed",
      };
    }
    // 无 schedule 副作用的首轮结算：仍记录 run 事实并推进到 first_schedule 之后
    // 由后续 schedule 事件补全（§10.1：允许 created 或有明确原因的 none）。
    return {
      kind: "advance",
      toStep: "first_schedule",
      refs: { runId: typeof event.payload.runId === "string" ? event.payload.runId : undefined },
    };
  }
  const milestoneStep = MILESTONE_STEPS[event.eventType];
  if (milestoneStep) {
    const refKey: Partial<Record<CompanionJourneyStepV2, keyof CompanionJourneyV2["refs"]>> = {
      first_source: "sourceId",
      first_note: "noteId",
      first_card: "cardId",
      first_evidence: "keyPointId",
    };
    const refName = refKey[milestoneStep];
    const entityId = typeof event.payload.entityId === "string" ? event.payload.entityId : undefined;
    return {
      kind: "advance",
      toStep: milestoneStep,
      refs: refName && entityId ? { [refName]: entityId } : {},
    };
  }
  return { kind: "noop", reason: `unhandled:${event.eventType}` };
}

/** 顺序守卫：材料链（source→note→card→evidence）紧跟前一步推进；
 * first_run/first_schedule/closing 是独立维度（Run 不依赖材料链前置）。 */
function isSequentialAdvance(
  state: JourneyReducerState,
  toStep: CompanionJourneyStepV2,
): boolean {
  const MATERIAL_CHAIN: CompanionJourneyStepV2[] = [
    "first_source",
    "first_note",
    "first_card",
    "first_evidence",
  ];
  const orderIndex = MATERIAL_CHAIN.indexOf(toStep);
  if (orderIndex === -1) return true; // first_run/first_schedule/closing 等独立步骤。
  if (orderIndex === 0) return true; // first_source 可直接到达。
  const prevIndex = MATERIAL_CHAIN.indexOf(
    state.currentStep as (typeof MATERIAL_CHAIN)[number],
  );
  // 已在更后位置 → 不倒退（迟到事件只合并 refs，由 applyJourneyCommand 处理）；
  // 紧跟前一步 → 允许推进。
  return prevIndex >= orderIndex - 1;
}

/** 应用命令（纯函数）。终端态/非 active 不接受推进（幂等）。 */
export function applyJourneyCommand(
  state: JourneyReducerState,
  command: ReducerCommand,
): JourneyReducerState {
  switch (command.kind) {
    case "noop":
      return state;
    case "pause":
      return {
        ...state,
        status: "paused",
        pausedAt: new Date().toISOString(),
        pauseReason: command.reason,
        error: command.error ?? null,
      };
    case "advance": {
      if (state.status !== "active") return state; // 终端/暂停不越级推进。
      // 材料链顺序守卫：缺失前置事实不得越级（事件保持 pending 等待前置）。
      if (!isSequentialAdvance(state, command.toStep)) {
        return state;
      }
      const refs = {
        ...state.refs,
        ...Object.fromEntries(
          Object.entries(command.refs).filter(([, value]) => value !== undefined),
        ),
      };
      // 迟到事件（当前步已在更后位置）：只合并 refs，不倒退步骤、不重放旁白。
      const MATERIAL_CHAIN: CompanionJourneyStepV2[] = ["first_source", "first_note", "first_card", "first_evidence"];
      const currentIndex = MATERIAL_CHAIN.indexOf(state.currentStep as CompanionJourneyStepV2);
      const targetIndex = MATERIAL_CHAIN.indexOf(command.toStep);
      if (currentIndex > targetIndex && targetIndex !== -1) {
        return {
          ...state,
          refs,
          stepRevision: state.stepRevision, // 不重复计步。
        };
      }
      return {
        ...state,
        currentStep: command.toStep,
        stepRevision: state.stepRevision + 1,
        refs,
        completionKind: command.completionKind ?? state.completionKind,
        status: command.terminalStatus ?? state.status,
        error: null,
      };
    }
  }
}

/** 应用单个领域事件（分类 + 命令 + lastDomainEventId）。 */
export function applyJourneyEvent(
  state: JourneyReducerState,
  event: JourneyDomainEventInput,
): JourneyReducerState {
  const next = applyJourneyCommand(state, classifyJourneyEvent(event));
  return { ...next, lastDomainEventId: event.domainEventId };
}

/** Journey 动作状态机（§10.1 表）。纯函数，CAS 由 service 执行。 */
export type JourneyActionCommand =
  | { kind: "pause" }
  | { kind: "resume"; resumeToken: string | null }
  | { kind: "dismiss_step_narration"; step: CompanionJourneyStepV2 }
  | { kind: "skip" }
  | { kind: "retry" }
  | { kind: "switch_branch"; branch: CompanionJourneyV2["branch"] };

export class JourneyActionError extends DomainError {
  constructor(message: string) {
    super({ name: "JourneyActionError", code: "journey_action_error", message, statusCode: 400 });
  }
}

export function applyJourneyAction(
  state: JourneyReducerState,
  action: JourneyActionCommand,
  now: Date = new Date(),
): JourneyReducerState {
  switch (action.kind) {
    case "pause": {
      if (state.status !== "active") throw new JourneyActionError("journey not active");
      return {
        ...state,
        status: "paused",
        pausedAt: now.toISOString(),
        pauseReason: "user",
      };
    }
    case "resume": {
      if (state.status !== "paused") throw new JourneyActionError("journey not paused");
      // resumeToken 校验在 service 层（resumeTokenRef/resumeExpiresAt）；
      // reducer 只负责状态推进。
      return { ...state, status: "active", pausedAt: null, pauseReason: null };
    }
    case "dismiss_step_narration": {
      if (state.status !== "active") throw new JourneyActionError("journey not active");
      if (state.dismissedNarrationSteps.includes(action.step)) return state; // 幂等
      return {
        ...state,
        dismissedNarrationSteps: [...state.dismissedNarrationSteps, action.step],
        stepRevision: state.stepRevision + 1,
      };
    }
    case "skip": {
      if (state.status === "skipped" || state.status === "completed") return state;
      // §10.1：skip 终态，不伪造任何业务里程碑（refs 保持原值但 completionKind=null）。
      return { ...state, status: "skipped", completionKind: null, error: null };
    }
    case "retry": {
      if (state.status !== "recoverable_error") throw new JourneyActionError("journey not recoverable");
      return { ...state, status: "active", error: null };
    }
    case "switch_branch": {
      if (state.status !== "active") throw new JourneyActionError("journey not active");
      // §10.1：只在 choose_start 或尚未创建分支专属对象时允许。
      const hasBranchObjects = Boolean(
        state.refs.sourceId ?? state.refs.noteId ?? state.refs.runId,
      );
      if (state.currentStep !== "choose_start" && hasBranchObjects) {
        throw new JourneyActionError("branch_locked");
      }
      if (state.branch === action.branch) return state;
      return { ...state, branch: action.branch, stepRevision: state.stepRevision + 1 };
    }
  }
}

/** 初始 journey 状态（start_journey）。 */
export function initialJourneyState(branch: CompanionJourneyV2["branch"]): JourneyReducerState {
  return {
    status: "active",
    branch,
    currentStep: "boundary_intro",
    stepRevision: 0,
    dismissedNarrationSteps: [],
    refs: {},
    lastDomainEventId: null,
    completionKind: null,
    pausedAt: null,
    pauseReason: null,
    error: null,
  };
}
