import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AccessService } from '../access/access.service.js';
import { SessionService } from '../auth/session.service.js';
import { repoRoom, SOCKET_EVENTS } from '../common/constants/socket-events.js';
import type { IssueDto } from '../common/types/issue.dto.js';
import { SESSION_COOKIE } from '../common/types/request.js';
import type { User } from '../generated/prisma/client.js';

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * Đẩy thay đổi issue xuống các trình duyệt đang mở.
 * Mỗi repository là một "phòng" (room); chỉ người có quyền với repository mới vào được phòng.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly session: SessionService,
    private readonly access: AccessService,
  ) {}

  /** Chặn kết nối của người chưa đăng nhập (đọc cookie phiên giống như HTTP). */
  afterInit(server: Server): void {
    server.use(async (socket, next) => {
      const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      const user = await this.session.verify(token);
      if (!user) return next(new Error('Chưa đăng nhập'));
      socket.data.user = user;
      next();
    });
  }

  @SubscribeMessage(SOCKET_EVENTS.subscribeRepo)
  async subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() repoId: unknown,
  ): Promise<void> {
    if (typeof repoId !== 'number') return;
    try {
      await this.access.requireMember(client.data.user as User, repoId);
      await client.join(repoRoom(repoId));
    } catch (error) {
      this.logger.debug(`Từ chối vào phòng repo ${repoId}: ${(error as Error).message}`);
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.unsubscribeRepo)
  async unsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() repoId: unknown,
  ): Promise<void> {
    if (typeof repoId !== 'number') return;
    await client.leave(repoRoom(repoId));
  }

  emitIssueCreated(repoId: number, issue: IssueDto): void {
    this.server.to(repoRoom(repoId)).emit(SOCKET_EVENTS.issueCreated, { repoId, issue });
  }

  emitIssueUpdated(repoId: number, issue: IssueDto): void {
    this.server.to(repoRoom(repoId)).emit(SOCKET_EVENTS.issueUpdated, { repoId, issue });
  }

  emitIssueDeleted(repoId: number, number: number): void {
    this.server.to(repoRoom(repoId)).emit(SOCKET_EVENTS.issueDeleted, { repoId, number });
  }
}
