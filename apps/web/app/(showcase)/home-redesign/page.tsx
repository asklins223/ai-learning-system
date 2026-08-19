"use client";

import { useMemo, useState } from "react";
import "@/app/styles/home-redesign.css";

type DemoId = "atlas" | "desk" | "archive";

const demoOptions: Array<{ id: DemoId; label: string; note: string }> = [
  { id: "atlas", label: "学习轨道", note: "把闭环变成一张可走的地图" },
  { id: "desk", label: "纸上仪表盘", note: "把今天变成一张会呼吸的书桌" },
  { id: "archive", label: "档案抽屉", note: "把证据与理解收进同一只抽屉" },
];

const nodes = [
  { id: "source", x: 12, y: 54, label: "原始材料", meta: "神经科学 · 18 min", state: "done" },
  { id: "note", x: 33, y: 34, label: "你的笔记", meta: "12 条关键观察", state: "done" },
  { id: "card", x: 55, y: 53, label: "学习卡", meta: "7 个待验证", state: "active" },
  { id: "review", x: 76, y: 31, label: "三分钟验证", meta: "今天 1 个到期", state: "next" },
  { id: "memory", x: 88, y: 66, label: "长期理解", meta: "正在形成", state: "future" },
] as const;

function Arrow({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M5 12h13m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="m12 2 1.65 7.35L21 11l-7.35 1.65L12 20l-1.65-7.35L3 11l7.35-1.65L12 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" fill="currentColor" />
    </svg>
  );
}

function Compass({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.35" />
      <path d="m14.95 9.05-2.25 5.1-5.1 2.25 2.25-5.1 5.1-2.25Z" fill="currentColor" opacity=".82" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="10.8" cy="10.8" r="6.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="m16 16 4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function PetMark({ active = false }: { active?: boolean }) {
  return (
    <span className={`home-redesign-pet-mark${active ? " is-active" : ""}`} aria-hidden="true">
      <span />
      <span />
      <i />
    </span>
  );
}

function DemoHeader({ activeDemo, setActiveDemo }: { activeDemo: DemoId; setActiveDemo: (id: DemoId) => void }) {
  return (
    <header className="home-redesign-topbar">
      <a className="home-redesign-brand" href="#top" aria-label="理解引擎 demo 首页">
        <span className="home-redesign-brand-dot" aria-hidden="true" />
        <span>理解引擎</span>
        <small>UI LAB · 26</small>
      </a>
      <nav className="home-redesign-demo-tabs" aria-label="Demo 版本">
        {demoOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={activeDemo === option.id ? "is-active" : ""}
            onClick={() => setActiveDemo(option.id)}
            aria-pressed={activeDemo === option.id}
          >
            <span>{option.label}</span>
            <small>{option.note}</small>
          </button>
        ))}
      </nav>
      <div className="home-redesign-topbar-tools">
        <button type="button" className="home-redesign-icon-button" aria-label="搜索">
          <SearchIcon />
        </button>
        <button type="button" className="home-redesign-avatar" aria-label="打开个人菜单">林</button>
      </div>
    </header>
  );
}

function DemoRail({ activeDemo }: { activeDemo: DemoId }) {
  return (
    <aside className="home-redesign-rail" aria-label="学习导航">
      <div className="home-redesign-rail-mark"><Compass /></div>
      <div className="home-redesign-rail-track" aria-hidden="true" />
      <nav>
        <a className="is-current" href="#focus"><span>今天</span><b>01</b></a>
        <a href="#path"><span>学习轨道</span><b>02</b></a>
        <a href="#library"><span>理解库</span><b>03</b></a>
      </nav>
      <div className="home-redesign-rail-bottom">
        <PetMark active={activeDemo === "desk"} />
        <small>伴星在线</small>
      </div>
    </aside>
  );
}

function CompanionPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="home-redesign-companion" aria-label="AI 伴星">
      <button className="home-redesign-companion-close" type="button" onClick={onClose} aria-label="关闭伴星面板">×</button>
      <div className="home-redesign-companion-orbit" aria-hidden="true">
        <div className="home-redesign-companion-glow" />
        <div className="home-redesign-companion-core"><PetMark active /></div>
      </div>
      <p className="home-redesign-companion-kicker">AI 伴星 · Echo</p>
      <h2>你已经走到<br />学习卡这一步了。</h2>
      <p className="home-redesign-companion-copy">要不要现在用 3 分钟，把“叠加态”讲给我听？我会帮你找出还没站稳的那一小块。</p>
      <button type="button" className="home-redesign-primary-button home-redesign-companion-action">
        开始对话 <Arrow />
      </button>
      <div className="home-redesign-companion-note"><Spark /> 不用准备得很完整，先说你记得的。</div>
    </aside>
  );
}

function AtlasDemo({ onOpenCompanion }: { onOpenCompanion: () => void }) {
  const [selectedNode, setSelectedNode] = useState("card");
  const selected = nodes.find((node) => node.id === selectedNode) ?? nodes[2];

  return (
    <section className="home-redesign-demo home-redesign-demo--atlas" aria-labelledby="atlas-title">
      <div className="home-redesign-atlas-intro">
        <p className="home-redesign-annotation">星期三 · 8 月 19 日 <span>/</span> 学习路径 04</p>
        <h1 id="atlas-title">今天，你要把哪一块<br /><em>理解走完？</em></h1>
        <p className="home-redesign-lede">从原始材料出发，沿着自己的证据走。每一次验证，都会让这张地图更亮一点。</p>
        <div className="home-redesign-atlas-actions">
          <button type="button" className="home-redesign-primary-button" onClick={() => setSelectedNode("review")}>继续今天的路径 <Arrow /></button>
          <button type="button" className="home-redesign-text-button" onClick={onOpenCompanion}>问问伴星 <Spark /></button>
        </div>
        <div className="home-redesign-atlas-stats" aria-label="学习进度">
          <div><strong>12</strong><span>已形成理解</span></div>
          <div><strong>03</strong><span>等待验证</span></div>
          <div><strong>68<span>%</span></strong><span>本周闭环</span></div>
        </div>
      </div>

      <div className="home-redesign-atlas-map" id="path">
        <div className="home-redesign-map-sky" aria-hidden="true" />
        <div className="home-redesign-map-grid" aria-hidden="true" />
        <div className="home-redesign-map-label map-label-top">FROM MATERIAL<br /><strong>TO UNDERSTANDING</strong></div>
        <svg className="home-redesign-map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M12 54 C20 54, 23 36, 33 34 S45 41, 55 53 S64 43, 76 31 S83 43, 88 66" />
          <path d="M33 34 C37 23, 43 20, 50 24" className="is-ghost" />
          <path d="M55 53 C64 70, 76 76, 88 66" className="is-ghost" />
        </svg>
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            className={`home-redesign-map-node is-${node.state}${selectedNode === node.id ? " is-selected" : ""}`}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
            onClick={() => setSelectedNode(node.id)}
            aria-label={`${node.label}：${node.meta}`}
          >
            <span className="home-redesign-node-pulse" aria-hidden="true" />
            <span className="home-redesign-node-dot" aria-hidden="true" />
            <span className="home-redesign-node-copy"><strong>{node.label}</strong><small>{node.meta}</small></span>
          </button>
        ))}
        <div className="home-redesign-map-detail" aria-live="polite">
          <span className="home-redesign-detail-line" />
          <small>当前停靠</small>
          <strong>{selected.label}</strong>
          <p>{selected.meta} · 这是今天最值得推进的一站。</p>
          <button type="button" className="home-redesign-map-detail-link">打开这张卡 <Arrow /></button>
        </div>
        <div className="home-redesign-map-axis" aria-hidden="true"><span>START</span><span>NOW</span><span>DEEPER</span></div>
      </div>
    </section>
  );
}

