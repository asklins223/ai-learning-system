/**
 * M3：proactive 生产触发桥——把业务事件（commit/pause/canonical 变更等）
 * 接到 trigger arbitration（issueSuggestionPermit）+ proactive delivery
 * （createCompanionProactiveDelivery）。
 *
 * 设计约束（合同 §10 / trigger-arbitration）：
 * - reasonId 必须是 COMPANION_TRIGGER_REASONS 注册内的合法 reason，否则跳过；
 * - policy 签名 hash 校验 fail-closed（DEFAULT_TRIGGER_POLICY + hash）；
 * - 抑制链从账号状态派生：global off / suggestion_paused / suppressed class
 *   全由既有 account state 门控；presence 档位只允许 moderate/active（默认
 *   quiet 时所有 reason 被 presence 拦截 → 零打扰）；
 * - 服务端触发的 capabilities 视为"认证即具备"（rule.requiredCapabilityIds
 *   全部满足）、actionManifestValid=true（manifest 已由 shell-actions 冻结）；
 * - deviceSurfaceEpoch = accountEpoch（服务端总是最新世代；global off 后
 *   epoch 递增的迟到业务事件由 issueSuggestionPermit 的 epoch 比较丢弃）；
 * - 全部 fail-closed：任何校验失败只返回 suppressed/skipped，不抛业务异常，
 *   不阻塞触发点主流程。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { getCompanionOverview } from "../companion-shell/service.ts";
import { resolvePresenceLevel } from "../companion-shell/presence-control.ts";
import {
  DEFAULT_TRIGGER_POLICY,
  TriggerArbitrationError,
  computeTriggerPolicyHash,
  createPgTriggerLedgerRepo,
  issueSuggestionPermit,
  resolveTriggerRule,
  type CompanionTriggerReason,
} from "../companion-shell/trigger-arbitration.ts";
import { createCompanionProactiveDelivery, createCompanionProactiveDeliveryInTransaction } from "./companion-proactive-service.ts";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";

export type FireCompanionTriggerResultV1 =
  | { status: "delivered"; deliveryId: string }
  | { status: "suppressed"; reason: string }
  | { status: "skipped"; reason: string };

export interface FireCompanionTriggerArgs {
  workspaceId: string;
  userId: string;
  reasonId: CompanionTriggerReason;
  /** rule.allowedPageKinds 之一；由业务出口派生。 */
  pageKind: string;
  routePattern: string;
  /** canonical 目标/来源稳定标识（服务端派生；不含页面实例/选择）。 */
  canonicalTarget: string;
  canonicalOrigin: string;
  /** canonical 变更单调 epoch（服务端判定；无变更 → 0）。 */
  targetChangeEpoch?: number;
  /** 有界 reason 文案（≤200，仅用户支持/幂等说明，不进画像）。 */
  boundedReason?: string;
}

/**
 * 统一触发入口。fire-and-forget 语义由调用方保证（本函数失败只返回
 * suppressed/skipped；内部错误抛出但调用方应 catch 后静默）。
 */
export async function fireCompanionTrigger(
  args: FireCompanionTriggerArgs,
): Promise<FireCompanionTriggerResultV1> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      // rule 解析 fail-closed：未知 reason 直接跳过。
      const rule = resolveTriggerRule(DEFAULT_TRIGGER_POLICY, args.reasonId);
      if (!rule) {
        return { status: "skipped", reason: "unknown_reason" };
      }

      const overview = await getCompanionOverview(args.userId, args.workspaceId);
      const account = overview.account;
      const accountEpoch = await getCompanionAccountEpoch(tx, args.userId);

      const suppression = {
        authLocalHidden: false, // 服务端触发：会话已认证
        globalOff: account.globalEnabled !== true,
        temporaryHidden: false, // 无设备上下文
        pageMuted: false,
        pageContextOff: false,
        focusUntilTaskEnd: false,
        suggestionPaused: account.suggestionPause?.paused === true,
        suppressedSuggestionClassIds: account.suppression?.suppressedSuggestionClassIds ?? [],
        suggestionClassId: rule.actionManifestId,
      };

      try {
        const permit = await issueSuggestionPermit(
          {
            repo: createPgTriggerLedgerRepo(tx),
            now: () => new Date(),
            idSource: randomUUID,
          },
          {
            userId: args.userId,
            workspaceId: args.workspaceId,
            deviceSessionId: `server://proactive:${args.reasonId}`,
            deviceSurfaceEpoch: accountEpoch,
            accountEpoch,
            reasonId: args.reasonId,
            boundedReason: args.boundedReason,
            pageKind: args.pageKind,
            routePattern: args.routePattern,
            canonicalTarget: args.canonicalTarget,
            canonicalOrigin: args.canonicalOrigin,
            targetChangeEpoch: args.targetChangeEpoch ?? 0,
            cooldownEpoch: 0,
            suggestionClassId: rule.actionManifestId,
            capabilities: [...rule.requiredCapabilityIds],
            actionManifestValid: true,
            suppression,
            presence: resolvePresenceLevel(account.presence?.presence),
            policy: DEFAULT_TRIGGER_POLICY,
            policyHash: computeTriggerPolicyHash(DEFAULT_TRIGGER_POLICY),
          },
        );

        const delivery = await createCompanionProactiveDelivery({
          workspaceId: args.workspaceId,
          userId: args.userId,
          permitId: permit.permitId,
          reasonId: args.reasonId,
          suggestionClassId: rule.actionManifestId,
        });
        const body = delivery.body as { status?: string; deliveryId?: string };
        if (delivery.statusCode === 200 && body.status !== "suppressed") {
          return { status: "delivered", deliveryId: body.deliveryId ?? permit.permitId };
        }
        return { status: "suppressed", reason: body.status ?? "delivery_suppressed" };
      } catch (err) {
        // 抑制/预算/冷却 → 静默跳过；其他错误抛出（触发点调用方 catch 后不阻塞）。
        if (err instanceof TriggerArbitrationError) {
          return { status: "suppressed", reason: err.message };
        }
        throw err;
      }
    },
  );
}

