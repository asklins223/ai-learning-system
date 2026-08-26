# Learning room V1 asset provenance

This runtime bundle contains reviewed copies, mechanical derivatives, and two generated first-person scene backplates. The generated sources preserve their complete prompts both as PNG metadata and as adjacent text files under `prompts/`.

## Study object-level repair candidate and rejected Review history

- `objects/study-open-notebook-v1.png` is the byte-identical runtime copy of `docs/design/assets/static/study-open-notebook-v1.png`. It is a 1536×1024 RGBA open-notebook material frame for the Study sample; all objective text, source identity, state and actions remain semantic DOM. The source sidecar and complete two-step generation/background-extraction prompt are adjacent to the source candidate and embedded in its PNG metadata. SHA-256: `96aaeddb4f5883b8da5c34f8180c63fb9f3c6e6242a50e7047453c3738461d5e`.
- `review-card-tray-v1.png` and `review-card-stand-v2.png` were both explicitly rejected in Owner re-review. V1 baked a false card hierarchy into the prop; V2 removed the baked cards but still made an oversized three-dimensional frame the layout coordinate system, creating mismatched perspective, false affordances and a compressed DOM task. Their design sources, prompt records and sidecars remain under `docs/design/assets/static/` for audit. Neither file is present in this runtime root or referenced by the manifest.
- Review now uses one continuous semantic DOM ledger over the existing paper texture. No replacement Review bitmap was generated because the missing capability was layout and information hierarchy, not imagery. The Review sample remains `CHANGES_REQUIRED`; this retirement does not imply Owner approval.

## Generated paper and card material replacements

- `objects/scene-card-stack-v2.png` is the byte-identical runtime copy of `docs/design/assets/static/scene-card-stack-v2.png`: a 1536×1024 RGBA blank four-card material/occlusion layer. Its complete prompt is stored at `docs/design/assets/static/scene-card-stack-v2.prompt.txt`; the fact sidecar records the empty source-input list, operator, workflow, C2PA agent, dimensions, byte size, SHA and review state. SHA-256: `803eda3b5ecf672262209075578da346ecc85a3b48cc0fc9dab0ac99a859e3cf`.
- `textures/scene-paper-fibres-v2.png` is the byte-identical runtime copy of `docs/design/assets/static/scene-paper-fibres-v2.png`: a 1254×1254 RGB low-contrast paper material. Its complete prompt and fact sidecar are adjacent to the source candidate. SHA-256: `2ccc53a8e70d1bd3de655cf29b0bf3c1be672d43f2e9e21199ed05aad83365db`.
- Both replacements were generated through the OpenAI built-in `image_gen` workflow without external image inputs at 2026-08-24T23:59:49+08:00 and 2026-08-25T00:00:16+08:00 respectively. The embedded C2PA identifies OpenAI Media Service API / `gpt-image` 2.0 and `trainedAlgorithmicMedia`. Both remain `reviewOnly: true`, `releaseApproval: false`, and `CHANGES_REQUIRED`; provenance completeness does not equal Owner approval.

## Recovered historical repair candidates — blocked

- The former runtime files `objects/scene-card-stack-v1.png` and `textures/scene-paper-fibres-v1.png` were the earliest surviving repository copies found in the 2026-08-24 audit. Their embedded C2PA claims prove creation by the OpenAI Media Service API with software agent `gpt-image` version `2.0`, digital source type `trainedAlgorithmicMedia`, and claim time `2026-08-24T00:00:00Z`.
- The C2PA claims do **not** contain either prompt, source inputs, operator identity, intended asset ID, or a complete project license record. Repository search found no older source PNG, prompt file, or sidecar. Byte-identical archival copies and fact-only sidecars are retained under `docs/design/assets/static/_recovered/`; this recovery does not turn them into authoritative masters.
- SHA-256: card stack `279f1e3de98b5ea082d42d0c849e887c2b2aa7c7b566091bb1ba9b25cba1d11d`; paper fibres `e5d4c452820f981abf091eabc940753c8b694400a24bf5bbb8a55a0b08574bb3`. Both remain `SOURCE_PROVENANCE_INCOMPLETE · BLOCKED_REPLACED · releaseApproval: false`. They have been removed from the runtime root and replaced by the fully recorded V2 candidates above; their only retained copies are the recovered design-audit artifacts.

## First-person seated scene V2

