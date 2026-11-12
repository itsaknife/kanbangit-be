import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service.js';
import { decrypt } from '../common/utils/crypto.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Env } from '../config/env.js';

vi.mock('octokit', () => ({
  Octokit: class {
    rest = {
      users: {
        getAuthenticated: async () => ({
          data: { id: 42, login: 'renamed', name: null, avatar_url: 'avatar' },
        }),
      },
    };
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe('GitHub OAuth account linking', () => {
  it('upserts by GitHub ID, encrypts token and links all pending memberships atomically', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'fake-token' }) })),
    );
    const upsert = vi.fn(
      async (_args: { where: { githubId: bigint }; create: { accessToken: string } }) => ({
        id: '10000000-0000-4000-8000-000000000001',
        login: 'renamed',
      }),
    );
    const updateMany = vi.fn();
    const prisma = {
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ user: { upsert }, repositoryMember: { updateMany } }),
    };
    const key = 'ab'.repeat(32);
    const config = new ConfigService({
      TOKEN_ENCRYPTION_KEY: key,
      GITHUB_CLIENT_ID: 'test',
      GITHUB_CLIENT_SECRET: 'test',
      API_URL: 'http://localhost:4000',
    }) as ConfigService<Env, true>;
    const result = await new AuthService(config, prisma as unknown as PrismaService).loginWithCode(
      'code',
    );
    expect(result.id).toBe('10000000-0000-4000-8000-000000000001');
    const args = upsert.mock.calls[0]![0];
    expect(args.where).toEqual({ githubId: 42n });
    expect(args.create.accessToken).not.toBe('fake-token');
    expect(decrypt(args.create.accessToken, key)).toBe('fake-token');
    expect(updateMany).toHaveBeenCalledWith({
      where: { githubUserId: 42n },
      data: { userId: '10000000-0000-4000-8000-000000000001' },
    });
  });

  it('rejects token exchange failure without accessing the database', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error_description: 'denied' }) })),
    );
    const prisma = { $transaction: vi.fn() };
    const auth = new AuthService(
      new ConfigService({}) as ConfigService<Env, true>,
      prisma as unknown as PrismaService,
    );
    await expect(auth.loginWithCode('bad')).rejects.toThrow('denied');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
