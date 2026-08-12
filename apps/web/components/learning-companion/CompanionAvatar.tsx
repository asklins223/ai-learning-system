"use client";

/**
 * 任务 05-4：统一基础角色组件 —— 年轻星际导航员（§5.2 / 冻结记录 01-8）。
 *
 * 角色规格（01-8 §3）：约 2.5~3 头身、发光星纹、短披风/围巾式彗尾、可变形的
 * 导航环；二维动画造型、干净色块、柔和描边；公测只交付一个统一基础角色。
 *
 * 本组件默认使用 owner 提供的静态参考资产；CSS/SVG 仍保留为资源加载失败时
 * 的最后降级层（02-10 spike）：
 * - 由 `CompanionVisualStateV1` props 驱动，动画只表达已发生的系统状态
 *   （系统事件权威映射在 lib/learning-companion/companion-visual-state.ts）；
 * - `systemEvent` 作为防御性入参：若提供的视觉状态与该事件不匹配，呈现
 *   不会伪装（handoffViewFor 只对 assessment_started 放行观测环）；
 * - `assessment_handoff` 可见退场：收起提示工具、退到场景边缘、独立观测环
 *   接管验证状态（表达「伴星不参与判分」）；
 * - reduced-motion：取消飞行 / 弹性缩放 / 视差 / 持续漂浮，静态呈现；
 * - 当前无 Rive 主资产时：按状态选择 owner 参考图静态立绘；资源失败再退回
 *   图标化 SVG + 标准控件（01-8 §9）；
 * - `hidden`（temporary_hidden/global_off）立即停渲染（§5.5）。
 *
 * 未来 Rive 主引擎（.riv 矢量/骨骼）可在保持本 props 接口的前提下替换内部
 * 渲染实现，静态 fallback 语义不变。
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  companionPoseForState,
  handoffViewFor,
  resolveCompanionPresentation,
  type CompanionPose,
  type CompanionPresentation,
  type CompanionSystemEvent,
  type CompanionVisualStateV1,
} from "@/lib/learning-companion/companion-visual-state";
import { companionReferenceAssetForState } from "@/lib/learning-companion/companion-reference-assets";

export interface CompanionAvatarProps {
  /** 视觉状态（由上层按系统事件权威映射驱动） */
  state: CompanionVisualStateV1;
  /** 触发该状态的真实系统事件（防御性：动画只表达已发生状态） */
  systemEvent?: CompanionSystemEvent;
  /** prefers-reduced-motion: reduce（或 animation_off） */
  prefersReducedMotion?: boolean;
  /** 动画资产（Rive .riv）加载成功；当前默认使用参考图静态资产 */
  assetLoaded?: boolean;
  /** temporary_hidden / global_off：立即停渲染 */
  hidden?: boolean;
  /** quiet 未召唤：dormant 只静态中性锚点 */
  quiet?: boolean;
  /** 角色尺寸（px 宽高） */
  size?: number;
  /** 在角色下方显示状态文字（读屏/低视觉降级，§13.4：动画不是唯一信息载体） */
  showLabel?: boolean;
  ariaLabel?: string;
  className?: string;
}

// ─── 组件内联动画说明 ──────────────────────────────────────────────────────
// lc-* 动画 keyframes 与 .lc-anim-* 类已移至全局样式 apps/web/app/globals.css
//（原每实例每渲染注入 <style> 会在多实例时重复注入同一批全局 @keyframes）。
// reduced-motion 下 motionEnabled=false，组件不挂 .lc-anim-* 类，动画不应用。

const PALETTE = {
  skin: "#FFD9B8",
  skinStroke: "#8A5A44",
  coat: "#4A7BD8",
  coatDark: "#3A63B0",
  coatStroke: "#2F4E8C",
  comet: "#FF9E6D",
  cometStroke: "#C96A3F",
  ring: "#5EA8FF",
  ringStroke: "#2E7FD9",
  star: "#FFE066",
  toolPaper: "#FDF6E9",
  toolStroke: "#C9A86A",
  eye: "#4A2E2A",
  observer: "#FF8A5C",
  observerStroke: "#C4502E",
} as const;

