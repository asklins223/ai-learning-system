"use client";

import { useMemo, useState } from "react";
import "@/app/styles/understanding-field.css";

type NodeId = "sleep" | "hippocampus" | "slow-wave" | "synapse" | "recall" | "evidence";

type FieldNode = {
  id: NodeId;
  x: number;
  y: number;
  size: "core" | "medium" | "small";
  tone: "amber" | "green" | "blue" | "paper";
  title: string;
  category: string;
  detail: string;
  evidence: string;
};

const fieldNodes: FieldNode[] = [
  { id: "sleep", x: 50, y: 48, size: "core", tone: "amber", title: "睡眠巩固", category: "核心理解", detail: "睡眠不是记忆的暂停，而是大脑重新整理线索的时间。", evidence: "6 / 8 条证据已对齐" },
  { id: "hippocampus", x: 27, y: 28, size: "medium", tone: "blue", title: "海马体", category: "来源概念", detail: "把新经验暂时保存，并在睡眠阶段参与重新播放。", evidence: "来自 2 份材料" },
  { id: "slow-wave", x: 76, y: 27, size: "medium", tone: "green", title: "慢波睡眠", category: "关键机制", detail: "慢波像一扇很慢的门，让新旧记忆有机会重新排列。", evidence: "来自你的 3 条笔记" },
  { id: "synapse", x: 25, y: 70, size: "small", tone: "paper", title: "突触可塑性", category: "待验证", detail: "你能说出它如何参与巩固吗？", evidence: "还有 1 个解释缺口" },
  { id: "recall", x: 75, y: 67, size: "small", tone: "green", title: "记忆提取", category: "已验证", detail: "能够在新场景中重新组织，而不是只认得原句。", evidence: "上次验证 · 2 天前" },
  { id: "evidence", x: 51, y: 82, size: "small", tone: "blue", title: "原始证据", category: "来源材料", detail: "睡眠中的神经振荡与记忆再激活。", evidence: "论文 · 18 分钟前收录" },
];

const fieldLinks: Array<{ from: NodeId; to: NodeId; path: string }> = [
  { from: "sleep", to: "hippocampus", path: "M50 48 C43 41 35 33 27 28" },
  { from: "sleep", to: "slow-wave", path: "M50 48 C59 40 67 32 76 27" },
  { from: "sleep", to: "synapse", path: "M50 48 C42 56 32 65 25 70" },
  { from: "sleep", to: "recall", path: "M50 48 C59 55 67 63 75 67" },
  { from: "sleep", to: "evidence", path: "M50 48 C50 60 50 72 51 82" },
  { from: "hippocampus", to: "synapse", path: "M27 28 C20 43 21 58 25 70" },
  { from: "slow-wave", to: "recall", path: "M76 27 C83 42 82 55 75 67" },
];

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M5 12h13m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FieldGlyph({ kind }: { kind: "field" | "orbit" | "spark" }) {
  if (kind === "spark") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="m12 2 1.7 7.3L21 11l-7.3 1.7L12 20l-1.7-7.3L3 11l7.3-1.7L12 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" fill="currentColor" /></svg>;
  }
  if (kind === "orbit") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><ellipse cx="12" cy="12" rx="8.5" ry="3.7" transform="rotate(-28 12 12)" stroke="currentColor" strokeWidth="1.25" /><ellipse cx="12" cy="12" rx="8.5" ry="3.7" transform="rotate(48 12 12)" stroke="currentColor" strokeWidth="1.25" opacity=".55" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.2" /><circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.2" /><path d="M12 3.5v4M20.5 12h-4M12 20.5v-4M3.5 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function EchoOrb({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`understanding-field-echo${open ? " is-open" : ""}`} onClick={onClick} aria-label={open ? "关闭伴星对话" : "打开 AI 伴星对话"}>
      <span className="understanding-field-echo-ring understanding-field-echo-ring--one" />
      <span className="understanding-field-echo-ring understanding-field-echo-ring--two" />
      <span className="understanding-field-echo-face"><i /><i /><b /></span>
      <span className="understanding-field-echo-label">ECHO <small>{open ? "对话中" : "伴星在线"}</small></span>
    </button>
  );
}

function StarNode({ node, active, connected, onSelect }: { node: FieldNode; active: boolean; connected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`understanding-field-node understanding-field-node--${node.size} understanding-field-node--${node.tone}${active ? " is-active" : ""}${connected ? " is-connected" : ""}`}
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
      onClick={onSelect}
      aria-label={`${node.title}，${node.category}，${node.evidence}`}
    >
      <span className="understanding-field-node-halo" aria-hidden="true" />
      <span className="understanding-field-node-core" aria-hidden="true"><span /></span>
      <span className="understanding-field-node-copy"><strong>{node.title}</strong><small>{node.category}</small></span>
    </button>
  );
}

