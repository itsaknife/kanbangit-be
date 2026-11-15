import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CollaborationChangeInterceptor } from '../collaboration/collaboration-change.interceptor.js';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { CommentsService } from './comments.service.js';
import { CommentDto } from './comment.dto.js';
import { MAX_ATTACHMENT_BYTES, type UploadFile } from './comment.rules.js';
@Controller('repositories/:repoId')
@UseGuards(JwtAuthGuard)
@UseInterceptors(CollaborationChangeInterceptor)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}
  @Get('issues/:issueId/comments') list(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
  ) {
    return this.comments.list(user, repoId, id);
  }
  @Post('issues/:issueId/comments') create(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('issueId', ParseUUIDPipe) id: string,
    @Body() dto: CommentDto,
  ) {
    return this.comments.create(user, repoId, id, dto.content);
  }
  @Patch('comments/:id') update(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommentDto,
  ) {
    return this.comments.update(user, repoId, id, dto.content);
  }
  @Delete('comments/:id') remove(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.comments.remove(user, repoId, id);
  }
  @Post('comments/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }),
  )
  upload(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: UploadFile,
  ) {
    return this.comments.upload(user, repoId, id, file);
  }
  @Delete('attachments/:id') removeFile(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.comments.removeAttachment(user, repoId, id);
  }
  @Get('attachments/:id')
  async download(
    @CurrentUser() user: User,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.comments.download(user, repoId, id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/'/g, '%27')}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.buffer);
  }
}
