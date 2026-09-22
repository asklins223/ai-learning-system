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
import re
import pathlib
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
    # 富块（nav/quote/diagram/card/image）到底有没有落进消息：B6 的全部意义就是这些
    # 东西进消息流，而 harness 以前只看 blocks[0].text——块没落地也看不出来。
    kinds = sql(f"SELECT coalesce(string_agg(b->>'type', '+' ORDER BY ordinality),'（无）') "
                f"FROM companion_turn_runs r "
                f"JOIN companion_messages m ON m.id=r.assistant_message_id, "
                f"jsonb_array_elements(m.blocks) WITH ORDINALITY AS t(b) WHERE r.id='{run_id}';")
    # 图片块存的是站内 url（渲染层按它取字节）；写成别的形状合同会收、客户端取不到。
    image_url = sql(f"SELECT coalesce(string_agg(b->>'url', ','),'') FROM companion_turn_runs r "
                    f"JOIN companion_messages m ON m.id=r.assistant_message_id, "
                    f"jsonb_array_elements(m.blocks) WITH ORDINALITY AS t(b) "
                    f"WHERE r.id='{run_id}' AND b->>'type'='image';")

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
    print(f"[服务端] 块: {kinds}  图片url: {image_url[:120] or '—'}")
    # 登记这一轮：质量报表的形态指标（推进率/开场重复率/回声率）要把脚本轮剔出去。
    # 场景输入是固定的，开场白也高度雷同，混进真实使用里就会造出假读数——
    # 2026-09-21 实测"今天唯一的连续相同开头是『我再查一』×2"，全是我自己跑 Y 打的。
    try:
        registry = pathlib.Path(__file__).resolve().parent.parent / ".impeccable/companion/scripted-runs.txt"
        registry.parent.mkdir(parents=True, exist_ok=True)
        with registry.open("a", encoding="utf-8") as handle:
            handle.write(f"{run_id}\n")
    except OSError as error:  # 登记失败不该让验证中断，但也不能静默
        print(f"[警告] 脚本轮登记失败（报表会把这些轮次算进真实使用）：{error}")

    return {"run_id": run_id, "deltas": len(deltas), "span": span,
            "client_text": "".join(parts), "db_text": msg, "run": run,
            "tool_calls": calls,
            "block_kinds": kinds, "image_urls": image_url,
            "stream_broken": len(stream_broken),
            "errors": [p for _, p in errors]}