- `posters/study-seat-day-v2.png` was generated for this frontend refactor as a 1672×941 production backplate. It changes the learning room from an external overview to the learner's seated eye-level view: window ahead, foreground desk, physical notebook/card box/mug, and an interactable brass lamp. The image intentionally contains no UI or companion so both stay accessible DOM layers. SHA-256: `69e2642de42b9cf62cca3e6b2318e1abea9017ef5da1af92bf275a8edd3f7fad`.
- `posters/study-seat-night-v2.png` is a lighting edit of the day composition, preserving its camera and object geometry while switching to indigo window light and a localized warm lamp pool. Its source was resized by one pixel in width with macOS ImageIO so both runtime themes share a 1672×941 registration. SHA-256: `8b5102a81f189ccf45a18bbd39a67eeb57800d2e8fc6336bc0a26feef89679c1`.
- Authoritative prompts are embedded under the `impeccable:prompt` PNG text key and duplicated verbatim at `prompts/study-seat-day-v2.txt` and `prompts/study-seat-night-v2.txt`.
- `room-day.webp` and `room-night.webp` remain the homepage scene truth. Seat V2 is selected only after the learner enters a concrete study, review, search, graph, card, or validation scene.
- The registered window videos remain approved only for the homepage overview camera. They are never mounted over Seat V2, so the closer scene cannot inherit the legacy registration seam.

## Canonical room imagery

- `posters/room-day.webp` is an unchanged copy of `assets/3d/learning-room/v1/fallback/room-furnished-day.webp`, derived from `docs/design/assets/static/room-furnished-day-user-2x-v1.png`.
- `posters/room-night.webp` is an unchanged copy of `assets/3d/learning-room/v1/fallback/room-furnished-night.webp`, derived from `docs/design/assets/static/room-furnished-night-user-2x-v1.png`.
- `objects/companion-orb.webp` is an unchanged copy of the abstract, faceless `assets/3d/learning-room/v1/fallback/companion-orb.webp`, derived from `docs/design/assets/static/companion-orb-flat-fallback-v1.png`.

The complete source PNG sidecars in `docs/design/assets/static/` remain the authority for generation prompts, source identifiers, hashes, and review state. The historical `assets/3d/` tree is a local migration/reference archive only and is excluded from fresh renderer output and packages; it is not a packaged provenance authority. The two `_recovered/` sidecars above explicitly remain incomplete and blocked.

## Existing fallback objects and textures

- `objects/*.webp` are unchanged copies of matching files in the local migration archive under `assets/3d/learning-room/v1/fallback/`.
- `textures/*.webp` are unchanged copies of matching files in the local migration archive under `assets/3d/learning-room/v1/textures/p0/`.
- The archive's adjacent `.json` files remain development-time provenance records, but the complete `assets/3d/` archive is intentionally absent from fresh `out` and `app.asar`.

## Package containment

- Production renderer builds use an explicit filtered public-asset emitter instead of Vite's blanket public-directory copy. The complete `assets/3d/` migration archive is excluded.
- `assets/companion/live2d-v1/` and its `assets/companion/vendor/` runtime are excluded because the reviewed model record does not authorize redistribution. The legal abstract orb remains available at `objects/companion-orb.webp`; package containment must prove that fallback is present.
- Packaged smoke fails closed unless `app.asar` is newer than both source and renderer build output, embeds a byte-identical V1 manifest, contains every manifest asset, excludes both archive families, and contains none of the four rejected motion files.
- A 2026-08-25 isolated electron-builder `--dir` preflight (outside `release/`) verified this boundary against a fresh `app.asar`: source, out, and packaged manifests were byte-identical with SHA-256 `5e93f5234b587ef20ce413b8b89085c9f3467e8bd620ceb658548e93d6037936`; all 30 manifest assets and the legal orb were present; rejected media, `assets/3d/`, Live2D, and its vendor runtime were absent. The same temporary package passed anonymous offline cold-start and online Auth Gate smoke without mounting Room, ActionRail, or Onboarding. This is containment and anonymous Gate evidence only, not release approval, an authenticated journey, or a signed canonical package.

## Motion and graph media

- `motion/window-day-loop-v2.mp4`, `motion/window-night-loop-v2.mp4`, and `motion/onboarding-first-entry-v1.mp4` are unchanged copies of matching files under `docs/design/assets/motion/`.
- The rejected `graph-entry-fog-v1.mp4` and `validation-ink-bloom-v1.mp4` candidates remain only in the design-source archive for review history. They are intentionally absent from this runtime asset root and manifest; Graph and Validation declare `motionImplementation: "code"` instead.
- `graph/graph-entry-background-v1.avif` is a lossless workflow derivative of `docs/design/assets/static/graph-entry-background-v1.png`, converted locally with macOS ImageIO (`sips`).
- Motion selection is declared in `manifest.json`. Only the current window and onboarding candidates are present in the runtime asset root; rejected Graph, Validation, and Companion motion stays outside the package in the design-source archive.

