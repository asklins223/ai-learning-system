/**
 * 公共任务运行内核（D5 / 39d W3-1）。
 *
 * 一句话：**三块底座已经在了**（`jobs` 表与 SQL 侧的租约/重试、`job-lease.ts` 的断言、
 * `AIProvider` 的模型传输），缺的是中间那一层——任务定义、尝试与检查点的统一语义、
 * 两种执行模式的统一外壳。这个模块只补那一层，不重写已经对的东西。
 *
 * 三条形状上的硬约束（都是为了让"再写一套"变得不划算，而不是靠自觉）：
 *
 *   1. **`execute` 的签名里没有事务对象**（D5 §5.2 第一件）。短事务准备与短事务保存
 *      分在 `prepare`/`commit` 两头，中间那一段拿不到 `tx`——想持锁等模型**写不出来**。
 *      活动事务的运行时检测是 W3-2 的活儿，这里刻意不重复做。
 *   2. **模型预算与业务提交重试是两条轴**（D5 §2.2）。`commit` 失败**绝不**重跑
 *      `execute`：已经花掉的钱不再花一遍，已经拿到的有效结果不因为一次提交失败而丢弃。
 *   3. **完成条件是声明出来的**（D5 §2.3），不许"跑完就算完成"。未达成不提交。
 *
 * 数据库、队列、提示词都不在这个模块里——它只吃端口（ports），所以三类调用方
 * （生成/检查、开放回答评估、伴星对话）能各自接自己的 `jobs` 行与业务写入，
 * **共用逻辑而不串同一队列**（D5 §3 第 2 条：作答反馈不能被批量制卡耗尽）。
 */

import { assertOutsideWorkspaceTransaction } from "./workspace-transaction.ts";

/** 两种执行模式（D5 §3）。工具循环本身在 provider 层已经存在，内核只管一"步"的边界。 */
export type AiTaskMode = "structured" | "tool_loop";

/**
 * 完成判据（D5 §2.3）。`custom` 给的是**有界**判据（例如"至少一张候选通过程序校验"），
 * 不是"随便什么时候算完"。
 */
export type AiTaskCompletion<TOutput> =
  | { readonly kind: "structured_parsed" }
  | { readonly kind: "tool_loop_settled" }
  | {
      readonly kind: "custom";
      readonly satisfied: (output: TOutput) => boolean;
      /** 未达成时给用户看的那一句的类别，不能让上层自己编（同一个读数只许一个来源）。 */
      readonly unmetReason: string;
    };

/**
 * 模型侧预算（D5 §2.2 的第一条轴）。
 *
 * `maxAutoRetries` 是**每个模型步骤**的自动重试上限。首期定 **1**（39c §8）：
 * 结构修复就占这一次机会，不另开修复循环；权限、内容版本、无效输入、实质质量问题
 * 根本不重试（见 `AI_TASK_RETRYABLE_FAILURE_CLASSES`）。
 */
export interface AiTaskBudget {
  readonly maxModelCalls: number;
  readonly stepTimeoutMs: number;
  readonly taskDeadlineMs: number;
  readonly maxAutoRetries: number;
}

/** 失败类别。**这张表就是"什么值得再花一次钱"的唯一答案**。 */
export type AiTaskFailureClass =
  | "transport"
  | "timeout"
  | "output_shape"
  | "permission"
  | "content_version"
  | "invalid_input"
  | "quality"
  | "lease_lost"
  | "cancelled"
  | "submission_failed";

export const AI_TASK_RETRYABLE_FAILURE_CLASSES: ReadonlySet<AiTaskFailureClass> = new Set([
  "transport",
  "timeout",
  "output_shape",
]);

/**
 * 「资源限制」与「用户能力不足」必须是两类话（39 §6.2）。
 *
 * 预算触顶时内核给出的不是"失败了"，而是"保留已完成的部分，稍后再试或结束"——
 * 上层拿这个类别去决定屏幕上怎么说。
 */
export type AiTaskOutcome =
  | "committed"
  | "resumed_and_committed"
  | "completion_unmet"
  | "budget_exhausted"
  | "cancelled"
  | "failed";

export interface AiTaskUsage {
  /** 真正发出去的模型调用次数（检查点命中时为 0）。 */
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
  readonly autoRetriesUsed: number;
}

/** 一次尝试的身份（D5 §4.1）。`leaseToken` 复用 `jobs.lease_token` 的形状。 */
export interface AiAttemptToken {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly userId: string | null;
}

