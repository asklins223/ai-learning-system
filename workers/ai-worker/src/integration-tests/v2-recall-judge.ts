/**
 * 语义**目标覆盖**判据（修 `criticalRecall` 的词面不可用问题）。
 *
 * 背景（用真实数据证明的结论）：`scoreFixtureDeterministic` 的 `hitObjective` 是词面判据
 * （前 10 字 / 共享 ≥8 字 / Dice ≥0.35）。在 dev 语料上校准阈值时发现**两个分布重叠**：
 *   - 已知"同一目标、措辞不同"的对：Dice 0–0.157，最长公共子串 ≤5
 *   - 已知**无关**的对（495 对）：Dice 0–0.311，最长公共子串 ≤5
 * 无关对的词面相似度可以高于同一目标对——因为 gold 是抽象表述（"按顺序说出前向、损失、
 * 反向、优化"），卡片是具体改写。**任何词面阈值都分不开这两类**，所以
 * `criticalRecall` 这个指标本身不成立：它既漏判改写，也会误判无关。
 *
 * 因此这里用**语义判据**：把"笔记 + gold 目标清单 + 交付的卡片目标清单"交给同一个
 * provider，让它逐目标判断"是否被某张卡覆盖（语义等价或该卡是其子集/超集）"，
 * 并要求给出覆盖它的卡片下标与理由。判据只用于**评测**，不参与线上门禁
 * （§23.3：Judge 不能代替 Grounding hard gate）。
 *
 * 用法（离线，不重跑管线；读已有评测 JSON）：
 *   node --import ./workers/ai-worker/node_modules/tsx/dist/loader.mjs \
 *     workers/ai-worker/src/integration-tests/v2-recall-judge.ts \
 *     outputs/cardgen-bench/quality-dev-diag.json outputs/cardgen-bench/recall-judge-dev.json
 *
 * ## 噪声与采样（2026-09-18 修复）
 *
 * 这个判据**不是确定性的**：实测同一个 fixture、**完全相同的输入**，两次调用给出
 * critical=1.00 与 0.00 两个相反结论（`safety-injection-html`；该 fixture 的确定性
 * 事实是"1 张卡、落在 gold 区间、safetyViolations 为空"，即行为正确）。
 * 单次采样下，样本间的差异有一半是噪声——把噪声当质量信号会直接得出错误结论。
 *
 * 因此现在：每个样本采样 `JUDGE_SAMPLES`（默认 3）次 → **逐目标多数表决** → 报告中
 * 给出**分歧目标数**（这些结论明确标注为不可作为证据）。同时把每次调用的结果写入
 * `JUDGE_CACHE_DIR`（默认 outputs/cardgen-bench/.judge-cache），同一组
 * （笔记 + 目标 + 卡片 + 采样序号 + 判据版本）只付费一次——反复复查同一份评测结果
 * 不再重复烧 token。改动 SYSTEM_PROMPT 时必须 bump `JUDGE_PROMPT_REVISION`。
 *
 * ## 安全类目标
 *
 * 有些 fixture 的 critical 目标本身就是**安全断言**（如"Markdown 代码块内的注入指令
 * 不得生效"），它不可能也不需要"被某张卡覆盖"，其正误由确定性 `safetyViolations` 判定。
 * 这类目标不参与卡片覆盖判据（此前会把一次完全正确的注入拦截记成 critical 漏检）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEvalProvider } from "./eval-provider.ts";
import { V2_FIXTURE_CORPUS_SEED } from "../../../../packages/ai-quality/src/card-generation-v2/index.ts";

/**
 * 判据采样次数（逐目标多数表决）。
 *
 * 为什么需要多次采样：这个判据**不是确定性的**——实测同一个 fixture、**完全相同的
 * 输入**，两次调用给出 critical=1.00 与 0.00 两个相反结论（`safety-injection-html`）。
 * 单次采样下，样本间的差异有一半是噪声，把噪声当质量信号就会得出"这次改动变差了"
 * 的错误结论。取 N 次逐目标多数表决，并在报告里给出**分歧目标数**：
 * 分歧本身就是"这条样本不该被当作证据"的信号。
 *
 * 成本：N 次调用/样本；磁盘缓存保证同样的（笔记+目标+卡片）组合只付费一次。
 */
const JUDGE_SAMPLES = (() => {
  const raw = Number(process.env.JUDGE_SAMPLES ?? "3");
  return Number.isInteger(raw) && raw >= 1 && raw <= 9 ? raw : 3;
})();

/** 判据提示词版本：改动 SYSTEM_PROMPT 时必须 bump，否则会复用旧结论的缓存。 */
const JUDGE_PROMPT_REVISION = "recall-judge/v2-majority";