### Vertical window-fit derivatives

The 1280×720 source videos are retained unchanged. The runtime window paths point to narrow derivatives whose 462×720 display aspect closely matches the registered window aperture (491.568×767.856 reference pixels, aspect 0.6402). Both themes use the same source crop so switching theme does not change the landscape viewpoint; the right-weighted crop preserves the night moon. A small keystone maps the image to the sloped window header before the existing four-pane mask is applied.

- `motion/window-day-vertical-fit-v1.mp4`
  - Source: `motion/window-day-loop-v2.mp4`, SHA-256 `73b9821eb623fd490ea8df5a42b34d88eea55c594baa09f2f36e9b2710f01a8e`.
  - Crop: `462:720:640:0`; perspective destination corners: `(0,32)`, `(W,0)`, `(0,H-4)`, `(W,H)`.
  - Runtime: H.264 High, `yuv420p`, 462×720, 24 fps, 241 frames; the source AAC-LC track is stream-copied and remains runtime-muted.
  - SHA-256: `f121dfd3e4901ab1e1671032bf80f8d7fa589e05264ae53bf1dd1d417311466c`.
- `motion/window-night-vertical-fit-v1.mp4`
  - Source: `motion/window-night-loop-v2.mp4`, SHA-256 `04a2dd44f82a68bebb5d0c5bf5fa07f213d2cc2c300bccef899c61be534b5fab`.
  - Crop and perspective: identical to the day derivative.
  - Runtime: H.264 High, `yuv420p`, 462×720, 24 fps, 241 frames; the source AAC-LC track is stream-copied and remains runtime-muted.
  - SHA-256: `257972a3cca222ca91828b6ff680d08a3a2cebe2bd7a0c251b0394a8f7f09d24`.

Both were encoded locally with FFmpeg 9.0.1 / libx264 using `-preset slow -crf 18 -profile:v high -level:v 4.0 -pix_fmt yuv420p -movflags +faststart`. The source video dimensions, duration, frame rate, and audio parameters were not changed or regenerated; the derivatives are application-side compatibility assets.

### First-entry Mandarin audio and captions

- `audio/onboarding-first-entry-zh-CN-v1.m4a` is a bit-for-bit AAC packet remux of audio stream `0:1` from `motion/onboarding-first-entry-v1.mp4`; it is not resampled, normalized, denoised, or synthesized. It is AAC-LC, 44.1 kHz stereo, 8.050 seconds, about 127 kb/s, tagged `zho`, and has SHA-256 `0288c4797d601087cef7bdb05b7102608ab0866ecaa30ba3384b8b3eaa538960`.
- `captions/onboarding-first-entry-zh-CN-v1.vtt` contains three Mandarin cues aligned to the extracted waveform and an unprompted local Whisper.cpp 1.9.2 base-model pass. The ASR output matched the supplied script except for the homophone `研究测`; that token was corrected to the authoritative script wording `研究册`. Concatenating the cues exactly yields `欢迎来到理解书房。点击桌上的研究册，写下第一个想真正弄懂的问题吧。`. SHA-256: `1cb1bd3feb787a6b3a3e07997bfc08132f61acf464b9355fa53045a5d5966cf0`.
- The source onboarding file probes as H.264 Constrained Baseline, `yuv420p`, 1920×1080, 24 fps, 193 frames, plus AAC-LC 44.1 kHz stereo. Video duration is 8.041667 seconds; audio/container duration is 8.050 seconds. The extracted voice measures approximately -20.4 LUFS integrated and -9.2 dBFS true peak. It was deliberately preserved instead of being altered to meet an aspirational loudness target.

## Code-native asset

- `masks/window-glass-mask-v1.svg` is an implementation-authored vector mask based on the frozen window registration in `docs/design/2d-learning-room-motion-design.md`. Its softly feathered plant-leaf silhouette is an internal alpha cutout of the lower-right pane. This avoids the previous even-odd compound path behavior that made the part of the plant below the glass into an additional video-visible island, while preserving moving scenery in the natural gaps between leaves. It contains no generated raster content. SHA-256: `d791cc5c024e9cd2ada16ead616a08596546629f05185b1e6d5beaeb1ae5f592`.
