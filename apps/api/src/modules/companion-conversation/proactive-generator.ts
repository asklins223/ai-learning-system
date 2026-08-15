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

export const memoryCandidateOutputSchema = z
  .object({
    learningContext: z
      .object({
        content: z.string().min(2).max(400),
        needsFollowup: z.boolean(),
      })
      .strict(),
    interactionNote: z
      .object({
        content: z.string().min(2).max(400),
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
  keyPointClaim: string;
  scheduleImpact: string;
}): Promise<GeneratedMemoryCandidates | null> {
  const url = process.env.ASSESSMENT_CRITIC_URL?.trim();
  const key = process.env.ASSESSMENT_CRITIC_KEY?.trim() ?? process.env.DASHSCOPE_API_KEY?.trim();
  if (!url || !key) return null;
  const model = process.env.ASSESSMENT_CRITIC_MODEL?.trim() ?? "qwen-plus";

  const prompt = [
    "你是学习伴星的记忆整理器。根据一次三分钟巩固的结果，输出 JSON：",
    `{"learningContext":{"content":"一句话学习洞察（用户掌握或缺口，中文，不含答案正文）","needsFollowup":true},"interactionNote":{"content":"值得后续提醒的交互备注（无则省略整个字段）"}}`,
    "输入：",
    `outcome=${input.outcome}`,
    `trustOutcome=${input.trustOutcome}`,
    `keyPointClaim=${input.keyPointClaim.slice(0, 200)}`,
    `scheduleImpact=${input.scheduleImpact}`,
    "只输出 JSON。",
  ].join("\n");

  try {
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
