/**
 * 迁移 0255 — 候选的 `dropped` 终态（§52/§53 的第一步）。
 *
 * 为什么先只做这一步：给 CHECK 增加一个合法值**不打断任何读写**（没人写它，
 * 也没人按它分支），所以它可以单独成为一次完整、可回滚的交付。真正的写入与
 * 读点收敛在下一步；这一步如果和那一步混在一起，中途失败就会留下
 * "库里有状态、代码不写、读点不认识"的三不管地带。
 *
 * 为什么不复用 `failed`：那会把"质量不合格"与"和别的卡重复/被 pedagogy 丢弃"
 * 混成一件——用户对前者的动作是重生成，对后者是什么都不用做。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_DIR = resolve(import.meta.dirname, "../db/migrations");
const TAG = "0255_candidate_quality_state_dropped";
const STATES = ["authored", "checking", "passed", "failed", "dropped"];

describe(`Migration ${TAG} — 候选 dropped 终态`, () => {
  const path = resolve(MIGRATION_DIR, `${TAG}.sql`);
  const sqlText = existsSync(path) ? readFileSync(path, "utf8") : "";

  it("文件存在且登记进 journal（清单是唯一迁移列表）", () => {
    assert.ok(sqlText.length > 0, `${TAG}.sql 不存在`);
    const entries = (JSON.parse(
      readFileSync(resolve(MIGRATION_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] }).entries;
    const position = entries.findIndex((entry) => entry.tag === TAG);
    assert.ok(position >= 0, "没登记进 journal 的迁移永远不会被应用");
    assert.equal(entries[position].idx, position);
    if (position > 0) {
      assert.ok(entries[position].when > entries[position - 1].when, "when 必须单调，否则应用顺序会反");
    }
  
  /**
   * 新状态必须有读者（§52 第 4 步）。这一条守的是"只加枚举不改读者"：
   * 合同不收这个值，review 页会整屏报错而不是少一张卡。
   */
  it("每个会读 qualityState 的地方都认识这个新值", () => {
    const readSites = [
      ["packages/shared/src/card-generation-v2-contracts.ts", /CandidateQualityStateValuesV2[\s\S]{0,400}"dropped",/],
      ["packages/shared/src/card-generation-desktop-contracts.ts", /qualityState: z\.enum\(\[[^\]]*"dropped"/],
      ["apps/desktop-client/src/renderer/src/components/CardGenerationSurface.tsx", /qualityState === "dropped"/],
    ] as const;
    for (const [file, pattern] of readSites) {
      const text = readFileSync(resolve(import.meta.dirname, "../../../..", file), "utf8");
      assert.ok(pattern.test(text), `${file} 还不认识 dropped（要么会整屏报错，要么显示成"待审核"）`);
    }
  });
});

  it("替换的是同一条约束，值集合就是那五个", () => {
    const body = sqlText.replace(/--.*$/gm, "");
    assert.match(body, /DROP CONSTRAINT cg_v2_cand_quality_chk/i);
    assert.match(body, /ADD CONSTRAINT cg_v2_cand_quality_chk/i);
    for (const state of STATES) {
      assert.ok(body.includes(`'${state}'`), `CHECK 里缺 ${state}`);
    }
    // 不能顺手把某个旧值删掉：那会让已落库的行在下次校验时变非法。
    for (const legacy of ["authored", "checking", "passed", "failed"]) {
      assert.ok(body.includes(`'${legacy}'`), `旧值 ${legacy} 被去掉了`);
    }
  
  /**
   * 新状态必须有读者（§52 第 4 步）。这一条守的是"只加枚举不改读者"：
   * 合同不收这个值，review 页会整屏报错而不是少一张卡。
   */
  it("每个会读 qualityState 的地方都认识这个新值", () => {
    const readSites = [
      ["packages/shared/src/card-generation-v2-contracts.ts", /CandidateQualityStateValuesV2[\s\S]{0,400}"dropped",/],
      ["packages/shared/src/card-generation-desktop-contracts.ts", /qualityState: z\.enum\(\[[^\]]*"dropped"/],
      ["apps/desktop-client/src/renderer/src/components/CardGenerationSurface.tsx", /qualityState === "dropped"/],
    ] as const;
    for (const [file, pattern] of readSites) {
      const text = readFileSync(resolve(import.meta.dirname, "../../../..", file), "utf8");
      assert.ok(pattern.test(text), `${file} 还不认识 dropped（要么会整屏报错，要么显示成"待审核"）`);
    }
  });
});

  it("drizzle schema 与迁移说的是同一件事", () => {
    const schema = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/shared/src/db-schema/card-generation-v2.ts"),
      "utf8",
    );
    const line = schema.split("\n").find((l) => l.includes("cg_v2_cand_quality_chk")) ?? "";
    for (const state of STATES) {
      assert.ok(line.includes(`'${state}'`), `schema 的 CHECK 里缺 ${state}（下一次 generate 会把它改回去）`);
    }
  });

  /**
   * 新状态必须有读者（§52 第 4 步）。这一条守的是"只加枚举不改读者"：
   * 合同不收这个值，review 页会整屏报错而不是少一张卡。
   */
  it("每个会读 qualityState 的地方都认识这个新值", () => {
    const readSites = [
      ["packages/shared/src/card-generation-v2-contracts.ts", /CandidateQualityStateValuesV2[\s\S]{0,400}"dropped",/],
      ["packages/shared/src/card-generation-desktop-contracts.ts", /qualityState: z\.enum\(\[[^\]]*"dropped"/],
      ["apps/desktop-client/src/renderer/src/components/CardGenerationSurface.tsx", /qualityState === "dropped"/],
    ] as const;
    for (const [file, pattern] of readSites) {
      const text = readFileSync(resolve(import.meta.dirname, "../../../..", file), "utf8");
      assert.ok(pattern.test(text), `${file} 还不认识 dropped（要么会整屏报错，要么显示成"待审核"）`);
    }
  });
});
