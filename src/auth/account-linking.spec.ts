import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { IdentityService, type ProviderAccount } from './identity.service.js';
import { ProjectAuthController } from './project-auth.controller.js';
import { IdentitiesController } from './identities.controller.js';
import { SessionService } from './session.service.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.js';
import { oauthSessionHash } from './oauth-state.js';

function fixture() {
  const users: Record<string, unknown>[] = [];
  const identities: Record<string, unknown>[] = [];
  const findUnique = vi.fn(
    async ({ where }: any) =>
      identities.find((i) =>
        where.provider_providerUserId
          ? i.provider === where.provider_providerUserId.provider &&
            i.providerUserId === where.provider_providerUserId.providerUserId
          : i.userId === where.userId_provider.userId &&
            i.provider === where.userId_provider.provider,
      ) ?? null,
  );
  const legacy = () =>
    identities.filter((i) => i.provider === 'GITHUB' && (!i.email || !i.emailVerified));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    authIdentity: {
      findUnique,
      findMany: vi.fn(async () => legacy()),
      findFirst: vi.fn(
        async ({ where }: any) =>
          identities.find(
            (i) =>
              i.emailVerified && String(i.email).toLowerCase() === where.email.equals.toLowerCase(),
          ) ?? null,
      ),
      upsert: vi.fn(async ({ create, update, where }: any) => {
        const old = await findUnique({ where });
        if (old) {
          Object.assign(old, update);
          return old;
        }
        const row = { ...create, id: 'identity-' + identities.length };
        identities.push(row);
        return row;
      }),
    },
    user: {
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, id: 'user-' + users.length };
        users.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const u = users.find((u) => u.id === where.id);
        Object.assign(u!, data);
        return u;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const u = users.find((u) => u.id === where.id);
        if (!u) throw Error('Missing User');
        return u;
      }),
    },
    repositoryMember: { updateMany: vi.fn(async () => ({ count: 0 })) },
    worklog: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  let tail = Promise.resolve();
  const prisma = {
    ...tx,
    $transaction: vi.fn((fn: any) => {
      const run = tail.then(() => fn(tx));
      tail = run.catch(() => {});
      return run;
    }),
  };
  const service = new IdentityService(
    prisma as unknown as PrismaService,
    new ConfigService({ TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }) as ConfigService<Env, true>,
  );
  return { service, users, identities, tx };
}
const account = (provider: 'GOOGLE' | 'GITHUB', id: string, email: string): ProviderAccount => ({
  provider,
  providerUserId: id,
  email,
  emailVerified: true,
  login: 'person',
  name: 'Person',
  avatarUrl: '',
  accessToken: null,
});
describe('account resolution without automatic merge', () => {
  for (const provider of ['GOOGLE', 'GITHUB'] as const) {
    it(`${provider}: creates an account only for a new identity/email and logs back into the same User`, async () => {
      const f = fixture(),
        a = account(provider, '101', 'new@example.test');
      const first = await f.service.resolve(a);
      const again = await f.service.resolve(a);
      expect(first.id).toBe(again.id);
      expect(f.users).toHaveLength(1);
      expect(f.identities).toHaveLength(1);
    });
    it(`${provider}: rejects a verified email owned by the other provider without creating or linking`, async () => {
      const f = fixture();
      await f.service.resolve(
        account(provider === 'GOOGLE' ? 'GITHUB' : 'GOOGLE', '102', 'same@example.test'),
      );
      await expect(
        f.service.resolve(account(provider, '103', 'SAME@example.test')),
      ).rejects.toThrow('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
      expect(f.users).toHaveLength(1);
      expect(f.identities).toHaveLength(1);
    });
    it(`${provider}: explicitly links the second provider, idempotently, then both logins resolve the original User`, async () => {
      const f = fixture(),
        old = account(provider === 'GOOGLE' ? 'GITHUB' : 'GOOGLE', '104', 'same@example.test'),
        next = account(provider, '105', 'same@example.test');
      const user = await f.service.resolve(old);
      await f.service.resolve(next, user.id);
      await f.service.resolve(next, user.id);
      expect((await f.service.resolve(next)).id).toBe(user.id);
      expect((await f.service.resolve(old)).id).toBe(user.id);
      expect(f.users).toHaveLength(1);
      expect(f.identities).toHaveLength(2);
    });
    it(`${provider}: rejects identity ownership transfer and leaves both accounts unchanged`, async () => {
      const f = fixture();
      const a = await f.service.resolve(account(provider, '106', 'a@example.test'));
      const b = await f.service.resolve(
        account(provider === 'GOOGLE' ? 'GITHUB' : 'GOOGLE', '107', 'b@example.test'),
      );
      const before = JSON.stringify(f.identities);
      await expect(
        f.service.resolve(account(provider, '106', 'a@example.test'), b.id),
      ).rejects.toThrow('IDENTITY_OWNED_BY_ANOTHER_USER');
      expect(JSON.stringify(f.identities)).toBe(before);
      expect(a.id).not.toBe(b.id);
    });
  }
  it('serializes competing links so exactly one User acquires an identity', async () => {
    const f = fixture();
    const a = await f.service.resolve(account('GITHUB', '201', 'a@example.test')),
      b = await f.service.resolve(account('GITHUB', '202', 'b@example.test'));
    const next = account('GOOGLE', '203', 'new@example.test');
    const result = await Promise.allSettled([
      f.service.resolve(next, a.id),
      f.service.resolve(next, b.id),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.identities.filter((i) => i.provider === 'GOOGLE')).toHaveLength(1);
  });
  it('checks migrated GitHub verified emails before creating the second provider User', async () => {
    const f = fixture();
    f.identities.push({
      id: 'legacy',
      provider: 'GITHUB',
      providerUserId: '301',
      userId: 'legacy-user',
      email: null,
      emailVerified: false,
      accessToken: 'encrypted',
    });
    const lookup = vi
      .spyOn(
        f.service as unknown as { legacyVerifiedEmails: (i: unknown) => Promise<string[] | null> },
        'legacyVerifiedEmails',
      )
      .mockResolvedValue(['registered@example.test']);
    await expect(
      f.service.resolve(account('GOOGLE', '302', 'registered@example.test')),
    ).rejects.toThrow('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
    expect(lookup).toHaveBeenCalledOnce();
    expect(f.users).toHaveLength(0);
    expect(f.identities).toHaveLength(1);
  });
  it('allows a new Google email when an unrelated legacy credential cannot verify its email', async () => {
    const f = fixture();
    f.identities.push({
      id: 'legacy',
      provider: 'GITHUB',
      providerUserId: '401',
      email: null,
      emailVerified: false,
      accessToken: null,
    });
    const before = { ...f.identities[0] };
    await f.service.resolve(account('GOOGLE', '402', 'new@example.test'));
    expect(f.users).toHaveLength(1);
    expect(f.identities).toHaveLength(2);
    expect(f.identities[0]).toEqual(before);
  });
  it('does not globally block new users because more than twenty legacy records lack email metadata', async () => {
    const f = fixture();
    for (let i = 0; i < 21; i++)
      f.identities.push({
        id: `legacy-${i}`,
        provider: 'GITHUB',
        providerUserId: String(600 + i),
        email: null,
        emailVerified: false,
        accessToken: null,
      });
    await f.service.resolve(account('GOOGLE', 'new-google', 'new@example.test'));
    expect(f.users).toHaveLength(1);
    expect(f.identities.filter((i) => i.provider === 'GOOGLE')).toHaveLength(1);
  });
  it('does not use an unverified email as proof of another account or a linking key', async () => {
    const f = fixture();
    await f.service.resolve(account('GOOGLE', '501', 'same@example.test'));
    const next = account('GITHUB', '502', 'same@example.test');
    next.emailVerified = false;
    await f.service.resolve(next);
    expect(f.users).toHaveLength(2);
    expect(f.identities).toHaveLength(2);
  });
});

describe('OAuth login/link HTTP state and session handling', () => {
  let app: INestApplication, jwt: JwtService;
  const user = { id: 'user-a' };
  const identities = {
    provider: (p: string) => p.toUpperCase(),
    authorize: vi.fn(
      (p: string, s: string) => `https://provider.test/?state=${encodeURIComponent(s)}`,
    ),
    exchange: vi.fn(async (provider: 'GOOGLE' | 'GITHUB') =>
      account(provider, '601', 'a@example.test'),
    ),
    resolve: vi.fn(async () => user),
    list: vi.fn(async () => []),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret-for-oauth-state' })],
      controllers: [ProjectAuthController, IdentitiesController],
      providers: [
        JwtAuthGuard,
        { provide: IdentityService, useValue: identities },
        {
          provide: SessionService,
          useValue: {
            verify: async (t: string) => (t === 'session-a' ? user : null),
            sign: async () => 'issued-session',
          },
        },
        {
          provide: ConfigService,
          useValue: new ConfigService({ FRONTEND_URL: 'http://frontend.test', NODE_ENV: 'test' }),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    await app.init();
    jwt = app.get(JwtService);
  });
  afterEach(async () => {
    await app.close();
  });
  it('rejects unauthenticated Connect before generating state', async () => {
    const r = await request(app.getHttpServer()).post('/users/me/identities/GOOGLE/link');
    expect(r.status).toBe(401);
  });
  it('rejects invalid and expired signed state without exchanging a provider code', async () => {
    for (const state of [
      'invalid.jwt.value',
      await jwt.signAsync(
        {
          purpose: 'link',
          userId: user.id,
          provider: 'GOOGLE',
          sessionHash: oauthSessionHash('session-a'),
        },
        { expiresIn: -1 },
      ),
    ]) {
      const r = await request(app.getHttpServer())
        .get('/auth/google/callback')
        .query({ code: 'code', state })
        .set('Cookie', [`oauth_GOOGLE=${state}`, 'session=session-a']);
      expect(r.headers.location).toBe('http://frontend.test/settings?error=invalid_state');
    }
    expect(identities.exchange).not.toHaveBeenCalled();
  });
  for (const provider of ['GOOGLE', 'GITHUB'] as const) {
    it(`${provider}: login callback resolves by provider and never creates a linking session`, async () => {
      const state = 'login-state',
        path = provider.toLowerCase();
      const r = await request(app.getHttpServer())
        .get(`/auth/${path}/callback`)
        .query({ code: 'code', state })
        .set('Cookie', `oauth_${provider}=${state}`);
      expect(identities.exchange).toHaveBeenCalledWith(provider, 'code');
      expect(identities.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ provider }),
        undefined,
      );
      expect(r.headers.location).toBe('http://frontend.test/projects');
      expect(String(r.headers['set-cookie']).includes('session=')).toBe(true);
    });
  }
  it('redirects a collision using the exact business code and does not issue a session', async () => {
    identities.resolve.mockRejectedValueOnce(new Error('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER'));
    const r = await request(app.getHttpServer())
      .get('/auth/google/callback?code=code&state=login-state')
      .set('Cookie', 'oauth_GOOGLE=login-state');
    expect(r.headers.location).toBe(
      'http://frontend.test/login?error=ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER',
    );
    expect(String(r.headers['set-cookie']).includes('session=')).toBe(false);
  });
  it('rejects mismatched cookie state and never resolves a User', async () => {
    const r = await request(app.getHttpServer())
      .get('/auth/google/callback?code=code&state=wrong')
      .set('Cookie', 'oauth_GOOGLE=expected');
    expect(r.headers.location).toContain('invalid_state');
    expect(identities.resolve).not.toHaveBeenCalled();
  });
  it('binds linking to the current User and exact session, and reports success after a valid callback', async () => {
    const api = request(app.getHttpServer());
    const start = await api
      .post('/users/me/identities/GOOGLE/link')
      .set('Cookie', 'session=session-a');
    expect(start.status).toBe(201);
    const state = new URL('http://api.test' + start.body.url).searchParams.get('link')!;
    const bad = await api
      .get('/auth/google')
      .query({ link: state })
      .set('Cookie', 'session=other-session');
    expect(bad.headers.location).toContain('invalid_state');
    const good = await api
      .get('/auth/google')
      .query({ link: state })
      .set('Cookie', 'session=session-a');
    expect(good.headers['set-cookie'][0]).toContain('oauth_GOOGLE=');
    const done = await api
      .get('/auth/google/callback')
      .query({ code: 'code', state })
      .set('Cookie', [`oauth_GOOGLE=${state}`, 'session=session-a']);
    expect(identities.resolve).toHaveBeenCalledWith(expect.any(Object), user.id);
    expect(done.headers.location).toBe('http://frontend.test/settings?result=ACCOUNT_LINK_SUCCESS');
    expect(done.headers.location).not.toContain('issued-session');
  });
});
