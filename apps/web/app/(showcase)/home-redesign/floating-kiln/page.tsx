"use client";

/*
 * THESIS: 把“我到底懂没懂”变成一件可以走进去、转动、点燃和留下的作品；拒绝 dashboard 的信息堆叠。
 * OWN-WORLD: 漂浮窑廊——深色釉面空间、奶白陶片、钴蓝关系线与琥珀火光，所有控件都是展厅的一部分。
 * STORY: 材料进入、碎片拆开、关系相遇、伴星追问、证据烧制，访客最后带走一条可复习的理解。
 * FIRST VIEWPORT: 左侧只有一句邀请和旅程刻度，右侧是一件漂浮的“睡眠 × 记忆”关系陶体；右上角可切换整体视角/证据剖面。
 * FORM: 窑架釉流世界（direction seed a580a0c8）；Pahari raise：同一内容拥有两种可探索的观看方式。
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import "@/app/styles/floating-kiln.css";

const chapters = [
  {
    id: "arrive",
    index: "01",
    label: "带进来",
    title: "把还没懂的，带进来。",
    body: "一段文章，一次困惑，先不急着命名。理解从你愿意把它放在桌面上开始。",
  },
  {
    id: "split",
    index: "02",
    label: "拆开",
    title: "它会先失去原来的形状。",
    body: "睡眠、海马体、再激活……碎片被摊开，等待被看见，也等待下一次相遇。",
  },
  {
    id: "meet",
    index: "03",
    label: "相遇",
    title: "两个词相遇，理解开始有了温度。",
    body: "不是把它们收藏起来，而是让关系真的发生：谁解释谁，谁还缺一条证据。",
  },
  {
    id: "test",
    index: "04",
    label: "烧制",
    title: "一句话，必须经得起火。",
    body: "伴星不会替你回答。你要用自己的话，让这条理解在追问里变得更结实。",
  },
  {
    id: "keep",
    index: "05",
    label: "留下",
    title: "被验证的东西，才值得留到明天。",
    body: "来源、证据和下一次复习，成为它的纹理。你知道它从哪里来，也知道什么时候回来。",
  },
] as const;

const fragments = [
  { label: "睡眠", x: 23, y: 20, delay: "0s" },
  { label: "海马体", x: 68, y: 16, delay: "-.9s" },
  { label: "慢波", x: 16, y: 60, delay: "-1.7s" },
  { label: "再激活", x: 76, y: 63, delay: "-2.2s" },
  { label: "突触可塑性", x: 43, y: 10, delay: "-3.1s" },
  { label: "记忆提取", x: 87, y: 39, delay: "-1.2s" },
  { label: "巩固", x: 27, y: 83, delay: "-2.6s" },
  { label: "证据", x: 72, y: 87, delay: "-3.7s" },
] as const;

type ViewMode = "orbit" | "section";
type VesselId = "source" | "meaning" | "evidence";

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ViewGlyph({ mode }: { mode: ViewMode }) {
  if (mode === "section") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true" fill="none">
        <path d="M5 8h22M5 16h22M5 24h22" stroke="currentColor" strokeWidth="1.2" />
        <path d="M12 5v22M20 5v22" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" fill="none">
      <ellipse cx="16" cy="16" rx="11" ry="5.5" transform="rotate(-28 16 16)" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="16" cy="16" rx="11" ry="5.5" transform="rotate(48 16 16)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}

function EchoFace() {
  return (
    <span className="floating-kiln-echo-face" aria-hidden="true">
      <i />
      <i />
      <b />
    </span>
  );
}

export default function FloatingKilnPage() {
  const [progress, setProgress] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("orbit");
  const [selectedVessel, setSelectedVessel] = useState<VesselId>("source");
  const [echoOpen, setEchoOpen] = useState(false);
  const [ritualStarted, setRitualStarted] = useState(false);
  const [answer, setAnswer] = useState("");
  const [answerSubmitted, setAnswerSubmitted] = useState(false);

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

  const chapterIndex = Math.min(chapters.length - 1, Math.floor(progress * chapters.length));
  const chapter = chapters[chapterIndex];
  const localProgress = progress * chapters.length - chapterIndex;
  const pageStyle = {
    "--kiln-progress": progress,
    "--kiln-local": localProgress,
    "--kiln-chapter": chapterIndex,
  } as CSSProperties;

  const selectedCopy = useMemo(() => {
    const copies: Record<VesselId, { title: string; body: string; meta: string }> = {
      source: { title: "原始材料", body: "睡眠如何改变记忆？", meta: "一篇 18 分钟材料 · 尚未整理" },
      meaning: { title: "你的解释", body: "慢波睡眠让记忆重新被激活。", meta: "一句自己的话 · 等待追问" },
      evidence: { title: "证据对齐", body: "2 份来源 · 3 条笔记 · 6 / 8 条证据", meta: "可追溯 · 下一次复习 明天" },
    };
    return copies[selectedVessel];
  }, [selectedVessel]);

  const jumpToChapter = (index: number) => {
    const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: (index / chapters.length) * range, behavior: "smooth" });
  };

  return (
    <main
      className={`floating-kiln-page floating-kiln-page--${chapter.id}${ritualStarted ? " is-started" : ""}${answerSubmitted ? " is-verified" : ""}`}
      data-view={viewMode}
      style={pageStyle}
    >
      <header className="floating-kiln-nav">
        <a href="/home-redesign" className="floating-kiln-brand" aria-label="返回设计实验室">
          <span className="floating-kiln-mark"><i /><i /><i /></span>
          <span>理解引擎</span>
          <small>MEMORY ATELIER</small>
        </a>
        <div className="floating-kiln-nav-center"><i /> 一间把资料变成理解的房间</div>
        <div className="floating-kiln-nav-actions">
          <button type="button" className="floating-kiln-sound" onClick={() => setRitualStarted((value) => !value)} aria-pressed={ritualStarted}>
            <span className="floating-kiln-sound-bars"><i /><i /><i /></span>
            动态场 {ritualStarted ? "开" : "关"}
          </button>
          <button type="button" className={`floating-kiln-echo-trigger${echoOpen ? " is-open" : ""}`} onClick={() => setEchoOpen((value) => !value)}>
            <EchoFace /> ECHO <small>{echoOpen ? "对话中" : "伴星在线"}</small>
          </button>
        </div>
      </header>

      <div className="floating-kiln-scroll-space">
        <div className="floating-kiln-sticky">
          <aside className="floating-kiln-rail" aria-label="理解旅程章节">
            <div className="floating-kiln-rail-caption">TODAY / 08.19</div>
            <div className="floating-kiln-rail-line"><i /></div>
            <nav>
              {chapters.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className={chapterIndex === index ? "is-active" : chapterIndex > index ? "is-passed" : ""}
                  onClick={() => jumpToChapter(index)}
                >
                  <span>{item.index}</span>
                  <b>{item.label}</b>
                </button>
              ))}
            </nav>
            <div className="floating-kiln-rail-foot"><span>{chapter.index} / 05</span><small>滚动进入</small></div>
          </aside>

          <section className="floating-kiln-story" aria-live="polite">
            <div className="floating-kiln-story-progress"><span>{chapter.index} / 05</span><i /></div>
            <h1 key={chapter.id}>{chapter.title}</h1>
            <p key={`${chapter.id}-body`}>{chapter.body}</p>

            {chapter.id === "arrive" && (
              <button type="button" className="floating-kiln-action" onClick={() => { setRitualStarted(true); jumpToChapter(1); }}>
                把一段材料放进来 <Arrow />
              </button>
            )}
            {chapter.id === "split" && (
              <div className="floating-kiln-story-note"><span className="floating-kiln-pulse-dot" /> 碎片已经摊开 <small>切换右上角视角，看看它们的另一面</small></div>
            )}
            {chapter.id === "meet" && (
              <button type="button" className="floating-kiln-action floating-kiln-action--quiet" onClick={() => setSelectedVessel("meaning")}>
                让两个词相遇 <Arrow />
              </button>
            )}
            {chapter.id === "test" && (
              <form className="floating-kiln-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) setAnswerSubmitted(true); }}>
                <label htmlFor="kiln-answer">不用看笔记，你会怎么说？</label>
                <div><input id="kiln-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="写下一句自己的话…" /><button type="submit" aria-label="提交理解"><Arrow /></button></div>
                {answerSubmitted && <small>已经烧制：这条理解有了你的声音。</small>}
              </form>
            )}
            {chapter.id === "keep" && (
              <button type="button" className="floating-kiln-action" onClick={() => jumpToChapter(0)}>
                再看一遍这条理解 <Arrow />
              </button>
            )}

            <div className="floating-kiln-story-foot"><span>材料 → 笔记 → 卡 → 验证 → 复习</span><span>{Math.round(progress * 100)}%</span></div>
          </section>

          <section className="floating-kiln-room" aria-label="漂浮理解馆">
            <div className="floating-kiln-room-header"><span>FLOATING KILN / 01</span><strong>睡眠 × 记忆</strong></div>
            <div className="floating-kiln-view-switch" aria-label="切换观看方式">
              <button type="button" className={viewMode === "orbit" ? "is-active" : ""} onClick={() => setViewMode("orbit")}><ViewGlyph mode="orbit" />整体漂浮</button>
              <button type="button" className={viewMode === "section" ? "is-active" : ""} onClick={() => setViewMode("section")}><ViewGlyph mode="section" />证据剖面</button>
            </div>
            <div className="floating-kiln-room-copy"><span>观察一条理解如何成形</span><i>{String(Math.floor(progress * 59)).padStart(2, "0")} : {String(Math.floor((progress * 100) % 100)).padStart(2, "0")}</i></div>

            <div className="floating-kiln-world" aria-hidden="true">
              <div className="floating-kiln-halo floating-kiln-halo--outer" />
              <div className="floating-kiln-halo floating-kiln-halo--middle" />
              <div className="floating-kiln-halo floating-kiln-halo--inner" />
              <div className="floating-kiln-stars"><i /><i /><i /><i /><i /><i /><i /><i /></div>
              <svg className="floating-kiln-threads" viewBox="0 0 1000 700" preserveAspectRatio="none">
                <path className="floating-kiln-thread floating-kiln-thread--one" d="M115 180 C270 95 300 295 445 340 S650 180 830 254" />
                <path className="floating-kiln-thread floating-kiln-thread--two" d="M130 470 C275 405 300 300 445 340 S640 472 830 435" />
                <path className="floating-kiln-thread floating-kiln-thread--three" d="M445 340 C450 230 520 185 610 155" />
                <path className="floating-kiln-thread floating-kiln-thread--four" d="M445 340 C520 420 580 500 680 545" />
              </svg>
              {fragments.map((fragment, index) => (
                <span key={fragment.label} className={`floating-kiln-fragment floating-kiln-fragment--${index + 1}`} style={{ "--fragment-x": `${fragment.x}%`, "--fragment-y": `${fragment.y}%`, "--fragment-delay": fragment.delay } as CSSProperties}>{fragment.label}</span>
              ))}

              <button type="button" className={`floating-kiln-vessel floating-kiln-vessel--source${selectedVessel === "source" ? " is-selected" : ""}`} onClick={() => setSelectedVessel("source")} aria-label="查看原始材料">
                <span className="floating-kiln-vessel-shape"><i /><b /><em /></span><strong>原始材料</strong><small>18 min</small>
              </button>
              <button type="button" className={`floating-kiln-vessel floating-kiln-vessel--meaning${selectedVessel === "meaning" ? " is-selected" : ""}`} onClick={() => setSelectedVessel("meaning")} aria-label="查看你的解释">
                <span className="floating-kiln-vessel-shape"><i /><b /><em /></span><strong>你的解释</strong><small>{answerSubmitted ? "已烧制" : "等待追问"}</small>
              </button>
              <button type="button" className={`floating-kiln-vessel floating-kiln-vessel--evidence${selectedVessel === "evidence" ? " is-selected" : ""}`} onClick={() => setSelectedVessel("evidence")} aria-label="查看证据对齐">
                <span className="floating-kiln-vessel-shape"><i /><b /><em /></span><strong>证据对齐</strong><small>6 / 8</small>
              </button>
              <div className="floating-kiln-core"><span /><strong>理解<br />成形</strong><small>可追溯</small></div>
              <div className="floating-kiln-glaze-drop floating-kiln-glaze-drop--one" /><div className="floating-kiln-glaze-drop floating-kiln-glaze-drop--two" /><div className="floating-kiln-glaze-drop floating-kiln-glaze-drop--three" />
            </div>

            <div className="floating-kiln-inspector">
              <div className="floating-kiln-inspector-head"><span><i />正在观察</span><small>点击物件切换</small></div>
              <strong>{selectedCopy.title}</strong><p>{selectedCopy.body}</p><small>{selectedCopy.meta}</small>
            </div>
            <div className="floating-kiln-room-foot"><span>拖动式理解 · 不是翻页</span><span>↓</span></div>
          </section>
        </div>
      </div>

      {echoOpen && (
        <aside className="floating-kiln-echo-panel" aria-label="ECHO 伴星对话">
          <div className="floating-kiln-echo-panel-head"><span><i /> ECHO / 伴星</span><button type="button" onClick={() => setEchoOpen(false)} aria-label="关闭对话">×</button></div>
          <p>你现在在「{chapter.label}」。</p>
          <strong>{chapter.id === "test" ? "如果不看笔记，你能把这条线说清楚吗？" : "我把下一件物件留在前面。继续走，它会自己发光。"}</strong>
          <button type="button" onClick={() => { setEchoOpen(false); setRitualStarted(true); jumpToChapter(Math.min(chapterIndex + 1, chapters.length - 1)); }}>继续这次探索 <Arrow /></button>
        </aside>
      )}
      <footer className="floating-kiln-footer"><span>UNDERSTANDING ENGINE / EXPERIENCE PROTOTYPE</span><span>让理解自己长出形状。</span></footer>
    </main>
  );
}
