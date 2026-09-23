import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from '@ooc/shared';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
