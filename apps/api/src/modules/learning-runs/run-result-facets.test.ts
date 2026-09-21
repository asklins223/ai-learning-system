import { test } from "node:test";
import assert from "node:assert/strict";
import { uncoveredFacets } from "./run-result-facets.ts";

const item = (facet: string, verdict: string) => ({ facet, verdict });

/**
 * 钉住 31 号文档 P1：练习结算此前无条件把本次 intent 写成缺口，所以四条 rubric
 * 全 covered 的作答会同时得到「还需补上：回忆」与四行「回忆 · 说清了」。
 */
test("每一条都判为 covered 时，缺口为空——这一条就是旧代码伪造出缺口的那一处", () => {
  assert.deepEqual(uncoveredFacets([
    item("recall", "covered"),
    item("recall", "covered"),
    item("recall", "covered"),
    item("recall", "covered"),
  ]), []);
});

test("只有未 covered 的 facet 算缺口，且同一个 facet 不重复出现", () => {
  assert.deepEqual(uncoveredFacets([
    item("recall", "covered"),
    item("explain", "partial"),
    item("apply", "missing"),
    item("explain", "contradicted"),
  ]), ["explain", "apply"]);
});

test("partial 与 not_assessable 都算没说到——只有 covered 才算说清", () => {
  assert.deepEqual(
    uncoveredFacets([item("boundary", "partial"), item("procedure", "not_assessable")]).sort(),
    ["boundary", "procedure"],
  );
});

test("没有判定时不推断任何缺口", () => {
  assert.deepEqual(uncoveredFacets([]), []);
});
