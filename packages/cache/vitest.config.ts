import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // the full-cache round-trip walks 596 files; give it room
    testTimeout: 120_000
  }
});
