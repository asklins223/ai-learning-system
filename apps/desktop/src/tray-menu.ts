/**
 * P6 顺序 8：tray/menu bar 菜单配置（纯逻辑，可测）。
 *
 * 不依赖 Electron：返回菜单项描述（id/label/role），由 main 进程映射为
 * Electron Menu/Tray。菜单语义（P6 §10.3-8）：
 * - 显示/隐藏 Pet（toggle）；
 * - 打开主窗口；
 * - 离开（quit，macOS 用 app.quit）。
 */

export interface TrayMenuItem {
  id: string;
  label: string;
  role?: "quit" | "togglePet" | "openMain" | "checkUpdate";
  enabled: boolean;
}

/** 更新状态投影（来自 UpdateStateMachine 快照，仅取托盘需要的最小字段）。 */
export interface TrayUpdateProjection {
  phase: string;
  version?: string;
}

export function buildPetTrayMenu(state: {
  petVisible: boolean;
  update?: TrayUpdateProjection;
}): TrayMenuItem[] {
  const ready = state.update?.phase === "ready";
  return [
    {
      id: "toggle-pet",
      label: state.petVisible ? "隐藏宠物" : "显示宠物",
      role: "togglePet",
      enabled: true,
    },
    {
      id: "open-main",
      label: "打开主窗口",
      role: "openMain",
      enabled: true,
    },
    {
      // 2026-08-11：更新闭环入口——此前自动更新仅启动检查且无 UI 触发点
      // 2026-08-12：ready 后同一入口变为“安装更新”（下载完成，安装需手动确认）
      id: "check-update",
      label: ready
        ? state.update?.version
          ? `安装更新 ${state.update.version}`
          : "安装更新"
        : "检查更新",
      role: "checkUpdate",
      enabled: true,
    },
    { id: "quit", label: "退出", role: "quit", enabled: true },
  ];
}
