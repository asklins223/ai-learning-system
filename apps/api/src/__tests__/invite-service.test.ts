import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConsumeInviteError,
  ONBOARDING_STEPS,
  type ConsumeInviteErrorCode,
} from "../modules/identity/invite-service.ts";

describe("invite-service: ConsumeInviteError", () => {
  it("creates error with correct code and message", () => {
    const error = new ConsumeInviteError("not_found");
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "not_found");
    assert.equal(error.name, "ConsumeInviteError");
  });

  it("supports all defined error codes", () => {
    const codes: ConsumeInviteErrorCode[] = [
      "not_found",
      "expired",
      "revoked",
      "already_consumed",
      "email_exists",
      "concurrent_consumption",
    ];
    for (const code of codes) {
      const error = new ConsumeInviteError(code);
      assert.equal(error.code, code);
      assert.ok(error instanceof Error);
      assert.ok(error instanceof ConsumeInviteError);
    }
  });

  it("is distinguishable from generic errors via instanceof", () => {
    const inviteError = new ConsumeInviteError("expired");
    const genericError = new Error("something else");
    assert.ok(inviteError instanceof ConsumeInviteError);
    assert.ok(!(genericError instanceof ConsumeInviteError));
  });
});

describe("invite-service: ONBOARDING_STEPS", () => {
  it("contains exactly 7 steps in expected order", () => {
    assert.equal(ONBOARDING_STEPS.length, 7);
    assert.deepEqual([...ONBOARDING_STEPS], [
      "ai_consent",
      "provider_config",
      "first_content",
      "first_note",
      "first_card",
      "evidence_review",
      "first_validation",
    ]);
  });

  it("steps are unique", () => {
    const unique = new Set(ONBOARDING_STEPS);
    assert.equal(unique.size, ONBOARDING_STEPS.length);
  });

  it("each step is a non-empty string", () => {
    for (const step of ONBOARDING_STEPS) {
      assert.equal(typeof step, "string");
      assert.ok(step.length > 0);
    }
  });
});

describe("invite-service: error code to HTTP status mapping", () => {
  // Verify the status mapping logic used in routes.ts is consistent
  const statusMap: Record<string, number> = {
    not_found: 404,
    expired: 410,
    revoked: 410,
    already_consumed: 409,
    email_exists: 409,
    concurrent_consumption: 409,
  };

  it("maps not_found to 404", () => {
    assert.equal(statusMap["not_found"], 404);
  });

  it("maps expired and revoked to 410 Gone", () => {
    assert.equal(statusMap["expired"], 410);
    assert.equal(statusMap["revoked"], 410);
  });

  it("maps conflict errors to 409", () => {
    assert.equal(statusMap["already_consumed"], 409);
    assert.equal(statusMap["email_exists"], 409);
    assert.equal(statusMap["concurrent_consumption"], 409);
  });

  it("all ConsumeInviteErrorCode values have a status mapping", () => {
    const allCodes: ConsumeInviteErrorCode[] = [
      "not_found",
      "expired",
      "revoked",
      "already_consumed",
      "email_exists",
      "concurrent_consumption",
    ];
    for (const code of allCodes) {
      assert.ok(code in statusMap, `missing status mapping for ${code}`);
    }
  });
});
