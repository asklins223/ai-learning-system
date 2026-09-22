/**
 * 每个学习空间最后一次被**进入**的时间——本机记忆，空间菜单据此把最近用过的排在
 * 各分组的前面。`workspace.list` 只按数据库顺序全量返回，20 个空间下"上次去的那个"
 * 没有任何线索，这份记录就是那条线索。
 *
 * 为什么落在 localStorage 而不是 `room-store`：这条记录跨工作区、跨重启都成立
 * （"我昨天进过海岸研究室"），而 room-store 持久化的是这台设备上的房间偏好，它的
 * `resetWorkspaceScope` 又专门清工作区级状态——把跨工作区的使用痕迹挂进去，下次
 * 谁给那张重置列表补字段就会连它一起清掉。这里沿用 `source-intake.ts` 的本机存储
 * 写法：读不出来就当没有，写不进去（配额满）也不挡切换。
 *
 * 键按 `workspaceId` 记，不按账号记：同一台机器上换过账号，能同时出现在两份列表里
 * 的只有双方真正共同所属的空间，而"这台设备上最近进过它"对双方都成立。
 */
const SPACE_RECENTS_KEY = "ailearn:space-recents";

/** 记录上限：更近的一次会覆盖旧值，留最近这些个足够排序，也不让记录无限长大。 */
const MAX_SPACE_RECENTS = 60;

type RecentsStorage = Pick<Storage, "getItem" | "setItem">;

/** workspaceId → 最后一次进入的 epoch 毫秒。 */
export type SpaceRecents = Readonly<Record<string, number>>;

function defaultStorage(): RecentsStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 手改过或旧版本残留的 localStorage 不该让菜单打不开：结构不对就当没有记录。 */
export function readSpaceRecents(storage: RecentsStorage | null = defaultStorage()): SpaceRecents {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SPACE_RECENTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const recents: Record<string, number> = {};
    for (const [workspaceId, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) recents[workspaceId] = at;
    }
    return recents;
  } catch {
    return {};
  }
}

/**
 * 记下一次真实进入（`workspace.switch` 成功，或新建后主进程直接进入新空间）。
 * 返回合并后的完整记录，调用方直接拿去当新的排序依据——不必再读一遍存储。
 */
export function markSpaceUsed(
  workspaceId: string,
  at: number = Date.now(),
  storage: RecentsStorage | null = defaultStorage(),
): SpaceRecents {
  const recents: Record<string, number> = { ...readSpaceRecents(storage), [workspaceId]: at };
  const trimmed: Record<string, number> = Object.fromEntries(
    Object.entries(recents)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_SPACE_RECENTS),
  );
  if (storage) {
    try {
      storage.setItem(SPACE_RECENTS_KEY, JSON.stringify(trimmed));
    } catch {
      // 配额满了就只记这次会话，不挡切换。
    }
  }
  return trimmed;
}
