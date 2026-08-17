/**
 * Plan 23 CS-03（web）：/learning-objectives/[objectiveId] 直达页。
 *
 * 搜索/外部链接以 objectiveId 为稳定身份；本页解析到公开呈现 cardId 后
 * 重定向到既有 Objective 档案页（/learning-cards/[cardId]），不复制详情逻辑。
 */
"use client";

import { useEffect, useState, type JSX } from "react";
import { useParams, useRouter } from "next/navigation";
import { learningObjectiveApi } from "@/lib/learning-objective-api";
import { ObjectiveSkeleton, ObjectiveError } from "@/features/learning-objective/ObjectiveStatePrimitives";

export default function ObjectiveRedirectPage(): JSX.Element {
  const params = useParams<{ objectiveId: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    learningObjectiveApi
      .getObjective(params.objectiveId)
      .then((surface) => {
        if (cancelled) return;
        const cardId = surface.content.presentation.cardId;
        router.replace(cardId ? "/learning-cards/" + cardId : "/cards");
      })
      .catch(() => {
        if (cancelled) return;
        setError("学习目标不存在或已迁移，请从学习目标库重新进入。");
      });
    return () => {
      cancelled = true;
    };
  }, [params.objectiveId, router]);

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <ObjectiveError message={error} retryable onRetry={() => router.push("/cards")} />
      </div>
    );
  }
  return <ObjectiveSkeleton rows={3} />;
}
