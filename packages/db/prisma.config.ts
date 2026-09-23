import { config } from 'dotenv';

// Load the repository root .env for local CLI use. Deployed environments inject variables directly.
config({ path: ['.env', '../../.env'], quiet: true });
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
