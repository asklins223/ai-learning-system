"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import "@/app/styles/one-take-learning.css";

const scenes = [
  { id: "collect", index: "01", label: "收进来", title: "先不要整理。", body: "把你真正想弄懂的东西，先放进来。材料不必完美，理解会在之后自己找到形状。" },
  { id: "shape", index: "02", label: "长出关系", title: "它开始和别的东西相遇。", body: "海马体、慢波睡眠、突触可塑性，不再是三个孤零零的词。它们开始互相解释。" },
  { id: "test", index: "03", label: "接受验证", title: "真正的理解，要经得起追问。", body: "伴星不会替你回答。它只会追问到你终于能用自己的话，把这条线说清楚。" },
  { id: "remember", index: "04", label: "留下来", title: "当一条线被验证，它就会留下。", body: "你的理解变成可追溯的记忆，知道来自哪里，也知道下一次什么时候回来。" },
] as const;

const fragments = ["睡眠", "海马体", "再激活", "慢波", "突触", "记忆", "巩固", "提取"];

function Arrow() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M5 12h13m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function OrbitGlyph() {
  return <svg viewBox="0 0 40 40" aria-hidden="true" fill="none"><ellipse cx="20" cy="20" rx="15" ry="7" transform="rotate(-28 20 20)" stroke="currentColor" strokeWidth="1.1" /><ellipse cx="20" cy="20" rx="15" ry="7" transform="rotate(48 20 20)" stroke="currentColor" strokeWidth="1.1" opacity=".6" /><circle cx="20" cy="20" r="2.4" fill="currentColor" /></svg>;
}

