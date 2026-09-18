export const HOME_WINDOW_WORLD_SIZE = Object.freeze({ width: 1920, height: 1080 });

export const HOME_WINDOW_ASPECT_RATIO = HOME_WINDOW_WORLD_SIZE.width / HOME_WINDOW_WORLD_SIZE.height;

// Keep 125% browser zoom in the full spatial room while 150% and 200% can
// intentionally cross into the compact semantic-room breakpoint.
export const HOME_WINDOW_INITIAL_CONTENT_SIZE = Object.freeze({ width: 1440, height: 810 });
export const HOME_WINDOW_MINIMUM_SIZE = Object.freeze({ width: 1280, height: 720 });

// The native window is ratio-locked by `window.setAspectRatio` and clamped to
// `HOME_WINDOW_MINIMUM_SIZE`. This is the single tolerance used by
// `isHomeWindowAspectRatio` and `homeWindowSizeProblems`; the capture harness
// (`apps/desktop-client/scripts/capture-home-v2.mjs`) mirrors the same value in
// its own `HOME_WINDOW_RATIO_TOLERANCE` literal because it runs outside the
// TypeScript build.
export const HOME_WINDOW_RATIO_TOLERANCE = 0.002;

export function isHomeWindowAspectRatio(
  size: Readonly<{ width: number; height: number }>,
  tolerance = HOME_WINDOW_RATIO_TOLERANCE,
): boolean {
  return Number.isFinite(size.width)
    && Number.isFinite(size.height)
    && size.width > 0
    && size.height > 0
    && Math.abs(size.width / size.height - HOME_WINDOW_ASPECT_RATIO) <= tolerance;
}

/**
 * Acceptance sizes must satisfy both native rules: at least
 * `HOME_WINDOW_MINIMUM_SIZE` and within `HOME_WINDOW_RATIO_TOLERANCE` of the
 * `16:9` window ratio. Returns one human-readable problem per violated
 * rule, and an empty array when the size is a reachable Home V2 content size.
 *
 * This is why `1024x700` cannot be a Home V2 acceptance size: it is narrower
 * than the locked minimum and off-ratio, so the native window cannot produce
 * it and the capture harness rejects it.
 */
export function homeWindowSizeProblems(width: number, height: number): string[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return [`Home window content size ${width}x${height} is not a positive finite size`];
  }

  const problems: string[] = [];
  if (width < HOME_WINDOW_MINIMUM_SIZE.width || height < HOME_WINDOW_MINIMUM_SIZE.height) {
    problems.push(
      `Home window content size ${width}x${height} is below the locked `
      + `${HOME_WINDOW_MINIMUM_SIZE.width}x${HOME_WINDOW_MINIMUM_SIZE.height} minimum`,
    );
  }
  if (Math.abs(width / height - HOME_WINDOW_ASPECT_RATIO) > HOME_WINDOW_RATIO_TOLERANCE) {
    problems.push(
      `Home window content size ${width}x${height} does not preserve the `
      + `${HOME_WINDOW_WORLD_SIZE.width}:${HOME_WINDOW_WORLD_SIZE.height} window ratio`,
    );
  }
  return problems;
}
