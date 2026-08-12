import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeErrorMessage } from "@ailearn/shared";
import { AIConsentRequiredError } from "./governance.ts";

describe("AI consent governance error", () => {
  it("persists a privacy-safe recovery code for the web app", () => {
    assert.equal(
      safeErrorMessage(new AIConsentRequiredError()),
      "operational_error:configuration:AIConsentRequiredError:ai_consent_required",
    );
  });
});
