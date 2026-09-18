/** Tests for the active worker handler timeout resolution. */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  resolveHandlerTimeout,
  resolveProviderCallTimeout,
  RESOLVED_TIMEOUT_INFO,
} from "../lib/handler-timeout-config.ts";

const ENV_KEYS = [
  "WORKER_MODEL_TIMEOUT_MS",
  "WORKER_TIMEOUT_PARSE_SOURCE_MS",
  "WORKER_PROVIDER_TIMEOUT_MS",
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

test("resolveHandlerTimeout returns active built-in defaults", () => {
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
  assert.equal(resolveHandlerTimeout("companion_agent"), 110_000);
});

test("resolveHandlerTimeout falls back to global default for unknown types", () => {
  assert.equal(resolveHandlerTimeout("unknown_type"), 90_000);
});

test("resolveHandlerTimeout respects a per-type override", () => {
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "120000";
  assert.equal(resolveHandlerTimeout("parse_source"), 110_000);
});

test("resolveHandlerTimeout respects the global override", () => {
  process.env.WORKER_MODEL_TIMEOUT_MS = "60000";
  assert.equal(resolveHandlerTimeout("unknown_type"), 60_000);
});

test("resolveHandlerTimeout ignores invalid env values", () => {
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "not-a-number";
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "-5";
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
});

test("lease safety margin remains below the lease timeout", () => {
  assert.equal(
    RESOLVED_TIMEOUT_INFO.maxAllowedTimeoutMs,
    RESOLVED_TIMEOUT_INFO.leaseTimeoutMs - 10_000,
  );
});

test("provider budget leaves time for persistence", () => {
  assert.equal(resolveProviderCallTimeout("parse_source"), 45_000);
  assert.equal(
    resolveHandlerTimeout("parse_source") - resolveProviderCallTimeout("parse_source"),
    15_000,
  );
});