function renderEyes(pose: CompanionPose, key: string) {
  const left = 52;
  const right = 68;
  const y = 40;
  if (pose.eyes === "closed") {
    return (
      <g key={key} aria-hidden="true">
        <path d={`M${left - 3} ${y} Q${left} ${y + 3} ${left + 3} ${y}`} fill="none" stroke={PALETTE.eye} strokeWidth={2.2} strokeLinecap="round" />
        <path d={`M${right - 3} ${y} Q${right} ${y + 3} ${right + 3} ${y}`} fill="none" stroke={PALETTE.eye} strokeWidth={2.2} strokeLinecap="round" />
      </g>
    );
  }
  const rx = pose.eyes === "focus" ? 3.1 : 2.5;
  return (
    <g key={key} aria-hidden="true">
      <ellipse cx={left} cy={y} rx={rx} ry={3.4} fill={PALETTE.eye} />
      <ellipse cx={right} cy={y} rx={rx} ry={3.4} fill={PALETTE.eye} />
      <circle cx={left + 1} cy={y - 1.2} r={0.9} fill="#fff" />
      <circle cx={right + 1} cy={y - 1.2} r={0.9} fill="#fff" />
    </g>
  );
}

function renderMouth(pose: CompanionPose, key: string) {
  if (pose.mouth === "smile") {
    return <path key={key} d="M55 49.5 Q60 54 65 49.5" fill="none" stroke={PALETTE.skinStroke} strokeWidth={2.2} strokeLinecap="round" aria-hidden="true" />;
  }
  if (pose.mouth === "speaking") {
    return <ellipse key={key} cx={60} cy={50.5} rx={2.7} ry={2.2} fill={PALETTE.skinStroke} aria-hidden="true" />;
  }
  return <path key={key} d="M56 50.5 Q60 52.4 64 50.5" fill="none" stroke={PALETTE.skinStroke} strokeWidth={2.2} strokeLinecap="round" aria-hidden="true" />;
}

/** 导航环（可变形态：full / partial / hidden）+ 观测环 */
function renderRings(
  pose: CompanionPose,
  observerRing: boolean,
  key: string,
  motionEnabled: boolean,
) {
  const rings: ReactNode[] = [];
  if (pose.ring === "full" || pose.ring === "partial") {
    const ring = pose.ring === "full"
      ? (
        <ellipse
          cx={60}
          cy={66}
          rx={34}
          ry={29}
          fill="none"
          stroke={PALETTE.ring}
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.85}
        />
      )
      : (
        <path
          d="M26 66 A34 29 0 0 1 94 66"
          fill="none"
          stroke={PALETTE.ring}
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.85}
        />
      );
    rings.push(
      <g key="ring" className={motionEnabled ? "lc-anim-ring" : undefined} aria-hidden="true">
        {ring}
        <circle cx={94} cy={66} r={2.4} fill={PALETTE.ringStroke} />
      </g>,
    );
  }
  if (observerRing) {
    // 独立「观测环」：与导航环不同颜色，表达外部评估接管（伴星不参与判分）
    rings.push(
      <g key="observer" aria-hidden="true">
        <circle cx={99} cy={22} r={10} fill="none" stroke={PALETTE.observer} strokeWidth={3} />
        <circle cx={99} cy={22} r={3} fill={PALETTE.observer} className={motionEnabled ? "lc-anim-glow" : undefined} />
        <path d="M93 30 L105 38" stroke={PALETTE.observerStroke} strokeWidth={2} strokeLinecap="round" />
      </g>,
    );
  }
  return <g key={key}>{rings}</g>;
}

function renderTool(pose: CompanionPose, key: string) {
  if (!pose.toolVisible) return null;
  return (
    <g key={key} aria-hidden="true">
      {/* 提示工具（证据卡/提示卡）：一张小卡片，示意文本，非真实内容 */}
      <rect x={82} y={42} width={27} height={19} rx={3.5} fill={PALETTE.toolPaper} stroke={PALETTE.toolStroke} strokeWidth={1.8} />
      <path d="M87 48 H104 M87 52 H98 M87 56 H100" stroke={PALETTE.toolStroke} strokeWidth={1.6} strokeLinecap="round" />
    </g>
  );
}

