import { describe, expect, it } from 'vitest';
import {
  MAX_RETRIES,
  RETRY_MS,
  retryDecision,
  syncBody,
  localIdFromBody,
  stripSyncMarker,
  syncFailure,
} from './sync.rules.js';
describe('M5 sync policy', () => {
  it('initial attempt plus five retries at exactly five-minute intervals', () => {
    const now = new Date('2020-01-01T00:00:00Z');
    for (let count = 0; count < MAX_RETRIES; count++)
      expect(retryDecision(count, true, now)).toEqual({
        status: 'RETRY_WAIT',
        nextRetryAt: new Date(now.getTime() + RETRY_MS),
      });
    expect(retryDecision(5, true, now)).toEqual({ status: 'FAILED', nextRetryAt: null });
    expect(retryDecision(0, false, now).status).toBe('FAILED');
  });
  it.each([401, 403, 404, 410, 422])(
    'HTTP %s is permanent and does not leak provider messages',
    (status) => {
      expect(
        syncFailure({ status, message: 'token=secret private body', request: { token: 'secret' } }),
      ).toMatchObject({ temporary: false });
      expect(syncFailure({ status, message: 'secret' }).message).not.toContain('secret');
    },
  );
  it.each([408, 429, 500, 502, 503, 504])('HTTP %s is temporary', (status) => {
    expect(syncFailure({ status }).temporary).toBe(true);
  });
  it('distinguishes primary/secondary rate limits from ordinary forbidden', () => {
    expect(
      syncFailure({ status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } })
        .temporary,
    ).toBe(true);
    expect(
      syncFailure({ status: 403, response: { headers: { 'retry-after': '60' } } }).temporary,
    ).toBe(true);
    expect(syncFailure(new Error('ECONNRESET secret')).temporary).toBe(true);
  });
  it('uses a stable hidden identity and removes it on inbound mapping without losing body whitespace', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const original = 'Text\n\n';
    const body = syncBody(original, id);
    expect(localIdFromBody(body)).toBe(id);
    expect(stripSyncMarker(body)).toBe(original);
    expect(syncBody(body, id)).toBe(body);
    expect(stripSyncMarker(null)).toBe(null);
  });
});
