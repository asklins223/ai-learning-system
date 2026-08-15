"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopPetScaleV1, PetHitGeometryV1 } from "@ailearn/shared/desktop-pet-contracts";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import { PetCharacterCanvas } from "../character/PetCharacterCanvas";
import type { SpriteHitMaskV1 } from "../character/SpriteCharacterDriver";
import { PetBubble } from "./PetBubble";
import { PetConfirmationCard } from "./PetConfirmationCard";
import { PetComposer } from "./PetComposer";
import { PetIcon } from "./PetIcon";
import { PetMenu } from "./PetMenu";
import { PetVoiceControl } from "./PetVoiceControl";
import {
  browserDragFrameSchedulerV1,
  DragTransportV1,
} from "./drag-transport";
import {
  computeCharacterRect,
  effectiveContentSize,
} from "../character/sprite-geometry";
import {
  CHARACTER_LONG_PRESS_MS,
  canStartCharacterDrag,
  hasCrossedCharacterDragThreshold,
  isEligibleCharacterLongPress,
  shouldDispatchCharacterClick,
} from "./character-gesture";

export interface PetSurfaceProps {
  side: "bubble-left" | "bubble-right";
  petScale: DesktopPetScaleV1;
  reducedMotion: boolean;
  animationOff: boolean;
  live2dEnabled?: boolean;
  exposeDemoApi?: boolean;
  textConversationEnabled?: boolean;
  voiceDialogueEnabled?: boolean;
  learningActionsEnabled?: boolean;
}

type RegionIdV1 = PetHitGeometryV1["regions"][number]["id"];
type GestureSourceV1 = "character" | "handle";

interface ActiveGestureV1 {
  pointerId: number;
  pointerType: string;
  source: GestureSourceV1;
  start: { x: number; y: number };
  current: { x: number; y: number };
  last: { x: number; y: number };
  dragged: boolean;
  movedBeyondThreshold: boolean;
  longPressed: boolean;
  longPressTimer: number | null;
  transport: DragTransportV1 | null;
}

