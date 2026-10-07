import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { UsageController } from './usage.controller';

@Module({ imports: [AuthModule, OrgsModule], controllers: [UsageController] })
export class UsageModule {}
