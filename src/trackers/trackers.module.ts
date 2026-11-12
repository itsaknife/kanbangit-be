import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessModule } from '../access/access.module.js';
import { TrackersController } from './trackers.controller.js';
import { TrackersService } from './trackers.service.js';
@Module({
  imports: [AuthModule, AccessModule],
  controllers: [TrackersController],
  providers: [TrackersService],
})
export class TrackersModule {}
