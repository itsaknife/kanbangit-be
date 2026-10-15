/** Tên sự kiện Socket.io, phải khớp với frontend (src/constants/socket-events.ts). */
export const SOCKET_EVENTS = {
  subscribeRepo: 'repo:subscribe',
  unsubscribeRepo: 'repo:unsubscribe',
  issueCreated: 'issue:created',
  issueUpdated: 'issue:updated',
  issueDeleted: 'issue:deleted',
} as const;

export const repoRoom = (repoId: number) => `repo:${repoId}`;
