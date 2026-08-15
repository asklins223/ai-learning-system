/**
 * Understanding Projection V2 前端消费（文档 16 §15 客户端语义）。
 *
 * - checkpoint-aware 拉取：本地保存最新 checkpoint token；minimumCheckpoint
 *   不可满足时服务端返回 202，客户端保持旧投影（绝不偷偷用旧图冒充新图）；
 * - delta 显影：changeSetId 只作为"哪些节点该显影"的注释，绝不把 before/after
 *   当补丁覆盖更新状态；动画层本地保存 (userId, deviceSessionId, changeSetId)
 *   receipt，同设备只播放一次；
 * - 客户端禁止自行 diff 两次 graph JSON 后声称掌握提升。
 */

export interface ProjectionFetchResult {
  status: "ready" | "pending";
  checkpointToken: string | null;
  data: unknown | null;
  retryAfterMs: number | null;
}

/** 解析投影拉取响应（200 投影 / 202 pending）。 */
export function parseProjectionResponse(
  payload: unknown,
  httpStatus: number,
): ProjectionFetchResult {
  if (httpStatus === 202) {
    return { status: "pending", checkpointToken: null, data: null, retryAfterMs: null };
  }
  const projection = payload as {
    version?: number;
    checkpoint?: { token?: string } | null;
  } | null;
  return {
    status: "ready",
    checkpointToken: projection?.checkpoint?.token ?? null,
    data: projection ?? null,
    retryAfterMs: null,
  };
}

/** 单次 refresh 的分页上限（页大小服务端 400/页；20 页 ≈ 8000 kp）。 */
export const MAX_PROJECTION_PAGES = 20;

/**
 * 合并分页投影（服务端 workspace_map 游标分页；§15.2 slice.continuationToken）。
 * - 节点按 nodeRef 去重、边按 edgeId 去重（跨页共有的 card/note/source 节点
 *   只在第一页的 kp 对应卡片上出现，但去重保证幂等合并）；
 * - checkpoint 取最后一页（同一 watermark 下每页签发一致）；
 * - slice.continuationToken 收敛为 null（已完整合并）。
 * 任何一页形状非法 → null（调用方 fail closed）。
 */
