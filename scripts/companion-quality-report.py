#!/usr/bin/env python3
"""伴星质量基线报告（语料模式：只读库，不花任何模型调用）。

为什么需要它：`companion-agent-runtime.ts` 里 20+ 条带日期编号的补丁注释（T0 / ④-b /
E / S6 …）是「无测量地反复打补丁」的痕迹。方案 29 §4.10 要求先有可对比的数字，
再动 §4.1–§4.9，否则每一刀都只能靠肉眼判断她聪明了没有。

两种用法：
    # 1) 语料基线（默认）——把库里真实轮次折成一张指标表
    python3 scripts/companion-quality-report.py
    python3 scripts/companion-quality-report.py --since 2026-09-20 --json .impeccable/companion/after-b2.json

    # 2) 与另一份 JSON 对照，输出 delta（改前/改后）
    python3 scripts/companion-quality-report.py --compare .impeccable/companion/baseline.json

实时发回合的验证不在这里：见 `companion-turn-e2e-verify.py`（它管流式/失败/落库形态，
本脚本管分布与占比）。两者互补，别合并——一个要花钱、一个只读。

前置：dev 栈已起，Postgres 容器可 `docker exec`。

口径说明（改动时别改回去）：
  * 「零工具轮」= tool_call_count=0。它是方案 RC1 的直接读数：关键词没命中 →
    selectSkill 返回 null → 工具面为空 → 单步。这个数降不下来，后面全白做。
  * 「推进率」判据是**回复里有没有把球抛回去**（问句或提议），不是长度。方案 #1 的
    正解是「答完带一个延续性话题」，长度只是它的代理指标。
  * 「回声率」= 回复去掉标点后完全等于上一条用户消息。实机「你好呀→你好呀！」就是它。
  * 语音完整性有三层：按 run 聚合 `voice.segment.ready` 事件数（服务端下发了几段）、
    0246 起的 `companion_tts_outcomes` stage='synth'（每段**实际合成结果**：ok/failed/
    rejected、引擎、耗时、字节数），以及 0247 起同表 stage='playback'（客户端**拿到字节
    之后**的结局：播完 / 等到超时 / 取段失败）。抱怨 #4「经常没声音」到这里才分得清是
    没生成、生成了没送出、送出了没响——而最后那一层只有在桌面端在线时才有数。
"""
from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import re
import subprocess
import sys
from datetime import datetime

CONTAINER = "ailearn-dev-postgres-1"


def rows(query: str) -> list[dict]:
    """跑一条 SELECT，返回 dict 列表。

    走 `COPY (...) TO STDOUT WITH CSV` 而不是 `psql -A -F`，两个原因都是静默错数：

    1. **折行**：psql 即使 `-A` 也会按输出宽度把长值切成多行（实测 base64 正文被
       拆成 64 字符一段），行式解析会把一条记录读成好几条。
    2. **分隔符撞值**：`-F ' | '` 撞上正文里的同串就错位。CSV 有引号转义，配合
       `csv.DictReader` 才是可逆的。

    `-t` 只用于压掉 `COPY n` 那行命令状态；表头由 `HEADER true` 给出。
    """
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "psql", "-U", "ailearn", "-d", "ailearn", "-t", "-c",
         f"COPY ({query.strip().rstrip(';')}) TO STDOUT WITH (FORMAT csv, HEADER true)"],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:400])
    reader = csv.DictReader(io.StringIO(out.stdout))
    return [dict(record) for record in reader]


def scalar(query: str) -> str:
    got = rows(query)
    if not got:
        return ""
    return next(iter(got[0].values()), "")


