import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { SupportAdminController, SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({ imports: [AuthModule, OrgsModule], controllers: [SupportController, SupportAdminController], providers: [SupportService] })
export class SupportModule {}
