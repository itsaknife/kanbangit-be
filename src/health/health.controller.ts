import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Endpoint cho cronjob gọi định kỳ để Render không cho server ngủ.
 * Có kèm một câu truy vấn nhẹ vào database nên cũng giúp Supabase không bị tạm dừng vì lâu không dùng.
 * Không yêu cầu đăng nhập và không trả dữ liệu nhạy cảm.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error('Không kết nối được database', error);
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    return { status: 'ok', database: 'up', uptimeSeconds: Math.round(process.uptime()) };
  }
}
