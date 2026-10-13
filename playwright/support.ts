import { test as base, chromium, type Page } from '@playwright/test';

// Injected into the page: auto-dismisses confirmation dialogs that are not data-entry forms.
// Uses \\b (word boundary) — note the double-backslash because this is a TypeScript string.
const DISMISS_SCRIPT = `
(function () {
  function dismissPopups() {
    var els = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
    els.forEach(function (el) {
      if (el.querySelector('input,textarea,select')) return;
      var btns = Array.from(el.querySelectorAll('button'));
      var dismiss = btns.find(function (b) {
        return /\\b(no|cancel|close|dismiss)\\b/i.test(b.textContent || '');
      });
      if (dismiss) (dismiss).click();
    });
  }
  var observer = new MutationObserver(dismissPopups);
  observer.observe(document.body, { childList: true, subtree: true });
  dismissPopups();
})();
`;

export const test = base.extend<{ page: Page }>({
  page: async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://localhost:9222');
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    // Register script to run on every navigation before page JS executes
    await page.addInitScript(DISMISS_SCRIPT);
    if (process.env.BASE_URL) await page.goto(process.env.BASE_URL);
    // Also evaluate immediately in case a dialog appeared before the observer was set up
    await page.evaluate(DISMISS_SCRIPT).catch(() => {});
    await use(page);
    await page.close();
    await browser.close();
  },
});
export { expect } from '@playwright/test';
