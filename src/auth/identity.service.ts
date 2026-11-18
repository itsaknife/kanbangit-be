import { ConflictException, Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Octokit } from 'octokit';
import { PrismaService } from '../prisma/prisma.service.js';
import { decrypt, encrypt } from '../common/utils/crypto.js';
import type { AuthProvider, User } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';

export interface ProviderAccount {
  provider: AuthProvider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  login: string;
  name: string | null;
  avatarUrl: string;
  accessToken: string | null;
}
@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}
  provider(value: string): AuthProvider {
    if (value.toUpperCase() !== 'GOOGLE' && value.toUpperCase() !== 'GITHUB')
      throw new BadRequestException('Provider không hợp lệ');
    return value.toUpperCase() as AuthProvider;
  }
  authorize(provider: AuthProvider, state: string) {
    const google = provider === 'GOOGLE';
    const id = this.config.get(google ? 'GOOGLE_CLIENT_ID' : 'GITHUB_CLIENT_ID', { infer: true });
    if (!id) throw new BadRequestException('Google OAuth chưa được cấu hình');
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: `${this.config.get('API_URL', { infer: true })}/auth/${provider.toLowerCase()}/callback`,
      scope: google ? 'openid email profile' : 'repo read:user user:email',
      state,
      response_type: 'code',
      prompt: google ? 'select_account' : 'select_account',
    });
    return `${google ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize'}?${params}`;
  }
  async exchange(provider: AuthProvider, code: string) {
    const google = provider === 'GOOGLE';
    const response = await fetch(
      google
        ? 'https://oauth2.googleapis.com/token'
        : 'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id:
            this.config.get(google ? 'GOOGLE_CLIENT_ID' : 'GITHUB_CLIENT_ID', { infer: true }) ??
            '',
          client_secret:
            this.config.get(google ? 'GOOGLE_CLIENT_SECRET' : 'GITHUB_CLIENT_SECRET', {
              infer: true,
            }) ?? '',
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${this.config.get('API_URL', { infer: true })}/auth/${provider.toLowerCase()}/callback`,
        }),
      },
    );
    const token = (await response.json()) as { access_token?: string };
    if (!response.ok || !token.access_token) throw new BadRequestException('OAuth thất bại');
    let account: ProviderAccount;
    if (google) {
      const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(15000),
      });
      const p = (await profile.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!profile.ok || !p.sub) throw new BadRequestException('Google identity không hợp lệ');
      account = {
        provider,
        providerUserId: p.sub,
        email: p.email ?? null,
        emailVerified: p.email_verified === true,
        login: `user-${randomUUID()}`,
        name: p.name ?? null,
        avatarUrl: p.picture ?? '',
        accessToken: null,
      };
    } else {
      const client = new Octokit({ auth: token.access_token });
      const [{ data: p }, { data: emails }] = await Promise.all([
        client.rest.users.getAuthenticated(),
        client.rest.users.listEmailsForAuthenticatedUser(),
      ]);
      const email = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      account = {
        provider,
        providerUserId: String(p.id),
        email: email?.email ?? null,
        emailVerified: !!email,
        login: p.login,
        name: p.name ?? null,
        avatarUrl: p.avatar_url,
        accessToken: encrypt(
          token.access_token,
          this.config.get('TOKEN_ENCRYPTION_KEY', { infer: true }),
        ),
      };
    }
    return account;
  }
  async resolve(a: ProviderAccount, linkUserId?: string) {
    // Migrated GitHub identities may not have an email yet. Perform provider I/O
    // before opening a DB transaction; never infer ownership from a public email.
    const legacyEmails = new Map<string, { token: string | null; emails: string[] | null }>();
    if (!linkUserId && a.emailVerified && a.email) {
      const existing = await this.prisma.authIdentity.findUnique({
        where: {
          provider_providerUserId: { provider: a.provider, providerUserId: a.providerUserId },
        },
      });
      if (!existing) {
        if (
          await this.prisma.authIdentity.findFirst({
            where: { email: { equals: a.email, mode: 'insensitive' }, emailVerified: true },
          })
        )
          throw new ConflictException('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
        const legacy = await this.prisma.authIdentity.findMany({
          where: { provider: 'GITHUB', OR: [{ email: null }, { emailVerified: false }] },
          take: 20,
        });
        await Promise.all(
          legacy.map(async (identity) => {
            legacyEmails.set(identity.id, {
              token: identity.accessToken,
              emails: await this.legacyVerifiedEmails(identity),
            });
          }),
        );
      }
    }
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize email collision checks and simultaneous links/unlinks.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('kanbangit-identities',0))::text`;
        const existing = await tx.authIdentity.findUnique({
          where: {
            provider_providerUserId: { provider: a.provider, providerUserId: a.providerUserId },
          },
        });
        if (existing && linkUserId && existing.userId !== linkUserId)
          throw new ConflictException('IDENTITY_OWNED_BY_ANOTHER_USER');
        let userId = linkUserId ?? existing?.userId;
        if (!userId) {
          if (
            a.emailVerified &&
            a.email &&
            (await tx.authIdentity.findFirst({
              where: { email: { equals: a.email, mode: 'insensitive' }, emailVerified: true },
            }))
          )
            throw new ConflictException('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
          if (a.emailVerified && a.email) {
            const legacy = await tx.authIdentity.findMany({
              where: { provider: 'GITHUB', OR: [{ email: null }, { emailVerified: false }] },
            });
            for (const identity of legacy) {
              const checked = legacyEmails.get(identity.id);
              if (!checked || checked.token !== identity.accessToken || checked.emails === null) {
                continue;
              }
              if (
                checked.emails.some(
                  (email) => email.toLowerCase() === a.email!.trim().toLowerCase(),
                )
              )
                throw new ConflictException('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER');
            }
            // Missing metadata or another person's expired credential is not
            // evidence that this verified email is already registered.
          }
          const user = await tx.user.create({
            data: { login: `user-${randomUUID()}`, name: a.name, avatarUrl: a.avatarUrl },
          });
          userId = user.id;
        }
        const occupied = await tx.authIdentity.findUnique({
          where: { userId_provider: { userId, provider: a.provider } },
        });
        if (occupied && occupied.providerUserId !== a.providerUserId)
          throw new ConflictException('PROVIDER_ALREADY_LINKED');
        const { name: _name, avatarUrl: _avatar, ...fields } = a;
        await tx.authIdentity.upsert({
          where: {
            provider_providerUserId: { provider: a.provider, providerUserId: a.providerUserId },
          },
          create: { ...fields, userId },
          update: fields,
        });
        if (a.provider === 'GITHUB') {
          await tx.user.update({
            where: { id: userId },
            data: { githubId: BigInt(a.providerUserId) },
          });
          await tx.repositoryMember.updateMany({
            where: { githubUserId: BigInt(a.providerUserId) },
            data: { userId },
          });
          // Owner-entered historical worklogs may predate this person's first login.
          // Reconcile their overlap key when the GitHub identity becomes linked.
          await tx.worklog.updateMany({
            where: { githubUserId: BigInt(a.providerUserId), personKey: { not: userId } },
            data: { personKey: userId },
          });
        }
        return tx.user.findUniqueOrThrow({ where: { id: userId } });
      },
      { timeout: 30000 },
    );
  }
  private async legacyVerifiedEmails(identity: {
    providerUserId: string;
    accessToken: string | null;
  }): Promise<string[] | null> {
    if (!identity.accessToken) return null;
    try {
      const client = new Octokit({
        auth: decrypt(
          identity.accessToken,
          this.config.get('TOKEN_ENCRYPTION_KEY', { infer: true }),
        ),
        request: { timeout: 5000 },
        retry: { enabled: false },
        throttle: { enabled: false },
      });
      const [{ data: user }, { data: emails }] = await Promise.all([
        client.rest.users.getAuthenticated(),
        client.rest.users.listEmailsForAuthenticatedUser(),
      ]);
      if (String(user.id) !== identity.providerUserId) return null;
      return emails.filter((email) => email.verified).map((email) => email.email);
    } catch {
      return null;
    }
  }
  list(user: User) {
    return this.prisma.authIdentity.findMany({
      where: { userId: user.id },
      select: {
        provider: true,
        providerUserId: true,
        email: true,
        emailVerified: true,
        login: true,
      },
    });
  }
  async unlink(user: User, provider: AuthProvider) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('kanbangit-identities',0))::text`;
      if ((await tx.authIdentity.count({ where: { userId: user.id } })) <= 1)
        throw new ConflictException('Không thể gỡ phương thức đăng nhập cuối cùng');
      await tx.authIdentity.deleteMany({ where: { userId: user.id, provider } });
      if (provider === 'GITHUB')
        await tx.user.update({
          where: { id: user.id },
          data: { githubId: null, accessToken: null },
        });
    });
  }
}
