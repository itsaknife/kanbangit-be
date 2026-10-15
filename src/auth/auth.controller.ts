import { randomBytes } from 'node:crypto';
import { Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { SESSION_COOKIE } from '../common/types/request.js';
import type { Env } from '../config/env.js';
import type { User } from '../generated/prisma/client.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';

const STATE_COOKIE = 'oauth_state';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly session: SessionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Bắt đầu đăng nhập: chuyển hướng sang GitHub. `state` chống giả mạo yêu cầu đăng nhập. */
  @Get('github')
  startLogin(@Res() res: Response): void {
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, { ...this.cookieOptions(), maxAge: 10 * 60 * 1000 });
    res.redirect(this.auth.buildAuthorizeUrl(state));
  }

  /** GitHub chuyển người dùng về đây kèm `code`. Xong thì đặt cookie đăng nhập và về giao diện web. */
  @Get('github/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const frontend = this.config.get('FRONTEND_URL', { infer: true });
    const expectedState = (req.cookies as Record<string, string> | undefined)?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, this.cookieOptions());

    if (!code || !state || state !== expectedState) {
      res.redirect(`${frontend}/login?error=invalid_state`);
      return;
    }

    try {
      const user = await this.auth.loginWithCode(code);
      const token = await this.session.sign(user.id);
      res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: SESSION_MAX_AGE_MS });
      res.redirect(`${frontend}/repositories`);
    } catch {
      res.redirect(`${frontend}/login?error=github_failed`);
    }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    return { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  /**
   * Cookie httpOnly để JavaScript trên trang không đọc được.
   * Khi chạy thật (frontend và backend khác tên miền) cần SameSite=None kèm Secure.
   */
  private cookieOptions(): CookieOptions {
    const production = this.config.get('NODE_ENV', { infer: true }) === 'production';
    return {
      httpOnly: true,
      secure: production,
      sameSite: production ? 'none' : 'lax',
      path: '/',
    };
  }
}
