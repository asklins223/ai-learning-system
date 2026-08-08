/**
 * 任务 09-7：硬不变量与必测行为收口 单测（§16.1/§17.1，阶段 09 W8）。
 *
 * 覆盖：
 * - 清单结构：§16.1 共 22 项（19 项 0 容忍 + 3 项 100%）、§17.1 共 35 条，
 *   id 唯一、断言非空、`requires` 字段真实存在于观察接口；
 * - 无伪通过：对清单每一项运行 `detectFakePass`，断言零 placeholder /
 *   skip / insufficient-data 问题；并对 placeholder / skip / insufficient-data
 *   三类构造样本逐一验证检测器必检；
 * - 逐项双样本：§16.1 每项与 §17.1 每条「干净样本全 pass + 违规样本必 fail」，
 *   证明每项判定都不是恒真/空实现；
 * - 收口编排：全合规输入 → `allClosed=true` 且不抛错；注入任一 0 容忍违规 /
 *   100% 项破坏 / 必测行为未通过 / 清单缺测 / 伪通过 → `allClosed=false`、
 *   `rollbackEvaluationRequired=true`，`assertHardInvariantCloseout` 抛
 *   `HardInvariantCloseoutFailure`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HARD_INVARIANTS_16_1,
  MUST_TEST_BEHAVIORS_17_1,
  HardInvariantCloseoutFailure,
  assertHardInvariantCloseout,
  detectFakePass,
  emptyObservations161,
  emptyObservations171,
  evaluateHardInvariant,
  evaluateMustTestBehavior,
  probeReadFields,
  runHardInvariantCloseout,
  type HardInvariantSpec,
  type MustTestBehaviorSpec,
  type Section161Observations,
  type Section171Observations,
} from "./hard-invariants.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** 破坏 spec 第一条断言所依赖的第一个证据字段（0 容忍/100% 项通用）。 */
function violateFirstAssertion161(
  spec: HardInvariantSpec,
): Section161Observations {
  const base = emptyObservations161();
  const field = spec.assertions[0].requires[0];
  const current = (base as unknown as Record<string, unknown>)[field];
  const next =
    typeof current === "string" ? `violated-${current}` : !current;
  return { ...base, [field]: next } as Section161Observations;
}

/** 破坏必测行为第一条断言所依赖的第一个证据字段（§17.1 全正向布尔）。 */
function violateFirstAssertion171(
  spec: MustTestBehaviorSpec,
): Section171Observations {
  const base = emptyObservations171();
  const field = spec.assertions[0].requires[0];
  return { ...base, [field]: false } as Section171Observations;
}

const KEYS_161 = new Set(Object.keys(emptyObservations161()));
const KEYS_171 = new Set(Object.keys(emptyObservations171()));

// ─── 清单结构 ─────────────────────────────────────────────────────────────

describe("清单结构（§16.1 硬指标）", () => {
  it("共 22 项：19 项 0 容忍 + 3 项 100%", () => {
    assert.equal(HARD_INVARIANTS_16_1.length, 22);
    const zero = HARD_INVARIANTS_16_1.filter((s) => s.tolerance === "zero");
    const hundred = HARD_INVARIANTS_16_1.filter(
      (s) => s.tolerance === "percent100",
    );
    assert.equal(zero.length, 19);
    assert.equal(hundred.length, 3);
  });

  it("id 唯一且命名规范（16.1-zNN / 16.1-pNN）", () => {
    const ids = HARD_INVARIANTS_16_1.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^16\.1-(z|p)\d{2}$/);
    }
  });

  it("每条断言非空、requires 非空且字段真实存在于观察接口", () => {
    for (const spec of HARD_INVARIANTS_16_1) {
      assert.ok(spec.assertions.length > 0, `${spec.id} 断言为空`);
      assert.ok(spec.frozenText.length > 0, `${spec.id} frozenText 为空`);
      assert.ok(spec.mapsTo.length > 0, `${spec.id} mapsTo 为空`);
      for (const a of spec.assertions) {
        assert.ok(a.requires.length > 0, `${spec.id}/${a.id} requires 为空`);
        for (const f of a.requires) {
          assert.ok(
            KEYS_161.has(f),
            `${spec.id}/${a.id} requires 字段 ${f} 不存在于观察接口`,
          );
        }
      }
    }
  });

  it("每条断言经 detectFakePass 零伪通过", () => {
    for (const spec of HARD_INVARIANTS_16_1) {
      const issues = detectFakePass(spec);
      assert.deepEqual(issues, [], `${spec.id} 存在伪通过：${JSON.stringify(issues)}`);
    }
  });
});

