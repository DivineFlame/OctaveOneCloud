import { Controller, Get, Inject, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { PrismaClient } from '@ooc/db';
import { orgUsageSummary } from '@ooc/integrations';
import { PRISMA } from '../common/prisma.module';
import { OrgGuard, RequireOrgPermission } from '../orgs/org.guard';

@UseGuards(OrgGuard)
@RequireOrgPermission('services.read')
@Controller('orgs/:orgId/usage')
export class UsageController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}

  @Get()
  summary(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return orgUsageSummary(this.db, orgId);
  }
}
