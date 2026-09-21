/**
 * 迁移 0253 — 候选的「同一目标同一版本只能有一行」唯一索引（A1 的前置）。
 *
 * 为什么现在必须钉这条（`docs/plans/objective-card-items-2026-09-21.md` §21/§38）：
 * 逐候选可见（A1）要求管道**每写完一张就提交一次**，于是同一个 job 被重投时，
 * 第二次会对同一批理解目标再插一遍——`insertAuthoredCandidatesBatched` 是裸 INSERT，
 * 既没有 ON CONFLICT 也没有先删后插。没有这条唯一索引，幂等只能靠"记得检查"，
 * 而"记得检查"在并发重投下不是控制。
 *
 * 键为什么带 revision：2026-09-21 对 dev 库 1600 行候选实测
 *   distinct (run_id, objective, revision) = 1600 —— 今天已成立，建索引不动任何数据；
 *   distinct (run_id, objective)           = 1545 —— 同一目标确实可以有 revision 2
 *     （regenerate_candidate 与有界修复走的就是这条路），所以 revision 不能拿掉。
 * 也没有任何目标对应过两个 candidate_id，"1 个计划目标 : 1 张候选" 是现行事实。
 *
 * 键为什么**必须带 plan_version**（第一次应用之后才查出来的那一步）：replan_set 把旧计划的
 * 候选 `supersede` 而**不删除**（immutable），再用 `planVersion+1` 的新计划重新 author 一批；
 * 新计划的 `objectiveLocalId` 同样由原子下标导出（`obj-atom-1`…），revision 也从 1 起。
 * 少了 plan_version，这一批就会撞在索引上——等于把「再生成一次候选」和整条 replan 路
 * 当场打死。dev 库里 `plan_version>1` 的候选是 0 行，所以旧键也建得起来，但那是
 * "这条路还没跑过"，不是"这条键选对了"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_DIR = resolve(import.meta.dirname, "../db/migrations");
const TAG = "0253_candidate_objective_revision_unique";
const INDEX_NAME = "cg_v2_cand_plan_objective_revision_idx";
// 第一次应用用的键少了 plan_version，索引名也一起换掉（不是改名，是换约束）。
const SUPERSEDED_INDEX_NAME = "cg_v2_cand_objective_revision_idx";

function readSql(): string {
  const path = resolve(MIGRATION_DIR, `${TAG}.sql`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readJournal(): { idx: number; tag: string }[] {
  const raw = JSON.parse(
    readFileSync(resolve(MIGRATION_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  return raw.entries;
}

describe(`Migration ${TAG} — 候选目标/版本唯一索引`, () => {
  const sql = readSql();

  it("迁移文件存在（清单与文件一一对应由 migration-journal-coverage 守，这里守内容）", () => {
    assert.ok(sql.length > 0, `${TAG}.sql 不存在——清单里有文件却没有 SQL 也是白登记`);
  });

  it("建的是 UNIQUE 索引，键为 (workspace_id, run_id, plan_version, plan_objective_local_id, revision)", () => {
    const normalized = sql.replace(/\s+/g, " ");
    const statement = normalized.match(
      new RegExp(`CREATE UNIQUE INDEX[^;]*${INDEX_NAME}[^;]*`, "i"),
    );
    assert.ok(statement, "必须是 CREATE UNIQUE INDEX——普通索引挡不住重投重复插");
    const body = statement[0];
    for (const column of ["workspace_id", "run_id", "plan_version", "plan_objective_local_id", "revision"]) {
      assert.match(body, new RegExp(`\\b${column}\\b`), `索引里缺列 ${column}`);
    }
    // 列序也是合同的一部分：workspace_id 打头才和这张表其余索引同构（RLS Scoped）。
    assert.ok(
      body.indexOf("plan_version") < body.indexOf("plan_objective_local_id"),
      "plan_version 必须排在 plan_objective_local_id 之前——它正是「哪一版计划」的判据",
    );
  });

  it("先把少了 plan_version 的那版索引-drop 掉（dev 库已经建过它）", () => {
    assert.match(
      sql,
      new RegExp(`DROP INDEX[^;]*${SUPERSEDED_INDEX_NAME}`, "i"),
      "旧索引还在的话，两条索引会同时约束同一批行，而其中一条是错的",
    );
  });

  it("只建索引：不动数据、不加外键、不删行", () => {
    const normalized = sql
      .replace(/--.*$/gm, "")
      .replace(/\s+/g, " ")
      .replace(/DROP INDEX[^;]*;/i, "")
      .trim();
    assert.doesNotMatch(normalized, /\bDELETE\b/i, "清理重复行等于把历史批次改写成别的样子");
    assert.doesNotMatch(normalized, /\bFOREIGN KEY\b/i, "这条约束不需要外键");
    assert.doesNotMatch(normalized, /\bUPDATE\b/i);
    assert.match(normalized, /^CREATE UNIQUE INDEX/i, "除了 drop 旧索引，这个迁移只应当新建一条索引");
  });

  it("journal 登记了它，且排在既有尾部之后（不重编号别人的条目）", () => {
    const entries = readJournal();
    const position = entries.findIndex((entry) => entry.tag === TAG);
    assert.ok(position >= 0, "没登记进 journal 的迁移永远不会被应用");
    assert.equal(position, entries.length - 1, "新条目应当追加在尾部");
    assert.equal(entries[position].idx, entries.length - 1);
  });

  it("drizzle schema 声明了同名索引（代码与库不许各说各话）", () => {
    const schemaPath = resolve(
      import.meta.dirname,
      "../../../../packages/shared/src/db-schema/card-generation-v2.ts",
    );
    const schema = readFileSync(schemaPath, "utf8");
    assert.ok(
      schema.includes(`uniqueIndex("${INDEX_NAME}")`),
      "schema 里没有这条唯一索引——下一次 drizzle-kit generate 会把它当多余对象删掉",
    );
    assert.match(
      schema,
      new RegExp(`uniqueIndex\\("${INDEX_NAME}"\\)\\.on\\([^)]*planVersion[^)]*planObjectiveLocalId[^)]*revision[^)]*\\)`),
      "schema 里的索引列必须与迁移一致",
    );
  });
});
