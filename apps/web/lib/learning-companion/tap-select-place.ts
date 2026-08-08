/**
 * 任务 05-3：tap-select-place 状态机（§6.6 / §13.4 / 冻结记录 01-4 §13.4）。
 *
 * 所有拖拽操作的等价路径：**点选对象 → 选择动作 → 点选目标**。
 * 本文件为纯逻辑（无 React / 无 DOM / 无计时），负责：
 * - 状态机（phase：idle → select_object → choose_action → select_target → done）
 * - 转移校验（对象已放置 / 动作不属于对象 / 目标不可放置 → 拒绝并给 lastError）
 * - 撤销（回退一步选择，或撤销最近一次完整放置）
 * - 锁定（全部 required 对象放置完成后才允许锁定；unlock 解锁）
 * - 键盘方向键导航（up/down/left/right/next/prev 找邻居，供方向键移动）
 *
 * Reduced-motion 友好：状态机不含任何动画、计时或速度概念 ——
 * 无计时评分、无精确拖拽速度评分（§13.4）；状态切换总是瞬时、确定性的。
 *
 * 不变量：所有转移都是纯函数、返回新状态；非法转移不改变状态并置 lastError。
 */

// ─── 1. 类型 ────────────────────────────────────────────────────────────

export type TapSelectPlacePhase =
  | "idle"
  | "select_object"
  | "choose_action"
  | "select_target"
  | "done";

/** 可点选对象（拖拽场景中的节点 / item） */
export interface TapSelectPlaceObject {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 该对象可用的动作 ID（引用 actions[].id） */
  actions: readonly string[];
}

export interface TapSelectPlaceAction {
  id: string;
  label: string;
}

