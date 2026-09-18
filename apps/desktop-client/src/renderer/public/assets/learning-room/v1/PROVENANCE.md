# Learning room V1 asset provenance

## Home V2 lighthouse study (2026-09-15)

- Stable fallback posters: `posters/home-v2/lighthouse/lighthouse-{day,dusk,night}-poster-v1.png`. All three use the approved 1672 × 941 lighthouse geometry; dusk and night are lighting references, never independent layouts.
- Production layers: `layers/home-v2/lighthouse/`. D0 is the clean room plate, D1 is a cropped water texture, D2 contains three window-structure crops, D3 contains desk/shelf/rest furniture groups, D4 contains the telescope plus two independently masked page pieces, and D6 contains only two cropped bottom-corner occluders. D5 remains the independent Live2D and semantic-feedback layer.
- Clean plates and the telescope were produced with OpenAI ImageGen from the owner-approved room geometry. The project-local sources live in `.impeccable/review/home-v2-lighthouse-layer-sources-v1`; no third-party reference image was supplied.
- `scripts/extract-room-scene-assets.mjs` applies the shared time-template specification at `scripts/fixtures/lighthouse-home-scene-assets.input.json`. It performs coordinate-preserving FFmpeg crops, scaling, RGBA conversion, and polygon masks. `scripts/sync-room-scene-manifest.mjs` records registrations and hashes.
- License: project-generated original visual for this product; internal product use is permitted. Every runtime layer records its exact pixel size, world registration, SHA-256, source poster, prompt record, review status, and release approval.
- Stable frames contain no particles, bloom, lens flares, floating light points, text, character, or UI. The complete derivation contract is stored at `prompts/home-v2/lighthouse/lighthouse-layer-pack-v1.md`.

This runtime bundle contains reviewed copies, mechanical derivatives, and generated scene backplates. Where a generated source has a complete prompt record, it is preserved in PNG metadata and as an adjacent text file under `prompts/`.

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
- `room-day.webp` and `room-night.webp` remain the homepage scene truth. Seat V2 is selected for concrete study, review, graph, card, or validation scenes; Search selects its own reference-archive scene instead of inheriting the study seat.
- The registered window-video assets remain archived for provenance, but the homepage no longer mounts them. The canonical room poster supplies the complete window view without a registration seam or independent pointer parallax.

## Search reference archive scene A

- `posters/search-reference-day-v1.png` is a generated 1672×941 full-bleed reference-archive scene for the Search destination. It is a separate frontal room with a built-in walnut archive wall, one central catalogue ledger, six embedded index-paper carriers, shelf lips and drawer edges. The image contains no product copy or UI; the query, result and scope text remain semantic DOM ink. SHA-256: `02f6964cef3d4efb051f0a4d5e5b30ed808a8921c52d7f1dc26192257041f3d9`.
- `posters/search-reference-night-v1.png` is the lighting edit of the same Search scene, preserving the camera and surface geometry while adding blue dusk, warm archive lamps and deeper walnut shadows. SHA-256: `e80ddd93c9f138b20e01b1948e88e0453b67b4712cb817ca435c18fe55c50eb6`.
- Complete prompts are embedded under `impeccable:prompt` and duplicated at `prompts/search-reference-day-v1.txt` and `prompts/search-reference-night-v1.txt`.
- Search now selects `searchPosters.day/night` as a scene-level backplate. The former `objects/shelf.webp` floating overlay is intentionally not part of this scene; Surface homographies are calibrated directly against the archive wall's physical paper carriers.
- The reviewed `textures/scene-paper-fibres-v2.png` remains available for Review, Study and Notebook material work; the Phase 1H low-contrast Search CSS material overlay was retired in Phase 1L, so Search no longer mounts that texture or other non-interactive translucent DOM fills. Phase 1J derives `foreground/search-foreground-day-v1.png` and `foreground/search-foreground-night-v1.png` from the corresponding reviewed Search backplates with `scripts/derive-search-foreground.py`: only the six central walnut slot fronts and a restrained source-derived contact shadow are retained on a same-size transparent RGBA canvas. SHA-256: day `b7b36f509b118803d3be139a5f33c2b974fd83716a448779f2e779b421436401`; night `52d52211fdf47fd26cbe1a6713ccee45fbf2334d193a3372e160aa057808079c`. The Search registry records both foreground hashes and keeps the CSS lip as a load-failure fallback; the foreground layer is `pointer-events: none` and hidden in compact mode.

## Login door threshold scene V1

- `posters/login-entry/entry-door-closed-day-v1.png` and `entry-door-closed-night-v1.png` are the closed-door threshold backplates. They deliberately show a separate hallway/door scene, not the interior learning-room homepage; the left wall is reserved for the semantic login form and the door occupies the right-hand visual anchor. SHA-256: day `4fe60dd1a1310ef4d01e57c2aed9622288fd65783b8efd3443318c064b9badf2`; night `f56ccfafabef4a9ce3d4c5a0687a513aff684bcaf96ccb7af657fc44d67f5a72`.
- `posters/login-entry/entry-door-open-day-v1.png` and `entry-door-open-night-v1.png` preserve the threshold camera and reveal the warm study interior through the open door. They remain review/reference posters for the composition; the runtime transition now builds the opening from the closed threshold texture, a PixiJS `PerspectiveMesh` hinged slab, stencil-clipped door aperture and a crop of the canonical room texture. The actual post-auth page remains the existing home room DOM and scene. SHA-256: day `499df910110ca097769dd522b847035323ccd4012d9db57fa64bc66480ce94d1`; night `3252cd203be1e23f4e91a3802dc45bdbeb18d54a57c247039e4aa633c5741372`.
- `objects/login-entry/door-slab-day-v2.png` and `door-slab-night-v2.png` remain reviewed transparent door-leaf alternatives, with full top and bottom edges, both stiles, panel faces, lever and hinge-side hardware. They are retained for future asset work but are intentionally not loaded by the current runtime transition: an independently generated slab cannot guarantee pixel registration against the closed poster and caused a visible width/color snap in the first movement frames. `DoorOpeningTransition` now derives a `546×880` door texture directly from the closed poster's registered `(x: 946, y: 0)` crop, then sends that crop through PixiJS `PerspectiveMesh`.
- The four 1672×941 PNGs were generated through the OpenAI built-in `image_gen` workflow for this desktop entry refactor and carry OpenAI C2PA provenance. They contain no product copy, form controls or companion; `DesktopAccessGate` owns all semantic DOM and authentication behavior. The runtime manifest registers all four paths under `entryPosters`; `DoorOpeningTransition` selects the day/night closed poster and canonical room texture, while the open posters remain available as visual review references. GSAP sequences latch release, hinge rotation, interior light, camera push and the final DOM handoff. These remain `reviewOnly: true`, `releaseApproval: false`, and `CHANGES_REQUIRED` pending owner review.

