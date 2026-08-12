"use client";

import "@/app/styles/login.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { api, setToken } from "@/lib/api";

type FieldErrors = {
  email?: string;
  password?: string;
};

function getLoginErrorMessage(caught: unknown) {
  const raw = caught instanceof Error ? caught.message : "";
  const normalized = raw.toLowerCase();

  if (normalized.includes("无法保存登录状态")) {
    return raw;
  }

  if (normalized.includes("401") || normalized.includes("invalid credentials")) {
    return "邮箱或密码不正确，请检查后重试。";
  }

  if (normalized.includes("fetch") || normalized.includes("network")) {
    return "暂时无法连接服务，请稍后重试。";
  }

  if (normalized.includes("429")) {
    return "登录尝试过于频繁，请稍后再试。";
  }

  if (/\b5\d\d\b/.test(normalized)) {
    return "登录服务暂时不可用，请稍后重试。";
  }

  return "登录失败，请稍后重试。";
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

export default function LoginPage() {
  const router = useRouter();
  const { mounted } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // 默认使用 sessionStorage；只有用户在私人设备上明确选择后才持久化。
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let sessionCheckTimer: number | undefined;

    async function restoreSession() {
      const verification = api.getMe().then(
        () => "valid" as const,
        () => "invalid" as const,
      );
      const result = await Promise.race([
        verification,
        new Promise<"timeout">((resolve) => {
          sessionCheckTimer = window.setTimeout(() => resolve("timeout"), 1_800);
        }),
      ]);
      if (sessionCheckTimer !== undefined) window.clearTimeout(sessionCheckTimer);

      if (result === "valid") {
        if (!cancelled) router.replace("/");
        return;
      }
      // A 401 clears stale legacy storage in the shared API client. Network
      // errors and slow requests leave the form available.

      if (cancelled) return;
      if (process.env.NODE_ENV === "development") {
        setEmail("owner@ailearn.local");
        setPassword("ailearn_owner");
      }
      setCheckingSession(false);
    }

    void restoreSession();
    return () => {
      cancelled = true;
      if (sessionCheckTimer !== undefined) window.clearTimeout(sessionCheckTimer);
    };
  }, [router]);

  function validate() {
    const nextErrors: FieldErrors = {};
    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      nextErrors.email = "请输入邮箱";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      nextErrors.email = "请输入有效的邮箱地址";
    }

    if (!password) {
      nextErrors.password = "请输入密码";
    }

    setFieldErrors(nextErrors);

    if (nextErrors.email) {
      emailRef.current?.focus();
    } else if (nextErrors.password) {
      passwordRef.current?.focus();
    }

    return Object.keys(nextErrors).length === 0;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!validate()) return;

    setLoading(true);
    try {
      await api.login(email.trim(), password, remember);
      // The API now sets an HttpOnly session cookie. Clear any pre-migration
      // bearer token without persisting the new response token.
      setToken(null);
      router.replace("/");
    } catch (caught: unknown) {
      setError(getLoginErrorMessage(caught));
      window.setTimeout(() => errorRef.current?.focus(), 50);
    } finally {
      setLoading(false);
    }
  }

  if (!mounted || checkingSession) {
    return (
      <main className="login-page login-page-pending" aria-busy="true">
        <span className="login-sr-only">正在准备登录页面</span>
      </main>
    );
  }

  return (
    <main className="login-page" data-page-root data-ui="login-page">
      <section className="login-stage" aria-labelledby="login-brand-title">
        <ThemeToggle className="login-theme-toggle" size="md" />

        <div className="login-brand-panel">
          <header className="login-wordmark" aria-label="理解引擎">
            <span className="login-wordmark-seal" aria-hidden="true">理</span>
            <span className="login-wordmark-name">理解引擎</span>
            <span className="login-wordmark-dot" aria-hidden="true" />
          </header>

          <div className="login-brand-copy">
            <p className="login-eyebrow">个人理解工作台</p>
            <h1 id="login-brand-title">
              把看过的内容，
              <span>变成能被验证的理解。</span>
            </h1>
            <p className="login-brand-description">
              整理资料、对齐证据、主动回忆。
              <br />
              让每一次学习，都有清楚的下一步。
            </p>
          </div>

          <div className="login-learning-paper" aria-label="理解路径">
            <div className="login-paper-heading">
              <span className="login-paper-kicker">理解路径</span>
              <span className="login-paper-rule" aria-hidden="true" />
              <span className="login-paper-note">从输入到掌握</span>
            </div>
            <ol className="login-path-list">
              <li>
                <span className="login-path-index">01</span>
                <span className="login-path-copy">
                  <strong>引入材料</strong>
                  <small>保留原文与来源</small>
                </span>
              </li>
              <li>
                <span className="login-path-index">02</span>
                <span className="login-path-copy">
                  <strong>建立理解</strong>
                  <small>形成清晰的学习卡</small>
                </span>
              </li>
              <li>
                <span className="login-path-index">03</span>
                <span className="login-path-copy">
                  <strong>主动验证</strong>
                  <small>回答并回到证据</small>
                </span>
              </li>
            </ol>
          </div>

          <div className="login-mobile-path" aria-hidden="true">
            <span>材料</span>
            <i />
            <span>理解</span>
            <i />
            <span>验证</span>
          </div>
        </div>

        <div className="login-form-panel">
          <div className="login-form-wrap">
            <div className="login-form-heading">
              <span className="login-form-kicker">欢迎回来</span>
              <h2>继续你的学习</h2>
              <p>登录后回到个人理解工作区</p>
            </div>

            <form className="login-form" onSubmit={onSubmit} noValidate>
              <div className="login-field">
                <label htmlFor="email">邮箱</label>
                <div className="login-input-shell">
                  <input
                    ref={emailRef}
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      if (error) setError(null);
                      if (fieldErrors.email) {
                        setFieldErrors((current) => ({ ...current, email: undefined }));
                      }
                    }}
                    autoComplete="email"
                    autoCapitalize="none"
                    inputMode="email"
                    spellCheck={false}
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={fieldErrors.email ? "email-error" : undefined}
                    placeholder="name@example.com"
                    disabled={loading}
                  />
                </div>
                {fieldErrors.email && (
                  <span className="login-field-error" id="email-error">
                    {fieldErrors.email}
                  </span>
                )}
              </div>

              <div className="login-field">
                <label htmlFor="password">密码</label>
                <div className="login-input-shell login-password-shell">
                  <input
                    ref={passwordRef}
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (error) setError(null);
                      if (fieldErrors.password) {
                        setFieldErrors((current) => ({ ...current, password: undefined }));
                      }
                    }}
                    autoComplete="current-password"
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={fieldErrors.password ? "password-error" : undefined}
                    placeholder="请输入密码"
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
                {fieldErrors.password && (
                  <span className="login-field-error" id="password-error">
                    {fieldErrors.password}
                  </span>
                )}
              </div>

              <div className="login-options">
                <label className="login-remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                    disabled={loading}
                  />
                  <span className="login-checkbox-mark" aria-hidden="true" />
                  <span>在此私人设备保持登录</span>
                </label>
                {process.env.NODE_ENV === "development" && (
                  <span className="login-dev-badge">开发环境已预填</span>
                )}
              </div>

              {error && (
                <div
                  ref={errorRef}
                  className="login-form-error"
                  role="alert"
                  aria-live="assertive"
                  tabIndex={-1}
                >
                  <span className="login-error-mark" aria-hidden="true">!</span>
                  <span>{error}</span>
                </div>
              )}

              <button className="login-submit" type="submit" disabled={loading} aria-busy={loading}>
                {loading && <span className="login-loading-spinner" aria-hidden="true" />}
                <span aria-live="polite">{loading ? "正在进入工作区…" : "进入工作区"}</span>
                {!loading && <ArrowGlyph />}
              </button>
            </form>

            <footer className="login-form-footer">
              <span className="login-footer-line" aria-hidden="true" />
              <span>理解引擎 v0.5 · 个人工作区优先</span>
              <span className="login-footer-line" aria-hidden="true" />
            </footer>

            <div className="login-register-cta">
              <span className="login-register-text">没有账号？</span>
              <Link href="/register" className="login-register-link">
                立即注册
                <ArrowGlyph />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="login-page-end" data-ui="page-end" aria-hidden="true" />
    </main>
  );
}
