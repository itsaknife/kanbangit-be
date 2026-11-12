import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import type { CreateTrackerDto, UpdateTrackerDto } from './tracker.dto.js';

function conflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
    throw new ConflictException({
      code: 'RESOURCE_CONFLICT',
      message: 'Tên hoặc prefix Tracker đã được sử dụng trong repository',
    });
  throw error;
}
@Injectable()
export class TrackersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}
  async list(user: User, repoId: string) {
    await this.access.requireMember(user, repoId);
    return this.prisma.tracker.findMany({
      where: { repositoryId: repoId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  async create(user: User, repoId: string, dto: CreateTrackerDto) {
    try {
      return await this.access.ownerTransaction(user, repoId, async (tx) => {
        const tracker = await tx.tracker.create({ data: { repositoryId: repoId, ...dto } });
        await this.reserve(tx, repoId, tracker.id, tracker.prefix);
        return tracker;
      });
    } catch (error) {
      return conflict(error);
    }
  }
  async update(user: User, repoId: string, trackerId: string, dto: UpdateTrackerDto) {
    try {
      return await this.access.ownerTransaction(user, repoId, async (tx) => {
        const tracker = await tx.tracker.findFirst({
          where: { id: trackerId, repositoryId: repoId },
        });
        if (!tracker) throw new NotFoundException('Không tìm thấy Tracker trong repository');
        if (dto.prefix) await this.reserve(tx, repoId, trackerId, dto.prefix);
        return tx.tracker.update({ where: { id: trackerId }, data: dto });
      });
    } catch (error) {
      return conflict(error);
    }
  }
  async setActive(user: User, repoId: string, trackerId: string, isActive: boolean) {
    return this.access.ownerTransaction(user, repoId, async (tx) => {
      const tracker = await tx.tracker.findFirst({
        where: { id: trackerId, repositoryId: repoId },
      });
      if (!tracker) throw new NotFoundException('Không tìm thấy Tracker trong repository');
      return tx.tracker.update({ where: { id: trackerId }, data: { isActive } });
    });
  }
  private async reserve(
    tx: Prisma.TransactionClient,
    repoId: string,
    trackerId: string,
    prefix: string,
  ) {
    const reserved = await tx.trackerPrefix.findUnique({
      where: { repositoryId_prefix: { repositoryId: repoId, prefix } },
    });
    if (reserved && reserved.trackerId !== trackerId)
      throw new ConflictException({
        code: 'RESOURCE_CONFLICT',
        message: 'Prefix đã thuộc về Tracker khác, kể cả prefix cũ',
      });
    if (!reserved)
      await tx.trackerPrefix.create({ data: { repositoryId: repoId, trackerId, prefix } });
  }
}

// Call inside the same transaction that creates the Issue. The UPDATE locks the
// tracker row until commit, serializing sequence allocation and prefix changes.
export async function allocateIssueCode(
  tx: Prisma.TransactionClient,
  repoId: string,
  trackerId?: string,
) {
  const tracker = trackerId
    ? await tx.tracker.findFirst({ where: { id: trackerId, repositoryId: repoId, isActive: true } })
    : await tx.tracker.findFirst({
        where: { repositoryId: repoId, isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
  if (!tracker)
    throw new BadRequestException({
      code: 'TRACKER_INACTIVE',
      message: 'Cần chọn Tracker hoạt động trong repository. Hãy nhờ Owner kích hoạt Tracker.',
    });
  const result = await tx.tracker.updateMany({
    where: { id: tracker.id, repositoryId: repoId, isActive: true },
    data: { nextSequence: { increment: 1 } },
  });
  if (result.count !== 1)
    throw new BadRequestException({
      code: 'TRACKER_INACTIVE',
      message: 'Tracker đã bị vô hiệu hóa',
    });
  const current = await tx.tracker.findUniqueOrThrow({ where: { id: tracker.id } });
  return {
    trackerId: current.id,
    issueCode: `${current.prefix}-${String(current.nextSequence - 1).padStart(3, '0')}`,
  };
}
