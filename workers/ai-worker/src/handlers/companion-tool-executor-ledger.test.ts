/**
 * 「她叫得出名字的工具，服务端到底有没有一段代码去执行它」的台账守卫（39d W2-4 的先决缺陷 #16）。
 *
 * 症状长这样：模型调 `companion_request_hint`，worker 的 switch 走到
 * `default: throw new CompanionToolError("tool has no direct executor")`——
 * registry 里有它、提示词里有它、界面上她说了要帮忙，然后那一轮报错。
 * 而**只有 full 档会走到这一步**：`requiresConfirmation=true` 的工具在 guided 档
 * 被拦成提案（提案那条路由由 API 侧执行），full 档按"用户已预授权"直接执行
 * （`companion-agent-registry.ts:128` 那段注释就是这个语义）。
 * 所以这条链在低权限档一路都是绿的，红只在免确认那一档——正是要拿它做 W2-4
 * 两处免确认（求助／换题）时才会撞上的那面墙。
 *
 * 两侧现读，不抄第二份名单：
 *  - 有哪些工具：registry 导出的 `COMPANION_AGENT_TOOL_DEFINITIONS`（活的合同）；
 *  - 哪些有执行分支：读运行时源码里两个执行器函数各自的 `case "companion_x"`。
 * 判据匹配**调用形状**（`case "名字"`），只匹配 import 行会让"提了名字但没分支"蒙混过关
 * ——我第一次量就踩到这个：注释里写着"已删除的 companion_read_memory"，
 * 按名字全文扫会把它算成活工具、数出 7 条，实际是 6 条。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@ailearn/shared/companion-agent-registry";
import { COMPANION_PROPOSAL_EXECUTED_TOOLS } from "@ailearn/shared/companion-agent-contracts";

const RUNTIME_SOURCE = readFileSync(
  resolve(import.meta.dirname, "companion-agent-runtime.ts"),
  "utf8",
);

/** 取出某个顶层函数体的文本（花括号配平；够用且不需要解析器）。 */
function functionBody(name: string): string {
  const start = RUNTIME_SOURCE.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `运行时里找不到函数 ${name}——改名了就要同步这张表`);
  let depth = 0;
  for (let index = RUNTIME_SOURCE.indexOf("{", start); index < RUNTIME_SOURCE.length; index += 1) {
    if (RUNTIME_SOURCE[index] === "{") depth += 1;
    else if (RUNTIME_SOURCE[index] === "}") {
      depth -= 1;
      if (depth === 0) return RUNTIME_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error(`${name} 的花括号没配平`);
}

function handledTools(): Set<string> {
  const arms = new Set<string>();
  for (const fn of ["executeReadTool", "executeDirectTool"]) {
    for (const match of functionBody(fn).matchAll(/case "(companion_[a-z_]+)"/g)) arms.add(match[1]);
  }
  return arms;
}

/**
 * 当前**没有**直执行器的工具（只许变短）。每条都写清"为什么还留着"，
 * 实现完执行器却不删这里的一条 ⇒ `staleEntries` 那条会红。
 *
 * 这六条都是**动作类**：它们在 worker 这侧没有直执行器，但**命令本体不是没有**——
 * 六条的业务执行都在 API 侧提案确认那一个函数里（`learning-action-bridge.ts` 的
 * `decideCompanionProposal`，按 payload 的 `kind` 分支：`start_learning_run_v2`／
 * `resume_learning_run`／`pause_learning_run`／`request_hint_level`／`switch_task_variant`／
 * `defer_review`，最后那条另走 `review/review-defer-service.ts`），
 * 并由 `tool-gateway-postgres.integration.ts` 覆盖（提示那一条还是 exposure-first 的形状）。
 * ⇒ **这张表不该被读成"去 worker 里补六段执行器"**：那会给同一条业务命令造出第二个实现。
 * full 档真正欠的是一个决定——预授权的那一档要不要由服务端把同一份提案**自动确认**掉
 * （审计三行、exposure-first、客户端 `autoExecute` 那套既有标志都得跟着走）。
 *
 * 指位置只写**函数名与 `kind` 名**，不写行号：那份文件正被并行会话改，行号会静默失效，
 * 而 `kind` 名是被 grep 得到的、也是分支本身的身份。
 */
const PENDING_DIRECT_EXECUTOR: Readonly<Record<string, string>> = {
  companion_start_learning: "命令在 decideCompanionProposal 的 start_learning_run_v2 分支；界面上另有开跑入口（39d W4-2）",
  companion_resume_learning: "命令在 decideCompanionProposal 的 resume_learning_run 分支；提案那条路由已接",
  companion_pause_learning: "命令在 decideCompanionProposal 的 pause_learning_run 分支；full 档欠自动确认那一步",
  companion_switch_task_variant: "命令在 decideCompanionProposal 的 switch_task_variant 分支；full 档欠自动确认那一步",
  companion_request_hint: "命令在 decideCompanionProposal 的 request_hint_level 分支（exposure-first）；full 档欠自动确认",
  companion_defer_review: "命令在 decideCompanionProposal 的 defer_review 分支与 review-defer-service；界面上队列那颗按钮已做同一件事",
};

const live = COMPANION_AGENT_TOOL_DEFINITIONS.map((entry) => entry.name);

test("正控制：台账两侧都真的读到了东西（读不到时差集为空就是假绿）", () => {
  assert.ok(live.length >= 25, `registry 只数出 ${live.length} 条工具，扫描/导入形状变了`);
  const arms = handledTools();
  assert.ok(arms.size >= 20, `运行时只数出 ${arms.size} 个 case 分支，判据没读到函数体`);
  // 已知有分支的样本：拿一条**确实存在**的工具证明判据认得它（不是只数出 20 个别的名字）。
  assert.ok(arms.has("companion_open_page"), "companion_open_page 明明有分支却没被读到 ⇒ 判据形状错了");
  assert.ok(arms.has("companion_save_memory"), "写类执行器的分支没读到 ⇒ 两把函数漏了一把");
});

test("每一条活工具：要么有执行分支，要么在欠账表里写明为什么没有", () => {
  const arms = handledTools();
  const unaccounted = live
    .filter((name) => !arms.has(name))
    .filter((name) => !(name in PENDING_DIRECT_EXECUTOR));
  assert.deepEqual(unaccounted, [], "这些工具她叫得出名字、运行时一句 `no direct executor`——补分支或记进欠账表并给理由");

  // 反向：欠账表里不许留下已经不需要它的条目（实现完忘了删，这张表就变成了免死金牌）。
  const stale = Object.keys(PENDING_DIRECT_EXECUTOR).filter((name) => arms.has(name));
  assert.deepEqual(stale, [], "这些工具已经有执行分支了，欠账条目该删");

  // 幻影：表里写了早就不存在的工具名。
  const phantom = Object.keys(PENDING_DIRECT_EXECUTOR).filter((name) => !live.includes(name));
  assert.deepEqual(phantom, [], "欠账表里有 registry 已经没有的工具");
});

/**
 * 这一条是 #16 真正会咬人的地方：**只有需要确认的工具才可能"永远走不到直执行器"**。
 * 一条 `requiresConfirmation === false` 的工具如果被摘成自动执行，它每一档都会撞
 * `throw`（不再只是 full 档）——那种形状必须红，而不是等用户在只读档点她一次。
 */
test("没有执行分支的工具必须是需要确认的那一类（否则它在所有权限档都会撞 throw）", () => {
  const arms = handledTools();
  const exposed = COMPANION_AGENT_TOOL_DEFINITIONS
    .filter((entry) => !arms.has(entry.name))
    .filter((entry) => !entry.requiresConfirmation)
    .map((entry) => `${entry.name}（riskClass=${entry.riskClass}，不需要确认却没有执行分支）`);
  assert.deepEqual(exposed, [], "这些工具任何一档都会直接执行，却没有一段代码执行它");
});

test("会红自证：漏登记与忘删两种形状都逮得住（合成输入，不依赖真实文件今天长什么样）", () => {
  const detect = (names: string[], arms: string[], pending: string[]) =>
    names.filter((name) => !arms.includes(name) && !pending.includes(name));
  // ① 该报：新加一条工具，没分支也没记账。
  assert.deepEqual(detect(["companion_open_page", "companion_brand_new"], ["companion_open_page"], []),
    ["companion_brand_new"]);
  // ② 不该报：记进欠账表就放过。
  assert.deepEqual(detect(["companion_brand_new"], [], ["companion_brand_new"]), []);
  // ③ 忘删：有分支却还留在表里，由 stale 那一路点名（这里复算同一条判据）。
  const stale = (pending: string[], arms: string[]) => pending.filter((name) => arms.includes(name));
  assert.deepEqual(stale(["companion_open_page"], ["companion_open_page"]), ["companion_open_page"]);
  assert.deepEqual(stale(["companion_brand_new"], ["companion_open_page"]), []);
});

/**
 * 权限判据与这张表必须说的是同一批工具。
 *
 * `COMPANION_PROPOSAL_EXECUTED_TOOLS`（shared）管的是"full 档也别去直执行这几条"，
 * 本表管的是"这几条没有直执行器"。**两件事同一批工具**——一份名单两处各抄一遍，
 * 迟早一处加了另一处没加：多出来的那半会让某个工具既"没人执行"又"没人确认"，
 * 少的那半会让 full 档重新撞上那面墙。所以这里双向对账，不靠注释提醒。
 */
test("权限判据里那份「提案执行」名单与本表是同一批工具（双向对账）", () => {
  const proposalExecuted = [...COMPANION_PROPOSAL_EXECUTED_TOOLS].sort();
  const pending = Object.keys(PENDING_DIRECT_EXECUTOR).sort();
  assert.deepEqual(proposalExecuted, pending,
    "shared 的 COMPANION_PROPOSAL_EXECUTED_TOOLS 与本表 PENDING_DIRECT_EXECUTOR 不再是同一批工具");
  // 这批工具确实**没有**直执行器（有分支却还留在两处名单里 = 两处都过期了）。
  const arms = handledTools();
  assert.deepEqual(pending.filter((name) => arms.has(name)), [],
    "这些工具已经有直执行器了，两份名单都该删它");
});

/**
 * 「有 case」还不够，case 必须长在**派活规则真会送去的那个执行器**里。
 *
 * 2026-09-25 量到的真实故障：`companion_focus_graph` 的实现写在 `executeReadTool`，
 * 而派活是 `definition.riskClass === "read" ? executeReadTool : executeDirectTool`
 * （`companion-agent-runtime.ts:2114`），它的档位是 `reversible_low` ⇒ 每次都被派去
 * `executeDirectTool`，在那里找不到分支、撞 `default` 的 throw。**上一版台账把两个函数
 * 的 case 并成一个集合**，所以它数出来"有分支"、这条守卫一直是绿的——
 * 那是我的判据形状错了，不是实现错了：并集看不见"住在哪一边"。
 */
test("每一条 case 都长在派活规则真会送去的那个执行器里", () => {
  const dispatch = /riskClass === "read"\s*\n?\s*\?\s*await executeReadTool/.test(RUNTIME_SOURCE)
    || /riskClass === "read"[\s\S]{0,40}\?\s*await executeReadTool/.test(RUNTIME_SOURCE);
  assert.ok(dispatch, "派活规则的形状变了（不再按 riskClass=read 分流）——这条判据要先跟着改");

  const readArms = new Set([...functionBody("executeReadTool").matchAll(/case "(companion_[a-z_]+)"/g)].map((m) => m[1]));
  const directArms = new Set([...functionBody("executeDirectTool").matchAll(/case "(companion_[a-z_]+)"/g)].map((m) => m[1]));
  const both = [...readArms].filter((name) => directArms.has(name));
  assert.deepEqual(both, [], "同一个工具在两处各有一个 case：派活规则送过去的那一个才是活的，另一个是第二份实现");

  const misplaced = COMPANION_AGENT_TOOL_DEFINITIONS
    .filter((definition) => definition.riskClass === "read" ? !readArms.has(definition.name) : !directArms.has(definition.name))
    .filter((definition) => readArms.has(definition.name) || directArms.has(definition.name))
    .map((definition) => `${definition.name}（档位 ${definition.riskClass}）的 case 在 ${
      definition.riskClass === "read" ? "executeDirectTool" : "executeReadTool"}，派活规则却送去另一边`);
  assert.deepEqual(misplaced, [], "这些工具的 case 长在派活规则不会送到的那个执行器里，运行时等于没有分支");

  // 正控制：这条判据认得"两边各有一批"这个现状（两边都空就是判据在空转）。
  assert.ok(readArms.size >= 10, `读取执行器只数出 ${readArms.size} 个 case`);
  assert.ok(directArms.size >= 5, `直执行器只数出 ${directArms.size} 个 case`);
  // 点名一条**已知在直执行器**里的，证明方向没写反（写反时上面那条会以相反的理由全绿）。
  assert.ok(directArms.has("companion_focus_graph"),
    "companion_focus_graph 的 case 不在直执行器里：它就是这条判据要防的那次搬家");
});
