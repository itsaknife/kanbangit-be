// Read-only live-DB boot check. Disable the background worker before app initialization.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../dist/app.module.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
const app = await NestFactory.create(AppModule, { logger: false });
try {
  app.get(ConfigService).set('SYNC_WORKER_ENABLED', false);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService);
  const member = await db.repositoryMember.findFirst({
    where: { isActive: true, userId: { not: null }, role: 'OWNER' },
    select: { repositoryId: true, userId: true },
  });
  assert.ok(member, 'An active owner is required');
  const token = await app.get(JwtService).signAsync({ sub: member.userId }, { expiresIn: '60s' });
  const root = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  const checks = [];
  async function get(path, authenticated = true) {
    const response = await fetch(root + path, {
      headers: authenticated ? { cookie: 'session=' + token } : {},
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, authenticated ? 200 : 401);
    checks.push({
      endpoint: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id'),
      status: response.status,
    });
    return response.json();
  }
  const queue = await get(`/repositories/${member.repositoryId}/sync/queue`);
  assert.ok(Array.isArray(queue.data));
  const issue = await db.issue.findFirst({
    where: { repoId: member.repositoryId },
    select: { id: true },
  });
  if (issue) {
    const info = await get(`/repositories/${member.repositoryId}/issues/${issue.id}/sync`);
    assert.equal(info.canRetry, true);
    assert.equal(typeof info.retryCount, 'number');
    assert.ok(!('accessToken' in info));
  }
  await get(`/repositories/${member.repositoryId}/sync/queue`, false);
  console.log(
    JSON.stringify({ applicationBoot: true, readOnly: true, workerDisabled: true, checks }),
  );
} finally {
  await app.close();
}
