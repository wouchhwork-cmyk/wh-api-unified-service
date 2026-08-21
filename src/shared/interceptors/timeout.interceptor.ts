import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { throwError, timeout, catchError, TimeoutError, type Observable } from 'rxjs';
import { AppConfigService } from '@/config';
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
  constructor(private readonly config: AppConfigService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
