"use client";

/**
 * 记忆星图只读视图（22-real-desktop-pet-memory-context-prd-tdd.md §2.6/§14.4）。
 * 当前为 overlay 数据展示；实际 Canvas 叠加可后续接入星图主图。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

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

export default function MemoryStarMapPage() {
  const [nodes, setNodes] = useState<MemoryStarMapNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void api.getCompanionMemoryStarMap().then((result) => {
      setNodes((result.nodes as MemoryStarMapNode[]) ?? []);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "暂时无法读取记忆星图");
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <main className="memory-star-map-page">
      <header>
        <span className="companion-memory-eyebrow"><i aria-hidden="true" /> MEMORY STAR MAP</span>
        <h1>记忆星图</h1>
        <p>记忆节点挂在 card / keyPoint / note / source / learning_run 等实体上。</p>
      </header>
      {error && <p className="memory-star-map-error" role="alert">{error}</p>}
      {!nodes && !error ? (
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
                      {link.entityType} · {link.entityId.slice(0, 8)}
                      {link.orphaned ? "（孤儿）" : ""}
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