function renderComet(pose: CompanionPose, key: string) {
  if (!pose.comet) return null;
  return (
    <g key={key} aria-hidden="true">
      {/* 围巾式彗尾（短披风）：从颈后向右后方飘出的两条飘带 */}
      <path
        d="M58 54 C 46 60 38 66 34 80 C 40 74 48 68 55 66 Z"
        fill={PALETTE.comet}
        stroke={PALETTE.cometStroke}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <path
        d="M63 55 C 54 62 49 72 48 86 C 54 78 60 70 65 66 Z"
        fill={PALETTE.comet}
        stroke={PALETTE.cometStroke}
        strokeWidth={1.6}
        strokeLinejoin="round"
        opacity={0.9}
      />
    </g>
  );
}

function renderStar(pose: CompanionPose, key: string, motionEnabled: boolean) {
  if (!pose.starGlow) return null;
  // 额头发光星纹（示意，非真实内容）
  return (
    <path
      key={key}
      d="M60 24 l1.7 3.1 3.4 0.4 -2.5 2.5 0.6 3.4 -3.2 -1.7 -3.2 1.7 0.6 -3.4 -2.5 -2.5 3.4 -0.4 Z"
      fill={PALETTE.star}
      stroke={PALETTE.cometStroke}
      strokeWidth={0.8}
      className={motionEnabled ? "lc-anim-glow" : undefined}
      aria-hidden="true"
    />
  );
}

/** 手部姿态渲染（手的位置/姿势随状态，静态或轻动画） */
function renderHand(pose: CompanionPose, key: string, waveAnim: boolean) {
  switch (pose.hand) {
    case "wave": {
      const content = (
        <>
          <path d="M74 60 L87 47" stroke={PALETTE.coatDark} strokeWidth={5} strokeLinecap="round" />
          <circle cx={90} cy={44} r={4.2} fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={1.6} />
          <circle cx={88} cy={41.5} r={1.2} fill={PALETTE.skin} />
          <circle cx={92} cy={42.5} r={1.2} fill={PALETTE.skin} />
        </>
      );
      return waveAnim
        ? <g key={key} className="lc-anim-wave" aria-hidden="true">{content}</g>
        : <g key={key} aria-hidden="true">{content}</g>;
    }
    case "point": {
      return (
        <g key={key} aria-hidden="true">
          <path d="M72 61 L86 57" stroke={PALETTE.coatDark} strokeWidth={5} strokeLinecap="round" />
          <path d="M88 55.5 L91.5 55.8 L88.6 59.6 Z" fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={1.2} strokeLinejoin="round" />
        </g>
      );
    }
    case "ring_hold": {
      return (
        <g key={key} aria-hidden="true">
          {/* 双手托住导航环前缘 */}
          <path d="M45 62 C 42 68 44 73 50 74" stroke={PALETTE.coatDark} strokeWidth={5} strokeLinecap="round" />
          <path d="M75 62 C 78 68 76 73 70 74" stroke={PALETTE.coatDark} strokeWidth={5} strokeLinecap="round" />
          <circle cx={50} cy={75} r={4} fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={1.5} />
          <circle cx={70} cy={75} r={4} fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={1.5} />
        </g>
      );
    }
    default: {
      // hand: down —— 双臂自然垂于身侧
      return (
        <g key={key} aria-hidden="true">
          <path d="M48 58 C 44 66 45 76 47 81" stroke={PALETTE.coatDark} strokeWidth={5} strokeLinecap="round" />
          <path d="M72 58 C 76 66 75 76 73 81" stroke={PALETTE.coatDark} strokeWidth={5} strokeLinecap="round" />
          <circle cx={47} cy={82.5} r={3.6} fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={1.5} />
          <circle cx={73} cy={82.5} r={3.6} fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={1.5} />
        </g>
      );
    }
  }
}

