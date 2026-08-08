/**
 * 任务 09-4：容量与性能 RC 单测（§16.5，阶段 09 W8）。
 *
 * 覆盖：
 * - 容量 fixture 矩阵：冻结档位、243 组合笛卡尔积、全组合合法、越界维度违规；
 * - 分位数：R7 线性插值（与 08-4 metrics-schema 同源语义）；
 * - 性能门限：action→帧 p95<100ms、scene→可交互 p95<300ms、星图帧率≥W0 基线、
 *   移动端内存（绝对+相对）、Shell JS/渲染/路由相对预算、样本量 ≥100；
 * - 报告环境完整性：硬件/浏览器/构建/fixture/网络/区间/样本量/冷热分离/
 *   禁止开发机/禁止平均值替代 p95；
 * - evaluateCapacityPerf 汇总：全过与各违规场景。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_TO_FRAME_P95_LIMIT_MS,
  CAPACITY_FIXTURES,
  CAPACITY_PERF_VERSION,
  CARD_KEY_POINT_LEVELS,
  CONCURRENT_SESSION_LEVELS,
  MIN_SAMPLES_PER_SCENARIO,
  MOBILE_MEMORY_BUDGET_MB,
  NOTE_CHARACTER_LEVELS,
  SCENE_TO_INTERACTIVE_P95_LIMIT_MS,
  SESSION_EPISODE_LEVELS,
  SHELL_MOBILE_MEMORY_DELTA_BUDGET_MB,
  SHELL_P95_DELTA_BUDGET_MS,
  STAR_MAP_1000_NODES_MIN_FPS,
  STAR_MAP_NODE_LEVELS,
  checkActionToFrameP95,
  checkMobileMemoryBudget,
  checkSceneToInteractiveP95,
  checkShellP95Delta,
  checkStarMapFps,
  computeP95,
  computePercentile,
  evaluateCapacityPerf,
  isFrozenCapacityFixture,
  validateCapacityFixture,
  validatePerfReportEnv,
  type CapacityFixture,
  type PerfReportEnv,
} from "./capacity-perf.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

/** 生成 n 个相同值的样本（测试用）。 */
function sampleN(value: number, n: number): number[] {
  return Array.from({ length: n }, () => value);
}

/** 合法环境元数据（各测试可按需覆盖单字段）。 */
function validEnv(overrides: Partial<PerfReportEnv> = {}): PerfReportEnv {
  return {
    hardware: "MacBook Pro M3 / 中档 Android (Pixel 7a)",
    browser: "Google Chrome 126 (stable)",
    build: "build-20260808.1",
    fixture: {
      noteChars: 13_000,
      keyPointsPerCard: 10,
      episodesPerSession: 3,
      starMapNodes: 1_000,
      concurrentSessions: 5,
    },
    network: "offline (仅本地渲染, 不含网络/Provider)",
    interval: "p95 12ms (11.2–14.8)",
    sampleCount: 120,
    hotCold: "separated",
    dataSource: "reference_desktop",
    aggregate: "p95",
    ...overrides,
  };
}

// ─── 1. 容量 fixture 矩阵 ─────────────────────────────────────────────────

describe("容量 fixture 矩阵（§16.5）", () => {
  it("冻结档位枚举正确", () => {
    assert.deepEqual([...NOTE_CHARACTER_LEVELS], [2_000, 13_000, 50_000]);
    assert.deepEqual([...CARD_KEY_POINT_LEVELS], [1, 10, 30]);
    assert.deepEqual([...SESSION_EPISODE_LEVELS], [1, 3, 5]);
    assert.deepEqual([...STAR_MAP_NODE_LEVELS], [100, 1_000, 5_000]);
    assert.deepEqual([...CONCURRENT_SESSION_LEVELS], [1, 5, 25]);
  });

  it("笛卡尔积 = 3×3×3×3×3 = 243 个组合，全部命中冻结档位", () => {
    assert.equal(CAPACITY_FIXTURES.length, 243);
    for (const fixture of CAPACITY_FIXTURES) {
      assert.deepEqual(validateCapacityFixture(fixture), [], "每个组合必须合法");
      assert.equal(isFrozenCapacityFixture(fixture), true);
    }
  });

  it("任一维度越界 → 违规", () => {
    const base: CapacityFixture = {
      noteChars: 13_000,
      keyPointsPerCard: 10,
      episodesPerSession: 3,
      starMapNodes: 1_000,
      concurrentSessions: 5,
    };
    const violations = validateCapacityFixture({ ...base, noteChars: 7_000 });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /noteChars/);

    const violations2 = validateCapacityFixture({
      ...base,
      keyPointsPerCard: 50,
      episodesPerSession: 2,
      starMapNodes: 50_000,
      concurrentSessions: 100,
    });
    assert.equal(violations2.length, 4);
    for (const v of violations2) {
      assert.ok(
        /noteChars|keyPointsPerCard|episodesPerSession|starMapNodes|concurrentSessions/.test(v),
      );
    }
  });

  it("isFrozenCapacityFixture：合法 true / 越界 false", () => {
    assert.equal(
      isFrozenCapacityFixture({
        noteChars: 50_000,
        keyPointsPerCard: 30,
        episodesPerSession: 5,
        starMapNodes: 5_000,
        concurrentSessions: 25,
      }),
      true,
    );
    assert.equal(
      isFrozenCapacityFixture({
        noteChars: 50_000,
        keyPointsPerCard: 30,
        episodesPerSession: 5,
        starMapNodes: 5_000,
        concurrentSessions: 26,
      }),
      false,
    );
  });
});