def num(value: str | None, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def since_clause(since: str | None, column: str) -> str:
    return f" AND {column} >= '{since}'::timestamptz" if since else ""


# ─── 指标采集 ──────────────────────────────────────────────────────────────

# 评测脚本自己打的轮次**不该进形态指标**：它们的输入是固定的场景句，开场白也高度雷同，
# 混进真实使用里就会造出假读数——2026-09-21 量到"今天唯一的连续相同开头是
# 『我再查一』×2"，那三句全是我自己跑 Y 场景打出来的，10.5%/17.1% 的开场重复率
# 有一半是测量者造的。脚本每跑一轮把 run id 追加进这个文件，报表据此剔除。
SCRIPTED_RUNS_FILE = ".impeccable/companion/scripted-runs.txt"

# 一票否决的取样切分点（UTC）。这一条不是"最近 N 天"这种方便写法，而是**改变输出形态
# 的那一批修复上线的时刻**：无条件攒住 12 字 + 坍缩修复梯子（方案 29 §9.69 及当天 11:00
# 的那次改动）。用它之前的轮次算退化率，量的是已经修掉的那个病。
# 下一批改变输出形态的修复上线时，改这一行，不要新增第二个窗口。
VETO_SAMPLE_SINCE = "2026-09-21 11:00:00+00"
VETO_GATE_MIN_SAMPLE = 100

# 客户端"播放完了/等到超时"上报能力的上线时刻（本机 09-21 14:10 提交，
# 全库第一条 playback 行 09:26 UTC）。早于这一行的段不可能有上报，不能算静音。
PLAYBACK_REPORTING_SINCE = "2026-09-21 06:10:00+00"

# "字节到手却零上报"已知成因的修复上线时刻：2026-09-22 12:40（本机）= 04:40 UTC。
# 那一刻上线的是 `runQueuedSpeech` 的播放封顶（`await host.play()` 不再无上限）
# + dropped 只报字节真的到手的段 + 三条裸 return 补上报（方案 29 §12.10）。
# 再往后 2026-09-22 下午又补了外层 catch 那条出口（单测覆盖，见
# companion-voice-playback.test.ts「意外异常也必须给已到手的段一个终态」）。
# 切分点之前剩下的段是历史，不是现状；只报全时段会让一个修好的病天天显示成故障。
AUDIO_SILENT_FIX_SINCE = "2026-09-22 04:40:00+00"

# `companion_stream_events` 有 TTL（迁移 0217 的过期清扫），旧事件会被真的删掉。
# 于是"按事件数出来的"指标在保留窗口之前会读成 0——那不是"没下发"，是**证据没了**。
#
# 地平线取**第一条 `voice.segment.ready` 事件**，不取全表最早事件：后者只说明"事件从那时
# 起没被清完"，不说明"从那时的段都被记下来了"。实测（2026-09-22）：
#   全表最早事件 09-20 01:45，但 09-20 那 158 轮的段事件是 0——它们要么被 TTL 清过、
#   要么那时管线还没在发段，两种解释都推不出"这 158 轮漏了段"。
#   第一条段事件在 09-21 09:26:35，从它起 n=80 轮、零段 = 0。
# 旧注释写的"分界 09-19 11:00"是当时的读数，现在读不出来了（事件已过期）——别照着它推。
VOICE_SEGMENT_HORIZON_SQL = (
    "(SELECT min(created_at) FROM companion_stream_events WHERE type = 'voice.segment.ready')"
)

# 「把话头递回去」不一定带问号。2026-09-22 分类"未推进"样本时抓到的一类：
# 用户说「等一下，先别念了」，她答「嗯，停在这儿了。你说。」——这是邀请，
# 但上面那串问句标记一个都不命中，于是被计成"没推进"。
# 只收**邀请形状**的说法；"我接着说/我说完了"是她在继续或收尾，不算递话头。
ADVANCE_INVITATION_TEST = re.compile(
    r"你说[。吧呀呢！]|你先说|想说什么|想说点什么|说点(什么|啥)|聊点(什么|啥)|尽管问|随时(说|找我|来问)"
)

# 开发库里的"真人账号"。这条是**开发栈的约定**而不是产品规则：这套 dev 栈上只有
# 一个人在用，其余账号都是集成测试现造的（`test-*` / `t-*` / `agent-*`，每个都自带
# 一个没签 AI 同意书的工作区，用来断言 fail-closed）。
# 为什么必须分开：全库 55 条 failed 里 **28 条来自这些夹具账号**（它们 40 条 run
# 里失败 28 条 = 70%，同码跨 13 个工作区），混在一起报出来的"失败率 10.6%"
# 把产品在线的 5.6% 抬了一倍。判据用邮箱而不是"跨工作区+挤在几分钟"那条启发式，
# 因为同意书夹具是**几天里反复跑出来的**，时间上不挤在一起。
DEV_REAL_ACCOUNT_EMAILS = ("owner@ailearn.local",)

# 系统视野类问句（方案 §8.5）：只收**学习时长**这一种。
#
# 形状与 worker 的预取判据同源（`companion-here-and-now.ts` 的
# VISION_LEARNING_QUESTION），但这里是 Python 侧的一份拷贝——SQL 里的 `~` 用的是
# POSIX 正则，两边的元字符集不同，没法共享同一个字面量。改一处必须改另一处，
# 漏改的后果是**样本静默变少**（不是报错），所以两处都写了这条注释。
VISION_TIME_QUESTION = (
    "(今天|今日|这周|本周|这个星期)[^。！？]{0,12}(学|复习|读)[^。！？]{0,6}"
    "(多久|多长时间|多少|几分钟|几小时)"
)

# "学习时长答错"这个已知成因（§9.24：她的编造被抽取器写进记忆，于是上下文里"出现过"
# 就成了合法出处）的修复切分点。界取在实测的两次之间：最后一条错答 09-21 00:19:50Z
# （"本周 23 分钟"，真值 60），第一条正确答案 00:25:37Z。全时段那个数永远一起打，
# 切分点只是把"已经修掉的病"与"现状"分开，不替换、不隐藏。
VISION_TRUTH_FIX_SINCE = "2026-09-21 00:25:00+00"


def scripted_run_ids() -> set[str]:
    try:
        with open(SCRIPTED_RUNS_FILE, encoding="utf-8") as handle:
            return {line.strip() for line in handle
                    if re.fullmatch(r"[0-9a-fA-F-]{36}", line.strip())}
    except OSError:
        return set()


def scripted_exclusion(column: str, ids: set[str]) -> str:
    """把评测脚本的轮次从一条 SQL 里剔掉（只按 uuid 精确匹配，不做模糊判断）。"""
    if not ids:
        return ""
    listed = ",".join(f"'{value}'" for value in sorted(ids))
    return f" AND coalesce({column}::text, '') <> ALL(ARRAY[{listed}]::text[])"


def minutes_mentioned(text: str) -> list[int]:
    """她答句里报出的"分钟"数（"X 小时"按 60 折算）。"""
    values = [int(match.group(1)) for match in re.finditer(r"(\d+)\s*分钟", text)]
    for match in re.finditer(r"(\d+(?:\.\d+)?)\s*(?:个)?\s*小时", text):
        values.append(int(round(float(match.group(1)) * 60)))
    return values


def summarize_vision_answers(
    samples: list[dict],
    tolerance_minutes: int = 3,
    split_at: str | None = None,
) -> dict:
    """把"学习时长"问句的答句与**锚在提问那一刻重算的真值**逐项比。

    口径写清楚，免得下一眼看错这个数：

    * 分母是"**可比对的项**"，不是"问句条数"——一条问句可能同时问今天和本周（两项），
      也可能她一个数字都没报（那种进 `answers_without_number`，不进分母）。
    * 容差 ±N 分钟：服务端自己就 `Math.round(seconds/60)`，她再口语化一次（"大概一小时"）
      还会再取整；把取整差当成说谎，这条读数第二天就没人信了。
    * 判"匹配"是"她报的数字里**有一个**落在真值附近"。她一句话里带别的分钟数
      （"还剩 12 分钟"）时可能撞上，所以这条读数是**下界**——它报错就一定错，
      它报对不排除蒙对。宁可是下界，也不要一个会自己反噬的精确率。
    * `split_at` 之后单独再算一遍。切分点是**已知成因的修复上线时刻**（§9.24：
      数字的合法出处只剩本轮重算的那几块 + 统计量不进记忆），之前那几条错答是
      已经修掉的那个病；全时段那个数永远一起打出来，不做替换。
    """
    def evaluate(rows_: list[dict]) -> tuple[int, int, list[dict], int]:
        expected = 0
        matched = 0
        without_number = 0
        mismatches: list[dict] = []
        for row in rows_:
            answer = (row.get("answer") or "").strip()
            question = (row.get("question") or "").strip()
            mentions = minutes_mentioned(answer)
            if not mentions:
                without_number += 1
                continue
            truths: list[tuple[str, int]] = []
            if re.search(r"今天|今日", question):
                truths.append(("今日", int(round(float(row.get("today_seconds") or 0) / 60))))
            if re.search(r"这周|本周|这个星期", question):
                truths.append(("本周", int(round(float(row.get("week_seconds") or 0) / 60))))
            for label, truth in truths:
                expected += 1
                if any(abs(value - truth) <= tolerance_minutes for value in mentions):
                    matched += 1
                else:
                    mismatches.append({
                        "asked_at": str(row.get("asked_at"))[:19],
                        "label": label,
                        "truth": truth,
                        "said": mentions[:3],
                        "question": question[:40],
                    })
        return expected, matched, mismatches, without_number

    compared, matched, mismatches, without_number = evaluate(samples)
    since_fix = None
    if split_at:
        later = [row for row in samples if str(row.get("asked_at"))[:19] >= split_at[:19]]
        later_compared, later_matched, _, _ = evaluate(later)
        since_fix = {
            "compared": later_compared,
            "matched": later_matched,
            "accuracy": (round(later_matched / later_compared, 3) if later_compared else None),
        }
    return {
        "turns": len(samples),
        "answers_without_number": without_number,
        "compared": compared,
        "matched": matched,
        "accuracy": (round(matched / compared, 3) if compared else None),
        "tolerance_minutes": tolerance_minutes,
        "mismatches": mismatches[:3],
        "since_fix": since_fix,
    }


def collect(since: str | None) -> dict:
    where = since_clause(since, "created_at")
    # 评测脚本轮次不参与形态统计（理由见 scripted_run_ids 的注释）。
    scripted = scripted_run_ids()

    runs = rows(f"""
        SELECT coalesce(status,'-') k, count(*) n FROM companion_turn_runs
        WHERE true {where.replace('created_at', 'created_at')}
        GROUP BY 1 ORDER BY 2 DESC;
    """)
    run_total = sum(int(r["n"]) for r in runs)
    by_status = {r["k"]: int(r["n"]) for r in runs}

    # 0239 把技能层整条删掉了，`agent_mode` 这一列不复存在（当时的指标也一起作废，
    # 见方案 §9.12）。这里改按**权限档**分组：现在决定"她能调什么"的只有权限，
    # 而"零工具轮占比"仍然是要看的那个数。
    modes = rows(f"""
        SELECT coalesce(nullif(permission_level,''),'(unset)') k, count(*) n,
               max(step_count) max_steps,
               count(*) FILTER (WHERE tool_call_count = 0) zero_tool
        FROM companion_turn_runs WHERE true {where} GROUP BY 1 ORDER BY 2 DESC;
    """)
    zero_tool = sum(int(m["zero_tool"]) for m in modes)

    # 失败原因**带工作区数与时间跨度**：同一分钟内跨多个工作区的同一种错误码，是
    # 集成测试夹具的签名（测试会现造没签同意的工作区），不是产品在线失败率。
    # 实测被这一条救过一次：since=04:06 的窗口里 5 条 AI_CONSENT_REQUIRED 撑起
    # "失败率 55.6%"，实为 4 个工作区在 04:54:55~04:55:51 一分钟内的一次测试跑。
    #
    # 只数 `status='failed'`。原来这里连着 cancelled/superseded 一起数，于是"失败原因"
    # 那本账的总数（82）与上面失败率的分母（55）不是同一批行，而排第一的
    # "(no code) 30" 里 **27 条是用户自己打断或又发了一轮**——一个不是失败的东西
    # 坐在了失败原因的头把交椅上。打断本身是有用的信号，所以它单独一行（见 interrupts）。
    failures = rows(f"""
        SELECT coalesce(nullif(error_code,''),'(no code)') k, count(*) n,
               count(DISTINCT workspace_id) distinct_ws,
               floor(extract(epoch FROM (max(created_at) - min(created_at))) / 60)::int span_min
        FROM companion_turn_runs
        WHERE status = 'failed' {where} GROUP BY 1 ORDER BY 2 DESC;
    """)

    interrupts = rows(f"""
        SELECT status, count(*) n
        FROM companion_turn_runs
        WHERE status IN ('cancelled','superseded') {where} GROUP BY 1;
    """)

    # 失败率按账号类别拆开（理由见 DEV_REAL_ACCOUNT_EMAILS 上方那段）。
    real_list = ",".join(f"'{email}'" for email in DEV_REAL_ACCOUNT_EMAILS)
    failure_split = rows(f"""
        SELECT CASE WHEN r.user_id IN (SELECT id FROM users WHERE email IN ({real_list}))
                    THEN 'real' ELSE 'fixture' END acct,
               count(*) runs, count(*) FILTER (WHERE r.status = 'failed') failed
        FROM companion_turn_runs r WHERE true {where} GROUP BY 1;
    """)

    # 正文长度分布：按用户输入长短分桶——「闲聊该短」是人格第 19 行的既定主张，
    # 混在一起看会被长问答轮次拉平，看不出坍缩。
    lengths = rows(f"""
        WITH pairs AS (
          SELECT length(u.blocks->0->>'text') AS ulen,
                 length(a.blocks->0->>'text') AS alen
          FROM companion_messages u
          JOIN companion_messages a ON a.conversation_id = u.conversation_id AND a.seq = u.seq + 1
          WHERE u.role = 'user' AND a.role = 'assistant' {since_clause(since, 'u.created_at')}
          {scripted_exclusion('a.run_id', scripted)}
        )
        SELECT CASE WHEN ulen <= 6 THEN 'short(<=6)' ELSE 'long(>6)' END bucket,
               count(*) n,
               round(avg(alen)::numeric, 1) mean,
               percentile_cont(0.1) WITHIN GROUP (ORDER BY alen) p10,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY alen) p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY alen) p90,
               count(*) FILTER (WHERE alen < 4) degenerate
        FROM pairs GROUP BY 1 ORDER BY 1;
    """)

    # 推进率 / 回声率：取最近 400 条 assistant 正文在 Python 侧算，
    # SQL 里写中文问号的字符类容易和 full-width 变体打架。
    #
    # 正文**必须 base64 传输**：psql -A 是行式输出，而她的回复里天然带 `\n\n`
    # （多步可见正文的分段符），裸传会把一条记录劈成多行、静默污染统计。
    # 同理 ` | ` 分隔符也可能出现在正文里。
    # `used_tool` 是为**口径**加的：推进率的目标（>60%）是给"陪人聊天"定的，而这个库
    # 里现在混着两类完全不同的轮次——评测脚本打的场景轮（大多是"我有多少东西到期"这种
    # 事实问答，答对就该收尾，反问一句反而讨厌）与用户自己的闲聊轮。把它们混在一个
    # 分母里，我 2026-09-21 就差点把 40.2% 读成"退化了"（同一周早些时候量过 85.7%），
    # 而真实情况是脚本轮占比变了。与"取段覆盖率要求客户端在线"同一类陷阱。
    # 列名一律带表别名：companion_turn_runs 也有 conversation_id，裸列名会 ambiguous。
    bodies_raw = rows(f"""
        SELECT m.role,
               encode(convert_to(coalesce(m.blocks->0->>'text',''), 'UTF8'), 'base64') body,
               CASE WHEN r.id IS NULL THEN 'none'
                    WHEN r.tool_call_count > 0 THEN 'tool'
                    ELSE 'chat' END used_tool,
               r.id::text AS run_id
        FROM companion_messages m
        LEFT JOIN companion_turn_runs r ON r.id = m.run_id
        WHERE true {since_clause(since, 'm.created_at')}
          {scripted_exclusion('m.run_id', scripted)}
          AND m.role IN ('user','assistant')
        ORDER BY m.conversation_id, m.seq DESC LIMIT 800;
    """)
    bodies = [{"role": r["role"], "used_tool": r.get("used_tool") or "none",
               "body": base64.b64decode(r["body"]).decode("utf-8", "replace")} for r in bodies_raw]
    advance = echo = opener_repeat = seen = 0
    # 推进率按"这一轮有没有查过东西"分开算（理由见上面 bodies_raw 的注释）。
    by_class = {"tool": [0, 0], "chat": [0, 0]}  # [分母=答句数, 分子=带延续性的]
    # JOIN 不上 run 的答句（主动念头落库那一类）不进任何一个分母：它们不是"回合的答句"，
    # 混进 chat 那档会把闲聊的推进率往下压，而这正是这次要分开的东西。
    no_run = 0
    prev_user = prev_opener = None
    for row in reversed(bodies):  # 上面按 seq DESC 取的是「最近的尾巴」，翻回转正序
        body = (row["body"] or "").strip()
        if row["role"] == "user":
            prev_user = body
            continue
        if not body:
            continue
        seen += 1
        asked = (any(mark in body for mark in ("？", "?", "要不要", "想不想", "试试", "吗？", "呢？"))
                 or bool(ADVANCE_INVITATION_TEST.search(body)))
        if asked:
            advance += 1
        cls = row["used_tool"] if row["used_tool"] in by_class else "none"
        if cls == "none":
            no_run += 1
        else:
            by_class[cls][0] += 1
            by_class[cls][1] += 1 if asked else 0
        strip = lambda s: "".join(ch for ch in s if ch not in "？！。，、；：…~ \t\n!.,;: ")  # noqa: E731
        if prev_user and strip(body) == strip(prev_user):
            echo += 1
        opener = body[:2]
        if prev_opener and opener == prev_opener:
            opener_repeat += 1
        prev_opener = opener

    # 记忆：读侧有没有命中、写侧有没有产出（方案 §2.3 的两条断点分别对应这两个数）
    mem_runs_total = int(scalar(f"SELECT count(*) FROM companion_turn_runs WHERE true {where};") or 0)
    # 命中数必须**以窗口内的 run 为分母、并 JOIN 到同一批 run**：曾经按
    # memory_usage_log 自己的 created_at 筛分子，于是集成测试留下的、以及窗口外 run 的
    # 使用记录也被计入，得到「命中轮占比 105.7%」这种不可能的数。
    mem_hit = int(scalar(f"""
        SELECT count(DISTINCT l.run_id) FROM memory_usage_log l
        JOIN companion_turn_runs r ON r.id = l.run_id
        WHERE cardinality(l.memory_ids) > 0 AND true {since_clause(since, 'r.created_at')};
    """) or 0)
    mem_extract_written = int(scalar("""
        SELECT count(*) FROM assistant_memory_items
        WHERE source_event_id LIKE 'memory-extract:%';
    """) or 0)
    mem_live = int(scalar("""
        SELECT count(*) FROM assistant_memory_items
        WHERE candidate = false AND deleted_at IS NULL;
    """) or 0)
    # 候选行**不是"卡住"**：抽取器只把 preference/goal/learning_context 直接写活，
    # interaction_note/episodic 故意留候选，交给记忆中心过目（决策 D3=a）。
    # 实测 `GET /companion/memory?includeCandidates=true` 返回 61 条里 20 条是候选，
    # 桌面端也确实传了这个参数（companion-center-surface.tsx:259），所以「确认写入」点得到。
    # 这一档该看的不是"有没有候选"，而是"有没有人来看"——所以量的是最久等了几天。
    mem_candidates = int(scalar("""
        SELECT count(*) FROM assistant_memory_items
        WHERE candidate = true AND deleted_at IS NULL AND archived_at IS NULL;
    """) or 0)
    mem_candidate_oldest_days = int(scalar("""
        SELECT floor(coalesce(extract(epoch FROM (now() - min(created_at))), 0) / 86400)
        FROM assistant_memory_items
        WHERE candidate = true AND deleted_at IS NULL AND archived_at IS NULL;
    """) or 0)
    # 0256 的冷静期到点了没有：等得够久、又不带"当前时间窗统计量"的候选，
    # 会被每日维护自动落库。这个数不为 0 就说明"还要人来看"这条默认还压着东西。
    mem_candidates_ripe = int(scalar("""
        SELECT count(*) FROM assistant_memory_items
        WHERE candidate = true AND deleted_at IS NULL AND archived_at IS NULL
          AND created_at < now() - interval '3 days'
          AND NOT (content ~ '(本周|这周|今天|今日|截至|这一阵)'
                   AND content ~ '\\d+(\\.\\d+)?\\s*(分钟|小时|张|篇|项|题|次|条|%)');
    """) or 0)
    extract_jobs = rows("""
        SELECT status k, count(*) n FROM jobs WHERE type='companion_memory_extract'
        GROUP BY 1 ORDER BY 2 DESC;
    """)

    # 语音：有正文却零段的 run
    #
    # **必须夹在"第一条段事件"之后读**（踩过两次）。全时段统计得到的是
    # 「363/444 有正文零语音」，看着像灾难，其实那 363 里绝大多数是**事件被 TTL 清掉的
    # 轮次**——seg=0 是证据没了，不是没下发。地平线之内（09-21 09:26 起）这个数是 **0**。
    #
    # 反过来这也**排除了一个错误假设**：用户抱怨「输出了但语音根本不读」不是服务端
    # 没下发段——有证据的窗口里一段都没漏过。责任在客户端 deadline 降级与 edge-tts
    # 上游故障（方案 §3.5 / §4.9）。地平线的定义与实测数见文件上方常量注释。
    voice = rows(f"""
        WITH per_run AS (
          SELECT r.id, r.created_at,
                 (SELECT count(*) FROM companion_stream_events e
                   WHERE e.run_id = r.id AND e.type = 'voice.segment.ready') segs,
                 coalesce(length((SELECT blocks->0->>'text' FROM companion_messages m
                                   WHERE m.id = r.assistant_message_id)), 0) chars
          FROM companion_turn_runs r WHERE r.status = 'succeeded' {since_clause(since, 'r.created_at')}
        )
        SELECT count(*) n,
               count(*) FILTER (WHERE segs = 0 AND chars > 0) zero_voice,
               min(created_at)::date zero_voice_from,
               max(created_at)::date zero_voice_to,
               round(avg(segs)::numeric, 2) avg_segs,
               -- 地平线之内：事件还在，seg=0 才是"真的没下发段"。
               count(*) FILTER (WHERE created_at >= {VOICE_SEGMENT_HORIZON_SQL}) in_horizon,
               count(*) FILTER (WHERE created_at >= {VOICE_SEGMENT_HORIZON_SQL} AND segs = 0 AND chars > 0)
                 zero_voice_in_horizon,
               round(avg(segs) FILTER (WHERE created_at >= {VOICE_SEGMENT_HORIZON_SQL})::numeric, 2)
                 avg_segs_in_horizon
        FROM per_run;
    """)

    # §8 的一票否决项（方案 B8 / §9.6）：**按模型**算退化率，而不是只按全库。
    # 两个阈值都写在这里（<10% 不足 6 字、>85% 以句末标点收尾），因为这一项
    # 不过的话其余各条的体感都不成立。按模型分组还有一层用途：`model_id` 记的是
    # **本轮实际生效的**模型，跨模型兜底（companion_fallback）跑起来时会单独成行，
    # 于是"换了个模型是不是真的更好"是读出来的，不是猜的。
    degeneration = rows(f"""
        WITH replies AS (
          SELECT coalesce(r.model_id, '(unknown)') AS model_id,
                 coalesce(m.blocks->0->>'text', '') AS t
          FROM companion_turn_runs r
          JOIN companion_messages m ON m.id = r.assistant_message_id
          WHERE r.status = 'succeeded' {since_clause(since, 'r.started_at')}
        )
        SELECT model_id, count(*) n,
               count(*) FILTER (WHERE length(t) < 6) lt6,
               count(*) FILTER (WHERE t ~ '[。！？!?…～~]$') well_ended
        FROM replies GROUP BY 1 ORDER BY n DESC;
    """)
    # 只看最近 6 小时。这一行存在的理由很具体：3 天窗口里那 19.2% 绝大部分是
    # 修复上线**之前**的轮次（实机 2026-09-21 逐小时量过：修前每小时 9~11/11~13，
    # 修后连续几个小时 0），只报聚合数会让修好看起来没修好。
    deg_recent = rows(f"""
        SELECT count(*) n,
               count(*) FILTER (WHERE length(coalesce(m.blocks->0->>'text','')) < 6) lt6,
               count(*) FILTER (WHERE coalesce(m.blocks->0->>'text','') ~ '[。！？!?…～~]$') well_ended
        FROM companion_turn_runs r
        JOIN companion_messages m ON m.id = r.assistant_message_id
        WHERE r.status = 'succeeded' AND r.started_at > now() - interval '6 hours'
          {since_clause(since, 'r.started_at')};
    """)

    # §8.8 的门写着"真机 ≥100 轮"，而这个数**永远攒不满**：真人不在机器上就没有轮次，
    # 于是它实际上是把"我没用"读成了"没修好"。脚本轮对这一条是合法样本——它测的是
    # "管线在压力下还会不会吐三字的答句"，而脚本轮恰好专挑「哈哈」这种最短输入。
    # （真正必须剔除脚本轮的只有**措辞一致性**那两类：开场重复率与闲聊推进率——
    # 脚本输入固定，混进去会造出假的重复率。那两条照旧剔。）
    # 所以这里按"修复切分点之后"给一个能攒够的窗口，并把样本构成摊开写清楚。
    deg_gate = rows(f"""
        WITH replies AS (
          SELECT coalesce(m.blocks->0->>'text', '') AS t,
                 -- 登记在册的脚本轮 = 脚本；没登记但确实是脚本跑的，算真人（宁可高估真人）
                 (r.id::text = ANY(ARRAY[{",".join(f"'{v}'" for v in sorted(scripted)) or "''"}]::text[]))
                   AS scripted
          FROM companion_turn_runs r
          JOIN companion_messages m ON m.id = r.assistant_message_id
          WHERE r.status = 'succeeded' AND r.started_at > TIMESTAMPTZ '{VETO_SAMPLE_SINCE}'
        )
        SELECT count(*) n,
               count(*) FILTER (WHERE scripted) n_scripted,
               count(*) FILTER (WHERE NOT scripted) n_human,
               count(*) FILTER (WHERE length(t) < 6) lt6,
               count(*) FILTER (WHERE t ~ '[。！？!?…～~]$') well_ended
        FROM replies;
    """)

    # §8.8 的形状刻意是"数字组成的 dict"而不是 list[dict]：`--compare` 的 flat()
    # 只递归 dict、只收数值，塞列表进去这一项就永远进不了基线对照——而这正是它
    # 最该被对照的时候（修复有没有把比率拉下来）。没有样本的模型不进字典。
    veto_n: dict[str, int] = {}
    veto_lt6: dict[str, float] = {}
    veto_ended: dict[str, float] = {}
    for row in degeneration:
        model_n = int(num(row["n"]))
        if model_n <= 0:
            continue
        veto_n[str(row["model_id"])] = model_n
        veto_lt6[str(row["model_id"])] = round(num(row["lt6"]) / model_n, 3)
        veto_ended[str(row["model_id"])] = round(num(row["well_ended"]) / model_n, 3)
    veto_recent_n = int(num(deg_recent[0]["n"])) if deg_recent else 0
    veto_recent_lt6 = round(num(deg_recent[0]["lt6"]) / veto_recent_n, 3) if veto_recent_n else None
    veto_recent_ended = (round(num(deg_recent[0]["well_ended"]) / veto_recent_n, 3)
                         if veto_recent_n else None)

    gate_row = deg_gate[0] if deg_gate else {}
    gate_n = int(num(gate_row.get("n")))
    gate = {
        "since": VETO_SAMPLE_SINCE,
        "n": gate_n,
        "n_scripted": int(num(gate_row.get("n_scripted"))),
        "n_human": int(num(gate_row.get("n_human"))),
        "short_of_sample": max(0, VETO_GATE_MIN_SAMPLE - gate_n),
        "lt6_pct": round(num(gate_row.get("lt6")) / gate_n, 3) if gate_n else None,
        "ended_pct": round(num(gate_row.get("well_ended")) / gate_n, 3) if gate_n else None,
    }

    # 0246 起才有的数：**逐段合成结果**。上面的 voice 只能证明"服务端下发了几段"，
    # 这一段才回答"这些段到底出没出声"——失败是引擎挂了还是回合被取消，也分得开。
    #
    # `stage='synth'` 这个谓词**不能省**：0247 之后同一张表里还有客户端的播放结局行，
    # 两阶段的 duration_ms 不同义（一个是引擎往返，一个是"从发起取段到播完"），
    # 混在一起算的 p50 与 ok_ratio 都是假的。
    tts = rows(f"""
        SELECT coalesce(engine,'(unknown)') engine, count(*) n,
               count(*) FILTER (WHERE outcome='ok') ok,
               count(*) FILTER (WHERE outcome='failed') failed,
               count(*) FILTER (WHERE outcome='rejected') rejected,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) p50_ms,
               round(avg(bytes)/1024.0, 1) avg_kb
        FROM companion_tts_outcomes
        WHERE stage = 'synth' {since_clause(since, 'created_at')}
        GROUP BY 1 ORDER BY 1;
    """)
    tts_totals = rows(f"""
        SELECT count(*) n,
               count(*) FILTER (WHERE outcome='ok') ok,
               count(*) FILTER (WHERE outcome='failed') failed,
               count(*) FILTER (WHERE outcome='rejected') rejected
        FROM companion_tts_outcomes
        WHERE stage = 'synth' {since_clause(since, 'created_at')};
    """)

    # 0247：客户端那一半——字节给了它之后发生了什么。三个取值各有其位：
    # played 播完了、deadline 等到超时被跳过、synth_failed 取段这一步就没成。
    playback = rows(f"""
        SELECT coalesce(error_code,'(unknown)') reason, count(*) n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) p50_ms,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) p90_ms
        FROM companion_tts_outcomes
        WHERE stage = 'playback' {since_clause(since, 'created_at')}
        GROUP BY 1 ORDER BY 1;
    """)
    playback_totals = rows(f"""
        SELECT count(*) n,
               -- 播出率的分母**不含 dropped**：用户打断是正常行为，算进分母就等于
               -- 让"打字快慢"决定这条门过不过（刚加的 dropped 一定会踩到这个坑）。
               count(*) FILTER (WHERE error_code IS DISTINCT FROM 'dropped') n_gate,
               count(*) FILTER (WHERE outcome='ok') played,
               count(*) FILTER (WHERE error_code='dropped') dropped,
               count(*) FILTER (WHERE error_code='deadline') deadline,
               count(*) FILTER (WHERE error_code='synth_failed') synth_failed
        FROM companion_tts_outcomes
        WHERE stage = 'playback' {since_clause(since, 'created_at')};
    """)
    # 最锋利的那个数：**服务端把音频交出去了，客户端却一句没回**的段数。
    # 它不为 0 就是"没声音"里最难看的一类（不是慢，是根本没响），而它只能跨阶段比出来。
    silent_after_ok = int(scalar(f"""
        SELECT count(*)
        FROM companion_tts_outcomes s
        WHERE s.stage = 'synth' AND s.outcome = 'ok'
          {since_clause(since, 's.created_at')}
          -- 播放上报是 09-21 14:10（本机）才上线的能力，全库第一条 playback 行在 09:26 UTC。
          -- 不设这道界会把"那时结构上不可能有上报"的段算成"给了音频没响"——实测那样
          -- 多算出 1 段，正好是这个数的一半。
          AND s.created_at > TIMESTAMPTZ '{PLAYBACK_REPORTING_SINCE}'
          AND NOT EXISTS (
            SELECT 1 FROM companion_tts_outcomes p
            WHERE p.stage = 'playback' AND p.run_id = s.run_id AND p.segment_id = s.segment_id
          );
    """))
    # 同一个数再按"已知成因修好没有"切一刀。
    #
    # 为什么必须切：剩下那 4 段全是历史——1 段落在播放上报能力对本机生效之前，3 段是
    # 09-22 03:59 那次音频钟停住（§12.10 已把 `await host.play()` 封顶 + dropped 只报
    # 已到手的段 + 三条裸 return 补上报）。只报全时段，就等于让一个已经修好的病每天
    # 在报表上显示成现状——这正是 §12.11/§12.12 对失败率做过的事。
    silent_after_ok_since_fix = int(scalar(f"""
        SELECT count(*)
        FROM companion_tts_outcomes s
        WHERE s.stage = 'synth' AND s.outcome = 'ok'
          {since_clause(since, 's.created_at')}
          AND s.created_at > TIMESTAMPTZ '{AUDIO_SILENT_FIX_SINCE}'
          AND NOT EXISTS (
            SELECT 1 FROM companion_tts_outcomes p
            WHERE p.stage = 'playback' AND p.run_id = s.run_id AND p.segment_id = s.segment_id
          );
    """))

    tts_requested = int(scalar(f"""
        SELECT count(*) FROM companion_stream_events e
        WHERE e.type = 'voice.segment.ready' {since_clause(since, 'e.created_at')}
          AND e.created_at >= {VOICE_SEGMENT_HORIZON_SQL};
    """) or 0)

    # 首字延迟：run 开始 → 第一个 assistant.delta
    ttft = rows(f"""
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.created_at - r.started_at))*1000) p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.created_at - r.started_at))*1000) p90,
               count(*) n
        FROM companion_stream_events e JOIN companion_turn_runs r ON r.id = e.run_id
        WHERE e.type = 'assistant.delta' AND r.started_at IS NOT NULL
          {since_clause(since, 'e.created_at')};
    """)

    # 「主动投递」以前数的是 `companion_proactive_deliveries`——那张表**没有任何 INSERT**
    # （只有一个清理路径的 UPDATE、导出读、TTL 删），所以它恒 0，我拿着那个 0 说过
    # "主动投递 = 0"。真实的主动投递走 `assistant_deliveries`
    # （`payload_ref->>'systemEventId'` 以 `thought:` / `reminder:` / `run.completed:` 开头）。
    #
    # 两类分开数（方案 29 §9.61）：`thought:` 是她**自己想开口**（受按偏好的间隔管），
    # `reminder:` / `run.completed:` 是**用户先要过或正在等的**（不进频率）。
    # 混在一个数里就看不出"她话太少"还是"闹钟没响"——那是两个完全不同的故障。
    pro_rows = rows("""
        SELECT split_part(d.payload_ref->>'systemEventId', ':', 1) AS kind,
               coalesce(d.state, '-') AS state, count(*) AS n
        FROM assistant_deliveries d
        WHERE d.payload_ref->>'systemEventId' LIKE '%:%'
        GROUP BY 1, 2;
    """)

    def pro_stats(kinds: tuple[str, ...]) -> dict[str, int]:
        by_state = {r["state"]: int(r["n"]) for r in pro_rows if r["kind"] in kinds}
        return {
            "total": sum(by_state.values()),
            # 与 worker 的节奏判定同一口径：displayed（露过）/ acted（点过）/ dismissed（划走）。
            # 只数 displayed 会把点过的那条从分子里丢掉，两处口径一旦不同名就会互相打脸。
            "seen": sum(by_state.get(state, 0) for state in ("displayed", "acted", "dismissed")),
            "queued": by_state.get("queued", 0),
        }

    routine = pro_stats(("thought",))
    triggered = pro_stats(("reminder", "run.completed"))
    proactive = {
        # 念头气泡：已送达 = 进过展示通道；queued 是"写好了但还没被人看见"。
        "thought_deliveries": routine["total"],
        "thought_displayed": routine["seen"],
        "thought_queued": routine["queued"],
        # 触发式：用户约好的提醒 + 他正在等的学习完成回执。
        "triggered_deliveries": triggered["total"],
        "triggered_displayed": triggered["seen"],
        "triggered_queued": triggered["queued"],
        # 候选为什么没变成气泡：状态分布就是抑制的账（§8.3 要的就是这一眼）。
        "thought_status": {
            r["status"]: int(r["n"]) for r in rows(
                "SELECT status, count(*) n FROM assistant_thoughts GROUP BY 1;"
            )
        },
        "thoughts": int(scalar("SELECT count(*) FROM assistant_thoughts;") or 0),
        # 漏斗的后半段：送达≠被看见。`delivered` 只是"进了收件箱通道"，
        # 真正决定体感的是 opened；过期没打开的那几条，用户根本没遇到过。
        "thought_opened": int(scalar(
            "SELECT count(*) FROM assistant_thoughts WHERE opened_at IS NOT NULL;"
        ) or 0),
        "thought_expired_unopened": int(scalar("""
            SELECT count(*) FROM assistant_thoughts
            WHERE opened_at IS NULL AND expires_at IS NOT NULL AND expires_at < now();
        """) or 0),
        "thought_jobs_dead": int(scalar("""
            SELECT count(*) FROM jobs WHERE type='companion_thought' AND status='dead';
        """) or 0),
    }

    # ─── 系统视野问答：学习时长答对率（方案 §8.5）────────────────────────────
    #
    # §8.5 的判据是"答案与库内真值逐项可比对"，但**只有能从历史重算的那几项**才比得了：
    # `learning_metric_events` 是只增的事件流，所以"今天/本周学了多久"可以锚在提问那一刻
    # 重算（`occurred_at <= 提问时刻`）。活跃卡片数与笔记数是**当前状态**，没有历史切片——
    # 拿今天的卡片数去判昨天的答句，是在制造假证据，所以它们不进这条读数。
    #
    # 问句判据与 worker 侧**同一个形状**（companion-here-and-now.ts 的
    # VISION_LEARNING_QUESTION）：两边各写一份正则，一边改了另一边就会静默漏样本。
    vision_turns = rows(f"""
        WITH msgs AS (
          SELECT m.workspace_id, m.user_id, m.conversation_id, m.seq, m.created_at, m.role,
                 (SELECT string_agg(b->>'text', ' ')
                    FROM jsonb_array_elements(m.blocks) b WHERE b->>'type' = 'text') AS text
          FROM companion_messages m
          WHERE m.blocks IS NOT NULL AND jsonb_typeof(m.blocks) = 'array'
            {since_clause(since, 'm.created_at')}
        ),
        asked AS (
          SELECT * FROM msgs WHERE role = 'user' AND text ~ '{VISION_TIME_QUESTION}'
        )
        SELECT a.created_at AS asked_at, a.text AS question, a.user_id, a.workspace_id,
               (SELECT string_agg(b->>'text', ' ')
                  FROM companion_messages r, jsonb_array_elements(r.blocks) b
                 WHERE r.conversation_id = a.conversation_id AND r.seq > a.seq
                   AND r.role = 'assistant' AND jsonb_typeof(r.blocks) = 'array'
                   AND b->>'type' = 'text'
                 GROUP BY r.seq ORDER BY r.seq LIMIT 1) AS answer,
               tz.zone AS tz,
               (SELECT coalesce(sum(e.active_seconds_used), 0) FROM learning_metric_events e
                 WHERE e.workspace_id = a.workspace_id AND e.user_id = a.user_id
                   AND e.occurred_at <= a.created_at
                   AND e.occurred_at >= date_trunc('day', a.created_at AT TIME ZONE tz.zone) AT TIME ZONE tz.zone
               ) AS today_seconds,
               (SELECT coalesce(sum(e.active_seconds_used), 0) FROM learning_metric_events e
                 WHERE e.workspace_id = a.workspace_id AND e.user_id = a.user_id
                   AND e.occurred_at <= a.created_at
                   AND e.occurred_at > a.created_at - interval '7 days'
               ) AS week_seconds
        FROM asked a
        LEFT JOIN LATERAL (
          SELECT coalesce(
            (SELECT s.quiet_hours->>'timezone' FROM user_companion_account_state s
              WHERE s.user_id = a.user_id LIMIT 1),
            'Asia/Shanghai') AS zone
        ) tz ON true
        ORDER BY a.created_at DESC;
    """)
    vision = summarize_vision_answers(vision_turns, split_at=VISION_TRUTH_FIX_SINCE)

    # 富输出块的**供给量**（方案 29 §4.8 / §9.48）。这一行存在的理由很具体：
    # `card` 块在库里恒 0 行持续了六周，而报表上没有任何一处会因为它为 0 而说话——
    # 真实原因是 `companion_open_card` 连错了键（`review_schedules.subject_id` 存的是
    # objectiveId），不是"没人要卡片"。零供给的两种成因必须摆到同一行上看。
    block_kinds = rows(f"""
        SELECT coalesce(b->>'type', '(null)') AS kind, count(*) n
        FROM companion_messages m, jsonb_array_elements(m.blocks) b
        WHERE m.role = 'assistant' AND jsonb_typeof(m.blocks) = 'array'
          {since_clause(since, 'm.created_at')}
        GROUP BY 1 ORDER BY 2 DESC;
    """)

    # 同一窗口里**每个块型的生产端工具成功过几个 run**（§13 D1）。
    # 加这一侧的理由：原来那条 ⚠ 写着"生产端都接在线上，所以不是需求少，是链没走到"，
    # 而按 run 对齐一量就知道它对 nav 是错的——现 regime 里 4 次产 nav 的工具成功
    # 对应 4 个 nav 块，一个都没丢；少，是因为**这窗口里她只被给了 4 次那种场景**。
    # 真正该由这条抓的是"工具成功了却没有块"（card 那六周就是这个形状）。
    producer_since = since_clause(since, "created_at")

    # **两侧必须同一口径**：脚本轮的消息已经被清掉（§14.9 的清理），但它们的
    # `companion_agent_tool_calls` 还在——只按工具那侧计数，就会造出
    # "生产端成功过、块却是 0"的假警报（实测：清理后立刻出现 diagram 0/1产、
    # card 0/2产 两条 ⚠，而被点名的 run 正是被清掉的那些脚本轮）。
    # 脚本轮的判据用两条并集：登记表（老口径）+ `user_message_id IS NULL`（清理后的事实）。
    scripted_runs_sql = (
        "run_id NOT IN (SELECT id FROM companion_turn_runs WHERE user_message_id IS NULL)"
        + scripted_exclusion("run_id", scripted)
    )

    def producer_branch(kind: str, names: str) -> str:
        listed = ", ".join(f"'{name}'" for name in names)
        return f"""
              SELECT '{kind}' kind, count(DISTINCT run_id) n,
                     left(string_agg(to_char(created_at,'MM-DD HH24:MI')||' run:'
                                     ||left(run_id::text, 8), ' ' ORDER BY created_at), 70) runs
                FROM companion_agent_tool_calls
               WHERE status = 'succeeded' AND name IN ({listed}) {producer_since}
                 AND {scripted_runs_sql}
        """

    producer_rows = rows(f"""
        SELECT * FROM ({
            " UNION ALL ".join([
                producer_branch("nav", ["companion_open_card", "companion_open_page",
                                        "companion_open_note", "companion_focus_graph",
                                        "companion_list_task_queue"]),
                producer_branch("card", ["companion_open_card"]),
                producer_branch("quote", ["companion_read_note", "companion_search_notes"]),
                producer_branch("image", ["companion_show_image"]),
                producer_branch("diagram", ["companion_render_diagram"]),
            ])
        }) producers;
    """)
    block_producers = {r["kind"]: int(r["n"]) for r in producer_rows}
    # 把是**哪几个 run** 一起带出来：告警要能被当场核对，而不是让人去猜。
    # 实机就有一个边界样本——09-22 01:05 那次 task_queue 成功却没 nav 块，因为
    # 给它加 route 的那一笔在 3 分钟后才上线；看见 run 时刻就知道不是链断了。
    producer_runs = {r["kind"]: r["runs"] for r in producer_rows}

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "since": since,
        "corpus_window": scalar("""
            SELECT to_char(min(created_at),'YYYY-MM-DD')||' ~ '||to_char(max(created_at),'YYYY-MM-DD')
            FROM companion_turn_runs;
        """),
        "runs": {
            "total": run_total,
            "by_status": by_status,
            "by_mode": {m["k"]: {"n": int(m["n"]), "max_steps": int(m["max_steps"]),
                                 "zero_tool": int(m["zero_tool"])} for m in modes},
            "zero_tool_ratio": round(zero_tool / mem_runs_total, 3) if mem_runs_total else 0,
            # 只算**有权限档**的行。`permission_level` 为空的那批是 0239 删除技能层之前
            # 的历史行——那时"这一轮有没有工具"取决于命中哪个技能（基线 90.7% 天生为 0），
            # 混进来这条数就永远降不下来，也不指向现在的系统。
            "zero_tool_ratio_current": (
                round(sum(int(m["zero_tool"]) for m in modes if m["k"] != "(unset)")
                      / sum(int(m["n"]) for m in modes if m["k"] != "(unset)"), 3)
                if sum(int(m["n"]) for m in modes if m["k"] != "(unset)") else 0),
            "unset_permission_rows": sum(int(m["n"]) for m in modes if m["k"] == "(unset)"),
            "interrupted": {i["status"]: int(i["n"]) for i in interrupts},
            "failure_split": {s["acct"]: {"runs": int(s["runs"]), "failed": int(s["failed"])}
                              for s in failure_split},
            "failure_ratio": round(sum(by_status.get(k, 0) for k in ("failed",)) / run_total, 3) if run_total else 0,
            "failure_codes": {f["k"]: int(f["n"]) for f in failures},
            # 每条错误码带上"像不像测试夹具"：跨多个工作区、挤在两三分钟内 = 夹具签名。
            "failure_detail": {
                f["k"]: {
                    "n": int(f["n"]),
                    "workspaces": int(f["distinct_ws"]),
                    "span_minutes": int(f["span_min"]),
                    "fixture_shaped": int(f["n"]) >= 3 and int(f["distinct_ws"]) >= 3
                    and int(f["span_min"]) <= 2,
                }
                for f in failures
            },
        },
        "reply_shape": {
            "length_buckets": {b["bucket"]: {"n": int(b["n"]), "mean": num(b["mean"]),
                                             "p10": num(b["p10"]), "p50": num(b["p50"]),
                                             "p90": num(b["p90"]),
                                             "degenerate_lt4": int(b["degenerate"])} for b in lengths},
            "advance_rate": round(advance / seen, 3) if seen else 0,
            # 分档的推进率（同一份 800 条样本，只是分母换成"这一档的答句数"）。
            # 登记表里有多少条脚本轮被剔出形态指标（0 = 这份库没跑过脚本，或没登记）。
            "scripted_runs_excluded": len(scripted),
            "advance_chat_n": by_class["chat"][0],
            "advance_chat_rate": (round(by_class["chat"][1] / by_class["chat"][0], 3)
                                  if by_class["chat"][0] else 0),
            "block_kinds": {r["kind"]: int(r["n"]) for r in block_kinds},
            "block_producers": block_producers,
            "producer_runs": producer_runs,
            "advance_tool_n": by_class["tool"][0],
            "advance_tool_rate": (round(by_class["tool"][1] / by_class["tool"][0], 3)
                                  if by_class["tool"][0] else 0),
            # JOIN 不上 run 的答句（主动念头那一类），两个分母都不进，只报个数。
            "advance_no_run_n": no_run,
            "echo_rate": round(echo / seen, 3) if seen else 0,
            "opener_repeat_rate": round(opener_repeat / seen, 3) if seen else 0,
            "sampled_replies": seen,
            "veto": {
                "n_by_model": veto_n,
                "lt6_pct_by_model": veto_lt6,
                "ended_pct_by_model": veto_ended,
                "recent_n": veto_recent_n,
                "recent_lt6_pct": veto_recent_lt6,
                "recent_ended_pct": veto_recent_ended,
                "gate": gate,
            },
        },
        "memory": {
            "runs_with_retrieval_hit": mem_hit,
            "retrieval_hit_ratio": round(mem_hit / mem_runs_total, 3) if mem_runs_total else 0,
            "written_by_extraction": mem_extract_written,
            "live_rows": mem_live,
            "candidate_rows": mem_candidates,
            "candidate_oldest_days": mem_candidate_oldest_days,
            "candidate_ripe_for_cooling_off": mem_candidates_ripe,
            "extract_jobs": {j["k"]: int(j["n"]) for j in extract_jobs},
        },
        "voice": {
            "succeeded_runs": int(num(voice[0]["n"])) if voice else 0,
            "runs_with_text_but_zero_segments": int(num(voice[0]["zero_voice"])) if voice else 0,
            "zero_voice_span": f"{voice[0].get('zero_voice_from') or '-'}~{voice[0].get('zero_voice_to') or '-'}" if voice else "-",
            "zero_voice_in_horizon": int(num(voice[0]["zero_voice_in_horizon"])) if voice else 0,
            "runs_in_horizon": int(num(voice[0]["in_horizon"])) if voice else 0,
            "avg_segments": num(voice[0]["avg_segs"]) if voice else 0,
            "avg_segments_in_horizon": num(voice[0]["avg_segs_in_horizon"]) if voice else 0,
            # 逐段合成结果（0246）。requested 是"下发了几段"，attempts 是"客户端来取过几次"，
            # 两者的差就是**根本没来取**的段数——那是另一类没声音。
            "tts": {
                "segments_emitted": tts_requested,
                "attempts": int(num(tts_totals[0]["n"])) if tts_totals else 0,
                # 取段覆盖率：下发了 N 段，客户端真来取了几段。
                # 这是"没声音"的第一道分流：比率低=根本没来取（客户端那侧），
                # 比率高但 ok 低=来了取但引擎失败（服务端/供应商那侧）。
                "fetch_ratio": (round(int(num(tts_totals[0]["n"])) / tts_requested, 3)
                                if tts_totals and tts_requested > 0 else None),
                "ok": int(num(tts_totals[0]["ok"])) if tts_totals else 0,
                "failed": int(num(tts_totals[0]["failed"])) if tts_totals else 0,
                "rejected": int(num(tts_totals[0]["rejected"])) if tts_totals else 0,
                "ok_ratio": (round(num(tts_totals[0]["ok"]) / num(tts_totals[0]["n"]), 3)
                             if tts_totals and num(tts_totals[0]["n"]) > 0 else None),
                "by_engine": [
                    {"engine": r["engine"], "n": int(num(r["n"])), "ok": int(num(r["ok"])),
                     "failed": int(num(r["failed"])), "p50_ms": round(num(r["p50_ms"])),
                     "avg_kb": num(r["avg_kb"])}
                    for r in tts
                ],
                # 0247 客户端那一半。played_ratio 的分母是"客户端回报过的段数"，
                # 不是下发段数——应用没开的时候根本不会有回报，那类缺口看
                # fetch_ratio 与 silent_after_bytes_delivered。
                "playback": {
                    "reported": int(num(playback_totals[0]["n"])) if playback_totals else 0,
                    "n_gate": int(num(playback_totals[0]["n_gate"])) if playback_totals else 0,
                    "dropped": int(num(playback_totals[0]["dropped"])) if playback_totals else 0,
                    "played": int(num(playback_totals[0]["played"])) if playback_totals else 0,
                    "deadline": int(num(playback_totals[0]["deadline"])) if playback_totals else 0,
                    "synth_failed": int(num(playback_totals[0]["synth_failed"])) if playback_totals else 0,
                    "played_ratio": (round(num(playback_totals[0]["played"]) / num(playback_totals[0]["n_gate"]), 3)
                                     if playback_totals and num(playback_totals[0]["n_gate"]) > 0 else None),
                    "by_reason": [
                        {"reason": r["reason"], "n": int(num(r["n"])),
                         "p50_ms": round(num(r["p50_ms"])), "p90_ms": round(num(r["p90_ms"]))}
                        for r in playback
                    ],
                    # 音频字节已经交出去、客户端却一句没回的段数（"没响"最难看的一类）。
                    "bytes_delivered_but_silent": silent_after_ok,
                    "bytes_delivered_but_silent_since_fix": silent_after_ok_since_fix,
                },
            },
        },
        "ttft_ms": {
            "p50": round(num(ttft[0]["p50"])) if ttft else 0,
            "p90": round(num(ttft[0]["p90"])) if ttft else 0,
            "delta_events": int(num(ttft[0]["n"])) if ttft else 0,
        },
        "proactive": proactive,
        "vision": vision,
    }


