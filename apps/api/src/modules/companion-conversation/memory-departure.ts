/**
 * 成员离开空间时的记忆收口（doc 34 L38）。
 *
 * 口径（2026-09-23 由用户拍定）：记忆归属于个人，`scope='workspace'` 的那一份只是
 * **关联**到某个空间；人离开就把关联那份收掉，`scope='global'`（带 `global_key`）不动。
 *
 * 为什么只能走数据库函数：`assistant_memory_items` 的策略要求
 * `user_id = current_setting('app.user_id')`，而 `removeMember` 的事务上下文是
 * (空间, **owner**)——按调用方身份去改那位成员的记忆会恒匹配 0 行（静默无效）。
 * 函数 `ailearn_retire_workspace_memories_on_departure`（迁移 0273）是 SECURITY DEFINER，
 * 授权只给 `ailearn_api`；这条路径的"能不能执行"由 roles.sql 里那份预期清单反向守着。
 *
 * 单独成文件是为了让 identity 侧（leave / removeMember）能引用它而不去拖整个
 * memory-service 的依赖面。
 */
import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";

export async function retireWorkspaceMemoriesOnDeparture(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT public.ailearn_retire_workspace_memories_on_departure(
      ${scope.workspaceId}::uuid, ${scope.userId}::uuid
    ) AS retired
  `);
  return Number((rows[0] as { retired: number | string } | undefined)?.retired ?? 0);
}
