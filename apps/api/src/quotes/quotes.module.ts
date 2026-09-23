import { Module } from '@nestjs/common';
import { OrgsModule } from '../orgs/orgs.module';
import { CheckoutService } from '../checkout/checkout.service';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';

@Module({ imports: [OrgsModule], controllers: [QuotesController], providers: [QuotesService, CheckoutService] })
export class QuotesModule {}
