/**
 * afterPack hook — strips unused locale .lproj directories from the
 * Electron Framework to save ~60MB.
 *
 * electron-builder's `electronLanguages` option only strips the app-level
 * Resources/*.lproj symlinks (which are 0 bytes). The actual locale files
 * live inside Electron Framework.framework/Versions/A/Resources/*.lproj
 * and must be removed manually.
 */

const fs = require("node:fs");
const path = require("node:path");

const KEEP_LOCALES = new Set(["en.lproj", "en_GB.lproj", "zh_CN.lproj"]);

module.exports = function afterPack(context) {
  // context.appOutDir is the directory containing the .app bundle,
  // e.g. release/mac-arm64. The .app name comes from product name.
  const appName = context.packager.appInfo.productName;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] App path: ${appPath}`);

  // ── Strip locales from Electron Framework ──────────────────────
  const frameworkResources = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
  );

  let removed = 0;

  if (fs.existsSync(frameworkResources)) {
    for (const entry of fs.readdirSync(frameworkResources)) {
      if (entry.endsWith(".lproj") && !KEEP_LOCALES.has(entry)) {
        fs.rmSync(path.join(frameworkResources, entry), { recursive: true, force: true });
        removed++;
      }
    }
    console.log(`[afterPack] Removed ${removed} unused locale dirs from Electron Framework.`);
  } else {
    console.log(`[afterPack] Framework Resources not found at: ${frameworkResources}`);
  }

  // ── Strip locales from Helper apps ─────────────────────────────
  const frameworksDir = path.join(appPath, "Contents", "Frameworks");
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir)) {
      if (!entry.endsWith(".app")) continue;
      const helperResources = path.join(
        frameworksDir, entry, "Contents", "Resources",
      );
      if (!fs.existsSync(helperResources)) continue;
      for (const locale of fs.readdirSync(helperResources)) {
        if (locale.endsWith(".lproj") && !KEEP_LOCALES.has(locale)) {
          fs.rmSync(path.join(helperResources, locale), { recursive: true, force: true });
        }
      }
    }
  }

  console.log(`[afterPack] Locale cleanup complete.`);
};
