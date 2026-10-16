/**
 * Writes the OpenAPI document to disk, so the contract can be committed and
 * diffed.
 *
 *   pnpm openapi:export
 *
 * COMPILED, like dist/migrate.js, rather than run through tsx from scripts/.
 * The tsx path could not resolve this graph's decorated modules and exited with
 * a code and no output at all, which is the least debuggable failure available.
 * It also means the export runs the same code the image ships.
 *
 * `package.json` has pointed at this file since the first commit and the file did
 * not exist, so the script failed, there was no committed document, and nothing
 * could tell a breaking change from a rename. CI diffs the output against the
 * committed copy.
 *
 * It builds the application graph WITHOUT listening: the document comes from
 * Nest's own route metadata, so no port is bound and nothing serves traffic. It
 * still needs a valid environment, because the module graph reads configuration
 * at construction — hence `--env-file`.
 */
// FIRST, before anything that carries a decorator. Nest's metadata reflection
// needs this polyfill installed, and without it the module graph fails in a way
// that produces an exit code and no output at all — which is how the first
// version of this script appeared to do nothing.
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppConfigService } from './config';
import { buildOpenApiDocument } from './openapi';

const OUTPUT = resolve(process.cwd(), 'openapi.json');

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  try {
    const config = app.get(AppConfigService);

    /*
     * The SAME prefix and versioning as main.ts, because they are part of every
     * path in the document. Without them the export would describe
     * `/conversations` while the service serves `/api/v1/conversations`.
     */
    app.setGlobalPrefix(config.app.apiPrefix);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    const document = buildOpenApiDocument(app, config.app.version);

    // Two-space JSON with a trailing newline: a document that is diffed has to
    // be formatted the same way every time, or every export is a whole-file
    // change.
    writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    const paths = Object.keys(document.paths ?? {}).length;
    console.log(`wrote ${OUTPUT} (${paths} paths)`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
