import { loadTestEnv } from './load-env';

/**
 * Per-file setup: the environment, before any test imports the config.
 *
 * The work itself lives in ./load-env so the global setup — which runs in its own
 * module graph and therefore shares nothing with this — can do exactly the same
 * thing rather than a near-enough copy of it.
 */
loadTestEnv();
