import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyJobFailureReason } from "./service.ts";

describe("job failure reason projection", () => {
  it("exposes the stable AI consent recovery reason", () => {
    assert.equal(
      classifyJobFailureReason(
        "operational_error:configuration:AIConsentRequiredError:ai_consent_required",
      ),
      "ai_consent_required",
    );
  });

  it("does not expose or infer a free-form internal error", () => {
    assert.equal(
      classifyJobFailureReason("operational_error:provider:Error"),
      "unknown",
    );
    assert.equal(classifyJobFailureReason(null), null);
  });
});
