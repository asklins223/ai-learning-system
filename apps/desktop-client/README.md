# AI Learn desktop client

This directory is the new Electron-only client. It is independent from the legacy
web and desktop applications.

## Commands

- `npm install` installs the isolated client dependencies.
- `npm run dev` starts Electron with the Vite development renderer.
- `npm run typecheck` checks the main, preload, and renderer TypeScript projects.
- `npm test` runs the Vitest suite once.
- `npm run build` creates the Electron production output in `out/`.
- `npm run preview` opens the local production build.
- `npm run dist` verifies, builds, and packages the desktop installers in `release/`.
- `npm run evidence:manifest` re-hashes the checked-in evidence fixture and emits a strict `QualityEvidenceManifestV1`; use the same command shape with a real capture manifest after a controlled run.
- `npm run package:smoke` launches the packaged artifact selected by `AILEARN_PACKAGED_APP` and checks the private bundle protocol, preload boundary, and startup error surface.
- `npm run capture:evidence` builds the client, captures the component and local journey evidence, and emits a strict advisory capture manifest.
- `npm run package:evidence` runs packaged smoke and binds its evidence to the packaged artifact SHA in a second strict manifest.

Production pages are served from the privileged, local-only
`ailearn-app://bundle/index.html` protocol. It supports streaming GET requests,
metadata-only HEAD requests, and one RFC-style byte range per request, including
the `Accept-Ranges`, `Content-Range`, `Content-Length`, and asset MIME headers
required by local video and audio playback. Requests are restricted to regular
files inside the packaged renderer directory, including after symlink resolution.

Renderer code has no Node.js access. The preload exposes only
`window.ailearnDesktop.platform`, `setTitleBarTheme(theme)`, and
`onWindowState(listener)`. The listener receives `visible`, `hidden`, or
`minimized` immediately after subscription and whenever the native lifecycle
changes; the returned function removes the listener.