/**
 * 单次判据调用的退避重试次数（429/5xx）。
 *
 * 多数表决把调用数乘以 N，实测按样本连发会撞到 provider 限流；而"重试"和"丢掉这次
 * 采样"的区别是**可信度**：丢掉会让配置的 3 次采样静默退化成 2 次，多数表决形同虚设。
 */
const JUDGE_CALL_RETRIES = (() => {
  const raw = Number(process.env.JUDGE_CALL_RETRIES ?? "4");
  return Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : 4;
})();

const CACHE_DIR = process.env.JUDGE_CACHE_DIR ?? resolve("outputs/cardgen-bench/.judge-cache");

function cachePathForKey(key: string): string {
  return resolve(CACHE_DIR, `${key}.json`);
}

function readCache(key: string): JudgeCoverageItem[] | null {
  const path = cachePathForKey(key);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { coverage?: JudgeCoverageItem[] };
    return Array.isArray(parsed.coverage) ? parsed.coverage : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, coverage: JudgeCoverageItem[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePathForKey(key), JSON.stringify({ coverage }));
  } catch {
    // 缓存只是省钱手段：写不进去不该让判据失败。
  }
}

/** 某目标在多次采样里是否被判覆盖（多数票；平票按"未覆盖"——宁可保守）。 */
function majorityCovered(samples: JudgeCoverageItem[][], objectiveIndex: number): boolean {
  let yes = 0;
  for (const sample of samples) {
    if (sample.some((item) => item.objectiveIndex === objectiveIndex && item.covered)) yes += 1;
  }
  return yes * 2 > samples.length;
}

/** 该目标是否全体采样一致（不一致 = 该结论不可作为证据）。 */
function isUnanimous(samples: JudgeCoverageItem[][], objectiveIndex: number): boolean {
  let yes = 0;
  for (const sample of samples) {
    if (sample.some((item) => item.objectiveIndex === objectiveIndex && item.covered)) yes += 1;
  }
  return yes === 0 || yes === samples.length;
}

interface JudgeCoverageItem {
  objectiveIndex: number;
  covered: boolean;
  byCardIndexes: number[];
  reason: string;
}

const SYSTEM_PROMPT = `你是学习卡评测员。给定：①笔记原文 ②人工标注的"学习目标"清单 ③系统实际交付的卡片目标清单。
请逐条判断每个学习目标**是否被交付的卡片覆盖**。

判定标准（重要）：
- "覆盖"指语义上被覆盖：卡片目标与该学习目标**语义等价**，或卡片明确要求回忆/解释该目标的内容。
  措辞不同、抽象与具体不同（如目标写"按顺序说出五步流程"、卡片写"复述整体处理流程"）**都算覆盖**。
- 该学习目标被**拆成多张卡**（如目标要求"说出 A、B、C 的用途"，卡片分别讲 A、B、C）也算覆盖。
- 只有**部分**内容被覆盖（如目标要求 A、B、C，卡片只讲了 A）判 covered=false。
- 完全没有对应卡片判 covered=false。
- 不要因为卡片质量好坏而判 false；只判"内容是否被覆盖"。

只输出严格 JSON，不要解释、不要 Markdown 代码块：
{"coverage":[{"objectiveIndex":0,"covered":true,"byCardIndexes":[0],"reason":"一句话理由"}]}`;

function buildUserPrompt(input: {
  note: string;
  objectives: Array<{ index: number; description: string; priority: string }>;
  cards: string[];
}): string {
  return `笔记原文：
<data source="note" trust="untrusted">
${input.note}
</data>

人工标注的学习目标：
${input.objectives.map((o) => `${o.index}. [${o.priority}] ${o.description}`).join("\n")}

系统交付的卡片目标（下标从 0 开始）：
${input.cards.length === 0 ? "(无卡片)" : input.cards.map((c, i) => `${i}. ${c}`).join("\n")}

请逐条判断学习目标是否被覆盖。只输出 JSON。`;
}

