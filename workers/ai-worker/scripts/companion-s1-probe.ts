/**
 * S1 探针台（39d W2-4 #15）：删分类器之前要先量得准的那两件事。
 *
 * 判据（39b §9.5 / 39d W2-4）：
 *  ① `toolChoice:"required"` 下**一步都不出 tool_calls** 的比例——只有真模型跑得出来；
 *  ② 模型给的参数**不合该工具 schema** 的比例——这一项**不花钱**：库里每一发
 *     `companion_agent_tool_calls.arguments` 都是模型当时真写出来的东西。
 *
 * 所以这个台子分两层，**分层是刻意的**：② 今天就能出数，① 要 `REAL_MODEL_BATCH=1`
 * 才动（花钱的批次由人批准，见仓库那条"先确定性后花钱"的规矩）。② 单独就能判一件事：
 * 参数面收紧（把 `minLength/maxLength` 与 `uuid` 对齐那一手，W2-1）之后模型还写不写得出
 * 合法参数——写不出来就不能靠"改提示词"蒙过去。
 *
 * 读数纪律照 `scripts/companion-gate-counterfactual.py`：**分母为 0 就是拒绝，不是绿**；
 * 按 `model_id` 分开打印（qwen 与 GLM 混在一起的平均值不能用来判门槛）。
 *
 * 跑法（`--tsconfig` 是 **tsx 的选项**，不是 `node --import tsx` 的——写成后者会得到
 * `node: bad option`，我第一次就这么错了；必须显式给，否则 tsx 退回 `node_modules`
 * 里那份安装期的 shared 快照，新加的合同文件会"找不到"）：
 *   cd workers/ai-worker && npx tsx --tsconfig tsconfig.json scripts/companion-s1-probe.ts --self-test
 *   DATABASE_URL=… npx tsx --tsconfig tsconfig.json scripts/companion-s1-probe.ts --days 30
 *
 * 注意角色：`companion_agent_tool_calls` 是 RLS 过的表，用受限角色跑会**读到 0 行**，
 * 而 0 行看着像"今天没有不合格的参数"。所以取数必须走有 `BYPASSRLS` 的那条串（dev 的
 * `DATABASE_URL`），且分母为 0 时以退出码拒绝。
 */
import process from "node:process";
import postgres from "postgres";
import { companionLeakGateVersionV1 } from "@ailearn/shared/companion-leak-gates";
import { getCompanionAgentTool, validateCompanionAgentToolArguments } from "@ailearn/shared/companion-agent-registry";

/** 回合层面的归因：闸版本落了没有、落了几种（39d #28 那一列的读者之一）。 */
interface AttributionRow {
  turns: string;
  unattributed: string;
  with_value: string;
  values: string | null;
}

interface CallRow {
  name: string;
  arguments: unknown;
  model_id: string | null;
  status: string | null;
  /** 那一发产出于哪一版闸表（39d #28）；NULL＝这一列落地前的历史行。 */
  leak_gate_version: string | null;
}

interface Tally {
  total: number;
  /** 名字**在**注册表里、但参数没过它自己那份 schema —— 这才是 39b §9.5 判据 ② 要的那个数。 */
  invalid: number;
  /**
   * 名字**今天**不在注册表里。**这不等于她叫错了**——2026-09-25 实量过一次：
   * 这一桶里 37 条 `companion_open_review` 全发生在 09-19/09-20，而那个名字
   * 是 09-21 的提交才从注册表拿掉的（`git log -S`），也就是**当年合法、后来被删**。
   * 判"当时合不合法"要的是那一发产出于哪一版工具面 ⇒ 正是 #28 欠的那一列。
   * 在没有那列之前，这一桶只能当**待人工对照**看，不能当缺陷率。
   */
  unknownName: number;
  /**
   * `unknownName` 里**归因得到当前闸版本**的那些（`leak_gate_version === 代码当前那份`）。
   * 只有这一格可以读成"她现在还会叫错名字"；`unknownName - unknownNameNow` 那部分落在
   * 无版本／旧版本的行上，仍然是"当年合法、后来被删"那一族（39d §19 实量过 37 条）。
   */
  unknownNameNow: number;
  invalidNames: Map<string, number>;
  unknownNames: Map<string, number>;
}

