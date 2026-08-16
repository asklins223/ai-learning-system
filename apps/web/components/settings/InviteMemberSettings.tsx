"use client";

import { useCallback, useEffect, useState, type ComponentType, type SVGProps } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface InviteItem {
  id: string;
  tokenHint: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
  consumedByEmail: string | null;
  revokedAt: string | null;
}

interface MemberItem {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

type CreateFormState = {
  role: "member" | "owner";
  expiresInHours: number | null;
};

const ROLE_OPTIONS: Array<{ value: "member" | "owner"; label: string; hint: string }> = [
  { value: "member", label: "成员", hint: "只读访问 + 验证/复习" },
  { value: "owner", label: "所有者", hint: "完整增删改权限" },
];

const EXPIRY_OPTIONS: Array<{ value: number | null; label: string; hint: string }> = [
  { value: 24, label: "24 小时", hint: "短期临时邀请" },
  { value: 72, label: "72 小时", hint: "常规默认有效期" },
  { value: 168, label: "7 天", hint: "给对方充裕时间" },
  { value: null, label: "无限制", hint: "直到手动撤销" },
];

function SectionHeader({
  title,
  description,
  icon: HeaderIcon,
}: {
  title: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return (
    <header className="invite-section-header">
      <span className="invite-section-icon" aria-hidden="true">
        <HeaderIcon />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  );
}

export function InviteMemberSettings() {
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [inviteTotal, setInviteTotal] = useState(0);
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateFormState>({
    role: "member",
    expiresInHours: 72,
  });
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { type: "revoke"; inviteId: string; label: string }
    | { type: "remove"; userId: string; label: string }
    | { type: "create_owner"; label: string }
    | null
  >(null);

  const loadData = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const [invitesRes, membersRes] = await Promise.all([
        api.listInvites(),
        api.listMembers({ limit: 200 }),
      ]);
      setInvites(invitesRes.items);
      setInviteTotal(invitesRes.total);
      setMembers(membersRes.items);
    } catch {
      if (background) {
        setActionError("操作已完成，但最新列表暂时无法同步，请稍后刷新。");
      } else {
        setError("加载数据失败，请稍后重试。");
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleCreateInvite() {
    if (creating) return;
    setCreating(true);
    setConfirmAction(null);
    setActionError(null);
    setCreatedToken(null);
    try {
      const result = await api.createInvite({
        role: createForm.role,
        expiresInHours: createForm.expiresInHours ?? undefined,
      });
      setCreatedToken(result.token);
      setCopiedLink(false);
      setCopiedCode(false);
      setCopyError(null);
      void loadData(true);
    } catch {
      setActionError("创建邀请失败，请稍后重试。");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    if (revokingId) return;
    setRevokingId(inviteId);
    setActionError(null);
    try {
      await api.revokeInvite(inviteId);
      setConfirmAction(null);
      void loadData(true);
    } catch {
      setActionError("撤销邀请失败，请稍后重试。");
    } finally {
      setRevokingId(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (removingId) return;
    setActionError(null);
    setRemovingId(userId);
    try {
      await api.removeMember(userId);
      setConfirmAction(null);
      void loadData(true);
    } catch {
      setActionError("移除成员失败，请稍后重试。");
    } finally {
      setRemovingId(null);
    }
  }

  function registrationUrl(token: string) {
    const path = `/register?token=${encodeURIComponent(token)}`;
    return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
  }

  async function copyLink() {
    if (!createdToken) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(registrationUrl(createdToken));
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 3000);
    } catch {
      setCopiedLink(false);
      setCopyError("复制链接失败，请手动选择。");
    }
  }

  async function copyCode() {
    if (!createdToken) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 3000);
    } catch {
      setCopiedCode(false);
      setCopyError("复制邀请码失败，请手动选择。");
    }
  }

  function statusLabel(status: string) {
    switch (status) {
      case "active":
        return "可用";
      case "consumed":
        return "已使用";
      case "revoked":
        return "已撤销";
      case "expired":
        return "已过期";
      default:
        return status;
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (loading) {
    return (
      <div className="invite-loading">
        <Icon.Refresh className="invite-spin" />
        <span>正在加载邀请与成员数据…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="invite-error-state">
        <Icon.AlertCircle aria-hidden="true" />
        <p>{error}</p>
        <button type="button" onClick={() => void loadData()}>
          <Icon.Refresh />
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="invite-member-settings">
      {actionError && (
        <div className="invite-action-error" role="alert">
          <Icon.Warn aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      {/* 创建邀请 */}
      <section className="invite-create-section">
        <SectionHeader
          title="创建邀请"
          description="默认创建 72 小时有效的成员邀请；需要时再调整高级选项。"
          icon={Icon.Plus}
        />
        <div className="invite-create-form">
          <div className="invite-default-summary">
            <span aria-hidden="true"><Icon.Check /></span>
            <div>
              <strong>{createForm.role === "owner" ? "所有者" : "成员"}邀请</strong>
              <small>
                {createForm.expiresInHours === null
                  ? "长期有效，直到手动撤销"
                  : `${createForm.expiresInHours} 小时内有效`}
              </small>
            </div>
          </div>

          <details className="invite-advanced-options">
            <summary>
              <span>高级选项</span>
              <small>角色与有效期</small>
              <Icon.Chevron aria-hidden="true" />
            </summary>
            <div className="invite-advanced-options-body">
          <fieldset className="invite-option-group">
            <legend>角色</legend>
            <div className="invite-option-grid invite-option-grid--2">
              {ROLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`invite-option ${createForm.role === opt.value ? "is-active" : ""}`}
                  aria-pressed={createForm.role === opt.value}
                  onClick={() => setCreateForm((f) => ({ ...f, role: opt.value }))}
                >
                  <span className="invite-option-label">{opt.label}</span>
                  <span className="invite-option-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {createForm.role === "owner" && (
            <div className="invite-owner-warning" role="note">
              <Icon.Warn aria-hidden="true" />
              <span><strong>所有者拥有完整管理权限</strong>可修改或删除工作区内容、管理成员与邀请。只向可信协作者授予。</span>
            </div>
          )}

          <fieldset className="invite-option-group">
            <legend>有效期</legend>
            <div className="invite-option-grid invite-option-grid--4">
              {EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  className={`invite-option ${createForm.expiresInHours === opt.value ? "is-active" : ""}`}
                  aria-pressed={createForm.expiresInHours === opt.value}
                  onClick={() => setCreateForm((f) => ({ ...f, expiresInHours: opt.value }))}
                >
                  <span className="invite-option-label">{opt.label}</span>
                  <span className="invite-option-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
            </div>
          </details>

          <button
            type="button"
            className="invite-create-btn"
            onClick={() => {
              if (createForm.role === "owner") {
                setConfirmAction({ type: "create_owner", label: "所有者" });
              } else {
                void handleCreateInvite();
              }
            }}
            disabled={creating}
            aria-busy={creating}
          >
            {creating ? <Icon.Refresh className="invite-spin" /> : <Icon.Link />}
            {creating ? "正在生成" : "生成邀请"}
          </button>
        </div>

        {createdToken && (
          <div className="invite-result-display">
            <div className="invite-result-warning">
              <Icon.Warn aria-hidden="true" />
              <span>邀请信息只显示一次，请立即复制保存。</span>
            </div>

            <div className="invite-result-cards">
              {/* 邀请注册链接 */}
              <div className="invite-result-card">
                <div className="invite-result-card-header">
                  <Icon.Link aria-hidden="true" />
                  <div>
                    <strong>邀请注册链接</strong>
                    <span>发给新用户，点击后直接进入注册页</span>
                  </div>
                </div>
                <div className="invite-result-card-body">
                  <code>{registrationUrl(createdToken)}</code>
                  <button
                    type="button"
                    onClick={() => void copyLink()}
                    className={copiedLink ? "is-copied" : ""}
                  >
                    {copiedLink ? <Icon.Check /> : <Icon.Link />}
                    {copiedLink ? "已复制" : "复制链接"}
                  </button>
                </div>
                <Link
                  className="invite-result-card-action"
                  href={`/register?token=${encodeURIComponent(createdToken)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon.Arrow />
                  打开注册页面
                </Link>
              </div>

              {/* 邀请码 */}
              <div className="invite-result-card">
                <div className="invite-result-card-header">
                  <Icon.Lock aria-hidden="true" />
                  <div>
                    <strong>邀请码</strong>
                    <span>已登录用户可在设置页粘贴此码加入工作区</span>
                  </div>
                </div>
                <div className="invite-result-card-body">
                  <code className="invite-result-code">{createdToken}</code>
                  <button
                    type="button"
                    onClick={() => void copyCode()}
                    className={copiedCode ? "is-copied" : ""}
                  >
                    {copiedCode ? <Icon.Check /> : <Icon.Lock />}
                    {copiedCode ? "已复制" : "复制邀请码"}
                  </button>
                </div>
              </div>
            </div>

            {copyError && <p className="invite-action-error" role="alert">{copyError}</p>}
          </div>
        )}
      </section>

      {/* 邀请列表 */}
      <section className="invite-list-section">
        <SectionHeader
          title="邀请记录"
          description={
            inviteTotal > invites.length
              ? `查看已发出的邀请状态；当前显示最近 ${invites.length} / ${inviteTotal} 条。`
              : "查看已发出的邀请状态，撤销仍在生效的链接。"
          }
          icon={Icon.Link}
        />
        {invites.length === 0 ? (
          <div className="invite-empty-state">
            <Icon.Link aria-hidden="true" />
            <p>暂无邀请记录</p>
            <small>在上方创建第一个邀请链接</small>
          </div>
        ) : (
          <div className="invite-table-scroll">
            <table className="invite-table">
              <thead>
                <tr>
                  <th>提示</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>过期时间</th>
                  <th>使用人</th>
                  <th className="col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id}>
                    <td className="mono" data-label="邀请提示">{invite.tokenHint}</td>
                    <td data-label="角色">{invite.role === "owner" ? "所有者" : "成员"}</td>
                    <td data-label="状态">
                      <span className={`invite-status-chip status-${invite.status}`}>
                        <span className="invite-status-chip-dot" aria-hidden="true" />
                        {statusLabel(invite.status)}
                      </span>
                    </td>
                    <td data-label="创建时间">{formatDate(invite.createdAt)}</td>
                    <td data-label="过期时间">{formatDate(invite.expiresAt)}</td>
                    <td data-label="使用人">{invite.consumedByEmail ?? "—"}</td>
                    <td className="col-action" data-label="操作">
                      {invite.status === "active" && (
                        <button
                          type="button"
                          className="revoke-btn"
                          onClick={() =>
                            setConfirmAction({
                              type: "revoke",
                              inviteId: invite.id,
                              label: invite.tokenHint,
                            })
                          }
                          disabled={Boolean(revokingId)}
                          aria-busy={revokingId === invite.id}
                        >
                          {revokingId === invite.id ? <Icon.Refresh className="invite-spin" /> : <Icon.X />}
                          {revokingId === invite.id ? "撤销中" : "撤销"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 成员列表 */}
      <section className="member-list-section">
        <SectionHeader
          title="工作区成员"
          description={`当前共 ${members.length} 位成员；移除后对方会话立即失效。`}
          icon={Icon.User}
        />
        {members.length === 0 ? (
          <div className="invite-empty-state">
            <Icon.User aria-hidden="true" />
            <p>暂无成员</p>
            <small>通过邀请链接邀请第一位成员</small>
          </div>
        ) : (
          <div className="invite-table-scroll">
            <table className="member-table">
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>加入时间</th>
                  <th className="col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td data-label="邮箱">
                      <span className="member-email">{member.email}</span>
                    </td>
                    <td data-label="角色">
                      <span className={`member-role member-role--${member.role}`}>
                        {member.role === "owner" ? "所有者" : "成员"}
                      </span>
                    </td>
                    <td data-label="加入时间">{formatDate(member.joinedAt)}</td>
                    <td className="col-action" data-label="操作">
                      {member.role !== "owner" && (
                        <button
                          type="button"
                          className="remove-btn"
                          onClick={() =>
                            setConfirmAction({
                              type: "remove",
                              userId: member.userId,
                              label: member.email,
                            })
                          }
                          disabled={Boolean(removingId)}
                          aria-busy={removingId === member.userId}
                        >
                          {removingId === member.userId ? <Icon.Refresh className="invite-spin" /> : <Icon.Trash />}
                          {removingId === member.userId ? "移除中" : "移除"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={
          confirmAction?.type === "remove"
            ? "确认移除成员？"
            : confirmAction?.type === "create_owner"
              ? "确认创建所有者邀请？"
              : "确认撤销邀请？"
        }
        message={
          confirmAction?.type === "remove"
            ? `移除「${confirmAction.label}」后，其在当前工作区的所有会话会立即失效。`
            : confirmAction?.type === "revoke"
              ? `撤销邀请「${confirmAction.label}」后，该链接将立即失效且无法恢复。`
              : confirmAction?.type === "create_owner"
                ? "获得此邀请的人可以修改或删除工作区内容，并继续邀请或移除成员。请确认接收者可信。"
                : ""
        }
        confirmLabel={
          confirmAction?.type === "remove"
            ? "确认移除"
            : confirmAction?.type === "create_owner"
              ? "创建所有者邀请"
              : "确认撤销"
        }
        cancelLabel="取消"
        variant="danger"
        loading={Boolean(removingId || revokingId || creating)}
        onCancel={() => {
          if (!removingId && !revokingId && !creating) setConfirmAction(null);
        }}
        onConfirm={() => {
          if (confirmAction?.type === "remove") {
            void handleRemoveMember(confirmAction.userId);
          } else if (confirmAction?.type === "revoke") {
            void handleRevoke(confirmAction.inviteId);
          } else if (confirmAction?.type === "create_owner") {
            void handleCreateInvite();
          }
        }}
      />
    </div>
  );
}
