import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { CorsIoAdapter } from './realtime/cors-io.adapter.js';

async function bootstrap() {
  // rawBody: giữ nguyên nội dung gốc của yêu cầu để kiểm tra chữ ký webhook của GitHub
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const frontendUrl = config.get('FRONTEND_URL', { infer: true });
  const port = config.get('PORT', { infer: true });

  app.use(cookieParser());
  // Frontend khác cổng nên cần CORS, và phải gửi kèm cookie đăng nhập (credentials) với origin cụ thể
  app.enableCors({ origin: frontendUrl, credentials: true });
  app.useWebSocketAdapter(new CorsIoAdapter(app, frontendUrl));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  await app.listen(port);
  Logger.log(`Backend chạy tại http://localhost:${port}`, 'Bootstrap');
}

await bootstrap();
