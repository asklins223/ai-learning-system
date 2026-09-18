/**
 * 稳定 P1（2026-09-15 审计）：parse_source 的 payload 契约在 handler 入口 fail closed。
 *
 * 这里只覆盖"坏载荷立刻以 JobPayloadContractError 失败、且被归类为不可重试"——
 * 顺序上它发生在 assertJobLease/任何 DB 查询**之前**，所以本用例不需要数据库。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JobPayloadContractError } from "@ailearn/shared/job-payload-contracts";
import { JobType } from "@ailearn/shared";
import { runParseSource } from "./parse-source.ts";
import type { JobPayload } from "./index.ts";
import { isNonRetryableError } from "../lib/non-retryable-errors.ts";

function claimedJob(payload: Record<string, unknown>): JobPayload {
  return {
    id: "job-1",
    workspaceId: "ws-1",
    requestedBy: null,
    payload,
    leaseToken: "lease-1",
  };
}

test("parse_source：坏 payload 在碰数据库前就以契约错误 fail closed，并归类为不可重试", async () => {
  const badPayloads: Array<[string, Record<string, unknown>]> = [
    ["缺 sourceId", {}],
    ["sourceId 是数字", { sourceId: 42 }],
    ["sourceId 是空串", { sourceId: "" }],
    ["sourceId 只有空白", { sourceId: "  " }],
    ["sourceId 是 null", { sourceId: null }],
  ];

  for (const [label, payload] of badPayloads) {
    await assert.rejects(
      () => runParseSource(claimedJob(payload)),
      (error: unknown) => {
        assert.ok(error instanceof JobPayloadContractError, `${label}: 应为 JobPayloadContractError`);
        assert.equal(error.jobType, JobType.PARSE_SOURCE, label);
        // 关键行为：确定性失败 → 不重试（否则坏载荷会空转三次租约才 dead）。
        assert.equal(isNonRetryableError(error), true, `${label}: 必须不可重试`);
        return true;
      },
      label,
    );
  }
});
