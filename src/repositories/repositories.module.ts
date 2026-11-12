import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GithubModule } from '../github/github.module.js';
import { IssuesModule } from '../issues/issues.module.js';
import { RepositoriesController } from './repositories.controller.js';
import { RepositoriesService } from './repositories.service.js';
import { MembersService } from './members.service.js';
import { RealtimeModule } from '../realtime/realtime.module.js';

@Module({
  imports: [AuthModule, AccessModule, GithubModule, IssuesModule, RealtimeModule],
  controllers: [RepositoriesController],
  providers: [RepositoriesService, MembersService],
})
export class RepositoriesModule {}
