import { loadTestEnv } from './load-env';

/**
 * Per-file setup for the E2E suite, which gets its OWN database.
 *
 * Separate from env-setup.ts for exactly one reason: this suite and the
 * integration suite both TRUNCATE in beforeEach, and vitest runs projects
 * alongside each other — so sharing a database meant they wiped each other's
 * fixtures. It presented as an arbitrary test failing about one combined run in
 * five and passing every time it ran alone.
 */
loadTestEnv('_e2e');
