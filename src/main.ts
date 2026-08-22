import 'reflect-metadata';
import { VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './config';
import { MAX_JSON_BODY_BYTES } from './shared/constants';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './shared/interceptors/response-envelope.interceptor';
import { TimeoutInterceptor } from './shared/interceptors/timeout.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // REQUIRED: without it the raw bytes are gone after body parsing, and Meta
    // webhook HMAC verification becomes impossible.
    rawBody: true,
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  app.useLogger(app.get(Logger));

  // Every route is /api/v1/... from day one. Retrofitting a version prefix
  // later is itself a breaking change.
  app.setGlobalPrefix(config.app.apiPrefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.use(helmet());
  app.use(cookieParser());
  /*
   * Nest's OWN body parsers, not app.use(json()): the rawBody: true option is
   * implemented inside them, so replacing them with express middleware silently
   * drops req.rawBody — and Meta webhook HMAC verification then always fails,
   * because it has nothing to verify against.
   */
  app.useBodyParser('json', { limit: MAX_JSON_BODY_BYTES });
  app.useBodyParser('urlencoded', { extended: false, limit: MAX_JSON_BODY_BYTES });

  // A strict allowlist, never a wildcard with credentials — the refresh cookie
  // makes this a credentialed API.
  app.enableCors({
    origin: config.app.corsOrigins.length > 0 ? [...config.app.corsOrigins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-Request-Id'],
    maxAge: 600,
  });

  // So rate limiting and audit rows see the real client IP rather than the
  // load balancer's.
  app.set('trust proxy', 1);

  const reflector = app.get(Reflector);
  // The request context is established by middleware (see AppModule), because
  // middleware runs before guards and interceptors do not.
  app.useGlobalInterceptors(
    new TimeoutInterceptor(config),
    new ResponseEnvelopeInterceptor(reflector),
  );
  app.useGlobalFilters(app.get(AllExceptionsFilter));

  /*
   * No global ValidationPipe: Nest's pipe requires class-validator, which this
   * project deliberately does not use (backend-design.md §1.3). Zod owns
   * validation — each handler parses its request with the schema that also
   * produces its TypeScript type and its OpenAPI schema, so there is one
   * declaration rather than a type and a set of rules that drift.
   */

  if (config.app.swaggerEnabled) mountSwagger(app, config);

  // Graceful shutdown: finish in-flight work, release leases, then exit.
  app.enableShutdownHooks();

  await app.listen(config.app.port);
}

function mountSwagger(app: NestExpressApplication, config: AppConfigService): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Wouchh Unified API')
      .setDescription(
        'Social inbox, comments and posts for connected enterprises. ' +
          'Every response uses one envelope: { success, data, meta } or ' +
          '{ success: false, error: { code, message, details }, meta }.',
      )
      .setVersion(config.app.version)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'accessToken')
      .addCookieAuth('refreshToken')
      .addTag('auth', 'Sign in, verification, session and enterprise switching')
      .addTag('enterprises', 'Business onboarding and profile')
      .addTag('connections', 'Meta and other provider connections')
      .addTag('health', 'Liveness, readiness and startup probes')
      .build(),
  );

  SwaggerModule.setup(`${config.app.apiPrefix}/docs`, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}

/*
 * A caught bootstrap, not `void bootstrap()`.
 *
 * Unhandled, the commonest startup failure by far — the port is already in use,
 * usually because a previous run is still holding it — arrives as fifteen lines
 * of Node internals with the one useful word buried in the middle. Config
 * validation throws even earlier, at require time, so it never reaches here; this
 * is for the failures that happen once the graph is built.
 */
bootstrap().catch((error: unknown) => {
  const code = (error as { code?: string }).code;
  const port = (error as { port?: number }).port;

  if (code === 'EADDRINUSE') {
    console.error(
      `\nPort ${port ?? 'unknown'} is already in use — something else is listening on it.\n` +
        `Find it with:  lsof -nP -iTCP:${port ?? 3000} -sTCP:LISTEN\n` +
        `Or start on another port with:  PORT=3001 pnpm start:local\n`,
    );
    process.exit(1);
  }

  console.error('\nThe service failed to start.\n');
  console.error(error);
  process.exit(1);
});
