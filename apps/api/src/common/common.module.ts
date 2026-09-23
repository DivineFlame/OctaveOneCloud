import { Global, Module } from '@nestjs/common';
import { AppConfig, CredentialCipher } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { AuditService } from './audit.service';

export const CIPHER = Symbol('CIPHER');

@Global()
@Module({
  providers: [
    AuditService,
    {
      provide: CIPHER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new CredentialCipher(c.CREDENTIAL_ENCRYPTION_KEY_ID, { [c.CREDENTIAL_ENCRYPTION_KEY_ID]: c.CREDENTIAL_ENCRYPTION_KEY }),
    },
  ],
  exports: [AuditService, CIPHER],
})
export class CommonModule {}
