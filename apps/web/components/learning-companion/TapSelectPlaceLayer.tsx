"use client";

/**
 * 任务 05-3：拖拽替代 UI 层（§6.6 / §13.4 / 冻结记录 01-4 §13.4）。
 *
 * 所有拖拽场景的等价操作路径：**点选对象 → 选择动作 → 点选目标**（tap-select-place）。
 * 本组件把纯逻辑状态机（lib/learning-companion/tap-select-place.ts）渲染为可访问 UI：
 *
 * A11y（§13.4）：
 * - 键盘：方向键移动焦点、Enter/Space 选择当前项、U 撤销、L 锁定、Esc 取消；
 * - 读屏：aria-live 播报阶段/进度、role=alert 播报错误、每个对象/动作/目标都有
 *   语义 aria-label（节点/关系/顺序描述）；roving tabindex 让 Tab 只聚焦当前项；
 * - Switch Control / 单手操作：全部触控目标 ≥ 44×44 CSS px（min-h-11 / min-w-11）；
 * - 200% zoom 与 390/768/1440 三视口：flex-wrap 网格 + 无固定像素宽度，缩放不丢功能、
 *   窄屏不阻断主路径；颜色/空间位置/动画不是唯一信息载体（文字标签始终存在）；
 * - reduced-motion：状态切换为即时 DOM 重渲染（无飞行/无位移动画），过渡
 *   附加 motion-reduce:transition-none；无计时评分、无速度评分。
 *
 * 组件为纯 UI + props 回调：onPlace/onUndo/onLock 通知宿主执行真实 Scene 动作，
 * 本组件不直接调用服务端。
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { Icon } from "@/components/ui/icons";
import {
  createTapSelectPlaceState,
  isTapSelectPlaceComplete,
  tapSelectPlaceProgress,
  tapSelectPlaceReducer,
  tapSelectPlaceTargetCandidates,
  type TapSelectPlaceEvent,
  type TapSelectPlacement,
  type TapSelectPlaceScene,
  type TapSelectPlaceState,
} from "@/lib/learning-companion/tap-select-place";

// 类型别名：事件与放置（对外导出供宿主使用）
export type { TapSelectPlaceEvent, TapSelectPlacement, TapSelectPlaceScene };

export interface TapSelectPlaceLayerProps {
  scene: TapSelectPlaceScene;
  /** 每次放置成功（宿主执行真实 Scene 动作 / 校验） */
  onPlace?: (placement: TapSelectPlacement) => void;
  /** 撤销一次放置（宿主同步 Scene） */
  onUndo?: (placement: TapSelectPlacement) => void;
  /** 锁定（宿主提交/锁存结果） */
  onLock?: () => void;
  ariaLabel?: string;
}

/** 键盘方向键（§13.4 键盘移动） */
const ARROW_TO_DIRECTION: Readonly<Record<string, "up" | "down" | "left" | "right">> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function labelForObject(
  scene: TapSelectPlaceScene,
  objectId: string,
): string {
  return scene.objects.find((object) => object.id === objectId)?.label ?? objectId;
}

function labelForAction(
  scene: TapSelectPlaceScene,
  actionId: string,
): string {
  return scene.actions.find((action) => action.id === actionId)?.label ?? actionId;
}

/** 读屏阶段描述（节点/关系/顺序可理解，§13.4） */
function describePhase(
  state: TapSelectPlaceState,
  scene: TapSelectPlaceScene,
): string {
  const { placedCount, requiredCount } = tapSelectPlaceProgress(state, scene);
  switch (state.phase) {
    case "idle":
      return "尚未开始。按「开始点选放置」进入点选模式。";
    case "select_object":
      return `请选择要放置的对象。进度 ${placedCount}/${requiredCount}。`;
    case "choose_action":
      return state.selectedObjectId === null
        ? "请先选择对象。"
        : `已选择对象「${labelForObject(scene, state.selectedObjectId)}」。请选择要执行的动作。`;
    case "select_target":
      return state.selectedObjectId === null || state.selectedActionId === null
        ? "请先选择对象与动作。"
        : `对象「${labelForObject(scene, state.selectedObjectId)}」的「${labelForAction(scene, state.selectedActionId)}」：请点选放置目标。`;
    case "done":
      return `已全部完成（${placedCount}/${requiredCount}）。可锁定结果。`;
  }
}

