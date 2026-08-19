/**
 * 任务 07-6：Relationship Governance（§10.5，Should）单测。
 *
 * 覆盖（验收）：
 * - Should flag 关闭时动作不可见不可执行（fail closed）；
 * - 所有来源只能提议 candidate；candidate 恒虚线、不进入 formal target；
 * - 独立 relation support check：direct → supported；仅 partial → partial；
 *   存在 contradicting → unsupported（引用完整 ≠ 语义支撑通过）；
 * - authorized confirm|reject：个人 workspace 仅 owner；协作 workspace
 *   owner/editor/specialized_relation_governor；viewer 拒绝；confirm 前必须
 *   support passed；
 * - versioned publish + fingerprint：版本单调递增、指纹覆盖支持+授权；
 * - candidate 不能直接 published：未支持/未授权一律拒绝；
 * - 上游变化 stale → 撤回重审；重审通过后以更高版本 republish；
 * - audit 记录确定性 auditId。
 *
 * 全部纯函数测试，不需要数据库。
 * （避免 import type + @ailearn/shared 组合挂起，类型用结构兼容字面量。）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAuthorizationDecision,
  applySupportCheck,
  assertCandidateNotInFormalTarget,
  assertRelationGovernanceEnabled,
  authorizeRelationDecision,
  buildAuditRecord,
  checkRelationStaleness,
  isRelationGovernanceEnabled,
  proposeRelationCandidate,
  publishRelation,
  reviewAndRepublish,
  runIndependentSupportCheck,
  RelationGovernanceError,
} from "./relation-governance.ts";

// ─── 测试数据 ───────────────────────────────────────────────────────────────

const ENABLED = { semanticRelationGovernance: true };
const DISABLED = { semanticRelationGovernance: false };

function propose(opts: { source?: string; flags?: { semanticRelationGovernance: boolean } } = {}) {
  return proposeRelationCandidate({
    workspace: { id: "ws-1" },
    source: (opts.source ?? "tutor") as "tutor",
    from: { nodeType: "key_point", entityId: "kp-1" },
    to: { nodeType: "key_point", entityId: "kp-2" },
    kind: "prerequisite",
    claim: "kp-1 是 kp-2 的前置",
    proposedBy: "tutor-session-1",
    upstreamRefs: [
      { entityId: "card-1", fingerprint: "fp-card-1-v1" },
      { entityId: "evidence-1", fingerprint: "fp-ev-1-v1" },
    ],
    proposedAt: "2026-08-08T00:00:00.000Z",
    flags: opts.flags ?? ENABLED,
  });
}

/** 独立支持检查：candidate 引用新指纹（v2 用于重审场景） */
function supportCheck(
  record: ReturnType<typeof propose>,
  opts: { evidenceFingerprint?: string; support?: "direct" | "partial" | "contradicting" } = {},
) {
  return runIndependentSupportCheck({
    candidate: record.candidate,
    evidenceRefs: [
      {
        entityId: "evidence-1",
        fingerprint: opts.evidenceFingerprint ?? "fp-ev-1-v1",
        support: opts.support ?? "direct",
        semanticSupportReportHash: (opts.support ?? "direct") === "direct" ? "ssr-1" : null,
      },
    ],
    checkVersion: "relation-support-check-v1",
    checkedBy: "independent-support-checker",
    checkedAt: "2026-08-08T00:10:00.000Z",
  });
}

const OWNER_WORKSPACE = {
  id: "ws-1",
  collaboration: false,
  ownerId: "owner-1",
  grantedRoles: ["owner", "editor", "viewer"] as const,
};

function confirm(record: ReturnType<typeof propose>, at = "2026-08-08T00:20:00.000Z") {
  return applyAuthorizationDecision({
    record,
    decision: "confirm",
    actor: { userId: "owner-1", role: "owner" },
    workspace: OWNER_WORKSPACE,
    flags: ENABLED,
    decisionAt: at,
  });
}

/** 已通过独立支持检查（support_passed）的 record。 */
function supportedProposal() {
  const record = propose();
  return applySupportCheck(record, supportCheck(record));
}

/** 构造已 published 的 record（v1）。 */
function publishedRecord() {
  return confirm(supportedProposal());
}

// ─── Should flag（flag 关闭时动作不可见不可执行）────────────────────────────