export default function OneTakeLearningPage() {
  const [progress, setProgress] = useState(0);
  const [echoOpen, setEchoOpen] = useState(false);
  const [probeStarted, setProbeStarted] = useState(false);

  useEffect(() => {
    let frame = 0;
    const readScroll = () => {
      frame = 0;
      const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      setProgress(Math.max(0, Math.min(1, window.scrollY / range)));
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(readScroll);
    };
    readScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const sceneIndex = Math.min(scenes.length - 1, Math.floor(progress * scenes.length));
  const scene = scenes[sceneIndex];
  const localProgress = progress * scenes.length - sceneIndex;
  const pageStyle = { "--take-progress": progress, "--take-local": localProgress } as CSSProperties;
  const sceneLabel = useMemo(() => `${scene.index} / ${String(scenes.length).padStart(2, "0")}`, [scene.index]);

  const jumpToScene = (index: number) => {
    const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: (index / scenes.length) * range, behavior: "smooth" });
  };

  return (
    <main className={`one-take-page one-take-page--${scene.id}`} style={pageStyle}>
      <header className="one-take-topbar">
        <a href="/home-redesign" className="one-take-brand" aria-label="返回设计实验室"><span className="one-take-brand-mark"><i /><i /><i /></span><span>理解引擎</span><small>ONE TAKE / 01</small></a>
        <div className="one-take-topbar-status"><i /> 一次连续的理解旅程</div>
        <button type="button" className={`one-take-echo-trigger${echoOpen ? " is-open" : ""}`} onClick={() => setEchoOpen((value) => !value)}><span className="one-take-echo-mini"><i /><i /><b /></span> ECHO <small>{echoOpen ? "对话中" : "伴星在线"}</small></button>
      </header>

      <div className="one-take-scroll-space">
        <div className="one-take-sticky">
          <aside className="one-take-steps" aria-label="理解旅程阶段">
            <div className="one-take-steps-title">TODAY / 08.19</div>
            <div className="one-take-steps-track"><i /></div>
            <nav>
              {scenes.map((item, index) => <button key={item.id} type="button" className={sceneIndex === index ? "is-active" : sceneIndex > index ? "is-passed" : ""} onClick={() => jumpToScene(index)}><b>{item.index}</b><span>{item.label}</span></button>)}
            </nav>
            <div className="one-take-steps-end"><span>{sceneLabel}</span><small>滚动继续</small></div>
          </aside>

          <section className="one-take-copy" aria-live="polite">
            <div className="one-take-copy-counter"><span>{sceneLabel}</span><i style={{ transform: `scaleX(${progress})` }} /></div>
            <h1 key={scene.id}>{scene.title}</h1>
            <p key={`${scene.id}-body`}>{scene.body}</p>
            {scene.id === "collect" && <button type="button" className="one-take-primary" onClick={() => jumpToScene(1)}>把一段材料放进来 <Arrow /></button>}
            {scene.id === "shape" && <div className="one-take-copy-note"><OrbitGlyph /> <span>关系正在形成<br /><small>拖动或继续滚动，看看它们如何靠近</small></span></div>}
            {scene.id === "test" && <button type="button" className={`one-take-primary${probeStarted ? " is-started" : ""}`} onClick={() => setProbeStarted((value) => !value)}>{probeStarted ? "验证进行中" : "让伴星开始追问"} <Arrow /></button>}
            {scene.id === "remember" && <button type="button" className="one-take-primary" onClick={() => jumpToScene(0)}>再看一遍这条理解 <Arrow /></button>}
            <div className="one-take-copy-foot"><span>材料 → 笔记 → 卡 → 验证 → 复习</span><span>{Math.round(progress * 100)}%</span></div>
          </section>

          <section className="one-take-viewport" aria-label="连续理解动画">
            <div className="one-take-viewport-title"><span>UNDERSTANDING / TAKE 01</span><strong>睡眠与记忆</strong></div>
            <div className="one-take-timecode">{String(Math.floor(progress * 3) + 1).padStart(2, "0")} : {String(Math.floor(progress * 59)).padStart(2, "0")} : {String(Math.floor((progress * 100) % 100)).padStart(2, "0")}</div>
            <div className="one-take-viewport-stars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
            <div className="one-take-orbit-system" aria-hidden="true"><i /><i /><i /></div>
            <div className="one-take-source"><span className="one-take-source-pin" /><small>原始材料 / 18 min</small><strong>睡眠如何<br />改变记忆？</strong><p>新收录 · 还没有整理</p></div>
            <div className="one-take-fragments" aria-hidden="true">{fragments.map((fragment, index) => <span key={fragment} style={{ "--fragment-index": index } as CSSProperties}>{fragment}</span>)}</div>
            <div className="one-take-link-cloud" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M15 56 C31 42 39 54 50 50 S68 29 83 40" /><path d="M15 56 C26 70 38 65 50 50 S66 63 83 40" /><path d="M50 50 C49 66 55 78 63 84" /></svg></div>
            <div className="one-take-concept"><span className="one-take-concept-ring" /><span className="one-take-concept-core" /><strong>睡眠巩固</strong><small>核心理解</small></div>
            <div className="one-take-proof"><small>证据已对齐</small><strong>6 / 8</strong><span><i /></span><p>来自 2 份材料<br />和 3 条你的笔记</p></div>
            <div className="one-take-echo-character"><span className="one-take-echo-aura" /><span className="one-take-echo-face"><i /><i /><b /></span><strong>ECHO</strong><small>我来问一个问题</small></div>
            <div className="one-take-remember"><OrbitGlyph /><span><strong>长期理解</strong><small>下一次复习 · 明天</small></span></div>
            <div className="one-take-viewport-caption"><span>每一次验证，都会改变这张图。</span><i>↓</i></div>
          </section>
        </div>
      </div>

      {echoOpen && <div className="one-take-echo-panel"><div className="one-take-echo-panel-head"><span><i /> ECHO / 伴星</span><button type="button" onClick={() => setEchoOpen(false)} aria-label="关闭对话">×</button></div><p>我们现在在「{scene.label}」。</p><strong>{scene.id === "test" ? "如果不看笔记，你能把这条线说清楚吗？" : "继续向下走，我会把这颗理解带到它该去的地方。"}</strong><button type="button" onClick={() => { setEchoOpen(false); setProbeStarted(true); jumpToScene(2); }}>继续这次旅程 <Arrow /></button></div>}
      <footer className="one-take-footer"><span>UNDERSTANDING ENGINE / EXPERIENCE PROTOTYPE</span><span>滚动，不是翻页。</span></footer>
    </main>
  );
}
