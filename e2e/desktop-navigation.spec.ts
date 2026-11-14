import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("desktop keeps one visible sidebar header and accessible controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /New chat/ })).toHaveCount(1);

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(scan.violations).toEqual([]);
});
