import { Controller, Get, HttpException, Inject } from '@nestjs/common';
import { PrismaClient } from '@ooc/db';
import { PRISMA } from '../common/prisma.module';
import { Queues } from '../common/queue.module';
import { Public } from '../auth/decorators';

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, private readonly queues: Queues) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, boolean> = {};
    checks.database = await this.db.$queryRaw`SELECT 1`.then(() => true, () => false);
    checks.redis = await this.queues.webhooks.client.then((c) => (c as unknown as { ping(): Promise<string> }).ping()).then((r) => r === 'PONG', () => false);
    const ok = Object.values(checks).every(Boolean);
    if (!ok) throw new HttpException({ status: 'unavailable', checks }, 503);
    return { status: 'ready', checks };
  }
}
