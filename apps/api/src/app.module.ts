import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma.module';
import { CommonModule } from './common/common.module';
import { QueueModule } from './common/queue.module';
import { BigIntInterceptor } from './common/bigint.interceptor';
import { ProvidersModule } from './providers/providers.module';
import { AuthModule } from './auth/auth.module';
import { OrgsModule } from './orgs/orgs.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { QuotesModule } from './quotes/quotes.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { SupportModule } from './support/support.module';
import { InvoicesModule } from './invoices/invoices.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { RefundsModule } from './refunds/refunds.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CommonModule,
    QueueModule,
    ProvidersModule,
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 300 }], skipIf: () => process.env.OOC_DISABLE_THROTTLE === 'true' }),
    AuthModule,
    OrgsModule,
    CatalogueModule,
    QuotesModule,
    WebhooksModule,
    AdminModule,
    HealthModule,
    SupportModule,
    InvoicesModule,
    SubscriptionsModule,
    RefundsModule,
  ],
  providers: [
    // Throttler runs before the session guard (guards execute in registration order).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: BigIntInterceptor },
  ],
})
export class AppModule {}
