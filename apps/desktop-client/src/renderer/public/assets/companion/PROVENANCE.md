# In-window companion assets

This directory is a renderer-local copy of the existing AI Learn companion
runtime. It is loaded only inside the desktop client's project window. Nothing
in `WindowLive2D` creates an always-on-top or out-of-window desktop-pet surface.

## Mao PRO model

- Source repository: [EchoBot](https://github.com/KdaiP/EchoBot)
- Locked source commit: `08e97a4a33b2ab611d24dd997038c1ec95ac6926`
- Original path: `echobot/app/builtin_live2d/mao_pro_en`
- Repository license: MIT; retained as `live2d-v1/EchoBot-LICENSE` and beside
  the model as `live2d-v1/mao-pro/EchoBot-LICENSE`
- Model terms: Live2D Free Material License Agreement and Terms of Use; the
  original `ReadMe.txt` is retained beside the model.
- Hashes: retained in `live2d-v1/manifest.json` and
  `live2d-v1/mao-pro/manifest.json`.

The model manifest records `redistributionAllowed=false`. Do not publish or
redistribute this asset package without a fresh license review.

## Browser runtime

- `vendor/pixi.min.js`: PixiJS 6.5.10 (MIT)
- `vendor/cubism4.min.js`: pixi-live2d-display 0.4.0 (MIT)
- `vendor/live2dcubismcore.min.js`: Live2D Cubism Core, governed by the
  [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)

The vendor source note is retained as `vendor/README.md`. Keep the three
runtime files aligned with the SHA-256 hashes in the model manifest.

## Removed assets

- The **Seethrough model** (`live2d-v2/seethrough`, user-provided
  `seethrough_output.psd2live` exported with PSD2Live 0.7.1 on 2026-09-15) was
  removed on 2026-09-19: it never became the runtime model (`WindowLive2D`
  loads `live2d-v1/mao-pro` only), its license status stayed development-only
  (`commercialReleaseAllowed=false`, `redistributionAllowed=false`), and the
  desktop plan of 2026-09-19 requires dormant asset packages to be deleted
  rather than shipped. Restore it from design archives if ownership and
  redistribution rights are ever confirmed.
- `live2d-v1/mao-pro/mao-half-idle-v1.png` was deleted together with the orb
  fallback (2026-09-16 Owner decision). Per that decision the companion has a
  single form (in-window Live2D); when the model cannot load the companion is
  hidden and a dismissible notice is shown instead, so no substitute image is
  rendered. The file was not referenced by any manifest hash list.
- The 2.5D room-pack orb (`assets/learning-room/v1/objects/companion-orb.webp`)
  and its `manifest.json` `companion` entry were removed in the same change.
- The archived 3D learning-room pack under `assets/3d/learning-room/v1/**`
  still contains its own orb files and manifest entries; that pack is frozen
  historical evidence for a path V1 no longer uses and was intentionally left
  untouched.
