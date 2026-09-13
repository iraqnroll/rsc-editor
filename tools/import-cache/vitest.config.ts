import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // importing the whole world touches 594 landscape files
    testTimeout: 300_000
  }
});