/** 上下文只带**引用**，不带正文（D5 §2.1，防上下文膨胀成第二个事实源）。 */
export interface AiTaskContext {
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly inputSnapshotRef: {
    /**
     * `audio` 是语音转写带出来的第四个取值：它的输入快照就是上传的那段字节本身
     * （转写成功之后才有 artifact 行，所以不能拿 `artifact` 冒充——那会写进一个
     * 当时并不存在的行 id）。
     */
    readonly kind: "note_version" | "artifact" | "task" | "audio";
    readonly id: string;
    readonly hash: string;
  };
  readonly permissionLevel: string;
  readonly signal?: AbortSignal;
}

/** `execute` 能拿到的全部环境——**没有事务对象**。 */
export interface AiTaskEnvironment {
  readonly mode: AiTaskMode;
  readonly usageContext: {
    readonly modelId: string;
    readonly promptVersion: string;
    readonly resourceClass: string;
  };
  /** 本步还剩多少毫秒（整任务 deadline 减去已用时）；<=0 时内核不再起新尝试。 */
  readonly remainingMs: number;
  readonly stepTimeoutMs: number;
  /** 第几次自动重试（0 = 首次）。 */
  readonly retryIndex: number;
  readonly signal: AbortSignal;
}

export interface AiStepSuccess<TOutput> {
  readonly ok: true;
  readonly output: TOutput;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface AiStepFailure {
  readonly ok: false;
  readonly class: AiTaskFailureClass;
  readonly message: string;
}

export type AiStepResult<TOutput> = AiStepSuccess<TOutput> | AiStepFailure;

/**
 * 检查点键（D5 §4.2）：**三条全同**才许复用——任务身份、任务版本、输入快照哈希。
 *
 * 换提示词或换输出合同（`taskVersion` 变了）就**既不默默重跑已完成步骤，也不默默
 * 复用旧产物**（39c §8 那一句话的两面）。不做跨用户复用：键里带 workspace/user。
 */
export interface AiCheckpointKey {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly inputSnapshotHash: string;
  readonly workspaceId: string;
  readonly userId: string | null;
}

export interface AiCheckpointEntry<TOutput> {
  readonly output: TOutput;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * 检查点的**物理形状留给 W3-3**（D5 §8：新表还是复用 `jobs.payload`，要看竖向样例
 * 的真实读写形状）。所以内核只吃这个端口，不建表。
 */
export interface AiTaskCheckpointPort<TOutput> {
  load(key: AiCheckpointKey): Promise<AiCheckpointEntry<TOutput> | null>;
  save(key: AiCheckpointKey, entry: AiCheckpointEntry<TOutput>): Promise<void>;
}

/**
 * 任务定义（D5 §2）。`id` + `version` 会进检查点键与尝试记录，是稳定标识。
 *
 * `resourceClass` 用 `JobResourceClass` 已有的五档之一（`interactive_ai`／
 * `card_foreground`／`card_map`／`vision`／`maintenance`）——D5 §8 留给 W3-1 的
 * "取值"这一项的答案是**不新造值**：`ailearn_claim_jobs(interactiveLimit, backgroundLimit)`
 * 早就按 `interactive_ai` 与其余分名额，作答反馈与批量制卡的隔离靠的就是它。
 */
export interface AiTaskDefinition<TInput, TOutput> {
  readonly id: string;
  readonly version: number;
  readonly mode: AiTaskMode;
  readonly resourceClass: string;
  readonly budget: AiTaskBudget;
  readonly completion: AiTaskCompletion<TOutput>;
  readonly usageContext: AiTaskEnvironment["usageContext"];

