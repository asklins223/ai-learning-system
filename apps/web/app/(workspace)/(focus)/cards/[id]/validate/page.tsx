"use client";

/**
 * v0.6 Card Validation Focus Route (计划 §9.1)
 *
 * Route: /cards/[id]/validate?keyPoint=...
 *
 * Independent Focus session for question-first validation.
 * Hides bottom navigation, uses 100dvh, sticky action bar.
 * No card title, claim, quote, or evidence visible during answering.
 */

import "@/app/styles/validation-focus.css";
import { useParams, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { ValidationFocus } from "@/components/ValidationFocus";
import { ValidationVoiceEntry } from "@/components/learning-companion/ValidationVoiceEntry";

export default function CardValidatePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const cardId = params.id;
  const keyPointId = searchParams.get("keyPoint") ?? undefined;

  const exitHref = `/cards/${cardId}`;

  return (
    <>
      {/* 伴星语音/文字输入接线（§6.5/§13.4）：模态切换 + 语音面板 + text fallback；
          无麦克风用户始终可切 text_or_mixed，无操作死路。 */}
      <ValidationVoiceEntry
        cardId={cardId}
        keyPointId={keyPointId ?? cardId}
        voiceUnavailable={false}
        onSubmitText={async (text) => {
          // 文字提交：宿主在此接入 question-first 提交（v0.6 语义兼容）。
          // 注意：不把用户输入原文写入 console（个人内容，§13.3 零采集）。
          console.info("[companion] text_or_mixed submit", { cardId, keyPointId, textLength: text.length });
        }}
      />
      <ValidationFocus
        cardId={cardId}
        keyPointId={keyPointId}
        exitHref={exitHref}
        exitLabel="返回学习卡"
        onExit={() => router.push(exitHref)}
      />
    </>
  );
}
