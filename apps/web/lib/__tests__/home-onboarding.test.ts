import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveHomeOnboardingVisibility } from "../home-onboarding";

describe("home onboarding visibility", () => {
  it("shows first-use guidance only in an empty workspace owned by the user", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: false,
        isPersonalWorkspace: true,
        isEmptyWorkspace: true,
      }),
      { showOnboarding: true, isFirstUse: true },
    );
  });

  it("does not show the legacy milestone projection in an active workspace", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: false,
        isPersonalWorkspace: true,
        isEmptyWorkspace: false,
      }),
      { showOnboarding: false, isFirstUse: false },
    );
  });

  it("never shows guidance in another user's workspace", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: false,
        isPersonalWorkspace: false,
        isEmptyWorkspace: true,
      }),
      { showOnboarding: false, isFirstUse: false },
    );
  });

  it("does not flash guidance while identity is loading", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: true,
        isPersonalWorkspace: true,
        isEmptyWorkspace: true,
      }),
      { showOnboarding: false, isFirstUse: false },
    );
  });
});
