import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GithubModule } from '../github/github.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncWorker } from './sync.worker.js';
@Module({
  imports: [AccessModule, AuthModule, GithubModule, RealtimeModule],
  controllers: [SyncController],
  providers: [SyncService, SyncWorker],
})
export class SyncModule {}
