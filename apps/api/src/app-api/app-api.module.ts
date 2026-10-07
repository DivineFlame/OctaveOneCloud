import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppApiController } from './app-api.controller';
import { AppSignatureGuard } from './app-signature.guard';

@Module({ imports: [AuthModule], controllers: [AppApiController], providers: [AppSignatureGuard] })
export class AppApiModule {}
