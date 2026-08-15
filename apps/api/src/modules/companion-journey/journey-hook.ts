/**
 * Journey 里程碑挂钩（P6 剩余：source/note 等 api 侧创建路径）。
 *
 * 与 Run 结算挂钩同一模式：同事务原子（创建与 Journey 推进同时成功或整体
 * 回滚重试）。无 active Journey 时零开销返回。
 */

import type { ApiTransaction } from "../../db/client.ts";

export async function hookJourneyEntityCreated(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  input: { eventType: string; entityId: string; payload?: Record<string, unknown> },
  now: Date = new Date(),
): Promise<void> {
  const { findActiveJourney, applyJourneyDomainEvent } = await import("./journey-service.ts");
  const journey = await findActiveJourney(tx, scope);
  if (!journey) return;
  await applyJourneyDomainEvent(tx, scope, {
    journeyId: journey.journeyId,
    domainEventId: `${input.eventType}:${input.entityId}`,
    eventType: input.eventType,
    // entityId 最后写入：调用方 payload 不得覆盖（事件 id 一致性）。
    payload: { ...(input.payload ?? {}), entityId: input.entityId },
  }, now);
}
