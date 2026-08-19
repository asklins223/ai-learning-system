import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveHomeOnboardingVisibility } from "../home-onboarding";

describe("home onboarding visibility", () => {
  it("always returns false after Journey V2 cutover", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: false,
        isPersonalWorkspace: true,
        isEmptyWorkspace: true,
      }),
      { showOnboarding: false, isFirstUse: false },
    );
  });

  it("does not show onboarding in an active workspace", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: false,
        isPersonalWorkspace: true,
        isEmptyWorkspace: false,
      }),
      { showOnboarding: false, isFirstUse: false },
    );
  });

  it("does not show onboarding in another user's workspace", () => {
    assert.deepEqual(
      resolveHomeOnboardingVisibility({
        accountLoading: false,
        isPersonalWorkspace: false,
        isEmptyWorkspace: true,
      }),
      { showOnboarding: false, isFirstUse: false },
    );
  });

  it("does not flash onboarding while identity is loading", () => {
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
