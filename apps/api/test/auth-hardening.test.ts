import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { NestExpressApplication } from '@nestjs/platform-express';
import { totpCode } from '@ooc/shared';
import { MailService } from '../src/auth/mail.service';
import { ORIGIN, createTestApp, db, makeOperator, resetDb, signUp } from './harness';

let app: NestExpressApplication;
let mail: MailService;
beforeAll(async () => {
  ({ app, mail } = (await createTestApp()) as { app: NestExpressApplication; mail: MailService });
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetDb);

const login = (email: string, password: string) => request(app.getHttpServer()).post('/v1/auth/login').set('Origin', ORIGIN).send({ email, password });

describe('auth hardening', () => {
  it('locks an account after 10 failures with the same response as a wrong password, and reset unlocks it', async () => {
    await signUp(app, 'victim@example.com', 'correct-horse-battery');
    for (let i = 0; i < 10; i++) expect((await login('victim@example.com', `wrong-${i}-password`)).status).toBe(401);
    const locked = await login('victim@example.com', 'correct-horse-battery');
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe('invalid_credentials'); // indistinguishable from unknown account
    expect((await login('nobody@example.com', 'whatever-password')).body).toEqual(locked.body);
    expect(mail.devOutbox.some((m) => m.to === 'victim@example.com' && m.subject.startsWith('Sign-in temporarily blocked'))).toBe(true);
    expect(await db.auditEvent.count({ where: { action: 'auth.account_locked' } })).toBe(1);

    await db.user.update({ where: { email: 'victim@example.com' }, data: { loginLockedUntil: new Date(Date.now() - 1000) } });
    expect((await login('victim@example.com', 'correct-horse-battery')).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { email: 'victim@example.com' } })).failedLogins).toBe(0);
  });

  it('rejects a replayed MFA code and ends the session after 5 wrong codes', async () => {
    const op = await makeOperator(app, 'ops@example.com');
    const fresh = request.agent(app.getHttpServer());
    await fresh.post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'ops@example.com', password: 'correct-horse-battery' }).expect(200);
    const next = totpCode(op.secret, Date.now() + 30_000);
    await fresh.post('/v1/auth/mfa/verify').set('Origin', ORIGIN).send({ code: next }).expect(200);

    const second = request.agent(app.getHttpServer());
    await second.post('/v1/auth/login').set('Origin', ORIGIN).send({ email: 'ops@example.com', password: 'correct-horse-battery' }).expect(200);
    expect((await second.post('/v1/auth/mfa/verify').set('Origin', ORIGIN).send({ code: next }).expect(403)).body.error).toBe('invalid_mfa_code'); // replay
    for (let i = 0; i < 3; i++) await second.post('/v1/auth/mfa/verify').set('Origin', ORIGIN).send({ code: '000000' }).expect(403);
    const last = await second.post('/v1/auth/mfa/verify').set('Origin', ORIGIN).send({ code: '000000' }).expect(403);
    expect(last.body.error).toBe('mfa_attempts_exceeded');
    await second.get('/v1/auth/me').expect(401);
  });
});