export default function UnderstandingFieldPage() {
  const [selectedId, setSelectedId] = useState<NodeId>("sleep");
  const [echoOpen, setEchoOpen] = useState(false);
  const [probeStarted, setProbeStarted] = useState(false);
  const selected = fieldNodes.find((node) => node.id === selectedId) ?? fieldNodes[0];
  const connectedIds = useMemo(() => new Set(fieldLinks.flatMap((link) => link.from === selectedId ? [link.to] : link.to === selectedId ? [link.from] : [])), [selectedId]);

  return (
    <main className="understanding-field-page">
      <header className="understanding-field-topbar">
        <a href="/home-redesign" className="understanding-field-brand" aria-label="返回设计实验室"><span className="understanding-field-brand-mark"><i /><i /><i /></span><span>理解引擎</span><small>FIELD / 01</small></a>
        <div className="understanding-field-breadcrumb"><span>个人理解空间</span><b>/</b><strong>睡眠与记忆</strong></div>
        <div className="understanding-field-top-actions"><span className="understanding-field-sync"><i />理解正在同步</span><button type="button" aria-label="搜索"><span>⌕</span></button><button type="button" className="understanding-field-avatar" aria-label="个人菜单">林</button></div>
      </header>

      <div className="understanding-field-body">
        <aside className="understanding-field-rail" aria-label="理解空间导航">
          <div className="understanding-field-rail-compass"><FieldGlyph kind="field" /></div>
          <div className="understanding-field-rail-line" aria-hidden="true" />
          <nav><a href="#field" className="is-current"><span>星场</span><small>01</small></a><a href="#evidence"><span>证据</span><small>02</small></a><a href="#review"><span>验证</span><small>03</small></a></nav>
          <div className="understanding-field-rail-bottom"><EchoOrb open={echoOpen} onClick={() => setEchoOpen((value) => !value)} /></div>
        </aside>

        <section className="understanding-field-stage" id="field" aria-label="理解关系场">
          <div className="understanding-field-headline"><h1>你已经理解的，<br /><em>正在连成一张图。</em></h1><p>点亮一颗星，看看它和你的材料、笔记、验证之间，还差哪一条线。</p></div>
          <div className="understanding-field-canvas">
            <div className="understanding-field-canvas-noise" aria-hidden="true" />
            <div className="understanding-field-canvas-title"><span>UNDERSTANDING FIELD</span><strong>睡眠与记忆 / 06 个理解单元</strong></div>
            <div className="understanding-field-canvas-coordinates" aria-hidden="true"><span>0.0</span><span>12:42</span><span>ACTIVE MAP</span></div>
            <div className="understanding-field-rings" aria-hidden="true"><i /><i /><i /><i /></div>
            <svg className="understanding-field-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {fieldLinks.map((link) => <path key={`${link.from}-${link.to}`} className={`${link.from === selectedId || link.to === selectedId ? "is-connected" : ""}`} d={link.path} />)}
            </svg>
            {fieldNodes.map((node) => <StarNode key={node.id} node={node} active={node.id === selectedId} connected={connectedIds.has(node.id)} onSelect={() => { setSelectedId(node.id); setProbeStarted(false); }} />)}
            <div className="understanding-field-field-caption"><span>一张理解图</span><strong>会随着你验证而变亮</strong><i>⌁</i></div>
            <div className="understanding-field-progress-line" aria-label="理解闭环进度"><span>材料</span><i className="is-done" /><span>笔记</span><i className="is-done" /><span>学习卡</span><i className="is-active" /><span>验证</span><i /><span>长期理解</span></div>
          </div>
          <div className="understanding-field-stage-foot"><span>今天的理解轨迹 · 8 月 19 日</span><span>拖动探索 <b>·</b> 点击聚焦</span></div>
        </section>

        <aside className="understanding-field-intel" id="evidence" aria-live="polite">
          <div className="understanding-field-intel-top"><span>FOCUS / {selected.id.toUpperCase()}</span><span className="understanding-field-intel-live"><i />LIVE</span></div>
          <div className={`understanding-field-intel-sigil is-${selected.tone}`}><FieldGlyph kind="orbit" /></div>
          <p className="understanding-field-intel-kind">{selected.category}</p>
          <h2>{selected.title}</h2>
          <p className="understanding-field-intel-detail">{selected.detail}</p>
          <div className="understanding-field-intel-evidence"><span>证据状态</span><strong>{selected.evidence}</strong><i><b style={{ transform: `scaleX(${selected.id === "sleep" ? .74 : .5})` }} /></i></div>
          <div className="understanding-field-intel-divider" />
          <div className="understanding-field-intel-next"><span>下一条线索</span><strong>{selected.id === "sleep" ? "你还没有解释：为什么是睡眠？" : "把它和核心理解重新连起来"}</strong><p>伴星会根据你的回答，更新这颗星的亮度。</p></div>
          <button type="button" className={`understanding-field-probe${probeStarted ? " is-started" : ""}`} onClick={() => setProbeStarted((value) => !value)}><span>{probeStarted ? "验证已开始" : "开始 3 分钟验证"}</span><small>{probeStarted ? "先说你记得的" : "不需要写长文"}</small><Arrow /></button>
          <button type="button" className="understanding-field-ask" onClick={() => setEchoOpen(true)}><FieldGlyph kind="spark" /> 让伴星追问这颗星</button>
          <div className="understanding-field-intel-footer"><span>最后更新 · 刚刚</span><span>来源可追溯</span></div>
        </aside>
      </div>

      <div className={`understanding-field-echo-console${echoOpen ? " is-visible" : ""}`} aria-hidden={!echoOpen}>
        <div className="understanding-field-echo-console-head"><span><i /> ECHO / 伴星</span><button type="button" onClick={() => setEchoOpen(false)} aria-label="关闭伴星对话">×</button></div>
        <p>我看见你点亮了「{selected.title}」。</p><strong>{selected.id === "sleep" ? "如果睡眠在整理记忆，那它具体整理了什么？" : "这颗星和「睡眠巩固」之间，哪条线你还说不清？"}</strong>
        <button type="button" onClick={() => { setEchoOpen(false); setProbeStarted(true); }}>我来试着解释 <Arrow /></button>
      </div>
      <footer className="understanding-field-page-foot"><span>UNDERSTANDING FIELD · DESIGN EXPLORATION</span><span>这是一张会被验证改变的地图</span></footer>
    </main>
  );
}
