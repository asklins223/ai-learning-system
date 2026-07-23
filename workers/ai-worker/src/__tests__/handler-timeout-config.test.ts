/**
 * Tests for handler-timeout-config.ts — per-job-type timeout resolution.
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { resolveHandlerTimeout, RESOLVED_TIMEOUT_INFO } from "../lib/handler-timeout-config.ts";

const ENV_KEYS = [
  "WORKER_MODEL_TIMEOUT_MS",
  "WORKER_TIMEOUT_GENERATE_CARD_MS",
  "WORKER_TIMEOUT_EVALUATE_VALIDATION_MS",
  "WORKER_TIMEOUT_ALIGN_EVIDENCE_MS",
  "WORKER_TIMEOUT_PARSE_SOURCE_MS",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("resolveHandlerTimeout returns built-in defaults per job type", () => {
  assert.equal(resolveHandlerTimeout("generate_card"), 90_000);
  assert.equal(resolveHandlerTimeout("evaluate_validation"), 90_000);
  assert.equal(resolveHandlerTimeout("align_evidence"), 30_000);
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
});

test("resolveHandlerTimeout falls back to global default for unknown job types", () => {
  assert.equal(resolveHandlerTimeout("unknown_type"), 90_000);
});

test("resolveHandlerTimeout respects per-type env override", () => {
  process.env.WORKER_TIMEOUT_GENERATE_CARD_MS = "120000";
  assert.equal(resolveHandlerTimeout("generate_card"), 110_000); // clamped to lease - 10s
});

test("resolveHandlerTimeout respects global env override for unknown types", () => {
  process.env.WORKER_MODEL_TIMEOUT_MS = "60000";
  assert.equal(resolveHandlerTimeout("unknown_type"), 60_000);
});

test("resolveHandlerTimeout per-type env overrides global env", () => {
  process.env.WORKER_MODEL_TIMEOUT_MS = "30000";
  process.env.WORKER_TIMEOUT_GENERATE_CARD_MS = "60000";
  assert.equal(resolveHandlerTimeout("generate_card"), 60_000);
  assert.equal(resolveHandlerTimeout("evaluate_validation"), 30_000); // uses global
});

test("resolveHandlerTimeout clamps to lease safety margin", () => {
  process.env.WORKER_TIMEOUT_GENERATE_CARD_MS = "999999";
  const resolved = resolveHandlerTimeout("generate_card");
  assert.equal(resolved, RESOLVED_TIMEOUT_INFO.maxAllowedTimeoutMs);
  assert.ok(resolved < RESOLVED_TIMEOUT_INFO.leaseTimeoutMs, "timeout must be < lease timeout");
});

test("resolveHandlerTimeout ignores invalid env values", () => {
  process.env.WORKER_TIMEOUT_GENERATE_CARD_MS = "not-a-number";
  assert.equal(resolveHandlerTimeout("generate_card"), 90_000);

  process.env.WORKER_TIMEOUT_GENERATE_CARD_MS = "-5";
  assert.equal(resolveHandlerTimeout("generate_card"), 90_000);

  process.env.WORKER_TIMEOUT_GENERATE_CARD_MS = "0";
  assert.equal(resolveHandlerTimeout("generate_card"), 90_000);
});

test("lease safety margin is 10 seconds below lease timeout", () => {
  assert.equal(
    RESOLVED_TIMEOUT_INFO.maxAllowedTimeoutMs,
    RESOLVED_TIMEOUT_INFO.leaseTimeoutMs - 10_000,
  );
});
