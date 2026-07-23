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
  const showOnboarding = !accountLoading && isPersonalWorkspace;
  return {
    showOnboarding,
    isFirstUse: showOnboarding && isEmptyWorkspace,
  };
}
