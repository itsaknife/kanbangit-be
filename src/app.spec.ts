import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RequestError } from 'octokit';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module.js';
import { SessionService } from './auth/session.service.js';
import { encrypt } from './common/utils/crypto.js';
import { IssueState, IssueStatus } from './generated/prisma/client.js';
import { GithubService } from './github/github.service.js';
import type { GithubRepo } from './github/github.types.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';

// ConfigModule đọc biến môi trường ngay khi import AppModule, nên phải đặt trước (hoisted)
const { WEBHOOK_SECRET, ENCRYPTION_KEY } = vi.hoisted(() => {
  const secrets = {
    WEBHOOK_SECRET: 'test-webhook-secret',
    ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
  };
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_WEBHOOK_SECRET: secrets.WEBHOOK_SECRET,
    JWT_SECRET: 'a-long-enough-secret',
    TOKEN_ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
    WEBHOOK_URL: 'https://smee.io/test',
  });
  return secrets;
});

const user = {
  id: 1,
  login: 'huy',
  name: 'Huy',
  avatarUrl: 'https://a/huy.png',
  accessToken: encrypt('gho_fake', ENCRYPTION_KEY),
};

const repoAsMember: GithubRepo = {
  id: 100,
  name: 'app',
  owner: 'huy',
  fullName: 'huy/app',
  description: null,
  isPrivate: false,
  openIssuesCount: 0,
  canManage: false,
};

/** Database giả lưu trong bộ nhớ, đủ cho các thao tác mà test cần. */
function createFakePrisma() {
  const issues = new Map<string, Record<string, any>>();
  const key = (repoId: number, number: number) => `${repoId}#${number}`;
  return {
    user: { findUnique: vi.fn(async () => user) },
    repository: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === 100 ? { id: 100, owner: 'huy', name: 'app', fullName: 'huy/app' } : null,
      ),
      findMany: vi.fn(async () => [{ id: 100 }]),
    },
    issue: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          issues.get(key(where.repoId_number.repoId, where.repoId_number.number)) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const k = key(where.repoId_number.repoId, where.repoId_number.number);
        const saved = { id: issues.size + 1, ...(issues.get(k) ?? create), ...update };
        issues.set(k, saved);
        return saved;
      }),
      deleteMany: vi.fn(async ({ where }: any) => ({
        count: issues.delete(key(where.repoId, where.number)) ? 1 : 0,
      })),
      groupBy: vi.fn(async () => [{ repoId: 100, _count: { _all: 2 } }]),
    },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
  };
}

function githubIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 3_000_000_001,
    number: 5,
    title: 'Lỗi đăng nhập',
    body: 'mô tả',
    state: 'open',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [],
    user: { login: 'lan', avatar_url: 'https://a/lan.png' },
    html_url: 'https://github.com/huy/app/issues/5',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

