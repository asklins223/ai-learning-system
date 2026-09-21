import { eq, exists, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { notes, noteVersions } from "@ailearn/shared/db-schema/note";

/**
 * 笔记归属的唯一判据（批次 4.5）。
 *
 * 规则：**新建的笔记默认「仅自己可见」**，共享是一次显式动作（界面上的
 * 「共享给空间」），并且作者随时可以撤回。产品口径是"共享学习空间只共享学习资料"，
 * 而一篇没拿出去的笔记还不是资料，是作者自己的东西。
 *
 * 这一列不能从空间类型推（协作空间里同样有只给自己的笔记），也不能从 `created_by`
 * 推（作者写的同样可以共享出去），所以它必须是一个独立的、由人决定的值。
 *
 * 为什么要专门一个文件：`notes` 的 RLS 本轮没重开（`note_blocks` / `note_versions`
 * 的策略还只按 workspace_id 判），这条边界目前**完全靠应用层每个读点带上同一个谓词**。
 * 判据散开写就会出现"列表挡住了、搜索没挡"那一类分裂——这正是审查里反复出现的那件事。
 * 所以：drizzle 读点用 `visibleNotesCondition`，手写 SQL 用 `noteVisibleSqlText`，
 * 已经握在手里的那一行用 `isNoteVisibleToViewer`。三个入口，一个规则。
 */

export const NOTE_SHARE_SCOPES = ["private", "shared"] as const;
export type NoteShareScope = (typeof NOTE_SHARE_SCOPES)[number];

export function isNoteShareScope(value: unknown): value is NoteShareScope {
  return value === "private" || value === "shared";
}

/** 判据那一句话。改动它等于改动全仓库的笔记可见性，所以只写一次。 */
export function visibleNotesCondition(userId: string): SQL {
  return or(eq(notes.shareScope, "shared"), eq(notes.createdBy, userId)) as SQL;
}

/** 同一句话的行内版本：给"行已经读出来了，要不要算他看得见"这种判断。 */
export function isNoteVisibleToViewer(
  row: { shareScope: string; createdBy: string },
  userId: string,
): boolean {
  return row.shareScope === "shared" || row.createdBy === userId;
}

/**
 * 同一句话的手写 SQL 版本。
 *
 * `viewerExpr` 是一个 SQL **表达式**而不是绑定参数：伴星那张图里它是 `m.user_id`
 * （记忆行自带主人），搜索那条路里它是 `v.viewer`（`CROSS JOIN (SELECT $1::uuid AS viewer)`
 * 带进来的那一列）。之所以不接占位符字符串：调用方拼的是参数化模板，占位符序号只有
 * 那里知道，而这一段话必须一字不差地复用。
 *
 * 与上面 drizzle 那条是同一规则的两种写法，这是本仓少有的重复。**故意留一份测试**
 * 去执行它们并比对结果集（`note-share-scope-postgres.integration.ts`），而不是比字符串——
 * 字符串相等证明不了两条路在同一份数据上给同样的答案。
 */
export function noteVisibleSqlText(alias: string, viewerExpr: string): string {
  return `(${alias}.share_scope = 'shared' OR ${alias}.created_by = ${viewerExpr})`;
}

/**
 * 搜索索引那张表专用：`search_documents` 没有用户列，判可见性必须回连 `notes`。
 *
 * 为什么在查询侧判而不是在**建索引**时判：索引是整个空间共用的一份。建索引时按某个人
 * 可见的范围裁剪，等于把"他的视角"烧进大家共用的那份数据——下一次换成 owner 触发重
 * 索引，私有笔记就谁也都搜不到了（连作者自己）。所以索引照旧收全量，发不发出去由
 * 这一次 join 决定。
 *
 * 返回的片段假设外层已经把查看者放进了一个 `v(viewer)` 的 CROSS JOIN。
 */
export function noteVisibleForSearchIndexSql(): string {
  return `(search_document.object_type <> 'note' OR EXISTS (
    SELECT 1 FROM public.notes visible_note
    WHERE visible_note.id = search_document.object_id
      AND visible_note.workspace_id = search_document.workspace_id
      AND visible_note.deleted_at IS NULL
      AND ${noteVisibleSqlText("visible_note", "v.viewer")}
  ))`;
}

/**
 * 卡片的可见性跟着它的**来源笔记**走（批次 4.5）。
 *
 * 一条学习卡是从某篇笔记的某个版本抽出来的正文摘录。空间规则说"只共享学习资料"，
 * 所以一篇没拿出去的笔记，从它生成的卡也没理由被全空间看见——否则"仅自己可见"
 * 只是把笔记本体藏起来，正文照样从卡片那一侧漏出去。
 *
 * 没有来源笔记的卡（手动建立的目标卡等，`note_version_id IS NULL`）不受这条约束：
 * 它没有可追溯的私有来源。
 *
 * 判据仍然只写一次：这里是把上面那句 `visibleNotesCondition` 原样嵌进相关子查询，
 * 所以"笔记可见性规则"改了这里自动跟上，不存在第二套会互相矛盾的口径。
 *
 * 参数是**列**而不是表名：调用方各自持有的那张卡的引用不一样（有的按 `cardId` 查，
 * 有的按 `objectiveId` 查），而 `learning_cards_v2` 属于卡片那一层的 schema，
 * 判据文件不该反过来依赖它。
 */
export function visibleCardsCondition(
  userId: string,
  cardNoteVersionId: SQLWrapper,
): SQL {
  return or(
    isNull(cardNoteVersionId),
    exists(
      sql`(SELECT 1 FROM ${noteVersions} JOIN ${notes} ON ${notes.id} = ${noteVersions.noteId}
           WHERE ${noteVersions.id} = ${cardNoteVersionId} AND ${visibleNotesCondition(userId)})`,
    ),
  ) as SQL;
}
