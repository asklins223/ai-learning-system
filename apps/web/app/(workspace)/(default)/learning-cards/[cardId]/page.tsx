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
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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

/** 2026-08-16（实机验证修复）：Electron 宿主不支持 window.prompt——
 *  编辑改为真实弹窗，避免 "prompt() is not supported." 崩溃。 */
function CardEditDialog({
  card,
  busy,
  onClose,
  onSave,
}: {
  card: PublicLearningCardV2;
  busy: boolean;
  onClose: () => void;
  onSave: (cue: string, prompt: string) => void;
}) {
  const [cue, setCue] = useState(card.front.cue ?? "");
  const [prompt, setPrompt] = useState(card.front.prompt ?? "");
  const titleId = useId();
  const cueId = useId();
  const promptId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="candidate-edit-overlay" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="candidate-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p>LEARNING CARD V2</p>
            <h2 id={titleId}>编辑学习卡正面</h2>
            <span>修改会直接发布新卡片版本。</span>
          </div>
          <button type="button" aria-label="关闭编辑" onClick={onClose}>
            <Icon.Close />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(cue.trim(), prompt.trim());
          }}
        >
          <label htmlFor={cueId}>
            <span>回忆线索（cue）</span>
            <input
              id={cueId}
              value={cue}
              maxLength={2000}
              required
              onChange={(event) => setCue(event.target.value)}
            />
          </label>
          <label htmlFor={promptId}>
            <span>正面作答提示（prompt）</span>
            <textarea
              id={promptId}
              value={prompt}
              rows={5}
              maxLength={2000}
              required
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <footer>
            <button type="button" className="card-v2-button card-v2-button--quiet" onClick={onClose}>取消</button>
            <button
              type="submit"
              className="card-v2-button card-v2-button--primary"
              disabled={busy || !cue.trim() || !prompt.trim()}
            >
              <Icon.Check />{busy ? "正在保存…" : "保存改动"}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export default function LearningCardV2DetailPage() {
  const params = useParams<{ cardId: string }>();
  const router = useRouter();
  const cardId = params.cardId;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [card, setCard] = useState<PublicLearningCardV2 | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reminders, setReminders] = useState<InitialValidationReminderV2[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [noticeTone, setNoticeTone] = useState<"info" | "error">("info");
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
          setNoticeTone("info");
          setNotice("已归档。");
          // 2026-08-16：归档成功后重新拉取卡状态，页面立即切换为"已归档"
          // 视图（此前只 router.refresh()，client state 不变 → UI 不更新）。
          const fresh = await client.readPublicCard(card.cardId);
          setCard(fresh);
        } else if (action === "regenerate") {
          if (!card.noteId) {
            setNoticeTone("error");
            setNotice("这张卡缺少来源笔记信息，请从笔记的“价值优先生成”入口发起。");
            return;
          }
          const result = await client.regenerateCardV2(
            card.cardId,
            `regenerate-${card.cardId}-${Date.now()}`,
          );
          router.push(`/notes/${encodeURIComponent(card.noteId)}/card-generation-v2?runId=${encodeURIComponent(result.runId)}`);
        } else {
          // Electron 宿主不支持 window.prompt：改为真实编辑弹窗。
          setEditOpen(true);
        }
      } catch (error) {
        setNoticeTone("error");
        setNotice(error instanceof Error ? error.message : "操作失败。");
      } finally {
        setBusy(false);
      }
    },
    [clientRef, card, router],
  );

  const onSaveEdit = useCallback(
    async (cue: string, prompt: string) => {
      const client = clientRef.current;
      if (!client || !card) return;
      setBusy(true);
      setNotice(null);
      try {
        await client.updateCardPresentationV2(
          card.cardId,
          {
            expectedPublicationRevision: card.publicationRevision,
            expectedPublicPayloadHash: card.publicPayloadHash,
            patch: { front: { cue, prompt } },
          },
          `edit-${card.cardId}-${Date.now()}`,
        );
        setEditOpen(false);
        setNoticeTone("info");
        setNotice("已保存正面编辑。");
        window.location.reload();
      } catch (error) {
        setNoticeTone("error");
        setNotice(error instanceof Error ? error.message : "保存失败。");
      } finally {
        setBusy(false);
      }
    },
    [clientRef, card],
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
      <div className="card-v2-route__inner">
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
                      setNoticeTone("info");
                      setNotice("提醒已取消。");
                    } catch (error) {
                      setNoticeTone("error");
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
      </div>
      {notice && <p className="card-v2-toast" data-tone={noticeTone} role="status">{notice}</p>}
      {editOpen && card && (
        <CardEditDialog
          card={card}
          busy={busy}
          onClose={() => setEditOpen(false)}
          onSave={(cue, prompt) => void onSaveEdit(cue, prompt)}
        />
      )}
    </main>
  );
}
