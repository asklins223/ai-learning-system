import { Suspense } from "react";
import "@/app/styles/learning-run.css";
import "@/components/liquid-orb/liquid-orb.css";
import { notFound } from "next/navigation";
import { isLearningRunV1Enabled } from "@/lib/feature-flags";
import { LearningRunLivePlayer } from "@/features/learning-run/LearningRunLivePlayer";

/**
 * LearningRun Player 生产页（P3 切流后的唯一正式运行表面）。
 * learning_run_v1 关闭时 404（fail closed；旧链路继续服务 Card/Review）。
 */
export default async function LearningRunPage({ params }: { params: Promise<{ runId: string }> }) {
  if (!isLearningRunV1Enabled()) notFound();
  const { runId } = await params;
  return (
    <Suspense fallback={<div className="learning-run-route-loading" role="status">正在恢复学习…</div>}>
      <LearningRunLivePlayer runId={runId} fallbackReturnTo="/" />
    </Suspense>
  );
}
