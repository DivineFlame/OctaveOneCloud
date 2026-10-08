import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupplierPricesController } from './supplier-prices.controller';

@Module({ imports: [AuthModule], controllers: [SupplierPricesController] })
export class SupplierPricesModule {}