export function CompanionAvatar({
  state,
  systemEvent,
  prefersReducedMotion = false,
  assetLoaded = false,
  hidden = false,
  quiet = false,
  size = 96,
  showLabel = false,
  ariaLabel,
  className,
}: CompanionAvatarProps) {
  const [referenceAssetFailed, setReferenceAssetFailed] = useState(false);
  const presentation: CompanionPresentation = useMemo(
    () =>
      resolveCompanionPresentation(state, {
        prefersReducedMotion,
        assetLoaded,
        hidden,
        quiet,
      }),
    [state, prefersReducedMotion, assetLoaded, hidden, quiet],
  );
  const pose = useMemo(() => companionPoseForState(state), [state]);
  const handoff = useMemo(
    () => handoffViewFor(systemEvent ?? null, state),
    [systemEvent, state],
  );

  // hidden（temporary_hidden/global_off）或 reduced-motion 下的 exit_or_hidden：立即停渲染
  const motionEnabled = presentation.motionEnabled;
  if (presentation.renderMode === "hidden") return null;

  // reduced-motion / 资产失败：取消飞行/弹性缩放/视差/持续漂浮（静态呈现）
  const floatAnim = motionEnabled && (state === "navigate" || state === "present_evidence");
  const waveAnim = motionEnabled && state === "invite_once";

  const label = ariaLabel ?? presentation.ariaLabel;
  const referenceAsset = companionReferenceAssetForState(state);
  const useReferenceAsset = Boolean(referenceAsset) && !referenceAssetFailed;

  return (
    <div
      className={`inline-flex flex-col items-center gap-1 ${className ?? ""}`}
      data-testid="companion-avatar"
      data-asset-source={useReferenceAsset ? "owner-reference-static" : "code-fallback"}
    >
      {useReferenceAsset ? (
        <span
          className={`relative inline-flex ${floatAnim ? "lc-anim-float" : ""}`}
          style={handoff.retreatToEdge ? { transform: "translateX(-22%)" } : undefined}
          data-companion-state={state}
          data-render-mode={presentation.renderMode}
        >
          <img
            src={referenceAsset ?? undefined}
            width={size}
            height={size}
            alt={label}
            className="block object-contain"
            onError={() => setReferenceAssetFailed(true)}
          />
          {handoff.observerRingActive ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-0 top-1 size-3 rounded-full border-2 border-[#ff8a5c] bg-[#ff8a5c]/20"
            />
          ) : null}
        </span>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox="0 0 120 120"
          role="img"
          aria-label={label}
          data-companion-state={state}
          data-render-mode={presentation.renderMode}
          className={floatAnim ? "lc-anim-float" : undefined}
        >
          {/* 角色组：assessment_handoff 时退到场景边缘（向左平移），观测环留在右上方 */}
          <g
            transform={handoff.retreatToEdge ? "translate(-26 0)" : undefined}
            aria-hidden="true"
          >
            {renderComet(pose, "comet")}
            {renderRings(pose, handoff.observerRingActive, "rings", motionEnabled)}
            {/* 身体（外套色块，柔和描边） */}
            <rect x={45} y={52} width={30} height={32} rx={12} fill={PALETTE.coat} stroke={PALETTE.coatStroke} strokeWidth={2} />
            {/* 腿 */}
            <rect x={51} y={84} width={6.5} height={13} rx={3} fill={PALETTE.coatDark} />
            <rect x={62.5} y={84} width={6.5} height={13} rx={3} fill={PALETTE.coatDark} />
            {/* 头部 */}
            <circle cx={60} cy={38} r={17} fill={PALETTE.skin} stroke={PALETTE.skinStroke} strokeWidth={2} />
            {renderStar(pose, "star", motionEnabled)}
            {renderEyes(pose, "eyes")}
            {renderMouth(pose, "mouth")}
            {renderHand(pose, "hand", waveAnim)}
            {renderTool(pose, "tool")}
          </g>
        </svg>
      )}
      {showLabel ? (
        <p className="text-center text-xs text-muted" role="note">
          {label}
        </p>
      ) : null}
    </div>
  );
}