/** 判据本体：一条 tool_call 的参数是不是它自己那份 schema 能收的。 */
export function isArgumentSchemaValid(name: string, args: unknown): boolean {
  return validateCompanionAgentToolArguments(name, args).success;
}

/**
 * 自证：判据必须**两边都会动**。
 *
 * 只测"合法的那条通过"等于什么都没测——空判据也通过。所以合成三条：
 * 一条真合法、一条缺必填、一条字段类型不对（uuid 位置塞了别的东西）。
 */
/**
 * 落库的闸版本与代码当前那份不一致 ⇒ 写入侧在读另一版闸表（安装期快照／没热重载的进程）。
 * 这时归因读数整体失真，探针拒绝下结论。没有可判样本（withValue=0）不在这条管：
 * 那条由"0 分母"另判，别把"还没人写"读成"写错了"。
 */
export function attributionDriftV1(withValue: number, seen: string[], current: string): boolean {
  if (withValue === 0) return false;
  return seen.length !== 1 || seen[0] !== current;
}

function selfTest(): number {
  const cases: Array<{ title: string; name: string; args: unknown; want: boolean }> = [
    {
      title: "合法参数应判为合 schema",
      name: "companion_read_note",
      args: { noteId: "11111111-1111-4111-8111-111111111111" },
      want: true,
    },
    {
      title: "缺必填应判为不合",
      name: "companion_read_note",
      args: {},
      want: false,
    },
    {
      title: "字段类型不对应判为不合",
      name: "companion_read_note",
      args: { noteId: "not-a-uuid" },
      want: false,
    },
    {
      title: "没登记 schema 的工具不能算合（否则未知名字会一路通过）",
      name: "companion_totally_made_up",
      args: { noteId: "11111111-1111-4111-8111-111111111111" },
      want: false,
    },
  ];
  let bad = 0;
  for (const testCase of cases) {
    const got = isArgumentSchemaValid(testCase.name, testCase.args);
    const okFlag = got === testCase.want;
    if (!okFlag) bad += 1;
    console.log(`${okFlag ? "ok  " : "FAIL"} ${testCase.title}（实得 ${got}，要 ${testCase.want}）`);
  }
  // 「名字不在注册表」这一桶现在要按闸版本分开：只有归因到当前版本的那些才读得出"她现在还叫错"。
  // 分错的话，判据会把历史行当成现役缺陷（39d §19 实量过一次：37 条当年合法、后来被删的名字）。
  const CURRENT = "v-current";
  const call = (over: Partial<CallRow>): CallRow => ({
    name: "companion_totally_made_up", arguments: {}, model_id: "m", status: "succeeded",
    leak_gate_version: CURRENT, ...over,
  });
  const bucketCases: Array<{ title: string; row: CallRow; wantUnknown: number; wantNow: number }> = [
    { title: "未登记名字 + 当前闸版本 ⇒ 计入「现在还会叫错」",
      row: call({}), wantUnknown: 1, wantNow: 1 },
    { title: "未登记名字 + 无版本（那一列落地前的历史行）⇒ 不计",
      row: call({ leak_gate_version: null }), wantUnknown: 1, wantNow: 0 },
    { title: "未登记名字 + 旧闸版本 ⇒ 不计",
      row: call({ leak_gate_version: "v-old" }), wantUnknown: 1, wantNow: 0 },
    { title: "登记过的名字 ⇒ 两格都不计",
      row: call({ name: "companion_read_note",
        arguments: { noteId: "11111111-1111-4111-8111-111111111111" } }), wantUnknown: 0, wantNow: 0 },
  ];
  for (const bucketCase of bucketCases) {
    const t = tally([bucketCase.row], CURRENT).get("m");
    const got = `${t?.unknownName ?? -1}/${t?.unknownNameNow ?? -1}`;
    const want = `${bucketCase.wantUnknown}/${bucketCase.wantNow}`;
    const bucketOk = t !== undefined && got === want;
    if (!bucketOk) bad += 1;
    console.log(`${bucketOk ? "ok  " : "FAIL"} 分桶：${bucketCase.title}（实得 unknown/now=${got}，要 ${want}）`);
  }
  // 归因漂移那条判据也要正反各构造一次：它今天不会被真实数据命中（窗口里 0 行有值），
  // 所以"没命中"必须靠合成输入证明它读得动，而不是靠真实数据今天长什么样。
  const driftCases: Array<{ title: string; got: boolean; want: boolean }> = [
    { title: "有值且都等于当前版本 ⇒ 不拒绝", got: attributionDriftV1(3, ["aaa"], "aaa"), want: false },
    { title: "有值但是旧版本 ⇒ 拒绝（有人在用旧表写库）", got: attributionDriftV1(3, ["bbb"], "aaa"), want: true },
    { title: "同时落了两个版本 ⇒ 拒绝（两侧读的不是同一份表）", got: attributionDriftV1(3, ["aaa", "bbb"], "aaa"), want: true },
    { title: "窗口里没有可判样本 ⇒ 不由这条拒绝（交给 0 分母那条）", got: attributionDriftV1(0, [], "aaa"), want: false },
  ];
  for (const testCase of driftCases) {
    const okFlag = testCase.got === testCase.want;
    if (!okFlag) bad += 1;
    console.log(`${okFlag ? "ok  " : "FAIL"} 归因：${testCase.title}（实得 ${testCase.got}，要 ${testCase.want}）`);
  }
  return bad === 0 ? 0 : 1;
}

