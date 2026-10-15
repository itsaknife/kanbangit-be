import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessService } from '../access/access.service.js';
import { SessionService } from '../auth/session.service.js';
import { SOCKET_EVENTS } from '../common/constants/socket-events.js';
import type { IssueDto } from '../common/types/issue.dto.js';
import { CorsIoAdapter } from './cors-io.adapter.js';
import { RealtimeGateway } from './realtime.gateway.js';

const issue: IssueDto = {
  id: 1,
  number: 5,
  title: 'Lỗi',
  body: null,
  state: 'open',
  status: 'todo',
  labels: [],
  assignees: [],
  author: null,
  htmlUrl: 'https://github.com/o/r/issues/5',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
};

const user = { id: 1, login: 'huy' };

describe('RealtimeGateway', () => {
  let app: INestApplication;
  let gateway: RealtimeGateway;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        // Chỉ token "valid" mới là người dùng hợp lệ
        {
          provide: SessionService,
          useValue: { verify: vi.fn(async (t?: string) => (t === 'valid' ? user : null)) },
        },
        // Người dùng chỉ là thành viên của repo 100
        {
          provide: AccessService,
          useValue: {
            requireMember: vi.fn(async (_u: unknown, repoId: number) => {
              if (repoId !== 100) throw new Error('không có quyền');
            }),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new CorsIoAdapter(app, 'http://localhost:3000'));
    await app.listen(0);
    gateway = app.get(RealtimeGateway);
    url = `http://localhost:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.close());
    await app.close();
  });

  const open = (cookie?: string) => {
    const socket = connect(url, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: cookie ? { cookie } : undefined,
    });
    sockets.push(socket);
    return socket;
  };

  const once = <T>(socket: Socket, event: string) =>
    new Promise<T>((resolve) => socket.once(event, resolve));

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('từ chối kết nối khi chưa đăng nhập', async () => {
    const socket = open();
    const error = await once<Error>(socket, 'connect_error');
    expect(error.message).toBe('Chưa đăng nhập');
  });

  it('thành viên vào phòng repo thì nhận được issue mới, đổi, xóa', async () => {
    const socket = open('session=valid');
    await once(socket, 'connect');
    socket.emit(SOCKET_EVENTS.subscribeRepo, 100);
    await wait(100);

    const created = once<{ repoId: number; issue: IssueDto }>(socket, SOCKET_EVENTS.issueCreated);
    gateway.emitIssueCreated(100, issue);
    expect(await created).toEqual({ repoId: 100, issue });

    const deleted = once(socket, SOCKET_EVENTS.issueDeleted);
    gateway.emitIssueDeleted(100, 5);
    expect(await deleted).toEqual({ repoId: 100, number: 5 });
  });

  it('không nhận dữ liệu của repo mình không có quyền, và ngừng nhận sau khi rời phòng', async () => {
    const socket = open('session=valid');
    await once(socket, 'connect');
    const received = vi.fn();
    socket.on(SOCKET_EVENTS.issueUpdated, received);

    socket.emit(SOCKET_EVENTS.subscribeRepo, 999); // không có quyền
    await wait(100);
    gateway.emitIssueUpdated(999, issue);

    socket.emit(SOCKET_EVENTS.subscribeRepo, 100);
    await wait(100);
    socket.emit(SOCKET_EVENTS.unsubscribeRepo, 100); // rời phòng
    await wait(100);
    gateway.emitIssueUpdated(100, issue);

    await wait(150);
    expect(received).not.toHaveBeenCalled();
  });
});
