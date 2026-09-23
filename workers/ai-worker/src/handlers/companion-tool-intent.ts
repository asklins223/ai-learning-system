import type { ChatMessage } from "@ailearn/shared";
import type { AIProvider } from "../lib/ai-provider.ts";

/**
 * Let the model decide whether the current request needs the user's live data or an app action.
 * A wording list cannot cover indirect requests such as "给我看看那篇文章的插图".
 */
export async function companionNeedsTool(
  provider: AIProvider,
  messages: readonly ChatMessage[],
  signal: AbortSignal,
): Promise<boolean | null> {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  if (!latest) return false;
  const current = typeof latest.content === "string"
    ? latest.content
    : latest.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  const recent = messages.filter((message) => message.role !== "system").slice(-5).map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? message.content.slice(0, 500)
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 500),
  }));
  try {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const answer = await provider.chatCompletion([
      {
        role: "system",
        content: [
          "你只判断下一步是否必须调用应用工具。只输出 JSON：{\"needsTool\":true} 或 {\"needsTool\":false}。",
          "当用户要查看自己的文章、笔记、图片、引用、卡片或实时信息，或要求导航、设置和执行动作时，必须先用工具；口语化、简称、代词和间接表达也一样。",
          "一般知识问答、闲聊、自我介绍以及询问操作方法可以直接回答。此前助手说过已找到或已展示，不等于本轮真的查询过。",
          "这里只判断是否需要工具；具体调用哪个工具和参数由后续模型自己决定。",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify({ current, recent }) },
    ], { maxTokens: 60, temperature: 0, responseFormat: "json_object", disableThinking: true }, boundedSignal);
    const parsed: unknown = JSON.parse(answer.content);
    if (!parsed || typeof parsed !== "object") return null;
    const decision = (parsed as Record<string, unknown>).needsTool;
    return typeof decision === "boolean" ? decision : null;
  } catch {
    return null;
  }
}
