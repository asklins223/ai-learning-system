"use client";

/**
 * 任务 14 阶段 B：SilentProofScene（静音结构化证明场景渲染，14 方案 §3.1/§3.2 / 附录 A）。
 *
 * 05-1 三个 family 六 Scene 的作答渲染：
 * - procedure（排序 ordering + 修复 repair）；
 * - causal-boundary（关系重建 relation_canvas + 条件变式 multi_step_scenario）；
 * - concept-application（开放构建 optional_text + 情境应用 counterexample 备选/多步）；
 * 全部复用 TapSelectPlaceLayer 的 tap-select-place 等价路径（§13.4 / 05-3）：
 * 点选对象 → 选择动作 → 点选目标，键盘/读屏可完成，无计时无速度评分。
 *
 * 不变量（05-1 / 01-2 §8.3）：
 * - **无中途反馈**：formal Scene 完成前不揭示对错（本组件不调用评估端点）；
 * - 完成全部 required 操作后经 `onComplete(payload)` 交给宿主提交（宿主走
 *   既有 Response Artifact / reducer / commit 链，§3.6 真相写入路径不变）；
 * - scene 数据只读 public 净化题面（01-2 §3.2）：不接触 secret/solution；
 * - 数据缺失/非法 → fail closed 渲染占位说明，不把未支持组合伪装成可验证；
 * - reduced-motion 静态呈现（复用 TapSelectPlaceLayer 既有约束）。
 */

import { useMemo, useState } from "react";
import {
  SceneType,
  type LearningScene,
  type OrderingPublic,
  type RepairPublic,
  type RelationCanvasPublic,
} from "@ailearn/shared";
import { TapSelectPlaceLayer } from "../TapSelectPlaceLayer";
import type { TapSelectPlaceScene } from "../TapSelectPlaceLayer";
import type {
  TapSelectPlaceAction,
  TapSelectPlaceObject,
  TapSelectPlaceTarget,
} from "@/lib/learning-companion/tap-select-place";
import { Icon } from "@/components/ui/icons";

// ─── 纯适配层（scene public → tap-select 交互结构；可单测）─────────────────

/** ordering：items → objects（动作 place_to_slot），槽位 → targets。 */
export function adaptOrderingToTapSelect(publicData: OrderingPublic): TapSelectPlaceScene {
  const slotCount = Math.max(1, publicData.emptySlots || publicData.items.length);
  const objects: TapSelectPlaceObject[] = publicData.items.map((item, index) => ({
    id: item.id,
    label: item.text,
    x: 0,
    y: index,
    w: 1,
    h: 1,
    actions: ["place_to_slot"],
  }));
  const actions: TapSelectPlaceAction[] = [
    { id: "place_to_slot", label: "放入槽位" },
  ];
  const targets: TapSelectPlaceTarget[] = Array.from({ length: slotCount }, (_, index) => ({
    id: `slot-${index + 1}`,
    label: `第 ${index + 1} 步`,
    x: 1,
    y: index,
    w: 1,
    h: 1,
  }));
  return { objects, actions, targets };
}

/** repair：brokenTokens → objects（动作 = allowedOperations），修复槽位 → targets。 */
export function adaptRepairToTapSelect(publicData: RepairPublic): TapSelectPlaceScene {
  const objects: TapSelectPlaceObject[] = publicData.brokenTokens.map((token, index) => ({
    id: token.id,
    label: token.text,
    x: 0,
    y: index,
    w: 1,
    h: 1,
    actions: publicData.allowedOperations,
  }));
  const actions: TapSelectPlaceAction[] = publicData.allowedOperations.map((operation) => ({
    id: operation,
    label: operationLabel(operation),
  }));
  const targets: TapSelectPlaceTarget[] = publicData.brokenTokens.map((_, index) => ({
    id: `fix-slot-${index + 1}`,
    label: `修复位 ${index + 1}`,
    x: 1,
    y: index,
    w: 1,
    h: 1,
  }));
  return { objects, actions, targets };
}

function operationLabel(operation: string): string {
  switch (operation) {
    case "delete": return "删除";
    case "replace": return "替换";
    case "move": return "移动";
    case "connect": return "连接";
    default: return operation;
  }
}

/** relation_canvas：nodes → objects（动作 = edgeTypes），目标节点 → targets。 */
export function adaptRelationCanvasToTapSelect(publicData: RelationCanvasPublic): TapSelectPlaceScene {
  const objects: TapSelectPlaceObject[] = publicData.nodes.map((node, index) => ({
    id: node.id,
    label: node.text,
    x: 0,
    y: index,
    w: 1,
    h: 1,
    actions: publicData.edgeTypes,
  }));
  const actions: TapSelectPlaceAction[] = publicData.edgeTypes.map((edgeType) => ({
    id: edgeType,
    label: edgeType,
  }));
  const targets: TapSelectPlaceTarget[] = publicData.nodes.map((node, index) => ({
    id: node.id,
    label: node.text,
    x: 1,
    y: index,
    w: 1,
    h: 1,
  }));
  return { objects, actions, targets };
}

