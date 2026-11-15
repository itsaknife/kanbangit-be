import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Prisma, RepositoryMember, User } from '../generated/prisma/client.js';
import { CollaborationAccess } from '../collaboration/collaboration-access.service.js';
import { mentionUserIds, validateAttachment, type UploadFile } from './comment.rules.js';

const authorSelect = {
  id: true,
  login: true,
  avatarUrl: true,
  user: { select: { displayName: true, name: true, customAvatarUrl: true } },
} as const;
const attachmentSelect = {
  id: true,
  fileName: true,
  mimeType: true,
  fileSize: true,
  createdAt: true,
} as const;
const include = {
  author: { select: authorSelect },
  attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' as const } },
};
const storageRoot = join(process.cwd(), 'uploads', 'attachments');
@Injectable()
export class CommentsService {
  constructor(private readonly access: CollaborationAccess) {}
  list(user: User, repoId: string, issueId: string) {
    return this.access.transaction(user, repoId, async (tx, viewer) => {
      await this.access.issue(tx, repoId, issueId);
      const rows = await tx.comment.findMany({
        where: { issueId },
        include,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return { data: rows.map((row) => this.dto(row, viewer)) };
    });
  }
  private dto(
    row: Prisma.CommentGetPayload<{ include: typeof include }>,
    viewer: RepositoryMember,
  ) {
    return {
      id: row.id,
      issueId: row.issueId,
      authorId: row.authorId,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      author: {
        id: row.author.id,
        login: row.author.login,
        name: row.author.user?.displayName || row.author.user?.name || row.author.login,
        avatarUrl: row.author.user?.customAvatarUrl || row.author.avatarUrl,
      },
      attachments: row.attachments,
      canEdit: this.access.canManage(viewer, row.authorId),
      canDelete: this.access.canManage(viewer, row.authorId),
    };
  }
  create(user: User, repoId: string, issueId: string, content: string) {
    return this.access.transaction(user, repoId, async (tx, viewer) => {
      await this.access.issue(tx, repoId, issueId);
      this.validateContent(content);
      const row = await tx.comment.create({
        data: { issueId, authorId: viewer.id, content: content.trim() },
      });
      await this.mentions(tx, user, repoId, row.id, issueId, content);
      return this.dto(
        await tx.comment.findUniqueOrThrow({ where: { id: row.id }, include }),
        viewer,
      );
    });
  }
  update(user: User, repoId: string, id: string, content: string) {
    return this.access.transaction(user, repoId, async (tx, viewer) => {
      const old = await this.editable(tx, viewer, repoId, id);
      this.validateContent(content);
      const row = await tx.comment.update({
        where: { id },
        data: { content: content.trim() },
        include,
      });
      await this.mentions(tx, user, repoId, id, old.issueId, content);
      return this.dto(row, viewer);
    });
  }
  private validateContent(content: string) {
    if (!content.trim()) throw new BadRequestException('Bình luận không được để trống');
  }
  private async mentions(
    tx: Prisma.TransactionClient,
    actor: User,
    repoId: string,
    commentId: string,
    issueId: string,
    content: string,
  ) {
    const ids = mentionUserIds(content);
    if (!ids.length) return;
    const members = await tx.repositoryMember.findMany({
      where: { repositoryId: repoId, isActive: true, userId: { in: ids } },
    });
    if (ids.some((id) => !members.some((m) => m.userId === id)))
      throw new BadRequestException(
        'Người được nhắc phải có tài khoản đang hoạt động trong repository',
      );
    for (const userId of ids) {
      if (userId === actor.id) continue;
      // This ledger survives removal/re-addition of tokens in edited content.
      const delivered = await tx.commentMention.findUnique({
        where: { commentId_userId: { commentId, userId } },
      });
      if (delivered) continue;
      await tx.commentMention.create({ data: { commentId, userId } });
      await tx.notification.create({
        data: { userId, repositoryId: repoId, issueId, commentId, type: 'MENTION' },
      });
    }
  }
  private async editable(
    tx: Prisma.TransactionClient,
    viewer: RepositoryMember,
    repoId: string,
    id: string,
  ) {
    const row = await tx.comment.findFirst({ where: { id, issue: { repoId } } });
    if (!row) throw new NotFoundException('Không tìm thấy bình luận');
    if (!this.access.canManage(viewer, row.authorId))
      throw new ForbiddenException('Bạn không được sửa bình luận này');
    return row;
  }
  async remove(user: User, repoId: string, id: string) {
    const keys = await this.access.transaction(user, repoId, async (tx, viewer) => {
      await this.editable(tx, viewer, repoId, id);
      const files = await tx.attachment.findMany({
        where: { commentId: id },
        select: { storageKey: true },
      });
      await tx.comment.delete({ where: { id } });
      return files.map((f) => f.storageKey);
    });
    await Promise.all(keys.map((k) => this.removeStored(k)));
    return { id };
  }
  async upload(user: User, repoId: string, commentId: string, file?: UploadFile) {
    const metadata = validateAttachment(file);
    const storageKey = randomUUID();
    try {
      return await this.access.transaction(user, repoId, async (tx, viewer) => {
        await this.editable(tx, viewer, repoId, commentId);
        await mkdir(storageRoot, { recursive: true });
        await writeFile(join(storageRoot, storageKey), file!.buffer, { flag: 'wx' });
        return tx.attachment.create({
          data: { commentId, ...metadata, storageKey },
          select: attachmentSelect,
        });
      });
    } catch (error) {
      await this.removeStored(storageKey);
      throw error;
    }
  }
  async removeAttachment(user: User, repoId: string, id: string) {
    const key = await this.access.transaction(user, repoId, async (tx, viewer) => {
      const row = await tx.attachment.findFirst({ where: { id, comment: { issue: { repoId } } } });
      if (!row) throw new NotFoundException('Không tìm thấy tệp');
      await this.editable(tx, viewer, repoId, row.commentId);
      await tx.attachment.delete({ where: { id } });
      return row.storageKey;
    });
    await this.removeStored(key);
    return { id };
  }
  download(user: User, repoId: string, id: string) {
    return this.access.transaction(user, repoId, async (tx) => {
      const row = await tx.attachment.findFirst({ where: { id, comment: { issue: { repoId } } } });
      if (!row) throw new NotFoundException('Không tìm thấy tệp');
      try {
        return { ...row, buffer: await readFile(join(storageRoot, row.storageKey)) };
      } catch {
        throw new NotFoundException('Tệp không còn trong bộ lưu trữ');
      }
    });
  }
  private async removeStored(key: string) {
    try {
      await unlink(join(storageRoot, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('Không thể dọn tệp đính kèm đã bỏ tham chiếu');
    }
  }
}
