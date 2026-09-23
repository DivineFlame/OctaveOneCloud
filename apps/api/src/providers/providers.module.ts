import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@ooc/db';
import { AppConfig, cashfreeBaseUrl } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { CashfreeClient, ResellerClubClient } from '@ooc/integrations';


export const CASHFREE = Symbol('CASHFREE');
export const RESELLERCLUB = Symbol('RESELLERCLUB');

@Global()
@Module({
  providers: [
    {
      provide: CASHFREE,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        new CashfreeClient(cashfreeBaseUrl(c.CASHFREE_ENV), { clientId: c.CASHFREE_CLIENT_ID, clientSecret: c.CASHFREE_CLIENT_SECRET, apiVersion: c.CASHFREE_API_VERSION }),
    },
    { provide: RESELLERCLUB, inject: [APP_CONFIG, PRISMA], useFactory: (c: AppConfig, db: PrismaClient) => new ResellerClubClient(c, db) },
  ],
  exports: [CASHFREE, RESELLERCLUB],
})
export class ProvidersModule {}
