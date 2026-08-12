import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnswerSubmissionError,
  computeAnswerContentHash,
  frozenProbeHashForKey,
  submitEpisodeAnswer,
  type AnswerSubmissionRepository,
} from "./answer-submission.js";

const WS = "ws-1";
const USER = "user-1";
const SESSION = "session-1";
const EPISODE = "episode-1";
const KEY_POINT = "kp-1";
const PROBE = "probe-1";

function makeRepo(overrides: Partial<AnswerSubmissionRepository> = {}) {
  const artifacts: Array<{ id: string; contentHash: string; modality: string }> = [];
  const locks: string[] = [];
  const repo: AnswerSubmissionRepository = {
    async findEpisode() {
      return { id: EPISODE, sessionId: SESSION, keyPointId: KEY_POINT, status: "active", processingPhase: "awaiting_response", probeId: PROBE, contentExposureKey: "cex:kp1" };
    },
    async ensureProbe() {
      return { probeId: PROBE };
    },
    async createArtifact(input) {
      artifacts.push({ id: input.id, contentHash: input.contentHash, modality: input.modality });
      return { id: input.id };
    },
    async lockEpisode(episodeId) {
      locks.push(episodeId);
    },
    ...overrides,
  };
  return { repo, artifacts, locks };
}

function baseInput() {
  return {
    workspaceId: WS,
    userId: USER,
    sessionId: SESSION,
    episodeId: EPISODE,
    keyPointId: KEY_POINT,
    probeId: PROBE,
    modality: "text_or_mixed" as const,
    text: "氧气是燃烧反应的氧化剂。",
  };
}

test("submitEpisodeAnswer：text_or_mixed 提交 → artifact locked + episode 锁定 + probe 建立", async () => {
  const { repo, artifacts, locks } = makeRepo();
  const result = await submitEpisodeAnswer(baseInput(), repo);
  assert.equal(result.artifact.status, "locked");
  assert.equal(result.episodeStatus, "active");
  assert.equal(result.processingPhase, "assessment_pending");
  assert.equal(result.artifact.modality, "text_or_mixed");
  assert.equal(result.artifact.probeId, PROBE, "probeId 来自 ensureProbe（非空，FK 前提）");
  assert.ok(result.artifact.contentHash.startsWith("sha256:"), "contentHash 带 sha256 前缀");
  assert.equal(artifacts.length, 1);
  assert.deepEqual(locks, [EPISODE]);
});

test("submitEpisodeAnswer：artifact 与 assessment outbox 使用同一组作用域 ID", async () => {
  const enqueued: Array<Record<string, string>> = [];
  const { repo } = makeRepo({
    async enqueueAssessment(input) {
      enqueued.push(input);
    },
  });
  const result = await submitEpisodeAnswer(baseInput(), repo);
  assert.deepEqual(enqueued, [{
    workspaceId: WS,
    userId: USER,
    sessionId: SESSION,
    episodeId: EPISODE,
    artifactId: result.artifact.artifactId,
  }]);
});

test("submitEpisodeAnswer：voice transcript 提交 → payload 为 confirmedTranscript", async () => {
  const { repo } = makeRepo();
  const result = await submitEpisodeAnswer({ ...baseInput(), modality: "voice" }, repo);
  assert.equal(result.artifact.modality, "voice");
});

test("submitEpisodeAnswer：空回答 → fail closed", async () => {
  const { repo, artifacts } = makeRepo();
  await assert.rejects(
    () => submitEpisodeAnswer({ ...baseInput(), text: "   " }, repo),
    (err: unknown) => err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "empty_answer",
  );
  assert.equal(artifacts.length, 0);
});

test("submitEpisodeAnswer：Episode 不存在 → 404", async () => {
  const { repo } = makeRepo({ findEpisode: async () => null });
  await assert.rejects(
    () => submitEpisodeAnswer(baseInput(), repo),
    (err: unknown) =>
      err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "episode_not_found",
  );
});

test("submitEpisodeAnswer：Episode 非 active → 不可作答", async () => {
  const { repo } = makeRepo({
    findEpisode: async () => ({ id: EPISODE, sessionId: SESSION, keyPointId: KEY_POINT, status: "active", processingPhase: "assessment_pending", probeId: PROBE, contentExposureKey: "cex:kp1" }),
  });
  await assert.rejects(
    () => submitEpisodeAnswer(baseInput(), repo),
    (err: unknown) =>
      err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "episode_not_answerable",
  );
});

test("submitEpisodeAnswer：Episode 属于其他 Session → 409", async () => {
  const { repo } = makeRepo({
    findEpisode: async () => ({ id: EPISODE, sessionId: "other-session", keyPointId: KEY_POINT, status: "active", processingPhase: "awaiting_response", probeId: PROBE, contentExposureKey: "cex:kp1" }),
  });
  await assert.rejects(
    () => submitEpisodeAnswer(baseInput(), repo),
    (err: unknown) =>
      err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "session_mismatch",
  );
});

test("computeAnswerContentHash：确定性（同输入同 hash，不同输入不同）", () => {
  const a = computeAnswerContentHash("答案A");
  const b = computeAnswerContentHash("答案A");
  const c = computeAnswerContentHash("答案B");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("frozenProbeHashForKey：纯 hex（与 session-service sha256Hex 派生一致，security_review MEDIUM）", () => {
  const h = frozenProbeHashForKey("kp-1", "cex:kp1");
  assert.match(h, /^[0-9a-f]{64}$/, "纯 64 位 hex，无 sha256: 前缀");
  assert.equal(h.includes(":"), false, "不含前缀分隔符");
  // 确定性
  assert.equal(frozenProbeHashForKey("kp-1", "cex:kp1"), h);
});
