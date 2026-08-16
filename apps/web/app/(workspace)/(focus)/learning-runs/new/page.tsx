"use client";

/**
 * LearningRun 创建入口（P3 生产切流）。
 *
 * 解析入口 query（origin/cardId/keyPointId/scheduleId/generation/returnTo），
 * 构造 CreateLearningRunRequestV1 并以稳定幂等键创建（同用户同入口重放返回
 * 同一 Run，即"恢复"语义）；创建成功后 redirect 到 [runId]。
 *
 * fail closed：learning_run_v1 关闭或无合法参数时不发起创建，只显示返回。
 */

import { Suspense, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import "@/app/styles/learning-run.css";
import "@/components/liquid-orb/liquid-orb.css";
import { LearningRunLivePlayer } from "@/features/learning-run/LearningRunLivePlayer";
import { isLearningRunV1Enabled } from "@/lib/feature-flags";
import {
  CHECKPOINT_V1_KEY,
  loadProjectionCheckpoint,
  type StoredProjectionCheckpoint,
} from "@/features/understanding/projection-client";
import type { CreateLearningRunRequestV1, CreateLearningRunRequestV2, LearningRunOriginV2 } from "@ailearn/shared";
import { notFound } from "next/navigation";

function safePath(candidate: string | null): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  try {
    const decoded = decodeURIComponent(trimmed);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return null;
    const parsed = new URL(decoded, "https://study.local");
    if (parsed.origin !== "https://study.local") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function buildCreateRequest(
  params: URLSearchParams,
): { request: CreateLearningRunRequestV1; returnTo: string } | null {
  const origin = params.get("origin");
  const cardId = params.get("cardId");
  const keyPointId = params.get("keyPointId");
  const scheduleId = params.get("scheduleId");
  const generationRaw = params.get("generation");
  const returnTo = safePath(params.get("returnTo")) ?? "/";
  // 幂等键按天分桶：同一天重复进入复用同一 Run（防重复创建）；次日进入
  // 新 Run（checkpoint/完成的旧 Run 不阻塞新一轮学习）。
  const dayBucket = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `lr-create:${origin ?? "card"}:${keyPointId ?? cardId ?? scheduleId ?? "x"}:${dayBucket}`.slice(0, 200);

  if (origin === "card" && cardId && keyPointId) {
    return {
      request: {
        version: 1,
        origin: { kind: "card", cardId, keyPointId },
        goal: "stabilize",
        clientRequestId: idempotencyKey,
        idempotencyKey,
      },
      returnTo,
    };
  }
  if (origin === "review" && scheduleId && keyPointId && generationRaw) {
    const generation = Number(generationRaw);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    return {
      request: {
        version: 1,
        origin: { kind: "review", scheduleId, keyPointId, scheduleGeneration: generation },
        goal: "stabilize",
        clientRequestId: idempotencyKey,
        idempotencyKey,
      },
      returnTo,
    };
  }
  if (origin === "today" && keyPointId) {
    return {
      request: {
        version: 1,
        origin: { kind: "today", keyPointId },
        goal: "stabilize",
        clientRequestId: idempotencyKey,
        idempotencyKey,
      },
      returnTo,
    };
  }
  if (origin === "onboarding" && keyPointId) {
    // §8.1/§17.4：新手微旅程入口（own_content / sandbox 示例；sandbox 需
    // 服务端签发的 namespace，缺失时服务端 fail closed 拒绝）。
    const sampleMode = params.get("sampleMode") === "sandbox" ? "sandbox" as const : "own_content" as const;
    const sandboxNamespaceId = params.get("sandboxNamespaceId") ?? undefined;
    return {
      request: {
        version: 1,
        origin: {
          kind: "onboarding",
          sampleMode,
          keyPointId,
          ...(sandboxNamespaceId ? { sandboxNamespaceId } : {}),
        },
        goal: "stabilize",
        clientRequestId: idempotencyKey,
        idempotencyKey,
      },
      returnTo,
    };
  }
  if (origin === "star_map" && keyPointId) {
    // P4 结构化：RoutePlan intent=repair_gap → goal=repair（planner 下发
    // repair 结构化主变体）；否则 stabilize。
    const goalParam = params.get("goal");
    const goal = goalParam === "repair" || goalParam === "clarify" || goalParam === "transfer"
      ? goalParam
      : "stabilize";
    // P7 星图行动面：基线 checkpoint 从本地投影缓存读取（useProjectionSync
    // 保存的完整 ProjectionCheckpointV1）；缺失/无效时 fail closed 不发起
    // （服务端还会做作用域/新鲜度二次校验）。
    const routePlanId = params.get("routePlanId") ?? undefined;
    const lens = params.get("lens");
    const lensValue = lens === "evidence" || lens === "provenance" || lens === "issues" || lens === "current_target"
      ? lens
      : "current_target";
    const storedCheckpoint =
      typeof window !== "undefined"
        ? loadProjectionCheckpoint(window.localStorage, "__star_map__")
        : null;
    // userId 键是运行时才知道的；投影缓存按 userId 键存，这里用宽松读取：
    // 扫描 localStorage 里最近一次保存的 checkpoint（key 前缀匹配）。
    const checkpoint = storedCheckpoint ?? readLatestProjectionCheckpoint();
    if (!checkpoint) return null;
    return {
      request: {
        version: 1,
        origin: {
          kind: "star_map",
          keyPointId,
          lens: lensValue,
          filter: { showArchived: false },
          routePlanId,
          baselineCheckpoint: checkpoint,
        },
        goal,
        // P4：repair 路线 → 结构化主变体（planner 按 responsePreference
        // structured 生成 ordering/relation/repair 交互）。
        responsePreference: goal === "repair" ? "structured" as const : undefined,
        clientRequestId: idempotencyKey,
        idempotencyKey,
      },
      returnTo,
    };
  }
  // onboarding sandbox：后端 fail closed，前端同样不提供入口（P6）。
  return null;
}

/**
 * 方案 20 §16.3：V2 PREPARE 入口。
 * 与 V1 互斥，query 使用 `origin=*_v2&objectiveId=...` 形态。
 */
function buildCreateV2Request(
  params: URLSearchParams,
): { request: CreateLearningRunRequestV2; returnTo: string } | null {
  const origin = params.get("origin");
  const cardId = params.get("cardId");
  const objectiveId = params.get("objectiveId");
  const scheduleId = params.get("scheduleId");
  const generationRaw = params.get("generation");
  const returnTo = safePath(params.get("returnTo")) ?? "/";
  const dayBucket = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `lr-create-v2:${origin ?? "x"}:${objectiveId ?? cardId ?? scheduleId ?? "x"}:${dayBucket}`.slice(0, 200);
  const goalParam = params.get("goal");
  const goal = goalParam === "repair" || goalParam === "clarify" || goalParam === "transfer"
    ? goalParam
    : "stabilize";
  const responsePreference = goal === "repair" ? "structured" as const : undefined;

  let originV2: LearningRunOriginV2 | null = null;
  if (origin === "card_v2" && cardId && objectiveId) {
    originV2 = { kind: "card", cardId, objectiveId };
  } else if (origin === "review_v2" && scheduleId && objectiveId && generationRaw) {
    const generation = Number(generationRaw);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    originV2 = { kind: "review", scheduleId, objectiveId, scheduleGeneration: generation };
  } else if (origin === "today_v2" && objectiveId) {
    originV2 = { kind: "today", objectiveId };
  } else if (origin === "star_map_v2" && objectiveId) {
    const routePlanId = params.get("routePlanId") ?? undefined;
    const lens = params.get("lens");
    const lensValue = lens === "evidence" || lens === "provenance" || lens === "issues" || lens === "current_target"
      ? lens
      : "current_target";
    const storedCheckpoint =
      typeof window !== "undefined"
        ? loadProjectionCheckpoint(window.localStorage, "__star_map__")
        : null;
    const checkpoint = storedCheckpoint ?? readLatestProjectionCheckpoint();
    if (!checkpoint) return null;
    originV2 = {
      kind: "star_map",
      objectiveId,
      lens: lensValue,
      filter: { showArchived: false },
      ...(routePlanId ? { routePlanId } : {}),
      baselineCheckpoint: checkpoint,
    };
  } else if (origin === "onboarding_v2" && objectiveId) {
    const sampleMode = params.get("sampleMode") === "sandbox" ? "sandbox" as const : "own_content" as const;
    const sandboxNamespaceId = params.get("sandboxNamespaceId") ?? undefined;
    originV2 = {
      kind: "onboarding",
      sampleMode,
      objectiveId,
      ...(sandboxNamespaceId ? { sandboxNamespaceId } : {}),
    };
  }
  if (!originV2) return null;

  return {
    request: {
      originV2,
      goal,
      ...(responsePreference ? { responsePreference } : {}),
      idempotencyKey,
    },
    returnTo,
  };
}

/** 扫描 localStorage 中最近保存的投影 checkpoint（跨 userId 键宽松读取）。 */
function readLatestProjectionCheckpoint(): StoredProjectionCheckpoint | null {
  if (typeof window === "undefined") return null;
  try {
    let latest: StoredProjectionCheckpoint | null = null;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(CHECKPOINT_V1_KEY)) continue;
      const parsed = loadProjectionCheckpoint(window.localStorage, key.slice(CHECKPOINT_V1_KEY.length));
      if (!parsed) continue;
      if (!latest || parsed.capturedAt > latest.capturedAt) latest = parsed;
    }
    return latest;
  } catch {
    return null;
  }
}

function LearningRunNewEntry() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useMemo(() => new URLSearchParams(searchParams.toString()), [searchParams]);
  const plan = useMemo(() => buildCreateRequest(params), [params]);
  const planV2 = useMemo(() => buildCreateV2Request(params), [params]);

  if (!isLearningRunV1Enabled()) notFound();

  if (!plan && !planV2) {
    return (
      <section className="learning-run-player learning-run-player--error" role="alert">
        <p>该入口尚未开放，或参数不完整。</p>
        <button type="button" onClick={() => router.push("/")}>返回学习首页</button>
      </section>
    );
  }

  return (
    <LearningRunLivePlayer
      create={plan?.request}
      createV2={planV2?.request}
      fallbackReturnTo={plan?.returnTo ?? planV2?.returnTo}
    />
  );
}

export default function LearningRunNewPage() {
  return (
    <Suspense fallback={<div className="learning-run-route-loading" role="status">正在准备学习界面…</div>}>
      <LearningRunNewEntry />
    </Suspense>
  );
}
