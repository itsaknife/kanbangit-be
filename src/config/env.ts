/** Các biến môi trường mà backend dùng. Giá trị lấy từ file .env (xem .env.example). */
export interface Env {
  NODE_ENV: string;
  PORT: number;
  /** Địa chỉ giao diện web, dùng cho CORS và chuyển hướng sau khi đăng nhập. */
  FRONTEND_URL: string;
  /** Địa chỉ backend mà trình duyệt truy cập được, dùng làm callback của GitHub OAuth. */
  API_URL: string;
  /** Địa chỉ công khai mà GitHub gửi webhook tới (khi chạy ở máy cá nhân là kênh smee.io hoặc ngrok). */
  WEBHOOK_URL: string;
  DATABASE_URL: string;
  /** Bật SSL khi nối database (Supabase cần bật, Postgres cài trên máy thì tắt). */
  DATABASE_SSL: boolean;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  JWT_SECRET: string;
  /** Khóa 32 byte dạng hex (64 ký tự) để mã hóa token GitHub trong database. */
  TOKEN_ENCRYPTION_KEY: string;
  /** Lệch múi giờ so với UTC tính bằng phút, dùng để chia tuần cho dashboard (Việt Nam = 420). */
  TZ_OFFSET_MINUTES: number;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  GEMINI_EMBEDDING_MODEL: string;
  /** Độ giống tối thiểu (0 đến 1) để một issue được xem là ứng viên trùng. */
  DUPLICATE_MIN_SIMILARITY: number;
}

function required(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Thiếu biến môi trường ${key}. Xem file .env.example.`);
  }
  return value.trim();
}

function optional(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function toNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Biến môi trường ${key} phải là số.`);
  return parsed;
}

/** Kiểm tra biến môi trường ngay khi khởi động để lỗi cấu hình hiện ra sớm và rõ ràng. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const jwtSecret = required(raw, 'JWT_SECRET');
  if (jwtSecret.length < 16) throw new Error('JWT_SECRET cần ít nhất 16 ký tự.');

  const encryptionKey = required(raw, 'TOKEN_ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY phải là 64 ký tự hex. Tạo bằng: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  return {
    NODE_ENV: optional(raw, 'NODE_ENV', 'development'),
    PORT: toNumber('PORT', optional(raw, 'PORT', '4000')),
    FRONTEND_URL: optional(raw, 'FRONTEND_URL', 'http://localhost:3000').replace(/\/$/, ''),
    API_URL: optional(raw, 'API_URL', 'http://localhost:4000').replace(/\/$/, ''),
    WEBHOOK_URL: required(raw, 'WEBHOOK_URL'),
    DATABASE_URL: required(raw, 'DATABASE_URL'),
    DATABASE_SSL: optional(raw, 'DATABASE_SSL', 'true') !== 'false',
    GITHUB_CLIENT_ID: required(raw, 'GITHUB_CLIENT_ID'),
    GITHUB_CLIENT_SECRET: required(raw, 'GITHUB_CLIENT_SECRET'),
    GITHUB_WEBHOOK_SECRET: required(raw, 'GITHUB_WEBHOOK_SECRET'),
    JWT_SECRET: jwtSecret,
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    TZ_OFFSET_MINUTES: toNumber('TZ_OFFSET_MINUTES', optional(raw, 'TZ_OFFSET_MINUTES', '420')),
    GEMINI_API_KEY: optional(raw, 'GEMINI_API_KEY', '') || undefined,
    GEMINI_MODEL: optional(raw, 'GEMINI_MODEL', 'gemini-3.5-flash-lite'),
    GEMINI_EMBEDDING_MODEL: optional(raw, 'GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
    DUPLICATE_MIN_SIMILARITY: toNumber(
      'DUPLICATE_MIN_SIMILARITY',
      optional(raw, 'DUPLICATE_MIN_SIMILARITY', '0.6'),
    ),
  };
}
