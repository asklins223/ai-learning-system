"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type AIPrivacySettings } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

const DEFAULT_POLICY: AIPrivacySettings["aiDataPolicy"] = {
  sendToExternal: false,
  sendImageContent: false,
  piiDetection: true,
  auditLogging: true,
};

export function AIPrivacySettings({ isOwner, accountLoading }: {
  isOwner: boolean;
  accountLoading: boolean;
}) {
  const [privacy, setPrivacy] = useState<AIPrivacySettings | null>(null);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextPrivacy = await api.getAIPrivacySettings();
      setPrivacy(nextPrivacy);
      setPolicy(nextPrivacy.aiDataPolicy);
      setConsent(Boolean(nextPrivacy.aiConsentAt && nextPrivacy.aiConsentVersion));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "隐私策略暂时无法读取");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = loading || savingPolicy || accountLoading;

  async function savePolicy() {
    setSavingPolicy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.updateAIDataPolicy(policy);
      if (isOwner && consent && !privacy?.aiConsentAt) {
        await api.updateAIConsent("v0.6-single-config-2026-08-05");
      }
      const updatedPrivacy = await api.getAIPrivacySettings();
      setPrivacy(updatedPrivacy);
      setPolicy(updatedPrivacy.aiDataPolicy);
      setConsent(Boolean(updatedPrivacy.aiConsentAt && updatedPrivacy.aiConsentVersion));
      setSuccess("工作区隐私策略已更新。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "隐私策略保存失败");
    } finally {
      setSavingPolicy(false);
    }
  }

  if (loading) {
    return (
      <div className="settings-ai-card">
        <div className="settings-ai-status">
          <Icon.Refresh className="settings-spin" />
          <span>正在加载隐私策略…</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <fieldset className="settings-ai-policy" disabled={!isOwner || accountLoading || busy}>
        <legend>当前工作区的外发与审计边界</legend>
        <label>
          <input type="checkbox" checked={policy.sendToExternal} onChange={(event) => setPolicy((value) => ({ ...value, sendToExternal: event.target.checked }))} />
          <span><strong>允许发送到外部模型</strong><small>关闭时，Worker 不会发送学习内容到外部 AI 模型。</small></span>
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
        <div className="settings-ai-actions">
          <button className="settings-primary-button" type="button" onClick={() => void savePolicy()} disabled={busy}>
            {savingPolicy ? <Icon.Refresh className="settings-spin" /> : <Icon.Check />}
            {savingPolicy ? "正在保存" : "保存隐私策略"}
          </button>
        </div>
      </fieldset>

      {!isOwner && (
        <div className="settings-permission-note"><Icon.Lock />工作区外发策略只能由所有者修改。</div>
      )}
      {success && <div className="settings-notice is-success" role="status"><Icon.Check /><span>{success}</span></div>}
      {error && <div className="settings-notice is-danger" role="alert"><Icon.Warn /><span>{error}</span></div>}
    </>
  );
}
