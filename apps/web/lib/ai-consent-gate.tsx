"use client";

/**
 * 2026-08-13（AI 协议前置判断）：所有调用 AI 生成的功能入口统一前置检查。
 *
 * 背景：此前未签署 AI 使用协议时，AI 任务（学习卡生成/题目/评估等）在
 * 服务端静默失败（worker governance 抛 AIConsentRequiredError），前端只在
 * 失败后展示，体验差。现在：点击 AI 功能时先检查 consent（getMe 的
 * aiConsentVersion），未同意 → 弹窗引导到设置页"AI 使用与数据"（model
 * section）签署协议。
 */
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** 当前工作区是否已签署 AI 使用协议（ai-settings 的 aiConsentVersion 非空）。 */
export async function isAIConsentGranted(): Promise<boolean> {
  try {
    const settings = await api.getAIPrivacySettings();
    return Boolean(settings?.aiConsentVersion);
  } catch {
    // 保守 fail-closed：拿不到信息时视为未同意（走引导，不静默提交）。
    return false;
  }
}

export interface AIConsentGate {
  /**
   * 前置检查：已同意 → true（调用方继续执行 AI 操作）；
   * 未同意 → 打开引导弹窗并返回 false（调用方中止）。
   */
  requireConsent(): Promise<boolean>;
  /** 引导弹窗（放在调用方组件树的任意位置）。 */
  dialog: React.ReactElement;
}

export function useAIConsentGate(): AIConsentGate {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<{ resolve: (granted: boolean) => void } | null>(null);

  const requireConsent = useCallback(async (): Promise<boolean> => {
    if (await isAIConsentGranted()) return true;
    return new Promise<boolean>((resolve) => {
      pendingRef.current = { resolve };
      setOpen(true);
    });
  }, []);

  const settle = useCallback((granted: boolean): void => {
    pendingRef.current?.resolve(granted);
    pendingRef.current = null;
    setOpen(false);
  }, []);

  const goSettings = useCallback((): void => {
    settle(false);
    router.push("/settings?section=model");
  }, [router, settle]);

  return {
    requireConsent,
    dialog: (
      <ConfirmDialog
        open={open}
        title="需要先同意 AI 使用协议"
        message="使用 AI 生成功能前，需要先在工作区设置中同意「AI 使用与数据」协议。"
        confirmLabel="去设置"
        cancelLabel="取消"
        onConfirm={goSettings}
        onCancel={() => settle(false)}
      />
    ),
  };
}
