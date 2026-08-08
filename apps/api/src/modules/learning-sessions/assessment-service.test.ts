import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AssessmentServiceError,
  assessEpisode,
  deterministicRubricVerdict,
  extractAnswerText,
  type AssessmentRepository,
  type AssessEpisodeInput,
} from "./assessment-service.js";

const WS = "ws-1";
const USER = "user-1";
const SESSION = "session-1";
const EPISODE = "episode-1";
const ARTIFACT = "artifact-1";

function makeRepo(overrides: Partial<AssessmentRepository> = {}) {
  const writes: unknown[] = [];
  const repo: AssessmentRepository = {
    async findLockedArtifact() {
      return {
        id: ARTIFACT,
        episodeId: EPISODE,
        status: "locked",
        modality: "text_or_mixed",
        payload: { text: "氧气是燃烧反应的氧化剂。", contentHash: "sha256:abc" },
      };
    },
    async findEpisodeRubricTargets() {
      return {
        episodeId: EPISODE,
        status: "answered_locked",
        rubricTargets: [
          { itemId: "rubric-0", evidenceHash: "hash-0", facet: "explain" },
          { itemId: "rubric-1", evidenceHash: "hash-1", facet: "explain" },
        ],
        episodeEpoch: 1,
      };
    },
    async writeAssessment(_ws, _u, _s, _ep, assessment) {
      writes.push(assessment);
    },
    ...overrides,
  };
  return { repo, writes };
}

function baseInput(): AssessEpisodeInput {
  return { workspaceId: WS, userId: USER, sessionId: SESSION, episodeId: EPISODE, artifactId: ARTIFACT };
}

test("assessEpisode：锁定 artifact + answered_locked episode → 评测 + 写报告", async () => {
  const { repo, writes } = makeRepo();
  const result = await assessEpisode(baseInput(), repo);
  assert.equal(result.reducerVerdict, "pass"); // 全部 covered + required → pass
  assert.equal(result.disposition, "pass");
  assert.match(result.decisionHash, /^[0-9a-f]{64}$/, "decisionHash 为确定性纯 hex");
  assert.equal(writes.length, 1);
});

test("assessEpisode：同输入重放 → decisionHash 一致（确定性，review nit）", async () => {
  const { repo } = makeRepo();
  const a = await assessEpisode(baseInput(), repo);
  const b = await assessEpisode(baseInput(), repo);
  assert.equal(a.decisionHash, b.decisionHash, "同输入两次评测 decisionHash 必须相等");
  assert.equal(a.reducerVerdict, b.reducerVerdict);
});

test("assessEpisode：空 rubric targets → 422（非 500，review should-fix）", async () => {
  const { repo } = makeRepo({
    findEpisodeRubricTargets: async () => ({
      episodeId: EPISODE, status: "answered_locked", rubricTargets: [], episodeEpoch: 1,
    }),
  });
  await assert.rejects(
    () => assessEpisode(baseInput(), repo),
    (err: unknown) =>
      err instanceof AssessmentServiceError && (err as AssessmentServiceError).code === "RUBRIC_TARGETS_EMPTY",
  );
});

test("assessEpisode：artifact 未锁定 → fail closed", async () => {
  const { repo } = makeRepo({
    findLockedArtifact: async () => ({
      id: ARTIFACT, episodeId: EPISODE, status: "draft", modality: "text_or_mixed", payload: { text: "x" },
    }),
  });
  await assert.rejects(
    () => assessEpisode(baseInput(), repo),
    (err: unknown) => err instanceof AssessmentServiceError && (err as AssessmentServiceError).code === "ARTIFACT_NOT_LOCKED",
  );
});

test("assessEpisode：artifact 属其他 Episode → 409", async () => {
  const { repo } = makeRepo({
    findLockedArtifact: async () => ({
      id: ARTIFACT, episodeId: "other-ep", status: "locked", modality: "text_or_mixed", payload: { text: "x" },
    }),
  });
  await assert.rejects(
    () => assessEpisode(baseInput(), repo),
    (err: unknown) => err instanceof AssessmentServiceError && (err as AssessmentServiceError).code === "EPISODE_MISMATCH",
  );
});

test("assessEpisode：episode 非 answered_locked → fail closed", async () => {
  const { repo } = makeRepo({
    findEpisodeRubricTargets: async () => ({
      episodeId: EPISODE, status: "active", rubricTargets: [], episodeEpoch: 1,
    }),
  });
  await assert.rejects(
    () => assessEpisode(baseInput(), repo),
    (err: unknown) => err instanceof AssessmentServiceError && (err as AssessmentServiceError).code === "EPISODE_NOT_ASSESSABLE",
  );
});

test("assessEpisode：空回答 → fail closed", async () => {
  const { repo } = makeRepo({
    findLockedArtifact: async () => ({
      id: ARTIFACT, episodeId: EPISODE, status: "locked", modality: "text_or_mixed", payload: { text: "   " },
    }),
  });
  await assert.rejects(
    () => assessEpisode(baseInput(), repo),
    (err: unknown) => err instanceof AssessmentServiceError && (err as AssessmentServiceError).code === "EMPTY_ANSWER",
  );
});

test("deterministicRubricVerdict：非空答案 → 全部 covered；空 → missing", () => {
  const targets = [
    { itemId: "r0", evidenceHash: "h0" },
    { itemId: "r1", evidenceHash: "h1" },
  ];
  const covered = deterministicRubricVerdict("我的回答内容", targets);
  assert.equal(covered.length, 2);
  assert.ok(covered.every((v) => v.verdict === "covered"));
  const missing = deterministicRubricVerdict("", targets);
  assert.ok(missing.every((v) => v.verdict === "missing"));
});

test("extractAnswerText：text_or_mixed 取 text；voice 取 confirmedTranscript", () => {
  assert.equal(extractAnswerText({ text: "答案" }, "text_or_mixed"), "答案");
  assert.equal(extractAnswerText({ confirmedTranscript: "语音答案" }, "voice"), "语音答案");
  assert.equal(extractAnswerText(null, "text_or_mixed"), "");
});
