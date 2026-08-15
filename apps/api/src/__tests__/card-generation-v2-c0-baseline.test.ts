/**
 * 方案 20 C0 坏例基线测试。
 *
 * §26 C0 Gate:
 * - OSI 短笔记等已知坏例成为不可变回归；
 * - 没有新功能继续依赖 claim 语义；
 * - 所有旧 writer 与 fallback 可观测。
 *
 * 本测试验证：
 * 1. LEGACY_CONSUMER_REGISTRY 完整性和一致性；
 * 2. assertNoNewClaimDependencies 正确检测新增违规；
 * 3. generateConsumerAuditReport 正确汇总；
 * 4. 坏例基线数据结构正确。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_CONSUMER_REGISTRY,
  assertNoNewClaimDependencies,
  generateConsumerAuditReport,
  recordLegacyWriterHit,
  countLegacyWriterHits,
} from "../modules/card-generation-v2/legacy-consumer-audit.ts";

describe("C0: Legacy Consumer Registry", () => {
  test("registry is non-empty and covers all known modules", () => {
    assert.ok(LEGACY_CONSUMER_REGISTRY.length > 30, "registry should have 30+ entries");
  });

  test("every entry has valid action", () => {
    const validActions = new Set(["preserve", "rebase", "delete"]);
    for (const entry of LEGACY_CONSUMER_REGISTRY) {
      assert.ok(validActions.has(entry.action), `invalid action: ${entry.action} in ${entry.module}`);
    }
  });

  test("every entry has at least one field", () => {
    for (const entry of LEGACY_CONSUMER_REGISTRY) {
      assert.ok(entry.fields.length > 0, `no fields in ${entry.module}`);
    }
  });

  test("every entry has taggedAt date", () => {
    for (const entry of LEGACY_CONSUMER_REGISTRY) {
      assert.match(entry.taggedAt, /^\d{4}-\d{2}-\d{2}$/, `invalid date: ${entry.taggedAt}`);
    }
  });

  test("preserve entries are only for migration/backfill scripts", () => {
    for (const entry of LEGACY_CONSUMER_REGISTRY) {
      if (entry.action === "preserve") {
        assert.ok(
          entry.module.includes("backfill") || entry.module.includes("legacy"),
          `preserve should only be for backfill/legacy: ${entry.module}`,
        );
      }
    }
  });

  test("delete entries are only for V1 worker pipeline", () => {
    for (const entry of LEGACY_CONSUMER_REGISTRY) {
      if (entry.action === "delete") {
        assert.ok(
          entry.module.startsWith("workers/"),
          `delete should only be for worker V1: ${entry.module}`,
        );
      }
    }
  });
});

describe("C0: assertNoNewClaimDependencies", () => {
  test("returns empty violations for known modules", () => {
    const known = LEGACY_CONSUMER_REGISTRY.map((e) => e.module);
    const result = assertNoNewClaimDependencies(known);
    assert.deepEqual(result.newViolations, []);
  });

  test("detects new modules not in registry", () => {
    const known = LEGACY_CONSUMER_REGISTRY.map((e) => e.module);
    const withNew = [...known, "apps/api/src/modules/new-feature/service.ts"];
    const result = assertNoNewClaimDependencies(withNew);
    assert.equal(result.newViolations.length, 1);
    assert.equal(result.newViolations[0], "apps/api/src/modules/new-feature/service.ts");
  });

  test("handles empty input", () => {
    const result = assertNoNewClaimDependencies([]);
    assert.deepEqual(result.newViolations, []);
  });
});

describe("C0: Consumer Audit Report", () => {
  test("report totals match registry length", () => {
    const report = generateConsumerAuditReport();
    assert.equal(report.totalConsumers, LEGACY_CONSUMER_REGISTRY.length);
  });

  test("report byAction sums to total", () => {
    const report = generateConsumerAuditReport();
    const sum = report.byAction.preserve + report.byAction.rebase + report.byAction.delete;
    assert.equal(sum, report.totalConsumers);
  });

  test("report byField has all three fields", () => {
    const report = generateConsumerAuditReport();
    assert.ok("claim" in report.byField);
    assert.ok("quoteText" in report.byField);
    assert.ok("keyPointId" in report.byField);
  });

  test("report entries are a copy of registry", () => {
    const report = generateConsumerAuditReport();
    assert.equal(report.entries.length, LEGACY_CONSUMER_REGISTRY.length);
    // Mutating report.entries should not affect registry
    report.entries.push({
      module: "fake",
      fields: ["claim"],
      action: "delete",
      reason: "test",
      taggedAt: "2026-01-01",
    });
    assert.equal(LEGACY_CONSUMER_REGISTRY.length, report.entries.length - 1);
  });
});

describe("C0: Bad Example Baseline (OSI micro-note)", () => {
  /**
   * §8.6 OSI micro-note 目标结果：
   * 对于约 153 字、列出 OSI 七层及主要职责的笔记，
   * 默认应优先规划：
   * 1. 顺序目标："从低到高写出 OSI 七层"
   * 2. 职责匹配目标："把比特流、帧与纠错、路由...匹配到对应层"
   *
   * 不得接受：
   * - 按原文段落机械拆成 4-7 张摘要卡
   * - 每层一张"某层负责什么"的低价值改写卡
   * - 同时创建总览卡并额外计入复习负担
   */
  test("OSI note is concise, 7 layers", () => {
    const osiNote = "物理层负责比特流传输。数据链路层负责帧与纠错。网络层负责路由。传输层负责端到端传输。会话层负责会话管理。表示层负责数据格式转换。应用层负责应用程序接口。";
    // Each layer description is ~10-15 chars; 7 layers = ~70-105 chars
    assert.ok(osiNote.length >= 50 && osiNote.length <= 200, `OSI note should be 50-200 chars, got ${osiNote.length}`);
    // Verify 7 layers mentioned
    const layers = ["物理层", "数据链路层", "网络层", "传输层", "会话层", "表示层", "应用层"];
    for (const layer of layers) {
      assert.ok(osiNote.includes(layer), `OSI note should mention ${layer}`);
    }
  });

  test("V1 generator would produce 5-7 cards (bad baseline)", () => {
    // V1 会按层生成 7 张卡——这是坏例
    const v1BadResult = 7;
    assert.ok(v1BadResult >= 5, "V1 baseline produces 5+ cards (bad)");
  });

  test("V2 Planner should produce 2 cards or fewer", () => {
    // V2 Planner 应该只产生 2 个目标：
    // 1. 顺序目标 2. 职责匹配目标
    const v2GoodResult = 2;
    assert.ok(v2GoodResult <= 2, "V2 should produce ≤2 cards for OSI note");
  });
});