// ─── 2. 分位数 ────────────────────────────────────────────────────────────

describe("分位数计算（R7 线性插值）", () => {
  it("1..100 的 p95 = 95.05", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(computePercentile(values, 0.95), 95.05);
    assert.equal(computeP95(values), 95.05);
  });

  it("空数组返回 0；p0 = min；p100 = max", () => {
    assert.equal(computeP95([]), 0);
    const values = [3, 1, 2, 5, 4];
    assert.equal(computePercentile(values, 0), 1);
    assert.equal(computePercentile(values, 1), 5);
    assert.equal(computePercentile(values, 0.5), 3); // 中位数
  });

  it("同一输入恒得同一输出（确定性）", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(computeP95(values), computeP95([...values].reverse()));
  });
});

// ─── 3. 性能门限 ──────────────────────────────────────────────────────────

describe("性能门限（§16.5）", () => {
  it("action→帧 p95<100ms：通过 / 越限 / 样本不足", () => {
    // 100 个均匀 [1..100] 样本，p95=95.05 < 100 → 通过
    const passing = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepEqual(checkActionToFrameP95(passing), []);

    // p95 越限（95% 值 ≥ 100ms）
    const failing = Array.from({ length: 100 }, (_, i) => 100 + i);
    const violations = checkActionToFrameP95(failing);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /p95/);

    // 样本不足 100 → 违规（即使 p95 达标）
    const sparse = sampleN(20, 50);
    const sparseViolations = checkActionToFrameP95(sparse);
    assert.ok(sparseViolations.some((v) => /样本量/.test(v)));
    assert.equal(ACTION_TO_FRAME_P95_LIMIT_MS, 100);
  });

  it("scene→可交互 p95<300ms：通过 / 越限 / 恒定样本数据异常", () => {
    // 真实变化样本（100 个 ±5ms 抖动），p95 ≈ 285 < 300 → 通过
    const passing = Array.from({ length: 100 }, (_, i) => 270 + (i % 10));
    assert.deepEqual(checkSceneToInteractiveP95(passing), []);

    // 越限（真实变化样本，p95 > 300）
    const failing = Array.from({ length: 100 }, (_, i) => 305 + (i % 10));
    const violations = checkSceneToInteractiveP95(failing);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /p95/);
    assert.equal(SCENE_TO_INTERACTIVE_P95_LIMIT_MS, 300);

    // 恒定样本（零方差）→ 数据异常违规（security_review MEDIUM 修复）
    const constant = Array.from({ length: 100 }, () => 280);
    const constantViolations = checkSceneToInteractiveP95(constant);
    assert.ok(constantViolations.some((v) => /恒定值|非正值/.test(v)));
  });

  it("星图帧率 ≥ W0 基线：通过 / 低于基线 / 节点数非法 / 恒定样本数据异常", () => {
    // 每帧 14-17ms ≈ 59-71fps ≥ 50fps → 通过（1000 节点，真实变化样本）
    assert.deepEqual(checkStarMapFps(Array.from({ length: 100 }, (_, i) => 14 + (i % 4)), 1_000), []);

    // 每帧 25ms = 40fps < 50fps → 违规（变化样本）
    const violations = checkStarMapFps(Array.from({ length: 100 }, (_, i) => 23 + (i % 4)), 1_000);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /基线/);
    assert.equal(STAR_MAP_1000_NODES_MIN_FPS, 50);

    // 节点数不在冻结档位 → 违规
    const badNodes = checkStarMapFps(sampleN(16, 100), 7_000);
    assert.ok(badNodes.some((v) => /节点数/.test(v)));

    // 样本不足 → 违规
    const sparse = checkStarMapFps(sampleN(16, 50), 1_000);
    assert.ok(sparse.some((v) => /样本量/.test(v)));

    // 恒定样本 → 数据异常违规
    const constant = checkStarMapFps(Array.from({ length: 100 }, () => 16), 1_000);
    assert.ok(constant.some((v) => /恒定值|非正值/.test(v)));
  });

  it("移动端内存：绝对上限 + 相对基线增量", () => {
    // 绝对 250MB < 300MB，相对基线 200MB 增量 50MB < 80MB → 通过
    assert.deepEqual(checkMobileMemoryBudget(250, 200), []);

    // 绝对越限
    const abs = checkMobileMemoryBudget(350, 200);
    assert.ok(abs.some((v) => /绝对上限/.test(v)));
    assert.equal(MOBILE_MEMORY_BUDGET_MB, 300);

    // 相对增量越限
    const rel = checkMobileMemoryBudget(290, 200);
    assert.ok(rel.some((v) => /相对 W0 基线/.test(v)));
    assert.equal(SHELL_MOBILE_MEMORY_DELTA_BUDGET_MB, 80);

    // 同时越限 → 两条违规
    const both = checkMobileMemoryBudget(400, 200);
    assert.equal(both.length, 2);
  });

  it("Shell JS/渲染/路由 p95 相对 W0 基线增量", () => {
    // 增量 100ms < 200ms → 通过
    assert.deepEqual(checkShellP95Delta("shell_js_p95", 500, 600), []);
    assert.deepEqual(checkShellP95Delta("shell_render_p95", 300, 400), []);
    assert.deepEqual(checkShellP95Delta("shell_route_p95", 200, 350), []);

    // 增量越限
    const violations = checkShellP95Delta("shell_js_p95", 500, 800);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /shell_js_p95/);
    assert.equal(SHELL_P95_DELTA_BUDGET_MS, 200);

    // 负值样本 → 违规
    const neg = checkShellP95Delta("shell_route_p95", -1, 100);
    assert.ok(neg.some((v) => /负值/.test(v)));
  });
});

