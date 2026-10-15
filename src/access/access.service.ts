import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Repository, User } from '../generated/prisma/client.js';
import { GithubService } from '../github/github.service.js';
import type { GithubRepo } from '../github/github.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RepoAccess {
  github: GithubRepo;
  /** Bản ghi repository trong database, chỉ có khi đã kết nối. */
  connected: Repository | null;
}

/** Kiểm tra người dùng có quyền gì trên một repository. Quyền lấy từ GitHub, không có bảng phân quyền riêng. */
@Injectable()
export class AccessService {
  constructor(
    private readonly github: GithubService,
    private readonly prisma: PrismaService,
  ) {}

  /** Người dùng phải có quyền truy cập repository trên GitHub (không cần đã kết nối). */
  async requireAccess(user: User, repoId: number): Promise<RepoAccess> {
    let github = (await this.github.listRepos(user)).find((repo) => repo.id === repoId);
    // Có thể danh sách lưu tạm đã cũ (vừa được mời vào repo), thử lấy mới một lần
    if (!github)
      github = (await this.github.listRepos(user, true)).find((repo) => repo.id === repoId);
    if (!github)
      throw new NotFoundException('Không tìm thấy repository hoặc bạn không có quyền truy cập');

    const connected = await this.prisma.repository.findUnique({ where: { id: repoId } });
    return { github, connected };
  }

  /** Thành viên của repository đã được kết nối vào hệ thống. */
  async requireMember(user: User, repoId: number): Promise<RepoAccess & { connected: Repository }> {
    const access = await this.requireAccess(user, repoId);
    if (!access.connected) {
      throw new BadRequestException('Repository chưa được kết nối. Hãy nhờ owner kết nối trước.');
    }
    return { ...access, connected: access.connected };
  }

  /** Chỉ owner (người có quyền admin trên repository GitHub). */
  async requireOwner(user: User, repoId: number): Promise<RepoAccess> {
    const access = await this.requireAccess(user, repoId);
    if (!access.github.canManage) {
      throw new ForbiddenException(
        'Chỉ owner (admin của repository trên GitHub) mới được thực hiện thao tác này',
      );
    }
    return access;
  }

  /** Giống requireMember nhưng chỉ owner mới qua được. */
  async requireConnectedOwner(
    user: User,
    repoId: number,
  ): Promise<RepoAccess & { connected: Repository }> {
    const access = await this.requireMember(user, repoId);
    if (!access.github.canManage) {
      throw new ForbiddenException(
        'Chỉ owner (admin của repository trên GitHub) mới được thực hiện thao tác này',
      );
    }
    return access;
  }
}
