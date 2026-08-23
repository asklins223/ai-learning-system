"use client";

/**
 * 记忆星图只读视图（22-real-desktop-pet-memory-context-prd-tdd.md §2.6/§14.4）。
 * 当前为 overlay 数据展示；实际 Canvas 叠加可后续接入星图主图。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import "../../conversations/conversation-page.css";
import { api, ApiError } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

interface MemoryStarMapNode {
  memoryId: string;
  kind: string;
  content: string;
  state: "active" | "pinned";
  entityLinks: { entityType: string; entityId: string; orphaned: boolean }[];
}

const KIND_LABEL: Record<string, string> = {
  preference: "偏好",
  goal: "目标",
  learning_context: "学习情境",
  interaction_note: "互动备注",
  episodic: "情景摘要",
};

/** 关联实体类型 → 中文。entity_type 由记忆提取器自由生成，未知值 fail-visible。 */
const ENTITY_TYPE_LABEL: Record<string, string> = {
  learning_card: "学习卡",
  card: "学习卡",
  note: "笔记",
  source: "来源",
  objective: "学习目标",
};

function entityLinkText(entityType: string, entityId: string): string {
  return `${ENTITY_TYPE_LABEL[entityType] ?? entityType} · ${entityId.slice(0, 8)}`;
}

export default function MemoryStarMapPage() {
  const [nodes, setNodes] = useState<MemoryStarMapNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // capability flag（COMPANION_MEMORY_STAR_MAP_V1）关闭时 API 返回 404：
  // 这是“功能未开放”而非故障，渲染引导空状态而不是裸错误。
  const [notAvailable, setNotAvailable] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    void api.getCompanionMemoryStarMap().then((result) => {
      setNotAvailable(false);
      setNodes((result.nodes as MemoryStarMapNode[]) ?? []);
    }).catch((caught) => {
      if (caught instanceof ApiError && caught.status === 404) {
        setNotAvailable(true);
        return;
      }
      setError(caught instanceof Error ? caught.message : "暂时无法读取记忆星图");
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <main className="memory-star-map-page">
      <header>
        <span className="companion-memory-eyebrow"><i aria-hidden="true" /> AI 伴星</span>
        <h1>记忆星图</h1>
        <p>每条记忆都挂在学习卡、笔记、来源与学习记录上，可以追溯出处。</p>
      </header>

      <nav className="memory-star-map-links-nav" aria-label="快捷入口">
        <Link href="/companion/memory" className="memory-star-map-link">
          <Icon.Pin />
          <span>记忆管理</span>
        </Link>
        <Link href="/companion/daily" className="memory-star-map-link">
          <Icon.Sparkle />
          <span>桌宠日记</span>
        </Link>
        <Link href="/companion/conversations" className="memory-star-map-link">
          <Icon.Timeline />
          <span>对话历史</span>
        </Link>
      </nav>
      {error && <p className="memory-star-map-error" role="alert">{error}</p>}
      {notAvailable && !error ? (
        <section className="memory-star-map-empty" role="status">
          <Icon.StarMap aria-hidden="true" />
          <strong>记忆星图暂未开放</strong>
          <p>
            记忆星图正在逐步放开。你仍可以在记忆管理页查看、确认与整理
            伴星记住的全部内容。
          </p>
          <Link href="/companion/memory" className="memory-star-map-empty-link">
            前往记忆管理
          </Link>
        </section>
      ) : !nodes && !error ? (
        <p className="memory-star-map-loading" role="status">正在读取…</p>
      ) : nodes && nodes.length === 0 ? (
        <p className="memory-star-map-empty">还没有可展示的记忆节点。</p>
      ) : (
        <ul className="memory-star-map-list">
          {nodes?.map((node) => (
            <li key={node.memoryId}>
              <span className="memory-star-map-kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
              <strong>{node.content}</strong>
              <small>{node.state === "pinned" ? "已固定" : "活跃"}</small>
              {node.entityLinks.length > 0 && (
                <ul className="memory-star-map-links">
                  {node.entityLinks.map((link, index) => (
                    <li key={`${link.entityType}:${link.entityId}:${index}`}>
                      {entityLinkText(link.entityType, link.entityId)}
                      {link.orphaned ? "（引用已失效）" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
