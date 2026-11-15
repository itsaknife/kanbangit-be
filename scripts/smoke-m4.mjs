// Read-only smoke check of the built application against its configured database.
// Uses an ephemeral localhost port and a short-lived session, never prints credentials or issue content.
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
  // M5 adds an automatic worker; this historical smoke script must remain read-only.
  app.get(ConfigService).set('SYNC_WORKER_ENABLED', false);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const root = 'http://127.0.0.1:' + address.port;
  const db = app.get(PrismaService);
  const member = await db.repositoryMember.findFirst({
    where: { isActive: true, userId: { not: null }, role: 'OWNER' },
    select: { repositoryId: true, userId: true },
  });
  assert.ok(member, 'An existing active owner is needed for the read-only smoke check');
  const token = await app.get(JwtService).signAsync({ sub: member.userId }, { expiresIn: '60s' });
  const headers = { cookie: 'session=' + token };
  const checks = [];
  const get = async (path) => {
    const response = await fetch(root + path, { headers, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, path);
    checks.push({
      endpoint: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id'),
      status: response.status,
    });
    return response.json();
  };
  const logs = await get('/repositories/' + member.repositoryId + '/worklogs?period=week');
  assert.ok(Array.isArray(logs.data));
  assert.equal(logs.canManage, true);
  const notifications = await get('/notifications');
  assert.ok(Array.isArray(notifications.data));
  const issue = await db.issue.findFirst({
    where: { repoId: member.repositoryId },
    select: { id: true },
  });
  if (issue) {
    const comments = await get(
      '/repositories/' + member.repositoryId + '/issues/' + issue.id + '/comments',
    );
    assert.ok(Array.isArray(comments.data));
    const summary = await get(
      '/repositories/' + member.repositoryId + '/issues/' + issue.id + '/time-summary',
    );
    assert.equal(typeof summary.directOverEstimate, 'boolean');
  }
  const anonymous = await fetch(root + '/notifications', { signal: AbortSignal.timeout(5000) });
  assert.equal(anonymous.status, 401);
  process.stdout.write(
    JSON.stringify({
      applicationBoot: true,
      readOnly: true,
      checks,
      anonymousStatus: anonymous.status,
    }),
  );
} catch (error) {
  process.stderr.write('M4 smoke check failed: ' + (error.code ?? error.name) + '\n');
  process.exitCode = 1;
} finally {
  await app.close();
}
