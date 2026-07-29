import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearActionKey,
  getOrCreateActionKey,
} from "../validation-action-keys.ts";

describe("validation action idempotency keys", () => {
  it("reuses the original key until the action has a definitive outcome", () => {
    const store = new Map<string, string>();
    let sequence = 0;
    const createId = () => `id-${++sequence}`;

    const first = getOrCreateActionKey(store, "submit:session:3", "ui-submit", createId);
    const retry = getOrCreateActionKey(store, "submit:session:3", "ui-submit", createId);

    assert.equal(first, "ui-submit-id-1");
    assert.equal(retry, first);
    assert.equal(sequence, 1);

    clearActionKey(store, "submit:session:3");
    const nextAttempt = getOrCreateActionKey(
      store,
      "submit:session:3",
      "ui-submit",
      createId,
    );
    assert.equal(nextAttempt, "ui-submit-id-2");
  });

  it("keeps independent actions in independent slots", () => {
    const store = new Map<string, string>();

    const submit = getOrCreateActionKey(store, "submit:session:1", "submit", () => "a");
    const reveal = getOrCreateActionKey(store, "result:session", "result", () => "b");

    assert.equal(submit, "submit-a");
    assert.equal(reveal, "result-b");
  });
});
