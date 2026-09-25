/**
 * **id 语义不许跨表**（39b §9.2 / 39d W2-1 判据 2）。
 *
 * 要防的那件事有一个真实样本：`companion_focus_graph` 的参数曾叫 `keyPointId`，而它执行时
 * 打的是 `learning_objectives_v2.objective_id`——库里 `key_point_id` 是**另一个 id-space**
 * （`validation_assistance_exposures.key_point_id → card_key_points.id`）。名字说谎的代价不是
 * 报错，是**读代码的人按名字推断语义，然后推错**；模型也会按参数名组织参数。
 *
 * 判据分两层，缺一不成立：
 *  1. **每个 `*Id` 参数都必须在下面这张表里显式登记**（没登记即红）——登记动作本身就是复核；
 *  2. **登记的目标列必须与参数名对得上**：列名要么等于参数名的下划线形式（`objectiveId`
 *     → `objective_id`），要么就是 `id`（`noteId` → `notes.id`，即"某实体的主键"这一种
 *     命名法）。两条都不满足 = 参数名在指向另一个 id-space，红。
 *     —— 旧状态 `keyPointId` → `objective_id` 正是这样被抓住的：`key_point_id` 既不等于
 *     `objective_id` 也不是 `id`。
 *
 * 写在 worker 侧是因为"登记的目标表/列得在执行体里真的出现"这一条要读运行时代码。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@ailearn/shared/companion-agent-registry";

/** 目标不是表列时用它显式说明是什么，而不是留空。 */
type IdTarget = { readonly table: string; readonly column: string } | {
  readonly opaque: true;
  readonly note: string;
};

/**
 * 「参数名 → 目标表.列」的冻结登记（39b §9.2 要求的那个显式动作）。
 *
 * 新增带 `*Id` 参数的工具时，**必须**在这里加一行；漏了第一条用例就会红。
 * 目标列名与参数名对不上的（第二条用例）要么改参数名，要么改到名字说的是那一列。
 */
const PARAM_TARGETS: Readonly<Record<string, Readonly<Record<string, IdTarget>>>> = {
  companion_read_note: { noteId: { table: "notes", column: "id" } },
  companion_open_note: { noteId: { table: "notes", column: "id" } },
  companion_open_card: { cardId: { table: "learning_cards_v2", column: "card_id" } },
  companion_focus_graph: { objectiveId: { table: "learning_objectives_v2", column: "objective_id" } },
  // 可选参数（39d W2-1 的裁定）：给了就按那篇笔记收窄查找范围，所以目标仍是 notes。
  companion_start_learning: { noteId: { table: "notes", column: "id" } },
  companion_resume_learning: { noteId: { table: "notes", column: "id" } },
  companion_pause_learning: { runId: { table: "learning_runs", column: "id" } },
  companion_request_hint: {
    runId: { table: "learning_runs", column: "id" },
    taskId: { table: "learning_tasks", column: "id" },
  },
  companion_switch_task_variant: {
    runId: { table: "learning_runs", column: "id" },
    taskId: { table: "learning_tasks", column: "id" },
    // 不是表列：它是本题候选里某个变体的描述符 id，随 `switch_variant` 动作交给 LearningRun。
    alternativeId: { opaque: true, note: "任务候选变体的描述符 id，随 switch_variant 动作传递，不落列" },
  },
  companion_defer_review: { scheduleId: { table: "review_schedules", column: "id" } },
  companion_cancel_reminder: { reminderId: { table: "companion_reminders", column: "id" } },
  companion_forget_memory: { memoryId: { table: "assistant_memory_items", column: "id" } },
  companion_read_image: {
    noteId: { table: "notes", column: "id" },
    assetId: { table: "note_image_assets", column: "id" },
  },
  companion_show_image: {
    noteId: { table: "notes", column: "id" },
    assetId: { table: "note_image_assets", column: "id" },
  },
};

const ID_PARAM = /^[a-z][A-Za-z]*Id$/;
const snake = (value: string) => value.replace(/Id$/, "").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) + "_id";

const runtimeSource = readFileSync(new URL("./handlers/companion-agent-runtime.ts", import.meta.url), "utf8");

/** 收集每个工具参数表里的 `*Id` 参数。 */
function idParams(): Array<{ tool: string; param: string }> {
  const found: Array<{ tool: string; param: string }> = [];
  for (const definition of COMPANION_AGENT_TOOL_DEFINITIONS) {
    const properties = definition.parameters.properties as Record<string, unknown> | undefined;
    for (const param of Object.keys(properties ?? {})) {
      if (ID_PARAM.test(param)) found.push({ tool: definition.name, param });
    }
  }
  return found;
}

test("每个 *Id 参数都在登记表里；登记的表/列必须真的出现在执行体里", () => {
  const declared = idParams();
  // 正控制：登记表本身得有内容，扫到 0 条等于没扫。
  assert.ok(declared.length >= 12, `只扫到 ${declared.length} 个 *Id 参数，判据可能读空了`);

  const undeclared = declared
    .filter(({ tool, param }) => !(param in (PARAM_TARGETS[tool] ?? {})))
    .map(({ tool, param }) => `${tool}.${param}`);
  assert.deepEqual(
    undeclared, [],
    "这些 *Id 参数没有登记目标表/列——登记本身就是复核，漏登记等于没人看过它指向哪张表",
  );

  const fictional: string[] = [];
  for (const [tool, targets] of Object.entries(PARAM_TARGETS)) {
    for (const [param, target] of Object.entries(targets)) {
      if ("opaque" in target) continue;
      // 登记不能是空想：表名与列名都要在执行体里找得到。
      if (!runtimeSource.includes(target.table)) fictional.push(`${tool}.${param} → 表 ${target.table}`);
      if (!runtimeSource.includes(target.column)) fictional.push(`${tool}.${param} → 列 ${target.column}`);
    }
  }
  assert.deepEqual(fictional, [], "登记的目标在执行体里搜不到——要么登记写错了，要么这个参数没在执行体里用");
});

test("登记的列名必须与参数名对得上，否则就是在指向另一个 id-space", () => {
  const offenders: string[] = [];
  for (const [tool, targets] of Object.entries(PARAM_TARGETS)) {
    for (const [param, target] of Object.entries(targets)) {
      if ("opaque" in target) continue;
      const expected = snake(param);
      // 两种合法命名法：列名就是参数名的下划线形式，或者它是该实体的主键 `id`。
      if (target.column !== expected && target.column !== "id") {
        offenders.push(`${tool}.${param} → ${target.table}.${target.column}（既不是 ${expected} 也不是 id）`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    "参数名指向的 id-space 与它实际打的列不是同一个——这正是 `keyPointId → objective_id` 被抓住的形状",
  );
});

test("正负对照：判据认得出跨表的形状，也放过两种合法命名法", () => {
  const check = (param: string, target: { table: string; column: string }) => {
    const expected = snake(param);
    return target.column === expected || target.column === "id";
  };

  // 正控制——该报：名字说 key point，打的是 objective。
  assert.equal(check("keyPointId", { table: "learning_objectives_v2", column: "objective_id" }), false);
  assert.equal(check("cardId", { table: "learning_objectives_v2", column: "objective_id" }), false);

  // 负控制——两种合法命名法都放过。
  assert.equal(check("objectiveId", { table: "learning_objectives_v2", column: "objective_id" }), true);
  assert.equal(check("noteId", { table: "notes", column: "id" }), true);
  assert.equal(check("cardId", { table: "learning_cards_v2", column: "card_id" }), true);
});
