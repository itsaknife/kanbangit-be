import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.js';

const key = randomBytes(32).toString('hex');

describe('encrypt / decrypt', () => {
  it('giải mã ra đúng nội dung ban đầu', () => {
    expect(decrypt(encrypt('gho_secret_token', key), key)).toBe('gho_secret_token');
  });

  it('mỗi lần mã hóa cho kết quả khác nhau', () => {
    expect(encrypt('abc', key)).not.toBe(encrypt('abc', key));
  });

  it('giải mã bằng khóa sai thì báo lỗi', () => {
    const encrypted = encrypt('abc', key);
    expect(() => decrypt(encrypted, randomBytes(32).toString('hex'))).toThrow();
  });
});