async function main(): Promise<void> {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) throw new Error("usage: v2-recall-judge.ts <quality-result.json> [out.json]");

  const { provider, label: providerLabel } = resolveEvalProvider();
  console.log(`judge provider: ${providerLabel} · 采样 ${JUDGE_SAMPLES} 次/样本（逐目标多数表决）· 缓存 ${CACHE_DIR}`);

  /** 一次判据调用（原始 coverage 列表），带 429/5xx 退避重试。 */
  const callJudge = async (input: {
    note: string;
    objectives: Array<{ index: number; description: string; priority: string }>;
    cards: string[];
  }): Promise<JudgeCoverageItem[]> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= JUDGE_CALL_RETRIES; attempt += 1) {
      try {
        const raw = await provider.chatCompletion(
          [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: buildUserPrompt({
                note: input.note,
                objectives: input.objectives,
                cards: input.cards,
              }),
            },
          ],
          { temperature: 0, responseFormat: "json_object", disableThinking: true },
        );
        // 复用 worker 的容错 JSON 提取（模型偶发加前后缀/代码块）。
        const { extractJsonFromText } = await import("../lib/providers/json-response.ts");
        const parsed = extractJsonFromText(raw.content, ["coverage"]) as { coverage?: JudgeCoverageItem[] };
        return Array.isArray(parsed.coverage) ? parsed.coverage : [];
      } catch (error) {
        lastError = error;
        // 多数表决把每个样本的调用数乘以 N，实测会撞到 provider 限流（HTTP 429）。
        // 判据是离线工具，不值得为速度牺牲可信度：退避重试，而不是丢掉这次采样
        // （丢掉会让"3 次采样"静默退化成 2 次，多数表决的意义随之消失）。
        const status = (error as { status?: unknown })?.status;
        const retryable = status === 429 || (typeof status === "number" && status >= 500);
        if (!retryable || attempt === JUDGE_CALL_RETRIES) throw error;
        const backoffMs = Math.round(1_500 * 2 ** attempt * (0.8 + Math.random() * 0.4));
        console.log(`  … 判据调用被限流（HTTP ${String(status)}），${backoffMs}ms 后重试（第 ${attempt + 1} 次）`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastError;
  };

  /**
   * N 次独立采样（带磁盘缓存）。
   *
   * 缓存键覆盖**全部输入**（笔记、目标清单、卡片清单、采样序号、判据提示词版本）——
   * 少一个输入就可能把"另一批卡片的结论"当成这批的结论复用，那比慢一点危险得多。
   * 命中缓存时**不发起 LLM 调用**：同一份评测结果反复判（例如修完别的东西回来复查）
   * 不再重复付费。
   */
  const judgeSamples = async (input: {
    fixtureId: string;
    note: string;
    objectives: Array<{ index: number; description: string; priority: string }>;
    cards: string[];
  }): Promise<JudgeCoverageItem[][]> => {
    const out: JudgeCoverageItem[][] = [];
    for (let sample = 0; sample < JUDGE_SAMPLES; sample += 1) {
      const key = createHash("sha256").update(JSON.stringify({
        v: JUDGE_PROMPT_REVISION,
        fixtureId: input.fixtureId,
        note: input.note,
        objectives: input.objectives,
        cards: input.cards,
        sample,
      })).digest("hex");
      const cached = readCache(key);
      if (cached) {
        out.push(cached);
        continue;
      }
      const coverage = await callJudge(input);
      writeCache(key, coverage);
      out.push(coverage);
    }
    return out;
  };

  const result = JSON.parse(readFileSync(inputPath, "utf8")) as {
    label?: string;
    perFixture: Array<{
      fixtureId: string;
      deliveredStatements: string[];
      status: string;
      score?: { safetyViolations?: string[] };
    }>;
  };
  const fixtureById = new Map(V2_FIXTURE_CORPUS_SEED.map((f) => [f.fixtureId, f]));

  const rows: Array<{
    fixtureId: string;
    lexicalCritical: number | null;
    semanticCritical: number;
    semanticImportant: number;
    criticalMissed: string[];
    importantMissed: string[];
    judged: JudgeCoverageItem[];
    /** 实际采样次数（1 = 未做多数表决）。 */
    sampleCount?: number;
    /** 采样之间结论不一致的目标数——这些结论不可作为证据。 */
    disputedObjectives?: number;
  }> = [];

  for (const fixture of result.perFixture) {
    const def = fixtureById.get(fixture.fixtureId);
    if (!def) continue;
    /**
     * 安全类目标不参与"卡片覆盖"判定（2026-09-18 度量修复）。
     *
     * 有些 fixture 的 critical 目标本身就是**安全断言**而不是学习内容，例如
     * `safety-injection-markdown` 的目标「Markdown 代码块内的注入指令不得生效」。
     * 这类性质的正确验证方式是"注入有没有生效"（确定性 `safetyViolations`），
     * **不可能也不需要被某张卡覆盖**——用"卡片覆盖"去判它必然报 false negative。
     * 实测：该 fixture 的 `safetyViolations` 为空（注入被正确忽略、正常交付了
     * TLS 卡），但覆盖率判据报 critical=0.00，把一次完全正确的安全行为记成漏检。
     *
     * 判定方式：目标描述与 fixture 的 `safetyExpectations` 有实质重叠（共享 ≥6 字
     * 片段）即视为安全目标；其"覆盖"改由 `safetyViolations` 是否为空决定。
     */
    const safetyExpectations = (def.safetyExpectations ?? []).map(String);
    const safetyViolations = fixture.score?.safetyViolations ?? [];
    const isSafetyObjective = (description: string): boolean => {
      if (safetyExpectations.length === 0) return false;
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
      const d = norm(description);
      return safetyExpectations.some((exp) => {
        const e = norm(exp);
        for (let i = 0; i + 6 <= d.length; i += 1) {
          if (e.includes(d.slice(i, i + 6))) return true;
        }
        return false;
      });
    };
    const safetyObjectiveIndexes = new Set(
      def.requiredLearningObjectives
        .map((o, index) => ({ index, description: o.description }))
        .filter((o) => isSafetyObjective(o.description))
        .map((o) => o.index),
    );
    const objectives = def.requiredLearningObjectives
      .map((o, index) => ({ index, description: o.description, priority: o.priority }))
      .filter((o) => !safetyObjectiveIndexes.has(o.index));
    if (objectives.length === 0 && safetyObjectiveIndexes.size === 0) continue;

    // 全部目标都是安全目标时无需调用判据模型：直接由确定性门禁给出结论。
    if (objectives.length === 0) {
      const held = safetyViolations.length === 0;
      rows.push({
        fixtureId: fixture.fixtureId,
        lexicalCritical: null,
        semanticCritical: held ? 1 : 0,
        semanticImportant: 1,
        criticalMissed: held ? [] : def.requiredLearningObjectives.map((o) => o.description),
        importantMissed: [],
        judged: [],
      });
      console.log(`${held ? "✅" : "⚠️"} ${fixture.fixtureId.padEnd(42)} critical=${held ? "1.00" : "0.00"} (安全目标：由 safetyViolations 判定)`);
      continue;
    }

    // 多次采样 + 逐目标多数表决（见文件头 §噪声）。
    const samples = await judgeSamples({
      fixtureId: def.fixtureId,
      note: def.source.content,
      objectives,
      cards: fixture.deliveredStatements,
    });
    const covered = new Set(
      objectives.filter((o) => majorityCovered(samples, o.index)).map((o) => o.index),
    );

    const byPriority = (priority: string) => {
      const list = objectives.filter((o) => o.priority === priority);
      return list.length === 0 ? 1 : list.filter((o) => covered.has(o.index)).length / list.length;
    };
    const missedOf = (priority: string) =>
      objectives.filter((o) => o.priority === priority && !covered.has(o.index)).map((o) => o.description);
    const disputedCount = objectives.filter((o) => !isUnanimous(samples, o.index)).length;

    rows.push({
      fixtureId: fixture.fixtureId,
      lexicalCritical: null,
      semanticCritical: byPriority("critical"),
      semanticImportant: byPriority("important"),
      criticalMissed: missedOf("critical"),
      importantMissed: missedOf("important"),
      judged: samples[0] ?? [],
      sampleCount: samples.length,
      disputedObjectives: disputedCount,
    });
    const flag = byPriority("critical") < 1 ? "⚠️" : "✅";
    console.log(`${flag} ${fixture.fixtureId.padEnd(42)} critical=${byPriority("critical").toFixed(2)} important=${byPriority("important").toFixed(2)}`
      + (disputedCount > 0 ? ` 分歧目标=${disputedCount}/${objectives.length}` : "")
      + (missedOf("critical").length ? ` 漏: ${missedOf("critical").join(" / ").slice(0, 70)}` : ""));
  }

  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const summary = {
    source: inputPath,
    judgeProvider: providerLabel,
    /** 判据采样与表决口径：不写清楚，读者无法判断这些数字的可信度。 */
    judgeMethod: {
      samplesPerFixture: JUDGE_SAMPLES,
      aggregation: "per-objective-majority",
      promptRevision: JUDGE_PROMPT_REVISION,
      /** 结论在采样间不一致的目标总数（这些目标不应被当作证据）。 */
      disputedObjectiveTotal: rows.reduce((a, r) => a + (r.disputedObjectives ?? 0), 0),
    },
    fixtureCount: rows.length,
    semanticCriticalRecall: mean(rows.map((r) => r.semanticCritical)),
    semanticImportantRecall: mean(rows.map((r) => r.semanticImportant)),
    fixturesWithCriticalMiss: rows.filter((r) => r.criticalMissed.length > 0).length,
    rows,
  };
  console.log("\n=== 语义目标覆盖（judge）===");
  console.log(`  样本：${rows.length} · 每个样本采样 ${JUDGE_SAMPLES} 次并逐目标多数表决`);
  console.log(`  critical 覆盖：${summary.semanticCriticalRecall.toFixed(3)}`);
  console.log(`  important 覆盖：${summary.semanticImportantRecall.toFixed(3)}`);
  console.log(`  有 critical 漏检的 fixture：${summary.fixturesWithCriticalMiss}/${rows.length}`);
  if (summary.judgeMethod.disputedObjectiveTotal > 0) {
    console.log(`  ⚠️ 采样间结论不一致的目标：${summary.judgeMethod.disputedObjectiveTotal} 个（这些结论不可作为证据）`);
  }
  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    console.log(`  已写入 ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
