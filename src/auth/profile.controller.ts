import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateProfileDto } from './profile.dto.js';

export function publicProfile(user: User) {
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    displayName: user.displayName,
    customAvatarUrl: user.customAvatarUrl,
  };
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('avatar', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  async upload(
    @CurrentUser() user: User,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
    @Body() dto: UpdateProfileDto,
  ) {
    if (!file) throw new BadRequestException('Vui lòng chọn ảnh avatar');
    const extension = avatarExtension(file.buffer);
    if (
      !extension ||
      file.mimetype !== { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[extension]
    )
      throw new BadRequestException('Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP hợp lệ');
    const directory = resolve('uploads/avatars');
    await mkdir(directory, { recursive: true });
    const filename = `${randomUUID()}.${extension}`;
    const path = resolve(directory, filename);
    await writeFile(path, file.buffer, { flag: 'wx' });
    try {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { displayName: dto.displayName, customAvatarUrl: `/avatars/${filename}` },
      });
      return publicProfile(updated);
    } catch (error) {
      await unlink(path);
      throw error;
    }
  }

  @Patch('me')
  async update(@CurrentUser() user: User, @Body() dto: UpdateProfileDto) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { displayName: dto.displayName, customAvatarUrl: dto.customAvatarUrl },
    });
    return publicProfile(updated);
  }
}

export function avatarExtension(buffer: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR'
  )
    return 'png';
  if (
    buffer.length >= 4 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255 &&
    buffer[buffer.length - 2] === 255 &&
    buffer[buffer.length - 1] === 217
  )
    return 'jpg';
  if (
    buffer.length >= 16 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

@Controller('avatars')
export class AvatarFilesController {
  @Get(':filename')
  get(@Param('filename') filename: string, @Res() res: Response) {
    if (!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(filename))
      throw new BadRequestException('Avatar không hợp lệ');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filename, { root: resolve('uploads/avatars') });
  }
}
