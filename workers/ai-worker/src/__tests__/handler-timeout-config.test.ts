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
  "WORKER_TIMEOUT_COMPANION_AGENT_MS",
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

/**
 * 伴星回合的预算阶梯（方案 29 §4.7/§9.6/§4.9 第 6 项）。
 *
 * 这四层数字以前靠手工同时修改来保持协调：lease(120s) > handler(110s) >
 * run 预算(handler - 持久化余量) > 单次工具 / 单次 provider 调用。任何一层被单独
 * 抬高，症状都不是报错而是**用户什么都收不到**——例如工具预算超过 run 预算时，
 * 那一轮必然被 handler 抢杀（delta 与终态事务没时间落库）。
 * 读图那次改动（45s 单工具预算）就是在这条阶梯上加的，所以钉它的那只手也钉在这里。
 *
 * 2026-09-22 收口：前三层不再各写一份数字，全部由 `resolveCompanionAgentBudget()`
 * 从租约派生。这条用例除了钉大小关系，还钉**派生本身**——把任一层改回字面量、
 * 或让 env 覆盖只动 handler 不动 loop deadline，都会在这里红。
 */
test("伴星预算阶梯：lease > handler > run > 单次工具/单次 provider", async () => {
  const { LEASE_TIMEOUT_MS } = await import("../queue.ts");
  const { COMPANION_AGENT_DEADLINE_MS, COMPANION_AGENT_TOOL_TIMEOUT_MS } = await import("@ailearn/shared");
  const { READ_IMAGE_TOOL_TIMEOUT_MS } = await import("../handlers/companion-agent-runtime.ts");
  const {
    COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
    resolveCompanionAgentBudget,
  } = await import("../lib/handler-timeout-config.ts");

  const handler = resolveHandlerTimeout("companion_agent");
  const runBudget = handler - COMPANION_AGENT_PERSISTENCE_MARGIN_MS;

  assert.ok(handler < LEASE_TIMEOUT_MS, "handler 必须先到期；否则 reaper 抢在 abort 前把 job 收回，run 停在 running");
  assert.ok(
    COMPANION_AGENT_DEADLINE_MS >= handler,
    "合同预算不该在一个新 attempt 里比 handler 更早绑住：那会把超时误记成 AGENT_BUDGET_EXCEEDED",
  );
  assert.ok(
    READ_IMAGE_TOOL_TIMEOUT_MS < runBudget,
    "最重的单个工具必须能在 run 预算内跑完一次，否则它每一次都会被中途掐死",
  );
  assert.ok(
    resolveProviderCallTimeout("companion_agent") < runBudget,
    "一次 provider 调用不能吃完整个 run 预算（后面的收尾就没有余地了）",
  );
  assert.ok(
    runBudget - READ_IMAGE_TOOL_TIMEOUT_MS >= COMPANION_AGENT_TOOL_TIMEOUT_MS * 2,
    "读完一张图之后，至少要还剩两次查库工具的时间，否则这一步之后什么都做不了",
  );

  // 派生链本身：三层是 lease 的函数，不是三个各自维护的数字。
  const budget = resolveCompanionAgentBudget();
  assert.equal(budget.leaseMs, LEASE_TIMEOUT_MS);
  assert.equal(budget.handlerAbortMs, handler);
  assert.equal(budget.loopDeadlineMs, handler - COMPANION_AGENT_PERSISTENCE_MARGIN_MS);
  assert.ok(
    budget.loopDeadlineMs < budget.handlerAbortMs,
    "loop deadline 必须先于 handler abort：否则循环跑到一半被 abort 掐死，delta 与终态事务没有落库时间",
  );
  assert.equal(
    RESOLVED_TIMEOUT_INFO.defaultTimeouts.companion_agent,
    RESOLVED_TIMEOUT_INFO.maxAllowedTimeoutMs,
    "companion_agent 的默认值必须由租约派生（= 租约 - 安全余量），不能再写成字面量",
  );
});

test("预算链跟着 env 覆盖一起动：handler 被覆盖时 loop deadline 不能停在旧值", async () => {
  const {
    COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
    resolveCompanionAgentBudget,
  } = await import("../lib/handler-timeout-config.ts");

  const before = resolveCompanionAgentBudget();
  process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS = "60000";
  try {
    const after = resolveCompanionAgentBudget();
    assert.equal(after.handlerAbortMs, 60_000);
    assert.equal(after.loopDeadlineMs, 60_000 - COMPANION_AGENT_PERSISTENCE_MARGIN_MS);
    assert.notEqual(after.loopDeadlineMs, before.loopDeadlineMs);
    assert.equal(after.leaseMs, before.leaseMs, "租约是外层边界，不该被 handler 覆盖改动");
  } finally {
    delete process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS;
  }
});
