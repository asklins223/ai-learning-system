import { useEffect, useRef, useState } from "react";
import { LogOut, UserRound } from "lucide-react";
import { useRoomStore, type AccountIdentity } from "../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { signOutCurrentAccount } from "../../app/account-signout";

/**
 * 头像没上传过时也要把「已经问过了」这件事记下来，否则每次点开小框都要再问一遍。
 * 空串就是那个记录：它表示确认过没有头像，而不是还没问过。
 */
const NO_AVATAR = "";

/**
 * 首字母印章。设置页的身份块、空间列表的每一行都用这个 motif，账户小框不另立一套；
 * 药丸上的账户按钮与卡片里读同一个函数，避免一处有字母一处没有。
 */
export function accountInitial(identity: AccountIdentity | null): string {
  return (identity?.displayName ?? identity?.email ?? "我").slice(0, 1).toUpperCase();
}

/** 身份块第二行。没设显示名时标题已经是邮箱，再抄一遍邮箱等于什么都没补上。 */
function accountSubline(identity: AccountIdentity | null): string {
  if (!identity) return "正在读取这台设备登录的账号";
  return identity.displayName ? `账号 ${identity.email}` : "这个账号没有设置显示名";
}

/** 当前账号的头像字节；只有它属于正在登录的这个邮箱时才用。 */
export function accountAvatarSrcFor(
  identity: AccountIdentity | null,
  avatar: { readonly email: string; readonly src: string } | null,
): string | null {
  if (!identity || !avatar || avatar.email !== identity.email || avatar.src === NO_AVATAR) return null;
  return avatar.src;
}

/**
 * 顶栏药丸上的账户按钮点开的小框：这台设备上是**谁**在登录，以及一条退出登录。
 *
 * 排布沿用学习空间那张卡（同一个 `.home-menu`），因为它是房间里唯一一处
 * 「点一下顶栏按钮弹出来的框」——换账号要用的两个动作应该长在同一个地方。
 *
 * 退出要按两次：一次点击就把整间房间换成登录页，代价是不论谁点错都要重新登录。
 * 这与空间切换、新建空间用的是同一个手法（第一次只武装，标签换成「再点确认」）。
 */
export function HudAccountCard({ onOpenAccount }: { readonly onOpenAccount: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const identity = useRoomStore((state) => state.accountIdentity);
  const avatar = useRoomStore((state) => state.accountAvatar);
  const setAccountAvatar = useRoomStore((state) => state.setAccountAvatar);
  const [armed, setArmed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // 卡片本身也是键盘事件的产物：把焦点交给卡片，下一次 Tab 落在第一行而不是它背后。
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * 头像字节只在点开小框时取，取到后发布给房间 store：药丸常驻，不该为一张照片
   * 每次挂载都发三个请求，而按钮与卡片必须显示同一张脸。
   */
  useEffect(() => {
    if (!identity || avatar?.email === identity.email) return undefined;
    const email = identity.email;
    let active = true;
    void (async () => {
      try {
        const profile = unwrapGatewayResult(
          await window.ailearn.auth.getProfile({ meta: createRequestMeta() }),
        );
        if (!profile.avatarUrl) {
          if (active) setAccountAvatar({ email, src: NO_AVATAR });
          return;
        }
        const bytes = unwrapGatewayResult(await window.ailearn.auth.getAvatar({
          meta: createRequestMeta(),
          request: { version: 1, objectKey: profile.avatarUrl.replace("/api/uploads/", "") },
        }));
        if (active) {
          setAccountAvatar({ email, src: `data:${bytes.mimeType};base64,${bytes.imageBase64}` });
        }
      } catch {
        // 头像取不回不是故障：落回首字母印章，本次不记账，下次点开再试。
      }
    })();
    return () => { active = false; };
  }, [avatar?.email, identity, setAccountAvatar]);

  const signOut = async () => {
    if (leaving) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setLeaving(true);
    // 这个方法自己消化所有失败结局（换成一句人话留给登录页），不会抛。
    await signOutCurrentAccount();
  };

  const src = accountAvatarSrcFor(identity, avatar);

  return (
    <div ref={rootRef} className="home-menu" aria-label="账户" tabIndex={-1}>
      <h2>账户</h2>
      {/* 身份块直接复用设置页的 `.settings-identity`：同一个账号在两个地方必须是
          同一张脸、同一套排布，这里不再抄一份样式。 */}
      <div className="settings-identity">
        {src
          ? <img className="settings-identity__avatar" src={src} alt="你的头像" />
          : <span className="settings-identity__seal" aria-hidden="true">{accountInitial(identity)}</span>}
        <div>
          <b>{identity?.displayName ?? identity?.email ?? "正在读取账号"}</b>
          <small>{accountSubline(identity)}</small>
        </div>
      </div>
      <button type="button" className="space-row" onClick={onOpenAccount}>
        <span className="space-seal"><UserRound size={15} aria-hidden="true" /></span>
        <div>
          <b>账户与空间</b>
          <div className="small">显示名、头像、学习空间与邀请</div>
        </div>
        <span aria-hidden="true">›</span>
      </button>
      <button
        type="button"
        className="space-row"
        data-danger="true"
        aria-busy={leaving || undefined}
        onClick={() => void signOut()}
      >
        <span className="space-seal"><LogOut size={15} aria-hidden="true" /></span>
        <div>
          <b>退出登录</b>
          <div className="small">
            {armed ? "再点一次就退出这台设备上的登录状态" : "换一个人用，或者到别的设备上继续"}
          </div>
        </div>
        {leaving ? <span className="tag">正在退出…</span> : armed ? <span className="tag red">再点确认</span> : <span className="tag">退出</span>}
      </button>
      <p className="sub">退出不会删除任何学习记录，也不影响其他设备上的登录。</p>
    </div>
  );
}
