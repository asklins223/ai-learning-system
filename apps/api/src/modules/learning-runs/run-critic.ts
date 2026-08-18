/**
 * LearningRun Assessment Critic（文档 16 §12.4：Assessment 与 Tutor/伴星角色隔离）。
 *
 * P2 接入：open_response（text/voice）的独立评估。Critic 只读 locked Artifact
 * 与 private task 输入，输出逐 rubric verdict；绝不直接写 mastery/schedule。
 *
 * 传输：OpenAI-compatible /chat/completions（response_format=json_object），
 * 经 @ailearn/shared/public-json-http 的 postJsonToPublicEndpoint（SSRF 防护）。
 * 配置环境变量：ASSESSMENT_CRITIC_URL / ASSESSMENT_CRITIC_KEY /
 * ASSESSMENT_CRITIC_MODEL。未配置或调用失败 → CriticUnavailableError（fail
 * closed，tick 端转 not_assessable，绝不猜结果）。
 *
 * 输出解析是 strict 的：每个 frozen rubric target 恰好一条 verdict，未知
 * rubricItemId / 未知 verdict / 缺条 → parse 失败（fail closed）。
 */

import { z } from "zod";
import { postJsonToPublicEndpoint } from "@ailearn/shared/public-json-http";
import type { LearningTargetSnapshotV2 } from "@ailearn/shared";

// ─── 合同 ────────────────────────────────────────────────────────────────

export interface CriticInput {
  /** 公开题面（不含答案）。 */
  taskPrompt: string;
  /** Key Point claim（公开内容，评估参照用）。 */
  claim: string;
  /** 证据引用（server-private：只发给 Critic，不回传客户端）。 */
  evidenceQuotes: string[];
  /** 用户答案（text 或 confirmedTranscript；declared_unable 不走 Critic）。 */
  answerText: string;
  intent: string;
  /** frozen rubric target ids（来自 private solution，客户端不可见）。 */
  rubricTargetIds: string[];
  /** 用户作答语言提示（可选）。 */
  answerLanguage?: string;
  /** §16.6：V2 run 携带 frozen snapshot 派生输入；存在时走 V2 提示。 */
  v2?: CriticInputV2;
}

export interface RubricVerdictOutput {
  rubricItemId: string;
  verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
  userFacingReason: string;
  confidence: number;
}

export class CriticUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticUnavailableError";
  }
}

export class CriticOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticOutputError";
  }
}

// ─── strict 输出 schema ──────────────────────────────────────────────────

export const criticVerdictSchema = z
  .object({
    rubricItemId: z.string().min(1),
    verdict: z.enum(["covered", "partial", "missing", "contradicted", "not_assessable"]),
    userFacingReason: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1).optional().default(1),
  })
  .strict();

export const criticOutputSchema = z
  .object({
    verdicts: z.array(criticVerdictSchema).min(1).max(8),
  })
  .strict();

/** 提取 JSON（模型可能包 markdown 围栏）。 */
export function extractCriticJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * strict 解析：每个 frozen rubric target 恰好一条 verdict；未知 id/缺条/重复
 * 全部失败（fail closed，不补造）。
 */
