#!/usr/bin/env python3
"""隔离验证：API 的 inbox SSE 到底会不会把 worker 直投的投递推下来。

跑法：python3 scripts/companion-inbox-sse-probe.py（dev 栈在跑即可；它会插一条到点提醒，
所以**会在桌宠上真长出一个气泡**，量完记得清 companion_reminders / reminder: 投递。）

不经过桌宠客户端，直接用 HTTP 打开流，再插入一条到点提醒，看流上有没有帧。
这一刀把"服务端推送"和"客户端渲染"两段分开——之前一次实验把两段混在一起量，
得出过相反的结论。
"""
import json
import subprocess
import threading
import time
import urllib.request

BASE = "http://127.0.0.1:4000"
EMAIL = "owner@ailearn.local"
PASSWORD = "ailearn_owner"
WORKSPACE = "97550966-adf4-47fa-8d91-f83eae9ebfc0"
USER = "f6c4a80e-e668-4be7-a7b3-e8ad9311079a"


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def psql(sql):
    return subprocess.run(
        ["docker", "exec", "ailearn-dev-postgres-1", "psql", "-U", "ailearn_worker", "-d", "ailearn", "-Atc", sql],
        capture_output=True, text=True, timeout=60,
    ).stdout.strip()


frames = []
stop = threading.Event()


def read_stream(token):
    req = urllib.request.Request(
        f"{BASE}/companion/deliveries/inbox/stream?after=0",
        headers={"authorization": f"Bearer {token}", "accept": "text/event-stream"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        current = []
        deadline = time.time() + 150
        while not stop.is_set() and time.time() < deadline:
            line = resp.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip("\n")
            if text.startswith("data: "):
                current.append(text[6:])
            elif text == "" and current:
                frames.append(json.loads("\n".join(current)))
                current = []


token = post("/auth/login", {"email": EMAIL, "password": PASSWORD})["token"]
before = psql("SELECT count(*) FROM assistant_deliveries")
worker = threading.Thread(target=read_stream, args=(token,), daemon=True)
worker.start()
time.sleep(4)
baseline = max([f.get("inboxSequence", 0) for f in frames] or [0])
print("replayed baseline seq =", baseline)
psql(f"INSERT INTO companion_reminders (workspace_id, user_id, text, fire_at) VALUES "
     f"('{WORKSPACE}','{USER}','第五条：SSE 分段验证', now() + interval '2 seconds')")
print("opened stream; reminder queued. frames_seen_on_connect =", len(frames))
waited = 0
while waited < 150 and not [f for f in frames if f.get("inboxSequence", 0) > baseline]:
    time.sleep(5)
    waited += 5
print(f"waited {waited}s for a frame beyond baseline")
stop.set()
print("frames:", len(frames))
for f in [x for x in frames if x.get("inboxSequence", 0) > baseline][:6]:
    print("  seq", f.get("inboxSequence"), f.get("kind"), (f.get("payloadRef") or {}).get("text"), "session=", f.get("assistantSessionId"))
print("deliveries before/after:", before, psql("SELECT count(*) FROM assistant_deliveries"))
