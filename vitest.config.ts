import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Creates, migrates and seeds the quota_test database once before any test file runs.
    globalSetup: ['tests/global-setup.ts'],
    restoreMocks: true,
    // Integration tests share one database (tests/helpers/db.ts); run files serially so resets don't race.
    fileParallelism: false,
  },
});
