import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgGuard } from './org.guard';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';

@Module({ imports: [AuthModule], controllers: [OrgsController], providers: [OrgsService, OrgGuard], exports: [OrgGuard] })
export class OrgsModule {}
