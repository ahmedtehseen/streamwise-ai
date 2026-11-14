import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

for (const mode of ["Chat", "Spec", "Portfolio Assistant"]) {
  test(`${mode} stays in place throughout menu opening and closing`, async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const probe = await page.evaluateHandle(() => {
      const measure = () => Array.from(document.querySelectorAll(
        ".chat-panel, .topbar, .welcome, .composer, .knowledge-panel"
      ), (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { selector: element.className, x, y, width, height };
      });
      const state = { frames: [measure()], frameId: 0 };
      const sample = () => {
        state.frames.push(measure());
        state.frameId = requestAnimationFrame(sample);
      };
      state.frameId = requestAnimationFrame(sample);
      return state;
    });

    try {
      await page.locator(".mobile-header").getByRole("button", { name: "Menu", exact: true }).tap();
      const drawer = page.getByRole("dialog", { name: "Conversation history" });
      const closeButton = drawer.getByRole("button", { name: "Close", exact: true });
      await expect(drawer).toBeVisible();
      await expect(closeButton).toBeFocused();
      await expect(page.locator(".chat-panel")).toHaveAttribute("inert", "");
      await expect(page.locator(".mobile-header")).toHaveAttribute("inert", "");
      await drawer.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));

      await closeButton.tap();
      await expect(page.locator(".sidebar.mobile-open")).toBeHidden();

      const frames = await probe.evaluate((state) => state.frames);
      await testInfo.attach("layout-frames", {
        body: JSON.stringify(frames),
        contentType: "application/json"
      });
      expect(frames.length).toBeGreaterThan(2);
      for (const frame of frames) {
        expect(frame, "Main content moved during the drawer transition").toEqual(frames[0]);
      }
      await expect(page.locator(".mobile-header").getByRole("button", { name: "Menu", exact: true })).toBeFocused();
    } finally {
      await probe.evaluate((state) => cancelAnimationFrame(state.frameId));
      await probe.dispose();
    }
  });
}

test("menu preserves accessibility and focus during reduced motion and rapid reopening", async ({ page }) => {
  await page.goto("/");
  const menuButton = page.locator(".mobile-header").getByRole("button", { name: "Menu", exact: true });
  const drawer = page.getByRole("dialog", { name: "Conversation history" });

  await menuButton.tap();
  const closeButton = drawer.getByRole("button", { name: "Close", exact: true });
  await expect(closeButton).toBeFocused();
  await drawer.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const openScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(openScan.violations).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();
  await expect(page.locator(".sidebar.mobile-open")).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await menuButton.tap();
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();
  await expect(page.locator(".sidebar.mobile-open")).toBeHidden();

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await menuButton.tap();
  await closeButton.tap();
  await menuButton.tap();
  await expect(drawer).toBeVisible();
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuButton).toBeFocused();
  await expect(page.locator(".sidebar.mobile-open")).toBeHidden();

  const closedScan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(closedScan.violations).toEqual([]);
});
