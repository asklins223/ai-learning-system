"use client";

/**
 * 设置页「伴星」区（阶段 07-1 + 07-4 + 07-9 接线层）。
 *
 * - `OnboardingInvite`：首次使用引导入口（三个同级动作：带我走一遍 / 我自己看看 /
 *   先调整方式；「我自己看看」直接跳过，不用弱化颜色/倒计时/二次挽留）。
 * - 存在感说明：quiet / moderate / active 三档（默认安静；未选择前不自动升级）。
 * - 重播入口：已完成后可随时手动重新开始引导（manual replay，不自动重放）。
 *
 * 服务端调用（CAS onboarding transition / 偏好持久化）经 props 注入；
 * 本组件只做 UI 编排，不直接调用网络（与 07-1 组件风格一致）。
 */

import { useState } from "react";
import { OnboardingInvite } from "./OnboardingInvite";

export interface CompanionSettingsProps {
  /** 引导是否已完成/已跳过（已完成则不自动邀请，仅保留重播入口）。 */
  onboardingConsumed?: boolean;
  /** 带我走一遍（宿主先做 02-3 CAS start 取得一次性 display permit）。 */
  onStartOnboarding: () => void;
  /** 我自己看看（宿主调用 CAS skip）。 */
  onSkipOnboarding: () => void;
  /** 先调整方式（宿主进入相处方式设置）。 */
  onAdjustMode: () => void;
  /** 重播引导（manual replay；服务端不自动重放）。 */
  onReplayOnboarding?: () => void;
}

export function CompanionSettings({
  onboardingConsumed = false,
  onStartOnboarding,
  onSkipOnboarding,
  onAdjustMode,
  onReplayOnboarding,
}: CompanionSettingsProps) {
  const [showPresence, setShowPresence] = useState(false);

  return (
    <section className="settings-section" data-ui="companion-settings" aria-labelledby="companion-settings-title">
      <header className="settings-section__header">
        <h2 id="companion-settings-title">伴星</h2>
        <p className="settings-section__caption">
          学习伴侣的存在感、首次引导与相处方式（§5.4/§5.5）。
        </p>
      </header>

      {!onboardingConsumed && (
        <div className="settings-block">
          <h3>首次引导</h3>
          <OnboardingInvite
            onStart={onStartOnboarding}
            onSkip={onSkipOnboarding}
            onAdjustMode={onAdjustMode}
          />
        </div>
      )}

      {onboardingConsumed && onReplayOnboarding && (
        <div className="settings-block">
          <h3>重新播放首次引导</h3>
          <p>引导完成后不会自动重放；你可以随时从这里手动重新开始（§11.2）。</p>
          <button type="button" onClick={onReplayOnboarding} className="btn btn-secondary">
            重新播放引导
          </button>
        </div>
      )}

      <div className="settings-block">
        <h3>
          <button
            type="button"
            onClick={() => setShowPresence((v) => !v)}
            className="settings-block__toggle"
            aria-expanded={showPresence}
          >
            存在感档位（quiet / moderate / active）
            <span aria-hidden="true">{showPresence ? "▾" : "▸"}</span>
          </button>
        </h3>
        {showPresence && (
          <div className="settings-block__body">
            <ul>
              <li><strong>quiet（默认）</strong>：未召唤时只有静态中性锚点；除首次引导一次性邀请外主动提示为 0。</li>
              <li><strong>moderate</strong>：只在恢复、可恢复错误、stale 或 committed change 给一次邀请，未响应即退场。</li>
              <li><strong>active</strong>：moderate 基础上允许一条有原因说明的下一步或路线，但不自动开始。</li>
            </ul>
            <p className="settings-block__muted">
              任一档都不自动打开麦克风、不自动进入下一题、不因忽略而失望、无红色倒计时；可一键隐藏且保留完整手动能力（§5.5/§5.6）。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
