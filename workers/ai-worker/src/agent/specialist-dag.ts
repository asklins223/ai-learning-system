import type { GenerationPlan, GenerationPlanBundleTask } from "@ailearn/shared";
import { dependenciesOf } from "./gap-detection.ts";

/**
 * P3-4: Specialist DAG 调度(实施计划 §3.2/§3.4)。
 *
 * - 并行调度 text/code/vision Specialists;
 * - relatedBundleIds 声明依赖:被依赖 bundle 必须先行(依赖关系仅约束调度序,
 *   不阻断并行——无依赖或依赖已完成的 bundle 同时调度);
 * - 全部 Required Bundle 完成(终态)后自动触发 Compose,不产生 Supervisor 空转 Turn。
 *
 * 纯函数:给定 Plan 与完成状态,计算"本批可调度"与"是否可进入 Compose"。
 */

export type SpecialistKind = GenerationPlanBundleTask["specialist"];

export interface BundleScheduleState {
  bundleId: string;
  specialist: SpecialistKind;
  relatedBundleIds: string[];
  /** 该 bundle 的 unit 是否已终态(succeeded/failed 均算完成;failed 由 Replan 决定) */
  completed: boolean;
  required: boolean;
}

export interface ScheduleDecision {
  /** 本批可并行调度的 bundle(依赖已满足且未完成) */
  runnable: string[];
  /** 所有 Required bundle 是否已终态(是则可自动 Compose) */
  canCompose: boolean;
  /** 仍未完成的 Required bundle(等待中) */
  pending: string[];
}

/** 构建 DAG 状态(从 Plan) */
export function buildScheduleState(plan: GenerationPlan, completed: Set<string>, requiredAll = true): BundleScheduleState[] {
  return plan.bundleTasks.map((t) => ({
    bundleId: t.bundleId,
    specialist: t.specialist,
    relatedBundleIds: dependenciesOf(t),
    completed: completed.has(t.bundleId),
    required: requiredAll,
  }));
}

/** 计算本批可调度 bundle 与 Compose 就绪性(纯函数) */
export function decideSchedule(states: BundleScheduleState[]): ScheduleDecision {
  const byId = new Map(states.map((s) => [s.bundleId, s]));
  const runnable: string[] = [];
  const pending: string[] = [];

  for (const s of states) {
    if (s.completed) continue;
    const deps = s.relatedBundleIds.filter((d) => byId.has(d));
    const depsDone = deps.every((d) => byId.get(d)?.completed ?? true);
    if (depsDone) {
      runnable.push(s.bundleId);
    } else {
      pending.push(s.bundleId);
    }
  }

  const incompleteRequired = states.filter((s) => s.required && !s.completed);
  const canCompose = incompleteRequired.length === 0;

  return { runnable, canCompose, pending: pending };
}

/** 并行度分组:把 runnable 按"无依赖交集"分波(同一波内可并行) */
export function scheduleWaves(states: BundleScheduleState[]): string[][] {
  const remaining = new Set(states.map((s) => s.bundleId));
  const byId = new Map(states.map((s) => [s.bundleId, s]));
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const id of [...remaining]) {
      const s = byId.get(id)!;
      const deps = s.relatedBundleIds.filter((d) => byId.has(d));
      const depsDone = deps.every((d) => !remaining.has(d));
      if (depsDone) {
        wave.push(id);
      }
    }
    if (wave.length === 0) {
      // 环(不应发生,Plan 校验禁止);防御:取字典序最小,避免死循环
      wave.push([...remaining].sort()[0]);
    }
    for (const id of wave) remaining.delete(id);
    waves.push(wave);
  }
  return waves;
}
