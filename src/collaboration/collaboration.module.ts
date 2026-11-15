import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { CollaborationChangeInterceptor } from './collaboration-change.interceptor.js';
import { CollaborationAccess } from './collaboration-access.service.js';
import { WorklogsService } from '../worklogs/worklogs.service.js';
import { WorklogsController } from '../worklogs/worklogs.controller.js';
import { CommentsService } from '../comments/comments.service.js';
import { CommentsController } from '../comments/comments.controller.js';
import { NotificationsController } from '../notifications/notifications.controller.js';
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [WorklogsController, CommentsController, NotificationsController],
  providers: [
    CollaborationAccess,
    WorklogsService,
    CommentsService,
    CollaborationChangeInterceptor,
  ],
})
export class CollaborationModule {}
