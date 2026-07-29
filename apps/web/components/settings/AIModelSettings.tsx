"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  type AIPrivacySettings,
  type PersonalAIConnectionTestResult,
  type PersonalAIModelConfig,
  type PersonalAIProvider,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons";

const PROVIDER_DEFAULTS: Record<Exclude<PersonalAIProvider, "mock">, { baseUrl: string; model: string }> = {
  dashscope: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  openai_compatible: {
    baseUrl: "https://api.openai.com/v1",
    model: "",
  },
};

const DEFAULT_POLICY: AIPrivacySettings["aiDataPolicy"] = {
  sendToExternal: false,
  sendImageContent: false,
  piiDetection: true,
  auditLogging: true,
};

function providerLabel(provider: PersonalAIProvider | null): string {
  if (provider === "dashscope") return "阿里云百炼 / DashScope";
  if (provider === "openai_compatible") return "OpenAI-compatible 接口";
  return "系统默认配置";
}

function hasSameEndpointOrigin(previousBaseUrl: string | null, nextBaseUrl: string): boolean {
  if (!previousBaseUrl || !nextBaseUrl.trim()) return false;
  try {
    return new URL(previousBaseUrl).origin === new URL(nextBaseUrl.trim()).origin;
  } catch {
    return false;
  }
}

