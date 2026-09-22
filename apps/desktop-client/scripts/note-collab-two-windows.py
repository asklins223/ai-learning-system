#!/usr/bin/env python3
"""起两个独立的生产构建桌面端实例，给 note-collab-clobber-check 当量测窗口。

只在宿主 /tmp 下开新的 user-data-dir 与新调试端口，绝不碰用户自己那个 :9222 窗口。
"""
import os
import subprocess
import time
from pathlib import Path

REPO = Path("/Users/asklins/Documents/asklins_workspace/study")
DESKTOP = REPO / "apps/desktop-client"
WANT = ("DESKTOP_API_ORIGIN", "AILEARN_DESKTOP_PAIRING_KEY_ID", "AILEARN_DESKTOP_PAIRING_SECRET",
        # 少了这个也是同一屏「桌面端尚未通过本机服务校验」：`readConfiguration` 先要它，
        # 才轮到那两个配对键（desktop-gateway.ts:514）。
        "AILEARN_DOMAIN_SCHEMA_REVISION")

env = dict(os.environ)
for line in (REPO / ".env").read_text().splitlines():
    if "=" not in line or line.startswith("#"):
        continue
    key, value = line.split("=", 1)
    if key.strip() in WANT:
        env[key.strip()] = value.strip()
missing = [key for key in WANT if not env.get(key)]
if missing:
    raise SystemExit(f"仓库根 .env 里缺这几个键：{missing}")

instances = [("a", 9321)] if os.environ.get("ONLY_A") == "1" else [("a", 9321), ("b", 9322)]
for name, port in instances:
    data_dir = f"/tmp/clob-{name}"
    log = open(f"/tmp/clob-{name}.log", "w")
    subprocess.Popen(
        ["node_modules/.bin/electron", ".", f"--user-data-dir={data_dir}",
         f"--remote-debugging-port={port}"],
        cwd=DESKTOP, env=env, stdout=log, stderr=log, start_new_session=True,
    )
    print(f"起 clob-{name} 端口 {port}（日志 /tmp/clob-{name}.log）")

for _name, port in instances:
    deadline = time.time() + 60
    while time.time() < deadline:
        code = subprocess.run(["curl", "-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}",
                               f"http://127.0.0.1:{port}/json/version"], capture_output=True, text=True).stdout
        if code == "200":
            print(f"CDP {port} 已就绪")
            break
        time.sleep(2)
    else:
        raise SystemExit(f"CDP {port} 60 秒内没起来，看 /tmp/clob-*.log")