export function TapSelectPlaceLayer({
  scene,
  onPlace,
  onUndo,
  onLock,
  ariaLabel = "点选放置（拖拽替代操作）",
}: TapSelectPlaceLayerProps) {
  const [state, dispatch] = useReducer(
    (current: TapSelectPlaceState, event: TapSelectPlaceEvent) =>
      tapSelectPlaceReducer(current, event, scene),
    undefined,
    createTapSelectPlaceState,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  // 焦点跟踪：roving tabindex 下键盘移动后把焦点落到当前项
  useEffect(() => {
    if (state.focusId === null) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-focus-id="${state.focusId}"]`,
    );
    el?.focus({ preventScroll: true });
  }, [state.phase, state.focusId]);

  // 副作用通知（只在实际状态变化后触发，避免在非法/被拒转移时误报）：
  // - placements 减少 → 通知宿主撤销最近一次放置；
  // - locked 由 false → true → 通知宿主锁定/提交。
  const prevPlacementsRef = useRef<readonly TapSelectPlacement[]>(state.placements);
  useEffect(() => {
    const prev = prevPlacementsRef.current;
    const next = state.placements;
    if (next.length < prev.length) {
      const removed = prev[prev.length - 1];
      onUndo?.(removed);
    }
    prevPlacementsRef.current = next;
  }, [state.placements, onUndo]);

  const prevLockedRef = useRef(state.locked);
  useEffect(() => {
    if (state.locked && !prevLockedRef.current) onLock?.();
    prevLockedRef.current = state.locked;
  }, [state.locked, onLock]);

  const selectFocused = useCallback(() => {
    if (state.focusId === null) return;
    if (state.phase === "select_object") {
      dispatch({ type: "pick_object", objectId: state.focusId });
    } else if (state.phase === "choose_action") {
      dispatch({ type: "pick_action", actionId: state.focusId });
    } else if (state.phase === "select_target") {
      dispatch({ type: "pick_target", targetId: state.focusId });
    }
  }, [state.phase, state.focusId]);

  // 键盘处理：方向键移动 / Enter·Space 选择 / U 撤销 / L 锁定 / Esc 取消
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const direction = ARROW_TO_DIRECTION[event.key];
      if (direction) {
        event.preventDefault();
        dispatch({ type: "move_focus", direction });
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectFocused();
        return;
      }
      const lower = event.key.toLowerCase();
      if (lower === "u") {
        event.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if (lower === "l") {
        dispatch({ type: "lock" });
        return;
      }
      if (event.key === "Escape") {
        dispatch({ type: "cancel" });
      }
    },
    [selectFocused],
  );

  const { placedCount, requiredCount } = tapSelectPlaceProgress(state, scene);
  const targetCandidates = tapSelectPlaceTargetCandidates(state, scene);
  const canLock = isTapSelectPlaceComplete(state, scene) || requiredCount === 0;
  const selectedObject = state.selectedObjectId
    ? scene.objects.find((object) => object.id === state.selectedObjectId)
    : undefined;

  const handlePlace = useCallback(
    (placement: TapSelectPlacement) => {
      // 仅当目标属于当前候选（canPlace 已通过）时通知宿主
      const isCandidate = targetCandidates.some((target) => target.id === placement.targetId);
      if (isCandidate) onPlace?.(placement);
    },
    [onPlace, targetCandidates],
  );

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={ariaLabel}
      className="flex w-full min-w-0 flex-col gap-3"
      onKeyDown={handleKeyDown}
      data-testid="tap-select-place-layer"
    >
      {/* 读屏播报：只播报必要状态（§13.4）；错误单独走 role=alert 避免重复 */}
      <p className="sr-only" role="status" aria-live="polite">
        {describePhase(state, scene)}
        {state.locked ? "，结果已锁定" : ""}
      </p>
      {state.lastError ? (
        <p className="sr-only" role="alert">
          {state.lastError}
        </p>
      ) : null}

      {/* 可见状态行 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{describePhase(state, scene)}</p>
        <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-surface-soft px-3 text-xs text-muted">
          <Icon.Keyboard aria-hidden="true" className="size-3.5" />
          <span>
            进度 {placedCount}/{requiredCount}
            {requiredCount > 0 ? "" : "（无强制项）"}
          </span>
        </span>
      </div>

      {state.lastError ? (
        <p className="text-sm text-danger-text" role="note" data-testid="tsp-error">
          {state.lastError}
        </p>
      ) : null}

      {/* ── idle：开始 ────────────────────────────────────────────── */}
      {state.phase === "idle" ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "begin" })}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-pill bg-action px-5 font-medium text-on-action transition-colors hover:bg-action-hover motion-reduce:transition-none"
          >
            <Icon.Target aria-hidden="true" className="size-4" />
            开始点选放置
          </button>
          {state.placements.length > 0 ? (
            <span className="inline-flex min-h-[44px] items-center text-xs text-muted">
              已有 {placedCount}/{requiredCount} 项放置，可继续。
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ── select_object：点选对象 ──────────────────────────────── */}
      {state.phase === "select_object" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            第 1 步 / 共 3 步：选择要放置的对象（用方向键移动，回车确认）。
          </p>
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {scene.objects
              .filter((object) => !state.placements.some((p) => p.objectId === object.id))
              .map((object) => {
                const focused = state.focusId === object.id;
                const placed = state.placements.some((p) => p.objectId === object.id);
                return (
                  <button
                    key={object.id}
                    type="button"
                    data-focus-id={object.id}
                    tabIndex={focused ? 0 : -1}
                    onClick={() => dispatch({ type: "pick_object", objectId: object.id })}
                    aria-label={`对象 ${object.label}${placed ? "，已放置" : ""}${focused ? "，当前焦点" : ""}`}
                    aria-current={focused ? "true" : undefined}
                    className="flex min-h-11 min-w-11 items-center justify-between gap-2 rounded-card border border-border bg-paper px-3 text-left text-sm text-ink transition-colors hover:bg-surface-soft focus-visible:border-action focus-visible:outline-none motion-reduce:transition-none"
                  >
                    <span>{object.label}</span>
                    <Icon.GripVertical aria-hidden="true" className="size-4 shrink-0 text-muted" />
                  </button>
                );
              })}
          </div>
        </div>
      ) : null}

      {/* ── choose_action：选择动作 ───────────────────────────────── */}
      {state.phase === "choose_action" && selectedObject ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            第 2 步 / 共 3 步：已选择对象「{selectedObject.label}」，选择要执行的动作。
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`对象「${selectedObject.label}」的动作`}>
            {selectedObject.actions.map((actionId) => {
              const action = scene.actions.find((item) => item.id === actionId);
              if (!action) return null;
              const focused = state.focusId === action.id;
              return (
                <button
                  key={action.id}
                  type="button"
                  data-focus-id={action.id}
                  tabIndex={focused ? 0 : -1}
                  onClick={() => dispatch({ type: "pick_action", actionId: action.id })}
                  aria-label={`动作 ${action.label}，应用于对象 ${selectedObject.label}`}
                  aria-current={focused ? "true" : undefined}
                  className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-pill border border-border bg-paper px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-soft focus-visible:border-action focus-visible:outline-none motion-reduce:transition-none"
                >
                  <Icon.Link aria-hidden="true" className="size-4" />
                  {action.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: "undo" })}
            className="inline-flex min-h-11 min-w-11 items-center gap-2 self-start rounded-pill border border-border px-4 text-sm text-muted hover:bg-surface-soft"
          >
            <Icon.Undo aria-hidden="true" className="size-4" />
            返回重新选对象
          </button>
        </div>
      ) : null}

      {/* ── select_target：点选目标 ───────────────────────────────── */}
      {state.phase === "select_target" && state.selectedObjectId && state.selectedActionId ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            第 3 步 / 共 3 步：把「{labelForObject(scene, state.selectedObjectId)}」的「
            {labelForAction(scene, state.selectedActionId)}」放到哪个目标？
          </p>
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {targetCandidates.map((target) => {
              const focused = state.focusId === target.id;
              return (
                <button
                  key={target.id}
                  type="button"
                  data-focus-id={target.id}
                  tabIndex={focused ? 0 : -1}
                  onClick={() => {
                    dispatch({ type: "pick_target", targetId: target.id });
                    handlePlace({
                      objectId: state.selectedObjectId!,
                      actionId: state.selectedActionId!,
                      targetId: target.id,
                    });
                  }}
                  aria-label={`目标 ${target.label}：放置 ${labelForObject(scene, state.selectedObjectId!)} 的 ${labelForAction(scene, state.selectedActionId!)}${focused ? "，当前焦点" : ""}`}
                  aria-current={focused ? "true" : undefined}
                  className="flex min-h-11 min-w-11 items-center justify-between gap-2 rounded-card border border-border bg-paper px-3 text-left text-sm text-ink transition-colors hover:bg-surface-soft focus-visible:border-action focus-visible:outline-none motion-reduce:transition-none"
                >
                  <span>{target.label}</span>
                  <Icon.Target aria-hidden="true" className="size-4 shrink-0 text-muted" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ── done / 已锁定 ─────────────────────────────────────────── */}
      {state.phase === "done" ? (
        <div className="flex flex-col gap-2 rounded-card border border-border bg-paper p-3">
          <p className="flex items-center gap-2 text-sm text-success-text" role="status">
            <Icon.Check aria-hidden="true" className="size-4" />
            全部放置完成（{placedCount}/{requiredCount}）
            {state.locked ? "，结果已锁定" : "，可锁定结果"}。
          </p>
          <div className="flex flex-wrap gap-2">
            {!state.locked ? (
              <button
                type="button"
                onClick={() => dispatch({ type: "lock" })}
                className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-pill bg-action px-4 font-medium text-on-action hover:bg-action-hover"
              >
                <Icon.Lock aria-hidden="true" className="size-4" />
                锁定结果
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => dispatch({ type: "undo" })}
              className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-pill border border-border px-4 text-sm text-muted hover:bg-surface-soft"
            >
              <Icon.Undo aria-hidden="true" className="size-4" />
              撤销上一步
            </button>
          </div>
        </div>
      ) : null}

      {/* ── 进行中操作栏：撤销 / 取消 ─────────────────────────────── */}
      {state.phase !== "idle" && state.phase !== "done" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "undo" })}
            disabled={state.placements.length === 0 && state.phase === "select_object"}
            aria-label="撤销上一步"
            className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-pill border border-border px-4 text-sm font-medium text-ink hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon.Undo aria-hidden="true" className="size-4" />
            撤销
            <span className="text-xs text-muted">(U)</span>
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "lock" })}
            disabled={!canLock}
            aria-label="锁定结果"
            className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-pill border border-border px-4 text-sm font-medium text-ink hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon.Lock aria-hidden="true" className="size-4" />
            锁定
            <span className="text-xs text-muted">(L)</span>
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "cancel" })}
            aria-label="取消当前选择"
            className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-pill border border-border px-4 text-sm text-muted hover:bg-surface-soft"
          >
            <Icon.Close aria-hidden="true" className="size-4" />
            取消
            <span className="text-xs text-muted">(Esc)</span>
          </button>
          <p className="text-xs text-muted">
            键盘：方向键移动 · 回车选择 · U 撤销 · L 锁定 · Esc 取消
          </p>
        </div>
      ) : null}
    </div>
  );
}
