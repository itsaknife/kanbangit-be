import { randomBytes } from 'node:crypto';
import { Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { SESSION_COOKIE } from '../common/types/request.js';
import type { Env } from '../config/env.js';
import type { User, AuthProvider } from '../generated/prisma/client.js';
import { SessionService } from './session.service.js';
import { IdentityService } from './identity.service.js';
import { publicProfile } from './profile.controller.js';
import { oauthSessionHash } from './oauth-state.js';
@Controller('auth')
export class ProjectAuthController {
  constructor(
    private readonly identities: IdentityService,
    private readonly session: SessionService,
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
  ) {}
  @Get('github') github(@Req() req: Request, @Res() res: Response, @Query('link') link?: string) {
    return this.start('GITHUB', req, res, link);
  }
  @Get('google') google(@Req() req: Request, @Res() res: Response, @Query('link') link?: string) {
    return this.start('GOOGLE', req, res, link);
  }
  private async start(provider: AuthProvider, req: Request, res: Response, link?: string) {
    let state = randomBytes(32).toString('hex');
    if (link) {
      try {
        const payload = await this.jwt.verifyAsync<{
          purpose: string;
          provider: AuthProvider;
          userId: string;
          sessionHash: string;
        }>(link);
        const user = await this.session.verify(req.cookies?.[SESSION_COOKIE]);
        if (
          payload.purpose !== 'link' ||
          payload.provider !== provider ||
          payload.userId !== user?.id ||
          !payload.sessionHash ||
          payload.sessionHash !== oauthSessionHash(req.cookies?.[SESSION_COOKIE])
        ) {
          res.redirect(`${this.frontend()}/settings?error=invalid_state`);
          return;
        }
        state = link;
      } catch {
        res.redirect(`${this.frontend()}/settings?error=invalid_state`);
        return;
      }
    }
    const url = this.identities.authorize(provider, state);
    res.cookie(`oauth_${provider}`, state, { ...this.cookies(), maxAge: 600000 });
    res.redirect(url);
  }
  @Get('github/callback') githubCallback(@Req() req: Request, @Res() res: Response) {
    return this.callback('GITHUB', req, res);
  }
  @Get('google/callback') googleCallback(@Req() req: Request, @Res() res: Response) {
    return this.callback('GOOGLE', req, res);
  }
  private async callback(provider: AuthProvider, req: Request, res: Response) {
    const { code, state } = req.query;
    const expected = req.cookies?.[`oauth_${provider}`];
    res.clearCookie(`oauth_${provider}`, this.cookies());
    let target = typeof expected === 'string' && expected.includes('.') ? '/settings' : '/login';
    try {
      if (typeof code !== 'string' || typeof state !== 'string' || !expected || state !== expected)
        throw Error('invalid_state');
      let linkUserId: string | undefined;
      if (state.includes('.')) {
        target = '/settings';
        const p = await this.jwt
          .verifyAsync<{
            purpose: string;
            provider: AuthProvider;
            userId: string;
            sessionHash: string;
          }>(state)
          .catch(() => {
            throw Error('invalid_state');
          });
        const user = await this.session.verify(req.cookies?.[SESSION_COOKIE]);
        if (
          p.purpose !== 'link' ||
          p.provider !== provider ||
          !user ||
          p.userId !== user.id ||
          !p.sessionHash ||
          p.sessionHash !== oauthSessionHash(req.cookies?.[SESSION_COOKIE])
        )
          throw Error('invalid_state');
        linkUserId = user.id;
      }
      const user = await this.identities.resolve(
        await this.identities.exchange(provider, code),
        linkUserId,
      );
      res.cookie(SESSION_COOKIE, await this.session.sign(user.id), {
        ...this.cookies(),
        maxAge: 7 * 86400000,
      });
      res.redirect(
        `${this.frontend()}${linkUserId ? '/settings?result=ACCOUNT_LINK_SUCCESS' : '/projects'}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = [
        'ACCOUNT_LINK_REQUIRED',
        'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER',
        'ACCOUNT_EMAIL_VERIFICATION_REQUIRED',
        'IDENTITY_ALREADY_LINKED',
        'IDENTITY_OWNED_BY_ANOTHER_USER',
        'PROVIDER_ALREADY_LINKED',
        'invalid_state',
      ].includes(message)
        ? message
        : 'oauth_failed';
      res.redirect(`${this.frontend()}${target}?error=${reason}`);
    }
  }
  @Get('me') @UseGuards(JwtAuthGuard) async me(@CurrentUser() user: User) {
    return { ...publicProfile(user), identities: await this.identities.list(user) };
  }
  @Post('logout') @HttpCode(204) logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, this.cookies());
  }
  private frontend() {
    return this.config.get('FRONTEND_URL', { infer: true });
  }
  private cookies(): CookieOptions {
    const production = this.config.get('NODE_ENV', { infer: true }) === 'production';
    return { httpOnly: true, secure: production, sameSite: production ? 'none' : 'lax', path: '/' };
  }
}
