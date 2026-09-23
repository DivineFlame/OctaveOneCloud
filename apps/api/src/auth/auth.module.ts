import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, MailService, { provide: APP_GUARD, useClass: SessionGuard }],
  exports: [AuthService, MailService],
})
export class AuthModule {}
