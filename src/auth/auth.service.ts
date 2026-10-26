import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from 'octokit';
import type { Env } from '../config/env.js';
import { encrypt } from '../common/utils/crypto.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Quyền xin từ GitHub: `repo` để đọc/ghi issue và đăng ký webhook (kể cả repo riêng tư). */
const OAUTH_SCOPE = 'repo read:user';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) { }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.get('GITHUB_CLIENT_ID', { infer: true }),
      redirect_uri: `${this.config.get('API_URL', { infer: true })}/auth/github/callback`,
      scope: OAUTH_SCOPE,
      state,
      prompt: 'select_account',
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /** Đổi mã `code` mà GitHub trả về lấy token, rồi lưu (hoặc cập nhật) người dùng. */
  async loginWithCode(code: string): Promise<User> {
    const accessToken = await this.exchangeCode(code);
    const { data } = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();

    const encrypted = encrypt(
      accessToken,
      this.config.get('TOKEN_ENCRYPTION_KEY', { infer: true }),
    );
    const fields = {
      login: data.login,
      name: data.name ?? null,
      avatarUrl: data.avatar_url,
      accessToken: encrypted,
    };
    return this.prisma.user.upsert({
      where: { id: data.id },
      create: { id: data.id, ...fields },
      update: fields,
    });
  }

  private async exchangeCode(code: string): Promise<string> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.get('GITHUB_CLIENT_ID', { infer: true }),
        client_secret: this.config.get('GITHUB_CLIENT_SECRET', { infer: true }),
        code,
        redirect_uri: `${this.config.get('API_URL', { infer: true })}/auth/github/callback`,
      }),
    });
    const data = (await response.json()) as { access_token?: string; error_description?: string };
    if (!response.ok || !data.access_token) {
      throw new UnauthorizedException(data.error_description ?? 'GitHub từ chối đăng nhập');
    }
    return data.access_token;
  }
}
