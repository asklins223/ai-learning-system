"use client";

/**
 * 设置页「伴星」区（阶段 07-1 + 07-4 + 07-9 接线层）。
 *
 * - `OnboardingInvite`：首次使用引导入口（三个同级动作：带我走一遍 / 我自己看看 /
 *   先调整方式；「我自己看看」直接跳过，不用弱化颜色/倒计时/二次挽留）。
 * - 存在感说明：安静陪伴 / 适时提醒 / 主动建议三档（默认安静；未选择前不自动升级）。
 * - 重播入口：已完成后可随时手动重新开始引导（manual replay，不自动重放）。
 *
 * 服务端调用（CAS onboarding transition / 偏好持久化）经 props 注入；
 * 本组件只做 UI 编排，不直接调用网络（与 07-1 组件风格一致）。
 */

import { useState } from "react";
import { OnboardingInvite } from "./OnboardingInvite";
import type { CompanionAccountState } from "@/features/companion/api/contracts";

type CompanionAccountPatch = {
  globalEnabled?: boolean;
  animationOff?: boolean;
  voiceOff?: boolean;
};

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
  /** 当前账号级状态；由服务端 `/me/companion` 提供。 */
  account?: CompanionAccountState;
  /** 账号级偏好 CAS 保存；组件不自行猜测 revision。 */
  onUpdateAccount?: (patch: CompanionAccountPatch) => Promise<void>;
  accountSaving?: boolean;
  /** true → 不渲染自带分区标题（宿主已有更高层标题，避免重复）。 */
  hideHeading?: boolean;
}

export function CompanionSettings({
  onboardingConsumed = false,
  onStartOnboarding,
  onSkipOnboarding,
  onAdjustMode,
  onReplayOnboarding,
  account,
  onUpdateAccount,
  accountSaving = false,
  hideHeading = false,
}: CompanionSettingsProps) {
  const [showPresence, setShowPresence] = useState(false);

  return (
    <section className="settings-section" data-ui="companion-settings" aria-labelledby={hideHeading ? undefined : "companion-settings-title"}>
      {!hideHeading && (
        <header className="settings-section__header">
          <h2 id="companion-settings-title">伴星</h2>
          <p className="settings-section__caption">
            学习伴星的存在感、首次引导与相处方式。
          </p>
        </header>
      )}

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
            onClick={() => {
              const next = !showPresence;
              setShowPresence(next);
              if (next) onAdjustMode();
            }}
            className="settings-block__toggle"
            aria-expanded={showPresence}
            aria-controls="companion-settings-presence-body"
          >
            相处方式
            <span aria-hidden="true">▾</span>
          </button>
        </h3>
        {showPresence && (
          <div className="settings-block__body" id="companion-settings-presence-body">
            <ul>
              <li><strong>安静陪伴（默认）</strong>：未召唤时只保留静态入口，不主动打扰。</li>
              <li><strong>适时提醒</strong>：只在恢复、可恢复错误或完成变化时给一次邀请，未响应即退场。</li>
              <li><strong>主动建议</strong>：在说明原因后提供下一步或路线，但不会自动开始。</li>
            </ul>
            <p className="settings-block__muted">
              任一方式都不会自动打开麦克风、自动进入下一题或催促你；随时可以隐藏入口。
            </p>
          </div>
        )}
      </div>

      {account && onUpdateAccount && (
        <div className="settings-block" data-ui="companion-account-controls">
          <h3>设备与隐私</h3>
          <p className="settings-block__muted">
            这些开关会通过账号级版本号保存，刷新后仍然生效。关闭全局伴星会立即移除页面入口。
          </p>
          <div className="companion-settings-controls" aria-busy={accountSaving}>
            <label className="companion-settings-control">
              <input
                type="checkbox"
                checked={account.globalEnabled}
                disabled={accountSaving}
                onChange={(event) => void onUpdateAccount({ globalEnabled: event.target.checked })}
              />
              <span>
                <strong>显示伴星入口</strong>
                <small>关闭后不显示角色、面板或主动提示。</small>
              </span>
            </label>
            <label className="companion-settings-control">
              <input
                type="checkbox"
                checked={!account.animationOff}
                disabled={accountSaving}
                onChange={(event) => void onUpdateAccount({ animationOff: !event.target.checked })}
              />
              <span>
                <strong>启用角色动画</strong>
                <small>关闭后保留静态角色和文字状态。</small>
              </span>
            </label>
            <label className="companion-settings-control">
              <input
                type="checkbox"
                checked={!account.voiceOff}
                disabled={accountSaving}
                onChange={(event) => void onUpdateAccount({ voiceOff: !event.target.checked })}
              />
              <span>
                <strong>允许伴星语音</strong>
                <small>关闭后仍可使用文字回答，不会自动打开麦克风。</small>
              </span>
            </label>
          </div>
        </div>
      )}
    </section>
  );
}
