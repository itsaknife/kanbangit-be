/**
 * Kiểm thử tích hợp với database Postgres THẬT (có pgvector). Mặc định bị bỏ qua.
 * Chạy: TEST_DATABASE_URL=postgresql://... npm test -- integration
 * Cần tạo bảng trước (npm run db:push) và dùng database riêng cho test, vì test sẽ xóa dữ liệu.
 * GitHub và Gemini được thay bằng bản giả, nhưng mọi câu SQL (kể cả pgvector) chạy thật.
 */
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { DB_URL } = vi.hoisted(() => {
  const url = process.env.TEST_DATABASE_URL ?? '';
  Object.assign(process.env, {
    // Khi không có database test, test bị bỏ qua nhưng cấu hình vẫn phải hợp lệ để import được AppModule
    DATABASE_URL: url || 'postgresql://unused:unused@localhost:5432/unused',
    DATABASE_SSL: 'false',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_WEBHOOK_SECRET: 'whsec',
    JWT_SECRET: 'a-long-enough-secret',
    TOKEN_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    WEBHOOK_URL: 'https://smee.io/test',
    DUPLICATE_MIN_SIMILARITY: '0.5',
  });
  return { DB_URL: url };
});

import { AppModule } from './app.module.js';
import { EMBEDDING_DIMENSIONS, GeminiService } from './ai/gemini.service.js';
import { SessionService } from './auth/session.service.js';
import { encrypt } from './common/utils/crypto.js';
import { GithubService } from './github/github.service.js';
import type { GithubIssue, GithubRepo } from './github/github.types.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';

const owner: GithubRepo = {
  id: 100,
  name: 'app',
  owner: 'huy',
  fullName: 'huy/app',
  description: 'Repo thử nghiệm',
  isPrivate: false,
  openIssuesCount: 3,
  canManage: true,
};

const NOW = new Date();
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

const makeIssue = (
  number: number,
  title: string,
  extra: Partial<GithubIssue> = {},
): GithubIssue => ({
  id: 5_000_000_000 + number,
  number,
  title,
  body: null,
  state: 'open',
  labels: [],
  assignees: [],
  user: { login: 'lan', avatar_url: 'https://a/lan.png' },
  html_url: `https://github.com/huy/app/issues/${number}`,
  created_at: iso(3),
  updated_at: iso(1),
  closed_at: null,
  ...extra,
});

const githubIssues: GithubIssue[] = [
  makeIssue(1, 'Không đăng nhập được bằng GitHub', {
    body: 'Bấm nút đăng nhập GitHub thì trang báo lỗi',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{ login: 'huy', avatar_url: 'https://a/huy.png' }],
  }),
  makeIssue(2, 'Thêm biểu đồ thống kê theo tuần', {
    body: 'Dashboard cần biểu đồ số issue hoàn thành mỗi tuần',
    labels: [
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'in progress', color: 'fbca04' },
    ],
    assignees: [{ login: 'lan', avatar_url: 'https://a/lan.png' }],
  }),
  makeIssue(3, 'Sửa lỗi hiển thị avatar', {
    body: 'Avatar bị méo trên trang danh sách',
    state: 'closed',
    closed_at: iso(0),
    assignees: [{ login: 'huy', avatar_url: 'https://a/huy.png' }],
  }),
];

/** Embedding giả: băm từng từ vào 768 chiều, hai văn bản chung nhiều từ thì vector gần nhau. */
function fakeEmbed(text: string): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const word of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.codePointAt(0)!) % EMBEDDING_DIMENSIONS;
    vector[hash]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

