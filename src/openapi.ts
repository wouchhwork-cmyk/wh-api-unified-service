import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

/**
 * The OpenAPI document, built once and used twice: served at `/api/docs`, and
 * written to disk by `pnpm openapi:export`.
 *
 * ITS OWN MODULE, not a function exported from main.ts. main.ts calls
 * `bootstrap()` at the top level, so importing anything from it starts the whole
 * server — which is how the first version of the export script came to bind a
 * port and then exit 1 with no output at all.
 *
 * One builder, so the committed contract cannot describe a different API than
 * the one that ships.
 */
export function buildOpenApiDocument(app: INestApplication, version: string): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Wouchh Unified API')
      .setDescription(
        'Social inbox, comments and posts for connected enterprises. ' +
          'Every response uses one envelope: { success, data, meta } or ' +
          '{ success: false, error: { code, message, details }, meta }.',
      )
      .setVersion(version)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'accessToken')
      .addCookieAuth('refreshToken')
      .addTag('auth', 'Sign in, verification, session and enterprise switching')
      .addTag('enterprises', 'Business onboarding and profile')
      .addTag('connections', 'Meta and other provider connections')
      .addTag('conversations', 'The shared inbox: reading, replying, assigning')
      .addTag('employees', 'Colleagues, roles and invitations')
      .addTag('platform', 'The Wouchh console: businesses and their features')
      .addTag('health', 'Liveness, readiness and startup probes')
      .build(),
  );
}
