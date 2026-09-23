/**
 * 理解目标库的视图态（搜索词 / 筛选桶 / 滚动位置）。
 *
 * 它必须是模块级的：从列表点进详情再返回时，组件会卸载重建，状态若留在
 * 组件里就会被清空。但正因为它活得比一次挂载长，**跨流程跳进来时必须显式
 * 清掉**——2026-09-20 实走复盘 #4 里，用户从「激活完成 → 查看理解目标」
 * 落到的是一个上次会话残留的「已稳定」筛选，新激活的卡（状态是
 * 「还没正式答过」）被这个筛选全部挡掉，页面看起来是空的。
 */
export type ObjectiveLibraryFilter = "all" | "attention" | "progress" | "stable";

export type ObjectiveLibraryView = {
  workspaceId: string | null;
  query: string;
  filter: ObjectiveLibraryFilter;
  scrollTop: number;
  lastObjectiveId: string | null;
};

function emptyView(workspaceId: string | null = null): ObjectiveLibraryView {
  return { workspaceId, query: "", filter: "all", scrollTop: 0, lastObjectiveId: null };
}

let view = emptyView();

export function readObjectiveLibraryView(): ObjectiveLibraryView {
  return view;
}

export function writeObjectiveLibraryView(patch: Partial<ObjectiveLibraryView>): void {
  view = { ...view, ...patch };
}

/** 换一个工作区 = 上一批目标根本不在这里，残留的筛选只会指向空集。 */
export function retargetObjectiveLibraryView(workspaceId: string): void {
  view = emptyView(workspaceId);
}

/** 别的流程（生成 / 激活）跳进来看新东西时调用。 */
export function resetObjectiveLibraryView(): void {
  view = emptyView(view.workspaceId);
}
