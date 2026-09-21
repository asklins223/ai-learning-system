#!/usr/bin/env python3
"""伴星回合链路端到端验证（host → 运行中的 dev 栈，通过 HTTP/SSE 与数据库取证）。

用途：改完伴星服务端链路后，验"用户真正看到的"三个指标——**流式批次数与时间跨度**、
**失败率与失败原因**、**落库正文形态**。这三样单测和 tsc 都证明不了。

前置：dev 栈已起（`docker compose -f docker-compose.dev.yml up -d`），API 在 :4000，
Postgres 容器可 `docker exec`。

用法：
    python3 scripts/companion-turn-e2e-verify.py            # 跑默认五轮
    python3 scripts/companion-turn-e2e-verify.py --rounds 8 # 多跑几轮无上下文流式

三个**测量陷阱**（都踩过，改脚本时别改回去）：
  1. SSE 帧是 `id: <conv>:<seq>` / `event: companion` / `data: {...}`——
     事件类型在 **`data.type`** 里，帧名恒为 `companion`；
     delta 正文在 **`payload.textDelta`**（不是 text/delta）。按帧名筛会得到 0 条。
  2. SSE 会**从 seq 1 重放**：等待条件必须按 `runId` 过滤，否则上一轮残留的
     `assistant.final` 会立刻放行，你会在 run 还没终态时就去查库，看到
     `status=running` 然后误判"卡住"。
  3. 同一会话有**并发保护**：上一轮未终态时 POST turns 返回 409。发下一轮前先等终态。

另有一条环境事实：**API 侧伴星集成测试必须在 worker 停止时跑**，否则 dev worker 会
并发消费测试创建的真实 job，与测试自己的 `companion_stream_events` seq 写入撞车
（`duplicate key ... companion_stream_events_pkey`），以及把 run 提前推进到终态
（`supersedesGeneration mismatch`）。跑法：
    docker stop ailearn-dev-worker-1
    cd apps/api && DATABASE_URL_API=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
        npm run test:companion:postgres
    docker start ailearn-dev-worker-1
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://127.0.0.1:4000"
EMAIL = "owner@ailearn.local"
PASSWORD = "ailearn_owner"


def post(path: str, body: dict, token: str | None = None, extra: dict | None = None) -> dict:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if extra:
        headers.update(extra)
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def sql(query: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "ailearn-dev-postgres-1", "psql", "-U", "ailearn", "-d", "ailearn",
         "-t", "-A", "-F", "\t", "-c", query],
        capture_output=True, text=True)
    return out.stdout.strip()


def stream(conv_id: str, token: str, out: list, stop: threading.Event, t0: float,
           after: int | None = None) -> None:
    """SSE 订阅，把 (相对秒, payload) 追加进 out（陷阱 1：类型在 data.type）。

    陷阱 4（2026-09-21 实测）：**不带 cursor 的订阅会被 409 CURSOR_EXPIRED 挡掉**——
    连续会话的 durable 事件有 TTL，seq 1 起的全量 replay 早就断了。表现为
    "一条事件都没收到"，看起来像流式坏了。所以订阅点必须从**当前游标**接上：
    `after = next_event_seq - 1`（= 最新一条已写事件的 seq，实测 0 缺口放行）。
    """
    cursor = "" if after is None else f"?after={after}"
    req = urllib.request.Request(
        BASE + f"/companion/conversations/{conv_id}/events{cursor}",
        headers={"authorization": f"Bearer {token}", "accept": "text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=200) as resp:
            for raw in resp:
                if time.time() - t0 > 190 or (stop.is_set() and time.time() - t0 > 2):
                    break
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("data:"):
                    try:
                        out.append((round(time.time() - t0, 3), json.loads(line[5:].strip())))
                    except Exception:  # noqa: BLE001
                        pass
    except Exception as exc:  # noqa: BLE001
        out.append((round(time.time() - t0, 3), {"type": "__stream_error__", "raw": str(exc)[:200]}))


def event_cursor(conv_id: str) -> int:
    """当前事件游标：next_event_seq 是分配器，已写出的最后一条是它减一。"""
    raw = sql(f"SELECT next_event_seq - 1 FROM companion_conversations WHERE id='{conv_id}';")
    return int(raw) if raw.isdigit() else 0


def wait_not_running(conv_id: str, seconds: int = 90) -> str:
    """陷阱 3：上一轮未终态时发下一轮会 409。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        st = sql(f"SELECT status FROM companion_turn_runs WHERE conversation_id='{conv_id}' "
                 f"ORDER BY created_at DESC LIMIT 1;")
        if st and "running" not in st:
            return st
        time.sleep(1)
    return "TIMEOUT"


