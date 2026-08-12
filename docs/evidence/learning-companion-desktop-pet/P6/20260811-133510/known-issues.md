# P6 known-issues（进行中；随 P6 步骤更新）

## 新增（P6）

1. **Windows 真机验证缺失（P6-6）**
   - 宿主为 macOS arm64，无法真机验证 Windows 窗口/DPI/音频/签名/安装。
   - 代码层审查：main.ts darwin 专用 titleBar、win32/linux 走默认标题栏；DPI scaleFactor 传递（pet-window-state.ts:158）；音频在 renderer（无 main 平台特定音频代码）。
   - 待办：Windows 真机或 CI runner 验证后解除。
2. **Linux X11/Wayland 真机验证缺失（P6-7）**
   - 代码层：`forwardedClickThrough: process.platform !== "linux"`（X11 transparent click-through 支持差，合理禁用）；无 X11/Wayland 特定依赖。
   - 按 §10.3「未通过则明确不支持」：真机验证前 Linux 明确声明为未验证/不支持。
3. **24h soak 与真机启动/GPU/音频验证（P6-5/P6-10）**
   - 宿主 GUI 受限，Electron 真机启动、GPU process、MediaStreamTrack、休眠/锁屏/显示器拔插等场景需人工真机执行；soak 采样器代码可交付，真机采样记录待执行。

## 既有（P3–P5 延续）

4. desktop dmg hdiutil/APFS 宿主限制（.app 可产出；dmg 未完成）。
5. make verify coverage gate 本地 fail-closed（CI 专用基准）。
6. worker 组合测试 runner 挂起（各 handler 单独跑绿）。
7. Docker buildx 权限（宿主受限）。
8. 容器 migrate journal 路径已根治（migrate.ts 逐条 hash 跳过）；CI 环境需确认 0090–0095 应用。

9. **旧 Anchor/Panel 删除 Gate（P6-11）**
   - Gate 结果：旧实现无代码引用（`CompanionAnchor.tsx`/`QuietAnchor.tsx`/`CompanionSidePanel` 仅在 `companion-control-state.ts:8` 注释提及；pages/app 无 import）——**可删**。
   - 待删清单（`apps/web/features/companion/` 旧 feature + `apps/web/components/learning-companion/QuietAnchor.tsx` + `CompanionShell.tsx` 等）。
   - 铁律：非本会话文件不删除 → **删除动作需 Owner 显式确认后执行**（或移入归档目录）。
   - 可恢复迁移：git 未提交（工作区），删除前需先 commit/归档（`docs/archive/`）保证可恢复。
