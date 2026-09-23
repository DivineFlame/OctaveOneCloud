import { Controller, ForbiddenException, HttpCode, Inject, Logger, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient, isUniqueViolation } from '@ooc/db';
import { AppConfig, redact, sha256Hex, verifyCashfreeSignature } from '@ooc/shared';
import { APP_CONFIG } from '../config/config.module';
import { PRISMA } from '../common/prisma.module';
import { Queues } from '../common/queue.module';
import { AuthedRequest, Public } from '../auth/decorators';

type Channel = 'pg' | 'subscription';

/**
 * Cashfree webhook intake. Verifies the signature over the ORIGINAL raw bytes, durably stores the
 * event in the inbox (deduplicated), then acknowledges. Processing is asynchronous in the worker.
 * Payment Gateway and Subscription events use separate endpoints, schemas and secrets.
 */
@Controller('webhooks/cashfree')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject(PRISMA) private readonly db: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: Queues,
  ) {}

  @Public()
  @HttpCode(200)
  @Post(':channel')
  async receive(@Param('channel') channelParam: string, @Req() req: AuthedRequest) {
    const channel = channelParam === 'pg' ? 'pg' : channelParam === 'subscriptions' ? 'subscription' : null;
    if (!channel) throw new ForbiddenException();
    const secret = this.secretFor(channel);
    if (!secret) throw new ForbiddenException({ error: 'channel_disabled' });

    const rawBody = req.rawBody;
    const timestamp = header(req, 'x-webhook-timestamp');
    const signature = header(req, 'x-webhook-signature');
    if (!rawBody || !verifyCashfreeSignature({ rawBody, timestamp, signature, secret })) {
      this.logger.warn(`Rejected Cashfree ${channel} webhook with invalid signature`);
      throw new UnauthorizedException({ error: 'invalid_signature' });
    }

    let eventType: string | undefined;
    try {
      eventType = String((JSON.parse(rawBody.toString('utf8')) as { type?: unknown }).type ?? '') || undefined;
    } catch {
      eventType = undefined;
    }
    // Prefer the provider idempotency header (API 2025-01-01+); fall back to a hash of the signed payload.
    const dedupeKey = header(req, 'x-idempotency-header') ?? header(req, 'x-idempotency-key') ?? sha256Hex(rawBody);

    let inboxId: string;
    try {
      const row = await this.db.webhookInbox.create({
        data: {
          provider: 'cashfree',
          channel,
          dedupeKey,
          eventType,
          rawBody: new Uint8Array(rawBody),
          headers: redact({ ...req.headers }) as Prisma.InputJsonValue,
          signatureValid: true,
        },
      });
      inboxId = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) return { received: true, duplicate: true };
      throw e;
    }
    // If Redis is unavailable the event is still durable; the worker's inbox sweeper picks it up.
    await this.queues.webhooks.add('inbox', { inboxId }, { jobId: `inbox-${inboxId}` }).catch((e: Error) => this.logger.error(`enqueue failed: ${e.message}`));
    return { received: true };
  }

  private secretFor(channel: Channel): string | undefined {
    if (this.config.CASHFREE_ENV === 'disabled') return undefined;
    if (channel === 'pg') return this.config.CASHFREE_WEBHOOK_SECRET;
    return this.config.CASHFREE_SUBSCRIPTIONS_ENABLED ? this.config.CASHFREE_SUBSCRIPTION_WEBHOOK_SECRET : undefined;
  }
}

function header(req: AuthedRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
