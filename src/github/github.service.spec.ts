import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { GithubService } from './github.service.js';
import type { User } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';

describe('GitHub personal integration requests', () => {
  function fixture() {
    const createForAuthenticatedUser = vi.fn(async () => ({
      data: {
        id: 100,
        name: 'app',
        owner: { login: 'owner', type: 'User' },
        full_name: 'owner/app',
        description: null,
        private: true,
        open_issues_count: 0,
      },
    }));
    const listForAuthenticatedUser = vi.fn();
    const listCollaborators = vi.fn();
    const getByUsername = vi.fn(async () => ({
      data: { id: 1, login: 'owner', avatar_url: 'owner-avatar' },
    }));
    const paginate = vi.fn(async () => []);
    const client = {
      rest: {
        repos: { createForAuthenticatedUser, listForAuthenticatedUser, listCollaborators },
        users: { getByUsername },
      },
      paginate,
    };
    const service = new GithubService(new ConfigService({}) as ConfigService<Env, true>);
    vi.spyOn(service, 'client').mockReturnValue(
      client as unknown as ReturnType<GithubService['client']>,
    );
    return {
      service,
      createForAuthenticatedUser,
      listForAuthenticatedUser,
      paginate,
      getByUsername,
    };
  }
  it('uses personal creation API with explicit visibility and invalidates cached discovery', async () => {
    const f = fixture();
    const user = { id: '10000000-0000-4000-8000-000000000001' } as User;
    await f.service.listRepos(user);
    await f.service.createPersonalRepo(user, {
      name: 'app',
      description: 'demo',
      visibility: 'PRIVATE',
    });
    expect(f.createForAuthenticatedUser).toHaveBeenCalledWith({
      name: 'app',
      description: 'demo',
      private: true,
      has_issues: true,
    });
    await f.service.listRepos(user);
    expect(f.paginate).toHaveBeenCalledTimes(2);
    await f.service.createPersonalRepo(user, { name: 'app', visibility: 'PUBLIC' });
    expect(f.createForAuthenticatedUser).toHaveBeenLastCalledWith({
      name: 'app',
      description: undefined,
      private: false,
      has_issues: true,
    });
  });
  it('includes the personal owner even if collaborator listing omits them', async () => {
    const f = fixture();
    const result = await f.service.listMembers(
      { id: '10000000-0000-4000-8000-000000000001' } as User,
      'owner',
      'app',
    );
    expect(result).toEqual([
      { githubUserId: 1n, login: 'owner', avatarUrl: 'owner-avatar', githubPermission: 'ADMIN' },
    ]);
    expect(f.getByUsername).toHaveBeenCalledWith({ username: 'owner' });
  });
});