describe("relation-governance: Should flag 关闭时动作不可见", () => {
  it("flag 关闭时 propose 一律拒绝（fail closed）", () => {
    assert.equal(isRelationGovernanceEnabled(DISABLED), false);
    assert.throws(() => assertRelationGovernanceEnabled(DISABLED), RelationGovernanceError);
    assert.throws(() => propose({ flags: DISABLED }), RelationGovernanceError);
  });

  it("flag 关闭时 confirm/reject 授权一律拒绝", () => {
    const record = propose();
    const verdict = authorizeRelationDecision({
      record,
      decision: "confirm",
      actor: { userId: "owner-1", role: "owner" },
      workspace: OWNER_WORKSPACE,
      flags: DISABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.equal(verdict.authorized, false);
    assert.equal(verdict.reasonCode, "governance_flag_disabled");
  });
});

// ─── candidate 虚线、不进入 formal target、来源只能提议 ─────────────────────

describe("relation-governance: candidate 虚线且不进入 formal target", () => {
  it("所有来源的 candidate 恒 formalTargetEligible=false，不进入 formal target", () => {
    for (const source of ["generation_claim_critic", "tutor", "session_supervisor", "user_scene_connection"] as const) {
      const record = propose({ source });
      assert.equal(record.candidate.formalTargetEligible, false);
      assert.equal(record.status, "proposed");
      assert.equal(assertCandidateNotInFormalTarget(record).ok, true);
    }
  });

  it("candidateId 确定性派生（相同输入 → 相同 candidateId）", () => {
    assert.equal(propose().candidate.candidateId, propose().candidate.candidateId);
  });
});

// ─── 独立 relation support check ───────────────────────────────────────────

describe("relation-governance: 独立 support check", () => {
  it("direct 语义支持（含报告 hash）→ supported", () => {
    const record = propose();
    const verdict = supportCheck(record);
    assert.equal(verdict.supported, true);
    assert.equal(verdict.level, "supported");
    assert.ok(verdict.checkHash.length > 0);
  });

  it("引用完整 ≠ 语义支撑通过：direct 但无 semantic support 报告 → 不算 direct", () => {
    // semanticSupportReportHash 为 null 时 helper 置 null（非 direct）
    const verdictNoReport = runIndependentSupportCheck({
      candidate: propose().candidate,
      evidenceRefs: [
        { entityId: "evidence-1", fingerprint: "fp-ev-1-v1", support: "direct", semanticSupportReportHash: null },
      ],
      checkVersion: "v1",
      checkedBy: "checker",
      checkedAt: "2026-08-08T00:10:00.000Z",
    });
    assert.equal(verdictNoReport.supported, false);
    assert.equal(verdictNoReport.level, "partial");
  });

  it("存在 contradicting 证据 → unsupported（fail closed）", () => {
    const verdict = supportCheck(propose(), { support: "contradicting" });
    assert.equal(verdict.supported, false);
    assert.equal(verdict.level, "unsupported");
  });

  it("未通过的 support check 不进入等待授权（停留 proposed）", () => {
    const weak = supportCheck(propose(), { support: "partial" });
    const applied = applySupportCheck(propose(), weak);
    assert.equal(applied.status, "proposed");
    assert.equal(applied.supportVerdict?.supported, false);
  });

  it("通过的 support check → support_passed（等待授权）", () => {
    const record = propose();
    const applied = applySupportCheck(record, supportCheck(record));
    assert.equal(applied.status, "support_passed");
  });
});

// ─── authorized confirm | reject 授权矩阵 ─────────────────────────────────

describe("relation-governance: authorized confirm | reject", () => {
  it("个人 workspace：仅 owner 可 confirm/reject", () => {
    const record = supportedProposal();
    const ok = authorizeRelationDecision({
      record,
      decision: "confirm",
      actor: { userId: "owner-1", role: "owner" },
      workspace: OWNER_WORKSPACE,
      flags: ENABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.equal(ok.authorized, true);

    const editor = authorizeRelationDecision({
      record,
      decision: "confirm",
      actor: { userId: "editor-1", role: "editor" },
      workspace: OWNER_WORKSPACE,
      flags: ENABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.equal(editor.authorized, false);
    assert.equal(editor.reasonCode, "personal_workspace_owner_only");
  });

  it("协作 workspace：owner/editor/specialized_relation_governor 可确认，viewer 拒绝", () => {
    const record = supportedProposal();
    const workspace = {
      id: "ws-1",
      collaboration: true,
      ownerId: "owner-1",
      grantedRoles: ["owner", "editor", "viewer", "specialized_relation_governor"] as const,
    };
    for (const role of ["owner", "editor", "specialized_relation_governor"] as const) {
      const verdict = authorizeRelationDecision({
        record,
        decision: "confirm",
        actor: { userId: `${role}-1`, role },
        workspace,
        flags: ENABLED,
        decisionAt: "2026-08-08T00:20:00.000Z",
      });
      assert.equal(verdict.authorized, true, `role=${role}`);
    }
    const viewer = authorizeRelationDecision({
      record,
      decision: "confirm",
      actor: { userId: "viewer-1", role: "viewer" },
      workspace,
      flags: ENABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.equal(viewer.authorized, false);
  });

  it("confirm 前必须 support passed：未通过支持检查 → 拒绝", () => {
    const verdict = authorizeRelationDecision({
      record: propose(), // 未做 support check
      decision: "confirm",
      actor: { userId: "owner-1", role: "owner" },
      workspace: OWNER_WORKSPACE,
      flags: ENABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.equal(verdict.authorized, false);
    assert.equal(verdict.reasonCode, "confirm_requires_support_check_passed");
  });

  it("confirm 后 → published；reject 后 → rejected（终态）", () => {
    const confirmed = confirm(supportedProposal());
    assert.equal(confirmed.status, "published");
    assert.equal(confirmed.published?.version, 1);
    assert.ok(confirmed.published!.fingerprint.length > 0);

    const rejected = applyAuthorizationDecision({
      record: supportedProposal(),
      decision: "reject",
      actor: { userId: "owner-1", role: "owner" },
      workspace: OWNER_WORKSPACE,
      flags: ENABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.published, null);
  });
});

// ─── candidate 不能直接 published ─────────────────────────────────────────

describe("relation-governance: candidate 不能直接 published", () => {
  it("未过 support check → publish 拒绝", () => {
    assert.throws(
      () =>
        publishRelation({
          record: propose(),
          authorization: {
            decision: "confirm",
            actorUserId: "owner-1",
            role: "owner",
            decisionAt: "2026-08-08T00:20:00.000Z",
            authorizationHash: "h",
          },
          publishedBy: "owner-1",
          publishedAt: "2026-08-08T00:20:00.000Z",
        }),
      RelationGovernanceError,
    );
  });

  it("rejected 状态不能 publish", () => {
    const rejected = applyAuthorizationDecision({
      record: supportedProposal(),
      decision: "reject",
      actor: { userId: "owner-1", role: "owner" },
      workspace: OWNER_WORKSPACE,
      flags: ENABLED,
      decisionAt: "2026-08-08T00:20:00.000Z",
    });
    assert.throws(
      () =>
        publishRelation({
          record: rejected,
          authorization: {
            decision: "confirm",
            actorUserId: "owner-1",
            role: "owner",
            decisionAt: "2026-08-08T00:20:00.000Z",
            authorizationHash: "h",
          },
          publishedBy: "owner-1",
          publishedAt: "2026-08-08T00:20:00.000Z",
        }),
      RelationGovernanceError,
    );
  });
});

// ─── 上游变化 stale → 撤回重审 ─────────────────────────────────────────────

describe("relation-governance: 上游变化 stale 撤回重审", () => {
  it("上游引用指纹变化 → stale_under_review（撤回支持）", () => {
    const result = checkRelationStaleness({
      record: publishedRecord(),
      currentFingerprints: [
        { entityId: "card-1", fingerprint: "fp-card-1-v1" },
        { entityId: "evidence-1", fingerprint: "fp-ev-1-v2" }, // 变化
      ],
      checkedAt: "2026-08-09T00:00:00.000Z",
    });
    assert.equal(result.verdict.stale, true);
    assert.equal(result.record.status, "stale_under_review");
    assert.equal(result.verdict.changedRefs.length, 1);
    assert.equal(result.verdict.changedRefs[0]!.entityId, "evidence-1");
  });

  it("上游未变化 → 保持 published", () => {
    const result = checkRelationStaleness({
      record: publishedRecord(),
      currentFingerprints: [
        { entityId: "card-1", fingerprint: "fp-card-1-v1" },
        { entityId: "evidence-1", fingerprint: "fp-ev-1-v1" },
      ],
      checkedAt: "2026-08-09T00:00:00.000Z",
    });
    assert.equal(result.verdict.stale, false);
    assert.equal(result.record.status, "published");
  });

  it("重审：重新 support check + 重新 authorized confirm → 更高版本 republish", () => {
    const staleRecord = checkRelationStaleness({
      record: publishedRecord(),
      currentFingerprints: [
        { entityId: "card-1", fingerprint: "fp-card-1-v1" },
        { entityId: "evidence-1", fingerprint: "fp-ev-1-v2" },
      ],
      checkedAt: "2026-08-09T00:00:00.000Z",
    }).record;
    assert.equal(staleRecord.status, "stale_under_review");

    // 上游已更新后，新的支持检查引用新指纹
    const newVerdict = supportCheck(staleRecord, { evidenceFingerprint: "fp-ev-1-v2" });
    const republished = reviewAndRepublish({
      record: staleRecord,
      supportVerdict: newVerdict,
      authorizationInput: {
        decision: "confirm",
        actor: { userId: "owner-1", role: "owner" },
        workspace: OWNER_WORKSPACE,
        flags: ENABLED,
        decisionAt: "2026-08-09T01:00:00.000Z",
      },
    });
    assert.equal(republished.status, "published");
    assert.equal(republished.published?.version, 2);
    assert.notEqual(republished.published!.fingerprint, staleRecord.published!.fingerprint);
  });

  it("重审未通过支持检查 → 保持撤回（虚线，不发布）", () => {
    const staleRecord = checkRelationStaleness({
      record: publishedRecord(),
      currentFingerprints: [
        { entityId: "card-1", fingerprint: "fp-card-1-v1" },
        { entityId: "evidence-1", fingerprint: "fp-ev-1-v2" },
      ],
      checkedAt: "2026-08-09T00:00:00.000Z",
    }).record;
    const weak = supportCheck(staleRecord, { support: "contradicting", evidenceFingerprint: "fp-ev-1-v2" });
    const result = reviewAndRepublish({
      record: staleRecord,
      supportVerdict: weak,
      authorizationInput: {
        decision: "confirm",
        actor: { userId: "owner-1", role: "owner" },
        workspace: OWNER_WORKSPACE,
        flags: ENABLED,
        decisionAt: "2026-08-09T01:00:00.000Z",
      },
    });
    // 撤回未解除：保持 stale_under_review，不发布新版本
    assert.equal(result.status, "stale_under_review");
    assert.equal(result.published?.version, 1);
  });
});

// ─── fingerprint 与 audit ─────────────────────────────────────────────────

describe("relation-governance: fingerprint 与 audit", () => {
  it("versioned publish 指纹覆盖支持+授权且版本递增", () => {
    const confirmed = confirm(supportedProposal());
    const published = confirmed.published!;
    assert.equal(published.version, 1);
    assert.ok(published.fingerprint.length > 0);
    assert.ok(published.supportCheckHash.length > 0);
    assert.ok(published.authorizationHash.length > 0);
    // 不同授权时间 → 不同 authorizationHash → 不同 fingerprint（防篡改）
    const confirmed2 = confirm(supportedProposal(), "2026-08-08T09:00:00.000Z");
    assert.notEqual(confirmed2.published!.authorizationHash, published.authorizationHash);
  });

  it("audit 记录确定性 auditId 且携带指纹/角色", () => {
    const audit = buildAuditRecord({
      workspaceId: "ws-1",
      candidateId: "rgc:abc",
      action: "published",
      actor: "owner-1",
      role: "owner",
      at: "2026-08-08T00:20:00.000Z",
      fingerprint: "fp-1",
      metadata: { version: 1 },
    });
    assert.equal(audit.workspaceId, "ws-1");
    assert.equal(audit.role, "owner");
    assert.equal(audit.fingerprint, "fp-1");
    assert.equal(audit.metadata.version, 1);
    const again = buildAuditRecord({
      workspaceId: "ws-1",
      candidateId: "rgc:abc",
      action: "published",
      actor: "owner-1",
      role: "owner",
      at: "2026-08-08T00:20:00.000Z",
      fingerprint: "fp-1",
    });
    assert.equal(audit.auditId, again.auditId);
  });
});
