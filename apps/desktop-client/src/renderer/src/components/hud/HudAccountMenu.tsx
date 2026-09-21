import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionContextV1, WorkspaceSummaryV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { spaceRoleLabel } from "../../app/space-identity";
import { readAuthenticatedSession } from "../../app/surface-session";
import { publishGateInvalidation } from "../../app/gate-invalidation";
import { requestSpaceSwitchReceipt, SPACE_MENU_REFRESH_EVENT } from "./space-menu-events";

type AccountMenuState = {
  readonly session: SessionContextV1 | null;
  readonly workspaces: readonly WorkspaceSummaryV1[];
  readonly failure: string | null;
  readonly loading: boolean;
  /** 至少成功读到过一次列表。后台刷新与刷新失败都不该清掉已可读的行。 */
  readonly ready: boolean;
};

/** 角色说法只有 `spaceRoleLabel` 一份：顶栏胶囊与这里的行不能各说各话。 */
function roleLabel(workspace: WorkspaceSummaryV1): string {
  return spaceRoleLabel({ role: workspace.role, isPersonal: workspace.isPersonal });
}

/**
 * The learning-space menu the room control's space key opens (mockup page 04,
 * "returning user" state, i.e. 04B). Every row is a real gateway fact: spaces
 * come from `workspace.list`, entering one goes through `workspace.switch`, and
 * joining goes through `auth.joinWorkspace`.
 *
 * `notice` carries the one message the gate has nowhere else to report — an
 * invite code that failed to redeem during sign-in.
 */
