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
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  // 2026-08-15（接线修复）：历史分页（beforeSeq keyset）——"加载更早"此前
  // 页面已接线（CompanionHistoryArchive hasEarlier/onLoadEarlier）但 hook 从未
  // 实现这 4 个能力，页面解构报类型错误。
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const oldestSeqRef = useRef<number | null>(null);
  const olderInFlightRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // 2026-08-11：SSE 重连游标——跟踪已收到的最大事件 seq，断线重连时
  // 以 after=lastSeq 增量续接，避免重复或丢事件。
  const lastSeqRef = useRef<number>(0);
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

  async function fetchMessages(
    conversationId: string,
    beforeSeq?: number,
  ): Promise<{ items: Message[]; hasMore: boolean; oldestSeq: number | null }> {
    const query = beforeSeq != null
      ? `?limit=50&beforeSeq=${beforeSeq}`
      : "?limit=100";
    const response = await fetch(`/api/companion/conversations/${conversationId}/messages${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`message list failed: ${response.status}`);
    const body = (await response.json()) as {
      items?: Message[];
      hasMore?: boolean;
      oldestSeq?: number | null;
    };
    return {
      items: Array.isArray(body.items) ? body.items : [],
      hasMore: body.hasMore === true,
      oldestSeq: typeof body.oldestSeq === "number" ? body.oldestSeq : null,
    };
  }

  const loadMessages = useCallback(
    async (conversationId: string, keepAssistantRunId?: string): Promise<void> => {
      // 2026-08-11（review 修复）：在途 fetch 返回时会话已切换（selectedIdRef
      // 比对）则丢弃——旧对话结果不混入新视图。
      setMessagesLoading(true);
      try {
        const { items: incoming, hasMore, oldestSeq } = await fetchMessages(conversationId);
        if (selectedIdRef.current !== conversationId) return;
        setMessages((current) => mergeMessages(current, incoming, keepAssistantRunId));
        setOlderAvailable(hasMore);
        oldestSeqRef.current = oldestSeq;
      } finally {
        setMessagesLoading(false);
      }
    },
    [],
  );

  // 2026-08-15（接线修复）：加载更早消息（beforeSeq keyset，prepend）。
  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const conversationId = selectedIdRef.current;
    const beforeSeq = oldestSeqRef.current;
    if (!conversationId || beforeSeq == null || olderInFlightRef.current) return;
    olderInFlightRef.current = true;
    setOlderLoading(true);
    try {
      const { items: older, hasMore, oldestSeq } = await fetchMessages(conversationId, beforeSeq);
      if (selectedIdRef.current !== conversationId) return;
      setMessages((current) => [...older, ...current]);
      setOlderAvailable(hasMore);
      oldestSeqRef.current = oldestSeq;
    } catch {
      setError("暂时无法加载更早的消息。");
    } finally {
      olderInFlightRef.current = false;
      setOlderLoading(false);
    }
  }, []);

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
    const { items: incoming, hasMore, oldestSeq } = await fetchMessages(conversationId);
    if (aborted()) return;
    // 2026-08-11：会话已切换/删除——丢弃重拉结果
    if (selectedIdRef.current !== conversationId) return;
    const hasFinal = messageId !== null && incoming.some((m) => m.id === messageId);
    setMessages((current) => mergeMessages(current, incoming, hasFinal ? undefined : runId));
    setOlderAvailable(hasMore);
    oldestSeqRef.current = oldestSeq;
    if (!hasFinal && retries > 0 && !aborted()) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // 等待期间可能已 abort——递归前再查一次
      if (aborted()) return;
      return reloadAfterFinal(conversationId, messageId, runId, retries - 1, controller);
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
      streamAbortRef.current?.abort();
    };
  }, [loadConversations, requestedConversationId]);

  useEffect(() => {
    if (!selectedId || enabled !== true) {
      setMessages([]);
      return;
    }
    // 2026-08-11（review 修复）：切换对话前先清空 + 中止旧流——否则
    // loadMessages 合并时混入上一对话消息，且旧 SSE 流 delta 事件会写入新对话视图。
    streamAbortRef.current?.abort();
    setMessages([]);
    void loadMessages(selectedId).catch(() => setError("暂时无法加载这段对话。"));
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
            setMessages((current) => {
              const pendingId = `assistant-${runId}`;
              const existing = current.find((item) => item.id === pendingId);
              if (existing) {
                return current.map((item) => item.id === pendingId
                  ? { ...item, blocks: [{ type: "text", text: `${textFromBlocks(item.blocks)}${delta}` }] }
                  : item);
              }
              return [...current, { id: pendingId, role: "assistant", seq: Number.MAX_SAFE_INTEGER, blocks: [{ type: "text", text: delta }], createdAt: new Date().toISOString() }];
            });
          }
          if (event.type === "assistant.final") {
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
            setTimeout(() => {
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
    loadOlderMessages,
    olderAvailable,
    olderLoading,
    deleteSelected,
  };
}
