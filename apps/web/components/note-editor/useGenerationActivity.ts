/**
 * Phase B（设计 §6.2）：Agent 活动流增量轮询 Hook。
 *
 * - 仅当控制台打开且 flag 开启时轮询 `/agent-events`；关闭即停。
 * - `since` 游标由服务端推进（`nextCursor`），客户端只按 `eventKey`
 *   幂等去重，避免页边界重复。
 * - 内存只保留最近 500 条（环形截断）；seen 集合记录全部已见 key
 *   （数量受 run 事件总量上界约束，安全）。
 * - 复用 run 轮询的 token 竞态保护与 visibility 节奏；5xx 指数退避
 *   （上限 30s），4xx 降级停止（run 视图轮询不受影响）。
 */

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AgentEventView } from "@/lib/api";

export const AGENT_EVENT_PAGE_SIZE = 200;
export const AGENT_EVENT_MAX_BUFFER = 500;
export const AGENT_EVENT_MAX_PAGES_PER_TICK = 5;
const ACTIVE_POLL_DELAY_MS = 3000;
const HIDDEN_POLL_DELAY_MS = 5000;
const DRAIN_DELAY_MS = 400;
const MAX_BACKOFF_MS = 30_000;

export interface GenerationActivityContext {
  /** 特性开关（AGENT_ACTIVITY_STREAM_ENABLED） */
  enabled: boolean;
  /** 控制台是否打开（打开才轮询） */
  open: boolean;
  /** 当前 run id（null 表示无 run） */
  runId: string | null;
  /** run 是否仍在运行（终态后只做一次收尾拉取） */
  active: boolean;
  /** 瞬时同步失败回调（写入 genMessage 渠道） */
  onTransientError?: (message: string) => void;
}

export interface GenerationActivityControls {
  events: AgentEventView[];
  loading: boolean;
  error: string | null;
}

/**
 * 增量合并：按 eventKey 去重追加，超出上限丢弃最早事件。
 * 纯函数：不修改 `buffer`/`seen` 入参（seen 以 ReadonlySet 传入）。
 * 调用方负责把本页新 key 登记进 seen（见 mergePage）。
 * 导出为纯函数便于单测。
 */
export function mergeAgentEvents(
  buffer: AgentEventView[],
  incoming: AgentEventView[],
  seen: ReadonlySet<string>,
  max = AGENT_EVENT_MAX_BUFFER,
): AgentEventView[] {
  if (incoming.length === 0) return buffer;
  const existingKeys = new Set(buffer.map((event) => event.eventKey));
  const fresh = incoming.filter(
    (event) => !seen.has(event.eventKey) && !existingKeys.has(event.eventKey),
  );
  const merged = [...buffer, ...fresh];
  return merged.length > max ? merged.slice(-max) : merged;
}

export function useGenerationActivity(ctx: GenerationActivityContext): GenerationActivityControls {
  const { enabled, open, runId, active, onTransientError } = ctx;
  const [events, setEvents] = useState<AgentEventView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  // events 的同步镜像：合并结果先算在 ref 上，再以值形式 setEvents。
  // 避免在 setEvents 函数式更新里调用读 seen 的合并逻辑（StrictMode dev
  // 双调用更新函数，第二次调用时 seen 已被填充，导致合并结果被清空）。
  const eventsRef = useRef<AgentEventView[]>([]);
  const onTransientErrorRef = useRef(onTransientError);
  onTransientErrorRef.current = onTransientError;

  // run 切换时重置游标与缓冲。
  useEffect(() => {
    cursorRef.current = null;
    seenRef.current.clear();
    eventsRef.current = [];
    setEvents([]);
    setError(null);
  }, [runId]);

  useEffect(() => {
    if (!enabled || !open || !runId) return;

    const token = tokenRef.current + 1;
    tokenRef.current = token;
    const controller = new AbortController();
    let cancelled = false;
    let backoffMs = 1500;

    const mergePage = (page: AgentEventView[]) => {
      // 用 eventsRef 同步镜像计算合并结果，再以值形式 setEvents：
      // 避免把会读 seen 的 mergeAgentEvents 放进函数式更新里
      // （StrictMode dev 双调用函数式更新，seen 是跨调用共享的引用，
      // 第二次调用时 seen 已被填充，结果被错误清空）。
      const next = mergeAgentEvents(eventsRef.current, page, seenRef.current);
      for (const event of page) seenRef.current.add(event.eventKey);
      eventsRef.current = next;
      setEvents(next);
    };

    /** 拉取一页；返回是否还有后续页。 */
    const fetchPage = async (signal: AbortSignal): Promise<boolean> => {
      const page = await api.getCardGenerationAgentEvents(runId!, {
        since: cursorRef.current ?? undefined,
        limit: AGENT_EVENT_PAGE_SIZE,
        signal,
      });
      if (cancelled || token !== tokenRef.current) return false;
      mergePage(page.items);
      cursorRef.current = page.nextCursor;
      return page.hasMore;
    };

    const drain = async (signal: AbortSignal): Promise<boolean> => {
      let more = false;
      for (let guard = 0; guard < AGENT_EVENT_MAX_PAGES_PER_TICK; guard++) {
        more = await fetchPage(signal);
        if (cancelled || token !== tokenRef.current) return false;
        if (!more) break;
      }
      return more;
    };

    const tick = async () => {
      if (cancelled || token !== tokenRef.current) return;
      setLoading(true);
      let more = false;
      let transientFailure = false;
      try {
        more = await drain(controller.signal);
        if (cancelled || token !== tokenRef.current) return;
        setLoading(false);
        setError(null);
        backoffMs = 1500;
        // 仅当 run 终态时停止轮询（收尾拉取后结束）。
        // 活动 run 即使当前没有更多事件（worker 尚未写入/已到尾部）
        // 也要继续按节奏轮询，等待新事件出现。
        if (!active) return;
      } catch (err) {
        if (cancelled || token !== tokenRef.current) return;
        setLoading(false);
        if (err instanceof ApiError && err.status === 404) {
          setError("生成任务已不存在");
          return;
        }
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          // 4xx：降级停止 agent 轮询，run 视图轮询不受影响。
          setError("代理活动流暂不可用");
          return;
        }
        // 5xx/网络：指数退避后重试。
        transientFailure = true;
        setError("暂时无法同步代理活动");
        onTransientErrorRef.current?.("暂时无法同步代理活动；任务仍在后台运行，你可以继续编辑。");
      }
      const baseDelay = more
        ? DRAIN_DELAY_MS
        : document.visibilityState === "hidden"
          ? HIDDEN_POLL_DELAY_MS
          : ACTIVE_POLL_DELAY_MS;
      const delay = transientFailure ? backoffMs : baseDelay;
      if (transientFailure) {
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      }
      // 2026-08-11：timer 存局部变量供 cleanup 清除——此前 setTimeout 未入
      // ref，runId/open/active 频繁变化时旧定时器仍触发一次空 tick（靠 token
      // 兜底不污染状态，但属于未清理的挂起任务）。
      timer = window.setTimeout(() => {
        void tick();
      }, delay);
    };

    let timer: number | null = null;
    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, open, runId, active]);

  return { events, loading, error };
}
