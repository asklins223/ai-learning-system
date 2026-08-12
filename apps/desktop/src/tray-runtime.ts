/**
 * P6 顺序 8：tray/menu bar 运行时接线（Electron Tray）。
 * 纯逻辑在 tray-menu.ts（可测）；此处只做 Electron 映射。
 * 失败安全：headless/无图标/异常时返回 null（不阻塞启动）。
 */

import { app, Menu, nativeImage, Tray } from "electron";
import { buildPetTrayMenu } from "./tray-menu.ts";

export interface PetTrayOptions {
  getPetVisible(): boolean;
  /** 更新状态投影（托盘据此切换“检查更新”/“安装更新 vX”）。 */
  getUpdateState(): { phase: string; version?: string } | undefined;
  onTogglePet(): void;
  onOpenMain(): void;
  /** 2026-08-11：检查更新入口 */
  onCheckUpdate(): void;
  iconPath: string;
}

export function setupPetTray(opts: PetTrayOptions): Tray | null {
  try {
    const icon = nativeImage.createFromPath(opts.iconPath);
    const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    const refresh = () => {
      tray.setContextMenu(
        Menu.buildFromTemplate(
          buildPetTrayMenu({
            petVisible: opts.getPetVisible(),
            update: opts.getUpdateState(),
          }).map((item) => ({
            label: item.label,
            enabled: item.enabled,
            click: () => {
              if (item.role === "togglePet") {
                opts.onTogglePet();
                refresh();
              }
              if (item.role === "openMain") opts.onOpenMain();
              if (item.role === "checkUpdate") opts.onCheckUpdate();
              if (item.role === "quit") app.quit();
            },
          })),
        ),
      );
    };
    refresh();
    // 暴露 refresh 供窗口可见性变化时同步菜单标签（隐藏宠物/显示宠物）。
    (tray as Tray & { refreshPetTrayMenu?: () => void }).refreshPetTrayMenu = refresh;
    return tray;
  } catch {
    // tray 创建失败不阻塞启动（无头/CI/无图标资源）
    return null;
  }
}
