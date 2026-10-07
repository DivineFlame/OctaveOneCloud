import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { RefundsAdminController } from './refunds.controller';

@Module({ imports: [AuthModule, ProvidersModule], controllers: [RefundsAdminController] })
export class RefundsModule {}