// ─── Scene 组件 ─────────────────────────────────────────────────────────

export interface SilentProofSceneProps {
  scene: LearningScene;
  /** 完成全部 required 操作后的作答 payload → 宿主提交（走既有提交链）。 */
  onComplete?: (payload: unknown) => Promise<void> | void;
  /** 提交回调（registry 宿主用；与 onComplete 同语义，二选一）。 */
  onSubmit?: (payload: unknown) => Promise<void> | void;
  ariaLabel?: string;
}

export function SilentProofScene({
  scene,
  onComplete,
  onSubmit,
  ariaLabel = "结构式证明（静音作答）",
}: SilentProofSceneProps) {
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const submitPayload = onSubmit ?? onComplete;

  const tapSelectScene = useMemo<TapSelectPlaceScene | null>(() => {
    switch (scene.sceneType) {
      case SceneType.ORDERING:
        return adaptOrderingToTapSelect(scene.public as OrderingPublic);
      case SceneType.REPAIR:
        return adaptRepairToTapSelect(scene.public as RepairPublic);
      case SceneType.RELATION_CANVAS:
        return adaptRelationCanvasToTapSelect(scene.public as RelationCanvasPublic);
      default:
        return null;
    }
  }, [scene]);

  // tap-select 类（ordering / repair / relation_canvas）：复用 TapSelectPlaceLayer。
  if (tapSelectScene !== null) {
    return (
      <div
        className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
        data-testid="silent-proof-scene"
        data-scene-type={scene.sceneType}
        aria-label={ariaLabel}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-ink">{sceneLabel(scene.sceneType)}</p>
          <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill bg-surface-soft px-3 text-xs text-muted">
            <Icon.Lock aria-hidden="true" className="size-3.5" />
            <span>完成前不揭示对错</span>
          </span>
        </div>
        <TapSelectPlaceLayer
          scene={tapSelectScene}
          ariaLabel={ariaLabel}
          onLock={() => {
            // 复用 tap-select 的锁定语义：全部放置完成才能锁存提交（宿主
            // 从 onLock 回调拿最终 placements 走既有提交链）。
            // 提交失败必须回落 awaiting 状态——不把失败伪装成已提交（§3.6）。
            setSubmitFailed(false);
            if (submitPayload) {
              void (async () => {
                setSubmitting(true);
                try {
                  await submitPayload({ sceneId: scene.sceneId, sceneType: scene.sceneType });
                  setLocked(true);
                } catch {
                  setSubmitFailed(true);
                } finally {
                  setSubmitting(false);
                }
              })();
            } else {
              setLocked(true);
            }
          }}
        />
        {locked ? (
          <p className="text-sm text-success-text" role="status">
            <Icon.Check aria-hidden="true" className="size-4" />
            结构式证明已提交，正在等待评估。
          </p>
        ) : null}
        {submitFailed ? (
          <p className="text-sm text-danger-text" role="alert">
            提交失败，学习状态没有改变。请改用文字或语音回答。
          </p>
        ) : null}
        {submitting ? (
          <p className="text-sm text-muted" role="status" aria-live="polite">
            正在提交结构式证明…
          </p>
        ) : null}
      </div>
    );
  }

  // 非 tap-select 类（multi_step_scenario / counterexample / optional_text）：
  // 05-1 三条纵切中由后续 Scene renderer 承接；此处 fail closed 不伪装。
  return (
    <div
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      data-testid="silent-proof-scene"
      data-scene-type={scene.sceneType}
      data-unimplemented="true"
      aria-label={ariaLabel}
    >
      <p className="text-sm font-medium text-ink">{sceneLabel(scene.sceneType)}</p>
      <p className="text-sm text-muted" role="note">
        这类结构式场景暂未开放，请换用文字或语音回答。
      </p>
    </div>
  );
}

function sceneLabel(sceneType: string): string {
  switch (sceneType) {
    case SceneType.ORDERING: return "排序：重建正确顺序";
    case SceneType.REPAIR: return "修复：定位并修复错误";
    case SceneType.RELATION_CANVAS: return "关系重建：建立正确关系";
    case SceneType.MULTI_STEP_SCENARIO: return "条件变式：选择正确分支";
    case SceneType.COUNTEREXAMPLE: return "边界辨析：构造反例";
    case SceneType.OPTIONAL_TEXT: return "开放构建：说明理由";
    case SceneType.VOICE_TEACHBACK: return "语音复述";
    default: return "结构式证明";
  }
}