/** 可点选目标（拖拽场景中的槽位 / 连接目标节点） */
export interface TapSelectPlaceTarget {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TapSelectPlaceScene {
  objects: readonly TapSelectPlaceObject[];
  actions: readonly TapSelectPlaceAction[];
  targets: readonly TapSelectPlaceTarget[];
  /** 必须放置完成的对象 ID；缺省 = 全部对象 */
  requiredObjectIds?: readonly string[];
  /**
   * 判定 objectId 上的 actionId 能否放置到 targetId（缺省：对象存在、
   * 动作属于该对象、target 存在）。
   */
  canPlace?: (objectId: string, actionId: string, targetId: string) => boolean;
}

/** 一次完整放置记录（动作序列中的一步） */
export interface TapSelectPlacement {
  objectId: string;
  actionId: string;
  targetId: string;
}

export interface TapSelectPlaceState {
  phase: TapSelectPlacePhase;
  selectedObjectId: string | null;
  selectedActionId: string | null;
  /** 键盘焦点所在项 id（objects / actions / targets 视 phase 而定） */
  focusId: string | null;
  /** 已完成放置（动作序列，顺序即放置顺序） */
  placements: readonly TapSelectPlacement[];
  locked: boolean;
  lastError: string | null;
}

export type TapSelectDirection = "up" | "down" | "left" | "right" | "next" | "prev";

export type TapSelectPlaceEvent =
  | { type: "begin" }
  | { type: "pick_object"; objectId: string }
  | { type: "pick_action"; actionId: string }
  | { type: "pick_target"; targetId: string }
  | { type: "undo" }
  | { type: "cancel" }
  | { type: "lock" }
  | { type: "unlock" }
  | { type: "move_focus"; direction: TapSelectDirection };

// ─── 2. 辅助纯函数 ──────────────────────────────────────────────────────

/** 初始状态（idle，未锁定，无放置） */
export function createTapSelectPlaceState(): TapSelectPlaceState {
  return {
    phase: "idle",
    selectedObjectId: null,
    selectedActionId: null,
    focusId: null,
    placements: [],
    locked: false,
    lastError: null,
  };
}

/** 需要完成放置的对象 ID（缺省 = 全部对象） */
export function tapSelectPlaceRequiredIds(scene: TapSelectPlaceScene): readonly string[] {
  return scene.requiredObjectIds ?? scene.objects.map((object) => object.id);
}

/** 是否已全部完成（所有 required 对象都至少放置过一次） */
export function isTapSelectPlaceComplete(
  state: TapSelectPlaceState,
  scene: TapSelectPlaceScene,
): boolean {
  const required = tapSelectPlaceRequiredIds(scene);
  if (required.length === 0) return false;
  const placedIds = new Set(state.placements.map((placement) => placement.objectId));
  return required.every((id) => placedIds.has(id));
}

/** 进度（供读屏播报：已放置 / 需要放置） */
export function tapSelectPlaceProgress(
  state: TapSelectPlaceState,
  scene: TapSelectPlaceScene,
): { placedCount: number; requiredCount: number } {
  const required = tapSelectPlaceRequiredIds(scene);
  const placedIds = new Set(state.placements.map((placement) => placement.objectId));
  return {
    placedCount: required.filter((id) => placedIds.has(id)).length,
    requiredCount: required.length,
  };
}

/** 默认 canPlace 工厂：对象存在、动作属于该对象、target 存在 */
function createDefaultCanPlace(scene: TapSelectPlaceScene) {
  return (objectId: string, actionId: string, targetId: string): boolean => {
    const object = scene.objects.find((item) => item.id === objectId);
    const action = scene.actions.find((item) => item.id === actionId);
    const target = scene.targets.find((item) => item.id === targetId);
    if (!object || !action || !target) return false;
    if (!object.actions.includes(actionId)) return false;
    return true;
  };
}

/** 可放置目标（phase=select_target 时展示的候选项） */
export function tapSelectPlaceTargetCandidates(
  state: TapSelectPlaceState,
  scene: TapSelectPlaceScene,
): readonly TapSelectPlaceTarget[] {
  if (state.phase !== "select_target" || !state.selectedObjectId || !state.selectedActionId) {
    return [];
  }
  const canPlace = scene.canPlace ?? createDefaultCanPlace(scene);
  return scene.targets.filter((target) =>
    canPlace(state.selectedObjectId!, state.selectedActionId!, target.id),
  );
}

/** 当前 phase 可聚焦项（供键盘导航与读屏） */
function focusableItems(
  state: TapSelectPlaceState,
  scene: TapSelectPlaceScene,
): readonly { id: string }[] {
  switch (state.phase) {
    case "select_object":
      return scene.objects.filter(
        (object) => !state.placements.some((placement) => placement.objectId === object.id),
      );
    case "choose_action": {
      const object = scene.objects.find((item) => item.id === state.selectedObjectId);
      if (!object) return [];
      return object.actions
        .map((actionId) => scene.actions.find((action) => action.id === actionId))
        .filter((action): action is TapSelectPlaceAction => action !== undefined);
    }
    case "select_target":
      return tapSelectPlaceTargetCandidates(state, scene);
    default:
      return [];
  }
}

function center(item: { x: number; y: number; w: number; h: number }): { cx: number; cy: number } {
  return { cx: item.x + item.w / 2, cy: item.y + item.h / 2 };
}

/**
 * 方向键邻居查找（up/down/left/right 按屏幕坐标找同方向最近项；
 * next/prev 按数组顺序循环）。纯函数，供键盘移动（§13.4 键盘等价路径）。
 */
export function tapSelectPlaceMoveFocus(
  state: TapSelectPlaceState,
  scene: TapSelectPlaceScene,
  direction: TapSelectDirection,
): string | null {
  const items = focusableItems(state, scene);
  if (items.length === 0) return null;
  if (state.focusId === null) return items[0].id;
  if (direction === "next" || direction === "prev") {
    const index = items.findIndex((item) => item.id === state.focusId);
    const base = index === -1 ? 0 : index;
    const delta = direction === "next" ? 1 : -1;
    const nextIndex = (base + delta + items.length) % items.length;
    return items[nextIndex].id;
  }
  const withGeometry = items.filter(
    (item): item is typeof item & { x: number; y: number; w: number; h: number } =>
      "x" in item && "y" in item && "w" in item && "h" in item,
  );
  if (withGeometry.length === 0) {
    // 无几何信息的候选项（动作组）：按数组顺序上下循环
    const index = items.findIndex((item) => item.id === state.focusId);
    const base = index === -1 ? 0 : index;
    const delta = direction === "down" || direction === "right" ? 1 : -1;
    return items[(base + delta + items.length) % items.length].id;
  }
  const current = withGeometry.find((item) => item.id === state.focusId);
  if (!current) return withGeometry[0].id;
  const { cx, cy } = center(current);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of withGeometry) {
    if (candidate.id === state.focusId) continue;
    const { cx: tx, cy: ty } = center(candidate);
    const dx = tx - cx;
    const dy = ty - cy;
    let passes = false;
    let score = 0;
    switch (direction) {
      case "up":
        passes = dy < -0.5;
        score = Math.abs(dx) * 1000 + -dy;
        break;
      case "down":
        passes = dy > 0.5;
        score = Math.abs(dx) * 1000 + dy;
        break;
      case "left":
        passes = dx < -0.5;
        score = Math.abs(dy) * 1000 + -dx;
        break;
      case "right":
        passes = dx > 0.5;
        score = Math.abs(dy) * 1000 + dx;
        break;
    }
    if (passes && score < bestScore) {
      bestScore = score;
      best = candidate.id;
    }
  }
  return best;
}

