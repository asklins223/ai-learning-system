import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const WEB_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

const desktopMainSource = readFileSync(
  resolve(REPO_ROOT, "apps/desktop/src/main.ts"),
  "utf8",
);
const appShellSource = readFileSync(
  resolve(WEB_ROOT, "components/layout/AppShell.tsx"),
  "utf8",
);
const layoutStyles = readFileSync(
  resolve(WEB_ROOT, "app/styles/layout.css"),
  "utf8",
);
const homeStyles = readFileSync(
  resolve(WEB_ROOT, "app/styles/home.css"),
  "utf8",
);
const noteEditorStyles = readFileSync(
  resolve(WEB_ROOT, "app/styles/note-editor.css"),
  "utf8",
);
const globalsSource = readFileSync(resolve(WEB_ROOT, "app/globals.css"), "utf8");

describe("desktop window adaptation contract", () => {
  it("keeps native macOS controls without a separate native title strip", () => {
    assert.match(desktopMainSource, /titleBarStyle: "hiddenInset"/);
    assert.match(desktopMainSource, /titleBarOverlay: \{ height: 56 \}/);
    assert.match(desktopMainSource, /useContentSize: true/);
    assert.doesNotMatch(desktopMainSource, /frame:\s*false/);
  });

  it("uses Window Controls Overlay geometry for safe header content", () => {
    assert.ok(layoutStyles.includes("env(titlebar-area-height, 0px)"));
    assert.ok(layoutStyles.includes("env(titlebar-area-x, 0px)"));
    assert.ok(layoutStyles.includes("env(titlebar-area-width, 100vw)"));
    assert.ok(layoutStyles.includes("var(--window-titlebar-safe-left)"));
    assert.ok(layoutStyles.includes("var(--window-titlebar-safe-right)"));
  });

  it("provides drag surfaces while preserving header controls", () => {
    assert.match(layoutStyles, /-webkit-app-region:\s*drag/);
    assert.match(layoutStyles, /-webkit-app-region:\s*no-drag/);
    for (const header of [
      ".card-detail-header",
      ".card-set-header",
      ".source-detail-header",
      ".note-workbench .ne-topbar",
      ".validation-focus-header",
      ".universe-top-hud",
    ]) {
      assert.ok(layoutStyles.includes(header), `${header} must join desktop chrome`);
    }
  });

  it("keeps native-window chrome safe after page zoom changes the responsive shell", () => {
    const chromeStart = layoutStyles.indexOf("/* ── Desktop window chrome");
    const chromeEnd = layoutStyles.indexOf("/* Drawer 挂载", chromeStart);
    const chromeStyles = layoutStyles.slice(chromeStart, chromeEnd);

    assert.ok(chromeStart >= 0 && chromeEnd > chromeStart);
    assert.doesNotMatch(chromeStyles, /@media \(min-width:\s*960px\)/);
    assert.ok(chromeStyles.includes(".tablet-topbar"));
    assert.ok(chromeStyles.includes(".workspace-route-loading"));
    assert.match(
      layoutStyles,
      /\.skip-link\s*\{[\s\S]*?window-titlebar-safe-left[\s\S]*?-webkit-app-region:\s*no-drag/,
    );
    // 2026-08-12 同步：WorkspaceRouteLoading 内联 <style> 已迁移至 globals.css
    //（样式迁移专项），titlebar-safe 变量消费随之移动——断言迁移后的宿主。
    assert.ok(globalsSource.includes("var(--window-titlebar-safe-left)"));
    assert.ok(globalsSource.includes("var(--window-titlebar-safe-right)"));
  });

  it("does not force viewport-locked pages into document overflow", () => {
    assert.match(
      noteEditorStyles,
      /@media \(min-width: 960px\) and \(min-height: 620px\)/,
    );
    // QUAL-43/40/68 重构后，AppShell 用路由表标记 ownsFocusHeader 取代
    // isCardSetDetailPage 布尔变量；视口锁定的卡组详情页应自带 Focus 头，
    // 由 shell 不叠加 TopBar，避免撑出文档溢出。
    assert.ok(
      appShellSource.includes('page: "card-set-detail", ownsFocusHeader: true'),
    );
    assert.ok(appShellSource.includes("!hasOwnedFocusHeader && <TopBar />"));
    assert.match(
      homeStyles,
      /@media \(min-width: 640px\)[\s\S]*?data-page="home"[\s\S]*?padding-bottom: 0;/,
    );
  });
});