## Canonical room imagery

- `foreground/home-foreground-leaves-v1.png` is a 1672×941 transparent RGBA near-camera foliage layer generated through the OpenAI built-in `image_gen` workflow on 2026-09-08 using `posters/room-day.webp` only as the style, palette and lighting reference. It contains no UI, text, person or business content. Runtime placement keeps it in D6, outside the functional desk center, with a low-amplitude GSAP sway and a static reduced-motion frame. SHA-256: `7f42ffaf3f2f660caee03338f691b94cc4e95fbb93ce6cb2082a8a5f84a50d82`. The complete prompt is stored at `prompts/home-foreground-leaves-v1.txt`.

- `posters/room-day.webp` is an unchanged copy of `assets/3d/learning-room/v1/fallback/room-furnished-day.webp`, derived from `docs/design/assets/static/room-furnished-day-user-2x-v1.png`.
- `posters/room-night.webp` is an unchanged copy of `assets/3d/learning-room/v1/fallback/room-furnished-night.webp`, derived from `docs/design/assets/static/room-furnished-night-user-2x-v1.png`.
- `objects/companion-orb.webp` **was removed on 2026-09-16** together with its `manifest.json` `companion` entry. Per the Owner decision the companion has a single form (in-window Live2D) and a load failure hides the character behind a dismissible notice, so no static substitute is shipped. Its historical source was `assets/3d/learning-room/v1/fallback/companion-orb.webp`, derived from `docs/design/assets/static/companion-orb-flat-fallback-v1.png`; the archived 3D pack still carries those files as frozen evidence.

The complete source PNG sidecars in `docs/design/assets/static/` remain the authority for generation prompts, source identifiers, hashes, and review state. The historical `assets/3d/` tree is a local migration/reference archive only and is excluded from fresh renderer output and packages; it is not a packaged provenance authority. The two `_recovered/` sidecars above explicitly remain incomplete and blocked.

## Existing fallback objects and textures

- `objects/*.webp` are unchanged copies of matching files in the local migration archive under `assets/3d/learning-room/v1/fallback/`.
- `textures/*.webp` are unchanged copies of matching files in the local migration archive under `assets/3d/learning-room/v1/textures/p0/`.
- The archive's adjacent `.json` files remain development-time provenance records, but the complete `assets/3d/` archive is intentionally absent from fresh `out` and `app.asar`.

## Package containment

- Production renderer builds use an explicit filtered public-asset emitter instead of Vite's blanket public-directory copy. The complete `assets/3d/` migration archive is excluded.
- `assets/companion/live2d-v1/` and its `assets/companion/vendor/` runtime are now enabled for the Owner-approved local desktop build. The original Live2D terms still restrict redistribution, so installers containing these files must remain private unless a separate release review clears them. The abstract orb is **no longer shipped** (removed 2026-09-16 by the same decision); the only companion form is the in-window Live2D model, and a load failure hides it instead of falling back.
- Packaged smoke fails closed unless `app.asar` is newer than both source and renderer build output, embeds a byte-identical V1 manifest, contains every manifest asset, includes the owner-approved Live2D runtime, **contains no orb asset** (`assets/learning-room/v1/objects/companion-orb.webp` must be absent since 2026-09-16), excludes the reference-only `assets/3d/` archive, and contains none of the four rejected motion files.
- A 2026-08-25 isolated electron-builder `--dir` preflight (outside `release/`) verified this boundary against a fresh `app.asar`: source, out, and packaged manifests were byte-identical with SHA-256 `5e93f5234b587ef20ce413b8b89085c9f3467e8bd620ceb658548e93d6037936`; every manifest asset listed at that time and the then-legal orb were present (that preflight predates the 2026-09-16 orb removal and is kept as historical evidence only); rejected media, `assets/3d/`, Live2D, and its vendor runtime were absent. The same temporary package passed anonymous offline cold-start and online Auth Gate smoke without mounting Room, ActionRail, or Onboarding. This is containment and anonymous Gate evidence only, not release approval, an authenticated journey, or a signed canonical package.

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

## Generated foreground asset

- `foreground/home-foreground-leaves-v1.png` was generated on 2026-09-08 with the built-in ImageGen tool, using the canonical room poster only as a style, palette, lighting, and brushwork reference. It is a 1672×941 RGBA near-camera pothos layer used in D6; CSS clips the generated canvas to its authored upper-left region so no low-alpha pixels can tint the rest of the room. The exact generation prompt is stored at `prompts/home-foreground-leaves-v1.txt`. SHA-256: `7f42ffaf3f2f660caee03338f691b94cc4e95fbb93ce6cb2082a8a5f84a50d82`.