function DeskDemo({ onOpenCompanion }: { onOpenCompanion: () => void }) {
  const [running, setRunning] = useState(false);
  const [energy, setEnergy] = useState(72);

  return (
    <section className="home-redesign-demo home-redesign-demo--desk" aria-labelledby="desk-title">
      <div className="home-redesign-desk-copy">
        <div className="home-redesign-desk-date"><span className="home-redesign-live-dot" /> 08 / 19 · WEDNESDAY</div>
        <h1 id="desk-title">你的理解，<br /><em>正在成形。</em></h1>
        <p>今天不需要清空所有待办。只要让一个概念从“看过”变成“我能解释”。</p>
        <div className="home-redesign-desk-callout">
          <span className="home-redesign-callout-mark">↳</span>
          <div><strong>今天的一个小动作</strong><span>把“突触可塑性”讲给伴星听</span></div>
          <button type="button" onClick={onOpenCompanion} aria-label="请伴星听我讲"><Arrow /></button>
        </div>
      </div>
      <div className="home-redesign-desk-surface" id="focus">
        <div className="home-redesign-desk-surface-top"><span>DESK / 04</span><span>FOCUS MODE</span><span>⌘ K</span></div>
        <div className="home-redesign-focus-card">
          <div className="home-redesign-focus-card-meta"><span>学习卡 · 待验证</span><span>01 / 03</span></div>
          <h2>为什么睡眠会巩固<br />新形成的记忆？</h2>
          <p>试着不用看笔记，先说出你记得的三个关键词。</p>
          <div className="home-redesign-card-streak"><span>连续理解</span><i><b style={{ transform: `scaleX(${energy / 100})` }} /></i><strong>{energy}%</strong></div>
          <button type="button" className={`home-redesign-focus-cta${running ? " is-running" : ""}`} onClick={() => setRunning((value) => !value)}>
            <span className="home-redesign-play-mark">{running ? "Ⅱ" : "▶"}</span>
            {running ? "验证进行中" : "开始 3 分钟验证"}
            <small>{running ? "先说你知道的" : "不需要写长文"}</small>
          </button>
        </div>
        <button type="button" className="home-redesign-floating-note home-redesign-floating-note--yellow" onClick={() => setEnergy((value) => Math.min(96, value + 8))}><span>今日复习</span><strong>1</strong><small>轻轻推一下</small></button>
        <button type="button" className="home-redesign-floating-note home-redesign-floating-note--blue" onClick={() => setEnergy((value) => Math.max(36, value - 8))}><span>待修补</span><strong>3</strong><small>还有一点模糊</small></button>
        <div className="home-redesign-desk-orbit" aria-hidden="true"><span /><span /><span /></div>
      </div>
      <div className="home-redesign-desk-footer"><span>本周学习节奏</span><div className="home-redesign-week-bars" aria-label="本周学习节奏"><i /><i /><i /><i className="is-today" /><i /><i /><i /></div><strong>4 / 7 天</strong><button type="button" onClick={onOpenCompanion}>让伴星陪我一会儿 <Arrow /></button></div>
    </section>
  );
}

