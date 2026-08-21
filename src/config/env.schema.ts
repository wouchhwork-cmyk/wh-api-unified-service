import { z } from 'zod';

/**
 * The complete set of environment variables this service reads.
 *
 * A missing or malformed variable STOPS THE PROCESS. It never defaults to
 * something plausible — a service that boots with a wrong secret is worse than
 * one that refuses to boot (backend-design.md §4.2).
 */
const booleanish = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const port = z.coerce.number().int().positive().max(65535);
const positiveInt = z.coerce.number().int().positive();

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['dev', 'qa', 'prod']),
    PORT: port.default(3000),
    APP_VERSION: z.string().default('dev'),
    API_PREFIX: z.string().default('api'),

    // --- Database ---------------------------------------------------------
    DB_HOST: z.string().min(1),
    DB_PORT: port,
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_SSL: booleanish,
    DB_POOL_MAX: positiveInt.default(10),
    DB_STATEMENT_TIMEOUT_MS: positiveInt.default(10_000),
    DB_CONNECT_TIMEOUT_MS: positiveInt.default(5_000),
    DB_IDLE_TIMEOUT_MS: positiveInt.default(30_000),
    REQUEST_TIMEOUT_MS: positiveInt.default(15_000),

    // --- Auth -------------------------------------------------------------
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: positiveInt.default(7),
    ARGON2_MEMORY_KIB: positiveInt.default(19_456),
    ARGON2_ITERATIONS: positiveInt.default(2),
    ARGON2_PARALLELISM: positiveInt.default(1),

    // --- Crypto -----------------------------------------------------------
    /** Which key version encrypts NEW rows. Old rows stay readable by version. */
    TOKEN_ENCRYPTION_KEY_ID: z.string().regex(/^k\d+$/, 'expected k1, k2, …'),
    /**
     * Key material, one variable per version: TOKEN_ENCRYPTION_KEY_K1, _K2, …
     * Collected dynamically in configuration.ts, because the set grows with
     * rotation and a fixed schema would have to be edited to rotate.
     */
    VERIFICATION_HMAC_PEPPER: z
      .string()
      .min(32, 'VERIFICATION_HMAC_PEPPER must be at least 32 characters'),

    // --- Workers ----------------------------------------------------------
    WORKER_POLL_INTERVAL_MS: positiveInt.default(2_000),
    WORKER_IDLE_POLL_INTERVAL_MS: positiveInt.default(10_000),
    WORKER_BATCH_SIZE: positiveInt.max(500).default(20),
    WORKER_LEASE_SECONDS: positiveInt.default(120),
    EXPIRY_WARNING_WINDOW_DAYS: positiveInt.default(7),
    EXPIRY_SWEEP_CRON: z.string().default('0 * * * *'),

    // --- Meta integration (backend-design.md §18) -------------------------
    META_ENABLED: booleanish.default(false),
    FB_APP_ID: z.string().default(''),
    FB_APP_SECRET: z.string().default(''),
    FB_LOGIN_CONFIG_ID: z.string().default(''),
    GRAPH_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, 'expected a Graph version like v25.0')
      .default('v25.0'),
    META_OAUTH_REDIRECT_URI: z.string().default(''),
    META_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
    FRONTEND_DASHBOARD_URL: z.string().default(''),

    // --- Observability ----------------------------------------------------
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SWAGGER_ENABLED: booleanish.default(false),
    CORS_ORIGINS: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    // Meta config is only required when the integration is switched on, so a
    // developer can boot the whole service without Meta credentials.
    if (env.META_ENABLED) {
      const required = [
        'FB_APP_ID',
        'FB_APP_SECRET',
        'FB_LOGIN_CONFIG_ID',
        'META_OAUTH_REDIRECT_URI',
        'META_WEBHOOK_VERIFY_TOKEN',
        'FRONTEND_DASHBOARD_URL',
      ] as const;
      for (const key of required) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when META_ENABLED=true`,
          });
        }
      }
      if (env.META_WEBHOOK_VERIFY_TOKEN && env.META_WEBHOOK_VERIFY_TOKEN.length < 16) {
        ctx.addIssue({
          code: 'custom',
          path: ['META_WEBHOOK_VERIFY_TOKEN'],
          message: 'META_WEBHOOK_VERIFY_TOKEN must be at least 16 characters',
        });
      }
      for (const key of ['META_OAUTH_REDIRECT_URI', 'FRONTEND_DASHBOARD_URL'] as const) {
        if (env[key] && !URL.canParse(env[key])) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} must be an absolute URL` });
        }
      }
    }

    // Production must never run with a committed dev placeholder, and must not
    // expose Swagger without deliberate intent.
    if (env.NODE_ENV === 'prod') {
      if (/dev-only|placeholder|changeme|localhost/i.test(env.JWT_ACCESS_SECRET)) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_ACCESS_SECRET'],
          message: 'refusing to boot prod with a placeholder JWT_ACCESS_SECRET',
        });
      }
      if (/dev-only|placeholder|changeme/i.test(env.VERIFICATION_HMAC_PEPPER)) {
        ctx.addIssue({
          code: 'custom',
          path: ['VERIFICATION_HMAC_PEPPER'],
          message: 'refusing to boot prod with a placeholder VERIFICATION_HMAC_PEPPER',
        });
      }
      if (!env.DB_SSL) {
        ctx.addIssue({
          code: 'custom',
          path: ['DB_SSL'],
          message: 'DB_SSL must be true in prod',
        });
      }
    }

    // The request timeout must outlive the statement timeout, so a slow query
    // surfaces as a diagnosable statement_timeout rather than an anonymous
    // request abort (backend-design.md §5.2).
    if (env.REQUEST_TIMEOUT_MS <= env.DB_STATEMENT_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['REQUEST_TIMEOUT_MS'],
        message: 'REQUEST_TIMEOUT_MS must be greater than DB_STATEMENT_TIMEOUT_MS',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;
