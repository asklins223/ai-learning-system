/**
 * 生产 CommitExecutor：episode-commit.commitEpisode 绑定 Pg CommitPort。
 *
 * commitEpisode 是纯编排（幂等 commit key + CAS 锁序 + canonical/schedule
 * 写端口注入）；createPgCommitPort(transaction) 是真实 PostgreSQL 端口
 * （commit-port-pg.ts）。本文件只做绑定，不含任何业务逻辑。
 */

import type { ApiTransaction } from "../../db/client.ts";
import { commitEpisode } from "./episode-commit.ts";
import { createPgCommitPort } from "./commit-port-pg.ts";
import type { CommitExecutor } from "./vertical-slice.ts";

export function createPgCommitExecutor(transaction: ApiTransaction): CommitExecutor {
  const port = createPgCommitPort(transaction);
  return (input) => commitEpisode(input, port);
}
