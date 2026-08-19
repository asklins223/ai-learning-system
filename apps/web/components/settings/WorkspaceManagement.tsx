"use client";

import { useCallback, useEffect, useState } from "react";
import { api, clearLegacyTokenStorage, type CurrentUser } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface WorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  role: string;
  workspaceType: string;
  isPersonal: boolean;
}

const MAX_COLLABORATIVE_WORKSPACES = 3;

function getJoinErrorMessage(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : "";
  const normalized = raw.toLowerCase();
  if (normalized.includes("not_found")) return "邀请码无效或不存在。";
  if (normalized.includes("expired")) return "邀请码已过期，请联系工作区所有者重新生成。";
  if (normalized.includes("revoked")) return "邀请码已被撤销。";
  if (normalized.includes("already_consumed")) return "邀请码已被使用。";
  if (normalized.includes("workspace_limit_reached")) {
    return `已达到协作工作区上限（${MAX_COLLABORATIVE_WORKSPACES} 个），请先退出某个协作工作区。`;
  }
  if (normalized.includes("already_member")) return "你已经是该工作区的成员。";
  return "加入工作区失败，请稍后重试。";
}

/**
 * ADR-0009: 工作区管理区
 *
 * 在设置页中展示用户的所有工作区，支持：
 * - 通过邀请码加入协作工作区
 * - 退出协作工作区（退出后邀请码失效，切换回个人工作区）
 */
