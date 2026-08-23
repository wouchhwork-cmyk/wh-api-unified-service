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
function readEncryptionKeys(activeKeyId: string, nodeEnv: string): Map<string, Buffer> {
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

  /*
   * Prod refuses the committed dev key, exactly as it already refuses a
   * placeholder JWT secret and pepper (env.schema.ts). This key is the one that
   * protects every Meta access token in the database, and it was the one secret
   * with no such guard — .env.dev ships a real, working 32-byte value, so a
   * deploy that forgot to set it would have booted happily and encrypted every
   * customer's provider tokens under a key that is in the repository.
   *
   * Only the ACTIVE key is checked. Older versions must stay loadable or rows
   * written under them become unreadable, which is the whole point of the
   * versioned envelope — and a rotation away from a leaked key is exactly what
   * we want to keep possible.
   */
  if (nodeEnv === 'prod') {
    const active = keys.get(activeKeyId);
    const marker = active?.toString('utf8').toLowerCase() ?? '';
    if (/dev-only|placeholder|changeme/.test(marker)) {
      throw new Error(
        `refusing to boot prod with a placeholder TOKEN_ENCRYPTION_KEY_${activeKeyId.toUpperCase()}`,
      );
    }
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
      rateLimitEnabled: env.RATE_LIMIT_ENABLED,
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
      keys: readEncryptionKeys(env.TOKEN_ENCRYPTION_KEY_ID, env.NODE_ENV),
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
    otp: {
      realtimeEnabled: env.OTP_REALTIME_ENABLED,
      staticCode: env.OTP_STATIC_CODE,
    },
    platformAdmin: {
      enabled: env.PLATFORM_ADMIN_ENABLED,
      name: env.PLATFORM_ADMIN_NAME,
      email: env.PLATFORM_ADMIN_EMAIL.trim().toLowerCase(),
      mobile: env.PLATFORM_ADMIN_MOBILE.trim(),
      password: env.PLATFORM_ADMIN_PASSWORD,
      forcePasswordReset: env.PLATFORM_ADMIN_FORCE_PASSWORD_RESET,
    },
  };
}