describe('ứng dụng', () => {
  let app: INestApplication;
  let cookie: string;
  let prisma: ReturnType<typeof createFakePrisma>;
  const realtime = {
    emitIssueCreated: vi.fn(),
    emitIssueUpdated: vi.fn(),
    emitIssueDeleted: vi.fn(),
  };
  const github = { listRepos: vi.fn(async () => [repoAsMember]) };

  beforeAll(async () => {
    prisma = createFakePrisma();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(GithubService)
      .useValue(github)
      .overrideProvider(RealtimeGateway)
      .useValue(realtime)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    cookie = `session=${await app.get(SessionService).sign(user.id)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    github.listRepos.mockResolvedValue([repoAsMember]);
  });

  describe('đăng nhập', () => {
    it('từ chối khi chưa đăng nhập', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Chưa đăng nhập');
    });

    it('trả thông tin người dùng khi đã đăng nhập, không lộ token', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 1,
        login: 'huy',
        name: 'Huy',
        avatarUrl: 'https://a/huy.png',
      });
    });

    it('chuyển hướng sang GitHub kèm state và đặt cookie chống giả mạo', async () => {
      const res = await request(app.getHttpServer()).get('/auth/github');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('https://github.com/login/oauth/authorize');
      expect(res.headers.location).toContain('scope=repo+read%3Auser');
      expect(res.headers['set-cookie']?.[0]).toContain('oauth_state=');
    });

    it('callback có state sai thì quay về trang login, không đăng nhập', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/github/callback?code=abc&state=sai')
        .set('Cookie', 'oauth_state=dung');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=invalid_state');
    });
  });

  describe('phân quyền owner', () => {
    it('danh sách repo cho biết người dùng có phải owner không', async () => {
      const res = await request(app.getHttpServer()).get('/repositories').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({
        id: 100,
        isConnected: true,
        openIssuesCount: 2,
        canManage: false,
      });
    });

    it('thành viên thường không được kết nối repo', async () => {
      const res = await request(app.getHttpServer())
        .post('/repositories/100/connect')
        .set('Cookie', cookie);
      expect(res.status).toBe(403);
    });

    it('thành viên thường không được tạo báo cáo AI', async () => {
      const res = await request(app.getHttpServer())
        .post('/repositories/100/ai/weekly-summary')
        .set('Cookie', cookie)
        .send({});
      expect(res.status).toBe(403);
    });

    it('không thấy repo của người khác', async () => {
      const res = await request(app.getHttpServer())
        .get('/repositories/999/issues')
        .set('Cookie', cookie);
      expect(res.status).toBe(404);
    });
  });

  describe('lỗi từ GitHub', () => {
    const githubError = (status: number, message: string) =>
      new RequestError(message, status, {
        request: { method: 'GET', url: 'https://api.github.com/user/repos', headers: {} },
        response: { status, url: '', headers: {}, data: { message } },
      });

    it('token GitHub hết hạn thì trả 401 với thông báo dễ hiểu (không phải 500)', async () => {
      github.listRepos.mockRejectedValueOnce(githubError(401, 'Bad credentials'));
      const res = await request(app.getHttpServer()).get('/repositories').set('Cookie', cookie);
      expect(res.status).toBe(401);
      expect(res.body.message).toContain('đăng nhập lại');
    });

    it('hết giới hạn gọi GitHub thì trả 429', async () => {
      github.listRepos.mockRejectedValueOnce(githubError(403, 'API rate limit exceeded'));
      const res = await request(app.getHttpServer()).get('/repositories').set('Cookie', cookie);
      expect(res.status).toBe(429);
    });
  });

  describe('kiểm tra dữ liệu gửi lên', () => {
    it('từ chối tiêu đề rỗng khi tạo issue', async () => {
      const res = await request(app.getHttpServer())
        .post('/repositories/100/issues')
        .set('Cookie', cookie)
        .send({ title: '' });
      expect(res.status).toBe(400);
    });

    it('từ chối trạng thái không hợp lệ khi kéo thẻ', async () => {
      const res = await request(app.getHttpServer())
        .patch('/repositories/100/issues/5/status')
        .set('Cookie', cookie)
        .send({ status: 'xong' });
      expect(res.status).toBe(400);
    });
  });

  describe('webhook từ GitHub', () => {
    const post = (event: string, payload: object, secret = WEBHOOK_SECRET) => {
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      return request(app.getHttpServer())
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', event)
        .set('X-Hub-Signature-256', signature)
        .send(body);
    };

    it('từ chối khi chữ ký sai', async () => {
      const res = await post('issues', { action: 'opened' }, 'secret-gia-mao');
      expect(res.status).toBe(401);
    });

    it('chấp nhận sự kiện ping', async () => {
      expect((await post('ping', { zen: 'ok' })).status).toBe(200);
    });

    it('issue mới: lưu và báo realtime; webhook lặp lại y hệt thì không báo lại', async () => {
      const payload = { action: 'opened', issue: githubIssue(), repository: { id: 100 } };

      expect((await post('issues', payload)).status).toBe(200);
      expect(realtime.emitIssueCreated).toHaveBeenCalledTimes(1);
      expect(realtime.emitIssueCreated.mock.calls[0]?.[1]).toMatchObject({
        number: 5,
        status: IssueStatus.todo,
      });

      expect((await post('issues', payload)).status).toBe(200);
      expect(realtime.emitIssueCreated).toHaveBeenCalledTimes(1);
      expect(realtime.emitIssueUpdated).not.toHaveBeenCalled();
    });

    it('đóng issue trên GitHub: chuyển sang cột Hoàn thành và báo realtime', async () => {
      const closed = githubIssue({
        state: 'closed',
        closed_at: '2026-10-03T00:00:00Z',
        updated_at: '2026-10-03T00:00:00Z',
      });
      await post('issues', { action: 'closed', issue: closed, repository: { id: 100 } });
      expect(realtime.emitIssueUpdated).toHaveBeenCalledTimes(1);
      expect(realtime.emitIssueUpdated.mock.calls[0]?.[1]).toMatchObject({
        state: IssueState.closed,
        status: IssueStatus.done,
      });
    });

    it('webhook đến muộn (cũ hơn dữ liệu đang lưu) thì bị bỏ qua', async () => {
      const stale = githubIssue({ title: 'Tiêu đề cũ', updated_at: '2026-10-01T12:00:00Z' });
      await post('issues', { action: 'edited', issue: stale, repository: { id: 100 } });
      expect(realtime.emitIssueUpdated).not.toHaveBeenCalled();
    });

    it('xóa issue: báo realtime', async () => {
      await post('issues', { action: 'deleted', issue: githubIssue(), repository: { id: 100 } });
      expect(realtime.emitIssueDeleted).toHaveBeenCalledWith(100, 5);
    });

    it('bỏ qua repository chưa kết nối', async () => {
      const res = await post('issues', {
        action: 'opened',
        issue: githubIssue({ number: 9 }),
        repository: { id: 555 },
      });
      expect(res.status).toBe(200);
      expect(realtime.emitIssueCreated).not.toHaveBeenCalled();
    });
  });
});
