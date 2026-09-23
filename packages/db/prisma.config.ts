import { config } from 'dotenv';

// Load the repository root .env for local CLI use. Deployed environments inject variables directly.
config({ path: ['.env', '../../.env'], quiet: true });
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // `prisma generate` does not need a database, so builds (Docker, CI) work without DATABASE_URL.
  // Commands that do need one (migrate, db) fail clearly against the placeholder host.
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://database-url-not-set@invalid.localhost:5432/unset',
  },
});
