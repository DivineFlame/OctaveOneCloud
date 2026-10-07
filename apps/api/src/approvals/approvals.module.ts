import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { ApprovalsController } from './approvals.controller';

@Module({ imports: [AuthModule, OrgsModule], controllers: [ApprovalsController] })
export class ApprovalsModule {}
