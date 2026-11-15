import { z } from 'zod';

/**
 * The complete set of environment variables this service reads.
 *
 * A missing or malformed variable STOPS THE PROCESS. It never defaults to
 * something plausible — a service that boots with a wrong secret is worse than
 * one that refuses to boot (backend-design.md §4.2).
 */
const booleanish = z.enum(['true', 'false']).transform((v) => v === 'true');

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
    /**
     * The role the APPLICATION connects as, when it differs from the one that
     * runs migrations.
     *
     * Naming it is what turns the audit_logs append-only grant from a comment
     * into a control: the schema revokes UPDATE and DELETE on that table from
     * this role. Left unset, nothing is revoked — which is the honest state when
     * one role does everything, as it does in development.
     */
    DB_APP_ROLE: z.string().default(''),
    DB_POOL_MAX: positiveInt.default(10),
    DB_STATEMENT_TIMEOUT_MS: positiveInt.default(10_000),
    DB_CONNECT_TIMEOUT_MS: positiveInt.default(5_000),
    DB_IDLE_TIMEOUT_MS: positiveInt.default(30_000),
    REQUEST_TIMEOUT_MS: positiveInt.default(15_000),

    // --- Auth -------------------------------------------------------------
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    /**
     * A jsonwebtoken duration: `900`, `15m`, `2h`, `7d`.
     *
     * Validated rather than accepted as any string. `15min` is not a duration
     * jsonwebtoken understands, and it throws at SIGNING time — so a typo booted
     * cleanly, passed every health check, and answered 500 to every login.
     */
    JWT_ACCESS_TTL: z
      .string()
      .regex(/^\d+(\.\d+)?\s*(ms|s|m|h|d|w|y)?$/, 'expected a duration like 900, 15m, 2h or 7d')
      .default('15m'),
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
    /**
     * OPTIONAL. Left empty, one is DERIVED from the app secret — see
     * MetaWebhookVerifyToken. Meta's handshake requires the two sides to share a
     * string, but nothing requires a human to invent it, and requiring it before
     * boot coupled "I want to test Facebook login" to "I have already set up
     * webhooks", which are weeks apart in practice.
     */
    META_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
    FRONTEND_DASHBOARD_URL: z.string().default(''),

    // --- Gemini (the conversational model) --------------------------------
    /**
     * OFF BY DEFAULT, and the default is the point.
     *
     * With it off nothing is sent to Google, no key is required, and the whole
     * service boots and runs — the same bargain `META_ENABLED` strikes. Turning
     * it on means customer message content leaves our infrastructure, which is
     * a decision an environment makes deliberately rather than one that arrives
     * with a deploy.
     */
    GEMINI_ENABLED: booleanish.default(false),
    /** Secret. Never logged, never returned, never defaulted to anything. */
    GEMINI_API_KEY: z.string().default(''),
    /**
     * The model id, CONFIG RATHER THAN CONSTANT because Google retires these on
     * their own schedule and has already scheduled two for automatic
     * re-routing. A model change must be an environment change, not a release.
     *
     * `gemini-2.5-flash-lite` WAS the default, at $0.10 / $0.40 per million
     * tokens against $0.30 / $2.50 here — roughly a third of the input cost
     * and a sixth of the output. It is not reachable: Google documents the 2.5
     * family as limited to existing users, and a new key is refused outright:
     *
     *   404 models/gemini-2.5-flash-lite is no longer available to new users.
     *       Please update your code to use models/gemini-3.5-flash-lite
     *
     * Tested with a real key on 15 November 2026. Whether a model id resolves
     * is a property of the KEY, not of this code — which is the reason this is
     * configuration rather than a constant, and why switching cost one line.
     */
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    /**
     * The API version the SDK talks to, and it is NOT cosmetic.
     *
     * `v1` refuses inline media outright — the first real image came back
     * `400 The value 'image' is not supported for 'input[1].type' in v1, it is
     * available in v1beta`. Describing media is the entire feature, so v1beta
     * is the working default rather than the adventurous one.
     *
     * Pinned for the same reason `GRAPH_API_VERSION` is: left to the SDK's
     * default, the shape we parse would change under us without a deploy.
     */
    GEMINI_API_VERSION: z.string().min(1).default('v1beta'),
    /**
     * A model call is on a customer-facing path, so it must give up before the
     * request does. Longer than a database statement, shorter than the HTTP
     * timeout above it.
     */
    GEMINI_TIMEOUT_MS: positiveInt.default(30_000),
    GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    /**
     * Whether Google may keep the interaction, which is what makes
     * `previous_interaction_id` work — the server holds the history instead of
     * us resending it.
     *
     * OFF BY DEFAULT because the content is customers' messages and the
     * retention is Google's: 55 days on the paid tier, 1 day on the free one.
     * On the free tier that content is also used to improve their products.
     * Convenience is not a reason to make that choice silently.
     */
    GEMINI_STORE_INTERACTIONS: booleanish.default(false),

    // --- OpenAI (text chat) ----------------------------------------------
    /**
     * OFF BY DEFAULT, the same bargain `GEMINI_ENABLED` strikes: with it off
     * nothing is sent to OpenAI, no key is required, and the service boots.
     *
     * A SEPARATE SWITCH FROM GEMINI'S, deliberately. They are two providers
     * with two keys, two bills and two retention policies, doing two
     * different jobs — Gemini describes media, this one holds text
     * conversations. One switch for both would turn on a provider nobody
     * asked for.
     */
    OPENAI_ENABLED: booleanish.default(false),
    /** Secret. Never logged, never returned, never defaulted to anything. */
    OPENAI_API_KEY: z.string().default(''),
    /**
     * The model id: the cheapest one OpenAI will still be answering with.
     *
     * `gpt-5-nano` is cheaper on paper — $0.05 / $0.40 per million tokens
     * against $0.10 / $0.50 here — and it is NOT the default, because OpenAI
     * has it deprecated with shutdown on 11 December 2026 and names
     * `gpt-6-luna` as its own replacement. A default that stops answering in
     * three weeks saves cents and costs an outage.
     *
     * CONFIG RATHER THAN CONSTANT for the reason `GEMINI_MODEL` is: the
     * retirement schedule belongs to them, so a model change must be an
     * environment change rather than a release.
     */
    OPENAI_MODEL: z.string().min(1).default('gpt-6-luna'),
    /**
     * PER ATTEMPT, NOT PER CALL. The SDK retries underneath us, so the worst
     * case is this multiplied by `OPENAI_MAX_RETRIES + 1` — which is why the
     * client bounds the total itself instead of trusting that product to stay
     * small.
     */
    OPENAI_TIMEOUT_MS: positiveInt.default(30_000),
    OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    /**
     * The ceiling on one reply, and it is not only about length.
     *
     * Output is the expensive half — $0.50/M against $0.10/M on `gpt-6-luna`
     * — and REASONING TOKENS BILL AS OUTPUT: thinking we are charged for and
     * never see. The API's own minimum is 16.
     */
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(4_000).default(600),
    /**
     * How hard the model thinks before answering: `none` through `max`.
     *
     * `none` BECAUSE THIS IS CHAT. Thinking is billed as output, and a
     * conversational reply does not need a reasoning budget. Empty sends no
     * field at all, which is the escape hatch for a model that rejects a
     * level — OpenAI documents that not every model supports every value.
     */
    OPENAI_REASONING_EFFORT: z
      .enum(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .default('none'),
    /**
     * Whether OpenAI keeps the response server-side.
     *
     * OFF, AND THAT IS THE OPPOSITE OF THEIR DEFAULT: the API stores every
     * response for at least 30 days unless told not to. What passes through
     * here is a customer's conversation, so the retention is a thing an
     * environment decides out loud rather than inherits.
     */
    OPENAI_STORE_RESPONSES: booleanish.default(false),

    // --- Verification delivery / OTP (backend-design.md §12) --------------
    /**
     * OFF means no provider is called and every issued code is the fixed
     * OTP_STATIC_CODE, so the whole signup flow is walkable without an SMS or
     * email vendor. Refused in prod by the check below: a predictable code in
     * production would let anyone verify as anyone.
     */
    OTP_REALTIME_ENABLED: booleanish.default(false),
    OTP_STATIC_CODE: z
      .string()
      .regex(/^\d{4,8}$/, 'OTP_STATIC_CODE must be 4 to 8 digits')
      .default('666666'),

    // --- Platform admin bootstrap ----------------------------------------
    /**
     * Creates (idempotently) one internal staff login with platform-wide reach
     * on boot. Internal staff never sign up — there is no self-service route to
     * a staff account by design, so the first one has to come from config.
     */
    PLATFORM_ADMIN_ENABLED: booleanish.default(false),
    PLATFORM_ADMIN_NAME: z.string().default('Platform Admin'),
    PLATFORM_ADMIN_EMAIL: z.string().default(''),
    PLATFORM_ADMIN_MOBILE: z.string().default(''),
    PLATFORM_ADMIN_PASSWORD: z.string().default(''),
    /**
     * Overwrite the existing admin's password from configuration on boot.
     *
     * OFF by default, and that default IS the security property: provisioning is
     * create-if-absent, so changing the password in the database sticks. It used
     * to be re-applied on every boot, which made the committed development
     * credential heal itself after any rotation.
     */
    PLATFORM_ADMIN_FORCE_PASSWORD_RESET: booleanish.default(false),

    // --- Observability ----------------------------------------------------
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SWAGGER_ENABLED: booleanish.default(false),
    CORS_ORIGINS: z.string().default(''),

    /**
     * On everywhere by default, and switchable ONLY so the e2e suite can log in
     * repeatedly from one address without tripping the credential limit. Prod
     * refuses to boot with it off — see the superRefine below.
     */
    RATE_LIMIT_ENABLED: booleanish.default(true),
  })
  .superRefine((env, ctx) => {
    /*
     * A key is required only when the model is switched on — so a developer
     * can run the whole service without a Google account, exactly as they can
     * without Meta credentials.
     */
    if (env.GEMINI_ENABLED && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'GEMINI_API_KEY is required when GEMINI_ENABLED=true',
      });
    }
    /*
     * REFUSED IN PRODUCTION. On the free tier Google states that content is
     * "used to improve our products"; these are customers' private messages,
     * and a paid key is what turns that off. Storage is also how a conversation
     * keeps its history server-side, so prod turning it on is a considered
     * choice about a 55-day retention rather than an accident of defaults.
     */
    if (env.NODE_ENV === 'prod' && env.GEMINI_ENABLED && env.GEMINI_STORE_INTERACTIONS) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_STORE_INTERACTIONS'],
        message:
          'GEMINI_STORE_INTERACTIONS must be set deliberately in prod: it leaves ' +
          'customer message content with Google for 55 days (paid tier) and is ' +
          'only safe on a paid key',
      });
    }
    /*
     * A key is required only when the provider is switched on — the same
     * bargain Gemini and Meta strike, so a developer needs no OpenAI account
     * to run the service.
     */
    if (env.OPENAI_ENABLED && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when OPENAI_ENABLED=true',
      });
    }
    /*
     * REFUSED IN PRODUCTION for the reason `GEMINI_STORE_INTERACTIONS` is:
     * OpenAI keeps a stored response for at least 30 days, and what we send
     * it is customers' conversation. Storing that in prod is a considered
     * choice about retention, never an accident of defaults.
     */
    if (env.NODE_ENV === 'prod' && env.OPENAI_ENABLED && env.OPENAI_STORE_RESPONSES) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_STORE_RESPONSES'],
        message:
          'OPENAI_STORE_RESPONSES must be set deliberately in prod: it leaves ' +
          'customer conversation content with OpenAI for at least 30 days',
      });
    }
    // Meta config is only required when the integration is switched on, so a
    // developer can boot the whole service without Meta credentials.
    if (env.META_ENABLED) {
      const required = [
        'FB_APP_ID',
        'FB_APP_SECRET',
        'FB_LOGIN_CONFIG_ID',
        'META_OAUTH_REDIRECT_URI',
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

    // The bootstrap needs all three: a name to show, a credential to log in
    // with, and a password. A half-configured admin would fail at boot instead
    // of at first login, which is the cheaper place to find out.
    if (env.PLATFORM_ADMIN_ENABLED) {
      for (const key of [
        'PLATFORM_ADMIN_EMAIL',
        'PLATFORM_ADMIN_MOBILE',
        'PLATFORM_ADMIN_PASSWORD',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when PLATFORM_ADMIN_ENABLED=true`,
          });
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
      // A fixed OTP in production is a total authentication bypass: anyone who
      // knows the constant can verify any email or mobile they can type.
      if (!env.OTP_REALTIME_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['OTP_REALTIME_ENABLED'],
          message:
            'OTP_REALTIME_ENABLED must be true in prod — a static OTP would bypass verification',
        });
      }
      // Turning the limiter off in prod would remove the only brake on password
      // and OTP guessing, so it is not a decision a deploy gets to make quietly.
      if (!env.RATE_LIMIT_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['RATE_LIMIT_ENABLED'],
          message: 'RATE_LIMIT_ENABLED must be true in prod',
        });
      }
      // A short password on an account that can see and change every business on
      // the platform is the highest-value credential in the system. The length
      // check alone would pass `1234567890123456`, so the shape is checked too:
      // .env.dev ships a working admin password, and this bootstrap runs on every
      // boot, so a deploy that inherited that file would provision a
      // full-platform account whose credential is in the repository.
      if (env.PLATFORM_ADMIN_ENABLED) {
        if (env.PLATFORM_ADMIN_PASSWORD.length < 16) {
          ctx.addIssue({
            code: 'custom',
            path: ['PLATFORM_ADMIN_PASSWORD'],
            message: 'PLATFORM_ADMIN_PASSWORD must be at least 16 characters in prod',
          });
        }
        if (
          !/[a-z]/.test(env.PLATFORM_ADMIN_PASSWORD) ||
          !/[^a-zA-Z0-9]/.test(env.PLATFORM_ADMIN_PASSWORD)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['PLATFORM_ADMIN_PASSWORD'],
            message:
              'PLATFORM_ADMIN_PASSWORD must mix letters and punctuation in prod — a digit string is guessable at any length',
          });
        }
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