def resolve_continuous_conversation(session: dict) -> str:
    """连续历史模型下会话是隐式单条（kind='inbox'）。

    `POST /companion/conversations` 这个路由**已经不存在了**——本脚本此前一直调它，
    现在会 404。改为从库里取当前最新的 inbox 会话（与桌面客户端实际用的是同一条）。

    但"全库最新一条"是错的：这里用超级用户查，RLS 不挡，而开发库里别的账号的
    inbox 一直在被别的会话的验收跑更新（实测 2026-09-21：另一台 app 用
    `/tmp/accept-udd-member` 起了第二个 workspace，它的 inbox 比我的新 94 秒），
    于是脚本挑到别人的会话，每一轮都 `403 conversation scope mismatch`。
    必须按**登录返回的那个 ctx** 去取——形状照服务端读，不从客户端 schema 反推。
    """
    ctx = session.get("ctx") or {}
    workspace_id, user_id = ctx.get("workspaceId"), ctx.get("userId")
    if not workspace_id or not user_id:
        raise SystemExit(f"登录响应里没有 ctx.workspaceId/userId：{sorted(ctx)}")
    conv_id = sql("SELECT id FROM companion_conversations WHERE kind='inbox' "
                  "AND workspace_id = '{}' AND user_id = '{}' "
                  "ORDER BY updated_at DESC LIMIT 1;".format(workspace_id, user_id))
    if not conv_id:
        raise SystemExit("这个账号名下找不到 kind='inbox' 的连续会话——先跑一次真实对话再回来")
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

    session = post("/auth/login", {"email": EMAIL, "password": PASSWORD})
    token = session["token"]
    conv_id = resolve_continuous_conversation(session)
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
        ("B 视野·今日量（问了才给：走 companion_get_learning_stats，口径与首页一致）",
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
        ("I 连续性·短输入（坍缩闸最该拦的一类；且不许主动报数）",
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
        # V：专门验 §4.8 的 quote 块——挑一条**内容与正文都不在最近对话里**的笔记，
        # 她只能真去 read_note 才拿得到原文（照历史复述不算通过）。
        ("V 读原文·quote 块（companion_read_note 带出服务端原文）",
         "《欧姆定律生成验收》那篇笔记里到底写了什么？必须真的用工具打开它读原文，别凭印象复述。", None),
        # W：§4.8 的 markdown 批次专用。判据不在"她有没有用星号"，而在
        # **落库正文 vs 朗读文本**是否分叉：正文可以带结构，voice.segment.ready 的
        # synthesisText 必须干净（否则 TTS 会把星号念出来）。
        ("W 结构化输出（步骤用列表/加粗，朗读文本必须无标记）",
         "把消防疏散那篇笔记里的操作步骤清楚地列给我，该分条就分条。", None),
        # X/Y：§4.8 的 diagram 与 card 块。Y 需要一张**真的到期**的卡——
        # 脚本跑之前先把一条 review_schedules 改到期，跑完还原（见 --only Y 的说明）。
        ("X 流程图（companion_render_diagram → diagram 块）",
         "把消防疏散的那几步画成一张流程图给我看。", None),
        ("Y 打开卡片（list_due_reviews 给 cardId → open_card → card 块）",
         "有哪张卡到期了？打开第一张，把题面给我看。", None),
        # Z：读图（抱怨 #9）。**这台机器上 sendImageContent=false**（0/852 个账号开着），
        # 所以这一轮验的不是"她看图说得对不对"（那条在 §9.33 用探针单独验过：7s、内容准确），
        # 而是政策关着时她**不能**装看：读图工具不在她的工具面上（看不见才不会答应之后看不了），
        # 而 read_note 会带着 imageCount + imageNote 回来。
        # 通过判据：不调任何读图工具、不出现"我看看这张图/图上写着…"，
        # 而是照实说看不了并说出开关在哪。
        ("Z 读图·政策关着时必须说实话（companion_read_image 不下发）",
         "《IndexTTS 2.5》那篇笔记里那张截图上写了什么？我真的要看到图里的内容，别猜。", None),
        # Z2：显示图片与读图是两条能力（§4.8 的 image 块）。把图摆到对话里只是本机显示，
        # 一个字节都不出境，所以**图片外发关着也该办成**。
        # 通过判据：调 companion_show_image（不是拒答、也不是去调被政策摘掉的读图），
        # 并且消息 blocks 里真的多出一个 image 块（url 形如 /api/uploads/…）。
        ("Z2 显示图片（companion_show_image → image 块，不外发）",
         "《IndexTTS 2.5》那篇里的第一张图，直接贴给我看看长什么样。", None),
        # AA：没发生的变化不能报成"改好了"（方案 29 §9.70）。实机 2026-09-22 场景 U，
        # 用户只要一句口头禅，她顺手把活跃度也"调成了「活跃」"——而活跃度本来就是
        # active（revision 白 +1，什么都没变）。判据：工具回 unchanged，正文里出现
        # "本来就是这样/没改动"这一类实话；跑前后各读一次 pet_profiles.revision 佐证。
        ("AA 人格·本来就是这一档（不该报成改动）",
         "把你的活跃度设成「活跃」。", None),
        # AB：§11 C1 的接入验收。摘要块带的是"最近 20 条之外"的那段对话，
        # 判据不是她答得漂不漂亮，而是**答案里出现的待办只能来自摘要**
        # （跑完用 SQL 比对：这句在最近 20 条正文里出现过 = 不可归因）。
        ("AB 摘要接入（更早那段对话她能不能想起来）",
         "往前翻翻我们更早的对话，有哪件事还没了结？", None),
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
    # Z 场景的**结果**判据（不是机制判据）。那一轮的病是"照实读正文也会说没有图"，
    # 所以只看落库正文：说成没图 = 假阴性还在；承诺去看图 = 政策关着时答应了做不到的事。
    # 两者都判失败——修好之后再退化会立刻红，而不是靠人读一遍输出。
    image_denial, image_promise = [], []
    for k, v in out.items():
        if not k.startswith("Z") and " Z " not in k:
            continue
        text = v["db_text"]
        if re.search(r"没有截图|没有图片|里没有图|没有任何图片", text):
            image_denial.append(k)
        if re.search(r"我(来|先|去)?看(看|一下)?(这张|那张)?图|帮你看看图", text):
            image_promise.append(k)
    print("Z 轮把有图的笔记说成没图（应为空）:", image_denial)
    print("Z 轮承诺去看图（应为空）:", image_promise)
    # Z2：把图"给用户看"是本机显示，不需要图片外发。判据是**块真的落地**了：
    # 她嘴里说"给你看"而消息里没有 image 块，就是又一次"答应了没做"。
    def is_z2(key: str) -> bool:
        return key.split(maxsplit=1)[0].upper() == "Z2"

    z2_keys = [k for k in out if is_z2(k)]
    missing_image_block = [k for k in z2_keys if "image" not in out[k]["block_kinds"]]
    bad_image_url = [k for k, v in out.items()
                     if "image" in v["block_kinds"]
                     and not all(u.startswith("/api/uploads/") for u in v["image_urls"].split(",") if u)]
    print("Z2 轮没有真的贴出图（应为空）:", missing_image_block)
    print("图片块 url 不是站内形状（应为空）:", bad_image_url)

    # card 块（方案 29 §9.48）：`companion_open_card` 六个周一直 not_found，
    # 因为 `review_schedules.subject_type='card'` 只是别名、列里存的是 objectiveId，
    # 而 listing 与 open_card 都按 card_id 连。库里 card 块恒 0 行才是当时的"正常"。
    # 所以这条链必须有一道"跑一次就知道"的门，而不是靠人去查库。
    # 没落块有两种可能：键又错了，或她整轮没调工具——后者同样该红，
    # 因为"让她做事却没落地"正是 steer 要兜住的那一类。
    y_keys = [k for k in out if k.split(maxsplit=1)[0].upper() == "Y"]
    missing_card_block = [k for k in y_keys if "card" not in out[k]["block_kinds"]]
    print("Y 轮没有落下 card 块（应为空）:", missing_card_block)

    # I 轮（用户只发了「哈哈」）判的是**结果**：正文里不许出现统计读数，也不许去调统计工具。
    # 实机 2026-09-21 22:00 用户原话是"我啥都没问啊，你在说什么呢？"——她那轮回的是
    # "今天已经学了 42 分钟，本周累计 99 分钟"，其中 42 来自环境块、99 来自一次没人要的
    # companion_get_learning_stats。用户真问时长是 B/N 轮，两条路各有场景，互不背书。
    stat_readout, stat_tool = [], []
    for k, v in out.items():
        if k.split(maxsplit=1)[0].upper() != "I":
            continue
        if re.search(r"\d+\s*(分钟|小时|张|篇|条|项|次|个)", v["db_text"]):
            stat_readout.append(k)
        if "companion_get_learning_stats" in v["tool_calls"]:
            stat_tool.append(k)
    print("I 轮没被问就报出统计（应为空）:", stat_readout)
    print("I 轮没被问就调了统计工具（应为空）:", stat_tool)
    sys.exit(1 if failed or bad_head or dup or bad_line_head or image_denial or image_promise
             or missing_image_block or bad_image_url or missing_card_block
             or stat_readout or stat_tool else 0)


if __name__ == "__main__":
    main()
