import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { loadConfig } from '@ooc/shared';
import { AppModule } from './app.module';
import { JsonLogger } from './common/logger';

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // rawBody keeps the original request bytes for webhook signature verification.
    rawBody: true,
    logger: opts.logger === false ? false : new JsonLogger(config.LOG_LEVEL, 'api'),
    bodyParser: true,
  });
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({ origin: [new URL(config.APP_URL).origin], credentials: true });
  app.setGlobalPrefix('v1', { exclude: ['health', 'ready'] });
  app.enableShutdownHooks();
  return app;
}
