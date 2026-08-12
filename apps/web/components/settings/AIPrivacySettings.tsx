"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AIPrivacySettings as AIPrivacySettingsState } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

const CONSENT_VERSION = "v0.7-ai-use-2026-08-12";

const DEFAULT_POLICY: AIPrivacySettingsState["aiDataPolicy"] = {
  sendToExternal: false,
  sendImageContent: false,
  piiDetection: true,
  auditLogging: true,
};

function signedAtLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function AIPrivacySettings({ isOwner, accountLoading }: {
  isOwner: boolean;
  accountLoading: boolean;
}) {
  const [privacy, setPrivacy] = useState<AIPrivacySettingsState | null>(null);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextPrivacy = await api.getAIPrivacySettings();
      setPrivacy(nextPrivacy);
      setPolicy(nextPrivacy.aiDataPolicy);
      setAgreementAccepted(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 使用设置暂时无法读取");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const consentSigned = Boolean(privacy?.aiConsentAt && privacy.aiConsentVersion);
  const consentRequired = privacy?.requiresAIConsent ?? false;
  const needsSignature = consentRequired && !consentSigned;
  const ready = !consentRequired || (consentSigned && policy.sendToExternal);
  const signedLabel = useMemo(
    () => signedAtLabel(privacy?.aiConsentAt ?? null),
    [privacy?.aiConsentAt],
  );
  const busy = loading || saving || accountLoading;

  async function save() {
    if (!privacy || busy || !isOwner) return;
    if (needsSignature && policy.sendToExternal && !agreementAccepted) {
      setError("启用外部 AI 前，请先阅读并确认本工作区的 AI 使用协议。");
      document.getElementById("ai-consent-accept")?.focus();
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await api.updateAIDataPolicy(policy);
      if (needsSignature && policy.sendToExternal) {
        await api.updateAIConsent(CONSENT_VERSION);
      }
      const updated = await api.getAIPrivacySettings();
      setPrivacy(updated);
      setPolicy(updated.aiDataPolicy);
      setAgreementAccepted(false);
      setSuccess(
        updated.aiDataPolicy.sendToExternal
          ? "AI 使用设置已保存，新的任务可以按当前数据范围运行。"
          : "外部 AI 已停用，新的任务不会发送学习内容。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 使用设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="settings-ai-loading" role="status" aria-live="polite">
        <Icon.Refresh className="settings-spin" />
        <span>正在确认 AI 使用状态…</span>
      </div>
    );
  }

  if (!privacy) {
    return (
      <div className="settings-notice is-danger" role="alert">
        <Icon.Warn aria-hidden="true" />
        <span>{error ?? "AI 使用设置暂时无法读取"}</span>
        <button type="button" onClick={() => void load()}>重试</button>
      </div>
    );
  }

  const status = needsSignature
    ? { tone: "attention", label: "待签署", title: "需要确认 AI 使用协议" }
    : ready
      ? { tone: "ready", label: "已启用", title: "外部 AI 可以按当前策略工作" }
      : { tone: "off", label: "已停用", title: "当前不会向外部 AI 发送内容" };

  return (
    <div className="settings-ai-workspace" data-ready={ready ? "true" : "false"}>
      <section className={`settings-ai-overview is-${status.tone}`} aria-labelledby="settings-ai-status-title">
        <span className="settings-ai-overview-icon" aria-hidden="true">
          {ready ? <Icon.Check /> : needsSignature ? <Icon.Lock /> : <Icon.Sparkle />}
        </span>
        <div className="settings-ai-overview-copy">
          <span className="settings-ai-eyebrow">当前工作区</span>
          <h3 id="settings-ai-status-title">{status.title}</h3>
          <p>
            {needsSignature
              ? "协议未签署时，依赖外部模型的生成、评估和讲解任务会安全停止。"
              : ready
                ? "系统模型由部署配置统一管理；这里仅决定学习内容是否可以外发以及外发范围。"
                : "本地功能仍可使用；依赖外部模型的任务会保持关闭。"}
          </p>
        </div>
        <span className="settings-ai-status-badge">{status.label}</span>
      </section>

      {needsSignature && (
        <section className="settings-ai-consent" id="ai-consent" aria-labelledby="settings-ai-consent-title">
          <header>
            <span aria-hidden="true"><Icon.Lock /></span>
            <div>
              <span className="settings-ai-eyebrow">启用前确认</span>
              <h3 id="settings-ai-consent-title">AI 使用协议</h3>
              <p>签署只作用于当前工作区，由工作区所有者完成。</p>
            </div>
          </header>
          <ul>
            <li><Icon.Check aria-hidden="true" /><span>仅在执行所选 AI 任务时发送必要的学习片段，不发送账号密码或 API Key。</span></li>
            <li><Icon.Check aria-hidden="true" /><span>图片内容需要单独开启；默认只允许文本任务。</span></li>
            <li><Icon.Check aria-hidden="true" /><span>可随时关闭后续外发；关闭不会删除已产生的学习记录或审计事实。</span></li>
          </ul>
          <label className="settings-ai-consent-accept" htmlFor="ai-consent-accept">
            <input
              id="ai-consent-accept"
              type="checkbox"
              checked={agreementAccepted}
              disabled={!isOwner || busy}
              onChange={(event) => {
                setAgreementAccepted(event.target.checked);
                if (error) setError(null);
              }}
            />
            <span>
              <strong>我已阅读并同意为当前工作区启用外部 AI</strong>
              <small>保存时将记录协议版本、签署时间与签署人。</small>
            </span>
          </label>
        </section>
      )}

      {consentSigned && (
        <div className="settings-ai-signed" role="status">
          <Icon.Check aria-hidden="true" />
          <span>
            <strong>协议已签署</strong>
            <small>{signedLabel ? `${signedLabel} · ` : ""}版本 {privacy.aiConsentVersion}</small>
          </span>
        </div>
      )}

      <fieldset className="settings-ai-controls" disabled={!isOwner || busy}>
        <legend>
          <span className="settings-ai-eyebrow">数据范围</span>
          <strong>决定 AI 可以接收什么</strong>
        </legend>

        <label className="settings-ai-control-row">
          <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Sparkle /></span>
          <span className="settings-ai-control-copy">
            <strong>允许外部 AI 处理学习内容</strong>
            <small>总开关。关闭后，新的生成、评估和讲解任务不会外发内容。</small>
          </span>
          <span className="settings-switch">
            <input
              type="checkbox"
              checked={policy.sendToExternal}
              onChange={(event) => {
                const enabled = event.target.checked;
                setPolicy((value) => ({
                  ...value,
                  sendToExternal: enabled,
                  sendImageContent: enabled ? value.sendImageContent : false,
                }));
                setSuccess(null);
              }}
              aria-label="允许外部 AI 处理学习内容"
            />
            <i aria-hidden="true" />
          </span>
        </label>

        <label className="settings-ai-control-row">
          <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Eye /></span>
          <span className="settings-ai-control-copy">
            <strong>允许发送图片内容</strong>
            <small>仅用于你主动发起的 OCR 或视觉理解任务；文本外发不需要此项。</small>
          </span>
          <span className="settings-switch">
            <input
              type="checkbox"
              checked={policy.sendImageContent}
              disabled={!policy.sendToExternal || !isOwner || busy}
              onChange={(event) => setPolicy((value) => ({ ...value, sendImageContent: event.target.checked }))}
              aria-label="允许发送图片内容"
            />
            <i aria-hidden="true" />
          </span>
        </label>

        <label className="settings-ai-control-row">
          <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Lock /></span>
          <span className="settings-ai-control-copy">
            <strong>发送前检测并脱敏个人信息</strong>
            <small>识别邮箱、手机号、证件号和银行卡号，并在外发前做掩码处理。</small>
          </span>
          <span className="settings-switch">
            <input
              type="checkbox"
              checked={policy.piiDetection}
              onChange={(event) => setPolicy((value) => ({ ...value, piiDetection: event.target.checked }))}
              aria-label="发送前检测并脱敏个人信息"
            />
            <i aria-hidden="true" />
          </span>
        </label>

        <label className="settings-ai-control-row">
          <span className="settings-ai-control-icon" aria-hidden="true"><Icon.Notepad /></span>
          <span className="settings-ai-control-copy">
            <strong>记录 AI 调用审计</strong>
            <small>记录操作者、模型、数据类别、耗时与结果，不记录输入正文或 API Key。</small>
          </span>
          <span className="settings-switch">
            <input
              type="checkbox"
              checked={policy.auditLogging}
              onChange={(event) => setPolicy((value) => ({ ...value, auditLogging: event.target.checked }))}
              aria-label="记录 AI 调用审计"
            />
            <i aria-hidden="true" />
          </span>
        </label>
      </fieldset>

      <footer className="settings-ai-footer">
        <p>
          {!isOwner
            ? "你可以查看当前策略；只有工作区所有者可以修改或签署。"
            : needsSignature && policy.sendToExternal
              ? "勾选协议确认后保存，即可恢复因未签署而停止的 AI 任务。"
              : "更改只影响之后发起的任务。"}
        </p>
        <button
          className="settings-primary-button"
          type="button"
          onClick={() => void save()}
          disabled={busy || !isOwner || (needsSignature && policy.sendToExternal && !agreementAccepted)}
        >
          {saving ? <Icon.Refresh className="settings-spin" /> : <Icon.Check />}
          {saving ? "正在保存" : needsSignature && policy.sendToExternal ? "签署并启用" : "保存 AI 设置"}
        </button>
      </footer>

      {success && <div className="settings-notice is-success" role="status"><Icon.Check /><span>{success}</span></div>}
      {error && <div className="settings-notice is-danger" role="alert"><Icon.Warn /><span>{error}</span></div>}
    </div>
  );
}
