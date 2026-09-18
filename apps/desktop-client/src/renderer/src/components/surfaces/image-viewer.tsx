import { useCallback, useState, useEffect, useRef, type ReactNode } from "react";
import { useSourceImage } from "./source-image";

/**
 * 通用图片预览（灯箱 + 整篇画廊）。
 *
 * 任何页面想给图片加「点击放大、左右切换、明确关闭」，用这三样：
 *
 * - `useImageLightbox(count)`：持有"当前开着第几张"的状态，返回
 *   `{ openIndex, isOpen, openAt, setIndex, close }`，缩略图 `onClick` 里
 *   调 `openAt(i)` 即可。
 * - `ImageGalleryLightbox`：画廊灯箱，默认盖满整个窗口；`variant="card"`
 *   时只盖住最近的定位卡片（纸面详情页用这个形态）。数据是 `GalleryImage[]`——站内地址
 *   （`/api/uploads/…`）标 `kind:"internal"`，切到哪张才取哪张字节；已经
 *   能直接给 `<img>` 的地址（blob:/https:）标 `kind:"resolved"`。
 * - `ZoomableReadingImage`：单张可放大缩略图（不关心画廊序号时用，自持开关）。
 *
 * 交互约定：Esc / 右上角关闭按钮 / 点遮罩三种方式退出；多图时左右箭头、
 * ←→ 键、触摸滑动切换并循环；灯箱开着时锁住页面滚动。
 */

/** 画廊里的一张图。 */
export type GalleryImage =
  /** 站内对象地址：灯箱按需走取字节通道（见 `source-image.ts`）。 */
  | { readonly kind: "internal"; readonly url: string; readonly alt: string }
  /** 已可直接交给 `<img>` 的地址（blob URL / 站外直链）。 */
  | { readonly kind: "resolved"; readonly src: string; readonly alt: string };

/**
 * 画廊开关状态：给任意一排缩略图接上"点开第 i 张"的能力。
 *
 * `count` 是画廊总张数；开合与越界收敛都在这里，调用方只剩
 * `onClick={() => openAt(i)}` 一行。切换时 `LightboxViewer` 传回来的序号
 * 已经循环处理过，`setIndex` 只需兜住边界。
 */
export function useImageLightbox(count: number) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openAt = useCallback((index: number) => {
    if (count <= 0) return;
    setOpenIndex(Math.min(Math.max(index, 0), count - 1));
  }, [count]);
  const close = useCallback(() => setOpenIndex(null), []);
  const setIndex = useCallback((index: number) => {
    if (count <= 0) return;
    setOpenIndex(Math.min(Math.max(index, 0), count - 1));
  }, [count]);
  return { openIndex, isOpen: openIndex !== null, openAt, setIndex, close };
}

/**
 * 灯箱骨架：遮罩、计数、切换与关闭的交互都在这里，画什么由 `children` 给
 * ——单图直接给 `<img>`，画廊给一张幻灯片。
 *
 * `onIndexChange` 缺席即单图模式：隐藏箭头与计数，只保留放大与关闭。
 */
/** `fullscreen` 盖满窗口；`card` 只盖住最近的 `position: relative` 卡片。 */
export type LightboxVariant = "fullscreen" | "card";

export function LightboxViewer({
  alt,
  count,
  index,
  variant = "fullscreen",
  onClose,
  onIndexChange,
  children,
}: {
  readonly alt: string;
  readonly count: number;
  readonly index: number;
  readonly variant?: LightboxVariant;
  readonly onClose: () => void;
  readonly onIndexChange?: (index: number) => void;
  readonly children: ReactNode;
}) {
  const gallery = count > 1 && onIndexChange !== undefined;
  // 键盘处理挂在 window 上，回调每轮渲染都换；经 ref 转发就不必反复解绑重绑。
  const navigateRef = useRef<((delta: number) => void) | null>(null);
  navigateRef.current = gallery
    ? (delta: number) => onIndexChange?.((index + delta + count) % count)
    : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") navigateRef.current?.(-1);
      if (event.key === "ArrowRight") navigateRef.current?.(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 灯箱开着时锁住纸面滚动，触摸滑动只属于切换图片。
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  const touchStartX = useRef<number | null>(null);

  return (
    <div
      className={variant === "card" ? "image-lightbox image-lightbox--card" : "image-lightbox"}
      role="dialog"
      aria-modal="true"
      aria-label={gallery
        ? `${alt}（放大预览 ${index + 1}/${count}，Esc 关闭）`
        : `${alt}（放大查看，Esc 关闭）`}
      onClick={onClose}
      onTouchStart={(event) => { touchStartX.current = event.touches[0]?.clientX ?? null; }}
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        const end = event.changedTouches[0]?.clientX;
        if (start === null || end === undefined) return;
        const deltaX = end - start;
        // 48px 以下算误触，不做翻页。
        if (Math.abs(deltaX) >= 48) navigateRef.current?.(deltaX < 0 ? 1 : -1);
      }}
    >
      {gallery ? (
        <button
          type="button"
          className="image-lightbox-nav image-lightbox-prev"
          aria-label="上一张"
          onClick={(event) => { event.stopPropagation(); navigateRef.current?.(-1); }}
        >
          ‹
        </button>
      ) : null}
      <figure className="image-lightbox-stage" onClick={(event) => event.stopPropagation()}>
        {children}
        <figcaption>
          <span>{alt}</span>
          {gallery ? <span className="image-lightbox-counter">{index + 1} / {count}</span> : null}
        </figcaption>
      </figure>
      {gallery ? (
        <button
          type="button"
          className="image-lightbox-nav image-lightbox-next"
          aria-label="下一张"
          onClick={(event) => { event.stopPropagation(); navigateRef.current?.(1); }}
        >
          ›
        </button>
      ) : null}
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="关闭预览"
        onClick={(event) => { event.stopPropagation(); onClose(); }}
      >
        ×
      </button>
    </div>
  );
}

