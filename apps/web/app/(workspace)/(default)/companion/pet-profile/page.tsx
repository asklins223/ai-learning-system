"use client";

/**
 * 桌宠人格设置（22-real-desktop-pet-memory-context-prd-tdd.md §2.1/§10.2.1）。
 * 预设选择 + 自定义表单 + 示例回复 + 边界 + 保存/重置。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

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
}

interface ProfileForm {
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: "quiet" | "moderate" | "active";
  boundaries: PetProfile["boundaries"];
}

export default function PetProfilePage() {
  const [presets, setPresets] = useState<PetPreset[]>([]);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    void api.getPetProfile().then((result) => {
      setPresets(result.presets as PetPreset[]);
      const p = result.profile as PetProfile | null;
      setActivePresetId(p?.presetId ?? null);
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
      boundaries: {},
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
      const result = await api.updatePetProfile(form);
      const savedProfile = (result as { profile: PetProfile }).profile;
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
      setError(caught instanceof Error ? caught.message : "保存失败");
    }
  }, [form]);

  const reset = useCallback(async () => {
    setError(null);
    try {
      await api.resetPetProfile();
      setForm(null);
      setActivePresetId(null);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重置失败");
    }
  }, []);

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

  if (!form) {
    return (
      <main className="pet-profile-page">
        <h1>桌宠人格</h1>
        {error && <p className="pet-profile-error" role="alert">{error}</p>}
        <p>当前使用系统默认人格。选择一个预设开始自定义：</p>
        {renderPresets()}
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

      <label>
        名字
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>

      <label>
        性格标签（逗号分隔）
        <input
          value={form.personalityTags.join("、")}
          onChange={(e) => setForm({
            ...form,
            personalityTags: e.target.value.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
          })}
        />
      </label>

      <label>
        说话风格
        <textarea
          value={form.speakingStyle}
          onChange={(e) => setForm({ ...form, speakingStyle: e.target.value })}
        />
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
        <legend>示例回复（最多 5 条）</legend>
        {form.examples.map((example, index) => (
          <div className="pet-profile-examples-row" key={index}>
            <input
              value={example.text}
              placeholder={`示例 ${index + 1}`}
              onChange={(e) => updateExample(index, e.target.value)}
            />
            <button type="button" onClick={() => removeExample(index)} aria-label={`删除示例 ${index + 1}`}>
              删除
            </button>
          </div>
        ))}
        <button type="button" className="pet-profile-add-example" onClick={addExample} disabled={form.examples.length >= 5}>
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

      <div className="pet-profile-actions">
        <button type="button" onClick={save}>保存</button>
        <button type="button" onClick={reset}>恢复默认</button>
      </div>
    </main>
  );
}
