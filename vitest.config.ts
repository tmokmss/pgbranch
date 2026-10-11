import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['test/integration/global-setup.ts'],
  },
});
