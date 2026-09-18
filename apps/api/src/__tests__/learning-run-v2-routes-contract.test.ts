/**
 * GS-01B / RUN-V2-WIRE-01 的 route roster contract。
 *
 * 该测试只锁定跨层边界：API 必须注册 V2 endpoint、解析 strict V2 schema，
 * desktop gateway 必须消费对应路径。真实 workspace、schedule、DB、worker
 * 闭环仍由 integration / packaged evidence 负责，不能由本测试替代。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const apiRoutesSource = readFileSync(
  resolve(import.meta.dirname, "../modules/learning-runs/run-routes.ts"),
  "utf8",
);
const reviewRoutesSource = readFileSync(
  resolve(import.meta.dirname, "../modules/review/routes.ts"),
  "utf8",
);
const gatewaySource = readFileSync(
  resolve(import.meta.dirname, "../../../desktop-client/src/main/desktop-gateway.ts"),
  "utf8",
);
const desktopIpcSource = readFileSync(
  resolve(import.meta.dirname, "../../../desktop-client/src/main/desktop-ipc.ts"),
  "utf8",
);
const preloadSource = readFileSync(
  resolve(import.meta.dirname, "../../../desktop-client/src/preload/index.ts"),
  "utf8",
);

describe("GS-01B V2 route roster", () => {
  it("keeps the standard start command on strict V2 dispatch", () => {
    assert.match(apiRoutesSource, /app\.post\("\/learning-runs"/);
    assert.match(apiRoutesSource, /createLearningRunV2RequestSchema/);
    assert.match(apiRoutesSource, /parseBody\(app, createLearningRunV2RequestSchema, req\.body\)/);
    assert.match(apiRoutesSource, /learningRunPublicSnapshotV2Schema/);
    assert.match(gatewaySource, /this\.request\("\/learning-runs", \{ method: "POST"/);
    assert.match(gatewaySource, /learningRunPublicSnapshotV2Schema\.safeParse/);
  });

  it("registers the V2 public snapshot, result and return contract endpoints", () => {
    for (const path of [
      "/learning-runs/:runId/v2",
      "/learning-runs/:runId/result/v2",
      "/learning-runs/:runId/return-contract/v2",
    ]) {
      assert.ok(apiRoutesSource.includes(path), `missing API route ${path}`);
    }
    assert.match(apiRoutesSource, /getResultPayloadV2/);
    assert.match(apiRoutesSource, /getReturnContractV2/);
    assert.match(apiRoutesSource, /Cache-Control.*no-store/);
    assert.match(gatewaySource, /\/learning-runs\/\$\{safeRunId\}\/result\/v2/);
    assert.match(gatewaySource, /\/learning-runs\/\$\{safeRunId\}\/return-contract\/v2/);
  });

  it("keeps V2 draft and submission receipts on V2 paths and schemas", () => {
    for (const path of [
      "/learning-runs/:runId/tasks/:taskId/draft/v2",
      "/learning-runs/:runId/tasks/:taskId/submissions/v2",
    ]) {
      assert.ok(apiRoutesSource.includes(path), `missing API route ${path}`);
    }
    for (const schema of [
      "putLearningTaskDraftRequestV2Schema",
      "learningTaskDraftWriteReceiptV2Schema",
      "submitTaskArtifactV2Schema",
      "submitTaskArtifactReceiptV2Schema",
    ]) {
      assert.ok(apiRoutesSource.includes(schema), `missing strict schema ${schema}`);
    }
    assert.match(gatewaySource, /\/draft\/v2/);
    assert.match(gatewaySource, /\/submissions\/v2/);
  });

  it("keeps V2 action and activity lease endpoints isolated from V1", () => {
    assert.ok(apiRoutesSource.includes("/learning-runs/:runId/actions/v2"));
    assert.ok(apiRoutesSource.includes("/learning-runs/:runId/activity-lease/v2"));
    assert.match(apiRoutesSource, /learningRunActionRequestV2Schema/);
    assert.match(apiRoutesSource, /recordLearningRunActivityLeaseRequestV2Schema/);
    assert.match(gatewaySource, /\/actions\/v2/);
    assert.match(gatewaySource, /\/activity-lease\/v2/);
  });

  it("keeps the complete M2 snapshot/events/command roster on strict V2 schemas", () => {
    const roster = [
      ["learningRunGet", "get", "learningRunPublicSnapshotV2Schema"],
      ["learningRunStart", "start", "learningRunPublicSnapshotV2Schema"],
      ["learningRunGetDraft", "getDraft", "learningTaskDraftV2Schema"],
      ["learningRunSaveDraft", "saveDraft", "learningTaskDraftWriteReceiptV2Schema"],
      ["learningRunSubmit", "submit", "submitTaskArtifactReceiptV2Schema"],
      ["learningRunAction", "action", "learningRunActionResponseV2Schema"],
      ["learningRunGetResult", "getResult", "getLearningRunResultResponseV2Schema"],
      ["learningRunGetReturnContract", "getReturnContract", "learningRunReturnContractV2Schema"],
      ["learningRunRecordActivityLease", "recordActivityLease", "recordLearningRunActivityLeaseOutputV2Schema"],
      ["learningRunAbandon", "abandon", "learningRunActionResponseV2Schema"],
    ] as const;

    for (const [channel, method, schema] of roster) {
      assert.match(desktopIpcSource, new RegExp(`installHandler\\(DESKTOP_IPC_CHANNELS\\.${channel}\\b`), `missing main handler ${channel}`);
      assert.match(desktopIpcSource, new RegExp(`\\b${schema}\\b`), `missing output schema ${schema}`);
      assert.match(preloadSource, new RegExp(`\\b${method}: \\(input\\) => invoke\\(DESKTOP_IPC_CHANNELS\\.${channel}\\b`), `missing preload method ${method}`);
    }

    assert.match(desktopIpcSource, /watchLearningRunEvents/);
    assert.match(desktopIpcSource, /kind === "learningRun"/);
    assert.match(gatewaySource, /eventsUrl\.searchParams\.set\("snapshotId"/);
  });

  it("exposes the dedicated sanitized ReviewQueueV2 endpoint", () => {
    assert.ok(reviewRoutesSource.includes("/reviews/v2/queue"));
    assert.match(reviewRoutesSource, /projectReviewQueueV2/);
    assert.match(gatewaySource, /\/reviews\/v2\/queue/);
  });

  it("binds the main-owned SSE stream to the strict V2 snapshot", () => {
    assert.match(apiRoutesSource, /snapshotId.*非法/);
    assert.match(apiRoutesSource, /getLearningRunPublicSnapshotV2\(tx, \{ \.\.\.scope, runId: params\.data\.runId \}\)/);
    assert.match(apiRoutesSource, /last-event-id/);
    assert.match(gatewaySource, /eventsUrl\.searchParams\.set\("snapshotId", streamSnapshot\.snapshotId\)/);
    assert.match(gatewaySource, /const streamSnapshot = await this\.getLearningRun\(safeRunId\)/);
  });
});