export function PetSurface({
  side,
  petScale,
  reducedMotion,
  animationOff,
  live2dEnabled = false,
  exposeDemoApi,
  textConversationEnabled = false,
  voiceDialogueEnabled = false,
  learningActionsEnabled = false,
}: PetSurfaceProps) {
  const runtime = usePetRuntime();
  const { state, presentation, dispatch, adapter, demo, windowState } = runtime;
  const rootRef = useRef<HTMLDivElement>(null);
  const geometryRevision = useRef(0);
  // F#9：几何重算 rAF 句柄——供 cleanup cancel，避免卸载后残留一帧触发。
  const geometryRafRef = useRef<number | null>(null);
  const [inviteOnceTrigger, setInviteOnceTrigger] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gestureRef = useRef<ActiveGestureV1 | null>(null);
  const dragTransportRef = useRef<DragTransportV1 | null>(null);
  const spriteHitMaskRef = useRef<(() => SpriteHitMaskV1 | null) | null>(null);
  const [spriteHitMaskRevision, setSpriteHitMaskRevision] = useState(0);
  const lastClickAtRef = useRef(Number.NEGATIVE_INFINITY);
  const fixtureVoiceEnabled = !textConversationEnabled && !voiceDialogueEnabled;
  // §6.3：Live2D 实际激活状态（初始 = 服务端能力；加载失败/上下文丢失回退
  // Sprite 后同步为 false，命中几何与 mask 都必须切回 Sprite rect）。
  const [live2dActive, setLive2dActive] = useState(live2dEnabled);

  const layout = useMemo(() => {
    const size = effectiveContentSize(petScale);
    const spriteCharacter = computeCharacterRect(side, petScale);
    const live2dStageWidth = Math.max(244, size.width - 300);
    const character = live2dActive
      ? {
          x: side === "bubble-left" ? 300 : 0,
          y: 150,
          width: live2dStageWidth,
          height: 354,
        }
      : spriteCharacter;
    const panelWidth = 288;
    const panelX = side === "bubble-left" ? 12 : size.width - panelWidth - 12;
    const menuWidth = 252;
    const menuX = side === "bubble-left" ? 32 : size.width - menuWidth - 32;
    const oppositePanelX = side === "bubble-left" ? size.width - 268 : 12;
    const characterInnerEdge = side === "bubble-left" ? character.x : character.x + character.width;
    const toolbarX = side === "bubble-left" ? characterInnerEdge - 18 : characterInnerEdge - 30;
    const dragX = side === "bubble-left" ? character.x + character.width - 54 : character.x + 10;
    // 2026-08-12（布局修复）：原 voiceX 紧贴角色左缘（bubble-left x=304），
    // 与 quick toolbar（y 282–384）垂直重叠 12px，且盖住角色左腰的星环法杖
    // 手柄（法杖尖端 x≤370）。改为与 drag handle 同列（x=dragX），CSS top 同步
    // 下移到 toolbar 下方（392px），与 toolbar/drag handle 三者不再重叠。
    const voiceX = dragX;
    // 2026-08-12+（15a-C 终版）：完整版语音岛（178px）放人物头顶上方（CSS top
    // 84，画布 y150 起不遮挡），水平居中于角色画布——bubble-left/right 通用。
    const voiceIslandX = character.x + (character.width - 178) / 2;
    return {
      width: size.width,
      height: size.height,
      spriteCharacter,
      character,
      panelX,
      menuX,
      oppositePanelX,
      toolbarX,
      dragX,
      voiceX,
      voiceIslandX,
      live2dStageWidth,
    };
  }, [side, petScale, live2dActive]);

  const clearLongPress = useCallback((gesture: ActiveGestureV1 | null) => {
    if (gesture?.longPressTimer !== null && gesture?.longPressTimer !== undefined) {
      window.clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  }, []);

  const triggerCharacterClick = useCallback(() => {
    dispatch({ type: "character.clicked" });
    setInviteOnceTrigger((value) => value + 1);
  }, [dispatch]);

  const handleSpriteReady = useCallback((
    _hitTest: (point: { x: number; y: number }) => boolean,
    getHitMask: () => SpriteHitMaskV1 | null,
  ) => {
    spriteHitMaskRef.current = getHitMask;
    setSpriteHitMaskRevision((value) => value + 1);
  }, []);

  const finishGesture = useCallback((cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    clearLongPress(gesture);
    gestureRef.current = null;

    if (gesture.dragged) {
      setDragging(false);
      gesture.transport?.end();
      return;
    }
    if (cancelled) return;

    const now = performance.now();
    if (shouldDispatchCharacterClick({
      source: gesture.source,
      dragged: gesture.dragged,
      movedBeyondThreshold: gesture.movedBeyondThreshold,
      longPressed: gesture.longPressed,
      lastClickAt: lastClickAtRef.current,
      now,
    })) {
      lastClickAtRef.current = now;
      triggerCharacterClick();
    }
  }, [clearLongPress, triggerCharacterClick]);

  const handlePointerDown = useCallback((source: GestureSourceV1, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || gestureRef.current || dragTransportRef.current) return;
    if (source === "handle" && windowState?.locked) return;
    // screenX/screenY remain stable while Electron moves the BrowserWindow;
    // client coordinates do not and can create a small backwards correction.
    const point = { x: event.screenX, y: event.screenY };
    const gesture: ActiveGestureV1 = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      source,
      start: point,
      current: point,
      last: point,
      dragged: false,
      movedBeyondThreshold: false,
      longPressed: false,
      longPressTimer: null,
      transport: null,
    };
    gestureRef.current = gesture;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    if (source === "character" && event.pointerType !== "mouse") {
      gesture.longPressTimer = window.setTimeout(() => {
        const current = gestureRef.current;
        if (!current || current.pointerId !== gesture.pointerId || current.dragged || current.movedBeyondThreshold) return;
        if (!isEligibleCharacterLongPress({
          pointerType: current.pointerType,
          start: current.start,
          current: current.current,
          elapsedMs: CHARACTER_LONG_PRESS_MS,
        })) return;
        current.longPressed = true;
        dispatch({ type: "menu.opened" });
      }, CHARACTER_LONG_PRESS_MS);
    }
  }, [dispatch, windowState?.locked]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = { x: event.screenX, y: event.screenY };
    gesture.current = point;

    if (!gesture.movedBeyondThreshold && hasCrossedCharacterDragThreshold(gesture.start, point)) {
      gesture.movedBeyondThreshold = true;
      clearLongPress(gesture);
    }

    let startedNow = false;
    if (!gesture.dragged && !gesture.longPressed && canStartCharacterDrag({
      start: gesture.start,
      current: point,
      locked: windowState?.locked ?? false,
    })) {
      clearLongPress(gesture);
      gesture.dragged = true;
      setDragging(true);
      dispatch({ type: "window.drag_started" });
      let transport: DragTransportV1;
      transport = new DragTransportV1({
        scheduler: browserDragFrameSchedulerV1,
        send: (deltaX, deltaY) => adapter.dragBy(deltaX, deltaY),
        onSettled: () => {
          if (dragTransportRef.current === transport) dragTransportRef.current = null;
          dispatch({ type: "window.drag_ended" });
        },
      });
      gesture.transport = transport;
      dragTransportRef.current = transport;
      startedNow = true;
    }

    if (gesture.dragged) {
      // Include movement accumulated before the 8px threshold on the first
      // frame so the window never finishes a few pixels behind the pointer.
      const deltaX = point.x - (startedNow ? gesture.start.x : gesture.last.x);
      const deltaY = point.y - (startedNow ? gesture.start.y : gesture.last.y);
      gesture.transport?.push(deltaX, deltaY);
    }
    gesture.last = point;
  }, [adapter, clearLongPress, dispatch, windowState?.locked]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    finishGesture(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, [finishGesture]);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    finishGesture(true);
  }, [finishGesture]);

  useEffect(() => {
    const endOnLifecycleChange = () => finishGesture(true);
    window.addEventListener("blur", endOnLifecycleChange);
    document.addEventListener("visibilitychange", endOnLifecycleChange);
    return () => {
      window.removeEventListener("blur", endOnLifecycleChange);
      document.removeEventListener("visibilitychange", endOnLifecycleChange);
      finishGesture(true);
    };
  }, [finishGesture]);

  useEffect(() => {
    if (windowState?.locked && gestureRef.current?.dragged) finishGesture(true);
  }, [finishGesture, windowState?.locked]);

  const registerGeometry = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const seen = new Set<RegionIdV1>();
    const regions: PetHitGeometryV1["regions"] = [];
    root.querySelectorAll<HTMLElement>("[data-pet-region]").forEach((element) => {
      const id = element.dataset.petRegion as RegionIdV1 | undefined;
      if (!id || seen.has(id)) return;
      // Hidden shortcut controls remain mounted so CSS hover can reveal them,
      // but they must not block the underlying desktop while another surface
      // owns the interaction. The eligible-state check deliberately keeps
      // menu_trigger/drag_handle registered while the idle surface is active
      // so hover/focus discovery still works.
      const shortcutsSuppressed =
        dragging ||
        state.bubble.kind !== "hidden" ||
        state.composer.kind !== "closed" ||
        state.voice.kind === "requesting_permission" ||
        state.voice.kind === "listening" ||
        state.voice.kind === "finalizing" ||
        state.voice.kind === "transcribing" ||
        state.voice.kind === "speaking";
      const voiceSuppressed = dragging || state.menu.kind !== "closed" || state.bubble.kind === "confirmation";
      if ((id === "menu_trigger" || id === "drag_handle") && shortcutsSuppressed) return;
      if (id === "voice_control" && voiceSuppressed) return;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = Math.max(0, Math.min(layout.width, rect.left - rootRect.left));
      const y = Math.max(0, Math.min(layout.height, rect.top - rootRect.top));
      const width = Math.min(rect.width, layout.width - x);
      const height = Math.min(rect.height, layout.height - y);
      if (width <= 0 || height <= 0) return;
      seen.add(id);
      const mask = id === "character" && !live2dActive
        ? spriteHitMaskRef.current?.() ?? null
        : null;
      regions.push(mask
        ? { id, kind: "alpha_mask", rect: { x, y, width, height }, mask }
        : { id, kind: "rect", rect: { x, y, width, height } });
    });
    geometryRevision.current += 1;
    void adapter.registerHitGeometry({
      version: 1,
      revision: geometryRevision.current,
      contentWidth: layout.width,
      contentHeight: 520,
      petScale,
      regions,
    });
  }, [adapter, dragging, layout.height, layout.width, live2dActive, petScale, state.bubble.kind, state.composer.kind, state.menu.kind, state.voice.kind]);

  // M9：observers effect 只挂载一次，用 ref 取最新 registerGeometry（不依赖
  // 其每次渲染的新引用，避免全量重建 observers）。
  const registerGeometryRef = useRef(registerGeometry);
  registerGeometryRef.current = registerGeometry;

  useEffect(() => {
    // M9（审计修复）：observers 只随 root 挂载建一次，不再随 surface 状态
    // 变化全量 disconnect+重建。动态挂载区域由 MutationObserver（childList +
    // subtree）实时纳入观察；几何重算由下方单独 effect 在状态变化时触发
    // rAF，避免每轮语音状态切换重建 observers + 起 rAF。
    const root = rootRef.current;
    if (!root) return;
    const frame = window.requestAnimationFrame(() => registerGeometryRef.current());
    const observer = new ResizeObserver(() => registerGeometryRef.current());
    observer.observe(root);
    const observed = new Set<Element>();
    const observeRegions = () => {
      root.querySelectorAll<HTMLElement>("[data-pet-region]").forEach((element) => {
        if (observed.has(element)) return;
        observed.add(element);
        observer.observe(element);
      });
    };
    observeRegions();
    // §6.3：composer/confirmation 卡等区域是动态挂载的，MutationObserver
    // 发现新的 [data-pet-region] 时立即加入 ResizeObserver 并重新注册几何，
    // 否则长内容撑高后命中区域错位。
    const mutation = new MutationObserver(() => {
      observeRegions();
      window.requestAnimationFrame(() => registerGeometryRef.current());
    });
    mutation.observe(root, { childList: true, subtree: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      mutation.disconnect();
    };
  }, []);

  // 几何重算：surface 状态 / mask revision 变化时只重算几何（不重建 observers）
  useEffect(() => {
    // F#9（round3）：rAF id 存入 ref 并在 cleanup cancel——避免卸载后下一帧
    // 仍触发一次 registerGeometry。
    geometryRafRef.current = window.requestAnimationFrame(() => registerGeometryRef.current());
    return () => {
      if (geometryRafRef.current !== null) {
        window.cancelAnimationFrame(geometryRafRef.current);
        geometryRafRef.current = null;
      }
    };
  }, [registerGeometry, spriteHitMaskRevision]);

  useEffect(() => {
    if (!exposeDemoApi) return;
    (window as unknown as Record<string, unknown>).__PET_DEMO__ = demo;
    return () => { delete (window as unknown as Record<string, unknown>).__PET_DEMO__; };
  }, [demo, exposeDemoApi]);

  const hidden = state.lifecycle.kind === "hidden" || state.lifecycle.kind === "suspended";
  const rootStyle: React.CSSProperties = {
    width: layout.width,
    height: layout.height,
    ["--pet-panel-x" as string]: `${layout.panelX}px`,
    ["--pet-menu-x" as string]: `${layout.menuX}px`,
    ["--pet-opposite-panel-x" as string]: `${layout.oppositePanelX}px`,
    ["--pet-toolbar-x" as string]: `${layout.toolbarX}px`,
    ["--pet-drag-x" as string]: `${layout.dragX}px`,
    ["--pet-voice-x" as string]: `${layout.voiceX}px`,
    ["--pet-voice-island-x" as string]: `${layout.voiceIslandX}px`,
  };

  return (
    <div
      ref={rootRef}
      className="pet-surface-root"
      style={rootStyle}
      data-side={side}
      data-surface="pet"
      data-lifecycle={state.lifecycle.kind}
      data-presentation={presentation}
      data-dragging={dragging ? "true" : "false"}
      data-locked={windowState?.locked ? "true" : "false"}
      data-voice-phase={state.voice.kind}
      data-motion={reducedMotion || animationOff ? "reduced" : "full"}
    >
      {hidden ? null : (
        <>
          <div
            className="pet-character-aura"
            style={{
              left: layout.character.x,
              top: layout.character.y,
              width: layout.character.width,
              height: layout.character.height,
            }}
            aria-hidden="true"
          ><i /><i /><i /></div>

          <PetCharacterCanvas
            presentation={presentation}
            side={side}
            petScale={petScale}
            reducedMotion={reducedMotion}
            animationOff={animationOff}
            mirror={side === "bubble-left"}
            live2dEnabled={live2dEnabled}
            occluded={state.occluded}
            inviteOnceTrigger={inviteOnceTrigger}
            emotionCue={state.emotion?.cue ?? null}
            emotionReceivedAt={state.emotion?.receivedAt ?? 0}
            onSpriteReady={handleSpriteReady}
            onRenderModeChange={setLive2dActive}
            live2dStageSize={live2dActive ? { width: layout.live2dStageWidth, height: layout.height } : undefined}
            style={{
              position: "absolute",
              left: layout.spriteCharacter.x,
              top: layout.spriteCharacter.y,
              width: layout.spriteCharacter.width,
              height: layout.spriteCharacter.height,
            }}
          />

          <div
            className="pet-character-hit-zone"
            data-pet-region="character"
            data-pet-character="true"
            style={{
              left: layout.character.x,
              top: layout.character.y,
              width: layout.character.width,
              height: layout.character.height,
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              clearLongPress(gestureRef.current);
              dispatch({ type: "menu.opened" });
            }}
            onPointerDown={(event) => handlePointerDown("character", event)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={(event) => {
              if (gestureRef.current?.pointerId === event.pointerId) finishGesture(true);
            }}
            onClick={(event) => {
              if (event.detail === 0) triggerCharacterClick();
            }}
            onDoubleClick={(event) => event.preventDefault()}
            role="button"
            tabIndex={0}
            aria-label={windowState?.locked ? "学习伴星，位置已锁定" : "学习伴星，可点击对话或拖动位置"}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                triggerCharacterClick();
              } else if (event.key === "ArrowDown" || event.key === "Menu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                dispatch({ type: "menu.opened" });
              }
            }}
          />

          {state.bubble.kind === "confirmation" ? <PetConfirmationCard /> : <PetBubble />}
          <PetComposer textConversationEnabled={textConversationEnabled} voiceDialogueEnabled={voiceDialogueEnabled} />
          <PetMenu learningActionsEnabled={learningActionsEnabled} />
          <PetVoiceControl
            left={layout.voiceX}
            voiceDialogueEnabled={voiceDialogueEnabled}
            fixtureMode={fixtureVoiceEnabled}
          />

          {state.menu.kind === "closed" ? (
            <div className="pet-character-toolbar" data-pet-region="menu_trigger" style={{ left: layout.toolbarX }}>
              <button
                type="button"
                className="pet-character-tool pet-character-chat-button"
                aria-label="和伴星说句话"
                onClick={() => dispatch({ type: "composer.opened" })}
              >
                <PetIcon name="message" />
                <span>对话</span>
              </button>
              <button
                type="button"
                className="pet-character-tool pet-character-menu-button"
                aria-label="打开伴星菜单"
                onClick={() => dispatch({ type: "menu.opened" })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  dispatch({ type: "menu.opened" });
                }}
              >
                <PetIcon name="more" />
                <span>菜单</span>
              </button>
            </div>
          ) : null}

          {state.menu.kind === "closed" && !windowState?.locked ? (
            <button
              type="button"
              className="pet-drag-handle"
              data-pet-region="drag_handle"
              style={{ left: layout.dragX }}
              aria-label="拖动伴星位置"
              title="拖动伴星位置"
              onPointerDown={(event) => handlePointerDown("handle", event)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={(event) => {
                if (gestureRef.current?.pointerId === event.pointerId) finishGesture(true);
              }}
            >
              <PetIcon name="drag" />
            </button>
          ) : null}

          <div
            className="pet-prototype-badge"
            title={voiceDialogueEnabled
              ? "P3 Voice — 真实录音与 ASR；TTS 仍按服务端 capability 控制"
              : textConversationEnabled
                ? "P2 Text — 已连接服务端对话"
                : "P1 Surface Prototype — 演示数据，未连接 AI 服务"}
          >
            <span aria-hidden="true" /> {voiceDialogueEnabled ? "P3 · Voice" : textConversationEnabled ? "P2 · Text" : "P1 · Fixture"}
          </div>

          <div aria-live="polite" className="sr-only pet-aria-status">
            {state.turn.kind === "running" && state.turn.phase === "thinking" ? "正在思考" : ""}
            {state.voice.kind === "listening" ? "正在聆听" : ""}
            {state.voice.kind === "speaking" ? "正在播报" : ""}
            {state.bubble.kind === "error" ? "出现错误" : ""}
          </div>
        </>
      )}
    </div>
  );
}
