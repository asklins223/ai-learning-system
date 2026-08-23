"use client";

/**
 * 桌宠人格设置（22-real-desktop-pet-memory-context-prd-tdd.md §2.1/§10.2.1）。
 * 预设选择 + 自定义表单 + 示例回复 + 边界 + 实时预览 + 保存（revision CAS）/重置。
 */

import { useCallback, useEffect, useState } from "react";
import "../conversations/conversation-page.css";
import { api, ApiError } from "@/lib/api";

interface PetProfile {
  id: string;
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: "quiet" | "moderate" | "active";
  boundaries: { allowPlayful?: boolean; allowNudgeLearning?: boolean; allowVoiceTags?: boolean; catchphrase?: string | null };
  presetId: string | null;
  revision: number;
}

interface PetPreset {
  presetId: string;
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: "quiet" | "moderate" | "active";
  // GET /companion/pet-profile 返回完整预设（含边界默认值）。
  boundaries: PetProfile["boundaries"];
}

interface ProfileForm {
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: "quiet" | "moderate" | "active";
  boundaries: PetProfile["boundaries"];
}

const ACTIVENESS_LABEL: Record<PetProfile["activeness"], string> = {
  quiet: "安静",
  moderate: "适中",
  active: "积极",
};

// 与服务端 petProfileBodySchema（apps/api/src/modules/companion-conversation/pet-profile-routes.ts）
// 对齐的客户端上限：输入控件加 maxLength + 计数提示，超限时禁用保存，避免裸服务端 400。
const NAME_MAX = 60;
const TAG_TEXT_MAX = 20;
const TAG_COUNT_MAX = 10;
const STYLE_MAX = 1000;
const EXAMPLE_TEXT_MAX = 200;
const EXAMPLE_COUNT_MAX = 5;

