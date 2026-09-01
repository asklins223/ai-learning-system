# Room plant foreground — night v1

Generation method: built-in ImageGen background extraction, followed by deterministic FFmpeg color-key conversion to a real RGBA PNG.

Reference: `apps/desktop-client/src/renderer/public/assets/learning-room/v1/foreground/search-foreground-night-v1.png`

Prompt:

> Background extraction for a 2.5D learning-room production candidate. Use the referenced night foreground as the exact alignment source. Isolate ONLY the lower-left potted leafy plant and its pot as a single foreground layer; preserve the original pixel position, scale, silhouette, proportions, and night painterly storybook rendering. Keep a full 1672x941 canvas with the plant in its original location. Make every other pixel genuinely transparent RGBA, including the shelves, drawers, paper slots, ladder, walls, floor, rug, window, lights, and shadows. Do not crop, reframe, move, resize, relight, repaint, add, remove, or invent anything inside the isolated plant. No text, logo, watermark, border, background, checkerboard pixels, or new objects. Output only the transparent extracted layer.

Post-processing:

```sh
ffmpeg -hide_banner -loglevel error -y -i <imagegen-output.png> -vf "colorkey=0xf7f7f7:0.10:0.0" -frames:v 1 -c:v png -pix_fmt rgba <rgba-output.png>
```

Review note: the generated night plant is isolated and aligned as a review candidate; final visual approval is still required before release.
