import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './profile.dto.js';
import { ProfileController } from './profile.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { User } from '../generated/prisma/client.js';

describe('KanbanGit display profile', () => {
  it('rejects missing or spoofed image uploads before writing a profile', async () => {
    const update = vi.fn();
    const controller = new ProfileController({ user: { update } } as unknown as PrismaService);
    await expect(controller.upload({ id: 'self' } as User, undefined, {})).rejects.toThrow(
      'chọn ảnh',
    );
    await expect(
      controller.upload(
        { id: 'self' } as User,
        { buffer: Buffer.from('<svg onload="alert(1)"/>'), mimetype: 'image/png' },
        {},
      ),
    ).rejects.toThrow('hợp lệ');
    expect(update).not.toHaveBeenCalled();
  });
  it('normalizes blank fields to null and rejects invalid names and avatar URLs', async () => {
    const blank = plainToInstance(UpdateProfileDto, { displayName: ' ', customAvatarUrl: '' });
    expect(await validate(blank)).toEqual([]);
    expect(blank).toMatchObject({ displayName: null, customAvatarUrl: null });
    for (const input of [
      { displayName: 'x'.repeat(81) },
      { customAvatarUrl: 'javascript:alert(1)' },
      { customAvatarUrl: 'http://example.com/avatar.png' },
    ]) {
      expect((await validate(plainToInstance(UpdateProfileDto, input))).length).toBeGreaterThan(0);
    }
  });

  it('updates only the authenticated user and exposes no secret or GitHub mutation', async () => {
    const update = vi.fn(async () => ({
      id: 'self',
      login: 'github-user',
      name: 'GitHub name',
      avatarUrl: 'https://example.com/github.png',
      displayName: 'Local name',
      customAvatarUrl: null,
      accessToken: 'secret',
    }));
    const controller = new ProfileController({ user: { update } } as unknown as PrismaService);
    const result = await controller.update({ id: 'self' } as User, {
      displayName: 'Local name',
      customAvatarUrl: null,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'self' },
      data: { displayName: 'Local name', customAvatarUrl: null },
    });
    expect(result).not.toHaveProperty('accessToken');
    expect(result.name).toBe('GitHub name');
  });
});
