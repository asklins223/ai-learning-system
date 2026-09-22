#!/usr/bin/env python3
"""批次 C2 新断言的变异检验：摘掉被守护的行为，确认对应用例真的变红。

判据不是"测试通过了"，而是"这条断言在它该保护的东西消失时会喊"。
脚本自身也要防静默失效：改完先确认那一行真的在里面，且 `git diff` 非空。
"""
import re
import subprocess
import sys
from pathlib import Path

DESKTOP = Path("/Users/asklins/Documents/asklins_workspace/study/apps/desktop-client")
HOOK = DESKTOP / "src/renderer/src/components/surfaces/use-note-doc-live-view.ts"
SURFACE = DESKTOP / "src/renderer/src/components/surfaces/notebook-surface.tsx"
SUITE = "src/renderer/src/components/surfaces/notebook-surface.live-frame.test.tsx"
HOOK_SUITE = "src/renderer/src/components/surfaces/use-note-doc-live-view.test.ts"
ANSI = re.compile(r"\x1b\[[0-9;]*m")

MUTATIONS = [
    ("M1 远端增量根本不 apply 进文档", HOOK,
     '        Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);',
     '        if (bytes) void 0;',
     ["对端改了那一段", "我没动过标题时"]),
    ("M2 标题不看本机覆盖值（永远画文档里那份）", SURFACE,
     "  const titleValue = draft.title ?? docTitle;",
     "  const titleValue = docTitle;",
     ["我改了标题时"]),
    ("M3 dirty 不算标题那一半", SURFACE,
     "  const dirty = noteDocLive.dirty || titleEdited;",
     "  const dirty = noteDocLive.dirty;",
     ["我改了标题时"]),
    ("M4 阅读态正文退回那次回读", SURFACE,
     "  const readSourceBlocks = noteDocLive.blocks.length ? noteDocLive.blocks : (note?.currentVersion.blocks ?? []);",
     "  const readSourceBlocks = note?.currentVersion.blocks ?? [];",
     ["对端改了那一段"]),
    ("M5 跟上别人的改名后仍判成脏", SURFACE,
     "  const titleEdited = draft.title !== null && draft.title !== docTitle;",
     '  const titleEdited = draft.title !== null || docTitle !== (note?.title ?? "");',
     ["我没动过标题时"]),
    ("M6 阅读态什么都不画", SURFACE,
     "  const readSourceBlocks = noteDocLive.blocks.length ? noteDocLive.blocks : (note?.currentVersion.blocks ?? []);",
     "  const readSourceBlocks: typeof noteDocLive.blocks = [];",
     ["对端改了那一段", "没有帧时画的就是这份文档"]),
    # —— 下面四条跑的是 `use-note-doc-live-view` 那一份用例（见 run_suite 的分流）——
    # M7（本地改动不推进投影版本号）摘掉之后这两份用例照样全绿 —— 那条变异
    # 已经不复现，所以这里不放进来冒充"验过"。那一行代码留着的历史依据写在用例注释里。
    ("M8 起点被重新取（换篇判断按\'这一屏没读到\'算）", HOOK,
     "  if (noteId !== null && targetRef.current !== noteId) {",
     "  if (targetRef.current !== noteId) {",
     ["noteId 短暂为空"]),
    ("M9 上行的命令号回到自己拼的那种（IPC 那把尺不放冒号）", HOOK,
     '      commandId: createCommandId("note-doc"),',
     "      commandId: `note-doc:${noteId}:${Date.now()}`,",
     ["本机打的那几个字算待提交"]),
    ("M10 被拒的写入重新读成「这台机器什么都没改」", HOOK,
     "    const via = unwrapGatewayResult(submitted).via;",
     "    const via = submitted.ok ? submitted.data.via : null;",
     ["主进程拒收那一次"]),
]

# 每条变异可以指定自己该跑哪份用例；不写就用默认那份（live-frame）。
PER_MUTATION_SUITE = {"M7", "M8", "M9", "M10"}


def run_suite(hook_suite: bool = False):
    proc = subprocess.run(["npx", "vitest", "run", HOOK_SUITE if hook_suite else SUITE], cwd=DESKTOP,
                          capture_output=True, text=True)
    out = ANSI.sub("", proc.stdout + proc.stderr)
    failed = set(re.findall(r"× (.+?)(?: \d+ms)?\n", out))
    crashed = ("Test Files  1 failed" in out or "Test Files  1 error" in out) and not failed
    return failed, crashed, out


def check(name, path, anchor, replacement, expect_red):
    original = path.read_text()
    if original.count(anchor) != 1:
        print(f"  {name}: 锚点出现 {original.count(anchor)} 次 —— 变异没写成，判红")
        return False
    mutated = original.replace(anchor, replacement)
    if replacement not in mutated:
        print(f"  {name}: 替换后找不到新行 —— 变异没写成，判红")
        return False
    path.write_text(mutated)
    diff = subprocess.run(["git", "diff", "--quiet", "--", str(path)]).returncode
    if diff == 0:
        print(f"  {name}: 写盘后 git diff 为空 —— 变异没落盘，判红")
        return False
    try:
        failed, crashed, out = run_suite(name.split()[0] in PER_MUTATION_SUITE)
    finally:
        path.write_text(original)
    if crashed:
        print(f"  {name}: 文件级失败/根本没跑完（不是按用例红）——判红")
        print(ANSI.sub("", "\n".join(out.splitlines()[-15:])))
        return False
    hit = [t for t in expect_red if any(t in f for f in failed)]
    missing = [t for t in expect_red if t not in " \n".join(failed)]
    if missing:
        print(f"  {name}: 该红的没红 -> {missing}")
        print(f"    实际红的是：{sorted(failed) if failed else '（一条都没红）'}")
        return False
    print(f"  {name}: 红 -> {hit}")
    return True


def main():
    ok = True
    for name, path, anchor, replacement, expect in MUTATIONS:
        ok &= check(name, path, anchor, replacement, expect)
    failed, crashed, _ = run_suite()
    hook_failed, hook_crashed, _ = run_suite(True)
    failed = failed | hook_failed
    crashed = crashed or hook_crashed
    if failed or crashed:
        print(f"恢复之后仍然不绿：{sorted(failed)}")
        ok = False
    else:
        print("恢复后全绿")
    print("结论：" + ("每条新断言都会喊" if ok else "有空断言"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
