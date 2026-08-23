import { ErrorCode } from './error-codes.enum';

/** Postgres error codes we act on, rather than string-matching driver output. */
export const PG_ERROR = {
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  NotNullViolation: '23502',
  CheckViolation: '23514',
  /** Retryable: the transaction lost a serialisation race. */
  SerializationFailure: '40001',
  /** Retryable: deadlock; one side is chosen as the victim. */
  DeadlockDetected: '40P01',
  QueryCanceled: '57014',
  LockNotAvailable: '55P03',
} as const;

/** Exactly the two classes of failure a retry can fix. */
export const RETRYABLE_PG_ERRORS: readonly string[] = [
  PG_ERROR.SerializationFailure,
  PG_ERROR.DeadlockDetected,
] as const;

/**
 * Constraint name → domain error, so a unique violation becomes a typed error
 * ONCE, in the repository layer, and callers never string-match driver output
 * (backend-design.md §6.3).
 *
 * Keys are the index names declared in the migrations.
 */
export const CONSTRAINT_ERROR: Readonly<Record<string, ErrorCode>> = {
  identities_email_uniq: ErrorCode.EmailAlreadyRegistered,
  identities_mobile_uniq: ErrorCode.MobileAlreadyRegistered,
  enterprises_slug_uniq: ErrorCode.EnterpriseSlugTaken,
  enterprises_email_uniq: ErrorCode.EnterpriseEmailAlreadyRegistered,
  enterprise_employees_enterprise_identity_uniq: ErrorCode.EmployeeAlreadyExists,
  roles_enterprise_name_uniq: ErrorCode.RoleNameTaken,
  roles_global_name_uniq: ErrorCode.RoleNameTaken,
  enterprise_features_uniq: ErrorCode.FeatureAlreadyRequested,
  customer_identifiers_value_uniq: ErrorCode.IdentifierAlreadyLinked,
  messages_idempotency_uniq: ErrorCode.DuplicateMessage,
  messages_platform_uniq: ErrorCode.DuplicateMessage,
  sync_jobs_live_uniq: ErrorCode.SyncAlreadyRunning,
  /*
   * Two simultaneous logins for one address race the supersede-then-insert pair,
   * and one of them loses on this index. Unmapped, that surfaced as a 500
   * INTERNAL_ERROR on a perfectly ordinary double-click.
   */
  verifications_live_uniq: ErrorCode.VerificationAlreadyPending,
};

interface PostgresErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly table?: string;
}

export function asPostgresError(error: unknown): PostgresErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as PostgresErrorShape;
  return typeof candidate.code === 'string' ? candidate : null;
}

export function isRetryablePostgresError(error: unknown): boolean {
  const pg = asPostgresError(error);
  return pg?.code !== undefined && RETRYABLE_PG_ERRORS.includes(pg.code);
}

/** Returns the domain code for a unique violation on a known constraint. */
export function mapConstraintViolation(error: unknown): ErrorCode | null {
  const pg = asPostgresError(error);
  if (pg?.code !== PG_ERROR.UniqueViolation || !pg.constraint) return null;
  return CONSTRAINT_ERROR[pg.constraint] ?? null;
}
