/**
 * E2E smoke (spec 14.1): load the console → run showcase 1 in replay mode (no keys) →
 * approve as the supervisor → the saga completes and the reply carries the verified stamp.
 */
import { test, expect } from "@playwright/test";

test("landing page renders the poster and links to the console", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/OmniResolve/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/agents/i);
  await expect(page.getByRole("img", { name: /gatekeeper/i })).toBeVisible();
});

test("showcase 1 in replay mode: pause, approve, saga, verified reply", async ({ page }) => {
  await page.goto("/console?scenario=s1-damaged-double-charge");
  const send = page.getByRole("button", { name: "Send this complaint" }).first();
  await expect(send).toBeEnabled();
  await send.click();

  const deck = page.getByRole("dialog", { name: /supervisor approval/i });
  await expect(deck).toBeVisible();
  await expect(deck).toContainText("$640.00");
  await expect(deck).toContainText(/PIVOT/);
  await deck.getByRole("button", { name: /^Approve$/ }).click();

  await expect(page.getByText(/verified/i).first()).toBeVisible();
  await expect(page.getByText("RESOLVED").first()).toBeVisible();
  await expect(page.locator("main").first()).toContainText(/RF-1001|refund/i);
});

test("security headers are present", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("nonce-");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
});
