import 'reflect-metadata';
import { VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './config';
import { MAX_JSON_BODY_BYTES } from './shared/constants';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './shared/interceptors/response-envelope.interceptor';
import { TimeoutInterceptor } from './shared/interceptors/timeout.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
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
  app.use(json({ limit: MAX_JSON_BODY_BYTES }));
  app.use(urlencoded({ extended: false, limit: MAX_JSON_BODY_BYTES }));

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
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const reflector = app.get(Reflector);
  // The request context is established by middleware (see AppModule), because
  // middleware runs before guards and interceptors do not.
  app.useGlobalInterceptors(new TimeoutInterceptor(config), new ResponseEnvelopeInterceptor(reflector));
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

function mountSwagger(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  config: AppConfigService,
): void {
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

void bootstrap();
