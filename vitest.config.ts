import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    miniflare: {
      compatibilityDate: '2026-10-09',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      bindings: {
        BOT_TOKEN: '123456789:test-only-token',
        WEBHOOK_SECRET: 'test-webhook-secret-never-use-in-production',
        ADMIN_IDS: '[111,222]',
        ARCHIVE_CHAT_ID: '-1009000',
        PUBLISH_CHANNELS: '{"主频道":-1001000,"第二频道":-1002000}',
        PUBLIC_BASE_URL: 'https://videos.example.com',
        TELEGRAPH_AUTHOR_NAME: '测试',
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      },
    },
  })],
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false },
}));
