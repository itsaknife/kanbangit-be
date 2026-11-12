import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { ActiveTrackerDto, CreateTrackerDto, UpdateTrackerDto } from './tracker.dto.js';
import { TrackersService } from './trackers.service.js';
@Controller('repositories/:repoId/trackers')
@UseGuards(JwtAuthGuard)
export class TrackersController {
  constructor(private readonly trackers: TrackersService) {}
  @Get() list(@CurrentUser() user: User, @Param('repoId', ParseUUIDPipe) repoId: string) {
    return this.trackers.list(user, repoId);
  }
  @Post() create(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() dto: CreateTrackerDto,
  ) {
    return this.trackers.create(user, repoId, dto);
  }
  @Patch(':trackerId') update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('trackerId', ParseUUIDPipe) trackerId: string,
    @Body() dto: UpdateTrackerDto,
  ) {
    return this.trackers.update(user, repoId, trackerId, dto);
  }
  @Patch(':trackerId/active') active(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('trackerId', ParseUUIDPipe) trackerId: string,
    @Body() dto: ActiveTrackerDto,
  ) {
    return this.trackers.setActive(user, repoId, trackerId, dto.isActive);
  }
}
