/**
 * Main ↔ Pet Companion Bridge V2 broker 注册（文档 16 §14.1/§14.2）。
 *
 * Electron main 是唯一 broker：两个 renderer 只拿到窄、强类型 preload API。
 * broker 职责（P5 最小闭环）：
 * - sender 校验（main/pet 角色，复用 requireTrustedSender）；
 * - 页面 context 注册表：pageInstanceId 唯一、revision CAS、30 秒 lease；
 * - UI 事件：eventId/pageSequence 由 broker 生成，renderer 不可自报；
 * - Pet 表面命令 relay（§14.4）：navigation 直接转发；in_page 强制 freshness
 *   字段（targetPageInstanceId + expectedContextRevision）校验后转发；
 * - 窗口销毁 / 账号切换（P5 以窗口销毁为触发）时撤销全部注册。
 *
 * 安全字段（account/workspace/user）不在本层签发——由服务端 hydration 端点
 * （POST /companion/bridge/contexts）以认证 session 覆盖；broker 只做
 * revision 计算（与服务端同一公式，@ailearn/shared/companion-bridge-revision）
 * 与短生命周期 relay。
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import {
  mainCommandResultV2Schema,
  mainPageContextInputV2Schema,
  navigationCommandEnvelopeV2Schema,
  inPageCommandEnvelopeV2Schema,
  type MainPageContextInputV2,
  type MainUiEventV2,
  type NavigationCommandEnvelopeV2,
  type InPageCommandEnvelopeV2,
  type MainCommandResultV2,
} from "@ailearn/shared";
import { computeContextRevisionV2 } from "@ailearn/shared/companion-bridge-revision";
import { requireTrustedSender } from "./validate-sender";
import { COMPANION_BRIDGE_CHANNELS } from "./companion-bridge-channels";
import { logger } from "../logger";

export const BRIDGE_CONTEXT_LEASE_MS = 30_000;

interface BridgeContextRecord {
  contextId: string;
  pageInstanceId: string;
  revision: string;
  expiresAt: number;
  mainWebContentsId: number;
}

export interface CompanionBridgeBrokerContext {
  origin: string;
  getMainWindow(): BrowserWindow | null;
  getPetWindow(): BrowserWindow | null;
}

export function registerCompanionBridgeBroker(context: CompanionBridgeBrokerContext): () => void {
  const records = new Map<string, BridgeContextRecord>(); // contextId → record
  // 二级索引：pageInstanceId → contextId，避免每次 UI/命令事件都把整个
  // registry 展开成数组做线性扫描（compat 于 contextId 主键）。
  const pageInstanceToContextId = new Map<string, string>();
  // 2026-08-16（性能专项）：按 expiresAt 排序的最小堆，只用来定位"最早过期"
  // 的 entry，避免每 30s 全量遍历 records（lazy-deletion：过期时若该 record
  // 已被删除/续期则跳过）。
  const expiresAtHeap: Array<{ expiresAt: number; contextId: string }> = [];
  const heapPush = (entry: { expiresAt: number; contextId: string }): void => {
    expiresAtHeap.push(entry);
    let idx = expiresAtHeap.length - 1;
    const item = expiresAtHeap[idx];
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      const parentItem = expiresAtHeap[parent];
      if (parentItem.expiresAt <= item.expiresAt) break;
      expiresAtHeap[idx] = parentItem;
      idx = parent;
    }
    expiresAtHeap[idx] = item;
  };
  const heapPop = (): { expiresAt: number; contextId: string } | undefined => {
    const heap = expiresAtHeap;
    const root = heap[0];
    const last = heap.pop();
    if (last === undefined) return root;
    if (heap.length === 0) return root;
    // 把原堆最后一个元素移到根位置，再向下 sift 恢复最小堆序
    // （用 item 作参照，避免移动产生的空洞槽位残留旧值干扰比较）。
    heap[0] = last;
    let idx = 0;
    const len = heap.length;
    const item = last;
    for (;;) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      // 以 item 为参照比较左右子节点（idx 是已上移产生的空洞，旧值已无效）。
      if (left < len && heap[left].expiresAt < item.expiresAt) smallest = left;
      if (right < len) {
        const best = smallest === idx ? item.expiresAt : heap[smallest].expiresAt;
        if (heap[right].expiresAt < best) smallest = right;
      }
      if (smallest === idx) break;
      heap[idx] = heap[smallest];
      idx = smallest;
    }
    heap[idx] = item;
    return root;
  };
  // 2026-08-16（性能专项）：撤销/续期会往堆里重复 push 引用，旧引用要等其过期
  // 时间到达才被 sweep 惰性回收——churn 下堆会瞬时膨胀。改在 unregister/renew/
  // publish 后按阈值重建堆，把堆大小约束在存活 record 数的常数倍内。
  const compactExpiresAtHeap = (): void => {
    const entries: Array<{ expiresAt: number; contextId: string }> = [];
    for (const [contextId, record] of records) {
      if (record.expiresAt >= Date.now()) {
        entries.push({ expiresAt: record.expiresAt, contextId });
      }
    }
    expiresAtHeap.length = 0;
    for (const entry of entries) heapPush(entry);
  };
  const maybeCompactExpiresAtHeap = (): void => {
    // 堆里混入的失效引用数 = heap.length - records.size（近似，记录可能已过期）。
    // 超过 2×+16 时重建，避免每次操作都重建（重建 O(n log n)）。
    if (expiresAtHeap.length > records.size * 2 + 16) {
      compactExpiresAtHeap();
    }
  };
  let pageSequence = 0;

  const unregister = (contextId: string, record: BridgeContextRecord | undefined) => {
    records.delete(contextId);
    if (record?.pageInstanceId) {
      pageInstanceToContextId.delete(record.pageInstanceId);
    }
    maybeCompactExpiresAtHeap();
  };

  const sweepExpiredRecords = () => {
    const now = Date.now();
    // 只处理堆顶已过期的 entry；未过期 entry 无需扫描（其余 entry 的过期时间
    // 都更晚）。lazy-deletion：record 已不存在或已被续期（expiresAt 变化）
    // 时跳过即可。
    for (;;) {
      const top = expiresAtHeap[0];
      if (!top || top.expiresAt >= now) break;
      heapPop();
      const record = records.get(top.contextId);
      if (record && record.expiresAt === top.expiresAt) {
        unregister(top.contextId, record);
      }
    }
  };

  const senderId = (role: "main" | "pet"): number | null => {
    const window = role === "main" ? context.getMainWindow() : context.getPetWindow();
    return window && !window.isDestroyed() ? window.webContents.id : null;
  };

  const requireRole = (event: IpcMainInvokeEvent, role: "main" | "pet"): void => {
    requireTrustedSender(event, senderId(role), context.origin, role);
  };

  const petSend = (channel: string, payload: unknown) => {
    const pet = context.getPetWindow();
    if (pet && !pet.isDestroyed()) pet.webContents.send(channel, payload);
  };
  const mainSend = (channel: string, payload: unknown) => {
    const main = context.getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
  };

  const revokeAllForMain = (mainWebContentsId: number) => {
    for (const [key, record] of records) {
      if (record.mainWebContentsId === mainWebContentsId) {
        unregister(key, record);
      }
    }
  };

  // 主窗口销毁：撤销全部 context 与 pending command（§14.2）。
  context.getMainWindow()?.webContents.once("destroyed", () => {
    const main = context.getMainWindow();
    if (main) revokeAllForMain(main.webContents.id);
  });

  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      try {
        return callback(event, ...args);
      } catch (error) {
        logger.warn(
          { channel, error: error instanceof Error ? error.message : String(error) },
          "companion bridge handler rejected",
        );
        return { accepted: false, reasonCode: "invalid_schema" };
      }
    });
  };

  // ─── Main → broker：publish context ────────────────────────────────────
  handle(COMPANION_BRIDGE_CHANNELS.mainPublishContext, (event, rawInput, rawContextId) => {
    requireRole(event, "main");
    const parsed = mainPageContextInputV2Schema.safeParse(rawInput);
    if (!parsed.success) return { accepted: false, reasonCode: "invalid_schema" };
    const input: MainPageContextInputV2 = parsed.data;
    const contextId = typeof rawContextId === "string" && rawContextId.length > 0
      ? rawContextId.slice(0, 200)
      : randomUUID();
    const revision = computeContextRevisionV2(input as never);
    const pageInstanceId = randomUUID();
    const expiresAt = Date.now() + BRIDGE_CONTEXT_LEASE_MS;
    const mainWindow = context.getMainWindow();
    const record: BridgeContextRecord = {
      contextId,
      pageInstanceId,
      revision,
      expiresAt,
      mainWebContentsId: mainWindow?.webContents.id ?? -1,
    };
    records.set(contextId, record);
    pageInstanceToContextId.set(record.pageInstanceId, contextId);
    heapPush({ expiresAt: record.expiresAt, contextId });
    maybeCompactExpiresAtHeap();
    petSend(COMPANION_BRIDGE_CHANNELS.petPageContext, {
      contextId,
      pageInstanceId,
      revision,
      expiresAt: new Date(expiresAt).toISOString(),
      page: input,
    });
    return {
      accepted: true,
      contextId,
      pageInstanceId,
      revision,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });

  // ─── Main → broker：renew / revoke（CAS）────────────────────────────────
  const renewOrRevoke = (event: IpcMainInvokeEvent, raw: unknown, revoke: boolean) => {
    requireRole(event, "main");
    const input = raw as { contextId?: unknown; expectedRevision?: unknown } | null;
    const contextId = typeof input?.contextId === "string" ? input.contextId : "";
    const expectedRevision = typeof input?.expectedRevision === "string" ? input.expectedRevision : "";
    const record = records.get(contextId);
    if (record && record.expiresAt < Date.now()) {
      unregister(contextId, record);
      return revoke ? { revoked: false } : { accepted: false, reasonCode: "expired" };
    }
    if (!record) return revoke ? { revoked: false } : { accepted: false, reasonCode: "expired" };
    if (record.revision !== expectedRevision) return { accepted: false, reasonCode: "stale_context" };
    if (revoke) {
      unregister(contextId, record);
      petSend(COMPANION_BRIDGE_CHANNELS.petPageContext, { contextId, revoked: true });
      return { revoked: true };
    }
    record.expiresAt = Date.now() + BRIDGE_CONTEXT_LEASE_MS;
    heapPush({ expiresAt: record.expiresAt, contextId });
    maybeCompactExpiresAtHeap();
    return { accepted: true, revision: record.revision, expiresAt: new Date(record.expiresAt).toISOString() };
  };
  handle(COMPANION_BRIDGE_CHANNELS.mainRenewContext, (event, raw) => renewOrRevoke(event, raw, false));
  handle(COMPANION_BRIDGE_CHANNELS.mainRevokeContext, (event, raw) => renewOrRevoke(event, raw, true));

  // ─── Main → broker：UI event（eventId/pageSequence 由 broker 生成）──────
  handle(COMPANION_BRIDGE_CHANNELS.mainPublishUiEvent, (event, raw) => {
    requireRole(event, "main");
    const body = raw as {
      pageInstanceId?: unknown;
      contextRevision?: unknown;
      type?: unknown;
      safeRefs?: unknown;
      commandId?: unknown;
    } | null;
    const pageInstanceId = typeof body?.pageInstanceId === "string" ? body.pageInstanceId : "";
    const contextRevision = typeof body?.contextRevision === "string" ? body.contextRevision : "";
    const type = typeof body?.type === "string" ? body.type : "";
    const contextId = pageInstanceToContextId.get(pageInstanceId);
    const record = contextId ? records.get(contextId) : undefined;
    if (!record || record.revision !== contextRevision) {
      return { accepted: false, reasonCode: "stale_context" };
    }
    if (![
      "page.ready", "route.entered", "selection.changed",
      "interaction.started", "interaction.ended", "command.completed",
      "command.rejected", "command.failed", "graph.delta_applied",
    ].includes(type)) {
      return { accepted: false, reasonCode: "invalid_schema" };
    }
    pageSequence += 1;
    const uiEvent: MainUiEventV2 = {
      version: 2,
      eventId: randomUUID(),
      pageInstanceId,
      pageSequence,
      contextRevision,
      commandId: typeof body?.commandId === "string" && body.commandId.length > 0 ? body.commandId : undefined,
      type: type as MainUiEventV2["type"],
      occurredAt: new Date().toISOString(),
      safeRefs: Array.isArray(body?.safeRefs) ? (body.safeRefs as MainUiEventV2["safeRefs"]) : [],
    };
    petSend(COMPANION_BRIDGE_CHANNELS.petUiEvent, uiEvent);
    return { accepted: true, eventId: uiEvent.eventId, pageSequence };
  });

  // ─── Pet → broker → Main：表面命令（§14.4）─────────────────────────────
  handle(COMPANION_BRIDGE_CHANNELS.petDispatchCommand, (event, raw) => {
    requireRole(event, "pet");
    const nav = navigationCommandEnvelopeV2Schema.safeParse(raw);
    if (nav.success) {
      const envelope: NavigationCommandEnvelopeV2 = nav.data;
      if (new Date(envelope.expiresAt).getTime() < Date.now()) {
        return { accepted: false, reasonCode: "expired" };
      }
      mainSend(COMPANION_BRIDGE_CHANNELS.mainCommand, envelope);
      return { accepted: true };
    }
    const inPage = inPageCommandEnvelopeV2Schema.safeParse(raw);
    if (inPage.success) {
      const envelope: InPageCommandEnvelopeV2 = inPage.data;
      if (new Date(envelope.expiresAt).getTime() < Date.now()) {
        return { accepted: false, reasonCode: "expired" };
      }
      // §14.2：页内命令强制 freshness——target pageInstance 必须仍是当前
      // revision（旧 pageInstance/revision 一律拒绝）。
      const targetContextId = pageInstanceToContextId.get(envelope.targetPageInstanceId);
      const record = targetContextId ? records.get(targetContextId) : undefined;
      if (!record) return { accepted: false, reasonCode: "stale_context" };
      if (record.revision !== envelope.expectedContextRevision) {
        return { accepted: false, reasonCode: "stale_context" };
      }
      mainSend(COMPANION_BRIDGE_CHANNELS.mainCommand, envelope);
      return { accepted: true };
    }
    return { accepted: false, reasonCode: "invalid_schema" };
  });

  // ─── Main → broker → Pet：命令结果回执 ─────────────────────────────────
  handle(COMPANION_BRIDGE_CHANNELS.mainReportCommandResult, (event, raw) => {
    requireRole(event, "main");
    const parsed = mainCommandResultV2Schema.safeParse(raw);
    if (!parsed.success) return { accepted: false, reasonCode: "invalid_schema" };
    const result: MainCommandResultV2 = parsed.data;
    petSend(COMPANION_BRIDGE_CHANNELS.petUiEvent, {
      version: 2,
      eventId: randomUUID(),
      pageSequence: 0,
      commandId: result.commandId,
      type: result.status === "completed"
        ? "command.completed"
        : result.status === "rejected"
          ? "command.rejected"
          : result.status === "failed"
            ? "command.failed"
            : "command.completed",
      occurredAt: result.occurredAt,
      safeRefs: result.resultRefs,
      commandResult: result,
    });
    return { accepted: true };
  });

  const sweepTimer = setInterval(sweepExpiredRecords, BRIDGE_CONTEXT_LEASE_MS);
  sweepTimer.unref?.();

  return () => {
    clearInterval(sweepTimer);
    for (const channel of Object.values(COMPANION_BRIDGE_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