// ─── 4. 报告环境完整性（强制）────────────────────────────────────────────

describe("报告环境完整性（§16.5 采集要求，强制）", () => {
  it("完整合法环境 → 无违规", () => {
    assert.deepEqual(validatePerfReportEnv(validEnv()), []);
  });

  it("硬件 / 构建 / 网络 / 区间缺失 → 违规", () => {
    assert.ok(validatePerfReportEnv(validEnv({ hardware: "  " })).some((v) => /硬件/.test(v)));
    assert.ok(validatePerfReportEnv(validEnv({ build: "" })).some((v) => /构建/.test(v)));
    assert.ok(validatePerfReportEnv(validEnv({ network: "" })).some((v) => /网络/.test(v)));
    const noInterval = validatePerfReportEnv(validEnv({ interval: "mean 12ms" }));
    assert.ok(noInterval.some((v) => /p95/.test(v)));
  });

  it("浏览器必须为 Chrome stable", () => {
    assert.ok(
      validatePerfReportEnv(validEnv({ browser: "Safari 17" })).some((v) => /Chrome/.test(v)),
    );
    assert.ok(
      validatePerfReportEnv(validEnv({ browser: "Google Chrome 126 (canary)" })).some((v) =>
        /stable/.test(v),
      ),
    );
    assert.deepEqual(
      validatePerfReportEnv(validEnv({ browser: "Chrome 126.0 stable" })),
      [],
    );
  });

  it("fixture 必须命中冻结档位矩阵", () => {
    const env = validEnv({
      fixture: {
        noteChars: 7_000,
        keyPointsPerCard: 10,
        episodesPerSession: 3,
        starMapNodes: 1_000,
        concurrentSessions: 5,
      },
    });
    assert.ok(validatePerfReportEnv(env).some((v) => /noteChars/.test(v)));
  });

  it("样本量 < 100 → 违规；冷热路径必须分开", () => {
    assert.ok(
      validatePerfReportEnv(validEnv({ sampleCount: 99 })).some((v) => /样本量/.test(v)),
    );
    assert.deepEqual(validatePerfReportEnv(validEnv({ sampleCount: 100 })), []);
    for (const hotCold of ["mixed", "hot_only", "cold_only"] as const) {
      assert.ok(
        validatePerfReportEnv(validEnv({ hotCold })).some((v) => /冷热/.test(v)),
      );
    }
  });

  it("禁止开发机数据；禁止平均值替代 p95", () => {
    assert.ok(
      validatePerfReportEnv(validEnv({ dataSource: "dev_machine" })).some((v) =>
        /开发机/.test(v),
      ),
    );
    assert.ok(
      validatePerfReportEnv(validEnv({ aggregate: "mean" })).some((v) =>
        /平均值/.test(v),
      ),
    );
    assert.ok(
      validatePerfReportEnv(validEnv({ aggregate: "other" })).some((v) =>
        /平均值/.test(v),
      ),
    );
  });
});

