import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule, AppConfigService } from '@/config';
import { buildDataSourceOptions } from '@/database/data-source';
import { DatabaseModule } from '@/database/database.module';
import { CatalogueModule } from '@/modules/catalogue/catalogue.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ConnectionsModule } from '@/modules/connections/connections.module';
import { EmployeesModule } from '@/modules/employees/employees.module';
import { EnterprisesModule } from '@/modules/enterprises/enterprises.module';
import { HealthModule } from '@/modules/health/health.module';
import { InboxModule } from '@/modules/inbox/inbox.module';
import { PlatformModule } from '@/modules/platform/platform.module';
import { CryptoModule } from '@/shared/crypto';
import {
  EnterpriseActiveGuard,
  EnterpriseScopeGuard,
  JwtAuthGuard,
  PermissionsGuard,
  PlatformAdminGuard,
} from '@/shared/guards';
import { AllExceptionsFilter } from '@/shared/filters/all-exceptions.filter';
import { RequestContextMiddleware } from '@/shared/context/request-context.middleware';
import { buildLoggerConfig } from '@/shared/logging/logger.config';

@Module({
  imports: [
    AppConfigModule,
    CryptoModule,

    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildLoggerConfig(config),
    }),

    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildDataSourceOptions(config.database),
    }),

    /*
     * In-memory rate limiting, because there is no Redis in V1. Accepted while
     * the instance count is small — and the security-critical throttles are
     * already GLOBAL by construction, because they live in Postgres:
     * identities.failed_login_count / locked_until for login, and the
     * verifications destination index for send caps.
     */
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    ScheduleModule.forRoot(),

    DatabaseModule,
    AuthModule,
    ConnectionsModule,
    EmployeesModule,
    EnterprisesModule,
    InboxModule,
    CatalogueModule,
    PlatformModule,
    HealthModule,
  ],
  providers: [
    // Resolved from the container in main.ts because it injects the logger.
    AllExceptionsFilter,

    /*
     * Guards are GLOBAL and opened up per route by @Public, rather than the
     * reverse: a route is protected unless it says otherwise, so forgetting a
     * decorator fails closed. Order matters — authentication, then scope, then
     * permission.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: EnterpriseScopeGuard },
    { provide: APP_GUARD, useClass: EnterpriseActiveGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: PlatformAdminGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /*
     * First in the chain: guards and interceptors both read this context.
     *
     * `{*path}` rather than `*`. Express 5's path-to-regexp dropped the bare
     * wildcard, and Nest currently auto-converts it while logging a warning on
     * every boot — so this is the same route, spelled the way the router will
     * still accept after the next upgrade.
     */
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
