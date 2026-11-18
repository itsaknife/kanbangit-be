import { createHash } from 'node:crypto';
export function oauthSessionHash(cookie: string | undefined): string {
  return cookie ? createHash('sha256').update(cookie).digest('hex') : '';
}
