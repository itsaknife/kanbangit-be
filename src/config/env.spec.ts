import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
  GITHUB_WEBHOOK_SECRET: 'whsec',
  JWT_SECRET: 'a-long-enough-secret',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  WEBHOOK_URL: 'https://smee.io/abc',
};

describe('validateEnv', () => {
  it('điền giá trị mặc định cho biến không bắt buộc', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.FRONTEND_URL).toBe('http://localhost:3000');
    expect(env.TZ_OFFSET_MINUTES).toBe(420);
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it('báo lỗi rõ ràng khi thiếu biến bắt buộc', () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow('DATABASE_URL');
  });

  it('từ chối khóa mã hóa sai độ dài', () => {
    expect(() => validateEnv({ ...valid, TOKEN_ENCRYPTION_KEY: 'abc' })).toThrow(
      'TOKEN_ENCRYPTION_KEY',
    );
  });

  it('bỏ dấu / ở cuối địa chỉ', () => {
    expect(validateEnv({ ...valid, FRONTEND_URL: 'http://localhost:3000/' }).FRONTEND_URL).toBe(
      'http://localhost:3000',
    );
  });
});
