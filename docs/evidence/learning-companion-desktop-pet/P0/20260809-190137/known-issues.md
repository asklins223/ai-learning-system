1. P0 is intentionally fixture-only. It is not a usable AI desktop pet and must not be reported as P1/P2/P3 complete.
2. `make verify` is blocked before package gates by a pre-existing API/DB schema mirror mismatch: API lacks files already present in packages/db. No P0 database file was changed.
3. The dev Docker web service sets a non-production NODE_ENV. Its mandated `npm run build` invocation fails during /404 prerender with Next's `<Html>` error; an explicit NODE_ENV=production container build passes.
4. Real macOS visual recordings for transparent pass-through, focus, multi-display, Retina, sleep/wake and Main close/Pet survival were not captured in this automated run and remain Owner review items.
5. Next.js still reports the repository's pre-existing multiple-lockfile workspace-root warning.
6. `apps/web npm test` has 2 failures in the existing page-coverage registry because the new isolated `/companion/pet` route is not classified there. The P0 implementation leaves that legacy registry untouched pending Owner direction on whether this route should be an explicit exception/classification.
