import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCriticAssessments,
  buildFailClosedCriticAssessments,
  buildFailClosedAssessment,
  type AssessmentContext,
} from "./learning-session-assessment.ts";

const baseContext: AssessmentContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  artifact: {
    artifactId: "artifact-1",
    status: "locked",
    modality: "text_or_mixed",
    revision: 0,
    contentHash: "hash",
    transcript: "用户回答文本",
  },
  artifactPayload: { text: "用户回答文本" },
  artifactEpisodeTargetFingerprint: "fingerprint-1",
  episode: {
    id: "episode-1",
    sessionId: "session-1",
    status: "active",
    processingPhase: "assessment_pending",
    keyPointId: "key-point-1",
    rubricTargets: [],
    modelId: "model-1",
    episodeTargetFingerprint: "fingerprint-1",
  },
  question: "为什么这个结论成立？",
};

test("assessment worker never upgrades arbitrary non-empty answers", () => {
  const result = buildFailClosedAssessment({
    episodeId: "episode-1",
    artifactId: "artifact-1",
    rubricTargets: [{ itemId: "rubric-0" }],
    canonicalCommitEnabled: false,
  });

  assert.deepEqual(result.verdicts, [{
    rubricItemId: "rubric-0",
    verdict: "not_assessable",
    weight: 1,
    required: true,
  }]);
  assert.equal(result.decisionHash.length, 64);
  assert.equal(result.reportHash.length, 64);
});

test("assessment report hash is stable for an outbox retry", () => {
  const input = {
    episodeId: "episode-1",
    artifactId: "artifact-1",
    rubricTargets: [{ itemId: "rubric-0" }],
    canonicalCommitEnabled: false,
  };
  assert.deepEqual(buildFailClosedAssessment(input), buildFailClosedAssessment(input));
});

test("assessment critic adapter：旧占位 rubric 严格保持 not_assessable 且绑定 artifact", () => {
  const assessments = buildFailClosedCriticAssessments({
    ...baseContext,
    episode: {
      ...baseContext.episode,
      rubricTargets: [{ itemId: "rubric-0", evidenceHash: "placeholder-only", facet: "explain" }],
    },
  });
  assert.deepEqual(assessments.map((item) => item.rubricItemId), ["rubric-0"]);
  assert.equal(assessments[0]?.verdict, "not_assessable");
  assert.equal(assessments[0]?.assessmentSource, "critic");
  assert.equal(assessments[0]?.responseBindings[0]?.responseArtifactId, "artifact-1");
  assert.deepEqual(assessments[0]?.evidenceRefIds, []);
});

test("assessment critic adapter：结构化 ordering 走 deterministic scorer，不把非空答案当 covered", async () => {
  const result = await buildCriticAssessments({
    ...baseContext,
    artifact: {
      ...baseContext.artifact,
      modality: "ordering",
      orderedIds: ["A", "B"],
      allowlistedItemIds: ["A", "B"],
    },
    artifactPayload: { orderedIds: ["A", "B"] },
    episode: {
      ...baseContext.episode,
      rubricTargets: [{
        id: "rubric-order",
        scoringMode: "ordering",
        evidenceRefIds: ["ev-a", "ev-b"],
        expectedOrderIds: ["A", "B"],
      }],
    },
  });
  assert.equal(result.source, "deterministic");
  assert.equal(result.criticVersion, "assessment-critic-deterministic-v1");
  assert.equal(result.assessments[0]?.verdict, "covered");
  assert.deepEqual(result.assessments[0]?.evidenceRefIds, ["ev-a", "ev-b"]);
});
