import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Integration tests share one database (tests/helpers/db.ts); run files serially so resets don't race.
    fileParallelism: false,
  },
});
