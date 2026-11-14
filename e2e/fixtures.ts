import { expect, test as base } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, runTest) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/knowledge/documents", (route) => route.fulfill({ json: { documents: [] } }));
    await runTest(page);
    expect(errors, "Unhandled browser errors").toEqual([]);
  }
});

export { expect };
