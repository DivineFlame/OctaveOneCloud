import 'reflect-metadata';
import { createApp } from './bootstrap';

async function main() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
}

main().catch((e) => {
  // Configuration errors never include secret values (see loadConfig).
  process.stderr.write(`Fatal startup error: ${(e as Error).message}\n`);
  process.exit(1);
});
