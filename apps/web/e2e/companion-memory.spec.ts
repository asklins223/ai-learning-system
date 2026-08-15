/**
 * 伴星记忆管理页 E2E（方案 16 §10.3）。
 *
 * 场景：登录 → /companion/memory 渲染（标题 + 空态或列表，二选一）→
 * 历史页 masthead 出现"管理记忆"入口链接。
 *
 * 运行前提（本地 dev 栈）：API :4000、web :3000；
 *   E2E_BASE_URL=http://localhost:3000 E2E_DEV_EMAIL=... E2E_DEV_PASSWORD=...
 */

import { test, expect } from "@playwright/test";
import {
  skipIfNoServer,
  devCredentials,
  loginViaUI,
} from "./helpers.ts";

const CREDENTIALS = devCredentials();
const CAN_RUN = Boolean(process.env.E2E_BASE_URL) && Boolean(CREDENTIALS);

test.describe("伴星记忆（§10.3）", () => {
  test("记忆页渲染（空态或列表）+ 历史页管理入口", async ({ page }) => {
    test.skip(!CAN_RUN, "E2E_BASE_URL/E2E_DEV_* 未配置");
    skipIfNoServer();
    test.setTimeout(90_000);
    await loginViaUI(page, CREDENTIALS!.email, CREDENTIALS!.password);

    await page.goto("/companion/memory", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "伴星记忆" })).toBeVisible({ timeout: 30_000 });
    // 空态或已有记忆列表（二选一，均合法）。
    const empty = page.getByText("还没有保存的记忆");
    const list = page.locator(".companion-memory-list li");
    await expect(empty.or(list.first())).toBeVisible({ timeout: 30_000 });

    // 历史页 masthead 的"管理记忆"入口。
    await page.goto("/companion/conversations", { waitUntil: "domcontentloaded" });
    const memoryLink = page.getByRole("link", { name: "管理记忆" });
    await expect(memoryLink).toBeVisible({ timeout: 30_000 });
    await expect(memoryLink).toHaveAttribute("href", "/companion/memory");
  });
});
