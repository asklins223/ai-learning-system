import { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { SCENE_WORLD } from "./scene-geometry";
import { createRoomScenePosterNode } from "./room-scene-renderer";

describe("room scene poster renderer slice", () => {
  it("normalizes a 2x poster into the canonical room world and stays non-interactive", () => {
    const texture = Texture.WHITE;
    const node = createRoomScenePosterNode(texture);

    expect(node.root).toBeInstanceOf(Container);
    expect(node.root.label).toBe("room-scene-poster-node");
    expect(node.root.eventMode).toBe("none");
    expect(node.root.interactiveChildren).toBe(false);
    expect(node.sprite.parent).toBe(node.root);
    expect(node.sprite.eventMode).toBe("none");
    expect(node.sprite.anchor.x).toBe(0);
    expect(node.sprite.anchor.y).toBe(0);
    expect(node.sprite.scale.x).toBe(SCENE_WORLD.width / texture.width);
    expect(node.sprite.scale.y).toBe(SCENE_WORLD.height / texture.height);

    node.root.destroy({ children: true });
    expect(texture.destroyed).toBe(false);
  });

  it("rejects a destroyed poster texture before mounting a partial node", () => {
    const texture = new Texture();
    texture.destroy(true);

    expect(() => createRoomScenePosterNode(texture)).toThrow("poster texture is unavailable");
  });
});