def run_round(token: str, conv_id: str, label: str, text: str,
              context: dict | None = None, wait: int = 90) -> dict:
    wait_not_running(conv_id)
    events: list = []
    stop = threading.Event()
    t0 = time.time()
    threading.Thread(target=stream,
                     args=(conv_id, token, events, stop, t0, event_cursor(conv_id)),
                     daemon=True).start()
    time.sleep(1.2)

    body = {"version": 1, "clientMessageId": str(uuid.uuid4()), "inputKind": "text",
            "blocks": [{"type": "text", "text": text}], "sourceSurface": "pet"}
    if context:
        body["context"] = context
    created = post(f"/companion/conversations/{conv_id}/turns", body, token,
                   {"Idempotency-Key": str(uuid.uuid4())})
    run_id = created.get("runId")

    deadline = time.time() + wait
    while time.time() < deadline:  # 陷阱 2：按 runId 过滤
        if any(p.get("runId") == run_id and p.get("type") in ("assistant.final", "error")
               for _, p in events):
            break
        time.sleep(0.4)
    time.sleep(1.5)
    stop.set()

    mine = [(t, p) for t, p in events if p.get("runId") == run_id]
    deltas = [(t, p) for t, p in mine if p.get("type") == "assistant.delta"]
    errors = [(t, p) for t, p in mine if p.get("type") == "error"]
    finals = [(t, p) for t, p in mine if p.get("type") == "assistant.final"]
    # 订阅自己坏了（401 / 409 CURSOR_EXPIRED / 连不上）时 delta 同样是 0，
    # 会被读成"流式没工作"——这类"测量仪坏了"的结论必须自己喊出来。
    stream_broken = [p for _, p in events if p.get("type") == "__stream_error__"]
    parts = [str((p.get("payload") or {}).get("textDelta") or "") for _, p in deltas]
    span = round(deltas[-1][0] - deltas[0][0], 3) if deltas else 0.0

    srv = sql(f"SELECT type||'='||count(*)||'|span='||coalesce(EXTRACT(EPOCH FROM "
              f"(max(created_at)-min(created_at)))::numeric(10,3),0) FROM companion_stream_events "
              f"WHERE run_id='{run_id}' GROUP BY type ORDER BY type;").replace("\n", "  ")
    run = sql(f"SELECT status||' err='||coalesce(error_code,'-')||' steps='||step_count||"
              f"' tools='||tool_call_count FROM companion_turn_runs WHERE id='{run_id}';")
    # tools= 只给个数，看不出"调了哪个、成没成"——而这一批的结论全在名字上
    # （recall 成功 + forget 失败 = 链路断在参数，不是模型不肯调）。
    calls = sql(f"SELECT coalesce(string_agg(name||'='||status, ' ; '),'（本轮没有工具调用）') "
                f"FROM companion_agent_tool_calls WHERE run_id='{run_id}';")
    # 落库正文必须按**本轮的 assistant 消息**取：以前查的是"会话里最后一条 assistant"，
    # 人同时在桌面端跟她聊天时（同一隐式连续会话）取到的是别人那句话，
    # 2026-09-21 实测两次把真实用户的"大肥鱼"轮当成脚本轮的结论。
    msg = sql(f"SELECT coalesce(m.blocks->0->>'text','') FROM companion_turn_runs r "
              f"JOIN companion_messages m ON m.id=r.assistant_message_id WHERE r.id='{run_id}';")

    print(f"\n===== {label} =====")
    print(f"runId={run_id}  墙钟={round(time.time()-t0,2)}s")
    print(f"[客户端] delta={len(deltas)}批 跨度={span}s 每批字数={[len(x) for x in parts]}")
    print(f"[客户端] error={len(errors)} final={len(finals)}")
    if errors:
        print("   error:", json.dumps(errors[-1][1], ensure_ascii=False)[:260])
    if stream_broken:
        print(f"   !!! SSE 订阅失败，本轮客户端读数不可信: {stream_broken[-1].get('raw')}")
    print(f"[客户端] 拼接正文({sum(len(x) for x in parts)}字): {''.join(parts)[:110]!r}")
    print(f"[服务端] {srv}")
    print(f"[服务端] run: {run}")
    print(f"[服务端] 工具: {calls[:240]}")
    print(f"[服务端] 落库正文: {msg[:110]!r}")
    return {"run_id": run_id, "deltas": len(deltas), "span": span,
            "client_text": "".join(parts), "db_text": msg, "run": run,
            "stream_broken": len(stream_broken),
            "errors": [p for _, p in errors]}


