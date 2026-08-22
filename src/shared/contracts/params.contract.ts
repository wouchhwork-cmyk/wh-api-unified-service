import { z } from 'zod';

/**
 * A public identifier from a URL path.
 *
 * Validated before it reaches a query so a malformed value is a clean 422 rather
 * than a Postgres 22P02 surfacing as a 500 — and so a path segment can never be
 * carried into SQL as anything but a uuid.
 */
export const RefIdParamSchema = z.uuid('expected a reference id');