  /** 短事务准备：校验权限与业务版本、冻结输入、领尝试。返回的东西才是 `execute` 能读的。 */
  prepare(ctx: AiTaskContext, attempt: AiAttemptToken): Promise<TInput>;
  /** 事务外执行。签名里没有 tx——这是类型，不是纪律。 */
  execute(input: TInput, env: AiTaskEnvironment): Promise<AiStepResult<TOutput>>;
  /** 短事务保存：核对身份/租约/取消/输入版本，写不可变产物与下一步投递。 */
  commit(
    ctx: AiTaskContext,
    attempt: AiAttemptToken,
    output: TOutput,
  ): Promise<AiTaskReceipt<TOutput>>;
}

export interface AiTaskReceipt<TOutput> {
  readonly outcome: AiTaskOutcome;
  readonly output: TOutput | null;
  readonly usage: AiTaskUsage;
  /** 失败/未达成时的类别与说明；`committed` 时为 null。 */
  readonly failure: AiStepFailure | null;
  /** 预算触顶但已拿到有效结果时，这些结果**保留**（D5 §2.2：不因模型预算丢弃有效结果）。 */
  readonly preservedValidResult: boolean;
  readonly resumedFromCheckpoint: boolean;
  readonly modelCalls: number;
}

export interface RunAiTaskOptions<TOutput> {
  readonly ctx: AiTaskContext;
  readonly attempt: AiAttemptToken;
  /**
   * 「当前作用域有没有活动事务」这一个读数。**必填**：把它做成可选，就等于让
   * "忘记核对"成为一种可以通过的形状。worker 侧传 `currentWorkerWorkspaceTransaction`，
   * API 侧传它那一份 scope 的 `current()`；纯函数级用例传 `() => undefined`。
   */
  readonly currentActiveTransaction: () => unknown;
  /** 被拒时怎么记一条开发错误（各进程接自己的 logger）。 */
  readonly reportDevelopmentError?: (message: string) => void;
  /**
   * 提交前核对这一次尝试是否还作数（接线到 `assertJobLease`／`lockJobLease`）。
   * D5 §4.1：租约已换 ⇒ **旧尝试的输出不许提交**。缺这个端口就等于不核对。
   */
  readonly verifyAttempt?: (attempt: AiAttemptToken) => Promise<boolean>;
  readonly checkpoint?: AiTaskCheckpointPort<TOutput>;
  readonly now?: () => number;
}

/** `output_shape` 之外的错误由调用方自己分类；这里给一个把异常变成分类结果的收口。 */
export function classifyThrownAsStepFailure(err: unknown): AiStepFailure {
  const message = describeThrown(err);
  if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.name))) {
    return { ok: false, class: "cancelled", message };
  }
  // ETIMEDOUT 是 Node 真实抛出的那一型（不是 "timeout" 这个词），漏认它就会把一次网络超时
  // 归成 transport——两者都可重试，但台账里"为什么重跑"就记错了。
  if (/timeout|timed out|deadline|etimedout/i.test(message)) return { ok: false, class: "timeout", message };
  if (/lease/i.test(message)) return { ok: false, class: "lease_lost", message };
  return { ok: false, class: "transport", message };
}

/**
 * drizzle 会把驱动错误包成 `Failed query: …`，**真因在 `cause` 上**：只看
 * `err.message` 就等于把"枚举取值不合法"和"网络断了"报成同一类（两者都只
 * 显示 `Failed query:`，而两者的可重试性完全相反）。沿 cause 链拼（限深，
 * 防自引用图）才有能分类的东西可看。
 */
function describeThrown(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const text = current instanceof Error ? `${current.name}: ${current.message}` : String(current);
    if (!parts.includes(text)) parts.push(text);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return parts.join(" ← ");
}

/**
 * 给一次调用套上**单步超时**与**取消信号**。超时算 `timeout`（可重试那三类之一）。
 *
 * 这里是 **race**，不是"只把 abort 信号传下去"：后者等于把纪律交给别人守——
 * 一个不看 signal 的实现（漏传、或者卡在同步循环里）会把整任务拖过它的 deadline，
 * 而 deadline 是内核承诺给调用方的东西。输掉的那一路仍然在跑（JS 取消不了 promise），
 * 但它再也提交不出去：`commit` 前面有尝试身份核对（D5 §4.1）。
 *
 * 不在这里做"锁内退避"——超时到点只是让调用方立刻拿到结果，重试由外层按预算决定。
 */