export function HudAccountMenu({
  notice,
  onSwitched,
}: {
  readonly notice?: string | null;
  readonly onSwitched?: (workspaceName: string) => void;
}) {
  const epochRef = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AccountMenuState>({
    session: null,
    workspaces: [],
    failure: null,
    loading: true,
    ready: false,
  });
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * 二次确认已对哪个空间武装。切换会走门禁失效路径，主进程随即 `failClosed` 掉
   * 正式测评并拆流，而房间 store 的 `activeRunId` 直接被清空——进行中的测评就
   * 这样在一次没有任何提示的点击里消失。有活跃 run 时第一次点击只武装、第二次才切。
   */
  const [armedSwitchFor, setArmedSwitchFor] = useState<string | null>(null);
  const [newSpaceName, setNewSpaceName] = useState("");
  const activeRunId = useRoomStore((store) => store.activeRunId);

  /**
   * 新建协作空间并进入它。
   *
   * 此前客户端没有这个入口，"共享学习空间"只能靠把别人拉进自己的个人空间。
   * 主进程在建好后会 switchWorkspace（邀请端点认当前 session 所在空间，不进去就
   * 永远邀请不了人），所以这里与 onSwitched 走同一条失效路径：先停车回执，再让
   * 门禁重验——本组件也会随之重挂载。
   */
  const create = async () => {
    const name = newSpaceName.trim();
    if (!name || busy !== null) return;
    setBusy("create");
    setMessage(null);
    try {
      const response = await window.ailearn.workspace.create({
        meta: createRequestMeta(epochRef.current),
        name,
      });
      unwrapGatewayResult(response);
      requestSpaceSwitchReceipt(name);
      publishGateInvalidation("stale_workspace");
    } catch (error) {
      setBusy(null);
      setMessage(gatewayErrorMessage(error));
    }
  };

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, failure: null }));
    try {
      const session = await readAuthenticatedSession(epochRef);
      const response = await window.ailearn.workspace.list({ meta: createRequestMeta(session.workspaceEpoch) });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setState({ session, workspaces: unwrapGatewayResult(response).workspaces, failure: null, loading: false, ready: true });
    } catch (error) {
      setState((current) => ({
        ...current,
        session: null,
        // 后台刷新失败时保留已有行：一次网络抖动不该把可读的列表整卡换成错误。
        workspaces: current.ready ? current.workspaces : [],
        failure: gatewayErrorMessage(error),
        loading: false,
      }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The list lives here, but the events that change it live in the gate's
  // workspace subscription. When one arrives while the menu is open, the menu
  // re-reads `workspace.list` in place instead of showing stale rows.
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener(SPACE_MENU_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(SPACE_MENU_REFRESH_EVENT, refresh);
  }, [load]);

  // Opening the menu is a keyboard event too: hand focus to the card itself so
  // the next Tab lands on the first row instead of an unknown spot behind it.
  // Escape already hands focus back to the space key.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const enter = async (workspace: WorkspaceSummaryV1) => {
    if (workspace.workspaceId === state.session?.workspace?.workspaceId) return;
    if (activeRunId !== null && armedSwitchFor !== workspace.workspaceId) {
      setArmedSwitchFor(workspace.workspaceId);
      setMessage("有进行中的正式测评，切换会中断它。确认请再点一次。");
      return;
    }
    setArmedSwitchFor(null);
    setBusy(workspace.workspaceId);
    setMessage(null);
    try {
      const response = await window.ailearn.workspace.switch({
        meta: createRequestMeta(epochRef.current),
        workspaceId: workspace.workspaceId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      onSwitched?.(workspace.name);
    } catch (error) {
      setMessage(gatewayErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const join = async () => {
    const inviteToken = inviteCode.trim();
    if (!inviteToken || busy) return;
    setBusy("join");
    setMessage(null);
    const knownIds = new Set(state.workspaces.map((workspace) => workspace.workspaceId));
    try {
      const response = await window.ailearn.auth.joinWorkspace({
        meta: createRequestMeta(epochRef.current),
        inviteToken,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setInviteCode("");
      // ADR-0009：加入不等于切换——当前空间保持不变，切换由 workspace.switch
      // 决定，所以这里不触发 gate 失效。留在菜单里刷新列表、点名新空间，让
      // 用户自己决定何时进入，而不是把菜单收走后不留一句确认。
      const list = unwrapGatewayResult(
        await window.ailearn.workspace.list({ meta: createRequestMeta(epochRef.current) }),
      );
      const joined = list.workspaces.find((workspace) => !knownIds.has(workspace.workspaceId));
      setState((current) => ({ ...current, workspaces: list.workspaces, failure: null, loading: false, ready: true }));
      setMessage(joined ? `已加入「${joined.name}」，点击它即可进入。` : "已加入新的学习空间。");
    } catch (error) {
      setMessage(gatewayErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const currentId = state.session?.workspace?.workspaceId ?? null;
  const status = message ?? notice ?? null;

  return (
    <div ref={rootRef} className="home-menu" aria-label="学习空间" tabIndex={-1}>
      <h2>学习空间</h2>
      {state.loading && !state.ready ? <p className="sub">正在读取可用的学习空间……</p> : null}
      {state.loading && state.ready ? <p className="sub" role="status">正在更新列表……</p> : null}
      {state.failure ? (
        <>
          <p className="sub" role="alert">{state.failure}</p>
          <button type="button" className="button" onClick={() => void load()}>重试</button>
        </>
      ) : null}
      {state.ready ? (
        <>
          {state.workspaces.length === 0 ? (
            <p className="sub">这个账号还没有可用的学习空间。</p>
          ) : null}
          {state.workspaces.map((workspace) => {
            const current = workspace.workspaceId === currentId;
            // Row-level busy: the whole column stays locked (one switch at a
            // time), but the row in flight names itself so the press has a
            // visible, announced target.
            const rowBusy = busy === workspace.workspaceId;
            return (
              <button
                key={workspace.workspaceId}
                type="button"
                className="space-row"
                aria-current={current ? "true" : undefined}
                data-current={current || undefined}
                aria-busy={rowBusy || undefined}
                data-busy={rowBusy || undefined}
                // 当前行没有可做的动作：禁用并交给 data-current 的样式，
                // 而不是让一次点击无声无息。
                disabled={busy !== null || current}
                onClick={() => void enter(workspace)}
              >
                <span className="space-seal">{workspace.name.slice(0, 1)}</span>
                <div>
                  <b>{workspace.name}</b>
                  <div className="small">{current ? `当前 · ${roleLabel(workspace)}` : roleLabel(workspace)}</div>
                </div>
                {rowBusy
                  ? <span className="tag">进入中…</span>
                  : current
                    ? <span className="tag green">已选择</span>
                    : armedSwitchFor === workspace.workspaceId
                      ? <span className="tag red">再点确认</span>
                      : <span aria-hidden="true">›</span>}
              </button>
            );
          })}
          <form
            className="invite-line"
            onSubmit={(event) => { event.preventDefault(); void join(); }}
          >
            <input
              value={inviteCode}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { setInviteCode(event.target.value); setMessage(null); }}
              placeholder="粘贴邀请码"
              aria-label="协作空间邀请码"
            />
            <button
              type="submit"
              className="button"
              disabled={busy !== null || !inviteCode.trim()}
            >
              {busy === "join" ? "加入中…" : "加入"}
            </button>
          </form>
          <form
            className="invite-line"
            onSubmit={(event) => { event.preventDefault(); void create(); }}
          >
            <input
              value={newSpaceName}
              maxLength={50}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { setNewSpaceName(event.target.value); setMessage(null); }}
              placeholder="新协作空间名称"
              aria-label="新协作空间名称"
            />
            <button
              type="submit"
              className="button"
              disabled={busy !== null || !newSpaceName.trim()}
            >
              {busy === "create" ? "创建中…" : "新建"}
            </button>
          </form>
          {status ? <p className="sub" role="status">{status}</p> : null}
        </>
      ) : null}
    </div>
  );
}
