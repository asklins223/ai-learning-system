/**
 * 公共任务运行内核的用例（D5 / 39d W3-1）。
 *
 * 这一组用例的形状就是 D5 §4.3 那张恢复表：**每一行都对应"半途出事时到底付不付第二次钱、
 * 提不提得出去"**。所以断言几乎全部落在**调用次数**与**谁没被调用**上，而不是返回值好不好看：
 * 一次多余的重跑是真金白银，一次本该被拒的提交是脏数据。
 *
 * 全部不碰 DB、不碰模型：内核只吃端口，所以这些判据是确定性的。真租约那一头在
 * `ai-task-kernel-postgres.integration.ts`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_TASK_RETRYABLE_FAILURE_CLASSES,
  classifyThrownAsStepFailure,
  runAiTask,
  type AiAttemptToken,
  type AiStepResult,
  type AiTaskCheckpointPort,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskFailureClass,
  type AiTaskReceipt,
} from "./ai-task-kernel.ts";
import { ExternalCallInsideTransactionError } from "./workspace-transaction.ts";

/** 纯函数层的"我现在不在任何事务里"。真实接线见集测那份（读的是 worker 的 AsyncLocalStorage）。 */
const NO_TX = () => undefined;

const BASE_BUDGET = {
  maxModelCalls: 4,
  stepTimeoutMs: 1_000,
  taskDeadlineMs: 5_000,
  maxAutoRetries: 1,
};

function ctx(overrides: Partial<AiTaskContext> = {}): AiTaskContext {
  return {
    workspaceId: "ws-1",
    userId: "u-1",
    inputSnapshotRef: { kind: "task", id: "t-1", hash: "sha-input-1" },
    permissionLevel: "guided",
    ...overrides,
  };
}

function attempt(overrides: Partial<AiAttemptToken> = {}): AiAttemptToken {
  return {
    taskId: "task-1",
    taskVersion: 3,
    attemptId: "a-1",
    leaseToken: "lease-1",
    idempotencyKey: "idem-1",
    workspaceId: "ws-1",
    userId: "u-1",
    ...overrides,
  };
}

interface Harness {
  definition: AiTaskDefinition<string, string>;
  prepareCalls: number;
  executeCalls: number;
  commitCalls: number;
  envs: Array<{ retryIndex: number; remainingMs: number; stepTimeoutMs: number }>;
  committedOutputs: string[];
}

/**
 * 造一个任务定义：`script` 是每一步的答复（用完最后一条就重复它），
 * 这样"重试了几次"直接等于 `executeCalls`。
 */
function harness(
  script: Array<AiStepResult<string> | Error>,
  overrides: Partial<AiTaskDefinition<string, string>> = {},
): Harness {
  const h: Harness = {
    prepareCalls: 0,
    executeCalls: 0,
    commitCalls: 0,
    envs: [],
    committedOutputs: [],
    definition: null as unknown as AiTaskDefinition<string, string>,
  };
  const definition: AiTaskDefinition<string, string> = {
    id: "task-1",
    version: 3,
    mode: "structured",
    resourceClass: "interactive_ai",
    budget: BASE_BUDGET,
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: "m", promptVersion: "p", resourceClass: "interactive_ai" },
    prepare: async () => {
      h.prepareCalls += 1;
      return "input";
    },
    execute: async (_input, env) => {
      const index = Math.min(h.executeCalls, script.length - 1);
      h.executeCalls += 1;
      h.envs.push({ retryIndex: env.retryIndex, remainingMs: env.remainingMs, stepTimeoutMs: env.stepTimeoutMs });
      const next = script[index];
      if (next instanceof Error) throw next;
      return next;
    },
    commit: async (_c, _a, output) => {
      h.commitCalls += 1;
      h.committedOutputs.push(output);
      return {
        outcome: "committed",
        output,
        usage: { modelCalls: h.executeCalls, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
        failure: null,
        preservedValidResult: false,
        resumedFromCheckpoint: false,
        modelCalls: h.executeCalls,
      } satisfies AiTaskReceipt<string>;
    },
    ...overrides,
  };
  h.definition = definition;
  return h;
}

const ok = (output: string): AiStepResult<string> => ({
  ok: true, output, promptTokens: 11, completionTokens: 7,
});
const fail = (class_: AiTaskFailureClass): AiStepResult<string> => ({
  ok: false, class: class_, message: `boom:${class_}`,
});

test("三段各一次、顺序是 prepare→execute→commit：这就是外壳的全部承诺", async () => {
  const h = harness([ok("产物 A")]);
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(receipt.outcome, "committed");
  assert.equal(receipt.output, "产物 A");
  assert.deepEqual([h.prepareCalls, h.executeCalls, h.commitCalls], [1, 1, 1]);
  assert.equal(receipt.usage.modelCalls, 1);
  // token 是从 execute 的答复里累出来的，不是 provider 自己填的数（一处一个来源）。
  assert.equal(receipt.usage.promptTokens, 11);
  assert.equal(receipt.usage.completionTokens, 7);
});