# ─── 呈现 ──────────────────────────────────────────────────────────────────

def render(metrics: dict) -> None:
    runs, shape, mem, voice, ttft, pro = (metrics["runs"], metrics["reply_shape"],
                                          metrics["memory"], metrics["voice"],
                                          metrics["ttft_ms"], metrics["proactive"])

    # 比例类指标一旦越过 1，一定是分子分母不同源（真实踩过：命中轮占比 105.7%）。
    # 这里**不夹紧**——夹住了就会把口径错误藏成看起来合理的数。
    broken = [name for name, value in {
        "零工具轮占比": runs["zero_tool_ratio"],
        "失败率": runs["failure_ratio"],
        "推进率": shape["advance_rate"],
        "推进率·闲聊": shape["advance_chat_rate"],
        "推进率·工具轮": shape["advance_tool_rate"],
        # 按模型的比率要摊开成一项一个名字：直接塞 dict 进去，
        # `not 0 <= value <= 1` 会拿 dict 去比大小（实机 TypeError）。
        **{f"退化率·{model}": value
           for model, value in shape["veto"]["lt6_pct_by_model"].items()},
        **{f"句末标点率·{model}": value
           for model, value in shape["veto"]["ended_pct_by_model"].items()},
        "回声率": shape["echo_rate"],
        "检索命中轮占比": mem["retrieval_hit_ratio"],
    }.items() if not 0 <= value <= 1]
    if broken:
        print(f"!! 口径异常，以下比例越过 [0,1]，分子分母不同源：{broken}")

    print(f"\n{'='*66}\n伴星质量指标  语料窗口={metrics.get('corpus_window') or '全部'}"
          f"  过滤 since={metrics['since'] or '无'}  runs={runs['total']}\n{'='*66}")

    print("\n【能力是否被给到】方案 RC1 的直接读数")
    for mode, stat in runs["by_mode"].items():
        print(f"  权限档={mode:<12} n={stat['n']:<4} 最大步数={stat['max_steps']} 零工具={stat['zero_tool']}")
    # 这条**不再挂目标值**。原目标"<10%"在 §9.12 已经作废：工具面每轮都给之后，
    # "她这一轮调没调工具"取决于问题需不需要调，拿它当 KPI 只会反向逼系统做无用调用。
    # 留着是因为它仍是一个形态读数（她是不是几乎什么都不查），但要看现 regime 的那一条。
    print(f"  零工具轮占比 = {runs['zero_tool_ratio_current']:.1%}"
          f"（现 regime，已排除权限档为空的 {runs['unset_permission_rows']} 条历史行）"
          f"  全时段含历史 = {runs['zero_tool_ratio']:.1%}")
    print(f"  失败率 = {runs['failure_ratio']:.1%}  原因 = {runs['failure_codes']}")
    print(f"  用户打断 = {runs['interrupted'].get('cancelled', 0)} 取消"
          f" + {runs['interrupted'].get('superseded', 0)} 被新一轮取代"
          "   ← 不是失败，所以不进上面的分母；它自己是一条有用的形态读数")
    split = runs["failure_split"]
    for acct, label in (("real", "真人账号"), ("fixture", "夹具账号")):
        stat = split.get(acct)
        if not stat or stat["runs"] == 0:
            continue
        print(f"    {label} {stat['failed']}/{stat['runs']}"
              f" = {stat['failed'] / stat['runs']:.1%}"
              + ("   ← 产品在线的失败率看这一条" if acct == "real" else
                 "   ← 集成测试现造的没签同意书的工作区，不该混进上面那条"))
    for code, detail in runs["failure_detail"].items():
        if detail["fixture_shaped"]:
            print(f"  ⚠ {code} 这 {detail['n']} 条来自 {detail['workspaces']} 个工作区、"
                  f"挤在 {detail['span_minutes']} 分钟内 —— 是集成测试夹具的签名，"
                  f"不是产品在线失败。看上面的失败率时把它扣掉。")

    print("\n【回答形态】方案 #1 / #11")
    for bucket, stat in shape["length_buckets"].items():
        print(f"  {bucket:<12} n={stat['n']:<4} 均值={stat['mean']:<6} p10/p50/p90="
              f"{stat['p10']:.0f}/{stat['p50']:.0f}/{stat['p90']:.0f}  退化(<4字)={stat['degenerate_lt4']}")
    # 目标 >60% 只对着**闲聊那一档**说。合起来的数会随"这周我跑了多少脚本轮"上下浮动，
    # 把它当退化来读就是我第二次掉进同一类陷阱（第一次是取段覆盖率）。
    if shape.get("scripted_runs_excluded"):
        print(f"  （形态指标已剔除评测脚本轮 {shape['scripted_runs_excluded']} 条登记 id，"
              f"理由见脚本头部注释：脚本输入固定、开场白高度雷同，混进来会造出假的重复率）")
    print(f"  推进率 闲聊轮 = {shape['advance_chat_rate']:.1%} (n={shape['advance_chat_n']})"
          f"   ← 只当形态读数：>60% 那条目标 2026-09-22 作废，理由见下一行")
    print("    （逐条看过「没推进」的闲聊样本：「嘿嘿嘿」→「嗯，我在。」、「你在哪？」→「我一直在这儿呀。」、"
          "「今天天气你知道吗」→「我这边看不到天气」——这些**不该被推高**；"
          "把这条当 KPI 就是逼她在用户让她停下的时候追加一句反问，与 §9.12 作废「零工具率」同一条理由。）")
    print(f"  推进率 工具轮 = {shape['advance_tool_rate']:.1%} (n={shape['advance_tool_n']})"
          f"   合起来 = {shape['advance_rate']:.1%}"
          + (f"   （另有 {shape['advance_no_run_n']} 条不属于任何回合的答句，两边都不计）"
             if shape.get("advance_no_run_n") else ""))
    # 这两个数**不是独立的**：一条只有三个字的退化回复里不可能带问句，所以下面
    # 「一票否决」那档的不足 6 字比例越高，闲聊推进率就越低。
    # 2026-09-21 我就绕了这一圈：闲聊 31.5% 的那天，正是退化轮占满的那天。
    print("  （闲聊推进率与下面的退化率同源：三字的退化答句里不会有问句。"
          "退化没归零前，不要去动推进率那条 prompt 规则。）")
    print(f"  回声率(照抄用户那句) = {shape['echo_rate']:.1%}   开场重复率 = {shape['opener_repeat_rate']:.1%}")
    kinds = shape["block_kinds"]
    producers = shape["block_producers"]
    print("  富输出块供给 = " + "   ".join(
        f"{k} {kinds.get(k, 0)}/{producers.get(k, 0)}产" for k in ("nav", "quote", "diagram", "card", "image"))
        + f"   （块数/同窗内生产端工具成功的 run 数；text {kinds.get('text', 0)} 不计）")
    # 只有"生产端成功过、块却是 0"才是链断了（card 那六周正是这个形状，§9.48）。
    # 两侧都为 0 不是缺陷，是这一窗口里没有那种场景——不要替它编一个原因。
    broken = [k for k in ("nav", "quote", "diagram", "card", "image")
              if producers.get(k, 0) > 0 and not kinds.get(k)]
    absent = [k for k in ("nav", "quote", "diagram", "card", "image")
              if not kinds.get(k) and producers.get(k, 0) == 0]
    if broken:
        for kind in broken:
            print(f"  ⚠ {kind}：生产端成功 {producers[kind]} 个 run，块却是 0 —— 查工具的键与返回"
                  f"（run: {shape['producer_runs'].get(kind) or '-'}；card 那六周就是这个形状，见 §9.48）")
    if absent:
        print(f"    （{'、'.join(absent)} 这一窗口两侧都是 0：没有一次生产端调用，不是链断了）")

    # §8.8 一票否决：不足 6 字 <10%，且以句末标点收尾 >85%。
    veto = shape["veto"]
    for model, n in veto["n_by_model"].items():
        lt6 = veto["lt6_pct_by_model"].get(model)
        ended = veto["ended_pct_by_model"].get(model)
        print(f"  一票否决·窗口内 {model:<16} n={n:<5}"
              f" 不足6字={lt6:.1%} {'✓' if lt6 < 0.10 else '✗'}"
              f"  句末标点={ended:.1%} {'✓' if ended > 0.85 else '✗'}")
    if veto["recent_n"]:
        print(f"  一票否决·近6小时{' '*11} n={veto['recent_n']:<5}"
              f" 不足6字={veto['recent_lt6_pct']:.1%}"
              f"  句末标点={veto['recent_ended_pct']:.1%}")
        print("  ⚠ 两个数不一致时看**近 6 小时**：聚合窗口里留着修复上线之前的轮次，"
              "它只会滞后——既不说谎，也不会表扬刚修好的东西。")
    else:
        print("  一票否决·近6小时：窗口内没有成功轮次（应用没开 + 没跑脚本轮）")

    # 这一行才是 §8.8 那条门的正式读数：切分点之后、样本构成摊开、够不够 100 轮直说。
    gate = veto["gate"]
    if gate["n"]:
        print(f"  一票否决·切分点后 {gate['since'][:16]}  n={gate['n']}"
              f"（真人 {gate['n_human']} / 脚本 {gate['n_scripted']}）"
              f" 不足6字={gate['lt6_pct']:.1%} {'✓' if gate['lt6_pct'] < 0.10 else '✗'}"
              f"  句末标点={gate['ended_pct']:.1%} {'✓' if gate['ended_pct'] > 0.85 else '✗'}")
        if gate["short_of_sample"]:
            print(f"  ⚠ 距 §8.8 要求的 {VETO_GATE_MIN_SAMPLE} 轮还差 {gate['short_of_sample']} 轮"
                  f"——这一条是样本量不足，不是没修好；脚本轮算在这一条里（理由见 SQL 上方注释）。")
    else:
        print(f"  一票否决·切分点后 {gate['since'][:16]}：窗口内零轮次")

    print("\n【记忆】方案 RC3：读侧命中 / 写侧产出")
    print(f"  检索命中轮占比 = {mem['retrieval_hit_ratio']:.1%}")
    print(f"  抽取写入行数 = {mem['written_by_extraction']}   ← 0 即写路径全断")
    print(f"  活行 = {mem['live_rows']}  待过目（候选，设计上不自动写活）= {mem['candidate_rows']}"
          f"，最久已等 {mem['candidate_oldest_days']} 天"
          f"（其中满 3 天会被 0256 自动落库的 = {mem['candidate_ripe_for_cooling_off']}）"
          f"  抽取 job = {mem['extract_jobs']}")

    print("\n【语音】方案 #4")
    print(f"  成功轮 = {voice['succeeded_runs']}  有正文却零语音段 = "
          f"{voice['zero_voice_in_horizon']}（段事件地平线内，n={voice['runs_in_horizon']}）"
          f" / {voice['runs_with_text_but_zero_segments']}（全时段）")
    # 全时段那个数**不是**"管线还没上线"，也不是"历史就是坏的"——是 `companion_stream_events`
    # 的 TTL 把证据删了。真相是"历史读不出来"，所以现状只能读地平线内那一半。
    print(f"    平均段数 = {voice['avg_segments_in_horizon']}（地平线内） / {voice['avg_segments']}（全时段）"
          f"   ← 全时段那一半含 {voice['zero_voice_span']} 这些**段事件已被 TTL 清掉**的轮次，"
          "它们的 seg=0 是证据没了，不是没下发")
    tts = voice["tts"]
    playback = tts["playback"]
    if tts["attempts"] == 0:
        print("  TTS 逐段结果 = 0 行（0246 之后还没有跑过语音回合，或客户端没来取段）")
    else:
        print(f"  TTS 逐段结果 = {tts['attempts']} 次取段：ok {tts['ok']} / failed {tts['failed']}"
              f" / rejected {tts['rejected']}   合成完整率 = {tts['ok_ratio']}")
        print(f"  取段覆盖率 = {tts['fetch_ratio']}"
              f"（下发 {tts['segments_emitted']} 段 / 被取 {tts['attempts']} 次）")
        # 这个比率**不能**直接当"客户端坏了"的证据：分子要求当时有客户端在线。
        # 实机 2026-09-21 我就差点据此误判——那 148 段里大部分是脚本在桌面端
        # 关着的时候打的（CDP 端口拒绝连接可证），"没人来取"≠"客户端有 bug"。
        print("  ⚠ 只有在桌面端在线时这个比率才有意义；脚本轮次（应用没开）会把分子压成 0。"
              "要用它定位静音，请只看应用开着的那段时间窗（--since/--until）。")
        for row in tts["by_engine"]:
            print(f"    {row['engine']:<9} n={row['n']:<5} ok={row['ok']:<5} failed={row['failed']:<4}"
                  f" p50={row['p50_ms']}ms  avg={row['avg_kb']}KB")

    # 0247 客户端那一半：字节交出去之后发生了什么。它与 attempts 是否为 0 无关，
    # 所以单独一段，不嵌在上面的分支里。
    if playback["reported"] == 0:
        print("  播放上报 = 0 条   ← 应用没在线时必然如此；这一半只在桌面端跑起来时才有数")
    else:
        print(f"  播放上报 = {playback['reported']} 段：播完 {playback['played']}"
              f" / 等到超时 {playback['deadline']} / 取段失败 {playback['synth_failed']}"
              f"   播出率 = {playback['played_ratio']}")
        if playback.get("dropped"):
            print(f"  ⚠ 另有 {playback['dropped']} 段字节到手却没播（dropped）："
                  "不计进上面的播出率，但它们就是「给了音频没响」的那类证据。")
        for r in playback["by_reason"]:
            print(f"    {r['reason']:<14} n={r['n']:<4} p50={r['p50_ms']}ms p90={r['p90_ms']}ms")
    print(f"  音频已交付却零上报 = {playback['bytes_delivered_but_silent']} 段（全时段）"
          f" / {playback['bytes_delivered_but_silent_since_fix']} 段（切分点后 09-22 12:40 本机）"
          "   ← 不为 0 就是「给了音频但根本没响」，与「慢」「引擎失败」是三种不同的病；"
          "看现状读**切分点后**那一半")

    # 系统视野（方案 §8.5）。这条以前只在某一次真机批次里手工逐项比对过，
    # 所以"≥95%"在报表上没有落脚点；现在它是每次跑报表都会重算的读数。
    vision = metrics["vision"]
    print("\n【系统视野问答】方案 §8.5")
    if vision["compared"] == 0:
        print(f"  学习时长答对率 = 无可比对项（窗口内问句 {vision['turns']} 条，"
              f"其中 {vision['answers_without_number']} 条她没报数字）"
              "   ← 这一档要等真机问句攒出来，不是没修好")
    else:
        print(f"  学习时长答对率（§8.5 里唯一能从历史重算的一项）= {vision['accuracy']:.1%}（全时段 "
              f"{vision['matched']}/{vision['compared']} 项，容差 ±{vision['tolerance_minutes']} 分钟）"
              f"   问句 {vision['turns']} 条 / 没报数字 {vision['answers_without_number']} 条")
        if vision.get("since_fix") and vision["since_fix"]["compared"]:
            fixed = vision["since_fix"]
            print(f"    切分点后（09-21 08:25 本机，§9.24 修复上线）= {fixed['accuracy']:.1%}"
                  f"（{fixed['matched']}/{fixed['compared']} 项）"
                  "   ← 现状读这一条；全时段那半留着那 4 条修好之前的错答")
        for item in vision["mismatches"]:
            print(f"    ✗ {item['asked_at']} 问「{item['question']}」"
                  f"→ 真值 {item['label']}={item['truth']} 分钟，她报 {item['said']}")

    print("\n【时延 / 主动性】方案 #8 #9")
    print(f"  首字 p50={ttft['p50']}ms p90={ttft['p90']}ms")
    # 数字来源换了表（见 metrics 里的注释）：以前这个位置打的是
    # `companion_proactive_deliveries` 的行数，而那张表没人写，所以它永远是 0，
    # 我拿 0 当过结论。现在打的是真链路，并把"为什么 16 个候选只出去 3 条"摊开。
    print(f"  念头气泡：送达 {pro['thought_deliveries']}（被看见过 {pro['thought_displayed']}"
          f" / 排队待展示 {pro['thought_queued']}）  死掉的念头 job = {pro['thought_jobs_dead']}")
    # 触发式（用户约好的提醒 + 他正在等的学习完成回执）单独一行：它不进频率闸，
    # 所以"这一类一条都没送达"和"送达了但没人看见"是两种不同的坏，混在念头那一行里看不出来。
    print(f"  触发式推送：送达 {pro['triggered_deliveries']}（被看见过 {pro['triggered_displayed']}"
          f" / 排队待展示 {pro['triggered_queued']}）  ← 到点提醒与运行完成回执，不受频率管")
    # 漏斗只给绝对数：n=3 的时候算百分比是演戏（这条会话里已经退掉过两个这类指标）。
    print(f"  念头漏斗：候选 {pro['thought_status'].get('candidate', 0)} → 送达 {pro['thought_status'].get('delivered', 0)}"
          f" → 被打开 {pro['thought_opened']}（过期没人看 {pro['thought_expired_unopened']}）"
          "   ← 送达不等于被看见；应用没开时这一档必然全 0")
    print(f"  念头状态分布 = {pro['thought_status']}"
          "   ← candidate 堆着不动就是抑制在起作用（间隔/熟悉度/去重/静默时段）")


