# Lighthouse Home V2 layer pack

Geometry source: the approved 1672 × 941 sunny lighthouse study with its warm central rug and no foreground railing.

The clean day, dusk, and night plates were generated from that single geometry while removing the telescope and tripod, the loose desk page, and the catalogue page assembly. Geometry-matched detail plates preserve the approved source pixels used to extract those D4 objects, while the telescope is a project-owned transparent ImageGen cutout. `extract-room-scene-assets.mjs` performs coordinate-preserving crops and polygon alpha masks; it does not redraw or independently reposition time variants.

Runtime intent: D0 remains still; water is a clipped TilingSprite; architecture and furniture are cropped D2/D3 assets; telescope, desk page, and catalog page are D4 assets; D6 contains only the two bottom-corner occluders. No particles, bloom, floating lights, or full-frame pseudo-layers are allowed.