test("结构解析失败只给一次机会：重跑恰好一次，不另开修复循环", async () => {
  const h = harness([fail("output_shape"), ok("第二次修好了")]);
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(h.executeCalls, 2, "output_shape 可重试，但只许一次");
  assert.equal(receipt.usage.autoRetriesUsed, 1);
  assert.equal(receipt.outcome, "committed");
  assert.equal(h.commitCalls, 1);
});

test("一直坏就停在两次：第三次没有发生（额度不会被「结构修复」另开一格）", async () => {
  const h = harness([fail("output_shape")]);
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(h.executeCalls, 2);
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "output_shape");
  assert.equal(h.commitCalls, 0, "没有有效结果时不许提交");
});

test("权限／内容版本／无效输入／实质质量：一次都不自动重试", async () => {
  for (const class_ of ["permission", "content_version", "invalid_input", "quality"] as const) {
    assert.equal(AI_TASK_RETRYABLE_FAILURE_CLASSES.has(class_), false, `${class_} 不在可重试集合里`);
    const h = harness([fail(class_), ok("如果重试就会用它")]);
    const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
    assert.equal(h.executeCalls, 1, `${class_} 被自动重试了`);
    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.failure?.class, class_);
    assert.equal(h.commitCalls, 0);
  }
});

test("两条轴分开：提交失败绝不重跑模型，有效结果原样保留", async () => {
  const h = harness([ok("已经花过钱的结果")]);
  h.definition.commit = async () => {
    throw new Error("db write rejected");
  };
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(h.executeCalls, 1, "提交失败回头又调了一次模型——这条就是 39c §8 点名的浪费");
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "submission_failed");
  assert.equal(receipt.output, "已经花过钱的结果", "不因一次提交失败丢弃已拿到的有效结果");
  assert.equal(receipt.preservedValidResult, true);
});

test("检查点命中：一次模型都不调，但业务提交照做", async () => {
  const h = harness([ok("不该被调用")]);
  const seen: string[] = [];
  const checkpoint: AiTaskCheckpointPort<string> = {
    load: async (key) => {
      seen.push(`${key.taskId}/${key.taskVersion}/${key.inputSnapshotHash}/${key.workspaceId}/${key.userId}`);
      return { output: "上次已经生成好了", promptTokens: 40, completionTokens: 9 };
    },
    save: async () => { throw new Error("命中时不该再存"); },
  };
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX, checkpoint });
  assert.equal(h.executeCalls, 0);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.resumedFromCheckpoint, true);
  assert.equal(receipt.outcome, "resumed_and_committed");
  assert.equal(h.commitCalls, 1, "复用检查点不等于跳过业务提交");
  // 匹配判据三条全在里面（D5 §4.2）：任务身份、任务版本、输入快照哈希，外加归属。
  assert.deepEqual(seen, ["task-1/3/sha-input-1/ws-1/u-1"]);
});

test("换了任务版本或输入哈希就不会默默复用：键由调用方去比，键里两样都带着", async () => {
  const asked: string[] = [];
  const store = new Map<string, { output: string; promptTokens: number; completionTokens: number }>();
  store.set("task-1|2|sha-input-1|ws-1|u-1", { output: "旧提示词的产物", promptTokens: 1, completionTokens: 1 });
  const checkpoint: AiTaskCheckpointPort<string> = {
    load: async (key) => {
      const id = `${key.taskId}|${key.taskVersion}|${key.inputSnapshotHash}|${key.workspaceId}|${key.userId}`;
      asked.push(id);
      return store.get(id) ?? null;
    },
    save: async () => undefined,
  };
  const h = harness([ok("新提示词的产物")]);
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX, checkpoint });
  assert.equal(h.executeCalls, 1, "版本不同却命中了旧检查点＝默默复用");
  assert.deepEqual(asked, ["task-1|3|sha-input-1|ws-1|u-1"]);
  assert.equal(receipt.output, "新提示词的产物");
});

test("旧尝试不许提交：结果留在回执里，写入没有发生", async () => {
  const h = harness([ok("晚到的旧结果")]);
  const receipt = await runAiTask(h.definition, {
    ctx: ctx(),
    attempt: attempt({ leaseToken: "lease-stale" }), currentActiveTransaction: NO_TX,
    verifyAttempt: async () => false,
  });
  assert.equal(h.commitCalls, 0, "租约已换还想提交＝往新尝试的结果上盖旧数据");
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "lease_lost");
  assert.equal(receipt.output, "晚到的旧结果", "拒收不等于销毁：钱已经花过了");
  assert.equal(receipt.preservedValidResult, true);
});

