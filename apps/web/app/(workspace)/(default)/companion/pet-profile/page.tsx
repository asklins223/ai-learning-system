"use client";

/**
 * 桌宠人格设置（22-real-desktop-pet-memory-context-prd-tdd.md §2.1/§10.2.1）。
 * 预设选择 + 自定义表单 + 保存/重置。
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

export default function PetProfilePage() {
  const [presets, setPresets] = useState<PetPreset[]>([]);
  const [form, setForm] = useState<{
    name: string;
    personalityTags: string[];
    speakingStyle: string;
    examples: { text: string }[];
    activeness: "quiet" | "moderate" | "active";
    boundaries: PetProfile["boundaries"];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    void api.getPetProfile().then((result) => {
      setPresets(result.presets as PetPreset[]);
      const p = result.profile as PetProfile | null;
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

  const save = useCallback(async () => {
    if (!form) return;
    setError(null);
    try {
      const result = await api.updatePetProfile(form);
      setForm((result as { profile: PetProfile }).profile);
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
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重置失败");
    }
  }, []);

  if (!form) {
    return (
      <main className="pet-profile-page">
        <h1>桌宠人格</h1>
        {error && <p className="pet-profile-error">{error}</p>}
        <p>当前使用系统默认人格。</p>
        <div className="pet-profile-presets">
          {presets.map((preset) => (
            <button key={preset.presetId} type="button" onClick={() => applyPreset(preset)}>
              {preset.name}
            </button>
          ))}
        </div>
        <button type="button" onClick={reload}>重新加载</button>
      </main>
    );
  }

  return (
    <main className="pet-profile-page">
      <h1>桌宠人格</h1>
      {error && <p className="pet-profile-error" role="alert">{error}</p>}
      {saved && <p className="pet-profile-saved">已保存</p>}
      <div className="pet-profile-presets">
        {presets.map((preset) => (
          <button key={preset.presetId} type="button" onClick={() => applyPreset(preset)}>
            {preset.name}
          </button>
        ))}
      </div>
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
      <div className="pet-profile-actions">
        <button type="button" onClick={save}>保存</button>
        <button type="button" onClick={reset}>恢复默认</button>
      </div>
    </main>
  );
}
