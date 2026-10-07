import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { SubscriptionsAdminController, SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({ imports: [AuthModule, OrgsModule], controllers: [SubscriptionsController, SubscriptionsAdminController], providers: [SubscriptionsService] })
export class SubscriptionsModule {}
