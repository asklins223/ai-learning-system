import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { materializeGroundedTutorEvidence } from "./companion-grounded-evidence.ts";

test("grounded tutor：只使用哈希校验通过的 sealed evidence 切片", () => {
  const blockContent = "start exact source quote end";
  const quote = "exact source quote";
  const startOffset = blockContent.indexOf(quote);
  const evidence = materializeGroundedTutorEvidence([{
    evidence_snapshot_id: "evidence-1",
    evidence_snapshot_hash: "a".repeat(64),
    quote_hash: hashCanonicalV2("evidence-quote", { quote }),
    block_content_hash: hashCanonicalV2("block", { content: blockContent }),
    start_offset: startOffset,
    end_offset: startOffset + quote.length,
    block_content: blockContent,
  }]);
  assert.deepEqual(evidence, [quote]);
});

test("grounded tutor：笔记块变化时拒绝把证据交给模型", () => {
  assert.throws(() => materializeGroundedTutorEvidence([{
    evidence_snapshot_id: "evidence-1",
    evidence_snapshot_hash: "a".repeat(64),
    quote_hash: hashCanonicalV2("evidence-quote", { quote: "original" }),
    block_content_hash: hashCanonicalV2("block", { content: "original" }),
    start_offset: 0,
    end_offset: 8,
    block_content: "modified",
  }]));
});

test("grounded tutor：Run 冻结 hash 与当前 evidence 不一致时拒绝", () => {
  const blockContent = "sealed quote";
  assert.throws(() => materializeGroundedTutorEvidence([{
    evidence_snapshot_id: "evidence-1",
    evidence_snapshot_hash: "a".repeat(64),
    expected_evidence_snapshot_hash: "b".repeat(64),
    quote_hash: hashCanonicalV2("evidence-quote", { quote: blockContent }),
    block_content_hash: hashCanonicalV2("block", { content: blockContent }),
    start_offset: 0,
    end_offset: blockContent.length,
    block_content: blockContent,
  }]));
});
