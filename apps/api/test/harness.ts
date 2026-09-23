import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createPrismaClient } from '@ooc/db';
import { truncateAll } from '@ooc/db/testing';
import { CashfreeClient } from '@ooc/integrations';
import { base32Decode, loadConfig, totpCode } from '@ooc/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { CASHFREE } from '../src/providers/providers.module';
import { MailService } from '../src/auth/mail.service';

export const ORIGIN = 'http://localhost:3000';
export const db = createPrismaClient(process.env.DATABASE_URL!);

export type FetchCall = { url: string; init: RequestInit };
export const cashfreeCalls: FetchCall[] = [];
let cashfreeResponder: (c: FetchCall) => Response = () => new Response('{}', { status: 500 });
export function onCashfree(fn: (c: FetchCall) => Response) {
  cashfreeResponder = fn;
}
const mockFetch = (async (url: string | URL, init: RequestInit) => {
  const call = { url: String(url), init };
  cashfreeCalls.push(call);
  return cashfreeResponder(call);
}) as unknown as typeof fetch;

export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CASHFREE)
    .useValue(new CashfreeClient('https://sandbox.cashfree.com/pg', { clientId: 'test-client', clientSecret: 'test-secret', apiVersion: '2025-01-01' }, mockFetch))
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app, loadConfig(process.env));
  await app.init();
  return { app, mail: app.get(MailService) };
}

export async function resetDb() {
  await truncateAll(db);
  cashfreeCalls.length = 0;
}

/** A logged-in browser-like client: cookie jar + trusted Origin on every request. */
export async function signUp(app: NestExpressApplication, email: string, password = 'correct-horse-battery') {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/v1/auth/register').set('Origin', ORIGIN).send({ email, password }).expect(201);
  await agent.post('/v1/auth/login').set('Origin', ORIGIN).send({ email, password }).expect(200);
  const me = await agent.get('/v1/auth/me').expect(200);
  return { agent, userId: me.body.id as string, email };
}

export async function makeOperator(app: NestExpressApplication, email: string, role: 'operator_admin' | 'operator_finance' = 'operator_admin') {
  const u = await signUp(app, email);
  await db.user.update({ where: { id: u.userId }, data: { operatorRole: role } });
  const setup = await u.agent.post('/v1/auth/mfa/setup').set('Origin', ORIGIN).expect(201);
  const secret = new URL(setup.body.otpauthUri).searchParams.get('secret')!;
  expect32(secret);
  await u.agent.post('/v1/auth/mfa/enable').set('Origin', ORIGIN).send({ code: totpCode(secret) }).expect(200);
  return { ...u, secret };
}

function expect32(secret: string) {
  if (base32Decode(secret).length !== 20) throw new Error('unexpected TOTP secret length');
}

export async function createOrg(agent: request.Agent, name = 'Acme Traders', stateCode = '29') {
  const org = await agent.post('/v1/orgs').set('Origin', ORIGIN).send({ name }).expect(201);
  await agent.patch(`/v1/orgs/${org.body.id}/billing`).set('Origin', ORIGIN).send({ stateCode, legalName: `${name} Pvt Ltd` }).expect(200);
  return org.body.id as string;
}

/** Creates a sellable app product directly in the DB (operator flows are tested separately). */
export async function sellableProduct(opts: { amountMinor?: number; interval?: string; key?: string } = {}) {
  const key = opts.key ?? `crm-${Math.random().toString(36).slice(2, 7)}`;
  await db.appAdapter.upsert({ where: { key: 'app.crm' }, update: { status: 'sandbox' }, create: { key: 'app.crm', name: 'CRM', status: 'sandbox' } });
  const product = await db.product.create({ data: { key, name: 'CRM', family: 'hosted_apps', fulfillment: 'app_adapter', adapterKey: 'app.crm', taxCategory: 'saas', status: 'active' } });
  const plan = await db.plan.create({ data: { productId: product.id, key: `${key}-starter`, name: 'CRM Starter', tier: 'starter' } });
  const version = await db.planVersion.create({ data: { planId: plan.id, version: 1 } });
  const price = await db.priceVersion.create({ data: { planVersionId: version.id, kind: 'subscription', billingInterval: opts.interval ?? 'P1M', amountMinor: BigInt(opts.amountMinor ?? 49900) } });
  await db.planVersion.update({ where: { id: version.id }, data: { publishedAt: new Date() } });
  if ((await db.taxRule.count({ where: { taxCategory: 'saas' } })) === 0) {
    await db.taxRule.createMany({
      data: [
        { taxCategory: 'saas', supplyType: 'intra_state', components: [{ name: 'CGST', rateBps: 900 }, { name: 'SGST', rateBps: 900 }], reviewed: true, reviewedBy: 'test' },
        { taxCategory: 'saas', supplyType: 'inter_state', components: [{ name: 'IGST', rateBps: 1800 }], reviewed: true, reviewedBy: 'test' },
      ],
    });
  }
  return { product, plan, version, price };
}
