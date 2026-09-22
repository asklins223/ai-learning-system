/**
 * 笔记可见性的**唯一判据文本**（服务端与 Worker 共用）。
 *
 * 规则：一篇笔记要么已经由作者显式共享给空间（`share_scope = 'shared'`），要么
 * 只有作者自己看得见（`created_by = 查看者`）。新建笔记默认 `private`，共享是一次
 * 显式动作（迁移 0248、`PRODUCT.md:127` 的只读协作边界）。
 *
 * ─── 为什么要单独放在 shared ───
 * 这条判据原先只在 `apps/api/src/modules/note/visibility.ts` 里，而伴星跑在
 * `workers/ai-worker`——**另一个进程、另一个包**。结果是：HTTP 那侧的列表/搜索/
 * 卡片/目标全都按人收窄了，伴星的 `companion_read_note` 与 here-and-now 快照
 * 仍然只按 `workspace_id` 查 `notes`。协作空间里，成员甲的伴星因此能读出成员乙
 * **私有笔记的正文**——比审查初稿抓到的"标题注入 prompt"更重一档。
 *
 * 判据散在两个包里就会漂移，所以文本在这里写一次：
 *   - API 的 drizzle 读点用 `noteVisibleConditionSql`（下面这段文本）；
 *   - Worker 的手写 SQL 直接把它插进模板；
 *   - 已握在手里的行用 `isNoteVisibleToViewer`。
 *
 * `viewerExpr` 是 SQL **表达式**而不是绑定参数：伴星那张图里它是 `m.user_id`
 * （记忆行自带主人），搜索那条路里它是 `v.viewer`（`CROSS JOIN` 带进来的列）。
 * 接占位符字符串做不到这件事——序号只有拼模板的那一方知道。
 */
export function noteVisibleSqlText(alias: string, viewerExpr: string): string {
  return `(${alias}.share_scope = 'shared' OR ${alias}.created_by = ${viewerExpr})`;
}

/** 同一句话的行内版本：行已经读出来了，判断要不要算他看得见。 */
export function isNoteVisibleToViewer(
  row: { shareScope: string; createdBy: string },
  userId: string,
): boolean {
  return row.shareScope === "shared" || row.createdBy === userId;
}

export const NOTE_SHARE_SCOPES = ["private", "shared"] as const;
export type NoteShareScope = (typeof NOTE_SHARE_SCOPES)[number];

export function isNoteShareScope(value: unknown): value is NoteShareScope {
  return value === "private" || value === "shared";
}
