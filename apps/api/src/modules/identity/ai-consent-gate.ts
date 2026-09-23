import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { userAiSettings } from "@ailearn/shared/db-schema/identity";
import { db } from "../../db/client.ts";

/**
 * 外发同意门（doc 34 L13）。
 *
 * `PRODUCT.md:50` 把账号级同意写成数据出本机的**唯一**闸门：签了就在哪个空间都算同意，
 * 没签就在哪个空间都发不出去。文字那条路确实有这道门（worker 侧
 * `lib/governance.ts` 的 `sendToExternal` 判据），但语音两条路此前只有
 * `requireSession` + 限流——**TTS 要把正文发给外部合成服务，ASR 更直接把麦克风音频发出去**，
 * 一个人没签同意也能被语音路径绕过闸门。
 *
 * 判据只写一次，且与 `identity/invite-service.ts` 里那句 `ai_consent` 完全同一形状
 * （`consentAt && consentVersion`）：两处各写一份，迟早一处放宽一处收紧。
 *
 * `users` 表没有启用 RLS，所以这里用 `db` 直读是安全的（这一判定见
 * `docs/plans/34-…` §1.2 ③ 的全量清点，不是"看起来没事"）。
 */
export async function hasExternalAiConsent(userId: string): Promise<boolean> {
  const row = await db
    .select({
      consentAt: userAiSettings.consentAt,
      consentVersion: userAiSettings.consentVersion,
    })
    .from(userAiSettings)
    .where(eq(userAiSettings.userId, userId))
    .limit(1);
  return Boolean(row[0]?.consentAt && row[0]?.consentVersion);
}

/**
 * preHandler：没签同意就把请求挡在合成/转写之前，**不回退成"静默用默认"**。
 *
 * 故意不缓存：这是一次单行主键读，而"刚签完就能出声"比省一次查询值钱；
 * 反过来把同意状态缓存在进程里，就会造出"界面上已同意、这一路还拒绝"的第二个来源。
 */
export async function requireAiConsent(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (await hasExternalAiConsent(req.session.userId)) return;
  // 403 + 一个可判定的错误码：桌面端据此说"先去设置里同意"，而不是"语音坏了"。
  await reply.code(403).send({
    error: "ai_consent_required",
    message: "还没有同意使用 AI 服务，语音合成与转写暂时不可用。",
  });
}
