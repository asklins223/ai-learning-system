import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, RotateCcw, Sparkles } from "lucide-react";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import type { CardGenerationActiveSummaryV1 } from "@ailearn/shared/card-generation-desktop-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../app/desktop-client";
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
      return `服务端的${subject}暂时不可用；不会把未知状态当成没有任务。`;
    case "unsupported_contract":
      return `${subject}合同暂时无法确认，请重新读取服务端状态。`;
    case "permission_denied":
      return `当前身份没有查看这部分${subject}的权限。`;
    case "stale_workspace":
      return "工作区已经变化，请重新读取当前恢复状态。";
    case "route_not_available":
      return `当前窗口没有可用的${subject}恢复入口。`;
  }
}

function activeGenerationErrorMessage(error: ActiveGenerationError): string {
  return recoverySectionErrorMessage("学习卡恢复查询", error.reason);
}

function activeRunErrorMessage(error: ActiveRunError): string {
  return recoverySectionErrorMessage("LearningRun 恢复列表", error.reason);
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
  const [runs, setRuns] = useState<ActiveRunItem[]>([]);
  const [generation, setGeneration] = useState<CardGenerationActiveSummaryV1 | null>(null);
  const [projectionFailure, setProjectionFailure] = useState<string | null>(null);
  const [generationFailure, setGenerationFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [runtimeRevision, setRuntimeRevision] = useState(0);

  useEffect(() => {
    if (surface || onboardingOpen || !window.ailearn) return;

    let active = true;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;
    const subscribe = async () => {
      try {
        const response = await window.ailearn.subscriptions.subscribe({
          meta: createRequestMeta(),
          topic: { kind: "runtime" },
        });
        if (!active) return;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        unsubscribeEvent = window.ailearn.subscriptions.onEvent(subscriptionId, (event) => {
          if (event.data.kind === "snapshot_invalidated" || event.data.kind === "connection_changed") {
            setRuntimeRevision((revision) => revision + 1);
          }
        });
      } catch {
        // The initial authenticated read remains authoritative; a later
        // surface transition will retry the runtime subscription.
      }
    };

    void subscribe();
    return () => {
      active = false;
      unsubscribeEvent?.();
      if (subscriptionId) {
        void window.ailearn.subscriptions.unsubscribe({
          meta: createRequestMeta(),
          subscriptionId,
        });
      }
    };
  }, [onboardingOpen, surface]);

  useEffect(() => {
    if (surface || onboardingOpen || !window.ailearn) {
      setRuns([]);
      setGeneration(null);
      setProjectionFailure(null);
      setGenerationFailure(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    const load = async () => {
      try {
        const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta() });
        const session = unwrapGatewayResult(sessionResponse);
        if (session.status !== "authenticated" || !session.workspace) {
          if (active) {
            setRuns([]);
            setGeneration(null);
            setProjectionFailure(null);
            setGenerationFailure(null);
          }
          return;
        }
        const projectionResponse = await window.ailearn.room.getProjection({
          meta: createRequestMeta(session.workspaceEpoch),
        });
        if (active) {
          const projection = unwrapGatewayResult(projectionResponse);
          const nextRuns = activeRunsFromProjection(projection);
          const nextGeneration = activeGenerationFromProjection(projection);
          if (nextRuns !== undefined) setRuns(nextRuns);
          if (nextGeneration !== undefined) setGeneration(nextGeneration);
          setProjectionFailure(
            projection.activeRunSummary.state === "error"
              ? activeRunErrorMessage(projection.activeRunSummary)
              : null,
          );
          setGenerationFailure(
            projection.activeGenerationSummary.state === "error"
              ? activeGenerationErrorMessage(projection.activeGenerationSummary)
              : null,
          );
        }
      } catch (error) {
        // Preserve the last trusted recovery items. A failed projection read
        // is not proof that no run exists, so surface the degraded state and
        // let the user perform an explicit read-only retry.
        if (active) setProjectionFailure(gatewayErrorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [onboardingOpen, runtimeRevision, surface]);

  const recoveryFailure = projectionFailure ?? generationFailure;
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
    <div className="run-recovery-stack">
      {recoveryFailure ? <aside className="run-recovery-notice run-recovery-notice--error" role="alert" aria-label="恢复状态暂时不可用">
        <span className="run-recovery-notice__mark" aria-hidden="true"><CircleAlert size={18} /></span>
        <div className="run-recovery-notice__copy">
          <strong>{projectionFailure ? "无法确认恢复状态" : "学习卡恢复状态暂时不可用"}</strong>
          <p>{recoveryFailure}</p>
        </div>
        <div className="run-recovery-notice__actions">
          <button type="button" className="run-recovery-notice__primary" disabled={loading} onClick={() => setRuntimeRevision((revision) => revision + 1)}>
            <RotateCcw size={15} aria-hidden="true" />{loading ? "正在重新读取…" : "重新读取恢复状态"}
          </button>
        </div>
      </aside> : null}
      {runs.length > 0 ? <aside className="run-recovery-notice" aria-label="可恢复的学习旅程">
        <span className="run-recovery-notice__mark" aria-hidden="true"><RotateCcw size={18} /></span>
        <div className="run-recovery-notice__copy">
          <strong>{runs.length === 1 ? "继续未完成的学习旅程" : `有 ${runs.length} 条进行中的学习`}</strong>
          <p>{runs.length === 1 ? "服务端仍保留一条可恢复的 LearningRun；进入前会重新同步快照。" : "选择一条继续；每次进入都会重新读取服务端快照。"}</p>
        </div>
        <div className="run-recovery-notice__actions">
          {runs.length === 1 ? (
            <button type="button" className="run-recovery-notice__primary" onClick={() => recover(runs[0])}>
              恢复学习旅程<ArrowRight size={15} aria-hidden="true" />
            </button>
          ) : (
            runs.slice(0, 4).map((run, index) => (
              <button type="button" className="run-recovery-notice__secondary" key={run.runId} onClick={() => recover(run)}>
                <span>恢复第 {index + 1} 条</span><small>{phaseLabel(run.phase)}</small><ArrowRight size={14} aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      </aside> : null}
      {generation ? <aside className="run-recovery-notice run-recovery-notice--generation" aria-label="可恢复的学习卡生成任务">
        <span className="run-recovery-notice__mark" aria-hidden="true"><Sparkles size={18} /></span>
        <div className="run-recovery-notice__copy">
          <strong>{generation.status === "needs_attention" || generation.status === "failed" || generation.status === "stale" ? "处理未完成的学习卡任务" : "继续未完成的学习卡整理"}</strong>
          <p>服务端保留了一条 Owner Card Generation；进入后会重新读取 run、恢复合同和公开候选。</p>
        </div>
        <div className="run-recovery-notice__actions">
          <button type="button" className="run-recovery-notice__primary" onClick={recoverGeneration}>
            {generationRecoveryActionLabel(generation)}<ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </aside> : null}
    </div>
  );
}
