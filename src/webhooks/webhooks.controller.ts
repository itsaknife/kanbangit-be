import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('github')
  @HttpCode(200)
  async github(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Body() payload: unknown,
  ): Promise<{ ok: true }> {
    if (!req.rawBody) throw new BadRequestException('Thiếu nội dung yêu cầu');
    await this.webhooks.assertSignature(req.rawBody.toString('utf8'), signature);
    await this.webhooks.handle(event, payload);
    return { ok: true };
  }
}
