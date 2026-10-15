import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module.js';
import { AccessService } from './access.service.js';

@Module({
  imports: [GithubModule],
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
