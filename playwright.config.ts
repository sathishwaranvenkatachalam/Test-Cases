import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './playwright/generated',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  retries: 0,
});
