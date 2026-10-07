import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpCode, NotFoundException, Post, Req, UseGuards, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import { PrismaClient } from '@ooc/db';
import { AppUsageError, appEntitlements, appRelease, appReserve, appSettle } from '@ooc/integrations';
import { ZodPipe } from '../common/zod.pipe';
import { PRISMA } from '../common/prisma.module';
import { Public } from '../auth/decorators';
import { AppRequest, AppSignatureGuard } from './app-signature.guard';

const Org = z.object({ orgId: z.uuid() }).strict();
const Reserve = z.object({
  orgId: z.uuid(),
  resource: z.string().min(1).max(100),
  quantity: z.number().int().positive().max(1_000_000_000),
  idempotencyKey: z.string().min(8).max(200),
  ttlSeconds: z.number().int().min(30).max(86_400).optional(),
}).strict();
const Settle = z.object({ reservationId: z.uuid(), actualQuantity: z.number().int().min(0).max(1_000_000_000), sourceEventId: z.string().min(1).max(200) }).strict();
const Release = z.object({ reservationId: z.uuid() }).strict();

function mapError(e: unknown): unknown {
  if (!(e instanceof AppUsageError)) return e;
  const body = { error: e.code, message: e.message, ...(e.details ?? {}) };
  if (e.code === 'org_not_served') return new ForbiddenException(body);
  if (e.code === 'reservation_not_found') return new NotFoundException(body);
  if (e.code === 'quota_exceeded' || e.code === 'reservation_not_open' || e.code === 'idempotency_conflict') return new ConflictException(body);
  return new BadRequestException(body);
}

/** Service API for hosted apps and the agent runtime (HMAC-signed, no cookies). */
@Public()
@SkipThrottle()
@UseGuards(AppSignatureGuard)
@Controller('app-api')
export class AppApiController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient) {}

  @HttpCode(200)
  @Post('entitlements')
  async entitlements(@Req() req: AppRequest, @Body(new ZodPipe(Org)) body: z.infer<typeof Org>) {
    try {
      return await appEntitlements(this.db, req.appKey!, body.orgId);
    } catch (e) {
      throw mapError(e);
    }
  }

  @HttpCode(200)
  @Post('usage/reserve')
  async reserve(@Req() req: AppRequest, @Body(new ZodPipe(Reserve)) body: z.infer<typeof Reserve>) {
    try {
      return await appReserve(this.db, req.appKey!, body);
    } catch (e) {
      throw mapError(e);
    }
  }

  @HttpCode(200)
  @Post('usage/settle')
  async settle(@Req() req: AppRequest, @Body(new ZodPipe(Settle)) body: z.infer<typeof Settle>) {
    try {
      return await appSettle(this.db, req.appKey!, body);
    } catch (e) {
      throw mapError(e);
    }
  }

  @HttpCode(200)
  @Post('usage/release')
  async release(@Req() req: AppRequest, @Body(new ZodPipe(Release)) body: z.infer<typeof Release>) {
    try {
      return await appRelease(this.db, req.appKey!, body.reservationId);
    } catch (e) {
      throw mapError(e);
    }
  }
}
