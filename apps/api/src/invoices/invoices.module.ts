import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { InvoicesAdminController, InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({ imports: [AuthModule, OrgsModule], controllers: [InvoicesController, InvoicesAdminController], providers: [InvoicesService] })
export class InvoicesModule {}
