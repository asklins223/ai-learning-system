/**
 * 任务 06-6：单 Key Point transfer 最小切片守卫单测（§14.1/§8，06-w5 任务 06-6）。
 *
 * 覆盖（验收）：
 * - transfer 无完整 rubric/evidence 时不可达（fail closed，无任何学习/schedule 副作用）；
 * - 三种形态：situated_application（单 Key Point 情境）/ repair（故障修复）/
 *   boundary_variant（边界变式）→ 各自 sceneKind；
 * - 默认 record_only 语义：非 official create/consume（含官方 record_only）→
 *   facet_observation，scheduleAffected=false，只写 facet；
 * - schedule 影响仅限 official 签发：create_initial/consume_pending + 完整
 *   mastery plan 通过 → mastery_transfer，scheduleAffected=true；mastery 未通过
 *   降级为 record_only；
 * - explore（随便看看）：听解释/证据浏览/开放问题/沙盘全部 practice-only，
 *   不消费 schedule；非法 mode fail closed。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthorizedAction,
  evaluateExploreAccess,
  evaluateTransferAccess,
  ExploreMode,
  TransferDisposition,
  TransferForm,
  TransferSceneKind,
  type TransferGateInput,
} from "./transfer-gate.ts";

// ─── Fixtures / helpers ───────────────────────────────────────────────────

const KEY_POINT_ID = "kp-transfer-1";

/** 完整 rubric/evidence 的 transfer 输入（最小切片前提满足）。 */
function transferInput(
  overrides?: Partial<TransferGateInput>,
): TransferGateInput {
  return {
    keyPointId: KEY_POINT_ID,
    rubricComplete: true,
    evidenceComplete: true,
    transferForm: TransferForm.SITUATED_APPLICATION,
    authorizedAction: AuthorizedAction.RECORD_ONLY,
    masteryPlanPassed: false,
    ...overrides,
  };
}

// ─── 1. 无完整 rubric/evidence 不可达 ─────────────────────────────────────

describe("transfer-gate: 无完整 rubric/evidence 不可达", () => {
  it("rubric 不完整 → inaccessible + unavailable，0 schedule 副作用", () => {
    const verdict = evaluateTransferAccess(transferInput({ rubricComplete: false }));
    assert.equal(verdict.accessible, false);
    assert.equal(verdict.disposition, TransferDisposition.UNAVAILABLE);
    assert.equal(verdict.scheduleAffected, false);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.RECORD_ONLY);
    assert.ok(verdict.reasonCodes.includes("incomplete_rubric_transfer_unavailable"));
  });

  it("evidence 不完整 → inaccessible + unavailable，0 schedule 副作用", () => {
    const verdict = evaluateTransferAccess(transferInput({ evidenceComplete: false }));
    assert.equal(verdict.accessible, false);
    assert.equal(verdict.disposition, TransferDisposition.UNAVAILABLE);
    assert.equal(verdict.scheduleAffected, false);
    assert.ok(verdict.reasonCodes.includes("incomplete_evidence_transfer_unavailable"));
  });

  it("rubric 与 evidence 均不完整 → 两条原因码都出现", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ rubricComplete: false, evidenceComplete: false }),
    );
    assert.equal(verdict.accessible, false);
    assert.equal(verdict.disposition, TransferDisposition.UNAVAILABLE);
    assert.ok(verdict.reasonCodes.includes("incomplete_rubric_transfer_unavailable"));
    assert.ok(verdict.reasonCodes.includes("incomplete_evidence_transfer_unavailable"));
  });

  it("非法 transferForm → fail closed（unavailable）", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ transferForm: "not-a-form" as TransferForm }),
    );
    assert.equal(verdict.accessible, false);
    assert.equal(verdict.disposition, TransferDisposition.UNAVAILABLE);
    assert.ok(verdict.reasonCodes.includes("invalid_transfer_form"));
  });

  it("非 official authorizedAction → 默认 record_only 写 facet，0 schedule", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ authorizedAction: "self_issued" as AuthorizedAction }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.disposition, TransferDisposition.FACET_OBSERVATION);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.RECORD_ONLY);
    assert.equal(verdict.scheduleAffected, false);
    assert.ok(verdict.reasonCodes.includes("non_official_authorized_action_default_record_only"));
  });
});

// ─── 2. 三种形态 ───────────────────────────────────────────────────────────

describe("transfer-gate: 三种形态", () => {
  it("situated_application → multi_step_scenario（单 Key Point 情境）", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ transferForm: TransferForm.SITUATED_APPLICATION }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.transferForm, TransferForm.SITUATED_APPLICATION);
    assert.equal(verdict.sceneKind, TransferSceneKind.MULTI_STEP_SCENARIO);
  });

  it("repair → repair（故障修复）", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ transferForm: TransferForm.REPAIR }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.transferForm, TransferForm.REPAIR);
    assert.equal(verdict.sceneKind, TransferSceneKind.REPAIR);
  });

  it("boundary_variant → conditional_variant（边界变式）", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ transferForm: TransferForm.BOUNDARY_VARIANT }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.transferForm, TransferForm.BOUNDARY_VARIANT);
    assert.equal(verdict.sceneKind, TransferSceneKind.CONDITIONAL_VARIANT);
  });
});

// ─── 3. 默认 record_only 语义 ─────────────────────────────────────────────

