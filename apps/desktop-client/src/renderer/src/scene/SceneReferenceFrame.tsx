import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import {
  SCENE_COORDINATE_SPACE_ID,
  SCENE_WORLD,
  type SceneFitMode,
} from "./scene-geometry";

type SceneReferenceFrameProps = ComponentPropsWithoutRef<"div"> & {
  readonly fitMode?: SceneFitMode;
};

type SceneReferenceFrameStyle = CSSProperties & {
  readonly "--scene-world-aspect": string;
};

const referenceFrameStyle = Object.freeze({
  "--scene-world-aspect": String(SCENE_WORLD.aspectRatio),
}) as SceneReferenceFrameStyle;

export const SceneReferenceFrame = forwardRef<HTMLDivElement, SceneReferenceFrameProps>(function SceneReferenceFrame(
  { className, fitMode = "cover", style, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={["scene-reference-frame", className].filter(Boolean).join(" ")}
      data-scene-coordinate-space={SCENE_COORDINATE_SPACE_ID}
      data-scene-fit={fitMode}
      style={{ ...referenceFrameStyle, ...style }}
    />
  );
});