describe("清单结构（§17.1 必测行为）", () => {
  it("共 35 条", () => {
    assert.equal(MUST_TEST_BEHAVIORS_17_1.length, 35);
  });

  it("id 唯一且命名规范（17.1-NN）", () => {
    const ids = MUST_TEST_BEHAVIORS_17_1.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^17\.1-\d{2}$/);
    }
  });

  it("每条断言非空、requires 非空且字段真实存在于观察接口", () => {
    for (const spec of MUST_TEST_BEHAVIORS_17_1) {
      assert.ok(spec.assertions.length > 0, `${spec.id} 断言为空`);
      assert.ok(spec.frozenText.length > 0, `${spec.id} frozenText 为空`);
      assert.ok(spec.mapsTo.length > 0, `${spec.id} mapsTo 为空`);
      for (const a of spec.assertions) {
        assert.ok(a.requires.length > 0, `${spec.id}/${a.id} requires 为空`);
        for (const f of a.requires) {
          assert.ok(
            KEYS_171.has(f),
            `${spec.id}/${a.id} requires 字段 ${f} 不存在于观察接口`,
          );
        }
      }
    }
  });

  it("每条断言经 detectFakePass 零伪通过", () => {
    for (const spec of MUST_TEST_BEHAVIORS_17_1) {
      const issues = detectFakePass(spec);
      assert.deepEqual(issues, [], `${spec.id} 存在伪通过：${JSON.stringify(issues)}`);
    }
  });
});

// ─── 逐项双样本（§16.1 硬指标）──────────────────────────────────────────

describe("§16.1 逐项双样本：干净样本全 pass + 违规样本必 fail", () => {
  for (const spec of HARD_INVARIANTS_16_1) {
    it(spec.id, () => {
      const clean = evaluateHardInvariant(spec, emptyObservations161());
      assert.equal(clean.passed, true, `${spec.id} 干净样本未通过`);

      const violated = evaluateHardInvariant(
        spec,
        violateFirstAssertion161(spec),
      );
      assert.equal(violated.passed, false, `${spec.id} 违规样本未检出`);
      assert.ok(
        violated.failedAssertionIds.length >= 1,
        `${spec.id} 违规样本无失败断言`,
      );
    });
  }
});

// ─── 逐项双样本（§17.1 必测行为）────────────────────────────────────────

describe("§17.1 逐条双样本：干净样本全 pass + 违规样本必 fail", () => {
  for (const spec of MUST_TEST_BEHAVIORS_17_1) {
    it(spec.id, () => {
      const clean = evaluateMustTestBehavior(spec, emptyObservations171());
      assert.equal(clean.passed, true, `${spec.id} 干净样本未通过`);

      const violated = evaluateMustTestBehavior(
        spec,
        violateFirstAssertion171(spec),
      );
      assert.equal(violated.passed, false, `${spec.id} 违规样本未检出`);
      assert.ok(
        violated.failedAssertionIds.length >= 1,
        `${spec.id} 违规样本无失败断言`,
      );
    });
  }
});

// ─── 伪通过检测 ─────────────────────────────────────────────────────────

