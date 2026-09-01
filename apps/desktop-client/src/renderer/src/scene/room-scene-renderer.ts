import { Container, Sprite, type Texture } from "pixi.js";
import { SCENE_WORLD } from "./scene-geometry";

export type RoomScenePosterNode = Readonly<{
  /** Container owned by the Pixi renderer host. */
  readonly root: Container;
  /** Sprite is kept exposed for renderer diagnostics and future transitions. */
  readonly sprite: Sprite;
}>;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Create the poster-backed D0 node for the first real room renderer slice.
 *
 * The source image may be a 2x export (the current room posters are
 * 3344×1882), so the sprite is normalized into the canonical 1672×941 world
 * instead of relying on a CSS image-size assumption. The returned container
 * is presentation-only and never opts into Pixi hit testing.
 */
export function createRoomScenePosterNode(texture: Texture): RoomScenePosterNode {
  if (!texture || texture.destroyed) {
    throw new Error("Room scene poster texture is unavailable.");
  }
  if (!isPositiveFinite(texture.width) || !isPositiveFinite(texture.height)) {
    throw new Error("Room scene poster texture dimensions are invalid.");
  }

  const root = new Container({
    label: "room-scene-poster-node",
    eventMode: "none",
    interactiveChildren: false,
  });
  const sprite = new Sprite({ texture });
  sprite.label = "room-scene-poster";
  sprite.eventMode = "none";
  sprite.interactiveChildren = false;
  sprite.anchor.set(0);
  sprite.scale.set(
    SCENE_WORLD.width / texture.width,
    SCENE_WORLD.height / texture.height,
  );
  root.addChild(sprite);

  return Object.freeze({ root, sprite });
}
