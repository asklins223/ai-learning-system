import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnswerSubmissionError,
  computeAnswerContentHash,
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
      return { id: EPISODE, sessionId: SESSION, keyPointId: KEY_POINT, status: "active", probeId: PROBE, contentExposureKey: "cex:kp1" };
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
  assert.equal(result.episodeStatus, "answered_locked");
  assert.equal(result.artifact.modality, "text_or_mixed");
  assert.equal(result.artifact.probeId, PROBE, "probeId 来自 ensureProbe（非空，FK 前提）");
  assert.ok(result.artifact.contentHash.startsWith("sha256:"), "contentHash 带 sha256 前缀");
  assert.equal(artifacts.length, 1);
  assert.deepEqual(locks, [EPISODE]);
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
    (err: unknown) => err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "EMPTY_ANSWER",
  );
  assert.equal(artifacts.length, 0);
});

test("submitEpisodeAnswer：Episode 不存在 → 404", async () => {
  const { repo } = makeRepo({ findEpisode: async () => null });
  await assert.rejects(
    () => submitEpisodeAnswer(baseInput(), repo),
    (err: unknown) =>
      err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "EPISODE_NOT_FOUND",
  );
});

test("submitEpisodeAnswer：Episode 非 active → 不可作答", async () => {
  const { repo } = makeRepo({
    findEpisode: async () => ({ id: EPISODE, sessionId: SESSION, keyPointId: KEY_POINT, status: "answered_locked", probeId: PROBE, contentExposureKey: "cex:kp1" }),
  });
  await assert.rejects(
    () => submitEpisodeAnswer(baseInput(), repo),
    (err: unknown) =>
      err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "EPISODE_NOT_ANSWERABLE",
  );
});

test("submitEpisodeAnswer：Episode 属于其他 Session → 409", async () => {
  const { repo } = makeRepo({
    findEpisode: async () => ({ id: EPISODE, sessionId: "other-session", keyPointId: KEY_POINT, status: "active", probeId: PROBE, contentExposureKey: "cex:kp1" }),
  });
  await assert.rejects(
    () => submitEpisodeAnswer(baseInput(), repo),
    (err: unknown) =>
      err instanceof AnswerSubmissionError && (err as AnswerSubmissionError).code === "SESSION_MISMATCH",
  );
});

test("computeAnswerContentHash：确定性（同输入同 hash，不同输入不同）", () => {
  const a = computeAnswerContentHash("答案A");
  const b = computeAnswerContentHash("答案A");
  const c = computeAnswerContentHash("答案B");
  assert.equal(a, b);
  assert.notEqual(a, c);
});