describe("transfer-gate: 默认 record_only 写 facet", () => {
  it("官方 record_only → facet_observation，0 schedule，写 facet", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ authorizedAction: AuthorizedAction.RECORD_ONLY }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.disposition, TransferDisposition.FACET_OBSERVATION);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.RECORD_ONLY);
    assert.equal(verdict.scheduleAffected, false);
    assert.ok(verdict.reasonCodes.includes("transfer_default_facet_record_only"));
  });

  it("官方 no_effect（practice 路径）→ practice_only，0 facet、0 schedule", () => {
    const verdict = evaluateTransferAccess(
      transferInput({ authorizedAction: AuthorizedAction.NO_EFFECT }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.disposition, TransferDisposition.PRACTICE_ONLY);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.NO_EFFECT);
    assert.equal(verdict.scheduleAffected, false);
    assert.ok(verdict.reasonCodes.includes("transfer_practice_only_official_no_effect"));
  });

  it("create_initial 但完整 mastery plan 未通过 → 降级为 record_only（0 schedule）", () => {
    const verdict = evaluateTransferAccess(
      transferInput({
        authorizedAction: AuthorizedAction.CREATE_INITIAL,
        masteryPlanPassed: false,
      }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.disposition, TransferDisposition.FACET_OBSERVATION);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.RECORD_ONLY);
    assert.equal(verdict.scheduleAffected, false);
    assert.ok(
      verdict.reasonCodes.includes("transfer_mastery_plan_not_passed_downgraded_to_record_only"),
    );
  });
});

// ─── 4. schedule 影响仅限 official 签发 ────────────────────────────────────

describe("transfer-gate: schedule 影响仅限 official 签发 + 完整 mastery plan", () => {
  it("official create_initial + 完整 mastery plan 通过 → mastery_transfer，影响 schedule", () => {
    const verdict = evaluateTransferAccess(
      transferInput({
        authorizedAction: AuthorizedAction.CREATE_INITIAL,
        masteryPlanPassed: true,
      }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.disposition, TransferDisposition.MASTERY_TRANSFER);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.CREATE_INITIAL);
    assert.equal(verdict.scheduleAffected, true);
    assert.ok(verdict.reasonCodes.includes("transfer_mastery_authorized:create_initial"));
  });

  it("official consume_pending + 完整 mastery plan 通过 → mastery_transfer，影响 schedule", () => {
    const verdict = evaluateTransferAccess(
      transferInput({
        authorizedAction: AuthorizedAction.CONSUME_PENDING,
        masteryPlanPassed: true,
      }),
    );
    assert.equal(verdict.accessible, true);
    assert.equal(verdict.disposition, TransferDisposition.MASTERY_TRANSFER);
    assert.equal(verdict.effectiveAuthorizedAction, AuthorizedAction.CONSUME_PENDING);
    assert.equal(verdict.scheduleAffected, true);
    assert.ok(verdict.reasonCodes.includes("transfer_mastery_authorized:consume_pending"));
  });

  it("official create/consume + mastery 未通过绝不产生 schedule 影响", () => {
    for (const authorizedAction of [
      AuthorizedAction.CREATE_INITIAL,
      AuthorizedAction.CONSUME_PENDING,
    ]) {
      const verdict = evaluateTransferAccess(
        transferInput({ authorizedAction, masteryPlanPassed: false }),
      );
      assert.equal(verdict.scheduleAffected, false, `${authorizedAction} 不得影响 schedule`);
      assert.equal(verdict.disposition, TransferDisposition.FACET_OBSERVATION);
    }
  });

  it("完整 rubric/evidence 但官方 record_only → 不因 rubric 完整而升级 schedule", () => {
    const verdict = evaluateTransferAccess(
      transferInput({
        rubricComplete: true,
        evidenceComplete: true,
        authorizedAction: AuthorizedAction.RECORD_ONLY,
      }),
    );
    assert.equal(verdict.scheduleAffected, false);
    assert.equal(verdict.disposition, TransferDisposition.FACET_OBSERVATION);
  });
});

// ─── 5. explore：全部 practice-only ───────────────────────────────────────

describe("transfer-gate: explore 全部 practice-only、不消费 schedule", () => {
  it("听解释 / 证据浏览 / 开放问题 / 沙盘 → allowed，no_effect，0 schedule", () => {
    for (const mode of [
      ExploreMode.EXPLANATION,
      ExploreMode.EVIDENCE_BROWSE,
      ExploreMode.OPEN_QUESTION,
      ExploreMode.SANDBOX,
    ]) {
      const verdict = evaluateExploreAccess(mode);
      assert.equal(verdict.allowed, true, `${mode} 应允许`);
      assert.equal(verdict.disposition, "practice_only");
      assert.equal(verdict.effectiveAuthorizedAction, "no_effect");
      assert.equal(verdict.scheduleAffected, false);
      assert.ok(verdict.reasonCodes.includes("explore_practice_only_no_schedule_effect"));
    }
  });

  it("非法 explore mode → fail closed（allowed=false，仍不消费 schedule）", () => {
    const verdict = evaluateExploreAccess("anything-goes" as ExploreMode);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.disposition, "practice_only");
    assert.equal(verdict.effectiveAuthorizedAction, "no_effect");
    assert.equal(verdict.scheduleAffected, false);
    assert.ok(verdict.reasonCodes.includes("invalid_explore_mode"));
  });
});
