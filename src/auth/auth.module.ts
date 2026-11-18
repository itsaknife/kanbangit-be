import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { ProjectAuthController } from './project-auth.controller.js';
import { IdentityService } from './identity.service.js';
import { IdentitiesController } from './identities.controller.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { GithubModule } from '../github/github.module.js';
import { AvatarFilesController, ProfileController } from './profile.controller.js';

@Module({
  imports: [
    GithubModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [ProjectAuthController, IdentitiesController, ProfileController, AvatarFilesController],
  providers: [IdentityService, AuthService, SessionService, JwtAuthGuard],
  exports: [SessionService, JwtAuthGuard],
})
export class AuthModule {}
