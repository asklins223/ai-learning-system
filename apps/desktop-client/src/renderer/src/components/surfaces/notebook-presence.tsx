import type { NoteDocPeer } from "./use-note-doc-live-view";

/**
 * 「还有谁开着这一篇」：一排印章 + 一句人数（批次 4.4 的 presence）。
 *
 * 只在对端真的报了状态时才渲染：一个人学习时这一排是空的，空的一排印章占着顶栏
 * 的位置却说不了任何事。
 *
 * 名字同时写在三个地方——印章里的首字母、悬停的 `title`、`aria-label`——因为鼠标
 * 悬停不是唯一的到达方式。人数那句话也是同一理由：颜色和小圆点谁都能一眼看到，
 * 但读屏和键盘浏览要有一句文字可对得上这一排印章。
 */
export function NotebookPresence({
  peers,
  selfName,
}: {
  readonly peers: readonly NoteDocPeer[];
  readonly selfName: string | null;
}) {
  if (peers.length === 0) return null;
  const everyone = [{ clientId: -1, name: selfName }, ...peers];
  return (
    <>
      <span className="notebook-presence">
        {everyone.map((peer) => {
          const name = peer.name?.trim() ?? "";
          // 没报名字的落回一枚「?」印章：这一排的位置就是人数的位置，
          // 少画一个会是"界面上找不到那个人"。
          const label = name ? (peer.clientId === -1 ? `${name}（你）` : name) : "没留下名字的协作者";
          return (
            <span
              key={peer.clientId}
              className="notebook-presence__peer"
              role="img"
              aria-label={label}
              title={label}
            >
              {name ? name.slice(0, 1).toUpperCase() : "?"}
            </span>
          );
        })}
      </span>
      <span className="tag" title="这几个人也开着这一篇">
        {everyone.length} 人在看
      </span>
    </>
  );
}
