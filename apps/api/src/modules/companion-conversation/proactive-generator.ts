/**
 * Orchestrator 模型生成接线（文档 16 §14.3 P8：记忆候选生成）。
 *
 * Run 结算后（Policy 允许）用真实 LLM（DashScope OpenAI-compatible，复用
 * ASSESSMENT_CRITIC_* 配置，key 同源 DASHSCOPE_API_KEY）生成分层记忆候选：
 * - learning_context：本 Run 的学习洞察（用户掌握/缺口，含来源引用）
 * - interaction_note：值得后续提醒的交互备注（可选，模型判定无需则缺省）
 *
 * 任何失败（无配置/网络/输出非法）静默降级返回空（确定性最小闭环照常），
 * 不阻塞 Run 结算事务；输出经 strict schema 校验，失败即弃。
 */

import { z } from "zod";
import { postJsonToPublicEndpoint } from "@ailearn/shared/public-json-http";
import { resolveAssessmentCriticConfig } from "../../lib/assessment-critic-config.ts";

/**
 * 记忆候选生成的单次调用预算（设计 P1-11，2026-09-15 审计）。
 *
 * 这是一次短 JSON 生成（输入是枚举 + 短文本，输出 ≤200 字），不是长文生成：
 * 8s 已远高于正常耗时。超时按既有 fail-open 语义返回 null，调用方走确定性模板。
 * 重点是把上界从"共享的 300s"压到与业务重要性相称的量级——该调用此前会最坏
 * 阻塞 run-processing tick 的串行链 5 分钟/条。
 */
const MEMORY_CANDIDATE_TIMEOUT_MS = 8_000;

export const memoryCandidateOutputSchema = z
  .object({
    learningContext: z
      .object({
        // §9.4/§25：写入端统一限制 ≤200 字。
        content: z.string().min(2).max(200),
        needsFollowup: z.boolean(),
      })
      .strict(),
    interactionNote: z
      .object({
        // §9.4/§25：写入端统一限制 ≤200 字。
        content: z.string().min(2).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface GeneratedMemoryCandidates {
  learningContext: string;
  interactionNote: string | null;
}

/** 生成记忆候选（不抛错；失败返回 null 由调用方降级）。 */
export async function generateMemoryCandidates(input: {
  outcome: string;
  trustOutcome: string;
  /** Plan 23 CS-05：从 Objective revision conceptLabel 取，不再用 legacy claim。 */
  keyPointClaim: string;
  scheduleImpact: string;
}): Promise<GeneratedMemoryCandidates | null> {
  // 设计 P0-2（2026-09-15 审计）：收敛到单一解析点。此前用
  // `?? DASHSCOPE_API_KEY`，而 compose 注入的是空串（`${VAR:-}`）——空串不回退，
  // 于是未显式配置 key 时这里会静默 return null，个性化被无声关闭。
  const config = resolveAssessmentCriticConfig();
  if (!config) return null;
  const { url, key, model } = config;

  const prompt = [
    "你是学习伴星的记忆整理器。根据一次三分钟巩固的结果，输出 JSON：",
    `{"learningContext":{"content":"一句话学习洞察（用户掌握或缺口，中文，不含答案正文，不超过 200 字）","needsFollowup":true},"interactionNote":{"content":"值得后续提醒的交互备注（无则省略整个字段，不超过 200 字）"}}`,
    "输入：",
    `outcome=${input.outcome}`,
    `trustOutcome=${input.trustOutcome}`,
    `objectiveLabel=${input.keyPointClaim.slice(0, 200)}`,
    `scheduleImpact=${input.scheduleImpact}`,
    "只输出 JSON。",
  ].join("\n");

  try {
    // 设计 P1-11（2026-09-15 审计）：此前不传 signal，只受共享的
    // AI_ENDPOINT_RESPONSE_TIMEOUT_MS（默认 300s）约束——一次挂起的 provider 会让
    // 该调用最多占 5 分钟（而它只是"锦上添花"的个性化，确定性路径本可立即完成）。
    // 这里给一个远小于共享值的预算：本调用是短 JSON 生成，超时即按既有 fail-open
    // 语义返回 null（调用方走确定性模板）。兄弟调用（proactive-hook 的个性化文案）
    // 用的是 2s，此处同样只做轻量生成。
    const response = await postJsonToPublicEndpoint(
      url,
      {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      {
        model,
        messages: [
          { role: "system", content: "你是学习伴星的记忆整理器，输出严格 JSON。" },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        stream: false,
      },
      AbortSignal.timeout(MEMORY_CANDIDATE_TIMEOUT_MS),
    );
    const raw = extractJson(
      (response.body as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content ?? "",
    );
    if (!raw) return null;
    const parsed = memoryCandidateOutputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      learningContext: parsed.data.learningContext.content,
      interactionNote: parsed.data.interactionNote?.content ?? null,
    };
  } catch {
    return null; // 任何失败静默降级（确定性最小闭环照常）。
  }
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}
