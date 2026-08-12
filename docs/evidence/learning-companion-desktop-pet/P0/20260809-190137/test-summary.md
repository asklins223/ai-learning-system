Passed:
- Shared contracts are strict and bounded.
- IPC channel names and bootstrap/window/hit payloads reject extra/out-of-range data.
- Sender ID, exact dynamic origin and Pet path are required.
- Main navigation is same-origin only; explicit external bridge accepts HTTPS only.
- Pet window options match transparent 560x520 P0 baseline.
- DIP screen-to-content conversion does not multiply/divide Retina scaleFactor.
- Rect, polygon and hashed alpha-mask hit testing work.
- Passive mode forwards outside clicks; interactive/text-input mode forces interaction.
- New preferences default to pet disabled, always-on-top, privacy off.
- Corrupt preferences fail closed; normalized position persistence is atomic.

Failed or blocked:
- `make verify` stopped at the pre-existing API/DB schema mirror mismatch before package gates.
- `apps/web npm test` passed 756 tests and failed 2 page-coverage assertions because `/companion/pet` is not yet classified by the existing registry.
- Docker dev-mode web build failed on the existing `/404` `<Html>` error under `NODE_ENV=development`; the production-mode container build passed.
