import { Module } from '@nestjs/common';
import { AppApiController } from './app-api.controller';
import { AppSignatureGuard } from './app-signature.guard';

@Module({ controllers: [AppApiController], providers: [AppSignatureGuard] })
export class AppApiModule {}
