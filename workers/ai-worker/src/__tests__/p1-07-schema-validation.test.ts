import { TOOL_ZOD_SCHEMAS } from "../agent/tools/schemas.ts";

// Test 1: submit_deck_draft missing density should fail
const draftNoDensity = TOOL_ZOD_SCHEMAS["submit_deck_draft"].safeParse({
  baseLedgerHash: "hash123",
  draft: {
    deckTitle: "Test",
    deckSummary: "Summary",
    cardBudget: 10,
    cards: [{ draftCardId: "c1", title: "T", summary: "S", candidateIds: ["cand1"], primarySupportCandidateId: "cand1" }],
  },
});
console.log("Test 1 (missing density):", draftNoDensity.success ? "FAIL (should reject)" : "PASS (rejected)");

// Test 2: submit_quality_report empty perClaimVerdicts should fail
const emptyVerdicts = TOOL_ZOD_SCHEMAS["submit_quality_report"].safeParse({
  report: {
    draftHash: "hash123",
    perClaimVerdicts: [],
    criticStatus: "passed",
  },
});
console.log("Test 2 (empty verdicts):", emptyVerdicts.success ? "FAIL (should reject)" : "PASS (rejected)");

// Test 3: record_extraction_decisions missing candidate fields should fail
const badCandidate = TOOL_ZOD_SCHEMAS["record_extraction_decisions"].safeParse({
  bundleIds: ["b1"],
  candidates: [{ localId: "c1" }],
});
console.log("Test 3 (missing candidate fields):", badCandidate.success ? "FAIL (should reject)" : "PASS (rejected)");

// Test 4: valid submit_deck_draft should pass
const validDraft = TOOL_ZOD_SCHEMAS["submit_deck_draft"].safeParse({
  baseLedgerHash: "hash123",
  draft: {
    deckTitle: "Test Deck",
    deckSummary: "A summary",
    density: "standard",
    cardBudget: 10,
    cards: [{ draftCardId: "c1", title: "Title", summary: "Summary", candidateIds: ["cand1"], primarySupportCandidateId: "cand1", learningObjective: "理解 Title 的基本概念和应用场景" }],
  },
});
console.log("Test 4 (valid draft):", validDraft.success ? "PASS (accepted)" : "FAIL (rejected)");

// Test 5: valid submit_quality_report with verdicts should pass
const validReport = TOOL_ZOD_SCHEMAS["submit_quality_report"].safeParse({
  report: {
    draftHash: "hash123",
    perClaimVerdicts: [{ candidateId: "cand1", verdict: "supported", reasonCode: "fully_supported" }],
    criticStatus: "passed",
  },
});
console.log("Test 5 (valid report):", validReport.success ? "PASS (accepted)" : "FAIL (rejected)");

// Test 6: additionalProperties false should reject unknown fields
const extraField = TOOL_ZOD_SCHEMAS["submit_deck_draft"].safeParse({
  baseLedgerHash: "hash123",
  draft: {
    deckTitle: "Test",
    deckSummary: "Summary",
    density: "standard",
    cardBudget: 10,
    cards: [{ draftCardId: "c1", title: "T", summary: "S", candidateIds: ["cand1"], primarySupportCandidateId: "cand1", learningObjective: "理解 T 的基本概念" }],
  },
  extraField: "should fail",
});
console.log("Test 6 (additionalProperties false):", extraField.success ? "FAIL (should reject)" : "PASS (rejected)");

// Test 7: record_extraction_decisions with no candidates and no noCandidate should fail
const noDecision = TOOL_ZOD_SCHEMAS["record_extraction_decisions"].safeParse({
  bundleIds: ["b1"],
});
console.log("Test 7 (no candidates and no noCandidate):", noDecision.success ? "FAIL (should reject)" : "PASS (rejected)");

// Test 8: duplicate candidate IDs in deck draft card should pass (deduplication not enforced at schema level)
const dupCandidateIds = TOOL_ZOD_SCHEMAS["submit_deck_draft"].safeParse({
  baseLedgerHash: "hash123",
  draft: {
    deckTitle: "Test",
    deckSummary: "Summary",
    density: "standard",
    cardBudget: 10,
    cards: [{ draftCardId: "c1", title: "T", summary: "S", candidateIds: ["cand1", "cand1"], primarySupportCandidateId: "cand1", learningObjective: "掌握 cand1 的核心定义和使用方法" }],
  },
});
console.log("Test 8 (valid with structure):", dupCandidateIds.success ? "PASS (accepted)" : "FAIL (rejected)");
