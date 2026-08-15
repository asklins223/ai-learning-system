"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCompanionBootstrap } from "@/features/companion-pet/bootstrap";
import { openCompanionSse } from "@/features/companion-pet/conversation/fetch-sse";
import {
  mergeMessages,
  seqFromEventId,
  textFromBlocks,
  type Conversation,
  type Message,
} from "./conversation-model";

/**
 * 完整对话页数据逻辑（从 page.tsx 原样迁移，行为不变）：
 * 列表加载、会话切换、发送、SSE 增量续接、删除、防旧会话混入。
 */

function randomUuid(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useCompanionConversations(requestedConversationId: string | null) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(requestedConversationId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // 2026-08-11：SSE 重连游标——跟踪已收到的最大事件 seq，断线重连时
  // 以 after=lastSeq 增量续接，避免重复或丢事件。
  const lastSeqRef = useRef<number>(0);
  // FN1：assistant.delta 的 rAF 聚合——一个帧内多个 delta 合并为一次
  // setMessages，避免每个 SSE 事件都整树重渲 + 历史全量 Markdown 重解析。
  // pendingDeltaRef: runId -> 本帧内累积的 delta 文本；deltaRafRef: 已排队的 rAF。
  const pendingDeltaRef = useRef<Map<string, string>>(new Map());
  const deltaRafRef = useRef<number | null>(null);
  // FN10：assistant.final 重试的 500ms 退避定时器句柄——存入 ref 并在
  // 卸载/中止时清除（bounded ≤2 次，此处仅补句柄管理）。
  const reloadRetryTimerRef = useRef<number | null>(null);
  // F#7（🟡19）：SSE 断线重连（onError 内 streamWithRetry）的重试定时器句柄。
  // 存入 ref 并在卸载/中止时清除，避免重连风暴期间累积悬置定时器。
  const streamRetryTimerRef = useRef<number | null>(null);
  const flushPendingDeltas = useCallback(() => {
    if (deltaRafRef.current !== null) {
      cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    if (pendingDeltaRef.current.size === 0) return;
    const deltas = pendingDeltaRef.current;
    pendingDeltaRef.current = new Map();
    setMessages((current) => {
      let next = current;
      deltas.forEach((delta, runId) => {
        const pendingId = `assistant-${runId}`;
        const existing = next.find((item) => item.id === pendingId);
        if (existing) {
          next = next.map((item) => item.id === pendingId
            ? { ...item, blocks: [{ type: "text", text: `${textFromBlocks(item.blocks)}${delta}` }] }
            : item);
        } else {
          next = [...next, {
            id: pendingId,
            role: "assistant",
            seq: Number.MAX_SAFE_INTEGER,
            blocks: [{ type: "text", text: delta }],
            createdAt: new Date().toISOString(),
          }];
        }
      });
      return next;
    });
  }, []);
  // 2026-08-11：当前选中会话快照——在途 fetch（loadMessages/reloadAfterFinal）
  // 返回时校验会话未切换，杜绝旧对话结果混入新视图。
  const selectedIdRef = useRef<string | null>(requestedConversationId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const loadConversations = useCallback(async (): Promise<Conversation[]> => {
    const response = await fetch("/api/companion/conversations?kind=dialogue&status=active&limit=50", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`conversation list failed: ${response.status}`);
    const body = (await response.json()) as { items?: Conversation[] };
    return Array.isArray(body.items) ? body.items : [];
  }, []);

  async function fetchMessages(conversationId: string): Promise<{ items: Message[]; hasMore: boolean }> {
    const response = await fetch(`/api/companion/conversations/${conversationId}/messages?limit=100`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`message list failed: ${response.status}`);
    const body = (await response.json()) as { items?: Message[]; hasMore?: boolean };
    return {
      items: Array.isArray(body.items) ? body.items : [],
      hasMore: Boolean(body.hasMore),
    };
  }

  const loadMessages = useCallback(
    async (conversationId: string, keepAssistantRunId?: string): Promise<void> => {
      // 2026-08-11（review 修复）：在途 fetch 返回时会话已切换（selectedIdRef
      // 比对）则丢弃——旧对话结果不混入新视图。
      const incoming = await fetchMessages(conversationId);
      if (selectedIdRef.current !== conversationId) return;
      setOlderAvailable(incoming.hasMore);
      setMessages((current) => mergeMessages(current, incoming.items, keepAssistantRunId));
    },
    [],
  );

  // 2026-08-11：assistant.final 后精确重拉——以 final payload 的 messageId 判断
  // 服务端是否已持久化该轮；未达时退避重试（最多 2 次），期间保留占位副本。
  async function reloadAfterFinal(
    conversationId: string,
    messageId: string | null,
    runId: string,
    retries = 2,
    // 2026-08-11（review 修复）：controller 作为参数传入递归——所有轮次
    // 检查同一个引用（发送新消息会替换 streamAbortRef.current，每轮重捕获
    // 会漏掉"等待期间 abort + 新发送"的残余窗口）。
    controller: AbortController | null = streamAbortRef.current,
  ): Promise<void> {
    const aborted = () => Boolean(controller?.signal.aborted);
    if (aborted()) return;
    const incoming = await fetchMessages(conversationId);
    if (aborted()) return;
    // 2026-08-11：会话已切换/删除——丢弃重拉结果
    if (selectedIdRef.current !== conversationId) return;
    const hasFinal = messageId !== null && incoming.items.some((m) => m.id === messageId);
    setMessages((current) => mergeMessages(current, incoming.items, hasFinal ? undefined : runId));
    if (!hasFinal && retries > 0 && !aborted()) {
      // FN10：定时器句柄存入 ref，卸载/中止时清除。
      reloadRetryTimerRef.current = window.setTimeout(() => {
        reloadRetryTimerRef.current = null;
        // 等待期间可能已 abort——递归前再查一次
        if (aborted()) return;
        return reloadAfterFinal(conversationId, messageId, runId, retries - 1, controller);
      }, 500);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bootstrap = await fetchCompanionBootstrap();
        if (cancelled) return;
        setEnabled(bootstrap.features.textConversation);
        if (!bootstrap.features.textConversation) return;
        const items = await loadConversations();
        if (cancelled) return;
        setConversations(items);
        const nextId = requestedConversationId && items.some((item) => item.id === requestedConversationId)
          ? requestedConversationId
          : items[0]?.id ?? null;
        setSelectedId(nextId);
      } catch {
        if (!cancelled) setError("暂时无法加载对话，请稍后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // FN1：卸载时取消未触发的 rAF 并 flush 残余 delta，保证最后一帧文本不丢。
      flushPendingDeltas();
      // FN10：清除 assistant.final 重试的 500ms 退避定时器。
      if (reloadRetryTimerRef.current !== null) {
        window.clearTimeout(reloadRetryTimerRef.current);
        reloadRetryTimerRef.current = null;
      }
      // F#7（🟡19）：清除 SSE onError 重连的重试定时器。
      if (streamRetryTimerRef.current !== null) {
        window.clearTimeout(streamRetryTimerRef.current);
        streamRetryTimerRef.current = null;
      }
      streamAbortRef.current?.abort();
    };
  }, [flushPendingDeltas, loadConversations, requestedConversationId]);

  useEffect(() => {
    if (!selectedId || enabled !== true) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }
    // 2026-08-11（review 修复）：切换对话前先清空 + 中止旧流——否则
    // loadMessages 合并时混入上一对话消息，且旧 SSE 流 delta 事件会写入新对话视图。
    // FN1：先 flush 残余 delta，避免清空后残留 rAF 把旧会话文本写进新视图。
    flushPendingDeltas();
    streamAbortRef.current?.abort();
    setError(null);
    setMessages([]);
    setMessagesLoading(true);
    void loadMessages(selectedId)
      .catch(() => {
        if (selectedIdRef.current === selectedId) setError("暂时无法加载这段对话。");
      })
      .finally(() => {
        if (selectedIdRef.current === selectedId) setMessagesLoading(false);
      });
  }, [enabled, loadMessages, selectedId]);

  async function createConversation(): Promise<string> {
    const response = await fetch("/api/companion/conversations", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, kind: "dialogue" }),
    });
    if (!response.ok) throw new Error(`conversation create failed: ${response.status}`);
    const conversation = (await response.json()) as Conversation;
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
    setSelectedId(conversation.id);
    return conversation.id;
  }

  // 2026-08-11：SSE 带重连的流——断线（network/server/rate_limited）时以
  // after=lastSeq 增量续接（最多重试 2 次，指数退避）；fatal/auth/cursor 类
  // 错误不重试。重连期间 controller 保持引用（删除/切换对话可中止）。
  async function streamWithRetry(opts: {
    conversationId: string;
    controller: AbortController;
    runId: string;
    generation: number;
    after: number;
    attempt: number;
  }): Promise<void> {
    const { controller, runId, generation } = opts;
    await openCompanionSse({
      conversationId: opts.conversationId,
      after: opts.after,
      lastEventId: null,
      signal: controller.signal,
      callbacks: {
        onEvent(event) {
          if (event.runId !== runId || event.generation !== generation) return;
          // 2026-08-11：防御性会话过滤——即使 abort 竞态下旧流事件到达，
          // 也不写入其他对话视图。
          if (event.conversationId && event.conversationId !== opts.conversationId) return;
          const seq = seqFromEventId(event.id);
          if (seq > lastSeqRef.current) lastSeqRef.current = seq;
          if (event.type === "assistant.delta") {
            const delta = (event.payload as { textDelta?: unknown }).textDelta;
            if (typeof delta !== "string") return;
            // FN1：rAF 聚合——合并本帧多个 delta 为一次 setMessages。
            pendingDeltaRef.current.set(runId, (pendingDeltaRef.current.get(runId) ?? "") + delta);
            if (deltaRafRef.current === null) {
              deltaRafRef.current = requestAnimationFrame(() => flushPendingDeltas());
            }
          }
          if (event.type === "assistant.final") {
            // 缝隙2（round3）：final 到达当帧、rAF 尚未触发时，最后一段 delta
            // 仍停在 pendingDeltaRef——这里先 flush 本帧残余 delta，使占位文本
            // 完整落到视图再处理 final（与 companion-chat-client 在 final 前
            // flushDeltas() 的语义对齐）。
            flushPendingDeltas();
            // 2026-08-11（review 修复）：final 前清 user 的 pending-* 副本——
            // 服务端已持久化本轮消息，重载时以正式消息为准；assistant 副本
            // 由 reloadAfterFinal 按 messageId 精确替换/占位保留。
            setMessages((current) => current.filter((m) => !m.id.startsWith("pending-")));
            const finalPayload = event.payload as { messageId?: unknown };
            const finalMessageId = typeof finalPayload.messageId === "string" ? finalPayload.messageId : null;
            void reloadAfterFinal(opts.conversationId, finalMessageId, runId).catch(() => {
              setError("本轮消息已发送，但刷新对话失败。");
            });
            void loadConversations().then(setConversations).catch(() => {});
          }
        },
        onError(error) {
          if (controller.signal.aborted) return;
          const retriable = error.kind === "network"
            || error.kind === "server"
            || error.kind === "rate_limited";
          if (retriable && opts.attempt < 2) {
            const delay = error.retryAfterMs ?? 500 * (2 ** opts.attempt);
            if (streamRetryTimerRef.current !== null) {
              window.clearTimeout(streamRetryTimerRef.current);
            }
            streamRetryTimerRef.current = window.setTimeout(() => {
              streamRetryTimerRef.current = null;
              if (!controller.signal.aborted) {
                void streamWithRetry({
                  ...opts,
                  after: lastSeqRef.current,
                  attempt: opts.attempt + 1,
                }).catch(() => {});
              }
            }, delay);
            return;
          }
          setError("对话连接中断，已保留已发送内容；可重新打开此对话继续查看。");
        },
      },
    });
  }

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!text || sending || enabled !== true) return;
    setSending(true);
    setError(null);
    // FN1：发新消息前把残余 delta 落到视图再中断旧流，避免文本丢失。
    flushPendingDeltas();
    streamAbortRef.current?.abort();
    // 2026-08-11（review 修复）：controller 在会话建立后再创建——此前在
    // createConversation 前创建，其 setSelectedId 触发切换 effect 会 abort
    // 掉刚创建的 controller，导致新用户首条消息（无会话时）turns POST 被取消、
    // 静默失败且无提示（需再点一次）。
    let controller: AbortController | null = null;
    try {
      const conversationId = selectedId ?? await createConversation();
      controller = new AbortController();
      streamAbortRef.current = controller;
      const response = await fetch(`/api/companion/conversations/${conversationId}/turns`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUuid(),
        },
        body: JSON.stringify({
          version: 1,
          clientMessageId: randomUuid(),
          inputKind: "text",
          blocks: [{ type: "text", text }],
          sourceSurface: "web_fallback",
        }),
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        runId?: string;
        generation?: number;
        eventCursor?: number;
      };
      if (!response.ok || !body.runId || typeof body.generation !== "number" || typeof body.eventCursor !== "number") {
        throw new Error("turn submit failed");
      }
      setDraft("");
      setMessages((current) => [
        ...current,
        { id: `pending-${randomUuid()}`, role: "user", seq: Number.MAX_SAFE_INTEGER, blocks: [{ type: "text", text }], createdAt: new Date().toISOString() },
      ]);
      await streamWithRetry({
        conversationId,
        controller,
        runId: body.runId,
        generation: body.generation,
        after: body.eventCursor,
        attempt: 0,
      });
    } catch {
      if (!controller?.signal.aborted) setError("这次消息没有送达，请稍后重试。草稿已保留。");
    } finally {
      setSending(false);
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selectedId) return;
    // 2026-08-11：删除前中止进行中的 SSE 流——否则删除后事件仍写入
    // setMessages（残留在新选中对话或已删对话的消息）。
    // FN1：先 flush 残余 delta，避免删除后残留 rAF 写回已删对话。
    flushPendingDeltas();
    streamAbortRef.current?.abort();
    const response = await fetch(`/api/companion/conversations/${selectedId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!response.ok) {
      setError("删除对话失败。");
      return;
    }
    const remaining = conversations.filter((conversation) => conversation.id !== selectedId);
    setConversations(remaining);
    setSelectedId(remaining[0]?.id ?? null);
    setMessages([]);
  }

  const selectConversation = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  // P8 历史 cursor 分页：更早消息按 beforeSeq keyset 拉取（服务端 hasMore/
  // oldestSeq 契约）。合并时更早消息在前，去重按 id。
  // messages ref（loadOlder 用最新值，避免闭包旧列表）。
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || olderLoading) return;
    setOlderLoading(true);
    try {
      const oldest = messagesRef.current.length > 0
        ? Math.min(...messagesRef.current.map((m) => Number(m.seq ?? 0) || 0))
        : null;
      if (oldest === null || oldest <= 1) {
        setOlderAvailable(false);
        return;
      }
      const response = await fetch(
        `/api/companion/conversations/${encodeURIComponent(conversationId)}/messages?limit=100&beforeSeq=${oldest}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (!response.ok) throw new Error(`older messages failed: ${response.status}`);
      const body = (await response.json()) as { items?: Message[]; hasMore?: boolean };
      const incoming = Array.isArray(body.items) ? body.items : [];
      if (selectedIdRef.current !== conversationId) return;
      if (incoming.length > 0) {
        setMessages((current) => {
          const known = new Set(current.map((m) => m.id));
          return [...incoming.filter((m) => !known.has(m.id)), ...current];
        });
      }
      setOlderAvailable(Boolean(body.hasMore));
    } catch {
      if (selectedIdRef.current === conversationId) setError("暂时无法加载更早的记录。");
    } finally {
      setOlderLoading(false);
    }
  }, [olderLoading]);

  return {
    enabled,
    conversations,
    selected,
    selectedId,
    messages,
    messagesLoading,
    draft,
    loading,
    sending,
    error,
    setDraft,
    selectConversation,
    createConversation,
    sendMessage,
    deleteSelected,
    loadOlderMessages,
    olderAvailable,
    olderLoading,
  };
}
