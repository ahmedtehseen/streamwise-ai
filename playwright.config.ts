import { defineConfig } from "@playwright/test";

const colorSchemes = ["light", "dark"] as const;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    ...[320, 390, 768, 900].flatMap((width) => colorSchemes.map((colorScheme) => ({
      name: `mobile-${width}-${colorScheme}`,
      testMatch: "**/mobile-menu.spec.ts",
      use: {
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme
      }
    }))),
    ...colorSchemes.map((colorScheme) => ({
      name: `desktop-${colorScheme}`,
      testMatch: "**/desktop-navigation.spec.ts",
      use: { viewport: { width: 1440, height: 900 }, colorScheme }
    }))
  ],
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false
  }
});