// ─── 5. 汇总判定 ──────────────────────────────────────────────────────────

describe("evaluateCapacityPerf 汇总", () => {
  function passingInput(overrides: Partial<Parameters<typeof evaluateCapacityPerf>[0]> = {}) {
    return {
      env: validEnv(),
      actionToFrameMs: Array.from({ length: 100 }, (_, i) => i + 1), // p95≈95.05 < 100
      sceneToInteractiveMs: Array.from({ length: 100 }, (_, i) => 270 + (i % 10)), // 变化样本，p95<300
      starMapFrameMs: Array.from({ length: 100 }, (_, i) => 14 + (i % 4)), // 变化样本 ≈ 55-70fps ≥ 50
      starMapNodeCount: 1_000,
      mobileMemoryMb: 250,
      mobileMemoryBaselineMb: 200,
      shellDeltaBaselineP95Ms: 500,
      shellDeltaWithShellP95Ms: 600,
      ...overrides,
    };
  }

  it("全部满足 → allPassed=true，无任何违规", () => {
    const report = evaluateCapacityPerf(passingInput());
    assert.equal(report.version, CAPACITY_PERF_VERSION);
    assert.equal(report.fixturesTotal, 243);
    assert.equal(report.envValidated, true);
    assert.equal(report.allPassed, true);
    assert.deepEqual(report.envViolations, []);
    assert.deepEqual(report.memoryViolations, []);
    assert.deepEqual(report.shellDeltaViolations, []);
    assert.equal(report.scenarioGates.length, 3);
  });

  it("任一环境字段违规 → envValidated=false 且 allPassed=false", () => {
    const report = evaluateCapacityPerf(
      passingInput({ env: validEnv({ dataSource: "dev_machine" }) }),
    );
    assert.equal(report.envValidated, false);
    assert.equal(report.allPassed, false);
    assert.ok(report.envViolations.some((v) => /开发机/.test(v)));
  });

  it("action p95 越限 → 该场景 Gate 违规且 allPassed=false", () => {
    const report = evaluateCapacityPerf(
      passingInput({ actionToFrameMs: Array.from({ length: 100 }, (_, i) => 100 + i) }),
    );
    const gate = report.scenarioGates.find((g) => g.scenario === "action_to_frame");
    assert.ok(gate);
    assert.equal(gate.passed, false);
    assert.equal(report.allPassed, false);
  });

  it("星图帧率低于基线 → allPassed=false", () => {
    const report = evaluateCapacityPerf(passingInput({ starMapFrameMs: sampleN(25, 100) }));
    const gate = report.scenarioGates.find((g) => g.scenario === "star_map_fps");
    assert.ok(gate);
    assert.equal(gate.passed, false);
    assert.equal(report.allPassed, false);
  });

  it("内存越限 / Shell 相对预算越限 → allPassed=false", () => {
    const mem = evaluateCapacityPerf(passingInput({ mobileMemoryMb: 400 }));
    assert.ok(mem.memoryViolations.length >= 1);
    assert.equal(mem.allPassed, false);

    const shell = evaluateCapacityPerf(passingInput({ shellDeltaWithShellP95Ms: 900 }));
    assert.ok(shell.shellDeltaViolations.length >= 1);
    assert.equal(shell.allPassed, false);
  });

  it("省略内存/Shell 相对输入 → 对应 Gate 跳过且不阻塞", () => {
    const report = evaluateCapacityPerf({
      env: validEnv(),
      actionToFrameMs: Array.from({ length: 100 }, (_, i) => i + 1),
      sceneToInteractiveMs: Array.from({ length: 100 }, (_, i) => 270 + (i % 10)),
      starMapFrameMs: Array.from({ length: 100 }, (_, i) => 14 + (i % 4)),
      starMapNodeCount: 1_000,
      mobileMemoryMb: undefined,
      mobileMemoryBaselineMb: undefined,
      shellDeltaBaselineP95Ms: undefined,
      shellDeltaWithShellP95Ms: undefined,
    });
    assert.deepEqual(report.memoryViolations, []);
    assert.deepEqual(report.shellDeltaViolations, []);
    assert.equal(report.allPassed, true);
    assert.equal(MIN_SAMPLES_PER_SCENARIO, 100);
  });
});
