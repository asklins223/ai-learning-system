"use client";

import { useEffect, useState } from "react";
import { CompanionAvatar } from "./CompanionAvatar";
import { api } from "@/lib/api";

type AuthSurface = "login" | "register";

const SAFE_FALLBACK_COPY: Record<AuthSurface, string> = {
  login: "伴星只提供公开帮助，不读取、记录或发送账号与密码输入。",
  register: "伴星只提供公开说明，不读取、记录或发送密码与验证码输入。",
};

/**
 * Credential 页的静态伴星壳。
 *
 * 这个组件不接收表单值，也不绑定输入事件。公开文案优先来自服务端签名
 * manifest；manifest 未验证时只显示固定的零采集安全文案，不把未签名内容
 * 当成产品上下文。
 */
export function CompanionAuthShell({ surface }: { surface: AuthSurface }) {
  const [copy, setCopy] = useState(SAFE_FALLBACK_COPY[surface]);
  const [manifestVerified, setManifestVerified] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getPublicAuthSurfaceManifest()
      .then((result) => {
        if (cancelled || result.testMode) return;
        const entry = result.manifest.surfaces.find(
          (item) => item.surfaceId === `${surface}:static_help` && item.surfaceKind === "static_help",
        );
        if (entry?.textContent) {
          setCopy(entry.textContent);
          setManifestVerified(true);
        }
      })
      .catch(() => {
        // The fixed copy above is the fail-closed path for an unavailable manifest.
      });
    return () => {
      cancelled = true;
    };
  }, [surface]);

  return (
    <aside
      className="companion-auth-shell"
      data-ui="companion-auth-shell"
      data-manifest-verified={manifestVerified ? "true" : "false"}
      aria-label="伴星公开帮助"
    >
      <div className="companion-auth-shell__character" aria-hidden="true">
        <CompanionAvatar state="dormant" size={64} showLabel={false} ariaLabel="学习伴星" />
      </div>
      <div className="companion-auth-shell__copy">
        <span className="companion-auth-shell__eyebrow">学习伴星</span>
        <p>{copy}</p>
        <small>登录后，你可以随时隐藏它；它不会替你填写或提交表单。</small>
      </div>
    </aside>
  );
}
