import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";
import { useRoomStore } from "../../app/room-store";

export const LEARNING_RUN_CEREMONY_LITE_DURATION_MS = 700;
/** 彩纸只在这段窗口里继续生成；演出不再自动收场，所以生成必须先停。 */
const CONFETTI_SPAWN_MS = 3_000;

type ConfettiParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  rotation: number;
  rotationSpeed: number;
  flip: number;
  flipSpeed: number;
  gravity: number;
  drag: number;
  color: string;
  round: boolean;
};

const CONFETTI_COLORS = ["#f8d970", "#f59f73", "#82c8b1", "#75b8d3", "#f4b7c4", "#fef7e4", "#a49ada"];
const random = (low: number, high: number) => low + Math.random() * (high - low);

/** The reference's two-sided cannons, scaled to this three-second result transition. */
function CelebrationConfetti() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext("2d"); } catch { return; }
    if (!context) return;
    const ctx = context;
    const particles: ConfettiParticle[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastTime = performance.now();
    let drizzleAt = lastTime + 420;
    const spawnUntil = lastTime + CONFETTI_SPAWN_MS;
    let stopped = false;
    const timers: number[] = [];

    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    };

    const add = (x: number, y: number, angle: number, speed: number, falling = false) => {
      if (particles.length >= 450) return;
      const round = Math.random() < 0.18;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        width: round ? random(5, 9) : random(5, 10),
        height: round ? 0 : random(9, 17),
        rotation: random(0, Math.PI * 2),
        rotationSpeed: random(-0.15, 0.15),
        flip: random(0, Math.PI * 2),
        flipSpeed: random(0.05, 0.14),
        gravity: falling ? random(0.035, 0.07) : random(0.23, 0.34),
        drag: falling ? 0.995 : random(0.982, 0.991),
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        round,
      });
    };

    const cannon = (left: boolean, count: number) => {
      const x = left ? -12 : width + 12;
      const angle = left ? -Math.PI / 3 : -Math.PI * 2 / 3;
      const speedScale = Math.max(0.68, Math.min(1, height / 780));
      for (let index = 0; index < count; index += 1) {
        add(x, height + 12, angle + random(-0.47, 0.47), random(15, 25) * speedScale);
      }
    };

    const loop = (time: number) => {
      if (stopped) return;
      const step = Math.min(time - lastTime, 50) / 16.667;
      lastTime = time;
      ctx.clearRect(0, 0, width, height);
      const spawning = time < spawnUntil;
      if (spawning && time > drizzleAt) {
        add(random(0, width), -15, Math.PI / 2 + random(-0.3, 0.3), random(0.5, 1.7), true);
        drizzleAt = time + random(55, 105);
      }
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        const drag = Math.pow(particle.drag, step);
        particle.vx *= drag;
        particle.vy = particle.vy * drag + particle.gravity * step;
        particle.x += particle.vx * step;
        particle.y += particle.vy * step;
        particle.rotation += particle.rotationSpeed * step;
        particle.flip += particle.flipSpeed * step;
        if (particle.y > height + 40 || particle.x < -90 || particle.x > width + 90) {
          particles.splice(index, 1);
          continue;
        }
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rotation);
        ctx.scale(Math.max(0.08, Math.abs(Math.cos(particle.flip))), 1);
        ctx.fillStyle = particle.color;
        if (particle.round) {
          ctx.beginPath();
          ctx.arc(0, 0, particle.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
        }
        ctx.restore();
      }
      // 演出不再按时收场，所以纸落完就自己停，不能留一个空转的 rAF。
      if (!spawning && particles.length === 0) return;
      frame = window.requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener("resize", resize);
    timers.push(window.setTimeout(() => cannon(true, 105), 90));
    timers.push(window.setTimeout(() => cannon(false, 105), 280));
    timers.push(window.setTimeout(() => { cannon(true, 62); cannon(false, 62); }, 890));
    frame = window.requestAnimationFrame(loop);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", resize);
      particles.length = 0;
    };
  }, []);

  return <canvas className="learning-run-ceremony__confetti" ref={canvasRef} aria-hidden="true" />;
}

export function LearningRunCeremony({
  active,
  stamp,
  eyebrow,
  headline,
  achievement,
  companionLine,
  onStart,
  onFinish,
}: {
  readonly active: boolean;
  readonly stamp: string;
  readonly eyebrow: string;
  readonly headline: string;
  readonly achievement: string;
  readonly companionLine: string | null;
  readonly onStart: () => void;
  readonly onFinish: () => void;
}) {
  const motionMode = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const [visible, setVisible] = useState(false);
  const startedRef = useRef(false);
  const skipRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (visible) skipRef.current?.focus({ preventScroll: true });
  }, [visible]);

  useEffect(() => {
    if (!active) {
      startedRef.current = false;
      setVisible(false);
      return;
    }
    if (!startedRef.current) {
      startedRef.current = true;
      onStart();
    }
    if (motionMode === "off" || reducedMotion) {
      onFinish();
      return;
    }
    setVisible(true);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setVisible(false);
      onFinish();
    };
    // 轻量模式仍按时自己收场；完整演出留到用户点任意一处再关（2026-09-24 裁定）。
    const timer = motionMode === "lite"
      ? window.setTimeout(finish, LEARNING_RUN_CEREMONY_LITE_DURATION_MS)
      : 0;
    // capture 而不是冒泡：伴星 feed 菜单有两处 stopPropagation，冒泡监听会被吃掉，
    // 那时这一屏就再也点不开了。
    window.addEventListener("pointerdown", finish, { once: true, capture: true });
    window.addEventListener("keydown", finish, { once: true, capture: true });
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("pointerdown", finish, { capture: true });
      window.removeEventListener("keydown", finish, { capture: true });
    };
  }, [active, motionMode, onFinish, onStart, reducedMotion]);

  if (!visible) return null;
  const host = document.querySelector(".desktop-app") ?? document.body;
  return createPortal(
    <div className="learning-run-ceremony" data-motion={motionMode} role="dialog" aria-modal="true" aria-live="polite" aria-label={`${headline}。${achievement}`}>
      <div className="learning-run-ceremony__aurora" aria-hidden="true" />
      {motionMode === "full" ? <CelebrationConfetti /> : null}
      <div className="learning-run-ceremony__orbit learning-run-ceremony__orbit--one" aria-hidden="true" />
      <div className="learning-run-ceremony__orbit learning-run-ceremony__orbit--two" aria-hidden="true" />
      <div className="learning-run-ceremony__content">
        <div className="learning-run-ceremony__stamp" aria-hidden="true"><Sparkles size={28} /><strong>{stamp}</strong></div>
        <span className="learning-run-ceremony__eyebrow">{eyebrow}</span>
        <h2>{headline}</h2>
        <p>{achievement}</p>
        {companionLine ? <div className="learning-run-ceremony__companion"><span>伴星</span>{companionLine}</div> : null}
      </div>
      <button ref={skipRef} type="button" className="learning-run-ceremony__skip" onClick={onFinish}>跳过庆祝，查看完整反馈</button>
    </div>,
    host,
  );
}
