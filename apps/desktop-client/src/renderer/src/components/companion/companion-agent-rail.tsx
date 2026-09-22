import { useEffect, useState, type CSSProperties } from "react";
import {
  BarChart3,
  Bell,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  CircleDashed,
  FileText,
  History,
  Layers,
  ListChecks,
  Network,
  ScanSearch,
  Sparkles,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  countAgentToolCalls,
  visibleAgentNodes,
  type CompanionAgentNode,
  type CompanionAgentNodes,
  nodeLabel,
} from "../../app/companion-agent-nodes";

/**
 * 头顶「步骤轨道」（方案 §1 第一层，2026-09-19）。
 *
 * 贴在状态气泡上方，一行一步，最多同时显示最近 3 步，更早的折成左端 `…+N`。
 * 它回答的是现在用户唯一看不到的那件事：**她到底做了什么、做到哪了**——在此之前
 * 工具调用、技能选择、第几步全部不可见，而服务端一直在发。
 *
 * 三条自我约束：
 *
 * 1. **文案只用 `safeLabel`**（收敛层已经保证），这里不合成描述。
 * 2. **不做表演**：状态点只在 `running` 呼吸、`waiting_confirmation` 脉冲；其余是静态
 *    的落定态。方案 §5 明确不做第二层打字机、不做循环旋转光晕。
 * 3. **收不收由回合状态决定，退场由气泡决定**：`assistant.final` 后 400ms 收成一行摘要；
 *    用户按停止保留 2s（让他看见"停在这里"）；出错**不自动收**——错误必须被看见。
 *    收起 ≠ 消失，而**消失这里不决定**：判据只有一份，见 `companionAgentRailVisible`。
 */

/** 本 run 的真实消耗。来自 `companion_turn_runs`，不是客户端数事件数出来的。 */
export interface CompanionAgentRailProgress {
  readonly stepCount: number;
  readonly maxSteps: number;
  readonly toolCallCount: number;
  readonly maxToolCalls: number;
}

export type CompanionAgentRailTurnState = "running" | "done" | "stopped" | "failed";

/**
 * 轨道在不在，只有一个判据：**这一轮调用过工具**，并且**此刻头顶有消息气泡**。
 *
 * 第二个条件是 2026-09-22 补的：轨道以前自己计时退场（轮结束 + 5.4s），而气泡要等朗读
 * 露完再停留，两条时间线互不知情——气泡还说着话轨道就没了；而 `stopped`/`failed` 两个
 * 分支压根没设退场计时，那行摘要从此永久挂在头顶（停止之后气泡早就收了，轨道还在）。
 * 过程留痕本来就在历史抽屉里，头顶这一条的寿命就该等于气泡的寿命。
 */
export function companionAgentRailVisible(
  nodes: CompanionAgentNodes,
  bubblePresent: boolean,
): boolean {
  return bubblePresent && nodes.some((node) => node.kind === "tool");
}

/**
 * 工具名 → 图标。方案 §1 要求「按工具名映射（打开卡片/复习/星图等）」。
 * 名字取自执行器的 switch（`companion-agent-runtime.ts`）；不认识的一律扳手，
 * 不猜语义（猜错比不认识更坏）。
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  companion_read_context: ScanSearch,
  companion_read_history: History,
  companion_read_memory: Brain,
  companion_open_card: Layers,
  companion_open_page: Network,
  companion_open_note: FileText,
  companion_search_notes: ScanSearch,
  companion_read_note: FileText,
  companion_get_learning_stats: BarChart3,
  companion_list_task_queue: ListChecks,
  companion_list_due_reviews: CalendarClock,
  companion_schedule_reminder: Bell,
  companion_list_reminders: Bell,
  companion_cancel_reminder: Bell,
  companion_start_learning: Sparkles,
};

function nodeIcon(node: CompanionAgentNode): LucideIcon {
  if (node.kind === "acting") return Wrench;
  if (node.kind === "thinking") return BookOpen;
  return (node.toolName ? TOOL_ICONS[node.toolName] : undefined) ?? Wrench;
}

/** 状态点：五档视觉，与方案 §1 的表一一对应。 */
function nodeMark(node: CompanionAgentNode) {
  if (node.state === "succeeded") return <Check size={13} aria-hidden="true" />;
  if (node.state === "failed") return <TriangleAlert size={13} aria-hidden="true" />;
  if (node.state === "cancelled") return <X size={13} aria-hidden="true" />;
  return <CircleDashed size={13} aria-hidden="true" />;
}

