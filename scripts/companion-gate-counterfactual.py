#!/usr/bin/env python3
"""反事实重放台（39b §10 / 39d W1-1）：只读、不花模型调用。

它回答一个问题：**这 11 道输出闸里，每一条在最近 30 天的真实流量上还漏不漏？**
漏的判定分三类——`covered`（供给侧机制已经给出确定的真值可填）、`rescued-by-tool`
（该调的工具仍在面上）、`still-leaks`（两者都没有）。退出码的规则只有一条：
**任一被标成「删除」的闸 `covered + rescued-by-tool < 100%` 即非 0。**

删闸的证据纪律（39b §9 规则 2）：本台只提供**第一份**证据（反事实覆盖）。
第二份（真实流量连续 0 触发）见 39d W0-11 的口径，两份缺一不删。

## 判据只有一份实现

11 道闸**不在本文件里重写**——它们由 `workers/ai-worker/scripts/companion-gate-eval.ts`
通过 tsx 直接 import 真函数执行。理由：同一判据在 TS 与 Python 正则里各写一份是这条链上
最贵的错法（`companion-quality-report.py` 的 `VISION_TIME_QUESTION` 已经吃过一次：
元字符集不同，漏改的后果是**样本静默变少**而不是报错）。本文件只负责取数、
P2 键表的取用、触发分类与退出码。

## 已知的口径边界（读数时必须一起看）

1. **历史环境块没有落库**（39b §10：`companion_agent_steps` 只有 `request_hash`）。
   重放只能按 `loadHereAndNow` **在重放时刻**重建环境块——同一账号的 509 轮因此共用
   同一份今天的读数。所以 G1／G2／G6／G10 的触发数记的是**重算口径**；不受环境影响的
   闸（G4／G5／G7／G8／G9／G11）是**原话逐字重算**，与当时一致。
   **P1（G3 的覆盖）同一条边界**：指称解析里的规则②③ 读的是"此刻这一屏"的可读视图、
   规则④ 读的是该会话最近 20 次工具调用——都是重放时刻的真值，不是历史那一刻的。
2. **P1（W2-3）与 P2（W2-5）都已落地**：指称解析由判据桥调**真实现**
   （`loadThisTurnFacts` + `noteReference`），读数目录的**键表与量词集**也从桥里现取
   （`mode: spans`，来自 `companion-fact-spans.ts`）。本文件不再自己维护这两份模拟。
   G10／G11 的覆盖读**产出侧守卫**（`validateThoughtExpression` + 送达前的
   `readsOutStatistics` 抑制）：念头气泡在新机制下没有读数目录，那两条判据已经在产出
   这一步执行，后置闸的触发是重复的。
3. 本台**没有**做"当时那一轮的模型还会不会再犯"的推断。它只判判据的触发与覆盖。

用法：
    python3 scripts/companion-gate-counterfactual.py
    python3 scripts/companion-gate-counterfactual.py --json .impeccable/companion/gate-counterfactual.json
    python3 scripts/companion-gate-counterfactual.py --days 30 --no-ambient   # 跳过环境块重建（快）
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CONTAINER = "ailearn-dev-postgres-1"
ROOT = Path(__file__).resolve().parent.parent
SCRIPTED_RUNS_FILE = ROOT / ".impeccable/companion/scripted-runs.txt"
BRIDGE = ROOT / "workers/ai-worker/scripts/companion-gate-eval.ts"
BRIDGE_RUNNER = ROOT / "workers/ai-worker/node_modules/.bin/tsx"

# 开发栈的"真人账号"约定，与 companion-quality-report.py 同源。
DEV_REAL_ACCOUNT_EMAILS = ("owner@ailearn.local",)

# 判据去向（39b §9.1 的"去向"列）。`keep` 不参与退出码；`delete` 必须
# `covered + rescued-by-tool == 100%` 才允许删；`conditional` 的覆盖依赖尚未
# 落地/尚未探针验证的上游机制（G4 依赖 P3，而 P3 取决于 S1 探针 ① < 2%）。
GATE_DISPOSITION = {
    "G1": "delete",
    "G2": "keep",       # 39b §13 已知会漏：P1 未解析出实体时假阴性仍可说 → 保留
    "G3": "delete",
    "G4": "conditional",
    "G5": "keep",
    "G6": "keep",
    "G7": "keep",
    "G8": "keep",
    "G9": "keep",
    "G10": "delete",
    "G11": "delete",
}

# 11 道闸的触发前提分类（39b §9.1 的"类"列）。
GATE_CLASS = {
    "G1": "A", "G2": "A", "G3": "A", "G4": "A", "G6": "A",
    "G5": "A-prime",
    "G7": "B", "G8": "B", "G9": "B",
    "G10": "C", "G11": "C",
}

# P2 的量词集：主流程从判据桥现取（`mode: spans`），这里只留一个空集占位。
SPAN_QUANTIFIERS: set[str] = set()

# 用户这句话在问学习数据吗（`asksForLearningStats` 的判据形状，39b §9.4 的 askable）。
# 这里只用于**分类**（"这个数字有没有确定的真值可填"），不用于触发判定。
LEARNING_DATA_QUESTION = re.compile(
    r"(今天|今日|这周|本周|这个星期|连续|坚持|连着)[^。！？]{0,12}"
    r"(学|复习|读|打卡|记录)[^。！？]{0,6}(多久|多长时间|多少|几分钟|几小时|几天|几张|几篇|几项)",
)

# P1 指称语法（39b §9.3 的五条规则）。
P1_TITLE_BRACKET = re.compile(r"[《「]([^》」\n]{1,30})[》」]")
P1_ORDINAL = re.compile(r"第\s*([一二三四五六七八九十\d]+)\s*[张条篇个]")
P1_PRONOUN = re.compile(r"(这篇|那篇|这条|那张|它)")
P1_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


# ─── 取数（只读） ──────────────────────────────────────────────────────────

def rows(query: str) -> list[dict]:
    """跑一条 SELECT，返回 dict 列表。走 COPY … CSV，理由与 companion-quality-report.py 同源
    （psql -A 会按输出宽度折行长值，行式解析把一条记录读成好几条）。"""
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "psql", "-U", "ailearn", "-d", "ailearn", "-t", "-c",
         f"COPY ({query.strip().rstrip(';')}) TO STDOUT WITH (FORMAT csv, HEADER true)"],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:400])
    return [dict(record) for record in csv.DictReader(io.StringIO(out.stdout))]


def sql_array(values: list[str]) -> str:
    if not values:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ",".join("'" + value.replace("'", "''") + "'" for value in values) + "]::text[]"


def scripted_run_ids() -> set[str]:
    try:
        with open(SCRIPTED_RUNS_FILE, encoding="utf-8") as handle:
            return {line.strip() for line in handle if re.fullmatch(r"[0-9a-fA-F-]{36}", line.strip())}
    except OSError:
        return set()


def text_of_blocks(blocks_json: str | None) -> str:
    """blocks->0->>'text' 的 Python 侧等价：只取 text 型块的正文（与 textOfCompanionBlocks 同义）。"""
    if not blocks_json:
        return ""
    try:
        blocks = json.loads(blocks_json)
    except (TypeError, ValueError):
        return ""
    if not isinstance(blocks, list):
        return ""
    return "".join(str(b.get("text", "")) for b in blocks
                   if isinstance(b, dict) and b.get("type") == "text")


def fetch_turns(days: int) -> dict:
    scripted = sorted(scripted_run_ids())
    emails = sql_array(list(DEV_REAL_ACCOUNT_EMAILS))
    window = f"r.created_at > now() - ({days} * interval '1 day')"
    counts = rows(f"""
        SELECT
          (SELECT count(*) FROM users WHERE email IN ({",".join("'" + e + "'" for e in DEV_REAL_ACCOUNT_EMAILS)})) AS n_listed_users,
          (SELECT count(*) FROM companion_turn_runs r WHERE {window}) AS n_all,
          (SELECT count(*) FROM companion_turn_runs r WHERE {window}
             AND r.id::text <> ALL({sql_array(scripted)})) AS n_minus_scripted,
          (SELECT count(*) FROM companion_turn_runs r WHERE {window}
             AND r.id::text <> ALL({sql_array(scripted)})
             AND r.user_id IN (SELECT id FROM users WHERE email IN ({",".join("'" + e + "'" for e in DEV_REAL_ACCOUNT_EMAILS)}))
          ) AS n_real,
          (SELECT count(*) FROM companion_turn_runs r WHERE {window}
             AND r.id::text <> ALL({sql_array(scripted)})
             AND r.user_id IN (SELECT id FROM users WHERE email IN ({",".join("'" + e + "'" for e in DEV_REAL_ACCOUNT_EMAILS)}))
             AND r.status = 'failed' AND coalesce(r.model_id, '') = ''
          ) AS n_no_model_failed
    """)[0]
    turns = rows(f"""
        SELECT r.id AS run_id, r.workspace_id, r.user_id, r.status,
               coalesce(r.step_count, 0) AS step_count,
               coalesce(r.tool_call_count, 0) AS tool_call_count,
               r.created_at, coalesce(r.model_id, '') AS model_id,
               coalesce(r.leak_gate_version, '') AS leak_gate_version,
               coalesce(r.conversation_id::text, '') AS conversation_id,
               coalesce(r.page_context::text, '') AS page_context,
               coalesce(ua.blocks::text, '') AS user_blocks,
               coalesce(aa.blocks::text, '') AS assistant_blocks
        FROM companion_turn_runs r
        LEFT JOIN companion_messages ua ON ua.id = r.user_message_id
        LEFT JOIN companion_messages aa ON aa.id = r.assistant_message_id
        WHERE {window} AND r.id::text <> ALL({sql_array(scripted)})
          AND r.user_id IN (SELECT id FROM users
                            WHERE email IN ({",".join("'" + e + "'" for e in DEV_REAL_ACCOUNT_EMAILS)}))
        ORDER BY r.created_at
    """)
    return {"counts": counts, "turns": turns}


def fetch_tool_calls(days: int) -> dict[str, list[dict]]:
    scripted = sorted(scripted_run_ids())
    emails = ",".join("'" + e + "'" for e in DEV_REAL_ACCOUNT_EMAILS)
    # 窗口必须跟 `--days` 走。这里原先写死 30 天：有人按 W0-11 那句"窗口 ≥ 30 天"去跑
    # `--days 60/90` 时，30 天以外的回合会取不到工具面，而工具面是 `rescued-by-tool`
    # 那一档的输入——症状是把"其实被工具救回来的一条"报成没救，读数**偏保守但错**。
    calls = rows(f"""
        SELECT c.run_id, c.name, coalesce(c.arguments::text, '') AS arguments,
               coalesce(c.result_safe_summary, '') AS summary, coalesce(c.status, '') AS status
        FROM companion_agent_tool_calls c
        WHERE c.run_id IN (
          SELECT r.id FROM companion_turn_runs r
          WHERE r.created_at > now() - ({days} * interval '1 day')
            AND r.id::text <> ALL({sql_array(scripted)})
            AND r.user_id IN (SELECT id FROM users WHERE email IN ({emails})))
        ORDER BY c.created_at
    """)
    grouped: dict[str, list[dict]] = {}
    for call in calls:
        grouped.setdefault(call["run_id"], []).append(call)
    return grouped


def fetch_thoughts(days: int, emails_sql: str) -> list[dict]:
    """念头链的产物（G10／G11 的数据源）。

    G10／G11 的判据长在 `companion-thought.ts` 上，它们的输入是**念头气泡的正文**，
    不在 `companion_turn_runs` 里。只收 `source='llm'` 那批——`streak`／`review_due`
    是模板句（她自己没写数字），没有可判定的正文。
    """
    return rows(f"""
        SELECT t.id, t.user_id, t.text, t.source, t.created_at,
               coalesce(t.leak_gate_version, '') AS leak_gate_version
        FROM assistant_thoughts t
        WHERE t.created_at > now() - interval '{days} days'
          AND t.source = 'llm'
          AND t.user_id IN (SELECT id FROM users WHERE email IN ({emails_sql}))
        ORDER BY t.created_at
    """)


# ─── 判据执行桥 ────────────────────────────────────────────────────────────

def gate_disagreements(table_gates: list[dict], disposition: dict[str, str]) -> list[str]:
    """代码里那份闸表 与 台子自己那份处置表 的差集（双向）。

    两边今天各写一份，靠人对——改了判据、删了一道闸，台子不会知道，只会拿着旧的号
    继续读。**这里把它变成会拒绝的**：号集不一致、或同一号的处置不一致，都算漂移。
    """
    coded = {gate["id"]: gate["disposition"] for gate in table_gates}
    out = [f"{key}：台子有这一号，代码里没有" for key in sorted(disposition) if key not in coded]
    out += [f"{key}：代码里有这一号，台子没有" for key in sorted(coded) if key not in disposition]
    out += [f"{key}：处置不一致（台子 {disposition[key]} vs 代码 {coded[key]}）"
            for key in sorted(coded) if key in disposition and disposition[key] != coded[key]]
    return out


def call_bridge(payload: dict) -> dict:
    """执行判据桥。

    结果走 `--out` 文件而不是 stdout：环境块模式会连库，worker 的 pino 日志默认写 fd 1
    （开发态是 pino-pretty），混进 stdout 会把 JSON 截断在中间。
    """
    env = dict(os.environ)
    env["DATABASE_URL_WORKER"] = env.get(
        "DATABASE_URL_WORKER", "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn")
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "bridge.json"
        # `--tsconfig` 必须显式给：桥 import 的是 `@ailearn/shared/*` 的**实时源码**
        # （靠 tsconfig paths 解析），而不给这一条时 tsx 按 cwd 找 tsconfig —— 从仓库根
        # 跑就会退回 `workers/ai-worker/node_modules/@ailearn/shared` 那份**安装期快照**，
        # 于是新加的 shared 文件在桥里"找不到"（而服务端自己跑得好好的）。
        proc = subprocess.run(
            [str(BRIDGE_RUNNER), "--tsconfig", str(ROOT / "workers/ai-worker/tsconfig.json"),
             str(BRIDGE), "--out", str(out_path)],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True, text=True, env=env)
        if proc.returncode != 0 or not out_path.exists():
            raise RuntimeError(f"判据桥失败: {proc.stderr.strip()[:600]}")
        return json.loads(out_path.read_text(encoding="utf-8"))


def run_bridge(turns: list[dict], activeness: str = "active") -> dict:
    return call_bridge({"activeness": activeness, "turns": turns})


def eval_ambient(turns: list[dict]) -> dict:
    """用真 `loadHereAndNow` 重建环境块（只读、按重放时刻）。

    输入每个 turn 需要 `workspaceId` / `userId` / `userText` / `pageContext`。
    """
    return call_bridge({"mode": "ambient", "turns": turns})


# ─── 分类 ─────────────────────────────────────────────────────────────────

QUANTIFIER_SHAPE = re.compile(r"\d+(?:\.\d+)?\s*(分钟|小时|天|周|张|篇|项|个|题|次|条|%)")


def statistic_tokens(text: str) -> set[str]:
    """正文里"数字 + 量词"的形状。G11 只回布尔、G10 只回布尔，它们的命中项
    要在这里现取——判据本身不吐 token 明细。"""
    return {match.group(0).strip() for match in QUANTIFIER_SHAPE.finditer(text or "")}


def token_quantifier(token: str) -> str:
    match = re.match(r"^[\d.]+\s*(.+)$", token)
    return match.group(1).strip() if match else ""


def span_able(tokens: set[str]) -> bool:
    """这些"数字 + 量词"能不能被 P2 的读数目录接住。

    界取在**量词类**而不是"这一轮她到底拿到没拿到那个键"：目录里每个键的真值在库里
    都是可算的（39b §10：输入都是真的），`askable` 决定的是它进不进本轮 prompt，而
    "没问的键不在目录里"正是她**没有对象可写错**的那一半。所以判据是量词落在真实现
    公布的量词集里（`mode: spans` 现取，见文件头 §2），值一定算得出来。

    **这条是乐观口径**：她仍可能无视规则直接写一个字面数字（那时 G1 才是唯一的兜底）。
    所以 W6-1 删 G1 只许拿它当"覆盖"的一半证据，另一半必须是真实流量 0 触发。
    """
    quantifiers = {token_quantifier(token) for token in tokens}
    return bool(quantifiers) and quantifiers <= SPAN_QUANTIFIERS


def classify(gate: str, turn: dict, gate_result: dict, p1: dict, text: str) -> dict:
    """给一条已触发的闸定桶。返回 `{bucket, why}`。"""
    face = set(turn.get("tool_face", []))
    # G1 自带命中明细（更准）；G10／G11 只有布尔，用正文现取的形状代理。
    gate_tokens = {str(token) for token in (gate_result.get("detail") or [])}
    tokens = gate_tokens or statistic_tokens(text)

    if gate == "G1":
        if span_able(tokens):
            return {"bucket": "covered", "why": f"量词属 P2 读数类（{sorted(tokens)}）"}
        if "companion_get_learning_stats" in face:
            return {"bucket": "rescued-by-tool", "why": "统计工具在面上"}
        return {"bucket": "still-leaks", "why": f"量词不属 P2 读数类（{sorted(tokens) or '无'}）"}

    if gate == "G2":
        # 39b §13：P1 未解析出实体时假阴性仍可说 → 保留。这里只记账，不驱动退出码。
        return {"bucket": "covered", "why": "P1 给出确定的到期读数（去向为保留，仅记账）"}

    if gate == "G3":
        # P1 的真实结果（判据桥在同一事务里跑 loadThisTurnFacts + noteReference）。
        if p1.get("definite"):
            return {"bucket": "covered", "why": f"P1 给出确定口径（{p1.get('rule') or 'noteReference'}）"}
        if p1.get("unknown"):
            return {"bucket": "unclassified",
                    "why": "没跑环境块重建 ⇒ P1 结果未知；不达标不删闸（见文件头 §1）"}
        if "companion_search_notes" in face or "companion_read_note" in face:
            return {"bucket": "rescued-by-tool", "why": "检索工具在面上"}
        return {"bucket": "still-leaks", "why": "P1 未给出确定口径且检索工具不在面上"}

    if gate == "G4":
        # 覆盖来自 P3（动作步没有 prose 通道），而 P3 取决于 S1 探针 ① < 2%。
        return {"bucket": "conditional", "why": "覆盖依赖 P3；P3 取决于 S1 探针（W2-4）"}

    if gate in ("G10", "G11"):
        # 念头气泡没有读数目录（主动开口时没人在问），覆盖来自**产出侧守卫**：
        # `validateThoughtExpression` 的统计形状拒绝 + 送达前 `readsOutStatistics` 抑制
        # ——两者都在她定稿那一步执行（桥的 `thoughtGuardCovers`）。
        if turn.get("thought_guard_covers"):
            return {"bucket": "covered", "why": "产出侧守卫会拒掉／抑制这条气泡（判据已前移）"}
        return {"bucket": "still-leaks", "why": f"产出侧守卫没拦住（{sorted(tokens) or '无'}）"}

    return {"bucket": "keep", "why": "去向为保留，不参与删闸判决"}


# ─── 退出码规则 ───────────────────────────────────────────────────────────

def account_filter_health(n_listed_users: int, n_real: int) -> str | None:
    """把"真实账号 0 条"这两种成因分开：名单本身失效，还是这一窗确实没人说话。

    两种都会让逐闸读数变成空集，但只有一种要我去改名单——混起来就会把
    "filter 没对上任何用户"读成"这台机器今天没有真实流量"。
    """
    if n_listed_users == 0:
        return (f"名单失效：`DEV_REAL_ACCOUNT_EMAILS` 里那 {len(DEV_REAL_ACCOUNT_EMAILS)} 个邮箱"
                "在库里一个都不存在 ⇒ 后面每一条读数都是空的，且与闸无关")
    if n_real == 0:
        return "窗口里没有真实账号的回合（名单是活的）：这一窗量不到，别当结论"
    return None


def exit_code_for(buckets: dict[str, dict[str, int]],
                  dispositions: dict[str, str],
                  measurable: dict[str, int] | None = None,
                  attribution: dict[str, dict] | None = None,
                  n_real: int | None = None) -> tuple[int, list[tuple[str, object]]]:
    """退出码规则（39d W6-1 对账后收紧）。任一标「删除」的闸出现下面三种情况之一即 1：

    ①`still-leaks`（含 `unclassified`）> 0 —— 原判据；
    ②**触发数 = 0** —— 没有一次触发不构成"这道闸没用了"的证据，只构成"这一窗口的
      样本里没出现"；把 0 触发读成 100% 覆盖，是 2026-09-25 那轮台账里最该防的错法；
    ③**可判分母 = 0** —— 判据需要的输入不存在时它**恒不触发**（G10 在
      `allowedSource` 为空时第一行就 return false；G5 的 A′ 前置 `stepEmitted` 从不落库）。
      这种 0 是"测不出来"，不是"没有"。

    ④**触发不可归因** ⇒ 不算证据。归因的根据是库里那一列 `leak_gate_version`（39d #28）：
      样本行记下的是「服务它的那一版闸表」。NULL＝那一列落地前的历史行，非当前版本＝闸后来动过，
      两者都不能拿来判「这道闸现在可以删」。只有归因到当前版本的触发才算证据，
      且这些证据仍要**跨 ≥2 天**——单日即使版本对得上，也分不清是常态还是那一次改动的抖动。
      这一条比旧版（只按日期判）更严：旧版放过的是「跨了几天但没人知道是哪套代码服务的」，
      现在那种一律不放过。只抬高门槛，不放过任何一条。

    `conditional`（G4）不在这里判——它的覆盖依赖 P3，而 P3 能不能落要看 S1 探针；
    把未决的事算成通过或算成失败都是替 W2-4 提前拍板。
    """
    problems: list[tuple[str, object]] = []
    measurable = measurable or {}
    if n_real == 0:
        # 空窗口要单独说，不能让逐闸那三条替它说话：「G1 零触发」读起来像"这道闸没被触发"，
        # 而真相是"这一窗一条真实样本都没有"——前者是关于闸的，后者是关于这次测量的。
        return 1, [("窗口", "真实账号回合为 0：这一窗什么都不该判，读数按『没量到』处理，"
                            "别把逐闸那几条当成闸的性质")]
    for gate, disposition in dispositions.items():
        if disposition != "delete":
            continue
        stat = buckets.get(gate, {})
        # `unclassified` 与 still-leaks 同等对待：判据未知时不允许删闸（保守方向）。
        leaks = stat.get("still-leaks", 0) + stat.get("unclassified", 0)
        if leaks > 0:
            problems.append((gate, leaks))
            continue
        fired = stat.get("covered", 0) + stat.get("rescued-by-tool", 0) + leaks
        denominator = measurable.get(gate, -1)
        if denominator == 0:
            problems.append((gate, "可判分母为 0：判据恒不触发，这一窗量不到"))
        elif fired == 0:
            # 空集与"测不出来"不是一回事：这里确实有样本，只是没出现违规说法。
            # 它仍然不够——第二份证据（真实流量在落地后的窗口里 0 触发，W0-11）还没有。
            shown = "未提供" if denominator < 0 else denominator
            problems.append((gate, f"零触发（可判分母 {shown}）：第一份证据是空集，"
                                   f"第二份还没有，不许删"))
            continue
        attr = (attribution or {}).get(gate)
        if attr is None:
            # 没有归因读数就判不了：宁可红，也不放一条删闸的结论出去。
            problems.append((gate, "没有闸版本归因读数：这一条判不了，不许删"))
            continue
        if attr["unattributed"] > 0:
            problems.append((gate, f"{attr['unattributed']} 条触发未归因"
                                   f"（无版本 {attr['missing']} 条／旧版本 {attr['stale']} 条）："
                                   f"covered 里混着判不出是谁服务的样本，不算证据"))
            continue
        if attr["attributed"] > 0 and attr["attributed_days"] < 2:
            # 「只落在一天」这句话的前提是**有**归因到的触发；一条都没有时该说的是②／③，
            # 不是让人以为"归因到了但都在同一天"（--days 1 的空窗口就是这么读错的）。
            problems.append((gate, f"归因到当前闸版本的触发只落在 {attr['attributed_days']} 天："
                                   f"单日照旧不算证据"))
    return (1 if problems else 0), problems


def self_test() -> int:
    # 闸表对质的自证：合成两份表，正反各一次（拿真实那份当这条的一条腿，
    # 明天改了它就变成"说不清的绿"）。
    assert gate_disagreements(
        [{"id": "G1", "disposition": "delete"}, {"id": "G2", "disposition": "keep"}],
        {"G1": "delete", "G2": "keep"},
    ) == [], "同一份表应当判为无漂移"
    drift = gate_disagreements(
        [{"id": "G1", "disposition": "delete"}, {"id": "G9", "disposition": "keep"}],
        {"G1": "keep", "G2": "keep"},
    )
    assert len(drift) == 3, f"三种漂移各要报一条，实得 {drift}"
    assert any("处置不一致" in line and "G1" in line for line in drift), drift
    assert any(line.startswith("G2") for line in drift), "台子有、代码没有的那一号必须点名"
    assert any(line.startswith("G9") for line in drift), "代码有、台子没有的那一号必须点名"
    """自证退出码规则两个方向都会动：全覆盖 → 0；留一条 still-leak → 1。

    棘轮（W1-3）有"先自证会红"的要求，这条规则同理——一条永远返回 0 的规则
    在删闸那天会表现为"全绿"，而它其实什么都没判。
    """
    all_covered = {gate: {"covered": 3, "rescued-by-tool": 0, "still-leaks": 0, "conditional": 0,
                          "keep": 0, "unclassified": 0}
                   for gate in GATE_DISPOSITION}
    # 归因那一格也要正反各构造一次：一条恒判「已归因」的规则和一条恒判「未归因」的规则
    # 都能让其它用例照旧红，只有把两种形状都做出来，才看得出这条规则到底在读什么。
    def attribution_for(**over: dict) -> dict:
        base = {gate: {"attributed": 3, "stale": 0, "missing": 0, "unattributed": 0,
                       "attributed_days": 2}
                for gate, disposition in GATE_DISPOSITION.items() if disposition == "delete"}
        base.update(over)
        return base

    leaks = {gate: dict(value) for gate, value in all_covered.items()}
    leaks["G1"]["still-leaks"] = 1
    leaks["G1"]["covered"] = 2
    conditional_only = {gate: dict(value) for gate, value in all_covered.items()}
    conditional_only["G4"] = {"covered": 0, "rescued-by-tool": 0, "still-leaks": 0, "conditional": 7,
                              "keep": 0, "unclassified": 0}
    unclassified = {gate: dict(value) for gate, value in all_covered.items()}
    unclassified["G3"] = {"covered": 0, "rescued-by-tool": 0, "still-leaks": 0, "conditional": 0,
                          "keep": 0, "unclassified": 2}

    # 新增两条：0 触发、分母 0 —— 都必须红（它们正是"看起来全绿"的那两种形状）
    zero_fired = {gate: dict(value) for gate, value in all_covered.items()}
    zero_fired["G10"] = {"covered": 0, "rescued-by-tool": 0, "still-leaks": 0, "conditional": 0,
                         "keep": 0, "unclassified": 0}
    code_zero, problems_zero = exit_code_for(zero_fired, GATE_DISPOSITION, None, attribution_for())
    # 空窗口（今天 `--days 1` 的真实形状）：一条触发都没有、归因格子也全 0。
    # 这一窗该说的是"零触发"，不是"归因到了但只落在 0 天"——那种读法会让人以为真有样本被日期挡住了。
    empty_window = {gate: dict(value) for gate, value in all_covered.items()}
    empty_window["G1"] = {"covered": 0, "rescued-by-tool": 0, "still-leaks": 0, "conditional": 0,
                          "keep": 0, "unclassified": 0}
    code_empty_window, problems_empty_window = exit_code_for(
        empty_window, GATE_DISPOSITION, {"G1": 0},
        attribution_for(G1={"attributed": 0, "stale": 0, "missing": 0,
                            "unattributed": 0, "attributed_days": 0}))
    blind_denominator = {gate: dict(value) for gate, value in all_covered.items()}
    code_blind, problems_blind = exit_code_for(
        blind_denominator, GATE_DISPOSITION, {"G10": 0, "G1": 12, "G3": 90, "G11": 55},
        attribution_for())
    # 分母健康但零触发：也要红（空集不是"这闸没用"，是"没量到"）
    zero_with_denominator = {gate: dict(value) for gate, value in all_covered.items()}
    zero_with_denominator["G10"] = {"covered": 0, "rescued-by-tool": 0, "still-leaks": 0,
                                    "conditional": 0, "keep": 0, "unclassified": 0}
    code_empty, problems_empty = exit_code_for(
        zero_with_denominator, GATE_DISPOSITION,
        {"G10": 55, "G1": 12, "G3": 90, "G11": 55}, attribution_for())
    # 归因的三种形状：全是无版本（这一列落地前的历史行）／掺了旧版本／归因齐了但只落在一天。
    # 三种都必须红，且各只点名那一道闸——别的闸归因是健康的，不许连坐。
    code_missing, problems_missing = exit_code_for(
        all_covered, GATE_DISPOSITION, None,
        attribution_for(G1={"attributed": 0, "stale": 0, "missing": 3,
                            "unattributed": 3, "attributed_days": 0}))
    code_stale, problems_stale = exit_code_for(
        all_covered, GATE_DISPOSITION, None,
        attribution_for(G3={"attributed": 2, "stale": 1, "missing": 0,
                            "unattributed": 1, "attributed_days": 3}))
    code_one_day, problems_one_day = exit_code_for(
        all_covered, GATE_DISPOSITION, None,
        attribution_for(G11={"attributed": 4, "stale": 0, "missing": 0,
                             "unattributed": 0, "attributed_days": 1}))
    # 缺整份归因读数：判不了，也要红（这条是为"上游忘了传"那种形状准备的）
    code_nodata, problems_nodata = exit_code_for(all_covered, GATE_DISPOSITION)
    # 空窗口（真实账号 0 条）：只许说"这一窗没量到"，不许把逐闸的结论端出去——
    # 所以这里故意用"有 still-leaks"的那份桶，验证它被整条挡下。
    code_blank, problems_blank = exit_code_for(leaks, GATE_DISPOSITION, None, attribution_for(), n_real=0)
    code_notblank, problems_notblank = exit_code_for(leaks, GATE_DISPOSITION, None, attribution_for(), n_real=7)
    code_green, problems_green = exit_code_for(all_covered, GATE_DISPOSITION, None, attribution_for())
    code_red, problems_red = exit_code_for(leaks, GATE_DISPOSITION, None, attribution_for())
    code_conditional, _ = exit_code_for(conditional_only, GATE_DISPOSITION, None, attribution_for())
    code_unknown, problems_unknown = exit_code_for(unclassified, GATE_DISPOSITION, None, attribution_for())
    # "真实账号 0 条"有两种成因，说法必须不同：名单没对上任何用户（要去改名单），
    # 还是名单是活、这一窗只是没人说话（要换窗口）。混起来就会把前者报成后者。
    health_dead_list = account_filter_health(0, 0)
    health_empty_window = account_filter_health(3, 0)
    health_fine = account_filter_health(3, 12)
    ok = (code_green == 0 and problems_green == []
          and code_red == 1 and problems_red == [("G1", 1)] and code_conditional == 0
          and code_unknown == 1 and problems_unknown == [("G3", 2)]
          and code_zero == 1 and problems_zero[0][0] == "G10" and "零触发" in str(problems_zero[0][1])
          and code_blind == 1 and any("可判分母为 0" in str(x[1]) for x in problems_blind)
          and code_empty == 1 and any("第一份证据是空集" in str(x[1]) for x in problems_empty)
          and code_missing == 1 and problems_missing[0][0] == "G1" and "未归因" in str(problems_missing[0][1])
          and code_stale == 1 and problems_stale[0][0] == "G3" and "旧版本 1 条" in str(problems_stale[0][1])
          # G11 归因齐了但只落在一天 → 红；G1／G3／G10 跨两日且已归因 → 不该出现在问题里
          and code_one_day == 1 and problems_one_day[0][0] == "G11" and len(problems_one_day) == 1
          and "单日照旧" in str(problems_one_day[0][1])
          and code_nodata == 1 and any("没有闸版本归因读数" in str(x[1]) for x in problems_nodata)
          # 空窗口那条：该说"量不到"，不该冒出"归因到了但只落在 0 天"
          and code_empty_window == 1
          and any("可判分母为 0" in str(x[1]) for x in problems_empty_window)
          and not any("只落在" in str(x[1]) for x in problems_empty_window)
          # 真实账号 0 条的窗口：只许报"这一窗没量到"，逐闸结论一条都不许端出去；
          # 同一份桶给了非零分母，G1 那条 still-leak 就要照常红。
          and code_blank == 1 and [gate for gate, _ in problems_blank] == ["窗口"]
          and "没量到" in str(problems_blank[0][1])
          and code_notblank == 1 and problems_notblank == [("G1", 1)]
          and health_dead_list is not None and "名单失效" in health_dead_list
          and health_empty_window is not None and "名单是活的" in health_empty_window
          # 两种成因不能长成同一句话（否则这个区分等于没做）
          and health_dead_list != health_empty_window
          and health_fine is None)
    print(f"自证：全覆盖 → {code_green}（期望 0）；G1 留 1 条 → {code_red}（期望 1，命中 {problems_red}）；"
          f"G4 只有 conditional → {code_conditional}（期望 0，不替 W2-4 拍板）；"
          f"G3 有未分类 → {code_unknown}（期望 1，命中 {problems_unknown}）")
    print(f"        G10 零触发（无分母信息）→ {code_zero}（期望 1，命中 {problems_zero}）；"
          f"G10 空集但有分母 → {code_empty}（期望 1）；G3 单日触发 → {code_one_day}（期望 1，命中 {problems_one_day}）；"
          f"G10 分母 0 → {code_blind}（期望 1，命中 {problems_blind}）")
    print(f"        归因：G1 全无版本 → {code_missing}（期望 1，命中 {problems_missing}）；"
          f"G3 掺旧版本 → {code_stale}（期望 1）；没传归因读数 → {code_nodata}（期望 1）")
    print(f"        空窗口（真实账号 0 条）→ {code_blank}（期望 1，只许报窗口那一条，命中 {problems_blank}）；"
          f"同一份桶给 n_real=7 → {code_notblank}（期望 1，命中 {problems_notblank}）")
    print(f"        账号名单：0 个邮箱在库里 →「{health_dead_list}」；名单活但窗口空 →「{health_empty_window}」；"
          f"有样本 → {health_fine!r}（期望 None）")
    print("自证通过" if ok else "自证失败：退出码规则没有按预期动")
    return 0 if ok else 1


# ─── 主流程 ───────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="11 道输出闸的反事实重放（只读）")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--json", type=str, default="", help="把结果写成 JSON")
    parser.add_argument("--no-ambient", action="store_true", help="跳过环境块重建（快，但 G1/G2/G6 变裸判）")
    parser.add_argument("--bridge-limit", type=int, default=0, help="只跑前 N 轮（调试）")
    parser.add_argument("--self-test", action="store_true", help="只自证退出码规则（不连库、不跑判据）")
    args = parser.parse_args()

    if args.self_test:
        return self_test()
    if not 1 <= args.days <= 365:
        # 这三条 SQL 都把天数拼成 `(N * interval '1 day')`：0 或负数不会报错，
        # 只会静默量出"空窗口"，而空窗口长得像"这一窗没问题"。
        raise SystemExit(f"--days 要是 1..365 之间的整数（今天给的是 {args.days}）")

    data = fetch_turns(args.days)
    counts = data["counts"]
    # 两种"0 条真实样本"要先分开说清，而且都不值得再跑一遍判据桥（三分种白烧）：
    # 名单失效要去改 `DEV_REAL_ACCOUNT_EMAILS`，窗口空要换窗口。
    health = account_filter_health(int(counts["n_listed_users"]), int(counts["n_real"]))
    if health:
        raise SystemExit(f"拒绝下结论：{health}")
    turns = data["turns"]
    if args.bridge_limit:
        turns = turns[:args.bridge_limit]
    tool_calls = fetch_tool_calls(args.days)
    # P2 的键表从判据桥现取（`companion-fact-spans.ts` 是唯一一份，见文件头 §2）。
    global SPAN_QUANTIFIERS
    gate_table = call_bridge({"mode": "gates", "turns": []})
    drift = gate_disagreements(gate_table["gates"], GATE_DISPOSITION)
    if drift:
        # 拒绝，而不是继续用一份对不上号的表读数：闸版本都归因不了，读出来的触发数更不可信。
        raise SystemExit("闸表与台子对不上（先修一边再跑）：" + "；".join(drift))
    current_version = gate_table["version"]
    print(f"闸版本 {current_version}（由代码里那份闸表派生，不是手写）")
    span_keys = call_bridge({"mode": "spans", "turns": []})["keys"]
    SPAN_QUANTIFIERS = {quantifier for spec in span_keys.values() for quantifier in spec["quantifiers"]}
    print(f"P2 键表：{len(span_keys)} 个键（{'、'.join(sorted(span_keys))}）"
          f"；量词 {'、'.join(sorted(SPAN_QUANTIFIERS))}")

    print(f"== 39d W1-1 反事实重放台 ==  窗口 {args.days} 天  跑批时刻 {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z")
    print(f"轮次：全量 {counts['n_all']} → 扣 scripted {counts['n_minus_scripted']} → 限定真实账号 {counts['n_real']}"
          f"（名单 {len(DEV_REAL_ACCOUNT_EMAILS)} 个邮箱，库里对得上 {counts['n_listed_users']} 个："
          + "、".join(DEV_REAL_ACCOUNT_EMAILS) + "）"
          f"（判据桥实跑 {len(turns)}）")
    # 剔除只有注册表那一层是显式的（`scripted-runs.txt` 由 e2e 验证脚本自己登记）；
    # 集测写进同一套库的行不在那张表里，只被账号名单挡住。所以这里把"挡得干不干净"印出来：
    # 真账号名下有多少行是「failed 且没选到模型」这一形状——这一格只报形状与稀释，不报成因。
    no_model_failed = int(counts["n_no_model_failed"])
    print(f"剔除：注册表 {len(scripted_run_ids())} 条（只有 `companion-turn-e2e-verify.py` 会登记）；"
          f"真账号名下「failed 且没选到模型」这一形状 **{no_model_failed} 条**")
    if no_model_failed:
        # 这句话只能说形状，不能说成因：逐条看过时间分布（09-20…09-23，每分钟一条）之后，
        # 它们更像真机上的失败回合（门禁／限流那类），不像集测夹具——把成因写死就是我又一次
        # "计数当结论"。要拿它做排除，得先逐条归因。
        print("        ↑ 这只报形状：这些行没有助手正文，判据对它们恒不触发，只会稀释分母；"
              "至于它们是测试数据还是真机失败，未逐条归因前不下结论")

    # 1) 环境块重建（真 loadHereAndNow，按重放时刻；见文件头 §1）
    ambient: dict[str, dict] = {}
    ran: list[int] = []
    dropped = 0
    if not args.no_ambient:
        ambient_turns = []
        for turn in turns:
            page_context = turn["page_context"] or ""
            ambient_turns.append({
                "runId": turn["run_id"],
                "workspaceId": turn["workspace_id"],
                "userId": turn["user_id"],
                "userText": text_of_blocks(turn["user_blocks"]),
                "pageContext": json.loads(page_context) if page_context.startswith("{") else None,
                "conversationId": turn.get("conversation_id") or None,
            })
        got = eval_ambient(ambient_turns)
        ambient = {entry["runId"]: entry for entry in got["turns"]}
        print(f"环境块：重建 {len(ambient)} 份（真 loadHereAndNow；历史环境块未落库，见文件头 §1）")
        # P1 preflight 的预算读数（39b §9.3：单轮 ≤ 120 ms，超了整块丢弃）。只统计真跑了
        # 解析器的那些轮（factsMs > 0），没有指称的轮一次查询都不发、不进这个分布。
        ran = [entry["factsMs"] for entry in ambient.values() if entry.get("factsMs")]
        dropped = sum(1 for entry in ambient.values() if entry.get("factsDropped"))
        if ran:
            ran_sorted = sorted(ran)
            p50 = ran_sorted[len(ran_sorted) // 2]
            p95 = ran_sorted[min(len(ran_sorted) - 1, int(len(ran_sorted) * 0.95))]
            print(f"P1 preflight：{len(ran)} 轮跑了解析（其余轮无指称，零查询）；"
                  f"p50 {p50} ms / p95 {p95} ms / max {ran_sorted[-1]} ms；超预算丢弃 {dropped} 轮")

    # 2) 判据执行
    bridge_turns = []
    for turn in turns:
        entry = ambient.get(turn["run_id"], {})
        bridge_turns.append({
            "runId": turn["run_id"],
            "replyText": text_of_blocks(turn["assistant_blocks"]),
            "systemTexts": [entry.get("systemText", "")] if entry.get("systemText") else [],
            "userTexts": [text_of_blocks(turn["user_blocks"])],
            "toolResultTexts": [call["summary"] for call in tool_calls.get(turn["run_id"], [])],
            "allowedNumberSource": entry.get("allowedNumberSource", ""),
        })
    got = run_bridge(bridge_turns)
    gate_results = {entry["runId"]: entry for entry in got["turns"]}

    # 3) 逐闸汇总
    buckets: dict[str, dict[str, int]] = {gate: {"covered": 0, "rescued-by-tool": 0,
                                                 "still-leaks": 0, "conditional": 0, "keep": 0,
                                                 "unclassified": 0}
                                         for gate in GATE_DISPOSITION}
    fired: dict[str, list[dict]] = {gate: [] for gate in GATE_DISPOSITION}
    for turn in turns:
        entry = gate_results.get(turn["run_id"])
        if not entry:
            continue
        calls = tool_calls.get(turn["run_id"], [])
        turn["tool_calls"] = calls
        # A 类闸的硬前提（39b §9.1）：整轮零工具调用。`planStepSteer` 的
        # `stepCalls === 0 && toolCallCount === 0` 里前一项是本步的，
        # 整轮 tool_call_count 为 0 时它必然也为 0，所以只看整轮这个数。
        is_a_class = int(turn["tool_call_count"]) == 0
        turn["tool_face"] = sorted({call["name"] for call in calls})
        # P1 的真实结果来自环境块重建那一趟（判据桥在同一事务里跑的 loadThisTurnFacts）。
        # 没跑重建时留 unknown：判据未知时不许把闸算成"已覆盖"。
        raw = ambient.get(turn["run_id"])
        p1 = {"definite": bool(raw and raw.get("p1Definite")), "rule": (raw or {}).get("p1Rule"),
              "unknown": raw is None}
        reply_text = text_of_blocks(turn["assistant_blocks"])
        for gate, result in entry["gates"].items():
            if not result.get("fired"):
                continue
            # C 类判据（G10／G11）长在念头链上，那里的输入是念头气泡正文——
            # 拿对话轮的回复跑它们只会得到一个好看但没意义的数。它们在下面单独跑。
            if GATE_CLASS[gate] == "C":
                continue
            # A 类闸的硬前提：整轮零工具调用。不满足时当时不会走到这条判据。
            if GATE_CLASS[gate] == "A" and not is_a_class:
                continue
            classification = classify(gate, turn, result, p1, reply_text)
            buckets[gate][classification["bucket"]] += 1
            fired[gate].append({"run_id": turn["run_id"], "source": "turn",
                                "created_at": turn["created_at"],
                                "leak_gate_version": turn["leak_gate_version"],
                                **classification, "detail": result.get("detail")})

    # 4) 念头链（G10／G11）：输入是念头气泡正文，数据源与对话轮不同。
    thoughts = fetch_thoughts(args.days, ",".join("'" + e + "'" for e in DEV_REAL_ACCOUNT_EMAILS))
    if thoughts:
        # allowedSource 取该用户的环境块（真 renderHereAndNow）——念头链喂给判据的事实来源
        # 与对话侧同一份。`--no-ambient` 时为空串，此时 G10 按设计恒不触发（判据首行
        # `if (allowedSource.length === 0) return false`），读数要跟着一起看。
        ambient_by_user: dict[str, str] = {}
        for turn in turns:
            entry = ambient.get(turn["run_id"], {})
            if entry.get("systemText"):
                ambient_by_user.setdefault(turn["user_id"], entry["systemText"])
        thought_payload = [{
            "runId": thought["id"],
            "replyText": thought["text"],
            "allowedNumberSource": ambient_by_user.get(thought["user_id"], ""),
            "isThought": True,
        } for thought in thoughts]
        thought_got = run_bridge(thought_payload)
        print(f"念头链：{len(thoughts)} 条（source='llm'）参与 G10／G11")
        for thought, entry in zip(thoughts, thought_got["turns"]):
            for gate in ("G10", "G11"):
                result = entry["gates"][gate]
                if not result.get("fired"):
                    continue
                classification = classify(
                    gate,
                    {"tool_calls": [], "tool_face": [],
                     "thought_guard_covers": bool(entry.get("thoughtGuardCovers"))},
                    result, {}, thought["text"])
                buckets[gate][classification["bucket"]] += 1
                fired[gate].append({"run_id": thought["id"], "source": "thought",
                                    "created_at": thought["created_at"],
                                    "leak_gate_version": thought["leak_gate_version"],
                                    **classification, "detail": result.get("detail")})

    thought_eval_turns = thought_got["turns"] if thoughts else []

    # 可判分母（39d W6-1 对账）：判据要用的输入不存在时它**恒不触发**，
    # 那种 0 是"测不出来"不是"没有"。G5 的 A′ 前置 `stepEmitted` 从不落库，
    # 所以这一格永远是 0；G10 的分子是"念头气泡拿到了非空数字来源"的条数。
    a_class_eligible = [t for t in turns
                        if int(t["tool_call_count"]) == 0 and ambient.get(t["run_id"], {}).get("systemText")]
    # 分母只数**有可能触发闸的行**：没有助手正文的回合（今天量到占 A 类前置的 24%）
    # 对任何一道输出闸都恒不触发，把它们留在分母里只会让"可判分母 408"这类数字虚高。
    a_class_ambient = [t for t in a_class_eligible if text_of_blocks(t["assistant_blocks"]).strip()]
    print(f"A 类可判分母：{len(a_class_eligible)} 条满足「零工具调用＋环境块在」，"
          f"其中 {len(a_class_eligible) - len(a_class_ambient)} 条没有助手正文 ⇒ 剔出分母（它们不可能触发任何闸）")
    measurable = {
        "G1": len(a_class_ambient), "G2": len(a_class_ambient),
        "G3": len(a_class_ambient), "G6": len(a_class_ambient),
        # G4 可判的只有短语表那一支；分类器那一支要发模型请求，本台按设计不发 ⇒
        # 这一格的分母是"半个判据的分母"，报告里另印一句提醒。
        "G4": len(a_class_ambient),
        "G5": 0,
        # B 类里这三条是**入库前**的拒绝闸：库里那份正文是过了闸才留下的，
        # 所以"删掉它会不会漏"在库里根本没有可判的输入——判据只能对"已经在它下游"的
        # 文本说话。它们去向都是 keep，但分母必须如实写 0，免得哪天按"触发 5 次"翻成 delete。
        "G7": 0, "G8": 0, "G9": 0,
        "G10": sum(1 for e in thought_eval_turns
                   if int(((e.get("gates") or {}).get("G10") or {}).get("sourceChars") or 0) > 0),
        "G11": len(thought_eval_turns),
    }
    # 生产把它们合成了一条闸、共用一份预算（`runtime.ts:3235,3239-3240,3249`）：
    # 分条计数会把"一次拦截"报成"两次触发"，所以单位一并印出来。
    def unit_of(pair: tuple[str, str]) -> int:
        # 必须与逐闸那一列同一拨样本（A 类前置＋环境块在），否则单位数会比触发数还大——
        # 那正是"好看但没意义的数"。
        return sum(1 for t in a_class_ambient
                   if any((gate_results.get(t["run_id"]) or {}).get("gates", {}).get(g, {}).get("fired")
                          for g in pair))
    unit_claims = unit_of(("G1", "G6"))
    unit_lookup = unit_of(("G2", "G3"))

    print()
    print(f"{'闸':<4}{'类':<8}{'去向':<12}{'触发':>5}{'covered':>9}{'rescued':>9}"
          f"{'still-leaks':>12}{'conditional':>13}{'可判分母':>10}")
    for gate in sorted(GATE_DISPOSITION, key=lambda g: int(g[1:])):
        stat = buckets[gate]
        # 保留闸不参与分桶，它的触发数就记在 `keep` 那一格里（这里不再减一次）。
        total = sum(stat.values())
        print(f"{gate:<4}{GATE_CLASS[gate]:<8}{GATE_DISPOSITION[gate]:<12}{total:>5}"
              f"{stat['covered']:>9}{stat['rescued-by-tool']:>9}{stat['still-leaks']:>12}"
              f"{stat['conditional']:>13}{measurable[gate]:>10}")
    # 归因（39d #28 第三步）：每条触发按它所在样本行的 `leak_gate_version` 分组——
    # 与当前闸表同名的才算证据，NULL／旧名都只算"有一条历史样本，不知道是谁服务的"。
    # 天数仍然要判：归因只解决了"哪套代码"，没解决"单日抖动"。
    attribution: dict[str, dict] = {}
    for gate, items in fired.items():
        matched = [i for i in items if i.get("leak_gate_version") == current_version]
        stale = [i for i in items if i.get("leak_gate_version")
                 and i.get("leak_gate_version") != current_version]
        missing = [i for i in items if not i.get("leak_gate_version")]
        attribution[gate] = {
            "attributed": len(matched),
            "stale": len(stale),
            "missing": len(missing),
            "unattributed": len(stale) + len(missing),
            "attributed_days": len({str(i["created_at"])[:10] for i in matched}),
        }
    delete_gates = [g for g, d in GATE_DISPOSITION.items() if d == "delete"]
    print("触发归因（当前闸版本 " + current_version + "）："
          + "；".join(f"{g} 归因 {attribution[g]['attributed']}"
                      f"／旧版本 {attribution[g]['stale']}"
                      f"／无版本 {attribution[g]['missing']}"
                      for g in sorted(delete_gates, key=lambda x: int(x[1:])))
          + f"（本窗口带闸版本的回合 {sum(1 for t in turns if t['leak_gate_version'] == current_version)}"
          f"／念头 {sum(1 for th in thoughts if th['leak_gate_version'] == current_version)}）")
    print(f"\nG10 的可判分母用的是**重放时刻**重建出来的环境块（历史那一屏没落库），"
          f"所以它的空集说的是「以今天的读数去判这 {len(thoughts)} 条气泡」，不是「当时判不出问题」。")
    print(f"G4 只测了短语表那一支；分类器那一支（`runtime.ts:2772`）要发模型请求，"
          f"本台按设计不发 ⇒ G4 的触发数是**下界**。")
    print(f"计数单位（生产是合并的，分条报会把一次拦截数成两次触发）："
          f"G1｜G6 合成 `hasUnverifiedClaims` ⇒ {unit_claims} 次；"
          f"G2｜G3 合成 `lookupClaim` ⇒ {unit_lookup} 次。"
          f" G5 的 196 类触发没有可判分母（A′ 前置从不落库），只能当上限看。")
    code, problems = exit_code_for(buckets, GATE_DISPOSITION, measurable, attribution,
                                   n_real=int(counts["n_real"]))

    print()
    if problems:
        for gate, leaks in problems:
            if isinstance(leaks, int):
                print(f"退出码 1：{gate} 仍有 {leaks} 条 still-leaks —— 不许删。", file=sys.stderr)
            else:
                # 零触发与分母为 0 都不是"这闸没用了"的证据，只是这一窗口量不到。
                print(f"退出码 1：{gate} {leaks} —— 证据不足，不许删。", file=sys.stderr)
                continue
            for item in fired[gate]:
                if item["bucket"] == "still-leaks":
                    print(f"    {item['run_id']} {item['created_at']} {item['why']} {item['detail']}",
                          file=sys.stderr)
    else:
        print("退出码 0：每条标「删除」的闸都满足 covered + rescued = 100%、触发数 > 0、可判分母 > 0。")
        print("（这是**第一份**证据。删闸还要第二份：真实流量在落地后的窗口里 0 触发，")
        print("  窗口 ≥ 30 天且整段落在落地之后——见 39d W0-11；两条齐了也只在 W6-1 删。）")

    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps({
            "window_days": args.days, "counts": counts,
            # 读数可信度这一族也进这一份（下游不许自己再数一遍）：名单、注册表规模、
            # 以及"真账号名下有多少行是 failed 且没选到模型这一形状"。
            "sample_health": {
                "listed_emails": list(DEV_REAL_ACCOUNT_EMAILS),
                "listed_users_in_db": int(counts["n_listed_users"]),
                "scripted_registry_ids": len(scripted_run_ids()),
                "no_model_no_text_shape_under_real_accounts": no_model_failed,
            },
            "buckets": buckets, "fired": {g: v for g, v in fired.items() if v},
            # 去向的**唯一机器可读副本**在这里（正文那份是 39b §9.1）。下游报告不许
            # 再抄一份 delete/keep/conditional——上一版就抄了一份中文标签表，改一处会静默不一致。
            "dispositions": GATE_DISPOSITION,
            "measurable": measurable, "units": {"G1|G6": unit_claims, "G2|G3": unit_lookup},
            # 归因与闸版本也进这一份：下游报告不许自己再数一遍日期来判"能不能删"。
            "gate_version": current_version, "attribution": attribution,
            "p1_preflight": {
                "runs": len(ran) if not args.no_ambient else 0,
                "ms": sorted(ran) if not args.no_ambient else [],
                "dropped": dropped if not args.no_ambient else 0,
            },
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"JSON 已写入 {args.json}")

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
