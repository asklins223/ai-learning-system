"use client";

/**
 * 任务 14 阶段 B：Scene 渲染器 registry（14-...-multimodal-reconstruction §3.2 / 附录 A）。
 *
 * 按 scene.kind（SceneType）分发 renderer，供练习页/复习页在作答区渲染
 * journeyPlan 编排出的 Scene 序列：
 * - 六个 silent family Scene（ordering / repair / relation_canvas /
 *   multi_step_scenario / counterexample / optional_text）＋ voice_teachback；
 * - **fail closed（§3.7 / 05-1）**：未注册/未实现的 kind 一律返回 null 渲染，
 *   不把未支持组合伪装成可验证；宿主据此不展示该路线并可换 text/voice；
 * - registry 只做分发，不持有服务端调用；scene 数据由宿主从 journeyPlan/
 *   PublicSceneContract 提供（public 净化题面，01-2 §3.2）。
 *
 * A11y / reduced-motion（§13.4）：所有 renderer 为键盘/读屏可完成的
 * 原生控件（复用 TapSelectPlaceLayer 的 tap-select-place 等价路径）；
 * 无计时、无速度评分。
 */

import { SceneType } from "@ailearn/shared";
import type { LearningScene } from "@ailearn/shared";
import { VoiceTeachBackScene } from "./scenes/VoiceTeachBackScene";
import { SilentProofScene } from "./scenes/SilentProofScene";

export type SceneRenderer =
  | ((props: { scene: LearningScene; onSubmit?: (payload: unknown) => Promise<void> | void }) => React.ReactElement | null)
  | null;

/**
 * 按 scene.kind 分发 renderer；未实现/未注册 kind → null（fail closed）。
 * 纯函数：不渲染、无副作用，便于单测锁定分发语义。
 */
export function sceneRendererFor(kind: string): SceneRenderer {
  switch (kind) {
    case SceneType.VOICE_TEACHBACK:
      return voiceTeachbackRenderer;
    case SceneType.ORDERING:
    case SceneType.REPAIR:
    case SceneType.RELATION_CANVAS:
    case SceneType.MULTI_STEP_SCENARIO:
    case SceneType.COUNTEREXAMPLE:
    case SceneType.OPTIONAL_TEXT:
      return silentProofRenderer;
    default:
      // fail closed：未知 kind 不渲染，宿主应回退 text/voice。
      return null;
  }
}

/** registry 中已注册的 kind 集合（供宿主做资格展示判定）。 */
export const REGISTERED_SCENE_KINDS: ReadonlySet<string> = new Set([
  SceneType.VOICE_TEACHBACK,
  SceneType.ORDERING,
  SceneType.REPAIR,
  SceneType.RELATION_CANVAS,
  SceneType.MULTI_STEP_SCENARIO,
  SceneType.COUNTEREXAMPLE,
  SceneType.OPTIONAL_TEXT,
]);

/** 是否已为该 kind 注册 renderer（fail-closed 资格判定）。 */
export function isSceneKindRenderable(kind: string): boolean {
  return REGISTERED_SCENE_KINDS.has(kind);
}

function voiceTeachbackRenderer(props: {
  scene: LearningScene;
  onSubmit?: (payload: unknown) => Promise<void> | void;
}): React.ReactElement | null {
  if (props.scene.sceneType !== SceneType.VOICE_TEACHBACK) return null;
  // voice_teachback 在阶段 A 已由 VoiceTeachBackScene 承载（录音 → 逐字确认 →
  // 提交）；此处透传宿主提交回调，宿主把确认 transcript 走既有提交链。
  const scene = props.scene;
  return (
    <VoiceTeachBackScene
      language="zh-CN"
      onSubmit={(transcript) => props.onSubmit?.({ transcript, sceneId: scene.sceneId }) ?? Promise.resolve()}
      ariaLabel="语音复述（场景渲染器）"
    />
  );
}

function silentProofRenderer(props: {
  scene: LearningScene;
  onSubmit?: (payload: unknown) => Promise<void> | void;
}): React.ReactElement | null {
  return (
    <SilentProofScene
      scene={props.scene}
      onSubmit={props.onSubmit}
    />
  );
}

export { SilentProofScene };
