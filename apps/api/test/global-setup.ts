import { migrateTestDatabase } from '@ooc/db/testing';

export default function setup() {
  migrateTestDatabase(process.env.TEST_DATABASE_URL);
}
