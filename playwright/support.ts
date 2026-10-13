import { test as base, chromium, type Page } from '@playwright/test';
export const test = base.extend<{ page: Page }>({
  page: async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://localhost:9222');
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    if (process.env.BASE_URL) await page.goto(process.env.BASE_URL);
    await use(page);
    await page.close();
    await browser.close();
  },
});
export { expect } from '@playwright/test';