function ArchiveDemo({ onOpenCompanion }: { onOpenCompanion: () => void }) {
  const [openDrawer, setOpenDrawer] = useState("neuro");
  const drawers = [
    { id: "neuro", label: "神经科学", count: "07", color: "orange", title: "睡眠与记忆巩固", desc: "从海马体到慢波睡眠，7 条证据已经对齐。", progress: 76 },
    { id: "design", label: "设计系统", count: "12", color: "green", title: "可验证的界面", desc: "整理中的材料，正在长出一张关系图。", progress: 42 },
    { id: "writing", label: "写作练习", count: "04", color: "blue", title: "让观点自己站起来", desc: "还有 2 个关键论据需要回到来源。", progress: 58 },
  ];
  const active = drawers.find((drawer) => drawer.id === openDrawer) ?? drawers[0];

  return (
    <section className="home-redesign-demo home-redesign-demo--archive" aria-labelledby="archive-title">
      <div className="home-redesign-archive-header">
        <div><p className="home-redesign-annotation">PERSONAL UNDERSTANDING ARCHIVE <span>/</span> 2026.08.19</p><h1 id="archive-title">每一份材料，<br /><em>都有它的下一步。</em></h1></div>
        <div className="home-redesign-archive-header-actions"><span><b>23</b> 个理解单元</span><button type="button" onClick={onOpenCompanion}><PetMark active /> 询问伴星 <Arrow /></button></div>
      </div>
      <div className="home-redesign-archive-workspace" id="library">
        <div className="home-redesign-drawer-stack" role="list" aria-label="理解抽屉">
          {drawers.map((drawer, index) => (
            <button key={drawer.id} type="button" role="listitem" className={`home-redesign-drawer home-redesign-drawer--${drawer.color}${openDrawer === drawer.id ? " is-open" : ""}`} onClick={() => setOpenDrawer(drawer.id)}>
              <span className="home-redesign-drawer-index">0{index + 1}</span><span className="home-redesign-drawer-title">{drawer.label}</span><span className="home-redesign-drawer-count">{drawer.count}</span><Arrow />
            </button>
          ))}
          <button type="button" className="home-redesign-add-drawer"><span>＋</span> 收入一份新的材料</button>
        </div>
        <article className="home-redesign-archive-sheet" aria-live="polite">
          <div className="home-redesign-sheet-registration" aria-hidden="true"><span>ARCHIVE / {active.id.toUpperCase()}</span><span>◇</span></div>
          <div className="home-redesign-sheet-content"><div className={`home-redesign-sheet-seal is-${active.color}`}>UNDERSTAND<br /><strong>IT</strong></div><p className="home-redesign-sheet-kicker">{active.label} · {active.count} 个单元</p><h2>{active.title}</h2><p>{active.desc}</p><div className="home-redesign-evidence-row"><span>证据对齐度</span><div><i style={{ transform: `scaleX(${active.progress / 100})` }} /></div><strong>{active.progress}%</strong></div><div className="home-redesign-sheet-actions"><button type="button" className="home-redesign-primary-button">继续整理 <Arrow /></button><button type="button" className="home-redesign-text-button">查看理解图 <Arrow /></button></div></div>
          <div className="home-redesign-sheet-footer"><span>最后编辑 · 18 分钟前</span><span>来源可追溯</span><span>间隔复习已安排</span></div>
        </article>
      </div>
      <div className="home-redesign-archive-quote">“真正拥有一个概念，不是记住它出现过，而是能在需要的时候，把它重新说出来。”<small>— 理解引擎学习原则</small></div>
    </section>
  );
}

export default function HomeRedesignPage() {
  const [activeDemo, setActiveDemo] = useState<DemoId>("atlas");
  const [companionOpen, setCompanionOpen] = useState(false);
  const demo = useMemo(() => demoOptions.find((option) => option.id === activeDemo) ?? demoOptions[0], [activeDemo]);

  return (
    <main id="top" className={`home-redesign-page home-redesign-page--${activeDemo}`}>
      <DemoHeader activeDemo={activeDemo} setActiveDemo={(id) => { setActiveDemo(id); setCompanionOpen(false); }} />
      <div className="home-redesign-body">
        <DemoRail activeDemo={activeDemo} />
        <div className="home-redesign-stage">
          <div className="home-redesign-stage-meta"><span>DEMO {demoOptions.findIndex((option) => option.id === activeDemo) + 1} / 3</span><span>{demo.note}</span><button type="button" onClick={() => setCompanionOpen((value) => !value)}><PetMark active={companionOpen} /> 伴星 {companionOpen ? "已展开" : "在线"}</button></div>
          {activeDemo === "atlas" && <AtlasDemo onOpenCompanion={() => setCompanionOpen(true)} />}
          {activeDemo === "desk" && <DeskDemo onOpenCompanion={() => setCompanionOpen(true)} />}
          {activeDemo === "archive" && <ArchiveDemo onOpenCompanion={() => setCompanionOpen(true)} />}
          <footer className="home-redesign-lab-footer"><span>这是设计探索页 · 不会改动现有生产首页</span><span>按 ← → 可切换版本</span></footer>
        </div>
        {companionOpen && <CompanionPanel onClose={() => setCompanionOpen(false)} />}
      </div>
    </main>
  );
}
