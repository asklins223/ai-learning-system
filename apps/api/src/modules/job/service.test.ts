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

  it("只按脱敏错误的**结构**取码，不再按后缀猜测（P1-15 回归）", () => {
    // 旧实现是 endsWith(":ai_consent_required")：任何以该后缀结尾的文本
    // （模型输出/用户内容被拼进错误消息）都会被误判成"需要签署同意"。
    assert.equal(
      classifyJobFailureReason("model said: please retry: ai_consent_required"),
      "unknown",
    );
    assert.equal(classifyJobFailureReason("ai_consent_required"), "unknown");
    // 结构正确但码名不同 → 仍归 unknown。
    assert.equal(
      classifyJobFailureReason("operational_error:configuration:OtherError:other_code"),
      "unknown",
    );
    // 结构正确且码名一致 → 命中（防止修过头）。
    assert.equal(
      classifyJobFailureReason("operational_error:configuration:AIConsentRequiredError:ai_consent_required"),
      "ai_consent_required",
    );
  });
});
