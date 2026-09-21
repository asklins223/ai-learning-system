import { useState } from "react";
import type { NoteShareScopeV1 } from "@ailearn/shared/note-share-contracts";

/**
 * 笔记归属那一个显式动作的界面（批次 4.5）。
 *
 * 规则：新建的笔记默认「仅自己可见」，要拿出去必须点一下「共享给空间」；作者随时能
 * 撤回。这一列不能从空间类型或 `created_by` 推出来，所以界面上它必须是一个**看得见
 * 的状态**加一个**点得动的动作**，而不是藏在菜单里的开关。
 *
 * 文案刻意不叫"个人笔记"（用户否掉过这个名字）：说的是可见范围，不是给笔记分类。
 */

export function noteShareScopeLabel(shareScope: NoteShareScopeV1): string {
  return shareScope === "shared" ? "已共享给空间" : "仅自己可见";
}

/** 明写在确认那一步上的话——审查里那条"放入这一步必须明示"的产品规则就落在这里。 */
export function shareConfirmCopy(next: NoteShareScopeV1): string {
  return next === "shared"
    ? "共享后，这个空间的成员都能读到这篇正文。"
    : "取消后其他成员就读不到了；已经按它生成过的学习卡不受影响。";
}

export function SpaceShareButton(props: {
  readonly shareScope: NoteShareScopeV1;
  readonly canShare: boolean;
  /** 个人空间里没有人可共享，整个控件不出现——出现了就是一个点了没变化的开关。 */
  readonly isPersonal: boolean;
  readonly busy?: boolean;
  readonly onShare: (next: NoteShareScopeV1) => void | Promise<void>;
  readonly testId?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (props.isPersonal) return null;

  const next: NoteShareScopeV1 = props.shareScope === "shared" ? "private" : "shared";
  const label = next === "shared" ? "共享给空间" : "取消共享";

  if (!props.canShare) {
    return (
      <button type="button" className="text-action" disabled title="只有写下这篇的人能改它共享给谁">
        {label}
      </button>
    );
  }
  if (confirming) {
    return (
      <>
        <span className="note-share-confirm" data-testid={props.testId ? `${props.testId}-confirm` : undefined}>
          {shareConfirmCopy(next)}
        </span>
        <button
          type="button"
          className="text-action text-action--strong"
          disabled={props.busy}
          onClick={async () => {
            setConfirming(false);
            await props.onShare(next);
          }}
        >
          {props.busy ? "正在处理…" : `确认${label}`}
        </button>
        <button type="button" className="text-action" onClick={() => setConfirming(false)}>取消</button>
      </>
    );
  }
  return (
    <button
      type="button"
      className="text-action"
      disabled={props.busy}
      title={next === "shared" ? "这篇将对本空间所有成员可见" : "撤回后只有你自己看得到"}
      onClick={() => setConfirming(true)}
    >
      {label}
    </button>
  );
}