export function parseCriticOutput(
  raw: string,
  expectedRubricTargetIds: string[],
): RubricVerdictOutput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractCriticJson(raw));
  } catch {
    throw new CriticOutputError("critic output is not valid JSON");
  }
  const result = criticOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new CriticOutputError(`critic output schema mismatch: ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  const verdicts = result.data.verdicts;
  const expected = new Set(expectedRubricTargetIds);
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    if (!expected.has(verdict.rubricItemId)) {
      throw new CriticOutputError(`unknown rubricItemId: ${verdict.rubricItemId}`);
    }
    if (seen.has(verdict.rubricItemId)) {
      throw new CriticOutputError(`duplicate rubricItemId: ${verdict.rubricItemId}`);
    }
    seen.add(verdict.rubricItemId);
  }
  for (const rubricId of expectedRubricTargetIds) {
    if (!seen.has(rubricId)) {
      throw new CriticOutputError(`missing verdict for rubricItemId: ${rubricId}`);
    }
  }
  return verdicts;
}

// ─── prompt 构造（纯函数，可测）─────────────────────────────────────────

export function buildCriticPrompt(input: CriticInput): string {
  const evidenceSection = input.evidenceQuotes.length > 0
    ? `\n\n【材料证据（供参照，评估时不泄露给用户）】\n${input.evidenceQuotes.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
    : "";
  const language = input.answerLanguage ? `\n用户作答语言：${input.answerLanguage}` : "";
  return [
    "你是独立的评估者（Assessment Critic），不是辅导老师。你的职责是逐条判定用户答案对评估目标的覆盖程度。",
    "",
    "【题目（能力意图）】",
    `intent: ${input.intent}`,
    `题面: ${input.taskPrompt}`,
    "",
    "【核心观点（公开）】",
    input.claim,
    evidenceSection,
    "",
    "【用户答案】",
    input.answerText,
    language,
    "",
    "【评估目标】",
    `需要评定的 rubric 目标 id：${input.rubricTargetIds.join(", ")}`,
    "",
    "【判定规则】",
    "- covered：答案用自己的话实质覆盖了目标（不要求与材料逐字一致）；",
    "- partial：只覆盖了一部分，或依赖提示才能成立；",
    "- missing：未覆盖该目标；",
    "- contradicted：答案与该目标的核心意思相矛盾；",
    "- not_assessable：输入不可辨、过短或无法判断（例如只有一个词）。",
    "不得因为表述流畅就给 covered；不得把复述题面当作理解。",
    "",
    `只输出 JSON：{"verdicts":[{"rubricItemId":"<目标id>","verdict":"covered|partial|missing|contradicted|not_assessable","userFacingReason":"<给用户看的一句中文说明，不含答案关键内容>","confidence":0..1}]}`,
    "每个 rubric 目标 id 恰好输出一条；不要输出其他内容。",
  ].join("\n");
}

// ─── 传输实现（OpenAI-compatible，SSRF 防护）────────────────────────────

export interface CriticTransport {
  assess(input: CriticInput): Promise<RubricVerdictOutput[]>;
}

export function createOpenAICompatibleCritic(env: {
  url?: string;
  key?: string;
  model?: string;
} = {}): CriticTransport {
  // 空串视为未配置（compose 注入 `${VAR:-}` 时缺失变量为空串而非 undefined，
  // `??` 不会回退；统一取第一个非空值）。
  const url = [env.url, process.env.ASSESSMENT_CRITIC_URL]
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const key = [
    env.key,
    process.env.ASSESSMENT_CRITIC_KEY,
    // DashScope OpenAI-compatible 模式复用项目主 key（无独立 critic key 时）。
    process.env.DASHSCOPE_API_KEY,
  ].find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
  const model = env.model
    ?? (process.env.ASSESSMENT_CRITIC_MODEL?.trim() || "default");
  return {
    async assess(input) {
      if (!url || !key) {
        throw new CriticUnavailableError("assessment critic provider not configured");
      }
      let response: { status: number; body: unknown };
      try {
        response = await postJsonToPublicEndpoint(
          url,
          {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          {
            model,
            messages: [
              { role: "system", content: "你是独立评估者，只输出被要求的 JSON。" },
              { role: "user", content: input.v2 ? buildCriticPromptV2(input.v2) : buildCriticPrompt(input) },
            ],
            response_format: { type: "json_object" },
            stream: false,
          },
          undefined,
        );
      } catch (err) {
        // 网络/超时/DNS/代理失败：包装为 CriticUnavailableError（fail closed
        // ——provider 故障绝不能当成"答错"，也绝不能无限重试卡死 Run）。
        throw new CriticUnavailableError(
          `critic provider request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new CriticUnavailableError(`critic provider returned ${response.status}`);
      }
      const body = response.body as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new CriticOutputError("critic returned empty content");
      }
      return parseCriticOutput(content, input.rubricTargetIds);
    },
  };
}

// ─── V2：frozen snapshot 驱动的 Critic 输入（§16.6）──────────────────────
// 禁止再回查 V1 card_key_points.claim/quoteText；全部参照来自 frozen snapshot。
// (V1 表已退役，key_point_id 现为 learning_objectives_v2.objective_id 的别名。)

/**
 * §16.6 V2 critic 输入：从 frozen snapshot 派生，snapshotHash 纳入闭包。
 */
export interface CriticInputV2 {
  /** exact learning objective（public）。 */
  objectiveStatement: string;
  /** canonical answer units（server-private，判分参照，不下发用户）。 */
  canonicalAnswerUnits: Array<{ unitId: string; text: string }>;
  /** required rubric units。 */
  requiredRubricUnits: Array<{ rubricUnitId: string; criterion: string }>;
  /** optional rubric units。 */
  optionalRubricUnits: Array<{ rubricUnitId: string; criterion: string }>;
  /** evidence hashes + 允许引用的 evidence preview。 */
  evidenceRefs: Array<{ evidenceSnapshotHash: string; preview: string }>;
  /** Task intent / interaction family / public payload hash / artifact text。 */
  taskIntent: string;
  taskPrompt: string;
  interactionFamily: string;
  publicPayloadHash: string | null;
  artifactText: string;
  /** target 闭包。 */
  semanticTargetFingerprint: string;
  targetRevisionHash: string;
  snapshotHash: string;
  criticVersion: string;
}

/** 从 CanonicalAnswerV2 展开 flat answer units（稳定 unitId）。 */
export function flattenAnswerUnits(
  canonicalAnswer: LearningTargetSnapshotV2["target"]["canonicalAnswer"],
): Array<{ unitId: string; text: string }> {
  switch (canonicalAnswer.kind) {
    case "text":
      return [{ unitId: canonicalAnswer.unit.unitId, text: canonicalAnswer.unit.text }];
    case "bullets":
      return canonicalAnswer.items.map((i) => ({ unitId: i.unitId, text: i.text }));
    case "ordered_steps":
      return canonicalAnswer.steps.map((s) => ({ unitId: s.unitId, text: s.text }));
    case "mapping":
      return canonicalAnswer.pairs.map((p) => ({ unitId: p.unitId, text: `${p.left} → ${p.right}` }));
    case "comparison":
      return canonicalAnswer.rows.map((r) => ({ unitId: r.unitId, text: `${r.dimension}: ${r.values.join(" / ")}` }));
    case "formula":
      return [{ unitId: canonicalAnswer.unitId, text: canonicalAnswer.latex }];
    case "code":
      return [{ unitId: canonicalAnswer.unitId, text: `${canonicalAnswer.language}\n${canonicalAnswer.code}` }];
  }
}

/**
 * §16.6 V2 critic prompt：exact objective + answer units + rubric units +
 * evidence hashes/previews + task 闭包 + snapshotHash/critic version。
 * 判分结果要求指出 rubric unit coverage。
 */
export function buildCriticPromptV2(input: CriticInputV2): string {
  const evidenceSection = input.evidenceRefs.length > 0
    ? `\n\n【材料证据（评估参照，不泄露给用户）】\n${input.evidenceRefs.map((e, i) => `${i + 1}. [${e.evidenceSnapshotHash.slice(0, 12)}] ${e.preview}`).join("\n")}`
    : "";
  return [
    "你是独立的评估者（Assessment Critic），不是辅导老师。职责是逐条判定用户答案对评估目标的覆盖程度。",
    "",
    "【学习目标（公开）】",
    input.objectiveStatement,
    "",
    "【标准答案单元（server-private 参照）】",
    input.canonicalAnswerUnits.map((u) => `- ${u.unitId}: ${u.text}`).join("\n"),
    "",
    "【必需的 rubric 单元】",
    input.requiredRubricUnits.length > 0
      ? input.requiredRubricUnits.map((u) => `- ${u.rubricUnitId}: ${u.criterion}`).join("\n")
      : "（无）",
    "",
    "【可选 rubric 单元】",
    input.optionalRubricUnits.length > 0
      ? input.optionalRubricUnits.map((u) => `- ${u.rubricUnitId}: ${u.criterion}`).join("\n")
      : "（无）",
    evidenceSection,
    "",
    "【任务闭包】",
    `intent: ${input.taskIntent}`,
    `题面: ${input.taskPrompt}`,
    `interaction: ${input.interactionFamily}`,
    input.publicPayloadHash ? `publicPayloadHash: ${input.publicPayloadHash}` : "",
    "",
    "【用户答案】",
    input.artifactText,
    "",
    "【闭包签名】",
    `semanticTargetFingerprint: ${input.semanticTargetFingerprint}`,
    `targetRevisionHash: ${input.targetRevisionHash}`,
    `snapshotHash: ${input.snapshotHash}`,
    `criticVersion: ${input.criticVersion}`,
    "",
    "【判定规则】",
    "- 必须逐条评估每个必需 rubric 单元是否被覆盖（covered）；",
    "- 未覆盖的必需单元 → missing；与核心意思矛盾 → contradicted；",
    "- 答案引入了未被答案/证据支持的推断且无法核实 → 视为 unsupported（missing）；",
    "- covered：用自己的话实质覆盖；不得因表述流畅就给 covered；",
    "- not_assessable：不可辨、过短或无法判断。",
    "",
    `只输出 JSON：{"verdicts":[{"rubricItemId":"<rubricUnitId>","verdict":"covered|partial|missing|contradicted|not_assessable","userFacingReason":"<给用户看的一句中文说明，不含答案关键内容>","confidence":0..1}]}`,
    "每个必需 rubric 目标 id 恰好输出一条；不要输出其他内容。",
  ].filter((line) => line !== "").join("\n");
}