export function WorkspaceManagement({ currentUser }: { currentUser: CurrentUser | null }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [joinToken, setJoinToken] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState<string | null>(null);

  const [leaveTarget, setLeaveTarget] = useState<WorkspaceMembership | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  // PROFILE-01: 个人工作区改名
  const [renameExpanded, setRenameExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSuccess, setRenameSuccess] = useState<string | null>(null);

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

  const collaborativeWorkspaces = workspaces.filter((w) => !w.isPersonal);
  const personalWorkspace = workspaces.find((w) => w.isPersonal);
  const canJoinMore = collaborativeWorkspaces.length < MAX_COLLABORATIVE_WORKSPACES;

  async function handleJoin() {
    const token = joinToken.trim();
    if (!token || joining) return;
    setJoining(true);
    setJoinError(null);
    setJoinSuccess(null);
    try {
      const result = await api.joinWorkspace({ inviteToken: token });
      setJoinSuccess(`已加入工作区「${result.workspaceName}」`);
      setJoinToken("");
      await loadWorkspaces();
    } catch (caught) {
      setJoinError(getJoinErrorMessage(caught));
    } finally {
      setJoining(false);
    }
  }

  async function handleLeave() {
    if (!leaveTarget || leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      const result = await api.leaveWorkspace({ workspaceId: leaveTarget.workspaceId });
      setLeaveTarget(null);
      if (result.switchedToPersonalWorkspace) {
        clearLegacyTokenStorage();
        // 退出后自动切换回个人工作区，同样需要硬刷新。
        window.location.hash = "workspaces";
        window.location.reload();
        return;
      }
      await loadWorkspaces();
    } catch {
      setLeaveError("退出工作区失败，请稍后重试。");
    } finally {
      setLeaving(false);
    }
  }

  async function handleSwitch(workspaceId: string) {
    if (switchingId || workspaceId === currentUser?.workspaceId) return;
    setSwitchingId(workspaceId);
    setError(null);
    try {
      await api.switchWorkspace(workspaceId);
      clearLegacyTokenStorage();
      // 工作区是整个客户端数据树的租户边界。必须硬刷新，避免保留旧工作区的
      // client state / request cache 后又把写操作发送到新工作区。
      // 使用 reload() 而非 assign()，因为用户已在 /settings 页面，
      // assign 同路径只改 hash 不触发刷新，会导致“切换中”卡死。
      window.location.hash = "workspaces";
      window.location.reload();
    } catch {
      setError("切换工作区失败，请稍后重试。");
      setSwitchingId(null);
    }
  }

  async function handleRename() {
    if (!personalWorkspace || renaming) return;
    const newName = renameValue.trim();
    if (!newName) return;
    setRenaming(true);
    setRenameError(null);
    setRenameSuccess(null);
    try {
      await api.renameWorkspace(personalWorkspace.workspaceId, newName);
      setRenameSuccess("工作区名称已更新");
      setRenameExpanded(false);
      await loadWorkspaces();
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "工作区改名失败";
      if (msg.includes("not_personal_workspace")) {
        setRenameError("只能重命名个人工作区");
      } else {
        setRenameError(msg);
      }
    } finally {
      setRenaming(false);
    }
  }

  function handleCancelRename() {
    setRenameExpanded(false);
    setRenameValue("");
    setRenameError(null);
    setRenameSuccess(null);
  }

  if (loading) {
    return (
      <div className="workspace-management" aria-busy="true">
        <div className="workspace-management-loading">
          <Icon.Refresh className="settings-spin" aria-hidden="true" />
          <span>正在加载工作区列表…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="workspace-management">
        <div className="settings-notice is-danger" role="alert">
          <Icon.Warn aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => void loadWorkspaces()}>重试</button>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-management">
      {/* 个人工作区 */}
      {personalWorkspace && (
        <div className="workspace-management-section-label is-personal">
          <span>我的空间</span>
          <small>默认工作区</small>
        </div>
      )}
      {personalWorkspace && (
        <div
          className={`workspace-management-card is-personal${personalWorkspace.workspaceId === currentUser?.workspaceId ? " is-current" : ""}`}
        >
          <div className="workspace-management-card-main">
            <span className="workspace-management-card-icon" aria-hidden="true">
              <Icon.User />
            </span>
            <div className="workspace-management-card-copy">
              <div className="workspace-management-card-title-row">
                <strong>{personalWorkspace.workspaceName}</strong>
                <span className="workspace-management-badge is-personal">个人工作区</span>
                {personalWorkspace.workspaceId === currentUser?.workspaceId && (
                  <span className="workspace-management-badge is-current">当前</span>
                )}
              </div>
              <p>你的私人学习空间，数据独立隔离，不可退出。可修改名称。</p>
            </div>
          </div>
          <div className="workspace-management-card-actions">
            {personalWorkspace.workspaceId !== currentUser?.workspaceId && (
              <button
                type="button"
                className="settings-primary-button"
                onClick={() => void handleSwitch(personalWorkspace.workspaceId)}
                disabled={Boolean(switchingId)}
                aria-busy={switchingId === personalWorkspace.workspaceId}
              >
                <Icon.Switch aria-hidden="true" />
                {switchingId === personalWorkspace.workspaceId ? "切换中" : "切换到这里"}
              </button>
            )}
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => {
                setRenameValue(personalWorkspace.workspaceName);
                setRenameError(null);
                setRenameSuccess(null);
                setRenameExpanded(true);
              }}
              disabled={renaming || renameExpanded}
            >
              <Icon.Edit aria-hidden="true" />
              改名
            </button>
          </div>
        </div>
      )}

      {/* PROFILE-01: 个人工作区改名表单（点击「改名」后展开） */}
      {personalWorkspace && renameExpanded && (
        <div className="workspace-management-rename">
          <div className="workspace-management-rename-form">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => {
                setRenameValue(e.target.value);
                if (renameError) setRenameError(null);
                if (renameSuccess) setRenameSuccess(null);
              }}
              placeholder={personalWorkspace.workspaceName}
              maxLength={50}
              disabled={renaming}
              aria-label="新工作区名称"
              autoFocus
            />
            <button
              type="button"
              className="settings-secondary-button"
              onClick={handleCancelRename}
              disabled={renaming}
            >
              取消
            </button>
            <button
              type="button"
              className="settings-primary-button"
              onClick={() => void handleRename()}
              disabled={renaming || !renameValue.trim() || renameValue.trim() === personalWorkspace.workspaceName}
              aria-busy={renaming}
            >
              {renaming ? <Icon.Refresh className="settings-spin" /> : <Icon.Check />}
              {renaming ? "保存中" : "保存名称"}
            </button>
          </div>
        </div>
      )}

      {/* PROFILE-01: 改名成功/失败提示（表单收起后仍可见） */}
      {personalWorkspace && renameSuccess && !renameExpanded && (
        <div className="settings-notice is-success" role="status">
          <Icon.Check aria-hidden="true" />
          <span>{renameSuccess}</span>
        </div>
      )}
      {personalWorkspace && renameError && !renameExpanded && (
        <div className="settings-notice is-danger" role="alert">
          <Icon.Warn aria-hidden="true" />
          <span>{renameError}</span>
        </div>
      )}

      {/* 协作工作区列表 */}
      <div className="workspace-management-section">
        <div className="workspace-management-section-label">
          <span>协作工作区</span>
          <small>{collaborativeWorkspaces.length} / {MAX_COLLABORATIVE_WORKSPACES}</small>
        </div>
        {collaborativeWorkspaces.length > 0 ? (
          <div className="workspace-management-card-list">
            {collaborativeWorkspaces.map((ws) => {
              const isCurrent = ws.workspaceId === currentUser?.workspaceId;
              return (
                <div
                  key={ws.workspaceId}
                  className={`workspace-management-card is-collaborative${isCurrent ? " is-current" : ""}`}
                >
                  <div className="workspace-management-card-main">
                    <span className="workspace-management-card-icon" aria-hidden="true">
                      <Icon.Layers />
                    </span>
                    <div className="workspace-management-card-copy">
                      <div className="workspace-management-card-title-row">
                        <strong>{ws.workspaceName}</strong>
                        <span className="workspace-management-badge is-collaborative">协作</span>
                        {ws.role === "owner" && (
                          <span className="workspace-management-badge is-owner">所有者</span>
                        )}
                        {isCurrent && (
                          <span className="workspace-management-badge is-current">当前</span>
                        )}
                      </div>
                      <p>
                        {ws.role === "owner" ? "你拥有此工作区" : "你作为成员加入此工作区"}
                      </p>
                    </div>
                  </div>
                  <div className="workspace-management-card-actions">
                    {!isCurrent && (
                      <button
                        type="button"
                        className="settings-primary-button"
                        onClick={() => void handleSwitch(ws.workspaceId)}
                        disabled={Boolean(switchingId) || leaving}
                        aria-busy={switchingId === ws.workspaceId}
                      >
                        <Icon.Switch aria-hidden="true" />
                        {switchingId === ws.workspaceId ? "切换中" : "切换"}
                      </button>
                    )}
                    {ws.role !== "owner" && (
                      <button
                        type="button"
                        className="settings-secondary-button is-danger"
                        onClick={() => {
                          setLeaveError(null);
                          setLeaveTarget(ws);
                        }}
                        disabled={leaving}
                      >
                        退出工作区
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="workspace-management-empty">
            <Icon.Layers aria-hidden="true" />
            <div>
              <strong>还没有协作工作区</strong>
              <span>收到邀请后，可以在下方加入。</span>
            </div>
          </div>
        )}
      </div>

      {/* 加入协作工作区 */}
      <section className="workspace-management-join" aria-labelledby="workspace-join-title">
        <div className="workspace-management-join-heading">
          <span className="workspace-management-join-icon" aria-hidden="true">
            <Icon.Switch />
          </span>
          <div>
            <strong id="workspace-join-title">加入协作工作区</strong>
            <p>
              粘贴工作区所有者发给你的邀请码，加入其协作空间。
              {!canJoinMore && (
                <span className="workspace-management-join-limit">
                  {" "}已达上限（{MAX_COLLABORATIVE_WORKSPACES} 个），请先退出某个协作工作区。
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="workspace-management-join-form">
          <input
            type="text"
            value={joinToken}
            onChange={(e) => {
              setJoinToken(e.target.value);
              if (joinError) setJoinError(null);
              if (joinSuccess) setJoinSuccess(null);
            }}
            placeholder="粘贴邀请码"
            disabled={joining || !canJoinMore}
            autoComplete="off"
            spellCheck={false}
            aria-label="邀请码"
          />
          <button
            type="button"
            className="settings-primary-button"
            onClick={() => void handleJoin()}
            disabled={joining || !joinToken.trim() || !canJoinMore}
            aria-busy={joining}
          >
            {joining ? <Icon.Refresh className="settings-spin" /> : <Icon.Switch />}
            {joining ? "正在加入" : "加入工作区"}
          </button>
        </div>
        {joinSuccess && (
          <div className="settings-notice is-success" role="status">
            <Icon.Check aria-hidden="true" />
            <span>{joinSuccess}</span>
          </div>
        )}
        {joinError && (
          <div className="settings-notice is-danger" role="alert">
            <Icon.Warn aria-hidden="true" />
            <span>{joinError}</span>
          </div>
        )}
      </section>

      {leaveError && (
        <div className="settings-notice is-danger" role="alert">
          <Icon.Warn aria-hidden="true" />
          <span>{leaveError}</span>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(leaveTarget)}
        title="确认退出协作工作区？"
        message={
          leaveTarget
            ? `退出「${leaveTarget.workspaceName}」后，你将无法访问该工作区的学习数据，对应的邀请码也会失效。如需重新加入，需要工作区所有者重新发送邀请。${leaveTarget.workspaceId === currentUser?.workspaceId ? "当前页面将切换回个人工作区。" : "你当前所在的工作区不会改变。"}`
            : ""
        }
        confirmLabel="确认退出"
        cancelLabel="取消"
        loading={leaving}
        onCancel={() => {
          if (!leaving) setLeaveTarget(null);
        }}
        onConfirm={() => void handleLeave()}
      />
    </div>
  );
}
