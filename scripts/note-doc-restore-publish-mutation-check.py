#!/usr/bin/env python3
"""恢复路径那一条集成用例的变异检验：把"把恢复同步到在线文档"这一步摘掉，它必须红。"""
import os
import re
import subprocess
from pathlib import Path

API = Path("/Users/asklins/Documents/asklins_workspace/study/apps/api")
ROUTES = API / "src/modules/note/routes.ts"
TEST = "src/integration-tests/note-collaboration-postgres.integration.ts"
NAME = "恢复历史版本：开着这一篇的人要跟着变，他之后敲的字不能把恢复顶回去"
ANCHOR = "          await publishRestoredNoteDoc({"
MUTATED = "          if (process.env.SKIP_PUBLISH !== \"1\") await publishRestoredNoteDoc({"

env_line = [line for line in Path("/Users/asklins/Documents/asklins_workspace/study/.env").read_text().splitlines()
            if line.startswith("DATABASE_URL_API=")][0].split("=", 1)[1]
url = env_line.replace("@postgres:5432", "@127.0.0.1:5432")


def run(skip: bool):
    proc = subprocess.run(
        ["node", "--import", "tsx", "--test", "--test-concurrency=1",
         f"--test-name-pattern={NAME}", TEST],
        cwd=API, capture_output=True, text=True,
        env={**os.environ, "DATABASE_URL_API": url, "SKIP_PUBLISH": "1" if skip else "0"},
    )
    out = re.sub(r"\x1b\[[0-9;]*m", "", proc.stdout + proc.stderr)
    passed = int(re.search(r"# pass (\d+)", out).group(1)) if "# pass " in out else -1
    failed = int(re.search(r"# fail (\d+)", out).group(1)) if "# fail " in out else -1
    return passed, failed, out


def main():
    original = ROUTES.read_text()
    assert original.count(ANCHOR) == 1, f"锚点出现 {original.count(ANCHOR)} 次，变异写不上"
    try:
        ROUTES.write_text(original.replace(ANCHOR, MUTATED))
        assert MUTATED in ROUTES.read_text(), "替换没落盘"
        print(f"摘掉那一步之后：{run(True)[:2]}（期望 pass 0 / fail 1）")
        passed, failed, out = run(True)
        if not (passed == 0 and failed >= 1):
            print("变异没让这条用例红 —— 这条断言是哑的。末尾输出：")
            print("\n".join(out.splitlines()[-25:]))
        else:
            print("红对了。再确认同一条用例带着那一步仍然绿：")
            ok_passed, ok_failed, ok_out = run(False)
            print(f"带修复：pass {ok_passed} / fail {ok_failed}")
            if ok_passed != 1 or ok_failed != 0:
                print("\n".join(ok_out.splitlines()[-25:]))
    finally:
        ROUTES.write_text(original)
    assert ROUTES.read_text() == original, "恢复原文件失败"
    print("已还原（git diff 应为空）")


main()