// ─── 3. 状态机 reducer ──────────────────────────────────────────────────

function reject(state: TapSelectPlaceState, message: string): TapSelectPlaceState {
  return { ...state, lastError: message };
}

/**
 * tap-select-place 状态机 reducer（纯函数）。
 * `scene` 提供对象/动作/目标与放置约束；事件驱动转移，非法转移 fail-closed。
 */
export function tapSelectPlaceReducer(
  state: TapSelectPlaceState,
  event: TapSelectPlaceEvent,
  scene: TapSelectPlaceScene,
): TapSelectPlaceState {
  if (state.locked && event.type !== "unlock") {
    return reject(state, "已锁定，不能修改放置。");
  }

  switch (event.type) {
    case "begin": {
      if (state.phase !== "idle") return reject(state, "当前已有进行中的选择。");
      const focusable = focusableItems(
        { ...state, phase: "select_object" as const },
        scene,
      );
      return {
        ...state,
        phase: "select_object",
        selectedObjectId: null,
        selectedActionId: null,
        focusId: focusable[0]?.id ?? null,
        lastError: null,
      };
    }

    case "pick_object": {
      if (state.phase !== "select_object") {
        return reject(state, "请先进入对象选择阶段。");
      }
      const object = scene.objects.find((item) => item.id === event.objectId);
      if (!object) return reject(state, `对象 ${event.objectId} 不存在。`);
      if (state.placements.some((placement) => placement.objectId === event.objectId)) {
        return reject(state, `对象「${object.label}」已放置，可用撤销后重选。`);
      }
      if (object.actions.length === 0) {
        return reject(state, `对象「${object.label}」没有可用的动作。`);
      }
      const focusable = focusableItems(
        { ...state, phase: "choose_action" as const, selectedObjectId: object.id },
        scene,
      );
      return {
        ...state,
        phase: "choose_action",
        selectedObjectId: object.id,
        selectedActionId: null,
        focusId: focusable[0]?.id ?? null,
        lastError: null,
      };
    }

    case "pick_action": {
      if (state.phase !== "choose_action" || state.selectedObjectId === null) {
        return reject(state, "请先选择一个对象。");
      }
      const object = scene.objects.find((item) => item.id === state.selectedObjectId);
      if (!object) return reject(state, "所选对象已不存在。");
      if (!object.actions.includes(event.actionId)) {
        return reject(state, `动作 ${event.actionId} 不属于对象「${object.label}」。`);
      }
      const action = scene.actions.find((item) => item.id === event.actionId);
      if (!action) return reject(state, `动作 ${event.actionId} 不存在。`);
      const focusable = focusableItems(
        { ...state, phase: "select_target" as const, selectedActionId: event.actionId },
        scene,
      );
      return {
        ...state,
        phase: "select_target",
        selectedActionId: event.actionId,
        focusId: focusable[0]?.id ?? null,
        lastError: null,
      };
    }

    case "pick_target": {
      if (state.phase !== "select_target" || !state.selectedObjectId || !state.selectedActionId) {
        return reject(state, "请先选择对象与动作。");
      }
      const canPlace = scene.canPlace ?? createDefaultCanPlace(scene);
      if (!canPlace(state.selectedObjectId, state.selectedActionId, event.targetId)) {
        return reject(state, `目标 ${event.targetId} 不可放置到当前对象。`);
      }
      const placement: TapSelectPlacement = {
        objectId: state.selectedObjectId,
        actionId: state.selectedActionId,
        targetId: event.targetId,
      };
      const placements = [...state.placements, placement];
      const nextState: TapSelectPlaceState = {
        ...state,
        placements,
        selectedObjectId: null,
        selectedActionId: null,
        lastError: null,
      };
      if (isTapSelectPlaceComplete({ ...nextState }, scene)) {
        return {
          ...nextState,
          phase: "done",
          focusId: null,
        };
      }
      // 继续选择下一个对象：focus 落在第一个未放置对象上
      const focusable = focusableItems(
        { ...nextState, phase: "select_object" as const },
        scene,
      );
      return {
        ...nextState,
        phase: "select_object",
        focusId: focusable[0]?.id ?? null,
      };
    }

    case "undo": {
      // 回退一步进行中的选择
      if (state.phase === "select_target") {
        return {
          ...state,
          phase: "choose_action",
          selectedActionId: null,
          focusId: state.selectedActionId ?? null,
          lastError: null,
        };
      }
      if (state.phase === "choose_action") {
        return {
          ...state,
          phase: "select_object",
          selectedObjectId: null,
          selectedActionId: null,
          focusId: state.selectedObjectId ?? null,
          lastError: null,
        };
      }
      // 无进行中的选择：撤销最近一次完整放置（回到 select_target 重选目标）
      if (state.placements.length > 0) {
        const last = state.placements[state.placements.length - 1];
        const placements = state.placements.slice(0, -1);
        return {
          ...state,
          phase: "select_target",
          selectedObjectId: last.objectId,
          selectedActionId: last.actionId,
          focusId: last.targetId,
          placements,
          lastError: null,
        };
      }
      return reject(state, "没有可撤销的操作。");
    }

    case "cancel": {
      if (state.phase === "idle") return reject(state, "当前没有进行中的选择。");
      return {
        ...state,
        phase: "idle",
        selectedObjectId: null,
        selectedActionId: null,
        focusId: null,
        lastError: null,
      };
    }

    case "lock": {
      if (isTapSelectPlaceComplete(state, scene)) {
        return { ...state, locked: true, phase: "done", lastError: null };
      }
      if (tapSelectPlaceRequiredIds(scene).length === 0) {
        // 场景无强制完成条件：允许随时锁定
        return { ...state, locked: true, lastError: null };
      }
      return reject(state, "还有未完成的放置，不能锁定。");
    }

    case "unlock": {
      if (!state.locked) return reject(state, "当前未锁定。");
      return { ...state, locked: false, lastError: null };
    }

    case "move_focus": {
      const nextFocus = tapSelectPlaceMoveFocus(state, scene, event.direction);
      if (nextFocus === null) return reject(state, "当前没有可聚焦的项。");
      return { ...state, focusId: nextFocus, lastError: null };
    }
  }
}