export function mergeProjectionPages(pages: unknown[]): unknown | null {
  if (pages.length === 0) return null;
  const first = pages[0] as {
    nodes?: unknown[];
    edges?: unknown[];
    checkpoint?: unknown;
    slice?: { kind?: string };
    planes?: unknown;
    request?: unknown;
    currentTarget?: unknown;
    version?: unknown;
    generatedAt?: unknown;
  } | null;
  if (!first || typeof first !== "object") return null;
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  for (const page of pages) {
    const p = page as { nodes?: unknown[]; edges?: unknown[] };
    if (!p || typeof p !== "object" || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) return null;
    for (const node of p.nodes) {
      // nodeRef 字段顺序由服务端固定；JSON key 序列化顺序稳定。
      const key = JSON.stringify((node as { nodeRef?: unknown })?.nodeRef ?? node);
      if (seenNodes.has(key)) continue;
      seenNodes.add(key);
      nodes.push(node);
    }
    for (const edge of p.edges) {
      const edgeId = (edge as { edgeId?: unknown })?.edgeId;
      if (typeof edgeId !== "string" || seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      edges.push(edge);
    }
  }
  const last = pages[pages.length - 1] as { checkpoint?: unknown };
  return {
    ...first,
    checkpoint: last?.checkpoint ?? first.checkpoint,
    nodes,
    edges,
    slice: { kind: first.slice?.kind ?? "workspace_map", continuationToken: null },
  };
}

export interface DeltaReceiptStore {
  has: (userId: string, deviceSessionId: string, changeSetId: string) => boolean;
  mark: (userId: string, deviceSessionId: string, changeSetId: string) => void;
}

const RECEIPT_KEY_PREFIX = "understanding-delta-receipt:";
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage receipt 实现（§15.5：同设备只播放一次）。 */
export function createLocalDeltaReceiptStore(storage: Storage): DeltaReceiptStore {
  const key = (userId: string, deviceSessionId: string, changeSetId: string) =>
    `${RECEIPT_KEY_PREFIX}${userId}:${deviceSessionId}:${changeSetId}`;
  return {
    has(userId, deviceSessionId, changeSetId) {
      const raw = storage.getItem(key(userId, deviceSessionId, changeSetId));
      if (!raw) return false;
      const at = Number(raw);
      return Number.isFinite(at) && Date.now() - at < RECEIPT_TTL_MS;
    },
    mark(userId, deviceSessionId, changeSetId) {
      // F13（round4）：写入新回执前先修剪本设备已过期的回执 key——防止每个动画
      // 过的 changeSetId 永久留 key（has 只查 TTL 从不删除）造成无界增长。
      // 只在写路径扫描一次，且扫描范围收敛到 "当前用户:当前设备" 前缀。
      const devicePrefix = `${RECEIPT_KEY_PREFIX}${userId}:${deviceSessionId}:`;
      const now = Date.now();
      try {
        for (let i = storage.length - 1; i >= 0; i -= 1) {
          const storageKey = storage.key(i);
          if (!storageKey || !storageKey.startsWith(devicePrefix)) continue;
          const raw = storage.getItem(storageKey);
          if (raw == null) continue;
          const at = Number(raw);
          if (!Number.isFinite(at) || now - at >= RECEIPT_TTL_MS) {
            storage.removeItem(storageKey);
          }
        }
      } catch {
        // 存储访问异常（私密模式等）时静默降级为仅写入新 key。
      }
      storage.setItem(key(userId, deviceSessionId, changeSetId), String(now));
    },
  };
}

/** delta 是否应显影（同设备同 changeSetId 只一次；§15.5）。 */
export function shouldAnimateDelta(
  store: DeltaReceiptStore,
  input: { userId: string; deviceSessionId: string; changeSetId: string },
): boolean {
  return !store.has(input.userId, input.deviceSessionId, input.changeSetId);
}

/** 投影 checkpoint 本地保存（换设备恢复语义目标；不保存图内容）。
 *
 * 2026-08-14（P7 星图发起 Run）：checkpoint 保存从裸 token 升级为完整
 * ProjectionCheckpointV1 对象（version/workspaceId/userId/token/capturedAt）——
 * 发起 star_map origin 的 LearningRun 需要完整基线（wire 合同
 * projectionCheckpointSchema）。旧裸 token 数据自动迁移。
 */
export const CHECKPOINT_TOKEN_KEY = "understanding-projection-checkpoint-token:";
export const CHECKPOINT_V1_KEY = "understanding-projection-checkpoint-v1:";

export interface StoredProjectionCheckpoint {
  version: 1;
  workspaceId: string;
  userId: string;
  token: string;
  capturedAt: string;
}

export function saveCheckpointToken(storage: Storage, userId: string, token: string | null): void {
  const key = `${CHECKPOINT_TOKEN_KEY}${userId}`;
  if (token) {
    storage.setItem(key, token);
  } else {
    // null 表示清除该用户的本地 checkpoint（fail closed：不再持有旧 token）。
    storage.removeItem(key);
  }
}

export function loadCheckpointToken(storage: Storage, userId: string): string | null {
  return storage.getItem(`${CHECKPOINT_TOKEN_KEY}${userId}`);
}

export function saveProjectionCheckpoint(
  storage: Storage,
  userId: string,
  checkpoint: StoredProjectionCheckpoint | null,
): void {
  if (!checkpoint) return;
  storage.setItem(`${CHECKPOINT_V1_KEY}${userId}`, JSON.stringify(checkpoint));
}

export function loadProjectionCheckpoint(
  storage: Storage,
  userId: string,
): StoredProjectionCheckpoint | null {
  const raw = storage.getItem(`${CHECKPOINT_V1_KEY}${userId}`);
  if (!raw) {
    // 迁移：旧裸 token → 结构缺 workspaceId/userId，不可直接用于发起 Run，
    // 返回 null（下次投影拉取会补全）。
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredProjectionCheckpoint;
    if (parsed.version !== 1 || typeof parsed.token !== "string" || typeof parsed.workspaceId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
