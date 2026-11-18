import { Controller, Get, Post, Delete, Param, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { IdentityService } from './identity.service.js';
import { JwtService } from '@nestjs/jwt';
@Controller('users/me/identities')
@UseGuards(JwtAuthGuard)
export class IdentitiesController {
  constructor(
    private readonly identities: IdentityService,
    private readonly jwt: JwtService,
  ) {}
  @Get() list(@CurrentUser() user: User) {
    return this.identities.list(user);
  }
  @Post(':provider/link') async link(@CurrentUser() user: User, @Param('provider') value: string) {
    const provider = this.identities.provider(value);
    const state = await this.jwt.signAsync(
      { purpose: 'link', provider, userId: user.id, nonce: randomBytes(32).toString('hex') },
      { expiresIn: '10m' },
    );
    // The start endpoint binds this signed, session-specific request to an HttpOnly state cookie.
    return { url: `/auth/${provider.toLowerCase()}?link=${encodeURIComponent(state)}` };
  }
  @Delete(':provider') unlink(@CurrentUser() user: User, @Param('provider') value: string) {
    return this.identities.unlink(user, this.identities.provider(value));
  }
}
