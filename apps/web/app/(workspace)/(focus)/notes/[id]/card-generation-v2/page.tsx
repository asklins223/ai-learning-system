"use client";

import "@/app/styles/card-generation-v2.css";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { CandidateReviewPage } from "@/features/card-generation-v2/CandidateReviewPage";

/**
 * /notes/[noteId]/card-generation-v2 — Card Generation V2 候选审核页（R7）。
 *
 * 通过 `?runId=` 定位到一次真实 V2 Generation Run。之前端 flag 关闭时应
 * 由入口隐藏此路由；用户直接访问时页面会读到后端 404 → 显示"未开启"提示，
 * fail-closed。
 */
export default function CardGenerationV2ReviewRoutePage() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("runId");
  const noteId = searchParams.get("noteId");

  return (
    <main className="card-v2-route">
      <header className="card-v2-route__bar">
        <div>
          <Link href={noteId ? `/notes/${noteId}` : "/notes"} className="card-v2-button card-v2-button--quiet">
            ← 返回笔记
          </Link>
          <h1>学习卡 · 候选审核</h1>
        </div>
        <ThemeToggle />
      </header>
      {runId ? (
        <CandidateReviewPage runId={runId} />
      ) : (
        <section className="card-v2-route__empty" role="alert">
          <p>缺少生成任务 runId。请从笔记的“价值优先生成”入口发起。</p>
          <Link href={noteId ? `/notes/${noteId}` : "/notes"} className="card-v2-button card-v2-button--primary">
            返回笔记
          </Link>
        </section>
      )}
    </main>
  );
}
