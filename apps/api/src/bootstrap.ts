import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfig, isInsecureHttp, loadConfig } from '@ooc/shared';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logger';

/** Shared HTTP configuration for production bootstrap and tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): INestApplication {
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({ origin: [new URL(config.APP_URL).origin], credentials: true });
  app.setGlobalPrefix('v1', { exclude: ['health', 'ready'] });
  app.enableShutdownHooks();
  return app;
}

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // rawBody keeps the original request bytes for webhook signature verification.
    rawBody: true,
    logger: opts.logger === false ? false : new JsonLogger(config.LOG_LEVEL, 'api'),
  });
  if (config.NODE_ENV === 'production' && isInsecureHttp(config)) {
    new JsonLogger(config.LOG_LEVEL, 'api').warn('Serving over plain HTTP (OOC_ALLOW_INSECURE_HTTP). Passwords and sessions are not encrypted in transit — use only for a trial, never for real customers.', 'Bootstrap');
  }
  return configureApp(app, config);
}
