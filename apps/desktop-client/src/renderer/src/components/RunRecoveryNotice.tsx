import { useHomeProjection } from "../app/home-projection";
import { ArrowRight, CircleAlert, RotateCcw, Sparkles } from "lucide-react";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import type { CardGenerationActiveSummaryV1 } from "@ailearn/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../app/room-store";

type ActiveRunItem = Extract<RoomProjectionV1["activeRunSummary"], { state: "data" }>["data"]["items"][number];
type ActiveRunError = Extract<RoomProjectionV1["activeRunSummary"], { state: "error" }>;
type ActiveGenerationError = Extract<RoomProjectionV1["activeGenerationSummary"], { state: "error" }>;

function activeRunsFromProjection(projection: RoomProjectionV1): ActiveRunItem[] | undefined {
  if (projection.activeRunSummary.state === "error") return undefined;
  if (projection.activeRunSummary.state !== "data") return [];
  return projection.activeRunSummary.data.items.slice(0, 20);
}

function activeGenerationFromProjection(projection: RoomProjectionV1): CardGenerationActiveSummaryV1 | null | undefined {
  if (projection.activeGenerationSummary.state === "error") return undefined;
  if (projection.activeGenerationSummary.state !== "data") return null;
  return projection.activeGenerationSummary.data;
}

function recoverySectionErrorMessage(subject: string, reason: ActiveRunError["reason"]): string {
  switch (reason) {
    case "upstream_unavailable":
      return `${subject}暂时无法读取，请稍后重试。`;
    case "unsupported_contract":
      return `${subject}暂时无法读取，请重新尝试。`;
    case "permission_denied":
      return `当前身份没有查看这部分${subject}的权限。`;
    case "stale_workspace":
      return "工作区已经变化，请重新读取当前恢复状态。";
    case "route_not_available":
      return `当前窗口没有可用的${subject}恢复入口。`;
  }
}

function activeGenerationErrorMessage(error: ActiveGenerationError): string {
  return recoverySectionErrorMessage("待整理的学习卡", error.reason);
}

function activeRunErrorMessage(error: ActiveRunError): string {
  return recoverySectionErrorMessage("未完成的学习", error.reason);
}

const phaseLabels: Record<string, string> = {
  preparing: "正在准备",
  active: "正在进行",
  assessing: "正在评估",
  checkpoint: "等待确认",
  committing: "正在记录",
  paused: "已暂停",
  recoverable_error: "可以恢复",
};

function phaseLabel(phase: string): string {
  return phaseLabels[phase] ?? "进行中";
}

function generationRecoveryActionLabel(generation: CardGenerationActiveSummaryV1): string {
  if (generation.status === "needs_attention" || generation.status === "failed" || generation.status === "stale") {
    return "查看恢复状态";
  }
  return "恢复候选审核";
}

export function RunRecoveryNotice() {
  const surface = useRoomStore((state) => state.surface);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const { projection, loading, failure, reload } = useHomeProjection();
  const runs = projection ? activeRunsFromProjection(projection) ?? [] : [];
  const generation = projection ? activeGenerationFromProjection(projection) : null;
  const projectionFailure = failure ?? (projection?.activeRunSummary.state === "error" ? activeRunErrorMessage(projection.activeRunSummary) : null);
  const generationFailure = projection?.activeGenerationSummary.state === "error" ? activeGenerationErrorMessage(projection.activeGenerationSummary) : null;
  const objectives = [
    ...(projection?.queueSummary.state === "data" ? projection.queueSummary.data.items : []),
    ...(projection?.recentObjectiveSummary.state === "data" ? projection.recentObjectiveSummary.data.items : []),
  ];
  const runTitle = (run: ActiveRunItem, index: number) => {
    const item = objectives.find((objective) => objective.objectiveId === run.objectiveId);
    const focus = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data.objective : null;
    return item?.conceptLabel || (focus?.objectiveId === run.objectiveId ? focus.content.conceptLabel : null) || `未完成的学习 ${index + 1}`;
  };

  const recoveryFailure = projectionFailure ?? generationFailure;
  // The compact companion panel and recovery notice are both persistent overlays.
  // Keep the focused companion interaction unobstructed without discarding the
  // trusted recovery state; the notice returns when the companion closes.
  if (surface || onboardingOpen || (runs.length === 0 && !generation && !recoveryFailure)) return null;

  const recover = (run: ActiveRunItem) => {
    setActiveRunId(run.runId);
    invoke("validate");
  };

  const recoverGeneration = () => {
    if (!generation) return;
    setActiveCardGenerationRunId(generation.runId);
    invoke("open-card-generation");
  };

  return (
    <details className="home-recovery" key={recoveryFailure ? "error" : "ready"}>
      <summary><RotateCcw size={15} aria-hidden="true" /><span>{recoveryFailure ? "恢复信息需要重新读取" : "继续未完成的学习"}</span><small>{runs.length + (generation ? 1 : 0) || "重试"}</small></summary>
      <div className="run-recovery-stack">
      {recoveryFailure ? <aside className="run-recovery-notice run-recovery-notice--error" role="alert" aria-label="恢复状态暂时不可用">
        <span className="run-recovery-notice__mark" aria-hidden="true"><CircleAlert size={18} /></span>
        <div className="run-recovery-notice__copy">
          <strong>{projectionFailure ? "无法确认恢复状态" : "学习卡恢复状态暂时不可用"}</strong>
          <p>{recoveryFailure}</p>
        </div>
        <div className="run-recovery-notice__actions">
          <button type="button" className="run-recovery-notice__primary" disabled={loading} onClick={reload}>
            <RotateCcw size={15} aria-hidden="true" />{loading ? "正在重新读取…" : "重新读取恢复状态"}
          </button>
        </div>
      </aside> : null}
      {runs.length > 0 ? <aside className="run-recovery-notice" aria-label="可恢复的学习旅程">
        <span className="run-recovery-notice__mark" aria-hidden="true"><RotateCcw size={18} /></span>
        <div className="run-recovery-notice__copy">
          <strong>{runs.length === 1 ? "继续未完成的学习旅程" : `有 ${runs.length} 条进行中的学习`}</strong>
          <p>{runs.length === 1 ? "上次的进度还在，可以从停下的地方继续。" : "选一项，从上次停下的地方继续。"}</p>
        </div>
        <div className="run-recovery-notice__actions">
          {runs.length === 1 ? (
            <button type="button" className="run-recovery-notice__primary" onClick={() => recover(runs[0])}>
              恢复学习旅程<ArrowRight size={15} aria-hidden="true" />
            </button>
          ) : (
            runs.map((run, index) => (
              <button type="button" className="run-recovery-notice__secondary" key={run.runId} onClick={() => recover(run)}>
                <span>{runTitle(run, index)}</span><small>{phaseLabel(run.phase)}</small><ArrowRight size={14} aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      </aside> : null}
      {generation ? <aside className="run-recovery-notice run-recovery-notice--generation" aria-label="可恢复的学习卡生成任务">
        <span className="run-recovery-notice__mark" aria-hidden="true"><Sparkles size={18} /></span>
        <div className="run-recovery-notice__copy">
          <strong>{generation.status === "needs_attention" || generation.status === "failed" || generation.status === "stale" ? "处理未完成的学习卡任务" : "继续未完成的学习卡整理"}</strong>
          <p>还有学习卡等待整理，回去看看它们。</p>
        </div>
        <div className="run-recovery-notice__actions">
          <button type="button" className="run-recovery-notice__primary" onClick={recoverGeneration}>
            {generationRecoveryActionLabel(generation)}<ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </aside> : null}
      </div>
    </details>
  );
}
