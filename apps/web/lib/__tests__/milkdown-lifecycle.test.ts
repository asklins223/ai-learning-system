import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withReadyMilkdownEditor } from "../milkdown-lifecycle.ts";

describe("Milkdown imperative lifecycle guard", () => {
  it("runs an operation only while the editor context is created", () => {
    const editor = { status: "Created", value: "draft" };

    assert.equal(
      withReadyMilkdownEditor(editor, (ready) => ready.value, null),
      "draft",
    );
  });

  for (const status of ["Idle", "OnCreate", "OnDestroy", "Destroyed"]) {
    it(`returns the fallback without touching a ${status} editor`, () => {
      let called = false;
      const result = withReadyMilkdownEditor(
        { status },
        () => {
          called = true;
          return "unexpected";
        },
        null,
      );

      assert.equal(result, null);
      assert.equal(called, false);
    });
  }

  it("tolerates a context disappearing between the status check and action", () => {
    assert.equal(
      withReadyMilkdownEditor(
        { status: "Created" },
        () => {
          throw new Error('Context "editorView" not found');
        },
        null,
      ),
      null,
    );
  });
});
