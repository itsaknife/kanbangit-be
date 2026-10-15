import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/** Cho phép giao diện web (khác cổng) kết nối Socket.io và gửi kèm cookie. */
export class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origin: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const merged = {
      ...options,
      cors: { origin: this.origin, credentials: true },
    } as ServerOptions;
    return super.createIOServer(port, merged);
  }
}