export default function PetProfilePage() {
  const [presets, setPresets] = useState<PetPreset[]>([]);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // §12.1.3 revision CAS：保存携带读取时的 revision，409 时提示并刷新最新版本。
  const [revision, setRevision] = useState<number | undefined>(undefined);

  const reload = useCallback(() => {
    setError(null);
    void api.getPetProfile().then((result) => {
      setPresets(result.presets as PetPreset[]);
      const p = result.profile as PetProfile | null;
      setActivePresetId(p?.presetId ?? null);
      setRevision(p?.revision);
      setForm(p ? {
        name: p.name,
        personalityTags: p.personalityTags,
        speakingStyle: p.speakingStyle,
        examples: p.examples,
        activeness: p.activeness,
        boundaries: p.boundaries,
      } : null);
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "读取人格失败");
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const applyPreset = useCallback((preset: PetPreset) => {
    setActivePresetId(preset.presetId);
    setForm({
      name: preset.name,
      personalityTags: preset.personalityTags,
      speakingStyle: preset.speakingStyle,
      examples: preset.examples,
      activeness: preset.activeness,
      // 预设自带边界默认值（packages/shared/src/pet-persona-presets.ts 每套预设
      // 都携带 boundaries），应用预设时以其为准，而不是清空成 {}。
      boundaries: preset.boundaries ?? {},
    });
    setSaved(false);
  }, []);

  const updateExample = useCallback((index: number, text: string) => {
    if (!form) return;
    setForm({
      ...form,
      examples: form.examples.map((example, i) => i === index ? { text } : example),
    });
  }, [form]);

  const addExample = useCallback(() => {
    if (!form) return;
    setForm({ ...form, examples: [...form.examples, { text: "" }] });
  }, [form]);

  const removeExample = useCallback((index: number) => {
    if (!form) return;
    setForm({ ...form, examples: form.examples.filter((_, i) => i !== index) });
  }, [form]);

  const updateBoundary = useCallback((key: keyof NonNullable<ProfileForm["boundaries"]>, value: boolean) => {
    if (!form) return;
    setForm({ ...form, boundaries: { ...form.boundaries, [key]: value } });
  }, [form]);

  const save = useCallback(async () => {
    if (!form) return;
    setError(null);
    try {
      const result = await api.updatePetProfile({
        ...form,
        // 首次保存（无已有档案）不带 revision；之后每次携带以启用乐观锁。
        ...(revision !== undefined ? { revision } : {}),
      });
      const savedProfile = (result as { profile: PetProfile }).profile;
      setRevision(savedProfile.revision);
      setForm({
        name: savedProfile.name,
        personalityTags: savedProfile.personalityTags,
        speakingStyle: savedProfile.speakingStyle,
        examples: savedProfile.examples,
        activeness: savedProfile.activeness,
        boundaries: savedProfile.boundaries,
      });
      setActivePresetId(savedProfile.presetId);
      setSaved(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError("人格档案已在其他设备被修改，已为你加载最新版本，请确认后重新保存。");
        reload();
        return;
      }
      setError(caught instanceof Error ? caught.message : "保存失败");
    }
  }, [form, revision, reload]);

  const reset = useCallback(async () => {
    setError(null);
    try {
      await api.resetPetProfile();
      setForm(null);
      setActivePresetId(null);
      setRevision(undefined);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重置失败");
    }
  }, []);

  // 客户端预校验（与服务端 zod 契约一致）：列出全部超限/缺项，禁用保存按钮。
  const validationErrors = (() => {
    if (!form) return [] as string[];
    const errors: string[] = [];
    if (form.name.trim().length === 0) errors.push("名字不能为空");
    else if (form.name.length > NAME_MAX) errors.push(`名字不能超过 ${NAME_MAX} 字`);
    if (form.personalityTags.length < 1) errors.push("至少保留一个性格标签");
    if (form.personalityTags.length > TAG_COUNT_MAX) errors.push(`性格标签最多 ${TAG_COUNT_MAX} 条`);
    const overLimitTags = form.personalityTags.filter((tag) => tag.length > TAG_TEXT_MAX);
    if (overLimitTags.length > 0) {
      errors.push(`性格标签每条不超过 ${TAG_TEXT_MAX} 字（当前超限 ${overLimitTags.length} 条）`);
    }
    if (form.speakingStyle.trim().length === 0) errors.push("说话风格不能为空");
    else if (form.speakingStyle.length > STYLE_MAX) errors.push(`说话风格不能超过 ${STYLE_MAX} 字`);
    if (form.examples.some((example) => example.text.trim().length === 0)) {
      errors.push("示例回复内容不能为空（可删除空行）");
    }
    if (form.examples.some((example) => example.text.length > EXAMPLE_TEXT_MAX)) {
      errors.push(`示例回复每条不超过 ${EXAMPLE_TEXT_MAX} 字`);
    }
    return errors;
  })();
  const profileInvalid = validationErrors.length > 0;

  const renderPresets = () => (
    <div className="pet-profile-presets" role="group" aria-label="预设人格">
      {presets.map((preset) => (
        <button
          key={preset.presetId}
          type="button"
          className={activePresetId === preset.presetId ? "is-active" : undefined}
          onClick={() => applyPreset(preset)}
        >
          {preset.name}
        </button>
      ))}
    </div>
  );

  // §10.2.1 实时预览：跟随表单即时变化，让用户保存前看到桌宠的说话效果。
  const previewExamples = (form?.examples ?? []).map((e) => e.text.trim()).filter(Boolean).slice(0, 3);

  const renderPreview = () => (
    <section className="pet-profile-preview" aria-label="实时预览">
      <p className="pet-profile-preview-title">实时预览</p>
      <div className="pet-profile-preview-card">
        <div className="pet-profile-preview-head">
          <span className="pet-profile-preview-avatar" aria-hidden="true">🐾</span>
          <span className="pet-profile-preview-name">{form?.name || "伴星"}</span>
          {form && <span className="pet-profile-preview-activeness">{ACTIVENESS_LABEL[form.activeness]}</span>}
        </div>
        {(form?.personalityTags.length ?? 0) > 0 && (
          <p className="pet-profile-preview-tags">
            {form?.personalityTags.map((tag) => (
              <span key={tag} className="pet-profile-preview-tag">{tag}</span>
            ))}
          </p>
        )}
        {form?.speakingStyle.trim() && (
          <p className="pet-profile-preview-style">说话风格：{form.speakingStyle}</p>
        )}
        <div className="pet-profile-preview-examples">
          {previewExamples.length > 0 ? (
            previewExamples.map((text, i) => (
              <p key={i} className="pet-profile-preview-bubble">{text}</p>
            ))
          ) : (
            <p className="pet-profile-preview-bubble is-empty">
              暂无示例回复——添加后这里会实时展示桌宠的说话效果。
            </p>
          )}
        </div>
      </div>
    </section>
  );

  if (!form) {
    return (
      <main className="pet-profile-page">
        <h1>桌宠人格</h1>
        {error && <p className="pet-profile-error" role="alert">{error}</p>}
        <p>当前使用系统默认人格。选择一个预设开始自定义：</p>
        {renderPresets()}
        {renderPreview()}
        <div className="pet-profile-actions">
          <button type="button" onClick={reload}>重新加载</button>
        </div>
      </main>
    );
  }

  return (
    <main className="pet-profile-page">
      <h1>桌宠人格</h1>
      {error && <p className="pet-profile-error" role="alert">{error}</p>}
      {saved && <p className="pet-profile-saved">已保存</p>}
      {renderPresets()}
      {renderPreview()}

      <label>
        名字
        <input
          value={form.name}
          maxLength={NAME_MAX}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <small className="pet-profile-count" aria-live="polite">{form.name.length}/{NAME_MAX}</small>
      </label>

      <label>
        性格标签（逗号分隔，最多 {TAG_COUNT_MAX} 条，每条 ≤ {TAG_TEXT_MAX} 字）
        <input
          value={form.personalityTags.join("、")}
          onChange={(e) => setForm({
            ...form,
            personalityTags: e.target.value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
          })}
        />
        <small className="pet-profile-count" aria-live="polite">{form.personalityTags.length}/{TAG_COUNT_MAX} 条</small>
      </label>

      <label>
        说话风格
        <textarea
          value={form.speakingStyle}
          maxLength={STYLE_MAX}
          onChange={(e) => setForm({ ...form, speakingStyle: e.target.value })}
        />
        <small className="pet-profile-count" aria-live="polite">{form.speakingStyle.length}/{STYLE_MAX}</small>
      </label>

      <label>
        主动程度
        <select
          value={form.activeness}
          onChange={(e) => setForm({ ...form, activeness: e.target.value as PetProfile["activeness"] })}
        >
          <option value="quiet">安静</option>
          <option value="moderate">适中</option>
          <option value="active">积极</option>
        </select>
      </label>

      <fieldset className="pet-profile-examples">
        <legend>示例回复（最多 {EXAMPLE_COUNT_MAX} 条，每条 ≤ {EXAMPLE_TEXT_MAX} 字）</legend>
        {form.examples.map((example, index) => (
          <div className="pet-profile-examples-row" key={index}>
            <input
              value={example.text}
              placeholder={`示例 ${index + 1}`}
              maxLength={EXAMPLE_TEXT_MAX}
              onChange={(e) => updateExample(index, e.target.value)}
            />
            <button type="button" onClick={() => removeExample(index)} aria-label={`删除示例 ${index + 1}`}>
              删除
            </button>
          </div>
        ))}
        <button type="button" className="pet-profile-add-example" onClick={addExample} disabled={form.examples.length >= EXAMPLE_COUNT_MAX}>
          + 添加示例
        </button>
      </fieldset>

      <fieldset className="pet-profile-boundaries">
        <legend>边界</legend>
        <label>
          <input
            type="checkbox"
            checked={form.boundaries.allowPlayful ?? false}
            onChange={(e) => updateBoundary("allowPlayful", e.target.checked)}
          />
          允许卖萌
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.boundaries.allowNudgeLearning ?? false}
            onChange={(e) => updateBoundary("allowNudgeLearning", e.target.checked)}
          />
          允许催学习
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.boundaries.allowVoiceTags ?? false}
            onChange={(e) => updateBoundary("allowVoiceTags", e.target.checked)}
          />
          使用语音标签
        </label>
      </fieldset>

      {profileInvalid && (
        <p className="pet-profile-error" role="alert">
          {validationErrors.join("；")}
        </p>
      )}

      <div className="pet-profile-actions">
        <button type="button" onClick={save} disabled={profileInvalid}>保存</button>
        <button type="button" onClick={reset}>恢复默认</button>
      </div>
    </main>
  );
}
