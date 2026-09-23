import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AppConfig, redisOptionsFromUrl } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';

export const QUEUE_NAMES = { webhooks: 'webhooks', provisioning: 'provisioning', reconcile: 'reconcile' } as const;

/** Producer side of the job queues. Jobs carry only ids; the database is the source of truth. */
@Injectable()
export class Queues implements OnModuleDestroy {
  readonly webhooks: Queue;
  readonly provisioning: Queue;
  readonly reconcile: Queue;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const connection = redisOptionsFromUrl(config.REDIS_URL);
    const defaultJobOptions = { attempts: 8, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: false };
    this.webhooks = new Queue(QUEUE_NAMES.webhooks, { connection, defaultJobOptions });
    this.provisioning = new Queue(QUEUE_NAMES.provisioning, { connection, defaultJobOptions });
    this.reconcile = new Queue(QUEUE_NAMES.reconcile, { connection, defaultJobOptions });
  }

  async onModuleDestroy() {
    await Promise.all([this.webhooks.close(), this.provisioning.close(), this.reconcile.close()]);
  }
}

@Global()
@Module({ providers: [Queues], exports: [Queues] })
export class QueueModule {}