function progressText(
  progress: CompanionAgentRailProgress | null,
  toolCalls: number,
  turnState: CompanionAgentRailTurnState,
): string {
  // 步数只在拿到**本 run** 的摘要时才说。`assistant.status` 一轮只发一次，客户端数不出
  // 步数——与其猜一个数字，不如先只说工具次数，摘要到了再补上步数。
  const steps = progress ? `${progress.stepCount}/${progress.maxSteps} 步` : null;
  const tools = progress ? `${toolCalls}/${progress.maxToolCalls} 次工具` : `${toolCalls} 次工具`;
  if (turnState === "stopped") return steps ? `已停止 · ${steps} · ${tools}` : `已停止 · ${tools}`;
  return steps ? `${steps} · ${tools}` : tools;
}

export function CompanionAgentRail({
  nodes,
  progress,
  turnState,
  tight = false,
  leaving = false,
}: {
  readonly nodes: CompanionAgentNodes;
  readonly progress: CompanionAgentRailProgress | null;
  readonly turnState: CompanionAgentRailTurnState;
  /**
   * 头顶的垂直预算已经不够放「展开态轨道 + 气泡下限」了（判据见 `CompanionHud.tsx` 的
   * 实测 effect）。此时只剩摘要行：轨道越出窗口比"少了三行过程"更糟，而摘要行本来就带
   * 步数与工具次数，信息不丢。
   */
  readonly tight?: boolean;
  /** 消息气泡正在退场：轨道同拍淡出，不留在原地等下一帧。 */
  readonly leaving?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  /**
   * 收起时机。`final` 后 400ms 收（让最后一步的落定被看见），停止后 2s 收
   * （"停在这里"需要停留），出错不收（错误被自动折叠掉等于没提示）。
   *
   * 这里只管"收成摘要"，不管消失——消失跟着气泡走（见文件头第 3 条约束）。
   */
  useEffect(() => {
    if (turnState === "running" || turnState === "failed") {
      setCollapsed(false);
      return;
    }
    if (turnState === "stopped") {
      const timer = window.setTimeout(() => setCollapsed(true), 2_000);
      return () => window.clearTimeout(timer);
    }
    const collapseTimer = window.setTimeout(() => setCollapsed(true), 400);
    return () => window.clearTimeout(collapseTimer);
  }, [turnState]);

  if (nodes.length === 0) return null;

  const folded = collapsed || tight;
  const { hiddenCount, visible } = visibleAgentNodes(nodes);
  // 工具次数取「摘要」与「本轮节点去重计数」的较大者：摘要是权威值但它按轮询节奏到，
  // 节点是即时的。两者同口径（都是去重后的 toolCallId 个数），取大不会虚报。
  const toolCalls = Math.max(progress?.toolCallCount ?? 0, countAgentToolCalls(nodes));

  return (
    <div
      className="companion-hud__rail"
      data-turn={turnState}
      data-collapsed={folded || undefined}
      data-tight={tight || undefined}
      data-leaving={leaving || undefined}
      role="status"
      aria-live="polite"
      aria-label="Mao 正在做的事"
    >
      {folded ? (
        <p className="companion-hud__rail-summary">{progressText(progress, toolCalls, turnState)}</p>
      ) : (
        <ol
          className="companion-hud__rail-steps"
          style={{ "--rail-index": Math.max(0, visible.length - 1) } as CSSProperties}
        >
          {hiddenCount > 0 ? <li className="companion-hud__rail-overflow">…+{hiddenCount}</li> : null}
          {visible.map((node) => {
            const Icon = nodeIcon(node);
            return (
              <li key={node.key} data-state={node.state} data-kind={node.kind} title={node.summary ?? undefined}>
                <span className="companion-hud__rail-icon"><Icon size={13} aria-hidden="true" /></span>
                <span className="companion-hud__rail-label">{nodeLabel(node)}</span>
                <span className="companion-hud__rail-mark">{nodeMark(node)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {!folded && turnState !== "failed" ? (
        <p className="companion-hud__rail-summary">{progressText(progress, toolCalls, turnState)}</p>
      ) : null}
    </div>
  );
}