describe.skipIf(!DB_URL)('tích hợp với database thật', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;

  const github = {
    listRepos: vi.fn(async () => [owner]),
    listIssues: vi.fn(async () => githubIssues),
    ensureLabels: vi.fn(async () => undefined),
    ensureWebhook: vi.fn(async () => 777),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
  };
  const gemini = {
    isConfigured: true,
    embed: vi.fn(async (texts: string[]) => texts.map(fakeEmbed)),
    generateJson: vi.fn(),
    generateText: vi.fn(
      async (_system: string, _prompt: string) => 'Tuần này nhóm hoàn thành 1 issue.',
    ),
  };
  const realtime = {
    emitIssueCreated: vi.fn(),
    emitIssueUpdated: vi.fn(),
    emitIssueDeleted: vi.fn(),
  };

  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Hết thời gian chờ');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GithubService)
      .useValue(github)
      .overrideProvider(GeminiService)
      .useValue(gemini)
      .overrideProvider(RealtimeGateway)
      .useValue(realtime)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    await prisma.weeklySummary.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.repository.deleteMany();
    await prisma.user.deleteMany();
    await prisma.user.create({
      data: {
        id: 1,
        login: 'huy',
        name: 'Huy',
        avatarUrl: 'https://a/huy.png',
        accessToken: encrypt('gho_fake', process.env.TOKEN_ENCRYPTION_KEY!),
      },
    });
    cookie = `session=${await app.get(SessionService).sign(1)}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const api = () => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer()).post(path).set('Cookie', cookie).send(body),
    patch: (path: string, body: object = {}) =>
      request(app.getHttpServer()).patch(path).set('Cookie', cookie).send(body),
  });

  it('chưa kết nối thì không xem được issue', async () => {
    expect((await api().get('/repositories/100/issues')).status).toBe(400);
  });

  it('owner kết nối repo: lưu repo, tạo nhãn, đăng ký webhook, lấy issue có sẵn', async () => {
    const res = await api().post('/repositories/100/connect');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 100,
      isConnected: true,
      openIssuesCount: 2,
      canManage: true,
    });
    expect(github.ensureLabels).toHaveBeenCalledOnce();
    expect(github.ensureWebhook).toHaveBeenCalledOnce();
    expect((await prisma.repository.findUnique({ where: { id: 100 } }))?.webhookId).toBe(777n);

    // kết nối lại không làm trùng issue
    await api().post('/repositories/100/connect');
    expect(await prisma.issue.count({ where: { repoId: 100 } })).toBe(3);
  });

  it('danh sách issue: đúng cột Kanban, nhãn trạng thái được ẩn khỏi danh sách nhãn', async () => {
    const res = await api().get('/repositories/100/issues');
    expect(res.status).toBe(200);
    expect(res.body.map((i: { number: number }) => i.number)).toEqual([3, 2, 1]);
    const byNumber = Object.fromEntries(res.body.map((i: { number: number }) => [i.number, i]));
    expect(byNumber[1]).toMatchObject({ status: 'todo', state: 'open' });
    expect(byNumber[2]).toMatchObject({
      status: 'in_progress',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
    });
    expect(byNumber[3]).toMatchObject({ status: 'done', state: 'closed' });
    expect(byNumber[1].author).toEqual({ login: 'lan', avatarUrl: 'https://a/lan.png' });
  });

  it('vector được tạo nền cho mọi issue sau khi kết nối', async () => {
    await waitFor(async () => {
      const rows = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM "Issue" WHERE embedding IS NOT NULL`;
      return Number(rows[0]?.n) === 3;
    });
  });

  it('phát hiện trùng: pgvector chọn ứng viên, LLM xác nhận, bỏ qua số issue LLM bịa ra', async () => {
    gemini.generateJson.mockResolvedValueOnce({
      duplicates: [
        { issueNumber: 1, reason: 'Cùng lỗi không đăng nhập được bằng GitHub.' },
        { issueNumber: 999, reason: 'Issue không tồn tại' },
      ],
    });
    const res = await api().post('/repositories/100/ai/duplicate-check', {
      title: 'Lỗi không đăng nhập được GitHub',
      body: 'Bấm đăng nhập GitHub thì báo lỗi',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      isDuplicate: true,
      candidates: [
        {
          issueNumber: 1,
          title: 'Không đăng nhập được bằng GitHub',
          reason: 'Cùng lỗi không đăng nhập được bằng GitHub.',
        },
      ],
    });
    // LLM chỉ được hỏi về ứng viên gần giống, và đọc nội dung chữ chứ không phải vector
    const prompt = gemini.generateJson.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('Issue #1');
    expect(prompt).toContain('Bấm nút đăng nhập GitHub thì trang báo lỗi');
  });

  it('phát hiện trùng: nội dung không liên quan thì không gọi LLM', async () => {
    gemini.generateJson.mockClear();
    const res = await api().post('/repositories/100/ai/duplicate-check', { title: 'zzz qqq xxx' });
    expect(res.body).toEqual({ isDuplicate: false, candidates: [] });
    expect(gemini.generateJson).not.toHaveBeenCalled();
  });

  it('dashboard: tổng quan, khối lượng từng thành viên, số issue xong trong tuần', async () => {
    const res = await api().get('/repositories/100/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalIssues: 3, todo: 1, inProgress: 1, done: 1 });
    expect(res.body.dailyClosed).toHaveLength(7);
    expect(res.body.members).toEqual(
      expect.arrayContaining([
        { login: 'huy', avatarUrl: 'https://a/huy.png', todo: 1, inProgress: 0, done: 1 },
        { login: 'lan', avatarUrl: 'https://a/lan.png', todo: 0, inProgress: 1, done: 0 },
      ]),
    );
    expect((await api().get('/repositories/100/dashboard?weekStart=abc')).status).toBe(400);
  });

  it('kéo thẻ sang Đang làm: gửi nhãn "in progress" lên GitHub, lưu và báo realtime', async () => {
    github.updateIssue.mockImplementationOnce(async (_u, _o, _r, number, payload) =>
      makeIssue(number, 'Không đăng nhập được bằng GitHub', {
        body: 'Bấm nút đăng nhập GitHub thì trang báo lỗi',
        updated_at: new Date().toISOString(),
        labels: (payload.labels as string[]).map((name) => ({ name, color: 'ededed' })),
      }),
    );
    const res = await api().patch('/repositories/100/issues/1/status', { status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(github.updateIssue.mock.calls[0]?.[4]).toMatchObject({
      state: 'open',
      labels: ['bug', 'in progress'],
    });
    expect(res.body.status).toBe('in_progress');
    expect(res.body.labels).toEqual([{ name: 'bug', color: 'ededed' }]);
    expect(realtime.emitIssueUpdated).toHaveBeenCalledTimes(1);
  });

  it('kéo thẻ sang Hoàn thành: đóng issue trên GitHub', async () => {
    github.updateIssue.mockImplementationOnce(async (_u, _o, _r, number, payload) =>
      makeIssue(number, 'Thêm biểu đồ thống kê theo tuần', {
        state: payload.state,
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        labels: (payload.labels as string[]).map((name) => ({ name, color: 'ededed' })),
      }),
    );
    const res = await api().patch('/repositories/100/issues/2/status', { status: 'done' });
    expect(github.updateIssue.mock.calls.at(-1)?.[4]).toMatchObject({
      state: 'closed',
      state_reason: 'completed',
      labels: ['enhancement'],
    });
    expect(res.body).toMatchObject({ status: 'done', state: 'closed' });
  });

  it('sửa tiêu đề: vector cũ bị xóa rồi tạo lại theo nội dung mới', async () => {
    github.updateIssue.mockImplementationOnce(async (_u, _o, _r, number, payload) =>
      makeIssue(number, payload.title as string, {
        state: 'closed',
        closed_at: iso(0),
        updated_at: new Date().toISOString(),
      }),
    );
    const res = await api().patch('/repositories/100/issues/3', {
      title: 'Avatar bị méo khi tải ảnh lớn',
    });
    expect(res.body.title).toBe('Avatar bị méo khi tải ảnh lớn');
    await waitFor(async () => {
      const rows = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM "Issue" WHERE number = 3 AND embedding IS NOT NULL`;
      return Number(rows[0]?.n) === 1;
    });
  });

  it('tạo issue mới trên app: tạo trên GitHub, lưu bản sao, báo realtime', async () => {
    github.createIssue.mockResolvedValueOnce(
      makeIssue(4, 'Issue mới', { labels: [{ name: 'task', color: '0e8a16' }] }),
    );
    const res = await api().post('/repositories/100/issues', {
      title: 'Issue mới',
      labels: ['task'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 4, status: 'todo' });
    expect(realtime.emitIssueCreated).toHaveBeenCalledTimes(1);
  });

  it('báo cáo tuần: owner tạo được, lưu lại và đọc được báo cáo gần nhất', async () => {
    expect((await api().get('/repositories/100/ai/weekly-summary')).status).toBe(404);
    const created = await api().post('/repositories/100/ai/weekly-summary', {});
    expect(created.status).toBe(201);
    expect(created.body.content).toBe('Tuần này nhóm hoàn thành 1 issue.');
    // dữ liệu thật của repo được đưa vào câu lệnh gửi LLM
    const prompt = gemini.generateText.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('Issue đã hoàn thành trong tuần');
    expect(prompt).toContain('#3');
    expect(prompt).toContain('#2');
    const latest = await api().get('/repositories/100/ai/weekly-summary');
    expect(latest.body.id).toBe(created.body.id);
  });
});
