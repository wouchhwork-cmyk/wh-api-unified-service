import type { VerificationKind, VerificationSecretShape } from '@/shared/enums';

export interface AppConfig {
  readonly env: 'dev' | 'qa' | 'prod';
  readonly isProd: boolean;
  readonly port: number;
  readonly version: string;
  readonly apiPrefix: string;
  readonly requestTimeoutMs: number;
  readonly corsOrigins: readonly string[];
  readonly swaggerEnabled: boolean;
  readonly logLevel: string;
  readonly rateLimitEnabled: boolean;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly name: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
  /** The application's own role, when distinct from the migration role. */
  readonly appRole: string | null;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

export interface AuthConfig {
  readonly accessSecret: string;
  readonly accessTtl: string;
  readonly refreshTtlDays: number;
  readonly argon2: {
    readonly memoryCost: number;
    readonly timeCost: number;
    readonly parallelism: number;
  };
}

export interface CryptoConfig {
  /** Which key version encrypts new rows. */
  readonly activeKeyId: string;
  /** All known key versions, so rows written under an older key stay readable. */
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly verificationPepper: string;
}

export interface VerificationKindConfig {
  readonly secretShape: VerificationSecretShape;
  /** Digits for a numeric code; bytes of entropy for a token. */
  readonly secretSize: number;
  readonly expiryMs: number;
  readonly maxAttempts: number;
  readonly resendCooldownMs: number;
  readonly hourlyDestinationCap: number;
}

export interface WorkerConfig {
  readonly pollIntervalMs: number;
  readonly idlePollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly expiryWarningWindowDays: number;
  readonly expirySweepCron: string;
}

export interface MetaConfig {
  readonly enabled: boolean;
  readonly appId: string;
  readonly appSecret: string;
  readonly loginConfigId: string;
  readonly graphApiVersion: string;
  readonly oauthRedirectUri: string;
  readonly webhookVerifyToken: string;
  readonly frontendDashboardUrl: string;
}

export interface GeminiConfig {
  /** Off means no call is made and no key is needed. */
  readonly enabled: boolean;
  /** Secret. Never logged and never included in an error response. */
  readonly apiKey: string;
  /** Config rather than constant — Google retires model ids on its own schedule. */
  readonly model: string;
  /**
   * `v1beta` or `v1`. Inline media is refused on v1, so this is load-bearing
   * rather than cosmetic — see the env schema.
   */
  readonly apiVersion: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /**
   * Whether Google keeps the interaction server-side, which is what makes
   * multi-turn work without resending history — at the cost of customer
   * message content living there for 55 days.
   */
  readonly storeInteractions: boolean;
}

/**
 * How hard a model may think, as the API spells it, plus the empty string for
 * "send no preference at all" — the escape hatch for a model that rejects a
 * level it does not implement.
 */
export type ReasoningEffortSetting =
  | ''
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/**
 * Keeping the exact bodies of a model call, for somebody debugging one.
 *
 * See `AI_WIRE_CAPTURE_ENABLED`: off by default, refused in prod.
 */
export interface AiWireCaptureConfig {
  readonly enabled: boolean;
  readonly dir: string;
  readonly maxFiles: number;
}

export interface OpenAiConfig {
  /** Off means no call is made and no key is needed. */
  readonly enabled: boolean;
  /** Secret. Never logged and never included in an error response. */
  readonly apiKey: string;
  /** Config rather than constant — OpenAI retires model ids on its own schedule. */
  readonly model: string;
  /** Per attempt. The SDK retries beneath it, so the client bounds the total. */
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** `none` through `max`; empty means the field is not sent at all. */
  readonly reasoningEffort: ReasoningEffortSetting;
  /**
   * Whether OpenAI keeps the response server-side. Their default is true and
   * retention is at least 30 days, so this is sent on every call rather than
   * left out.
   */
  readonly storeResponses: boolean;
}

export interface OtpConfig {
  /** When false nothing is sent and every code is `staticCode`. */
  readonly realtimeEnabled: boolean;
  readonly staticCode: string;
}

export interface PlatformAdminConfig {
  readonly enabled: boolean;
  readonly name: string;
  readonly email: string;
  readonly mobile: string;
  readonly password: string;
  /** Deliberate recovery only: overwrite an EXISTING admin's password on boot. */
  readonly forcePasswordReset: boolean;
}

export interface Configuration {
  readonly app: AppConfig;
  readonly database: DatabaseConfig;
  readonly auth: AuthConfig;
  readonly crypto: CryptoConfig;
  readonly verification: Readonly<Record<VerificationKind, VerificationKindConfig>>;
  readonly worker: WorkerConfig;
  readonly meta: MetaConfig;
  readonly gemini: GeminiConfig;
  readonly aiWireCapture: AiWireCaptureConfig;
  readonly openai: OpenAiConfig;
  readonly otp: OtpConfig;
  readonly platformAdmin: PlatformAdminConfig;
}
