"use client";

/**
 * V2 Active Card 页面（方案 20 §19.5）。
 *
 * 真实读取 `/api/v2/cards/:cardId`，支持 reveal（exposure-first）、
 * 开始 LearningRun（originV2 card）、归档。
 */

import "@/app/styles/card-generation-v2.css";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ActiveLearningCardV2 } from "@/features/learning-card-v2/ActiveLearningCardV2";
import type { LearningCardRevealContentV2 } from "@/features/card-generation-v2/contracts/ui-contracts";
import { toLearningCardRevealContent, toPublicLearningCardPreview } from "@/features/card-generation-v2/api/learning-card-adapters";
import type { V2Client } from "@/features/card-generation-v2/api-client";
import type { PublicLearningCardV2, InitialValidationReminderV2 } from "@ailearn/shared";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

export default function LearningCardV2DetailPage() {
  const params = useParams<{ cardId: string }>();
  const router = useRouter();
  const cardId = params.cardId;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [card, setCard] = useState<PublicLearningCardV2 | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reminders, setReminders] = useState<InitialValidationReminderV2[]>([]);
  const clientRef = useMemo<{ current: V2Client | null }>(() => ({ current: null }), []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const mod = await import("@/features/card-generation-v2/api-client");
        const client = mod.createV2Client();
        clientRef.current = client;
        const data = await client.readPublicCard(cardId);
        if (cancelled) return;
        setCard(data);
        try {
          const reminderResult = await client.listReadyReminders();
          if (!cancelled) {
            setReminders(reminderResult.reminders.filter((r) => r.objectiveId === data.objectiveId));
          }
        } catch {
          // Reminder 不可用不阻塞卡片展示。
        }
        setLoad({ status: "ready" });
      } catch (error) {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: error instanceof Error ? error.message : "卡片加载失败。",
        });
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [cardId, clientRef]);

  const onReveal = useCallback(
    async (id: string): Promise<LearningCardRevealContentV2> => {
      const client = clientRef.current;
      if (!client) throw new Error("V2 客户端不可用。");
      const reveal = await client.revealCardV2(
        {
          cardId: id,
          expectedPublicationRevision: card?.publicationRevision ?? 1,
          expectedPublicPayloadHash: card?.publicPayloadHash ?? "",
        },
        `reveal-${id}-${Date.now()}`,
      );
      return toLearningCardRevealContent(reveal);
    },
    [clientRef, card],
  );

  const onStartLearning = useCallback(
    ({ cardId: cid, objectiveId }: { cardId: string; objectiveId: string; exposureId: string | null }) => {
      const params = new URLSearchParams({
        origin: "card_v2",
        cardId: cid,
        objectiveId,
        returnTo: `/learning-cards/${cid}`,
      });
      router.push(`/learning-runs/new?${params.toString()}`);
    },
    [router],
  );

  const onLifecycleAction = useCallback(
    async (action: "edit" | "archive" | "regenerate") => {
      const client = clientRef.current;
      if (!client || !card) return;
      setBusy(true);
      setNotice(null);
      try {
        if (action === "archive") {
          await client.archiveCardV2(
            {
              cardId: card.cardId,
              expectedPublicationRevision: card.publicationRevision,
              expectedPublicPayloadHash: card.publicPayloadHash,
              expectedObjectiveLifecycleEpoch: 1,
            },
            `archive-${card.cardId}-${Date.now()}`,
          );
          setNotice("已归档。");
          router.refresh();
        } else if (action === "regenerate") {
          if (!card.noteId) {
            setNotice("这张卡缺少来源笔记信息，请从笔记的“价值优先生成”入口发起。");
            return;
          }
          const result = await client.regenerateCardV2(
            card.cardId,
            `regenerate-${card.cardId}-${Date.now()}`,
          );
          router.push(`/notes/${encodeURIComponent(card.noteId)}/card-generation-v2?runId=${encodeURIComponent(result.runId)}`);
        } else {
          const nextPrompt = window.prompt("编辑正面作答提示", card.front.prompt);
          if (nextPrompt === null || !nextPrompt.trim()) return;
          await client.updateCardPresentationV2(
            card.cardId,
            {
              expectedPublicationRevision: card.publicationRevision,
              expectedPublicPayloadHash: card.publicPayloadHash,
              patch: { front: { cue: card.front.cue, prompt: nextPrompt.trim() } },
            },
            `edit-${card.cardId}-${Date.now()}`,
          );
          setNotice("已保存正面编辑。");
          window.location.reload();
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "操作失败。");
      } finally {
        setBusy(false);
      }
    },
    [clientRef, card, router],
  );

  if (load.status === "loading") {
    return (
      <main className="card-v2-route">
        <header className="card-v2-route__bar">
          <Link href="/cards" className="card-v2-button card-v2-button--quiet">← 学习卡库</Link>
          <h1>学习卡</h1>
          <ThemeToggle />
        </header>
        <div className="card-v2-lab__stage" aria-busy="true">
          <section className="candidate-review__loading"><Icon.Sparkle />正在载入学习卡…</section>
        </div>
      </main>
    );
  }

  if (load.status === "error" || !card) {
    return (
      <main className="card-v2-route">
        <header className="card-v2-route__bar">
          <Link href="/cards" className="card-v2-button card-v2-button--quiet">← 学习卡库</Link>
          <h1>学习卡</h1>
          <ThemeToggle />
        </header>
        <section className="candidate-review__error" role="alert">
          <Icon.Warn />
          <h2>卡片加载失败</h2>
          <p>{load.status === "error" ? load.message : "卡片不存在。"}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="card-v2-route">
      <header className="card-v2-route__bar">
        <Link href="/cards" className="card-v2-button card-v2-button--quiet">← 学习卡库</Link>
        <h1>学习卡</h1>
        <ThemeToggle />
      </header>
      <div className="card-v2-lab__stage">
        <ActiveLearningCardV2
          card={toPublicLearningCardPreview(card)}
          capability="available"
          onReveal={onReveal}
          onStartLearning={onStartLearning}
          onLifecycleAction={busy ? undefined : (action) => void onLifecycleAction(action)}
        />
        {reminders.length > 0 && (
          <section className="learning-card-v2__reminders" aria-label="首次验证提醒">
            <h2>首次验证提醒</h2>
            {reminders.map((reminder) => (
              <div key={reminder.reminderId} className="learning-card-v2__reminder">
                <span>{reminder.status === "ready" ? "可以开始首次验证" : "首次验证已安排"}</span>
                <button
                  type="button"
                  className="card-v2-button card-v2-button--quiet"
                  disabled={busy}
                  onClick={async () => {
                    const client = clientRef.current;
                    if (!client) return;
                    setBusy(true);
                    try {
                      await client.cancelReminder(reminder.reminderId);
                      setReminders((prev) => prev.filter((r) => r.reminderId !== reminder.reminderId));
                      setNotice("提醒已取消。");
                    } catch (error) {
                      setNotice(error instanceof Error ? error.message : "取消失败。");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  取消提醒
                </button>
              </div>
            ))}
          </section>
        )}
        {notice && <p className="candidate-review__notice" role="status">{notice}</p>}
      </div>
    </main>
  );
}
