import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GithubModule } from '../github/github.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';

@Module({
  imports: [AuthModule, AccessModule, GithubModule, RealtimeModule, AiModule],
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
