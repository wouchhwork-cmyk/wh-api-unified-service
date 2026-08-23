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
import { NoStoreMiddleware } from '@/shared/middleware/no-store.middleware';
import { WebhookBodyLimitMiddleware } from '@/shared/middleware/webhook-body-limit.middleware';
import { MetaWebhookController } from '@/modules/connections/meta-webhook.controller';
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
     * In-memory rate limiting, because there is no Redis in V1.
     *
     * Its limits are therefore PER PROCESS: two replicas allow twice the traffic
     * and a deploy resets every counter. That is accepted while the instance
     * count is small, and it is why the caps that must not be evadable live in
     * Postgres instead — identities.locked_until for a proven password, and the
     * verifications destination index for send caps.
     *
     * What this is NOT is a substitute for either of those. The credential
     * routes carry their own, much tighter @Throttle for that reason: the
     * account lock is only consulted once a password is already proven, so it
     * never sees a wrong guess.
     */
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        /*
         * The only reason this switch exists: the e2e suite signs in dozens of
         * times from one address, which is indistinguishable from a guessing
         * attack and should be. Prod refuses to boot with it off
         * (env.schema.ts), so it cannot be turned into a production decision.
         */
        skipIf: () => !config.app.rateLimitEnabled,
      }),
    }),

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
    consumer.apply(RequestContextMiddleware, NoStoreMiddleware).forRoutes('{*path}');

    /*
     * A tighter body limit on the one PUBLIC WRITE route. Declared in the module
     * rather than in main.ts so the e2e harness — which builds this module and
     * duplicates main.ts's wiring by hand — cannot drift out of step with it.
     */
    /*
     * Bound to the CONTROLLER, not to a path string. A path here has to agree
     * with the global prefix and the URI version — `api` and `v1` — and a string
     * that silently fails to match is a limit that silently does not exist,
     * which is what happened to the first version of this line.
     */
    consumer.apply(WebhookBodyLimitMiddleware).forRoutes(MetaWebhookController);
  }
}
