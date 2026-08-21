import { EnvSchema, type Env } from './env.schema';
import { VERIFICATION_CONFIG } from './verification.config';
import type { Configuration } from './config.types';

/**
 * THE ONLY PLACE `process.env` IS READ.
 *
 * Everything else injects ConfigService. A `process.env` reference outside this
 * directory is a lint error (backend-design.md §4.2).
 */
function readEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    // Report EVERY problem at once — fixing config one variable per restart is
    // needless friction. Values are never printed; a bad secret must not reach
    // a log line.
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  - ${key}: ${issue.message}`;
    });
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n` +
        'See .env.example for the full list of variables.',
    );
  }

  return parsed.data;
}

/**
 * Collects token-encryption keys from TOKEN_ENCRYPTION_KEY_K1, _K2, … so that
 * rotating a key is an added variable rather than a code change. Rows written
 * under an older version stay readable because the envelope names its version
 * (schema.md §14).
 */
function readEncryptionKeys(activeKeyId: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  const prefix = 'TOKEN_ENCRYPTION_KEY_';

  for (const [name, raw] of Object.entries(process.env)) {
    if (!name.startsWith(prefix) || name === `${prefix}ID` || !raw) continue;

    const keyId = name.slice(prefix.length).toLowerCase();
    if (!/^k\d+$/.test(keyId)) continue;

    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(`${name} must decode to exactly 32 bytes for AES-256-GCM, got ${key.length}`);
    }
    keys.set(keyId, key);
  }

  if (!keys.has(activeKeyId)) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY_ID is "${activeKeyId}" but ` +
        `TOKEN_ENCRYPTION_KEY_${activeKeyId.toUpperCase()} is not set. ` +
        'Provider tokens could be read but never written.',
    );
  }

  return keys;
}

export function loadConfiguration(): Configuration {
  const env = readEnv();

  return {
    app: {
      env: env.NODE_ENV,
      isProd: env.NODE_ENV === 'prod',
      port: env.PORT,
      version: env.APP_VERSION,
      apiPrefix: env.API_PREFIX,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      corsOrigins: env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      swaggerEnabled: env.SWAGGER_ENABLED,
      logLevel: env.LOG_LEVEL,
    },
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      ssl: env.DB_SSL,
      poolMax: env.DB_POOL_MAX,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
      argon2: {
        memoryCost: env.ARGON2_MEMORY_KIB,
        timeCost: env.ARGON2_ITERATIONS,
        parallelism: env.ARGON2_PARALLELISM,
      },
    },
    crypto: {
      activeKeyId: env.TOKEN_ENCRYPTION_KEY_ID,
      keys: readEncryptionKeys(env.TOKEN_ENCRYPTION_KEY_ID),
      verificationPepper: env.VERIFICATION_HMAC_PEPPER,
    },
    verification: VERIFICATION_CONFIG,
    worker: {
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      idlePollIntervalMs: env.WORKER_IDLE_POLL_INTERVAL_MS,
      batchSize: env.WORKER_BATCH_SIZE,
      leaseSeconds: env.WORKER_LEASE_SECONDS,
      expiryWarningWindowDays: env.EXPIRY_WARNING_WINDOW_DAYS,
      expirySweepCron: env.EXPIRY_SWEEP_CRON,
    },
    meta: {
      enabled: env.META_ENABLED,
      appId: env.FB_APP_ID,
      appSecret: env.FB_APP_SECRET,
      loginConfigId: env.FB_LOGIN_CONFIG_ID,
      graphApiVersion: env.GRAPH_API_VERSION,
      oauthRedirectUri: env.META_OAUTH_REDIRECT_URI,
      webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
      frontendDashboardUrl: env.FRONTEND_DASHBOARD_URL,
    },
  };
}
