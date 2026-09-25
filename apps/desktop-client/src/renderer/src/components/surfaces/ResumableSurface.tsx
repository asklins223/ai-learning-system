import { useMemo } from "react";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { usePageReadableView } from "../hud/use-page-readable-view";
import { learningPhaseLabel } from "./learning-run-surface";
import { SurfaceDataState, formatRelative, useSurfaceProjection } from "./surface-data";

/**
 * 未完成的学习——首页那句「N 项可恢复」真正的落点（审计 F24）。
 *
 * 病是这么来的：首页书桌报「10 项可恢复」，点进去是「今日学习」，那一页是**日志**
 * （已经发生的事），里面没有任何一条可恢复的 run，也没有继续的按钮。数据库里确实
 * 躺着 8 个 active + 2 个 paused，只是没有任何一屏把它们列出来。
 *
 * 这一页只做一件事：把投影里那份 `activeRunSummary` 摆出来，每条给出
 * "哪一件事（目标名）· 走到哪（阶段）· 最近动过什么时候"，并给一个「继续」直达
 * 那条 run。不合并进今日日志：那是历史，这是待办，两件事混在一起就会再次出现
 * "数得出 10 却找不到那 10 条"。
 */
export function ResumableSurface() {
  useHudPage("resumable");
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);

  const { data, loading, failure, reload, epochRef } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const response = await window.ailearn.room.getProjection({ meta: createRequestMeta(workspaceEpoch) });
    return unwrapGatewayResult(response);
  });

  const summary = data?.activeRunSummary ?? null;
  const items = useMemo(() => (summary?.state === "data" ? summary.data.items : []), [summary]);
  const total = summary?.state === "data" ? summary.data.activeCount : 0;
  /**
   * 屏上 header 那一行只写一次：登记给伴星的 `statusLine` 复用同一个表达式。
   * 分成两处写就是两份文案，早晚会分叉。
   */
  const headLine
    = summary?.state === "error"
      ? "这批状态暂时读不到。"
      : total > 0
        ? `共 ${total} 项；挑一条接着走，进度都还在。`
        : "现在没有摊着的事。";
  /** 投影一节最多带 20 条（契约上限）：数得出更多时如实说，不让"列出来的"冒充"全部"。 */
  const truncatedLine
    = items.length > 0 && total > items.length
      ? `这里先列出 ${items.length} 项，共 ${total} 项；其余会在这一屏刷新后补上。`
      : null;

  /**
   * 这一屏登记给伴星读的可读视图（39d W2-7）。标题＝屏上的 h2，状态行＝`headLine`，
   * 条目＝清单自己那一批（`<b>` 的那个名字＋阶段字），三个数都不重新计算。
   *
   * **刻意不带"最近动过 X 前"**：那是一个随读表时刻漂移的串，载荷合同明令
   * "多久之前一律由服务端从 `issuedAt` 算"（`companion-bridge-contracts.ts` 的
   * `pageReadableV1Schema` 段注释）。登记进来只会让她念出一个已经过期的数。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!summary && !failure) return null;
    return {
      pageId: "resumable",
      title: "未完成的学习",
      statusLine: headLine,
      metrics: [
        { label: "共", value: `${total} 项` },
        ...(truncatedLine ? [{ label: "先列出", value: `${items.length} 项` }] : []),
      ],
      ...(items.length > 0
        ? {
            items: items.slice(0, 12).map((item, index) => ({
              ordinal: index + 1,
              label: (item.conceptLabel ?? "未命名目标").slice(0, 120),
              state: learningPhaseLabel(item.phase).slice(0, 40),
            })),
          }
        : {}),
      ...(truncatedLine ? { notice: truncatedLine.slice(0, 200) } : {}),
    };
  }, [failure, headLine, items, total, truncatedLine]);
  usePageReadableView(readableView);

  // 只挂 runId：`invoke(...)` 会清掉 activeObjectiveId（目标页不登记返回目标），
  // 作答面自己从 run 里解出目标——与复习队列、星图、目标简报那三处恢复同一条路。
  const resume = (runId: string) => {
    setActiveRunId(runId);
    invoke("validate");
  };

  return (
    <HudPage page="resumable">
      <section className="resumable-index" aria-labelledby="resumable-title">
        <header className="resumable-index__head">
          <p className="eyebrow">书桌上摊着的那几件事</p>
          <h2 id="resumable-title">未完成的学习</h2>
          <p className="small">{headLine}</p>
        </header>

        {loading && !data ? <SurfaceDataState kind="loading" message="正在读取未完成的学习" detail="只列出这个空间里属于你的在途任务。" /> : null}
        {!loading && failure ? (
          <SurfaceDataState kind="error" message="未完成的学习暂时读不到" detail={failure} onRetry={() => void reload()} />
        ) : null}
        {!loading && !failure && summary?.state === "error" ? (
          <SurfaceDataState
            kind="error"
            message="未完成的学习暂时读不到"
            detail="服务端的房间投影这一节读失败；数量与清单都不显示，避免给出一个猜出来的数。"
            onRetry={() => void reload()}
          />
        ) : null}
        {!loading && !failure && summary?.state === "empty" ? (
          <SurfaceDataState
            kind="empty"
            message="没有未完成的学习"
            detail="每一条都会在结束或完成后从这里离开；去书桌看看今天能做什么。"
            action={
              <button type="button" className="button" onClick={() => invoke("home")}>回到书桌</button>
            }
          />
        ) : null}
        {!loading && !failure && items.length > 0 ? (
          <ul className="resumable-list">
            {items.map((item) => (
              <li key={item.runId} className="resumable-row">
                <div className="resumable-row__what">
                  <b>{item.conceptLabel ?? "未命名目标"}</b>
                  <span className="small">
                    {learningPhaseLabel(item.phase)}
                    {" · "}
                    最近动过 {formatRelative(item.updatedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="button primary"
                  aria-label={`继续「${item.conceptLabel ?? "未命名目标"}」`}
                  onClick={() => resume(item.runId)}
                >
                  继续
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {truncatedLine ? (
          <p className="small resumable-index__note">{truncatedLine}</p>
        ) : null}
      </section>
    </HudPage>
  );
}
