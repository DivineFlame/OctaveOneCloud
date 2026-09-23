import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits decorator metadata, which NestJS dependency injection relies on.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ['test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      APP_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:4000',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://ooc:ooc@localhost:5432/ooc_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      CREDENTIAL_ENCRYPTION_KEY: '0f'.repeat(32),
      CASHFREE_ENV: 'sandbox',
      CASHFREE_CLIENT_ID: 'test-client',
      CASHFREE_CLIENT_SECRET: 'test-secret',
      CASHFREE_WEBHOOK_SECRET: 'whsec-test',
      SELLER_STATE_CODE: '29',
      OOC_DISABLE_THROTTLE: 'true',
      LOG_LEVEL: 'error',
    },
  },
});
