import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
@Injectable()
export class CollaborationChangeInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeGateway) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; params: { repoId: string } }>();
    return next.handle().pipe(
      tap(() => {
        if (['POST', 'PATCH', 'DELETE'].includes(request.method))
          this.realtime.emitCollaborationChanged(request.params.repoId);
      }),
    );
  }
}