async function roleOf(url: string): Promise<string> {
  const probe = postgres(url, { max: 1 });
  try {
    const rows = await probe`
      select current_user as usr,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
    const r = rows[0] as { usr: string; bypass: boolean | null };
    return `${r.usr}${r.bypass ? "（BYPASSRLS）" : "（受 RLS 约束）"}`;
  } finally {
    await probe.end({ timeout: 2 });
  }
}

function tally(rows: CallRow[], currentGateVersion: string): Map<string, Tally> {
  const byModel = new Map<string, Tally>();
  for (const row of rows) {
    const key = row.model_id ?? "(读不到 model_id)";
    const t = byModel.get(key) ?? { total: 0, invalid: 0, unknownName: 0, unknownNameNow: 0,
      invalidNames: new Map<string, number>(), unknownNames: new Map<string, number>() };
    t.total += 1;
    let args = row.arguments;
    if (typeof args === "string") {
      // postgres.js 在列被转成 text 读时会回字符串；这里只在能解析时解析，
      // 解析不动就**照原判据算不合**（那正是"模型写出来的东西不是合法参数"）。
      try { args = JSON.parse(args); } catch { /* 保持原样 */ }
    }
    if (!getCompanionAgentTool(row.name)) {
      t.unknownName += 1;
      // 归因只认"这一发的闸版本 == 代码当前那份"：无版本（那一列落地前）与旧版本
      // 都只能算历史样本，拿它们当"她现在还叫错"是我上一轮犯过的错法。
      if (row.leak_gate_version === currentGateVersion) t.unknownNameNow += 1;
      t.unknownNames.set(row.name, (t.unknownNames.get(row.name) ?? 0) + 1);
    } else if (!isArgumentSchemaValid(row.name, args)) {
      t.invalid += 1;
      t.invalidNames.set(row.name, (t.invalidNames.get(row.name) ?? 0) + 1);
    }
    byModel.set(key, t);
  }
  return byModel;
}

async function main(): Promise<number> {
  if (process.argv.includes("--self-test")) return selfTest();

  const daysFlag = process.argv.indexOf("--days");
  const days = daysFlag >= 0 ? Number(process.argv[daysFlag + 1]) : 30;
  // 窗口只收 1..365 的整数：它既挡住把字符串拼进 interval（postgres.js 会把
  // `${sql(days)} days` 参数化成 `' days'` 那种东西，直接 syntax error），
  // 也保证"读不到样本"不会被一个离谱的窗口解释成"最近没数据"。
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    console.error(`拒绝跑：--days 要是 1..365 的整数，实得 ${String(process.argv[daysFlag + 1])}`);
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("拒绝跑：没有 DATABASE_URL（受限角色读不到这一列，0 行会被当成合格）");
    return 1;
  }
  const sql = postgres(url, { max: 1 });
  let rows: CallRow[];
  let attribution: AttributionRow[];
  try {
    rows = await sql`
      SELECT c.name, c.arguments, c.status, r.model_id, r.leak_gate_version
      FROM companion_agent_tool_calls c
      LEFT JOIN companion_turn_runs r ON r.id = c.run_id
      WHERE c.created_at > now() - (${days} * interval '1 day')
      ORDER BY c.created_at
    ` as CallRow[];
  attribution = await sql`
      SELECT count(*)::text AS turns,
             count(*) FILTER (WHERE leak_gate_version IS NULL)::text AS unattributed,
             count(*) FILTER (WHERE leak_gate_version IS NOT NULL)::text AS with_value,
             string_agg(DISTINCT leak_gate_version, ',') AS values
      FROM companion_turn_runs
      WHERE created_at > now() - (${days} * interval '1 day')
    ` as AttributionRow[];
  } finally {
    await sql.end({ timeout: 2 });
  }

  const byModel = tally(rows, companionLeakGateVersionV1());
  // 读数要带它是**谁**读到的：`.env` 里那四条 URL 今天都是超户角色（BYPASSRLS），
  // 所以"换一条 _API 就等于在 RLS 下跑"是不成立的——把角色打在数字旁边，
  // 而不是让它靠跑的人记得（同一组数在两种角色下不是同一个数）。
  const role = await roleOf(url);
  console.log(`S1 ②参数合 schema 率（最近 ${days} 天，共 ${rows.length} 条 tool_call；角色 ${role}）`);
  for (const [model, t] of [...byModel.entries()].sort()) {
    const rate = t.total === 0 ? 0 : (t.invalid / t.total) * 100;
    const unknownRate = t.total === 0 ? 0 : (t.unknownName / t.total) * 100;
    const names = [...t.invalidNames.entries()].sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name}×${n}`).join(", ");
    const unknown = [...t.unknownNames.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 4).map(([name, n]) => `${name}×${n}`).join(", ");
    console.log(`  ${model}: ${t.total} 条｜参数不合 schema ${t.invalid} 条（${rate.toFixed(1)}%）${names ? ` 分布 ${names}` : ""}`);
    console.log(`  ${model}:         ｜名字今天不在注册表 ${t.unknownName} 条（${unknownRate.toFixed(1)}%）${unknown ? ` 分布 ${unknown}` : ""}`);
    if (t.unknownName > 0) {
      const historic = t.unknownName - t.unknownNameNow;
      console.log(`  ${model}:         ｜↑ 其中**归因到当前闸版本** ${t.unknownNameNow} 条（这些才能读成"她现在还叫错名字"）`
        + `、落在无版本／旧版本行上 ${historic} 条（本仓实测：多数是当年合法、后来删掉的名字，不是缺陷率）`);
    }
  }
  if (rows.length === 0) {
    console.error("拒绝下结论：窗口内 0 条 tool_call——要么没有样本，要么这条连接读不到（RLS）。两者都不算通过。");
    return 1;
  }
  const a = attribution[0];
  if (a) {
    const withValue = Number(a.with_value);
    const seen = (a.values ?? "").split(",").filter(Boolean);
    const current = companionLeakGateVersionV1();
    console.log(`   闸版本归因（同窗口 ${a.turns} 个回合）：无值 ${a.unattributed} 个（NULL＝那一列落地前的历史行）、有值 ${withValue} 个（落到的版本 ${seen.join("、") || "无"}）`);
    console.log(`   代码当前那份闸表派生的版本 = ${current}（与重放台同源：都由 shared 那张表算）`);
    if (attributionDriftV1(withValue, seen, current)) {
      // 写库那一侧读的是另一版表（安装期快照、或没热重载的进程）。这不是"样本少"，
      // 而是"有人在用旧表写"——归因读数会整体失真，所以拒绝在这里下结论。
      console.error("拒绝下结论：落库的闸版本与代码当前那份不一致 ⇒ 写入侧在读另一版闸表，归因不可用。");
      return 1;
    }
    console.log(withValue === 0
      ? "   ⇒ 这一窗还没有一行带版本：删闸那侧会整批按「未归因」拒绝（台子读的就是这一列，不是日期）。"
      : `   ⇒ ${withValue} 行已被真实服务写进版本（生产者验通）；其余 ${a.unattributed} 行仍是落地前的历史样本，别拿它们当某一版闸的证据。`);
  }
  console.log("S1 ①required 下 0 个 tool_calls 的比例：**本台子今天没量**（要真模型，REAL_MODEL_BATCH=1 才动）；");
  console.log("   归因那一半已具备（`leak_gate_version` 随回合与念头落库，台子的删闸判据从 09-25 起读这一列）。");
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error("探针自己出错了，不当成任何读数：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
