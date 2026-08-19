export interface HomeOnboardingVisibilityInput {
  accountLoading: boolean;
  isPersonalWorkspace: boolean;
  isEmptyWorkspace: boolean;
}

/**
 * New-user guidance belongs to a workspace owned by the current user. Keeping
 * this decision outside the component also prevents a member view from briefly
 * mounting the guide while identity is still loading.
 *
 * P6 cutover complete (2026-08-14): Journey V2 + system_pet_v2 are atomically
 * enabled. First-use onboarding is handled by the companion pet + Journey,
 * so the homepage onboarding card is permanently disabled.
 */
export function resolveHomeOnboardingVisibility(
  _input: HomeOnboardingVisibilityInput,
): {
  showOnboarding: boolean;
  isFirstUse: boolean;
} {
  return { showOnboarding: false, isFirstUse: false };
}