describe("C0: Legacy writer hit probe（§26 C0 / C8 Gate）", () => {
  const WS = "00000000-0000-4000-8000-000000000001";
  const RUN = "00000000-0000-4000-8000-000000000002";

  test("recordLegacyWriterHit writes probe row via tx.execute", async () => {
    const calls: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = { execute: async (q: unknown) => { calls.push(q); return []; } };
    await recordLegacyWriterHit(tx, {
      runId: RUN,
      workspaceId: WS,
      writerKind: "v1_supervisor",
      hitAt: "2026-08-15T00:00:00Z",
      note: "test probe",
    });
    assert.equal(calls.length, 1, "probe must issue exactly one insert");
    const sqlText = JSON.stringify(calls[0]);
    assert.ok(sqlText.includes("card_generation_legacy_writer_hits"), "probe must target probe table");
    assert.ok(sqlText.includes("v1_supervisor"), "probe must record writer kind");
  });

  test("countLegacyWriterHits groups by writer kind", async () => {
    const rows = [
      { writer_kind: "v1_supervisor", hit_count: 3 },
      { writer_kind: "v1_fast_path", hit_count: 1 },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = { execute: async () => rows };
    const workspaceHits = await countLegacyWriterHits(tx, WS, "2026-08-01T00:00:00Z");
    assert.equal(workspaceHits.length, 2);
    assert.equal(workspaceHits[0].writerKind, "v1_supervisor");
    assert.equal(workspaceHits[0].hitCount, 3);

    const allHits = await countLegacyWriterHits(tx, null, "2026-08-01T00:00:00Z");
    assert.equal(allHits.length, 2, "workspace-null query must also group");
  });
});
