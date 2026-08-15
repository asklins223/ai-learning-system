import { isJourneyV2Enabled } from "@/lib/feature-flags";

export interface HomeOnboardingVisibilityInput {
  accountLoading: boolean;
  isPersonalWorkspace: boolean;
  isEmptyWorkspace: boolean;
}

/**
 * New-user guidance belongs to a workspace owned by the current user. Keeping
 * this decision outside the component also prevents a member view from briefly
 * mounting the guide while identity is still loading.
 */
export function resolveHomeOnboardingVisibility({
  accountLoading,
  isPersonalWorkspace,
  isEmptyWorkspace,
}: HomeOnboardingVisibilityInput): {
  showOnboarding: boolean;
  isFirstUse: boolean;
} {
  // P6（2026-08-14 切流）：Journey V2 + system_pet_v2 已原子开启——新用户
  // 首次引导由桌宠 + Journey 承担，首页 onboarding 大卡停用（§22.2：
  // 首次移除 fallback 时 journey_v2 与 system_pet_v2 必须同时开启）。
  if (isJourneyV2Enabled()) {
    return { showOnboarding: false, isFirstUse: false };
  }
  // 旧 fallback（capability 关闭时）：仅 first-use 恢复面。
  const showOnboarding =
    !accountLoading && isPersonalWorkspace && isEmptyWorkspace;
  return {
    showOnboarding,
    isFirstUse: showOnboarding,
  };
}