/**
 * M3：worker 进程版触发入口（learning-session commit 等 worker 出口用）。
 * 保持 worker 角色分离：worker 用受限角色 + withWorkerWorkspaceTransaction
 * 传入事务，本函数不经过 API 进程；proactive 逻辑复用
 * createCompanionProactiveDeliveryInTransaction（单一真相）。
 */
export async function fireCompanionTriggerFromWorker(
  tx: { execute<T>(q: unknown): Promise<T[]> },
  args: FireCompanionTriggerArgs,
): Promise<FireCompanionTriggerResultV1> {
  const rule = resolveTriggerRule(DEFAULT_TRIGGER_POLICY, args.reasonId);
  if (!rule) return { status: "skipped", reason: "unknown_reason" };

  const accountRows = await tx.execute<{
    global_enabled: boolean | null;
    presence: { presence?: string } | null;
    suggestion_pause: { paused?: boolean } | null;
    suppression: { suppressedSuggestionClassIds?: string[] } | null;
  }>(sql`
    SELECT global_enabled, presence, suggestion_pause, suppression
    FROM user_companion_account_state WHERE user_id = ${args.userId}
  `);
  const account = accountRows[0] ?? {};
  const accountEpoch = await getCompanionAccountEpoch(tx, args.userId);
  const suppression = {
    authLocalHidden: false,
    globalOff: account.global_enabled !== true,
    temporaryHidden: false,
    pageMuted: false,
    pageContextOff: false,
    focusUntilTaskEnd: false,
    suggestionPaused: account.suggestion_pause?.paused === true,
    suppressedSuggestionClassIds: account.suppression?.suppressedSuggestionClassIds ?? [],
    suggestionClassId: rule.actionManifestId,
  };

  try {
    const permit = await issueSuggestionPermit(
      {
        // drizzle PgTransaction 与窄 execute 接口运行时一致，类型断言。
        repo: createPgTriggerLedgerRepo(tx as never),
        now: () => new Date(),
        idSource: randomUUID,
      },
      {
        userId: args.userId,
        workspaceId: args.workspaceId,
        deviceSessionId: `server://proactive:${args.reasonId}`,
        deviceSurfaceEpoch: accountEpoch,
        accountEpoch,
        reasonId: args.reasonId,
        boundedReason: args.boundedReason,
        pageKind: args.pageKind,
        routePattern: args.routePattern,
        canonicalTarget: args.canonicalTarget,
        canonicalOrigin: args.canonicalOrigin,
        targetChangeEpoch: args.targetChangeEpoch ?? 0,
        cooldownEpoch: 0,
        suggestionClassId: rule.actionManifestId,
        capabilities: [...rule.requiredCapabilityIds],
        actionManifestValid: true,
        suppression,
        presence: resolvePresenceLevel(account.presence?.presence),
        policy: DEFAULT_TRIGGER_POLICY,
        policyHash: computeTriggerPolicyHash(DEFAULT_TRIGGER_POLICY),
      },
    );

    const delivery = await createCompanionProactiveDeliveryInTransaction(tx, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      permitId: permit.permitId,
      reasonId: args.reasonId,
      suggestionClassId: rule.actionManifestId,
    });
    const body = delivery.body as { status?: string; deliveryId?: string };
    if (delivery.statusCode === 200 && body.status !== "suppressed") {
      return { status: "delivered", deliveryId: body.deliveryId ?? permit.permitId };
    }
    return { status: "suppressed", reason: body.status ?? "delivery_suppressed" };
  } catch (err) {
    if (err instanceof TriggerArbitrationError) {
      return { status: "suppressed", reason: err.message };
    }
    throw err;
  }
}