describe("detectFakePass 伪通过检测", () => {
  it("空断言列表 → placeholder（空实现占位）", () => {
    const issues = detectFakePass({
      id: "fake-placeholder",
      assertions: [],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "placeholder");
    assert.equal(issues[0].assertionId, "*");
  });

  it("requires 为空 → insufficient-data", () => {
    const issues = detectFakePass({
      id: "fake-requires-empty",
      assertions: [
        {
          id: "a1",
          description: "d",
          requires: [],
          check: (o: Section161Observations) => !o.singleClickSelectionUpgraded,
        },
      ],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "insufficient-data");
  });

  it("check 不读取任何观察字段 → skip（恒真占位）", () => {
    const issues = detectFakePass({
      id: "fake-skip",
      assertions: [
        { id: "a1", description: "无条件通过", requires: ["x"], check: () => true },
      ],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "skip");
  });

  it("声明的 requires 字段未被判定实际读取 → insufficient-data", () => {
    const issues = detectFakePass({
      id: "fake-insufficient",
      assertions: [
        {
          id: "a1",
          description: "只读 a 但声明 a+b",
          requires: ["unknownOrUnauthorizedRefUsed", "crossUserLeak"],
          check: (o: Section161Observations) => !o.unknownOrUnauthorizedRefUsed,
        },
      ],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, "insufficient-data");
    assert.match(issues[0].detail, /crossUserLeak/);
  });

  it("正常断言（requires 与运行时读取一致）→ 零问题", () => {
    const issues = detectFakePass({
      id: "fake-ok",
      assertions: [
        {
          id: "a1",
          description: "d",
          requires: ["singleClickSelectionUpgraded"],
          check: (o: Section161Observations) => !o.singleClickSelectionUpgraded,
        },
      ],
    });
    assert.deepEqual(issues, []);
  });

  it("probeReadFields 收集嵌套与多字段读取路径", () => {
    const fields = probeReadFields((o: Section161Observations) => {
      const a = o.singleClickSelectionUpgraded;
      const b = o.crossWorkspaceLeak;
      return !a && !b;
    });
    assert.ok(fields.includes("singleClickSelectionUpgraded"));
    assert.ok(fields.includes("crossWorkspaceLeak"));
  });
});

// ─── 收口编排 ─────────────────────────────────────────────────────────

describe("runHardInvariantCloseout 收口编排", () => {
  it("全合规输入 → allClosed=true，不抛错", () => {
    const report = runHardInvariantCloseout({
      section161: emptyObservations161(),
      section171: emptyObservations171(),
    });
    assert.equal(report.summary.invariantTotal, 22);
    assert.equal(report.summary.invariantPassed, 22);
    assert.deepEqual(report.summary.zeroToleranceViolatedIds, []);
    assert.deepEqual(report.summary.percent100FailedIds, []);
    assert.equal(report.summary.behaviorsTotal, 35);
    assert.equal(report.summary.behaviorsPassed, 35);
    assert.deepEqual(report.summary.behaviorsFailedIds, []);
    assert.deepEqual(report.summary.missingInvariantIds, []);
    assert.deepEqual(report.summary.missingBehaviorIds, []);
    assert.equal(report.summary.fakePassCount, 0);
    assert.equal(report.summary.allClosed, true);
    assert.equal(report.summary.rollbackEvaluationRequired, false);
    assert.doesNotThrow(() => assertHardInvariantCloseout(report));
  });

  it("任一 0 容忍违规 → zeroToleranceViolatedIds 记录、回滚评估、抛错", () => {
    const report = runHardInvariantCloseout({
      section161: {
        ...emptyObservations161(),
        unknownOrUnauthorizedRefUsed: true,
      },
      section171: emptyObservations171(),
    });
    assert.deepEqual(report.summary.zeroToleranceViolatedIds, ["16.1-z01"]);
    assert.equal(report.summary.allClosed, false);
    assert.equal(report.summary.rollbackEvaluationRequired, true);
    assert.throws(
      () => assertHardInvariantCloseout(report),
      HardInvariantCloseoutFailure,
    );
  });

  it("投影 replay hash 不一致 → 100% 项未达成", () => {
    const report = runHardInvariantCloseout({
      section161: {
        ...emptyObservations161(),
        projectionReplayHash: "replayed-hash-abc",
        projectionStoredHash: "stored-hash-def",
      },
      section171: emptyObservations171(),
    });
    assert.deepEqual(report.summary.percent100FailedIds, ["16.1-p03"]);
    assert.equal(report.summary.allClosed, false);
  });

  it("redacted 仍支持 semantic re-audit → 100% 项未达成", () => {
    const report = runHardInvariantCloseout({
      section161: {
        ...emptyObservations161(),
        redactedSemanticReauditSupported: true,
      },
      section171: emptyObservations171(),
    });
    assert.deepEqual(report.summary.percent100FailedIds, ["16.1-p02"]);
    assert.equal(report.summary.allClosed, false);
  });

  it("必测行为未通过 → behaviorsFailedIds 记录", () => {
    const report = runHardInvariantCloseout({
      section161: emptyObservations161(),
      section171: {
        ...emptyObservations171(),
        credentialFuzzAllVariantsBlocked: false,
      },
    });
    assert.deepEqual(report.summary.behaviorsFailedIds, ["17.1-01"]);
    assert.equal(report.summary.allClosed, false);
  });

  it("清单缺测（裁剪为空）→ 缺测不静默通过", () => {
    const report = runHardInvariantCloseout(
      { section161: emptyObservations161(), section171: emptyObservations171() },
      [],
      [],
    );
    assert.equal(report.summary.missingInvariantIds.length, 22);
    assert.equal(report.summary.missingBehaviorIds.length, 35);
    assert.equal(report.summary.allClosed, false);
    assert.equal(report.summary.rollbackEvaluationRequired, true);
  });

  it("全部破坏 → 全维度违规汇总", () => {
    const report = runHardInvariantCloseout({
      section161: {
        ...emptyObservations161(),
        unknownOrUnauthorizedRefUsed: true,
        starMapStateChangedWithoutEvent: true,
        projectionReplayHash: "x",
        projectionStoredHash: "y",
      },
      section171: {
        ...emptyObservations171(),
        routerCoverageReconciled: false,
        keyboardlessMainPath: false,
      },
    });
    assert.equal(report.summary.zeroToleranceViolatedIds.length, 2);
    assert.deepEqual(report.summary.percent100FailedIds, ["16.1-p03"]);
    assert.deepEqual(report.summary.behaviorsFailedIds, ["17.1-04", "17.1-30"]);
    assert.equal(report.summary.allClosed, false);
    assert.throws(
      () => assertHardInvariantCloseout(report),
      /zeroViolated=16\.1-z01,16\.1-z19/,
    );
  });
});
