import { useLayoutEffect, type RefObject } from "react";
import { relativeQuadToCssMatrix3d, type SceneQuad } from "./scene-geometry";
import { surfaceLocalQuad, type SceneSurfaceRegistration } from "./scene-surfaces";

export type SceneSurfaceProjectionTarget = {
  readonly ref: RefObject<HTMLElement | null>;
  readonly surface: SceneSurfaceRegistration;
};

export type SceneSurfaceQuadOverrides = Readonly<Record<string, SceneQuad>>;

export type SceneSurfaceProjectionOptions = {
  readonly active: boolean;
  readonly compactMediaQuery: string;
  readonly quadOverrides?: SceneSurfaceQuadOverrides;
};

export function useSceneSurfaceProjections(
  targets: readonly SceneSurfaceProjectionTarget[],
  options: SceneSurfaceProjectionOptions,
): void {
  useLayoutEffect(() => {
    if (!options.active) return undefined;

    const mountedTargets = targets.flatMap((target) => {
      const element = target.ref.current;
      return element ? [{ element, surface: target.surface }] : [];
    });
    if (!mountedTargets.length) return undefined;

    const compactQuery = window.matchMedia(options.compactMediaQuery);
    let animationFrame = 0;

    const applyProjection = () => {
      const flatten = compactQuery.matches;
      const measurements = mountedTargets.map(({ element, surface }) => ({
        element,
        surface,
        width: element.offsetWidth,
        height: element.offsetHeight,
      }));
      const updates = measurements.map(({ element, surface, width, height }) => {
        let matrix: string | null = null;
        if (!flatten && width > 0 && height > 0) {
          try {
            matrix = relativeQuadToCssMatrix3d(
              { width, height },
              surfaceLocalQuad(surface, options.quadOverrides?.[surface.id] ?? surface.quad),
            );
          } catch {
            matrix = null;
          }
        }
        return {
          element,
          surface,
          matrix: matrix ?? "none",
          state: flatten ? "flat" : matrix ? "projected" : "invalid",
        };
      });

      for (const update of updates) {
        update.element.style.setProperty("--scene-surface-projection", update.matrix);
        update.element.dataset.sceneSurface = update.surface.id;
        update.element.dataset.sceneSurfaceProjection = update.state;
      }
    };

    const scheduleProjection = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        applyProjection();
      });
    };

    applyProjection();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleProjection);
    for (const { element } of mountedTargets) observer?.observe(element);
    window.addEventListener("resize", scheduleProjection, { passive: true });
    compactQuery.addEventListener("change", scheduleProjection);

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleProjection);
      compactQuery.removeEventListener("change", scheduleProjection);
      for (const { element } of mountedTargets) {
        element.style.removeProperty("--scene-surface-projection");
        delete element.dataset.sceneSurfaceProjection;
      }
    };
  }, [options.active, options.compactMediaQuery, options.quadOverrides, targets]);
}