async function withStepDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
  stepTimeoutMs: number,
  remainingMs: number,
): Promise<{ ok: true; value: T } | { ok: false; failure: AiStepFailure }> {
  const budget = Math.min(stepTimeoutMs, remainingMs);
  const signals: AbortSignal[] = [outer];
  if (budget > 0) signals.push(AbortSignal.timeout(budget));
  const signal = AbortSignal.any(signals);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed out">((resolve) => {
    timer = setTimeout(() => resolve("timed out"), Math.max(budget, 0));
  });
  try {
    const value = await Promise.race([run(signal), deadline]);
    if (value === "timed out") {
      return { ok: false, failure: { ok: false, class: "timeout", message: `step exceeded ${budget}ms` } };
    }
    return { ok: true, value };
  } catch (err) {
    const failure = classifyThrownAsStepFailure(err);
    // 调用方自己按下去的取消，和这一步超时，是两件事——前者不许重试。
    if (outer.aborted) return { ok: false, failure: { ok: false, class: "cancelled", message: failure.message } };
    if (Date.now() - started >= budget) {
      return { ok: false, failure: { ok: false, class: "timeout", message: `step exceeded ${budget}ms` } };
    }
    return { ok: false, failure };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isSettled<T>(result: AiStepResult<T>): result is AiStepSuccess<T> {
  return result.ok === true;
}

/**
 * 跑一个任务定义。**这个函数就是两类模式共用的那一层外壳**，它做的事全部是
 * "什么时候允许再花一次钱、什么时候不许提交"，不碰任何业务语义。
 */
export async function runAiTask<TInput, TOutput>(
  definition: AiTaskDefinition<TInput, TOutput>,
  options: RunAiTaskOptions<TOutput>,
): Promise<AiTaskReceipt<TOutput>> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const outerSignal = options.ctx.signal ?? new AbortController().signal;
  const usage: { modelCalls: number; promptTokens: number; completionTokens: number; autoRetriesUsed: number } = {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    autoRetriesUsed: 0,
  };
  const receipt = (
    outcome: AiTaskOutcome,
    output: TOutput | null,
    failure: AiStepFailure | null,
    extra: { preserved?: boolean; resumed?: boolean } = {},
  ): AiTaskReceipt<TOutput> => ({
    outcome,
    output,
    usage: {
      modelCalls: usage.modelCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      elapsedMs: now() - startedAt,
      autoRetriesUsed: usage.autoRetriesUsed,
    },
    failure,
    preservedValidResult: extra.preserved ?? false,
    resumedFromCheckpoint: extra.resumed ?? false,
    modelCalls: usage.modelCalls,
  });

  const input = await definition.prepare(options.ctx, options.attempt);

  // ── 检查点：命中就不重付已完成的模型步骤（D5 §4.3 "生成已保存、检查未开始" 那一行）──
  const checkpointKey: AiCheckpointKey = {
    taskId: definition.id,
    taskVersion: definition.version,
    inputSnapshotHash: options.ctx.inputSnapshotRef.hash,
    workspaceId: options.ctx.workspaceId,
    userId: options.ctx.userId,
  };
  /**
   * "已经拿到可提交的结果"这件事只有一个表示法：`{ output, resumed }`。
   * 用 null 当"还没有"会让提交那一头收到 `TOutput | null`，而 `commit` 的合同是
   * **只提交得出去的结果**——所以这里刻意不出现"大概是 null 吧"的那种收窄。
   */
  let settled: { output: TOutput; resumed: boolean } | null = null;
  if (options.checkpoint) {
    const hit = await options.checkpoint.load(checkpointKey);
    if (hit) {
      settled = { output: hit.output, resumed: true };
      usage.promptTokens += hit.promptTokens;
      usage.completionTokens += hit.completionTokens;
    }
  }

  if (!settled) {
    let lastFailure: AiStepFailure | null = null;
    // 首次 + 至多 maxAutoRetries 次自动重试；每步一次的额度**同时**是结构修复的额度。
    const maxAttempts = 1 + definition.budget.maxAutoRetries;
    for (let step = 0; step < maxAttempts; step += 1) {
      if (outerSignal.aborted) return receipt("cancelled", null, { ok: false, class: "cancelled", message: "aborted before model call" });
      const elapsedMs = now() - startedAt;
      const remainingMs = definition.budget.taskDeadlineMs - elapsedMs;
      if (remainingMs <= 0) {
        return receipt("budget_exhausted", null, { ok: false, class: "timeout", message: "task deadline reached before step" });
      }
      if (usage.modelCalls >= definition.budget.maxModelCalls) {
        return receipt("budget_exhausted", null, { ok: false, class: "timeout", message: "model call budget reached" });
      }
      // 发外部调用**之前**再核一次作用域（D5 §5.2 第二件）。类型上 `execute` 拿不到 tx，
      // 但闭包能偷到——这一个读数挡的就是偷的那种。
      assertOutsideWorkspaceTransaction({
        boundary: `AI 任务 ${definition.id} 的模型调用`,
        caller: `${definition.id}@v${definition.version}`,
        activeTransaction: options.currentActiveTransaction(),
        reportDevelopmentError: options.reportDevelopmentError,
      });
      usage.modelCalls += 1;
      const stepped = await withStepDeadline(
        (signal) => definition.execute(input, {
          mode: definition.mode,
          usageContext: definition.usageContext,
          remainingMs,
          stepTimeoutMs: definition.budget.stepTimeoutMs,
          retryIndex: step,
          signal,
        }),
        outerSignal,
        definition.budget.stepTimeoutMs,
        remainingMs,
      );
      if (!stepped.ok) {
        lastFailure = stepped.failure;
        if (stepped.failure.class === "cancelled") return receipt("cancelled", null, stepped.failure);
        if (!AI_TASK_RETRYABLE_FAILURE_CLASSES.has(stepped.failure.class)) {
          // 权限／内容版本／无效输入／实质质量：**不自动重试**（D5 §2.2）。
          return receipt("failed", null, stepped.failure);
        }
        usage.autoRetriesUsed += 1;
        continue;
      }
      const result = stepped.value;
      if (!isSettled(result)) {
        lastFailure = result;
        // 调用在**执行内部**被取消（provider 看着 signal 停的）与"这一步没做好"是两件事：
        // 前者不许重试，也不许被报成失败——用户按的是停止，不是重试。
        if (result.class === "cancelled") return receipt("cancelled", null, result);
        if (!AI_TASK_RETRYABLE_FAILURE_CLASSES.has(result.class)) return receipt("failed", null, result);
        usage.autoRetriesUsed += 1;
        continue;
      }
      settled = { output: result.output, resumed: false };
      usage.promptTokens += result.promptTokens ?? 0;
      usage.completionTokens += result.completionTokens ?? 0;
      lastFailure = null;
      break;
    }
    if (!settled) {
      const failure = lastFailure ?? { ok: false as const, class: "transport" as const, message: "no result" };
      return receipt(failure.class === "cancelled" ? "cancelled" : "failed", null, failure);
    }
  }

  const output = settled.output;
  const resumedFromCheckpoint = settled.resumed;

  // ── 完成判据：没达成就不提交 ────────────────────────────────────────────
  if (definition.completion.kind === "custom") {
    if (!definition.completion.satisfied(output)) {
      return receipt("completion_unmet", output, { ok: false, class: "quality", message: definition.completion.unmetReason }, { preserved: true, resumed: resumedFromCheckpoint });
    }
  }

  if (outerSignal.aborted) {
    return receipt("cancelled", output, { ok: false, class: "cancelled", message: "aborted before commit" }, { preserved: true, resumed: resumedFromCheckpoint });
  }

  // ── 旧尝试不许提交（D5 §4.1 的租约那一行）────────────────────────────────
  if (options.verifyAttempt && !(await options.verifyAttempt(options.attempt))) {
    return receipt("failed", output, { ok: false, class: "lease_lost", message: "attempt no longer owns its lease; output not committed" }, { preserved: true, resumed: resumedFromCheckpoint });
  }

  let committed: AiTaskReceipt<TOutput>;
  try {
    committed = await definition.commit(options.ctx, options.attempt, output);
  } catch (err) {
    // **第二条轴**：业务提交失败不回头重跑模型（已经花掉的钱不再花一遍）。
    // 有效结果留在 `output` 里，回执说"结果已拿到、提交待重试"。
    const failure = classifyThrownAsStepFailure(err);
    return receipt("failed", output, {
      ok: false,
      class: "submission_failed",
      message: `${failure.class}: ${failure.message}`,
    }, { preserved: true, resumed: resumedFromCheckpoint });
  }

  // 命中检查点的那一次**不再回写**：刚读出来的东西再存一遍是纯写放大，
  // 还会让"这条检查点是几点写的"失去意义（它标记的是那次生成，不是这次读取）。
  if (options.checkpoint && !resumedFromCheckpoint && committed.outcome === "committed") {
    await options.checkpoint.save(checkpointKey, {
      output,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
  }
  return {
    ...committed,
    usage: {
      modelCalls: usage.modelCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      elapsedMs: now() - startedAt,
      autoRetriesUsed: usage.autoRetriesUsed,
    },
    outcome: committed.outcome === "committed" && resumedFromCheckpoint ? "resumed_and_committed" : committed.outcome,
    resumedFromCheckpoint,
    modelCalls: usage.modelCalls,
  };
}
