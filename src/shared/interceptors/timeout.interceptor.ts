import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { throwError, timeout, catchError, TimeoutError, type Observable } from 'rxjs';
import { AppConfigService } from '@/config';
import { SKIP_TIMEOUT_KEY } from '@/shared/decorators';
import { AppException, ErrorCode } from '@/shared/errors';

/**
 * The outermost time bound on a request.
 *
 * Deliberately LONGER than the database statement timeout, so a slow query
 * surfaces as a diagnosable statement_timeout rather than an anonymous request
 * abort (backend-design.md §5.2). The env schema enforces that ordering at boot.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(
    private readonly config: AppConfigService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A handler may opt out — see SkipTimeout for the one case that needs it.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TIMEOUT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    return next.handle().pipe(
      timeout(this.config.app.requestTimeoutMs),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new AppException(ErrorCode.RequestTimeout, { cause: error })
            : error,
        ),
      ),
    );
  }
}