export function AIModelSettings({ isOwner, accountLoading }: {
  isOwner: boolean;
  accountLoading: boolean;
}) {
  const [config, setConfig] = useState<PersonalAIModelConfig | null>(null);
  const [privacy, setPrivacy] = useState<AIPrivacySettings | null>(null);
  const [provider, setProvider] = useState<PersonalAIProvider>("mock");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDefaultConfirm, setShowDefaultConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<PersonalAIConnectionTestResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextConfig, nextPrivacy] = await Promise.all([
        api.getPersonalAIModelConfig(),
        api.getAIPrivacySettings(),
      ]);
      setConfig(nextConfig);
      setPrivacy(nextPrivacy);
      const nextProvider = nextConfig.provider ?? "mock";
      setProvider(nextProvider);
      if (nextProvider === "mock") {
        setBaseUrl("");
        setModel("");
      } else {
        setBaseUrl(nextConfig.baseUrl ?? PROVIDER_DEFAULTS[nextProvider].baseUrl);
        setModel(nextConfig.model ?? PROVIDER_DEFAULTS[nextProvider].model);
      }
      setApiKey("");
      setConnectionResult(null);
      setPolicy(nextPrivacy.aiDataPolicy);
      setConsent(Boolean(nextPrivacy.aiConsentAt && nextPrivacy.aiConsentVersion));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型配置暂时无法读取");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const external = provider !== "mock";
  const hasReusableKey = Boolean(
    config?.apiKeyHint &&
    config.provider === provider &&
    config.provider !== "mock" &&
    hasSameEndpointOrigin(config.baseUrl, baseUrl),
  );
  const hasPersonalConfig = Boolean(
    config?.configured && config.provider && config.provider !== "mock",
  );
  const modelAvailable = Boolean(config);
  const busy = loading || saving || testing || deleting;

  function clearConnectionResult() {
    setConnectionResult(null);
    setSuccess(null);
    setError(null);
  }

  function changeProvider(nextProvider: PersonalAIProvider) {
    setProvider(nextProvider);
    clearConnectionResult();
    if (nextProvider === "mock") {
      setBaseUrl("");
      setModel("");
      setApiKey("");
      return;
    }
    const defaults = PROVIDER_DEFAULTS[nextProvider];
    if (config?.provider === nextProvider) {
      setBaseUrl(config.baseUrl ?? defaults.baseUrl);
      setModel(config.model ?? defaults.model);
    } else {
      setBaseUrl(defaults.baseUrl);
      setModel(defaults.model);
    }
    setApiKey("");
  }

  function requestSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!external && hasPersonalConfig) {
      setShowDefaultConfirm(true);
      return;
    }
    void save();
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    setConnectionResult(null);
    try {
      if (external && !config?.encryptionReady) {
        throw new Error("服务端尚未配置 AI_CREDENTIAL_ENCRYPTION_KEY，暂时不能安全保存 API Key");
      }
      if (external && !apiKey.trim() && !hasReusableKey) {
        throw new Error("首次配置、切换 Provider 或更换接口域名时需要填写 API Key");
      }
      const saved = await api.savePersonalAIModelConfig({
        provider,
        ...(external ? {
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        } : {}),
      });

      if (isOwner) {
        await api.updateAIDataPolicy(policy);
        if (external && consent && !privacy?.aiConsentAt) {
          await api.updateAIConsent("v0.4-personal-byok-2026-07-18");
        }
      }
      setConfig(saved);
      setApiKey("");
      setShowKey(false);
      const updatedPrivacy = await api.getAIPrivacySettings();
      setPrivacy(updatedPrivacy);
      setPolicy(updatedPrivacy.aiDataPolicy);
      setConsent(Boolean(updatedPrivacy.aiConsentAt && updatedPrivacy.aiConsentVersion));
      setSuccess(
        !external
          ? "已切换为系统默认配置，下一次 AI 任务将使用系统提供的模型。"
          : !updatedPrivacy.aiDataPolicy.sendToExternal || !updatedPrivacy.aiConsentAt
          ? "个人模型已保存；当前工作区尚未允许外发，任务会继续被隐私门禁拦截。"
          : "个人模型配置已保存，下一次由你发起的 AI 任务将使用此配置。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型配置保存失败");
    } finally {
      setSaving(false);
      setShowDefaultConfirm(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setConnectionResult(null);
    setError(null);
    setSuccess(null);
    try {
      if (!external) throw new Error("系统默认配置无需测试外部连接");
      if (!baseUrl.trim()) throw new Error("请填写 API Base URL");
      if (!model.trim()) throw new Error("请填写模型名称");
      if (!apiKey.trim() && !hasReusableKey) {
        throw new Error("请填写 API Key 后再测试连接；更换接口域名时不能复用已保存的 Key");
      }
      const result = await api.testPersonalAIModelConnection({
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setConnectionResult(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "模型连接测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function removeConfig() {
    setDeleting(true);
    setError(null);
    setSuccess(null);
    setConnectionResult(null);
    try {
      await api.deletePersonalAIModelConfig();
      setShowDeleteConfirm(false);
      await load();
      setSuccess("个人模型配置已删除，现已恢复为系统默认配置。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除模型配置失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <form className="settings-ai-card" onSubmit={requestSave}>
        <div className="settings-ai-status">
          <span className={`settings-ai-status-dot ${modelAvailable ? "is-configured" : ""}`} />
          <div>
            <strong>{hasPersonalConfig ? "已启用个人模型配置" : "当前使用系统默认配置"}</strong>
            <small>
              {hasPersonalConfig
                ? `${providerLabel(config?.provider ?? null)}${config?.apiKeyHint ? ` · Key ${config.apiKeyHint}` : ""}`
                : "由系统统一管理，无需填写接口或密钥"}
            </small>
          </div>
          <button type="button" className="settings-icon-button" onClick={() => void load()} disabled={busy} aria-label="刷新模型配置">
            <Icon.Refresh className={loading ? "settings-spin" : undefined} />
          </button>
        </div>

        <div className="settings-ai-grid">
          <label className="settings-field">
            <span>模型来源</span>
            <select value={provider} onChange={(event) => changeProvider(event.target.value as PersonalAIProvider)} disabled={busy}>
              <option value="mock">系统默认</option>
              <option value="dashscope">阿里云百炼 / DashScope</option>
              <option value="openai_compatible">OpenAI-compatible</option>
            </select>
            <small>
              {external
                ? "个人配置只属于当前账户，不影响其他成员。"
                : "使用系统统一维护的模型，可直接开始生成学习卡。"}
            </small>
          </label>

          {external && (
            <>
              <label className="settings-field is-wide">
                <span>API Base URL</span>
                <input type="url" required maxLength={500} value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); clearConnectionResult(); }} placeholder="https://api.example.com/v1" disabled={busy} />
                <small>
                  {provider === "dashscope"
                    ? "仅允许 DashScope 官方 aliyuncs.com 公网 HTTPS 地址；推荐使用 /compatible-mode/v1，Qwen 3.5/3.6 会自动适配兼容协议。"
                    : "仅允许公网 HTTPS 域名；可填写 API 根路径或完整 /chat/completions 地址。"}
                </small>
              </label>
              <label className="settings-field">
                <span>模型名称</span>
                <input required maxLength={200} value={model} onChange={(event) => { setModel(event.target.value); clearConnectionResult(); }} placeholder="qwen-plus / your-model-id" disabled={busy} />
                <small>必须与服务商控制台中的 model id 完全一致。</small>
              </label>
              <label className="settings-field">
                <span>API Key</span>
                <div className="settings-secret-input">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => { setApiKey(event.target.value); clearConnectionResult(); }}
                    placeholder={hasReusableKey && config?.apiKeyHint
                      ? `已保存 ${config.apiKeyHint}；留空表示不更换`
                      : "输入 API Key"}
                    autoComplete="new-password"
                    maxLength={4096}
                    disabled={busy}
                  />
                  <button type="button" onClick={() => setShowKey((value) => !value)} disabled={!apiKey}>
                    {showKey ? "隐藏" : "显示"}
                  </button>
                </div>
                <small>完整 Key 不会回显；数据库只保存 AES-GCM 密文。切换 Provider 或接口域名时必须重新填写。</small>
              </label>
            </>
          )}
        </div>

        {external && (
          <fieldset className="settings-ai-policy" disabled={!isOwner || accountLoading || busy}>
            <legend>当前工作区的外发与审计边界</legend>
            <label>
              <input type="checkbox" checked={policy.sendToExternal} onChange={(event) => setPolicy((value) => ({ ...value, sendToExternal: event.target.checked }))} />
              <span><strong>允许发送到外部模型</strong><small>关闭时，即使个人 Key 已配置，Worker 也不会发送学习内容。</small></span>
            </label>
            <label>
              <input type="checkbox" checked={policy.sendImageContent} onChange={(event) => setPolicy((value) => ({ ...value, sendImageContent: event.target.checked }))} />
              <span><strong>允许发送图片内容</strong><small>单独授权 OCR 与视觉理解；关闭时正文仍可外发，但图片任务会明确等待授权。</small></span>
            </label>
            <label>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={Boolean(privacy?.aiConsentAt) || !isOwner} />
              <span><strong>我确认当前工作区允许使用外部 AI</strong><small>签署后不可在此页撤销历史记录；如需撤销应由管理员更新治理策略。</small></span>
            </label>
            <label>
              <input type="checkbox" checked={policy.piiDetection} onChange={(event) => setPolicy((value) => ({ ...value, piiDetection: event.target.checked }))} />
              <span><strong>发送前检测并脱敏 PII</strong><small>邮箱、手机号、证件号和银行卡号会先做掩码处理。</small></span>
            </label>
            <label>
              <input type="checkbox" checked={policy.auditLogging} onChange={(event) => setPolicy((value) => ({ ...value, auditLogging: event.target.checked }))} />
              <span><strong>记录 AI 调用审计</strong><small>记录操作者、模型、数据类别、耗时与结果，不记录 API Key。</small></span>
            </label>
          </fieldset>
        )}

        {!isOwner && external && (
          <div className="settings-permission-note"><Icon.Lock />个人模型可以保存，但工作区外发策略只能由所有者修改。</div>
        )}
        {external && (
          <div className="settings-permission-note">
            <Icon.Bolt />
            <span>连接测试只发送固定的最小 “OK” 请求，用于验证地址、模型和 Key；不会读取学习内容，也不会保存模型回复。</span>
          </div>
        )}
        {external && config && !config.encryptionReady && (
          <div className="settings-notice is-danger" role="alert"><Icon.Warn /><span>服务端加密密钥未配置，禁止保存个人 API Key。</span></div>
        )}
        {success && <div className="settings-notice is-success" role="status"><Icon.Check /><span>{success}</span></div>}
        {connectionResult && (
          <div className="settings-notice is-success" role="status">
            <Icon.Check />
            <span>连接成功：{providerLabel(connectionResult.provider)} · {connectionResult.model} · {connectionResult.latencyMs} ms</span>
          </div>
        )}
        {error && <div className="settings-notice is-danger" role="alert"><Icon.Warn /><span>{error}</span></div>}

        <div className="settings-ai-actions">
          {external && (
            <button className="settings-secondary-button" type="button" onClick={() => void testConnection()} disabled={busy}>
              {testing ? <Icon.Refresh className="settings-spin" /> : <Icon.Bolt />}
              {testing ? "正在测试连接" : "测试连接"}
            </button>
          )}
          {hasPersonalConfig && (
            <button className="settings-secondary-button is-danger" type="button" onClick={() => setShowDeleteConfirm(true)} disabled={busy}>
              <Icon.Trash />删除个人配置
            </button>
          )}
          <button className="settings-primary-button" type="submit" disabled={busy}>
            {saving ? <Icon.Refresh className="settings-spin" /> : <Icon.Check />}
            {saving
              ? external ? "正在加密保存" : "正在切换"
              : external ? "保存个人模型配置" : "使用系统默认配置"}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={showDefaultConfirm}
        title="改用系统默认配置？"
        message="当前个人模型、接口地址和加密保存的 API Key 将被删除，后续 AI 任务会使用系统默认配置。"
        confirmLabel="确认切换"
        cancelLabel="保留个人配置"
        loading={saving}
        onCancel={() => setShowDefaultConfirm(false)}
        onConfirm={() => void save()}
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        title="删除个人模型配置？"
        message="加密保存的 API Key、接口地址和模型选择都会删除，后续 AI 任务将使用系统默认配置。"
        confirmLabel="确认删除"
        cancelLabel="保留配置"
        loading={deleting}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={() => void removeConfig()}
      />
    </>
  );
}