def compare(current: dict, baseline: dict) -> None:
    def flat(node, prefix=""):
        out = {}
        for key, value in node.items():
            path = f"{prefix}{key}"
            if isinstance(value, dict):
                out.update(flat(value, path + "."))
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                out[path] = value
        return out

    before, after = flat(baseline), flat(current)
    # 这些键**跨时间不可比**，delta 表里一律不出现：
    # `voice.runs_with_text_but_zero_segments` 数的是"段事件还在的轮次里 seg=0 有几条"，
    # 而事件有 TTL——同一条历史在 09-20 读是 0、在 09-22 读是 363，涨的是"证据过期"，
    # 不是"她哑了"。把它放进 delta 表，下一个人一定会把它读成回归。
    # 同一个 TTL 也压着平均段数：分母里那些轮的段事件被清掉了，段数自然是 0。
    incomparable = {
        "voice.runs_with_text_but_zero_segments",
        "voice.avg_segments",
    }
    interesting = [k for k in after
                   if k in before and before[k] != after[k] and k not in incomparable]
    print(f"\n{'='*66}\n与基线对照（基线 since={baseline.get('since') or '全部'}）\n{'='*66}")
    width = max((len(k) for k in interesting), default=10)
    for key in sorted(interesting):
        old, new = before[key], after[key]
        arrow = "↑" if new > old else "↓"
        print(f"  {key:<{width}}  {old}  →  {new}  {arrow}")
    if not interesting:
        print("  无差异")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None, help="只统计该时刻之后的数据，如 2026-09-20")
    parser.add_argument("--json", dest="json_out", default=None, help="把指标写成 JSON 供之后对照")
    parser.add_argument("--compare", default=None, help="与一份先前写出的 JSON 对照")
    args = parser.parse_args()

    metrics = collect(args.since)
    render(metrics)

    if args.compare:
        with open(args.compare, encoding="utf-8") as handle:
            compare(metrics, json.load(handle))

    if args.json_out:
        import os
        os.makedirs(os.path.dirname(args.json_out) or ".", exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(metrics, handle, ensure_ascii=False, indent=1)
        print(f"\n指标已写出：{args.json_out}")


if __name__ == "__main__":
    sys.exit(main())
