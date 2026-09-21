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
  * 语音完整性按 run 聚合 `voice.segment.ready` 事件数；**没有 TTS 结果表可读**
    （companion_voice_artifacts 只有 ASR 列且 0 行），所以这里测的是「有没有下发段」，
    测不到「客户端有没有播出来」——那一段的可观测性缺口记在方案 §4.9。
"""
from __future__ import annotations

import argparse
import base64
import csv
import io
import json
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

def collect(since: str | None) -> dict:
    where = since_clause(since, "created_at")

    runs = rows(f"""
        SELECT coalesce(status,'-') k, count(*) n FROM companion_turn_runs
        WHERE true {where.replace('created_at', 'created_at')}
        GROUP BY 1 ORDER BY 2 DESC;
    """)
    run_total = sum(int(r["n"]) for r in runs)
    by_status = {r["k"]: int(r["n"]) for r in runs}

    modes = rows(f"""
        SELECT coalesce(nullif(agent_mode,''),'(unset)') k, count(*) n,
               max(step_count) max_steps,
               count(*) FILTER (WHERE tool_call_count = 0) zero_tool
        FROM companion_turn_runs WHERE true {where} GROUP BY 1 ORDER BY 2 DESC;
    """)
    zero_tool = sum(int(m["zero_tool"]) for m in modes)

    failures = rows(f"""
        SELECT coalesce(nullif(error_code,''),'(no code)') k, count(*) n
        FROM companion_turn_runs
        WHERE status IN ('failed','cancelled','superseded') {where} GROUP BY 1 ORDER BY 2 DESC;
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
    bodies_raw = rows(f"""
        SELECT role, encode(convert_to(coalesce(blocks->0->>'text',''), 'UTF8'), 'base64') body
        FROM companion_messages WHERE true {since_clause(since, 'created_at')}
          AND role IN ('user','assistant')
        ORDER BY conversation_id, seq DESC LIMIT 800;
    """)
    bodies = [{"role": r["role"],
               "body": base64.b64decode(r["body"]).decode("utf-8", "replace")} for r in bodies_raw]
    advance = echo = opener_repeat = seen = 0
    prev_user = prev_opener = None
    for row in reversed(bodies):  # 上面按 seq DESC 取的是「最近的尾巴」，翻回转正序
        body = (row["body"] or "").strip()
        if row["role"] == "user":
            prev_user = body
            continue
        if not body:
            continue
        seen += 1
        if any(mark in body for mark in ("？", "?", "要不要", "想不想", "试试", "吗？", "呢？")):
            advance += 1
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
    mem_candidates = int(scalar("""
        SELECT count(*) FROM assistant_memory_items
        WHERE candidate = true AND deleted_at IS NULL;
    """) or 0)
    extract_jobs = rows("""
        SELECT status k, count(*) n FROM jobs WHERE type='companion_memory_extract'
        GROUP BY 1 ORDER BY 2 DESC;
    """)

    # 语音：有正文却零段的 run
    #
    # **必须带时间边界读这个数**（踩过）。实测分界是 **2026-09-19 11:00**：
    #   02:00–10:00 共 106 轮，零段 = 106（100%）；11:00 起 108 轮，零段 = 0。
    # 分段管线是那一刻才落的，所以全时段统计会得到「125/255 ≈ 49% 有正文零语音」，
    # 看着像灾难性故障，其实是历史数据。
    #
    # 反过来这也**排除了一个错误假设**：用户抱怨「输出了但语音根本不读」不是服务端
    # 没下发段——分界之后一段都没漏过。责任在客户端 deadline 降级与 edge-tts 上游
    # 故障（方案 §3.5 / §4.9）。这里把分界固化下来，别让下一个人重新推一遍。
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
               round(avg(segs)::numeric, 2) avg_segs
        FROM per_run;
    """)

    # 首字延迟：run 开始 → 第一个 assistant.delta
    ttft = rows(f"""
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.created_at - r.started_at))*1000) p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.created_at - r.started_at))*1000) p90,
               count(*) n
        FROM companion_stream_events e JOIN companion_turn_runs r ON r.id = e.run_id
        WHERE e.type = 'assistant.delta' AND r.started_at IS NOT NULL
          {since_clause(since, 'e.created_at')};
    """)

    proactive = {
        "deliveries": int(scalar("SELECT count(*) FROM companion_proactive_deliveries;") or 0),
        "thoughts": int(scalar("SELECT count(*) FROM assistant_thoughts;") or 0),
        "thought_jobs_dead": int(scalar("""
            SELECT count(*) FROM jobs WHERE type='companion_thought' AND status='dead';
        """) or 0),
    }

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
            "failure_ratio": round(sum(by_status.get(k, 0) for k in ("failed",)) / run_total, 3) if run_total else 0,
            "failure_codes": {f["k"]: int(f["n"]) for f in failures},
        },
        "reply_shape": {
            "length_buckets": {b["bucket"]: {"n": int(b["n"]), "mean": num(b["mean"]),
                                             "p10": num(b["p10"]), "p50": num(b["p50"]),
                                             "p90": num(b["p90"]),
                                             "degenerate_lt4": int(b["degenerate"])} for b in lengths},
            "advance_rate": round(advance / seen, 3) if seen else 0,
            "echo_rate": round(echo / seen, 3) if seen else 0,
            "opener_repeat_rate": round(opener_repeat / seen, 3) if seen else 0,
            "sampled_replies": seen,
        },
        "memory": {
            "runs_with_retrieval_hit": mem_hit,
            "retrieval_hit_ratio": round(mem_hit / mem_runs_total, 3) if mem_runs_total else 0,
            "written_by_extraction": mem_extract_written,
            "live_rows": mem_live,
            "stuck_candidate_rows": mem_candidates,
            "extract_jobs": {j["k"]: int(j["n"]) for j in extract_jobs},
        },
        "voice": {
            "succeeded_runs": int(num(voice[0]["n"])) if voice else 0,
            "runs_with_text_but_zero_segments": int(num(voice[0]["zero_voice"])) if voice else 0,
            "zero_voice_span": f"{voice[0].get('zero_voice_from') or '-'}~{voice[0].get('zero_voice_to') or '-'}" if voice else "-",
            "avg_segments": num(voice[0]["avg_segs"]) if voice else 0,
        },
        "ttft_ms": {
            "p50": round(num(ttft[0]["p50"])) if ttft else 0,
            "p90": round(num(ttft[0]["p90"])) if ttft else 0,
            "delta_events": int(num(ttft[0]["n"])) if ttft else 0,
        },
        "proactive": proactive,
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
        "回声率": shape["echo_rate"],
        "检索命中轮占比": mem["retrieval_hit_ratio"],
    }.items() if not 0 <= value <= 1]
    if broken:
        print(f"!! 口径异常，以下比例越过 [0,1]，分子分母不同源：{broken}")

    print(f"\n{'='*66}\n伴星质量指标  语料窗口={metrics.get('corpus_window') or '全部'}"
          f"  过滤 since={metrics['since'] or '无'}  runs={runs['total']}\n{'='*66}")

    print("\n【能力是否被给到】方案 RC1 的直接读数")
    for mode, stat in runs["by_mode"].items():
        print(f"  agent_mode={mode:<12} n={stat['n']:<4} 最大步数={stat['max_steps']} 零工具={stat['zero_tool']}")
    print(f"  零工具轮占比 = {runs['zero_tool_ratio']:.1%}   ← 目标 <10%")
    print(f"  失败率 = {runs['failure_ratio']:.1%}  原因 = {runs['failure_codes']}")

    print("\n【回答形态】方案 #1 / #11")
    for bucket, stat in shape["length_buckets"].items():
        print(f"  {bucket:<12} n={stat['n']:<4} 均值={stat['mean']:<6} p10/p50/p90="
              f"{stat['p10']:.0f}/{stat['p50']:.0f}/{stat['p90']:.0f}  退化(<4字)={stat['degenerate_lt4']}")
    print(f"  推进率(带问句/提议) = {shape['advance_rate']:.1%}   ← 目标 >60%")
    print(f"  回声率(照抄用户那句) = {shape['echo_rate']:.1%}   开场重复率 = {shape['opener_repeat_rate']:.1%}")

    print("\n【记忆】方案 RC3：读侧命中 / 写侧产出")
    print(f"  检索命中轮占比 = {mem['retrieval_hit_ratio']:.1%}")
    print(f"  抽取写入行数 = {mem['written_by_extraction']}   ← 0 即写路径全断")
    print(f"  活行 = {mem['live_rows']}  卡在候选 = {mem['stuck_candidate_rows']}  抽取 job = {mem['extract_jobs']}")

    print("\n【语音】方案 #4")
    print(f"  成功轮 = {voice['succeeded_runs']}  有正文却零语音段 = {voice['runs_with_text_but_zero_segments']}"
          f"（落在 {voice['zero_voice_span']}，管线 2026-09-19 才上线——**不要按全时段读这个数**）")
    print(f"  平均段数 = {voice['avg_segments']}")
    print("  （注：TTS 合成结果无表可读，这里只测到「有没有下发段」，测不到客户端有没有播出来）")

    print("\n【时延 / 主动性】方案 #8 #9")
    print(f"  首字 p50={ttft['p50']}ms p90={ttft['p90']}ms")
    print(f"  主动投递 = {pro['deliveries']}  念头 = {pro['thoughts']}  死掉的念头 job = {pro['thought_jobs_dead']}")


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
    interesting = [k for k in after if k in before and before[k] != after[k]]
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
