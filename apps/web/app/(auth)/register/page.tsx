"use client";

import "@/app/styles/login.css";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ApiError, api, clearLegacyTokenStorage } from "@/lib/api";
import { AvatarUploader } from "@/components/account/AvatarUploader";
import { Icon } from "@/components/ui/icons";

type FieldErrors = {
  email?: string;
  password?: string;
  displayName?: string;
  inviteToken?: string;
};

function getRegisterErrorMessage(caught: unknown) {
  if (caught instanceof ApiError) {
    switch (caught.code) {
      case "not_found":
        return "邀请链接无效或不存在。";
      case "expired":
        return "邀请链接已过期，请联系工作区所有者重新生成。";
      case "revoked":
        return "邀请链接已被撤销，请联系工作区所有者。";
      case "already_consumed":
        return "邀请链接已被使用。";
      case "email_exists":
        return "该邮箱已注册，请直接登录。";
    }
    if (caught.status === 429) {
      return "注册尝试过于频繁，请稍后再试。";
    }
  }

  const raw = caught instanceof Error ? caught.message : "";
  const normalized = raw.toLowerCase();

  if (normalized.includes("not_found")) {
    return "邀请链接无效或不存在。";
  }
  if (normalized.includes("expired")) {
    return "邀请链接已过期，请联系工作区所有者重新生成。";
  }
  if (normalized.includes("revoked")) {
    return "邀请链接已被撤销，请联系工作区所有者。";
  }
  if (normalized.includes("already_consumed")) {
    return "邀请链接已被使用。";
  }
  if (normalized.includes("email_exists") || normalized.includes("email already exists")) {
    return "该邮箱已注册，请直接登录。";
  }
  if (normalized.includes("fetch") || normalized.includes("network")) {
    return "暂时无法连接服务，请稍后重试。";
  }
  return "注册失败，请稍后重试。";
}

function EyeGlyph({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
      {!visible && <path d="m4 4 16 16" />}
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 7l5 5-5 5" />
    </svg>
  );
}

function InfoGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 8h.01M11 12h1v4h1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<main className="login-page login-page-pending" aria-busy="true" />}>
      <RegisterPageContent />
    </Suspense>
  );
}

function RegisterPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mounted } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // 支持从 URL ?token=xxx 自动填充邀请码
  useEffect(() => {
    const tokenFromUrl = searchParams.get("token");
    if (tokenFromUrl) {
      setInviteToken(tokenFromUrl);
      setInviteOpen(true);
    }
  }, [searchParams]);

  function validate() {
    const errors: FieldErrors = {};
    if (!email.trim()) {
      errors.email = "请输入邮箱";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = "邮箱格式不正确";
    }
    if (!password) {
      errors.password = "请输入密码";
    } else if (password.length < 8) {
      errors.password = "密码至少 8 位";
    }
    if (displayName.trim() && displayName.trim().length > 32) {
      errors.displayName = "昵称最多 32 个字符";
    }
    setFieldErrors(errors);

    if (errors.email) {
      emailRef.current?.focus();
    } else if (errors.password) {
      passwordRef.current?.focus();
    } else if (errors.displayName) {
      displayNameRef.current?.focus();
    }

    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validate()) return;
    setLoading(true);
    try {
      await api.register({
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
        inviteToken: inviteToken.trim() || undefined,
      });
      clearLegacyTokenStorage();

      // 注册成功后，如果有待上传的头像文件，此时已有 session，执行上传
      if (pendingAvatarFile) {
        try {
          const uploadResult = await api.uploadAvatar(pendingAvatarFile);
          await api.updateProfile({ avatarUrl: uploadResult.url });
        } catch {
          // 头像上传失败不阻塞注册流程，用户可稍后在设置中上传
        }
      }

      // 清理本地预览 URL
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);

      router.replace("/");
    } catch (caught) {
      setError(getRegisterErrorMessage(caught));
      window.setTimeout(() => errorRef.current?.focus(), 50);
    } finally {
      setLoading(false);
    }
  }

  if (!mounted) {
    return (
      <main className="login-page login-page-pending" aria-busy="true">
        <span className="login-sr-only">正在准备注册页面</span>
      </main>
    );
  }

  const hasInvite = Boolean(inviteToken.trim());

  return (
    <main className="login-page register-page" data-page-root data-ui="register-page">
      <section className="login-stage register-stage" aria-label="创建理解引擎账号">
        <ThemeToggle className="login-theme-toggle" size="md" />

        <aside className="register-context">
          <header className="register-wordmark" aria-label="理解引擎">
            <span className="register-wordmark-seal" aria-hidden="true">理</span>
            <span className="register-wordmark-name">理解引擎</span>
            <span className="register-wordmark-version">v0.5</span>
          </header>

          <div className="register-context-copy">
            <p className="register-context-kicker">个人理解账本</p>
            <h2 id="register-brand-title">
              把每天学到的，
              <span>沉淀成自己的理解。</span>
            </h2>
            <p>
              从一份独立的个人学习账本开始。笔记、卡片与复习记录都归属于你，
              协作空间则作为可随时切换的补充。
            </p>
          </div>

          <ul className="register-context-highlights" aria-label="个人学习空间特点">
            <li><Icon.Check aria-hidden="true" /><span><strong>个人空间独立</strong><small>笔记与复习记录默认只属于你</small></span></li>
            <li><Icon.Check aria-hidden="true" /><span><strong>学习路径连续</strong><small>材料、学习卡与复习自然衔接</small></span></li>
            <li><Icon.Check aria-hidden="true" /><span><strong>协作按需加入</strong><small>不会替换或合并个人记录</small></span></li>
          </ul>

          <div className="register-personal-note" role="note">
            <InfoGlyph />
            <p>
              <strong>个人空间始终优先。</strong>
              邀请码只会新增一个协作空间，不会替换或合并你的个人记录。
            </p>
          </div>
        </aside>

        <section className="register-form-panel" aria-labelledby="register-form-title">
          <div className="register-form-wrap">
            <header className="register-form-heading">
              <div className="register-form-meta" aria-label="注册说明">
                <span>创建账号</span>
                <span>约 1 分钟</span>
              </div>
              <h1 id="register-form-title">建立个人学习账本</h1>
              <p>先完成账号基础。个性化设置与协作邀请码以后也可以补充。</p>
            </header>

            <form className="register-form" onSubmit={handleSubmit} noValidate>
              <fieldset className="register-section register-section-required">
                <legend className="register-section-heading">
                  <span className="register-section-index" aria-hidden="true">01</span>
                  <span className="register-section-title">
                    <strong>账号基础</strong>
                    <small>用于登录并保护你的学习记录</small>
                  </span>
                  <span className="register-section-badge is-required">必填</span>
                </legend>

                <div className="register-field-grid">
                  <div className="login-field register-field-email">
                    <label htmlFor="email">邮箱</label>
                    <div className="login-input-shell">
                      <input
                        ref={emailRef}
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          if (error) setError(null);
                          if (fieldErrors.email) {
                            setFieldErrors((c) => ({ ...c, email: undefined }));
                          }
                        }}
                        placeholder="name@example.com"
                        autoComplete="email"
                        autoCapitalize="none"
                        inputMode="email"
                        spellCheck={false}
                        disabled={loading}
                        aria-invalid={Boolean(fieldErrors.email)}
                        aria-describedby={fieldErrors.email ? "email-error" : undefined}
                      />
                    </div>
                    {fieldErrors.email && (
                      <span className="login-field-error" id="email-error">
                        {fieldErrors.email}
                      </span>
                    )}
                  </div>

                  <div className="login-field register-field-password">
                    <label htmlFor="password">密码</label>
                    <div className="login-input-shell login-password-shell">
                      <input
                        ref={passwordRef}
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (error) setError(null);
                          if (fieldErrors.password) {
                            setFieldErrors((c) => ({ ...c, password: undefined }));
                          }
                        }}
                        placeholder="至少 8 位"
                        autoComplete="new-password"
                        aria-invalid={Boolean(fieldErrors.password)}
                        aria-describedby={fieldErrors.password ? "password-help password-error" : "password-help"}
                        disabled={loading}
                      />
                      <button
                        className="login-password-toggle"
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        aria-pressed={showPassword}
                        title={showPassword ? "隐藏密码" : "显示密码"}
                        disabled={loading}
                      >
                        <EyeGlyph visible={showPassword} />
                      </button>
                    </div>
                    <span className="login-field-help" id="password-help">至少 8 个字符</span>
                    {fieldErrors.password && (
                      <span className="login-field-error" id="password-error">
                        {fieldErrors.password}
                      </span>
                    )}
                  </div>
                </div>
              </fieldset>

              <details
                className="register-optional-disclosure"
                open={personalizationOpen}
                onToggle={(event) => setPersonalizationOpen(event.currentTarget.open)}
              >
                <summary>
                  <span className="register-disclosure-icon" aria-hidden="true"><Icon.User /></span>
                  <span><strong>添加昵称和头像</strong><small>可选，也可以注册后再完善</small></span>
                  <Icon.Chevron className="register-disclosure-chevron" aria-hidden="true" />
                </summary>
              <fieldset className="register-section register-section-optional">
                <legend className="login-sr-only">个性化资料</legend>

                <div className="register-field-grid">
                  <div className="register-field-avatar register-field-wide">
                    <div className="register-avatar-row">
                      <AvatarUploader
                        currentUrl={avatarPreviewUrl}
                        displayName={displayName}
                        onFileSelected={(file) => {
                          // 清理旧的预览 URL
                          if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
                          const previewUrl = URL.createObjectURL(file);
                          setPendingAvatarFile(file);
                          setAvatarPreviewUrl(previewUrl);
                          setAvatarError(null);
                        }}
                        onError={(msg) => setAvatarError(msg)}
                        disabled={loading}
                        size={72}
                      />
                      <div className="register-avatar-meta">
                        <strong>头像</strong>
                        <span>选填 · 展示在侧栏和个人中心</span>
                      </div>
                    </div>
                    {avatarError && (
                      <span className="login-field-error">{avatarError}</span>
                    )}
                  </div>

                  <div className="login-field register-field-display-name register-field-wide">
                    <label htmlFor="displayName">昵称</label>
                    <div className="login-input-shell">
                      <input
                        ref={displayNameRef}
                        id="displayName"
                        type="text"
                        value={displayName}
                        onChange={(e) => {
                          setDisplayName(e.target.value);
                          if (fieldErrors.displayName) {
                            setFieldErrors((c) => ({ ...c, displayName: undefined }));
                          }
                        }}
                        placeholder="展示在侧栏和工作区名称中"
                        autoComplete="nickname"
                        maxLength={32}
                        disabled={loading}
                        aria-invalid={Boolean(fieldErrors.displayName)}
                        aria-describedby={
                          fieldErrors.displayName
                            ? "displayName-help displayName-error"
                            : "displayName-help"
                        }
                      />
                    </div>
                    <span className="login-field-help" id="displayName-help">最多 32 个字符</span>
                    {fieldErrors.displayName && (
                      <span className="login-field-error" id="displayName-error">
                        {fieldErrors.displayName}
                      </span>
                    )}
                  </div>
                </div>
              </fieldset>
              </details>

              <details
                className={`register-optional-disclosure register-optional-disclosure--invite${hasInvite ? " has-value" : ""}`}
                open={inviteOpen}
                onToggle={(event) => setInviteOpen(event.currentTarget.open)}
              >
                <summary>
                  <span className="register-disclosure-icon" aria-hidden="true"><Icon.Layers /></span>
                  <span>
                    <strong>{hasInvite ? "已识别协作邀请" : "使用协作邀请码"}</strong>
                    <small>{hasInvite ? "注册后自动加入对应工作区" : "收到邀请时再填写"}</small>
                  </span>
                  <Icon.Chevron className="register-disclosure-chevron" aria-hidden="true" />
                </summary>
              <fieldset className={`register-section register-section-invite${hasInvite ? " has-value" : ""}`}>
                <legend className="login-sr-only">协作邀请码</legend>

                <div className="login-field register-field-invite">
                  <label htmlFor="inviteToken">邀请码</label>
                  <div className="login-input-shell">
                    <input
                      id="inviteToken"
                      type="text"
                      value={inviteToken}
                      onChange={(e) => {
                        setInviteToken(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="没有邀请码可直接留空"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={loading}
                      aria-describedby="inviteToken-help"
                    />
                  </div>
                  <div className="register-invite-help" id="inviteToken-help" role="note">
                    <InfoGlyph />
                    <span>
                      个人工作区仍是默认空间；协作空间可在「设置 → 工作区管理」中切换。
                    </span>
                  </div>
                </div>
              </fieldset>
              </details>

              {error && (
                <div
                  ref={errorRef}
                  className="login-form-error register-form-error"
                  role="alert"
                  aria-live="assertive"
                  tabIndex={-1}
                >
                  <span className="login-error-mark" aria-hidden="true">!</span>
                  <span>{error}</span>
                </div>
              )}

              <div className="register-actions">
                <div className="register-action-copy">
                  <strong>从个人空间开始</strong>
                  <span>注册完成后立即进入你的学习账本</span>
                </div>
                <button
                  className="login-submit register-submit"
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                >
                  {loading && <span className="login-loading-spinner" aria-hidden="true" />}
                  <span aria-live="polite">
                    {loading
                      ? "正在注册…"
                      : hasInvite
                        ? "创建账号并加入协作空间"
                        : "创建个人工作区"}
                  </span>
                  {!loading && <ArrowGlyph />}
                </button>
              </div>
            </form>

            <footer className="register-form-footer">
              <span>已有账号？</span>
              <Link href="/login" className="register-login-link">
                直接登录
                <ArrowGlyph />
              </Link>
            </footer>
          </div>
        </section>
      </section>

      <div className="login-page-end" data-ui="page-end" aria-hidden="true" />
    </main>
  );
}
