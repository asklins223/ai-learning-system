/**
 * Frozen public update channel for the desktop release.
 *
 * The URL is the GitHub release download root; electron-updater appends the
 * platform metadata filename (for example latest-mac.yml). A deployment may
 * override it for a private mirror with AILEARN_UPDATE_FEED, but production
 * release configuration must keep an HTTPS URL.
 */
export const DESKTOP_UPDATE_FEED_URL =
  "https://github.com/asklins223/ai-learning-system/releases/latest/download";
