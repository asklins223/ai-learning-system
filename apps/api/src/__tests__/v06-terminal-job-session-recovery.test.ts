import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { terminalJobRecoveryProjection } from "../modules/validation/session-service.ts";

const serviceSource = readFileSync(
  new URL("../modules/validation/session-service.ts", import.meta.url),
  "utf8",
);

test("terminal question jobs recover stuck sessions to question_retryable", () => {
  for (const status of ["succeeded", "failed", "dead", "missing"]) {
    assert.deepEqual(
      terminalJobRecoveryProjection("question_preparing", status),
      {
        status: "question_retryable",
        failureStage: "question_generation",
        failureCode: `question_job_${status}_without_projection`,
      },
    );
  }
});

test("terminal evaluation jobs recover stuck sessions to evaluation_retryable", () => {
  for (const status of ["succeeded", "failed", "dead", "missing"]) {
    assert.deepEqual(
      terminalJobRecoveryProjection("evaluation_pending", status),
      {
        status: "evaluation_retryable",
        failureStage: "evaluation",
        failureCode: `evaluation_job_${status}_without_projection`,
      },
    );
  }
});

test("active jobs and non-pending sessions are not rewritten", () => {
  assert.equal(terminalJobRecoveryProjection("question_preparing", "pending"), null);
  assert.equal(terminalJobRecoveryProjection("question_preparing", "running"), null);
  assert.equal(terminalJobRecoveryProjection("ready", "dead"), null);
  assert.equal(terminalJobRecoveryProjection("completed", "succeeded"), null);
});

test("recovery uses a job-pointer-fenced CAS and refreshes after a lost race", () => {
  const start = serviceSource.indexOf("async function reconcilePendingJobProjection(");
  const end = serviceSource.indexOf("async function keyPointHasHardEvidence(", start);
  const section = serviceSource.slice(start, end);

  assert.match(section, /eq\(currentJobColumn, jobId\)/);
  assert.match(section, /\.returning\(\)/);
  assert.match(section, /if \(recovered\) return recovered/);
  assert.match(section, /tx\.query\.validationSubmissions\.findFirst/);
});

test("GET keeps submission recovery and question reads in one RLS-scoped transaction", () => {
  const start = serviceSource.indexOf("export async function getValidationSession(");
  const end = serviceSource.indexOf("// ─── 3. Draft", start);
  const section = serviceSource.slice(start, end);

  assert.match(section, /withWorkspaceTransaction\(/);
  assert.match(section, /reconcilePendingJobProjection\(tx,/);
  assert.match(section, /tx\.query\.validationQuestions\.findFirst/);
  assert.doesNotMatch(section, /db\.query\.|cardKeyPoints/);
});