test("用户取消：提交前的取消不提、已提交的不撤", async () => {
  const before = harness([ok("结果")]);
  const controller = new AbortController();
  controller.abort();
  const receiptBefore = await runAiTask(before.definition, { ctx: ctx({ signal: controller.signal }), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(receiptBefore.outcome, "cancelled");
  assert.equal(before.executeCalls, 0, "已经取消了还去调模型");
  assert.equal(before.commitCalls, 0);

  // 取消落在 commit 之内：动作已经落地，回执必须是 committed（39b §5 末段——
  // 对话取消不默认撤销已经提交成功的业务动作）。
  const after = harness([ok("结果")]);
  const mid = new AbortController();
  after.definition.commit = async (_c, _a, output) => {
    mid.abort();
    return {
      outcome: "committed", output,
      usage: { modelCalls: 1, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
      failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 1,
    };
  };
  const receiptAfter = await runAiTask(after.definition, { ctx: ctx({ signal: mid.signal }), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(receiptAfter.outcome, "committed");
});

test("取消不参与自动重试：它不是「这一步没做好」", async () => {
  const h = harness([{ ok: false, class: "cancelled", message: "aborted mid-call" }, ok("第二次")]);
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(h.executeCalls, 1);
  assert.equal(receipt.outcome, "cancelled");
});

test("完成条件未达成：不提交，但结果保留（「跑完」不等于「完成」）", async () => {
  // 判据与答复要**真的对不上**：上一版这里写的是"一张都没过校验"配
  // `output.includes("过校验")`——子串恰好命中，条件其实满足了，用例红在
  // "为什么提交了"上。判据自己骗自己时，红的会是断言而不是产品。
  const h = harness([ok("FAIL 没有任何候选通过程序校验")], {
    completion: { kind: "custom", satisfied: (output) => output.startsWith("PASS"), unmetReason: "没有候选通过程序校验" },
  });
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(h.commitCalls, 0);
  assert.equal(receipt.outcome, "completion_unmet");
  assert.equal(receipt.failure?.message, "没有候选通过程序校验");
  assert.equal(receipt.preservedValidResult, true);
});

test("模型调用额度用满：报的是「稍后再试」那一类，不是「做不到」", async () => {
  const h = harness([fail("transport"), fail("transport")], {
    budget: { ...BASE_BUDGET, maxModelCalls: 1 },
  });
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  assert.equal(h.executeCalls, 1);
  assert.equal(receipt.outcome, "budget_exhausted");
  assert.notEqual(receipt.failure?.class, "quality", "资源限制不许被说成用户能力不足（39 §6.2）");
});

test("单步超时：不合作的实现也拖不过 deadline（超时是 race，不是只发个信号）", async () => {
  const started = Date.now();
  const h = harness([], {
    budget: { ...BASE_BUDGET, stepTimeoutMs: 30, taskDeadlineMs: 500, maxAutoRetries: 0 },
    execute: async () => {
      h.executeCalls += 1;
      // 故意不看 signal：真实世界里"漏传 abort"就长这样。
      await new Promise((resolve) => setTimeout(resolve, 400));
      return ok("太晚了");
    },
  });
  const receipt = await runAiTask(h.definition, { ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX });
  const waited = Date.now() - started;
  assert.ok(waited < 200, `等了 ${waited}ms，单步超时没兜住`);
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "timeout");
});

test("整任务 deadline 到点不起新步：第二次尝试不会开始", async () => {
  let clock = 0;
  const h = harness([fail("transport"), ok("会成功，但不该再花一次钱")], {
    budget: { ...BASE_BUDGET, taskDeadlineMs: 100 },
  });
  const receipt = await runAiTask(h.definition, {
    ctx: ctx(), attempt: attempt(), currentActiveTransaction: NO_TX, now: () => (clock += 90),
  });
  assert.equal(h.executeCalls, 1);
  assert.equal(receipt.outcome, "budget_exhausted");
});

test("异常也能分类：超时字样算 timeout、租约字样算 lease_lost、其余算 transport", () => {
  assert.equal(classifyThrownAsStepFailure(new Error("gateway timeout after 30s")).class, "timeout");
  assert.equal(classifyThrownAsStepFailure(new Error("job lease is no longer active")).class, "lease_lost");
  assert.equal(classifyThrownAsStepFailure(new Error("ECONNRESET")).class, "transport");
  assert.equal(classifyThrownAsStepFailure("字符串也能进来").class, "transport");
});

test("外部调用边界：活动事务里跑内核 ⇒ 当场拒绝，一次模型都不发", async () => {
  // 类型上 `execute` 拿不到事务对象，但闭包能偷到——这一个读数挡的就是偷的那种
  // （D5 §5.2 第二件）。这里给的是"有活动事务"的返回值；真实作用域那一头见集测。
  const reported: string[] = [];
  const h = harness([ok("不该发生的调用")]);
  await assert.rejects(() => runAiTask(h.definition, {
    ctx: ctx(),
    attempt: attempt(),
    currentActiveTransaction: () => ({ context: {}, transaction: {}, open: true }),
    reportDevelopmentError: (message) => reported.push(message),
  }), ExternalCallInsideTransactionError);
  assert.equal(h.executeCalls, 0, "被拒之后还去调模型＝这道闸只是装饰");
  assert.equal(h.commitCalls, 0);
  assert.equal(reported.length, 1, "拒绝了却没记开发错误＝下一轮没人知道是谁");
  assert.match(reported[0], /task-1@v3/);
  assert.match(reported[0], /短事务准备/);
});
