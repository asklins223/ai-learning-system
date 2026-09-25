#!/usr/bin/env python3
"""用**受限角色**跑集测：把 `DATABASE_URL_API` / `DATABASE_URL_WORKER` 换成 CI 用的那两个角色再执行命令。

为什么要有这台：dev 根 `.env` 里四条 `DATABASE_URL*` 的用户**全是 `ailearn`**（`pg_roles` 里
`rolsuper=t, rolbypassrls=t`），而 CI（`.github/workflows/ci.yml:386-387`）把 `_API`/`_WORKER`
指到 `ailearn_api`/`ailearn_worker`（`NOBYPASSRLS`）。于是同一批隔离类用例在两边结论相反：
本地拿超户跑，"无 session context 应当零行"这种断言**必红**（2026-09-25 实测 107 条里红 5 条，
全是这一族），而那 5 条换成真角色后 2/2、逐条绿。红本身不是产品回归，但**每次都要重新误判一遍**
就是纯浪费——以前也踩过反方向：同一个眼罩让该红的东西假绿。

密码取自 `.env` 的 `API_PASSWORD` / `WORKER_PASSWORD`（`infra/postgres/apply-roles.sh` 就是拿这两个
建角色的），拼 URL 时做百分号编码；**只打印用了哪个角色，绝不打印 URL 或密码**。
容器里的库名与端口沿用 `.env` 里那条 URL，只把主机名 `postgres` 换成 `127.0.0.1`
（宿主进程在容器网络外，`@postgres:` 一律 `ENOTFOUND`）。

用法：
    scripts/with-restricted-db-urls.py apps/api npm run test:companion-integration:postgres
"""

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent


def die(message: str) -> "None":
    print(message, file=sys.stderr)
    raise SystemExit(2)


def dotenv() -> dict:
    values = {}
    for line in (ROOT / ".env").read_text().splitlines():
        match = re.match(r"^([A-Z_0-9]+)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('"')
    return values


def main() -> int:
    if len(sys.argv) < 3:
        die("用法：scripts/with-restricted-db-urls.py <包目录> <命令…>")
    package, command = sys.argv[1], sys.argv[2:]
    values = dotenv()
    template = values.get("DATABASE_URL_WORKER") or values.get("DATABASE_URL_API")
    if not template:
        die("`.env` 里没有可参照的 DATABASE_URL_WORKER／_API，猜不出库名与端口")
    host = re.search(r"@([^/?]+)", template)
    database = template.rsplit("/", 1)[1].split("?")[0]
    if host is None:
        die(f"参照 URL 里没有 @host 段：{template.split(':')[0]}://…")
    # 只换主机名：`postgres` 是 compose 内网名，宿主跑命令时解析不到。
    reachable = host.group(1).replace("postgres:", "127.0.0.1:")
    env = dict(os.environ)
    for url_key, role_key in (("DATABASE_URL_API", "API_PASSWORD"), ("DATABASE_URL_WORKER", "WORKER_PASSWORD")):
        password = values.get(role_key)
        if not password:
            die(f"`.env` 里缺 {role_key}，造不出 {url_key}（这个角色是 apply-roles.sh 建的）")
        role = url_key.removeprefix("DATABASE_URL_").lower()
        env[url_key] = f"postgres://ailearn_{role}:{quote(password, safe='')}@{reachable}/{database}"
    # 夹具写入仍走超户那条：CI 的分工是"写用 migrator/超户、被测读数用受限角色"。
    for passthrough in ("DATABASE_URL", "DATABASE_URL_MIGRATOR"):
        if values.get(passthrough):
            env[passthrough] = values[passthrough].replace("@postgres:", "@127.0.0.1:")
    print("已注入受限角色：" + "、".join(
        f"{key}→ailearn_{key.rsplit('_', 1)[-1].lower()}"
        for key in ("DATABASE_URL_API", "DATABASE_URL_WORKER")
    ) + f"（库 {database}@{reachable}；URL 与密码不打印）", flush=True)
    result = subprocess.run(command, cwd=ROOT / package, env=env)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
