import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AiModule } from './ai/ai.module.js';
import { AuthModule } from './auth/auth.module.js';
import { GithubExceptionFilter } from './common/filters/github-exception.filter.js';
import { validateEnv } from './config/env.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { HealthModule } from './health/health.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    RepositoriesModule,
    IssuesModule,
    DashboardModule,
    AiModule,
    RealtimeModule,
    WebhooksModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GithubExceptionFilter }],
})
export class AppModule { }