def resolve_continuous_conversation(token: str) -> str:
    """连续历史模型下会话是隐式单条（kind='inbox'）。

    `POST /companion/conversations` 这个路由**已经不存在了**——本脚本此前一直调它，
    现在会 404。改为从库里取当前最新的 inbox 会话（与桌面客户端实际用的是同一条）。
    """
    conv_id = sql("SELECT id FROM companion_conversations WHERE kind='inbox' "
                  "ORDER BY updated_at DESC LIMIT 1;")
    if not conv_id:
        raise SystemExit("找不到 kind='inbox' 的连续会话——先跑一次真实对话再回来")
    return conv_id


def reap_orphaned_runs() -> int:
    """跑之前先收尸（方案 29 §9.3）。

    job 已 dead 但 run 还挂在非终态时，该会话之后**每一轮**都会 409 RUN_ALREADY_ACTIVE。
    worker 每 30s 的回收 tick 会处理，但验证脚本等不起也不该靠它，直接调同一个函数。
    """
    out = sql("SELECT public.ailearn_reclaim_orphaned_companion_runs();")
    return int(out) if out.isdigit() else 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=5,
                        help="默认五轮的场景数；超出部分一律跑'无上下文'轮（流式对照）")
    parser.add_argument("--title", default="回合链路验证")
    parser.add_argument("--only", default="",
                        help="只跑这些编号的场景（逗号分隔，按给出的顺序执行），例如 --only S,Q,R")
    args = parser.parse_args()

    token = post("/auth/login", {"email": EMAIL, "password": PASSWORD})["token"]
    conv_id = resolve_continuous_conversation(token)
    print("conversationId =", conv_id, "(连续会话；--title 仅用于日志，不再建会话)")
    print("回收孤儿 run =", reap_orphaned_runs())

    today = {"pageKind": "today", "sharing": "page_registered"}
    # 场景按用户 2026-09-20 的 13 条抱怨分档，而不是只测流式：
    #   视野类（#5 #6）——以前零工具时必然答不出；
    #   记忆类（#3）——写路径与 recall；
    #   连续性（#1）——答完有没有把球抛回来；
    #   流式（#4）——delta 批数与跨度。
    scenarios = [
        ("A 视野·时间（环境块，无工具也应答对）",
         "现在几点了，是上午还是下午呀？", None),
        ("B 视野·今日量（环境块）",
         "我今天一共学了多久了？", None),
        ("C 视野·笔记（需要真下钻，应调工具）",
         "我笔记库里最近写的是哪几篇来着？", None),
        ("D 视野·复习到期（需要真下钻）",
         "我现在有多少个东西到期该复习了？", None),
        ("E 记忆·写（companion_save_memory）",
         "帮我记住：我习惯在图书馆三楼复习。", None),
        ("F 记忆·读（下一轮能否用上）",
         "你还记得我平时在哪儿复习吗？", None),
        ("G 导航（跳转工具 + route）",
         "带我去复习页面看看。", None),
        ("H today 上下文（带页面状态）",
         "我现在这一页能看到什么？简单说说就好。", today),
        ("I 连续性·短输入（坍缩闸最该拦的一类）",
         "哈哈", None),
        ("J 带上下文追问（验证历史是真多轮）",
         "刚才你说的第一件事，再展开一点。", today),
        # K–O：方案 29 §4.2 新开的系统面（抱怨 #5/#6/#9）。这些不是"能不能答对"，
        # 而是"有没有真的去调"——工具没接上时她会用一句含糊的话糊过去，
        # 所以每轮都要看 run 行里的 tools= 计数。
        ("K 视野·搜笔记（companion_search_notes）",
         "帮我搜搜笔记里有没有写到疏散路线的，是哪一篇？", None),
        ("L 视野·读正文（companion_read_note，要接住上一轮的 noteId）",
         "就那篇，正文里具体写了什么？念一小段给我。", None),
        ("M 视野·任务队列（companion_list_task_queue）",
         "我接下来的任务队列里都排着什么？", None),
        ("N 视野·学习统计（companion_get_learning_stats，口径要和首页一致）",
         "我这周总共学了多久？现在有多少张活跃卡片、多少篇笔记？", None),
        ("O 提醒（companion_schedule_reminder + list）",
         "明天早上九点提醒我把疏散路线再背一遍。", None),
        ("P 提醒·回看（她记不记得自己许的约）",
         "你答应过我几件事？分别是什么时间？", None),
        # Q–U：方案 29 §4.3/§4.4 的记忆与活动面。Q/R 是一对——recall 拿到 memoryId
        # 才谈得上 forget（她如果跳过 recall 直接猜 id，forget 必失败，这正是
        # "工具能调但链路不成立"的那类缺陷，要看 run 行的 tools= 计数）。
        ("Q 记忆·再检索（companion_recall_memory，要翻出本轮没注入的那些）",
         "除了你现在想到的，我以前还让你记住过什么？翻翻看。", None),
        ("R 记忆·忘掉（companion_forget_memory，先 recall 拿到 id）",
         "关于我在哪儿复习那条，别记着了，忘掉它。", None),
        ("S 活动流（companion_list_recent_activity）",
         "我最近这几天都在系统里干了些啥？", None),
        ("T 边界·催学习（companion_set_boundary，改完要立刻影响下一轮口吻）",
         "以后别主动催我复习，我不问你别说。", None),
        ("U 边界·口头禅（companion_set_boundary catchphrase）",
         "给你自己加个口头禅：就这么定了。偶尔带上就行。", None),
    ]
    out = {}
    if args.only.strip():
        # --only 按编号挑场景并保持给出的顺序：新工具要单独跑时，不该为此付 21 轮的钱。
        wanted = [letter.strip().upper() for letter in args.only.split(",") if letter.strip()]
        by_letter = {label.split()[0].upper(): (label, text, ctx)
                     for label, text, ctx in scenarios}
        missing = [letter for letter in wanted if letter not in by_letter]
        if missing:
            raise SystemExit(f"没有这些场景编号: {missing}（可用: {sorted(by_letter)}）")
        picked = [by_letter[letter] for letter in wanted]
        for letter, (label, text, ctx) in zip(wanted, picked):
            out[f"{letter} {label}"] = run_round(token, conv_id, label, text, ctx)
    else:
        for i, (label, text, ctx) in enumerate(scenarios[:args.rounds], start=1):
            out[f"{i} {label}"] = run_round(token, conv_id, label, text, ctx)
    for i in range(len(scenarios), args.rounds):
        out[f"{i+1} 附加无上下文轮"] = run_round(
            token, conv_id, f"附加 #{i+1} 无上下文（流式对照）", "跟我说一句鼓励的话。")

    total = len(out)
    failed = sum(1 for v in out.values() if "succeeded" not in v["run"])
    streamed = sum(1 for v in out.values() if v["deltas"] > 1)
    used_tools = sum(1 for v in out.values() if "tools=0" not in v["run"])
    print(f"\n===== 汇总 =====\n轮次={total} 失败={failed} 多批流式={streamed} 调用了工具={used_tools}")
    broken_rounds = [k for k, v in out.items() if v.get("stream_broken")]
    print(f"SSE 订阅失败的轮次（这些轮的『批数/跨度』不可信，应为空）: {broken_rounds}")
    print("每轮：(批数, 跨度s) =", {k: (v["deltas"], v["span"]) for k, v in out.items()})
    print("每轮 run 行 =", {k.split()[0]: v["run"] for k, v in out.items()})
    bad_head = [k for k, v in out.items() if v["db_text"][:1] in "，。、；：,.;:"]
    # ④-b 新增的两类门槛（2026-09-19 实机首轮就踩中，必须长期把关）：
    # 1. 分段重复——可见正文是多步 content 的拼接，模型在工具步把话说完、终答步又
    #    说一遍，拼起来就是肉眼可见的复读（实机 C 轮：同一句 34 字出现两次）。
    # 2. 行首孤立标点——旧版 `stripLeadingOrphanPunctuation` 只削整段开头，拦不住
    #    分段边界上的 `？\n\n，你今天…`（实机 B 轮）。
    ORPHAN = "，。、；：,.;:"
    dup, bad_line_head = [], []
    for k, v in out.items():
        segs = [s.strip() for s in v["db_text"].split("\n\n") if len(s.strip()) >= 8]
        if len(segs) != len(set(segs)):
            dup.append(k)
        # 注意：空行 `""[:1]` 是 `""`，而 `"" in ORPHAN` 恒为 True——必须先排除空行
        # （2026-09-19 踩过：`\n\n` 分段让每轮都误报）。
        if any(line and line[:1] in ORPHAN for line in v["db_text"].split("\n")):
            bad_line_head.append(k)
    print("落库正文以孤立标点开头（应为空）:", bad_head)
    print("分段重复（应为空）:", dup)
    print("行首孤立标点（应为空）:", bad_line_head)
    sys.exit(1 if failed or bad_head or dup or bad_line_head else 0)


if __name__ == "__main__":
    main()
