import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionContextV1, WorkspaceSummaryV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { mediaAssetUrl, useLearningRoomManifest } from "../../media/learning-room-manifest";
import { HOME_V2_ENABLED } from "../home-v2/home-v2";
import { CompanionRoot } from "../companion/CompanionPresence";
import { DirectoryRail } from "../DirectoryRail";
import { HudRoomControl } from "./HudRoomControl";
import { useHudPage } from "./use-hud-page";

function workspaceRoleLabel(workspace: WorkspaceSummaryV1): string {
  if (workspace.workspaceType === "personal") return "Personal";
  return workspace.role === "owner" ? "Owner" : "Member";
}

/**
 * Mockup page 04A — the one-time choice made on the first entry into the study.
 *
 * The mockup draws two ways in on one paper: take a space the account already
 * has, or redeem an invite code. Both are real: the left column lists
 * `workspace.list` and enters one with `workspace.switch`; the right column
 * redeems with `auth.joinWorkspace`. No counts are invented — a workspace
 * summary carries its name, role and type, and that is all the left column says.
 */
function HudFirstSpace({
  workspaces,
  workspaceEpoch,
  notice,
  onCommitted,
}: {
  readonly workspaces: readonly WorkspaceSummaryV1[];
  readonly workspaceEpoch: number;
  readonly notice?: string | null;
  readonly onCommitted: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [selectedId, setSelectedId] = useState(() => workspaces[0]?.workspaceId ?? null);
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState<"enter" | "join" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const selected = useMemo(
    () => workspaces.find((workspace) => workspace.workspaceId === selectedId) ?? workspaces[0] ?? null,
    [selectedId, workspaces],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // The paper is a modal (`role="dialog" aria-modal="true"`), so Tab has to
  // cycle inside it: focus escaping to the rail or the control pill would let
  // keyboard users act on a room that has no space bound yet.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => document.removeEventListener("keydown", trap, true);
  }, []);

  const enter = async () => {
    if (!selected || busy) return;
    setBusy("enter");
    setFailure(null);
    try {
      unwrapGatewayResult(await window.ailearn.workspace.switch({
        meta: createRequestMeta(workspaceEpoch),
        workspaceId: selected.workspaceId,
      }));
      setBusy(null);
      onCommitted();
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
      setBusy(null);
    }
  };

  const join = async () => {
    const inviteToken = inviteCode.trim();
    if (!inviteToken || busy) return;
    setBusy("join");
    setFailure(null);
    try {
      unwrapGatewayResult(await window.ailearn.auth.joinWorkspace({
        meta: createRequestMeta(workspaceEpoch),
        inviteToken,
      }));
      setInviteCode("");
      setBusy(null);
      onCommitted();
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
      setBusy(null);
    }
  };

  const status = failure ?? notice ?? null;

  return (
    <section ref={dialogRef} className="first-space" role="dialog" aria-modal="true" aria-labelledby="first-space-title">
      <h1 id="first-space-title" ref={headingRef} tabIndex={-1}>先选一个学习空间</h1>
      <p className="sub">这是首次进入书房的一次性设置；选择前不会读取任何空间数据。</p>
      {status ? <p className="sub first-space__notice" role="alert">{status}</p> : null}
      <div className="space-path">
        <section className="space-choice">
          <div className="stamp">{selected ? selected.name.slice(0, 1) : "＋"}</div>
          <h3>进入已有空间</h3>
          {selected ? (
            <p className="sub">{selected.name} · {workspaceRoleLabel(selected)}</p>
          ) : (
            <p className="sub">这个账号名下还没有空间。</p>
          )}
          {workspaces.length > 1 ? (
            <div className="space-pick" role="group" aria-label="账号名下的学习空间">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.workspaceId}
                  type="button"
                  title={workspace.name}
                  aria-label={workspace.name}
                  aria-pressed={workspace.workspaceId === selected?.workspaceId}
                  disabled={busy !== null}
                  onClick={() => { setSelectedId(workspace.workspaceId); setFailure(null); }}
                >
                  {/* 双字印章：单字在同名/同前缀空间之间不可辨，34px 圆内两字放得下。 */}
                  {workspace.name.slice(0, 2)}
                </button>
              ))}
            </div>
          ) : null}
          <button
            className="button primary"
            type="button"
            disabled={!selected || busy !== null}
            onClick={() => void enter()}
          >
            {busy === "enter" ? "正在进入…" : "进入这个空间"}
          </button>
        </section>
        <div className="space-divider" />
        <section className="space-choice">
          <div className="stamp">＋</div>
          <h3>加入协作空间</h3>
          <p className="sub">粘贴邀请码，验证后再进入。</p>
          {/* 包一层 form 让粘贴后回车即验证——桌面端粘贴邀请码后敲回车是肌肉记忆。 */}
          <form
            className="invite-line"
            onSubmit={(event) => { event.preventDefault(); void join(); }}
          >
            <input
              value={inviteCode}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴邀请码"
              aria-label="协作空间邀请码"
              onChange={(event) => { setInviteCode(event.target.value); setFailure(null); }}
            />
            <button
              type="submit"
              className="button"
              disabled={busy !== null || !inviteCode.trim()}
            >
              {busy === "join" ? "验证中…" : "验证"}
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}

/**
 * The 04A scene: the study itself, its directory, the control pill and Mao, with
 * the first-entry paper floating on top. The mockup renders the selection inside
 * the home page rather than on its own page, so the room is painted here from
 * the room plates and nothing else is read before a space is chosen: the rail
 * and the pill are inert, and the companion is the idle live model with the
 * page's one line.
 */
export function HudFirstSpaceScene({
  session,
  workspaces,
  notice,
  onCommitted,
}: {
  readonly session: SessionContextV1;
  readonly workspaces: readonly WorkspaceSummaryV1[];
  readonly notice?: string | null;
  readonly onCommitted: () => void;
}) {
  useHudPage("space", { spaceFirstEntry: true });
  const theme = useRoomStore((state) => state.theme);
  const { manifest } = useLearningRoomManifest();
  // The mockup puts 04A on `bg-home`, so the plate is the home room's own
  // poster — the same pair `RoomStage` paints behind the live home page.
  const dayPlate = manifest
    ? mediaAssetUrl(manifest, (HOME_V2_ENABLED ? manifest.homeV2Posters : manifest.posters).day.path)
    : null;
  const nightPlate = manifest
    ? mediaAssetUrl(manifest, (HOME_V2_ENABLED ? manifest.homeV2Posters : manifest.posters).night.path)
    : null;

  return (
    <>
      <div
        className="scene-stage"
        role="region"
        aria-label={theme === "day" ? "日间理解书房场景" : "夜间理解书房场景"}
        aria-hidden="true"
      >
        {dayPlate ? <img className="room-backplate room-backplate--home-day" src={dayPlate} alt="" draggable={false} /> : null}
        {nightPlate ? <img className="room-backplate room-backplate--home-night" src={nightPlate} alt="" draggable={false} /> : null}
      </div>
      <DirectoryRail readOnly />
      <CompanionRoot />
      <HudRoomControl readOnly />
      <HudFirstSpace
        workspaces={workspaces}
        workspaceEpoch={session.workspaceEpoch}
        notice={notice}
        onCommitted={onCommitted}
      />
    </>
  );
}
