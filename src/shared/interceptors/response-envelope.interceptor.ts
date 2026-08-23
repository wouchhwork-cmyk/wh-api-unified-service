import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { RAW_RESPONSE_KEY } from '@/shared/decorators/raw-response.decorator';
import { RequestContext } from '@/shared/context';
import {
  carriesPagination,
  isPaginated,
  type Envelope,
  type ResponseMeta,
} from '@/shared/contracts/envelope';

/**
 * Wraps every controller return value in the success envelope, so NO CONTROLLER
 * EVER CONSTRUCTS ONE BY HAND (backend-design.md §8.1). Controllers return plain
 * data; the shape is enforced here, once.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isRaw) return next.handle();

    return next.handle().pipe(
      map((payload: unknown): Envelope<unknown> => {
        const meta: ResponseMeta = {
          requestId: RequestContext.correlationId() ?? 'unknown',
          timestamp: new Date().toISOString(),
        };

        // A paginated result carries its own meta; lift it so `data` is the
        // array itself rather than an object wrapping one.
        if (isPaginated(payload)) {
          return {
            success: true,
            data: payload.items,
            meta: { ...meta, pagination: payload.pagination },
          };
        }

        /*
         * A result that carries a page WITHOUT being one — the conversation
         * thread, which is a conversation and its messages. The pagination is
         * lifted into meta so there is ONE envelope rather than one shape for a
         * bare list and another for anything else.
         */
        if (carriesPagination(payload)) {
          const { pagination, ...rest } = payload;
          return { success: true, data: rest, meta: { ...meta, pagination } };
        }

        return { success: true, data: payload ?? null, meta };
      }),
    );
  }
}
