import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AiController } from './ai.controller.js';
import { DuplicateService } from './duplicate.service.js';
import { EmbeddingService } from './embedding.service.js';
import { GeminiService } from './gemini.service.js';
import { WeeklySummaryService } from './weekly-summary.service.js';

@Module({
  imports: [AuthModule, AccessModule],
  controllers: [AiController],
  providers: [GeminiService, EmbeddingService, DuplicateService, WeeklySummaryService],
  exports: [EmbeddingService],
})
export class AiModule {}