/** 灯箱里的一张站内图：和阅读页正文同一份取字节通道与缓存。 */
function LightboxSlide({
  url,
  alt,
  workspaceEpoch,
}: {
  readonly url: string;
  readonly alt: string;
  readonly workspaceEpoch?: number;
}) {
  const { state, retry } = useSourceImage(url, workspaceEpoch);
  if (state.status === "ready" || state.status === "external") {
    return <img src={state.src} alt={alt} />;
  }
  if (state.status === "loading") {
    return <div className="image-lightbox-pending" role="status">正在载入图片…</div>;
  }
  return (
    <div className="image-lightbox-pending">
      这张图片没能取回：{alt}
      <button type="button" className="text-action text-action--strong" onClick={retry}>
        重试
      </button>
    </div>
  );
}

/**
 * 通用图片画廊：按传入顺序全屏切换浏览。
 *
 * 不关心图片来自笔记、来源解析还是别的什么列表——`GalleryImage` 说清每张
 * 的地址形态即可。`internal` 的图切到才取字节（命中同一份 LRU 缓存，正文
 * 加载过的瞬间就位），不会让首张图等在整队后面。
 */
export function ImageGalleryLightbox({
  images,
  index,
  variant,
  workspaceEpoch,
  onClose,
  onIndexChange,
}: {
  readonly images: readonly GalleryImage[];
  readonly index: number;
  readonly variant?: LightboxVariant;
  readonly workspaceEpoch?: number;
  readonly onClose: () => void;
  readonly onIndexChange: (index: number) => void;
}) {
  const bounded = Math.min(Math.max(index, 0), images.length - 1);
  const current = images[bounded];
  if (!current) return null;
  return (
    <LightboxViewer
      alt={current.alt}
      count={images.length}
      index={bounded}
      variant={variant}
      onClose={onClose}
      onIndexChange={onIndexChange}
    >
      {current.kind === "resolved"
        ? <img src={current.src} alt={current.alt} />
        : <LightboxSlide url={current.url} alt={current.alt} workspaceEpoch={workspaceEpoch} />}
    </LightboxViewer>
  );
}

/**
 * 阅读页里的可放大图片：平时受版心约束，点击进灯箱看原图。
 *
 * 来源详情页的图片片段与笔记阅读页的图片块共用这一个组件，保证两处的交互与
 * 样式一致。`retryable`/`onRetry` 透传 blob URL 失效时的重试（见
 * `source-image.ts` 缓存淘汰的兜底说明）。
 *
 * 只给一张图用。整篇有多张、需要互相切换时，缩略图只负责
 * `onClick={() => openAt(i)}`，灯箱交给 `ImageGalleryLightbox`——受控模式
 * 下这个组件不再自渲染灯箱，避免两层遮罩叠在一起。
 */
export function ZoomableReadingImage({
  src,
  alt,
  retryable,
  onRetry,
  open,
  onOpenChange,
}: {
  readonly src: string;
  readonly alt: string;
  readonly retryable?: boolean;
  readonly onRetry?: () => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;
  const setOpen = onOpenChange ?? setSelfOpen;
  // 受控模式（页面级画廊接管开关）时不在组件内再渲染一层灯箱。
  const renderLocal = open === undefined;
  return (
    <>
      <img
        className="reading-image"
        src={src}
        alt={alt}
        loading="lazy"
        onError={retryable ? onRetry : undefined}
        onClick={() => setOpen(true)}
      />
      {isOpen && renderLocal ? (
        <LightboxViewer alt={alt} count={1} index={0} onClose={() => setOpen(false)}>
          <img src={src} alt={alt} onError={retryable ? onRetry : undefined} />
        </LightboxViewer>
      ) : null}
    </>
  );
}
