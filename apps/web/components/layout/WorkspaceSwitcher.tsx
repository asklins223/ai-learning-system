"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, clearLegacyTokenStorage, type CurrentUser } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

interface WorkspaceOption {
  workspaceId: string;
  workspaceName: string;
  role: string;
  workspaceType: string;
  isPersonal: boolean;
}

interface WorkspaceSwitcherProps {
  currentUser: CurrentUser | null;
  onSwitched?: () => void;
}

/**
 * ADR-0009: 工作区切换器
 *
 * 在各尺寸的 AppShell 中展示当前工作区，并允许切换到其他活跃工作区。
 * 切换会重新签发 session 并刷新页面上下文。
 */
export function WorkspaceSwitcher({ currentUser, onSwitched }: WorkspaceSwitcherProps) {
  const optionsId = useId();
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listWorkspaces();
      setWorkspaces(result.workspaces);
    } catch {
      setError("工作区列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const currentWorkspace = workspaces.find((w) => w.workspaceId === currentUser?.workspaceId);
  const otherWorkspaces = workspaces.filter((w) => w.workspaceId !== currentUser?.workspaceId);

  async function handleSwitch(workspaceId: string) {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      await api.switchWorkspace(workspaceId);
      clearLegacyTokenStorage();
      setExpanded(false);
      onSwitched?.();
      // 工作区是整个客户端数据树的租户边界。必须硬刷新，避免保留旧工作区的
      // client state / request cache 后又把写操作发送到新工作区。
      window.location.reload();
    } catch {
      setError("切换失败，请重试");
    } finally {
      setSwitching(false);
    }
  }

  if (loading && workspaces.length === 0) {
    return (
      <div className="workspace-switcher is-loading" aria-label="正在加载工作区列表">
        <Icon.Layers className="workspace-switcher-icon" />
        <span className="workspace-switcher-name">正在加载…</span>
      </div>
    );
  }

  if (error && workspaces.length === 0) {
    return (
      <div className="workspace-switcher is-error" role="alert">
        <Icon.AlertCircle className="workspace-switcher-icon" />
        <span className="workspace-switcher-name">{error}</span>
        <button type="button" onClick={() => void loadWorkspaces()}>
          重试
        </button>
      </div>
    );
  }

  if (workspaces.length <= 1) {
    // 只有一个工作区（个人工作区），不需要切换器
    return (
      <div className="workspace-switcher is-single" aria-label="当前工作区">
        <Icon.Layers className="workspace-switcher-icon" />
        <div className="workspace-switcher-meta">
          <span className="workspace-switcher-label">当前工作区</span>
          <strong className="workspace-switcher-name">
            {currentWorkspace?.workspaceName ?? currentUser?.workspaceName ?? "个人工作区"}
          </strong>
          {(currentWorkspace?.isPersonal ?? currentUser?.isPersonal) ? (
            <span className="workspace-switcher-badge">个人</span>
          ) : (
            <span className="workspace-switcher-badge">协作</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-switcher" data-expanded={expanded}>
      <button
        type="button"
        className="workspace-switcher-trigger"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={optionsId}
        disabled={switching}
      >
        <Icon.Layers className="workspace-switcher-icon" />
        <div className="workspace-switcher-meta">
          <span className="workspace-switcher-label">当前工作区</span>
          <strong className="workspace-switcher-name">
            {currentWorkspace?.workspaceName ?? currentUser?.workspaceName ?? "个人工作区"}
          </strong>
        </div>
        {(currentWorkspace?.isPersonal ?? currentUser?.isPersonal) ? (
          <span className="workspace-switcher-badge">个人</span>
        ) : (
          <span className="workspace-switcher-badge">协作</span>
        )}
        <Icon.Chevron className={`workspace-switcher-chevron ${expanded ? "open" : ""}`} />
      </button>

      {expanded && (
        <div
          id={optionsId}
          className="workspace-switcher-list"
          aria-label="切换工作区"
        >
          <div className="workspace-switcher-list-label">切换到其他工作区</div>
          {otherWorkspaces.map((ws) => (
            <button
              key={ws.workspaceId}
              type="button"
              className="workspace-switcher-option"
              onClick={() => void handleSwitch(ws.workspaceId)}
              disabled={switching}
            >
              <Icon.Layers className="workspace-switcher-option-icon" />
              <div className="workspace-switcher-option-meta">
                <strong>{ws.workspaceName}</strong>
                <span>
                  {ws.isPersonal ? "个人工作区" : "协作工作区"}
                  {" · "}
                  {ws.role === "owner" ? "所有者" : "成员"}
                </span>
              </div>
              <Icon.Switch className="workspace-switcher-option-action" />
            </button>
          ))}
          {otherWorkspaces.length === 0 && (
            <div className="workspace-switcher-empty">暂无其他可切换的工作区</div>
          )}
        </div>
      )}

      {error && <p className="workspace-switcher-error" role="alert">{error}</p>}
    </div>
  );
}
