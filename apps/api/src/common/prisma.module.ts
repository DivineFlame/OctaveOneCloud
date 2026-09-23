import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, PrismaClient } from '@ooc/db';
import { AppConfig } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';

export const PRISMA = Symbol('PRISMA');

@Injectable()
class PrismaLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: PRISMA, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createPrismaClient(c.DATABASE_URL) },
    PrismaLifecycle,
  ],
  exports: [PRISMA],
})
export class PrismaModule {}
