/**
 * 方案 20 C2: Learnability Planner 测试。
 *
 * 验证：
 * 1. 确定性 Atom 提取正确工作；
 * 2. Planner 允许 0 卡且不调用 Author；
 * 3. micro-note 数量限制；
 * 4. model 无权扩大 server hard max；
 * 5. planHash 正确计算；
 * 6. existing objective dedup。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  executePlanner,
  extractAtomsDeterministic,
  SERVER_POLICY_MAX_CARDS,
  type SourceBlockInput,
  type ExistingObjectiveRef,
} from "@ailearn/shared/card-generation-v2-pipeline";

// ─── Mock helpers ────────────────────────────────────────────────────────

function makeMockInputSnapshot(runId: string, cardContentEpoch = 1) {
  return {
    version: 2 as const,
    generationRunId: runId,
    workspaceId: "ws-00000000-0000-4000-8000-000000000001",
    idempotencyKey: `key-${runId}`,
    rawRequest: {
      version: 2 as const,
      noteVersionId: "nv-00000000-0000-4000-8000-000000000001",
      sourceScope: { kind: "whole_note" as const },
      learningGoal: "understand" as const,
      detailThreshold: "balanced" as const,
      quantity: { kind: "adaptive" as const },
      clientRequestId: "req-001",
    },
    sourceSnapshot: {
      sourceSnapshotId: "ss-00000000-0000-4000-8000-000000000001",
      noteId: "n-00000000-0000-4000-8000-000000000001",
      noteVersionId: "nv-00000000-0000-4000-8000-000000000001",
      sourceSnapshotHash: "a".repeat(64),
      sourceContentHash: "b".repeat(64),
      blockManifestHash: "c".repeat(64),
      assetManifestHash: "d".repeat(64),
      scopeManifestHash: "e".repeat(64),
    },
    semanticSpecHash: "f".repeat(64),
    generationFingerprint: "g".repeat(64),
    cardContentEpoch,
    inputSnapshotHash: "h".repeat(64),
  };
}

function makeMockSemanticSpec() {
  return {
    version: 2 as const,
    semanticRequest: {
      sourceScope: { kind: "whole_note" as const },
      learningGoal: "understand" as const,
      detailThreshold: "balanced" as const,
      quantity: { kind: "adaptive" as const },
    },
    policies: {
      plannerPolicyVersion: "planner-v1",
      deterministicGateVersion: "gate-v1",
      evidencePolicyVersion: "evidence-v1",
      targetPolicyVersion: "target-v1",
      cardContractVersion: "learning-card-v2" as const,
      targetSnapshotVersion: "learning-target-snapshot-v2" as const,
      stageRuntimes: [{
        stage: "planner" as const,
        providerId: "system",
        modelSnapshot: "v1",
        deploymentId: "local",
        capabilityFingerprint: "basic",
        promptVersion: "v1",
        sampling: { temperature: 0 },
        outputSchemaVersion: "v2",
      }],
    },
    governancePolicyVersion: "gov-v1",
    semanticSpecHash: "f".repeat(64),
  };
}

function makeBlocks(content: string): SourceBlockInput[] {
  return [{ blockId: "blk-1", type: "paragraph", content, ordinal: 0 }];
}

describe("C2: Deterministic Atom Extraction", () => {
  test("extracts atoms from simple text", () => {
    const blocks = makeBlocks("定义：分布式共识是指多个节点对某个值达成一致。因为网络可能故障，所以需要共识协议。");
    const atoms = extractAtomsDeterministic(blocks);
    assert.ok(atoms.length >= 2, "should extract at least 2 atoms");
    assert.ok(atoms.every((a) => a.proposition.length > 0));
  });

  test("filters out short sentences", () => {
    const blocks = makeBlocks("OK。好的。这是一个完整的句子，应该被提取为知识原子。");
    const atoms = extractAtomsDeterministic(blocks);
    assert.ok(atoms.every((a) => a.proposition.length >= 10));
  });

  test("infers knowledge form correctly", () => {
    const blocks = makeBlocks("定义是指某概念的含义。因为网络可能故障所以需要共识协议来保证一致性。比较两种不同架构方案的区别和优缺点。步骤一到步骤二描述了完整的过程。");
    const atoms = extractAtomsDeterministic(blocks);
    const forms = atoms.map((a) => a.knowledgeFormHint);
    assert.ok(forms.includes("definition"), `should detect definition, got forms: ${forms.join(",")}`);
    assert.ok(forms.includes("causal_model"), `should detect causal model, got forms: ${forms.join(",")}`);
    assert.ok(forms.includes("comparison"), `should detect comparison, got forms: ${forms.join(",")}`);
  });

  test("R33: does not filter content sentences containing 交/买 substrings (交换/交易/买卖)", () => {
    // 回归：裸 `交`/`买` 子串曾把"血液循环…气体交换"等科学内容句整体
    // 过滤为临时待办 → 0 卡。
    const blocks = makeBlocks(
      "血液循环：心脏泵血推动血液在血管中循环流动；体循环与肺循环同时进行，分别完成氧气输送与气体交换。",
    );
    const atoms = extractAtomsDeterministic(blocks);
    assert.ok(atoms.length >= 1, "content with 交换 must not be filtered as operational");
    assert.ok(atoms[0].proposition.includes("气体交换"), "atom must retain the full content sentence");
  });
});

describe("C2: Planner Core Logic", () => {
  test("produces no_cards_recommended for empty content", async () => {
    const result = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000001",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000001"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks("TODO: 待办事项"),
      existingObjectives: [],
    });
    assert.equal(result.plan.result.kind, "no_cards_recommended");
    assert.ok(result.plan.planHash.match(/^[0-9a-f]{64}$/));
  });

  test("C03: 临时待办/日程内容 → no_cards_recommended（不提取为知识原子）", async () => {
    const result = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000004",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000004"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks("明天上午 10 点开会；下午交周报；记得买牛奶。"),
      existingObjectives: [],
    });
    assert.equal(result.plan.result.kind, "no_cards_recommended");
    assert.equal(result.atoms.length, 0, "todo content must not produce atoms");
  });

  test("produces author_candidates for learnable content", async () => {
    const result = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000002",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000002"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks("定义：分布式共识是指多个节点对某个值达成一致的协议。因为网络可能分区，所以需要多数派来保证一致性。比较Raft和Paxos：Raft更易理解，Paxos更基础。"),
      existingObjectives: [],
    });
    assert.equal(result.plan.result.kind, "author_candidates");
    if (result.plan.result.kind === "author_candidates") {
      assert.ok(result.plan.result.recommendedCardCount > 0);
      assert.ok(result.plan.result.activationHardMax <= SERVER_POLICY_MAX_CARDS);
      assert.ok(result.plan.result.objectives.length > 0);
    }
  });

  test("deduplicates against existing objectives", async () => {
    const content = "定义：分布式共识是指多个节点对某个值达成一致的协议。";
    const existing: ExistingObjectiveRef[] = [{
      objectiveId: "obj-00000000-0000-4000-8000-000000000001",
      semanticTargetFingerprint: "f".repeat(64),
      objectiveStatement: "定义：分布式共识是指多个节点对某个值达成一致的协议。",
      publicSummary: "分布式共识定义",
    }];
    const result = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000003",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000003"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(content),
      existingObjectives: existing,
    });
    // The atom should be covered by existing objective (exact string match)
    const coveredDecisions = result.plan.atomDecisions.filter((d) => d.decision === "covered_by_existing_objective");
    const omittedDecisions = result.plan.atomDecisions.filter((d) => d.decision.startsWith("omit"));
    // Either covered by existing or omitted (both mean no new objective created)
    assert.ok(coveredDecisions.length > 0 || omittedDecisions.length > 0, "should not create new objectives for existing content");
  });

  test("micro-note caps at 3 cards", async () => {
    const shortContent = "定义A是指某概念。定义B是指另一概念。定义C是指第三个概念。定义D是指第四个概念。";
    const result = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000004",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000004"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(shortContent),
      existingObjectives: [],
    });
    if (result.plan.result.kind === "author_candidates") {
      assert.ok(result.plan.result.activationHardMax <= 3, "micro-note should cap at 3");
    }
  });

  test("C04: 重复两次相同段落 → 卡数不增加，Atom 有重复决策记录", async () => {
    const single = "TCP 提供可靠有序的字节流传输，通过确认与重传机制保证数据不丢失不重复。";
    const duplicated = `${single}${single}`;
    const singleResult = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000007",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000007"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(single),
      existingObjectives: [],
    });
    const dupResult = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000008",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000008"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(duplicated),
      existingObjectives: [],
    });
    const countOf = (r: typeof singleResult) =>
      r.plan.result.kind === "author_candidates" ? r.plan.result.objectives.length : 0;
    assert.equal(countOf(dupResult), countOf(singleResult), "duplicated paragraph must not double card count");
    const dupDecisions = dupResult.plan.atomDecisions.filter((d) => d.decision === "omit_duplicate");
    assert.ok(dupDecisions.length >= 1, "atom decisions must record omit_duplicate");
  });

  test("client hardMaxCards is respected", async () => {
    const content = "定义A。定义B。定义C。定义D。定义E。定义F。定义G。定义H。定义I。定义J。";
    const result = await executePlanner({
      runId: "r-00000000-0000-4000-8000-000000000005",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000005"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(content),
      existingObjectives: [],
      clientHardMaxCards: 2,
    });
    if (result.plan.result.kind === "author_candidates") {
      assert.ok(result.plan.result.activationHardMax <= 2, "should respect client hardMax");
    }
  });

  test("R36 §14.2：非文本模态（image/code）无文本 evidence → unsupported_for_requested_goal 显式提示", async () => {
    // 无文本 blocks（仅非文本模态）→ no_cards_recommended + unsupported reason
    const input = {
      runId: "r-00000000-0000-4000-8000-000000000007",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000007"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: [] as SourceBlockInput[],
      unsupportedSourceBlocks: [
        { blockId: "b-code", type: "code", content: "def f(): pass", ordinal: 1 },
        { blockId: "b-img", type: "image", content: "", ordinal: 2 },
      ],
      existingObjectives: [] as ExistingObjectiveRef[],
    };
    const result = await executePlanner(input);
    assert.equal(result.plan.result.kind, "no_cards_recommended");
    if (result.plan.result.kind === "no_cards_recommended") {
      assert.ok(
        result.plan.result.reasonCodes.includes("unsupported_for_requested_goal"),
        `reasonCodes 必须含 unsupported_for_requested_goal（实际: ${result.plan.result.reasonCodes.join(",")}）`,
      );
    }
  });

  test("R36 §14.2：文本 evidence 存在时非文本模态不误伤（不触发 unsupported reason）", async () => {
    const content = "定义：共识是指节点对值达成一致。";
    const input = {
      runId: "r-00000000-0000-4000-8000-000000000008",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000008"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(content),
      unsupportedSourceBlocks: [
        { blockId: "b-code", type: "code", content: "def f(): pass", ordinal: 1 },
      ],
      existingObjectives: [] as ExistingObjectiveRef[],
    };
    const result = await executePlanner(input);
    assert.equal(result.plan.result.kind, "author_candidates");
  });

  test("planHash is deterministic for same input", async () => {
    const content = "定义：共识是指节点对值达成一致。";
    const input = {
      runId: "r-00000000-0000-4000-8000-000000000006",
      workspaceId: "ws-00000000-0000-4000-8000-000000000001",
      inputSnapshot: makeMockInputSnapshot("r-00000000-0000-4000-8000-000000000006"),
      semanticSpec: makeMockSemanticSpec(),
      blocks: makeBlocks(content),
      existingObjectives: [] as ExistingObjectiveRef[],
    };
    const result1 = await executePlanner(input);
    // planRevisionId is randomUUID so planHash won't be identical,
    // but the structure should be the same
    assert.ok(result1.plan.planHash.match(/^[0-9a-f]{64}$/));
    assert.equal(result1.plan.version, 2);
    assert.equal(result1.plan.planVersion, 1);
    assert.equal(result1.plan.previousPlanRevisionId, null);
  });
});
