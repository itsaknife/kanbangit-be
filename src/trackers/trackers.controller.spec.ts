import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TrackersController } from './trackers.controller.js';
import { TrackersService } from './trackers.service.js';
import { SessionService } from '../auth/session.service.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
const repoId = '10000000-0000-4000-8000-000000000100';
const trackerId = '10000000-0000-4000-8000-000000000200';
describe('M2 Tracker HTTP contract', () => {
  let app: INestApplication;
  const trackers = {
    list: vi.fn(async () => []),
    create: vi.fn(async (_user: unknown, _repo: unknown, dto: unknown) => dto),
    update: vi.fn(async (_user: unknown, _repo: unknown, _tracker: unknown, dto: unknown) => dto),
    setActive: vi.fn(async () => ({ isActive: false })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TrackersController],
      providers: [
        JwtAuthGuard,
        { provide: TrackersService, useValue: trackers },
        {
          provide: SessionService,
          useValue: {
            verify: vi.fn(async (token: string) =>
              token === 'valid' ? { id: 'user', githubId: 1n } : null,
            ),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('requires authentication', async () => {
    expect(
      (await request(app.getHttpServer()).get(`/repositories/${repoId}/trackers`)).status,
    ).toBe(401);
  });
  it('accepts validated create input and strips unsupported fields', async () => {
    const response = await request(app.getHttpServer())
      .post(`/repositories/${repoId}/trackers`)
      .set('Cookie', 'session=valid')
      .send({ name: ' Bug ', prefix: 'BUG', color: '#EF4444', nextSequence: 0 });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ name: 'Bug', prefix: 'BUG', color: '#EF4444' });
  });
  it('rejects invalid prefixes, colors, names and orders', async () => {
    for (const invalid of [
      { prefix: 'bad prefix' },
      { color: 'red' },
      { name: '  ' },
      { displayOrder: -1 },
      { displayOrder: null },
    ]) {
      const response = await request(app.getHttpServer())
        .post(`/repositories/${repoId}/trackers`)
        .set('Cookie', 'session=valid')
        .send({ name: 'Bug', prefix: 'BUG', color: '#123456', ...invalid });
      expect(response.status).toBe(400);
    }
  });
  it('rejects null optional edits instead of passing null to Prisma', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .patch(`/repositories/${repoId}/trackers/${trackerId}`)
          .set('Cookie', 'session=valid')
          .send({ color: null })
      ).status,
    ).toBe(400);
  });
  it('validates repository UUID and active boolean', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .get('/repositories/100/trackers')
          .set('Cookie', 'session=valid')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer())
          .patch(`/repositories/${repoId}/trackers/${trackerId}/active`)
          .set('Cookie', 'session=valid')
          .send({ isActive: 'false' })
      ).status,
    ).toBe(400);
  });
});
