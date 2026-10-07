import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';
import { OidcController } from './oidc.controller';
import { OidcService } from './oidc.service';

@Module({
  controllers: [AuthController, OidcController],
  providers: [AuthService, MailService, OidcService, { provide: APP_GUARD, useClass: SessionGuard }],
  exports: [AuthService, MailService],
})
export class AuthModule {}
