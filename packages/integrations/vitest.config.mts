import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    globalSetup: ['test/global-setup.ts'],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://ooc:ooc@localhost:5432/ooc_test', NODE_ENV: 'test' },
  },
});
