import { z } from 'zod';
import { ErrorCode } from '@/shared/errors';

/**
 * ONE envelope for every response, success or failure (backend-design.md §8.1).
 *
 * `success` is redundant with the HTTP status and kept deliberately: clients
 * branch on one boolean instead of a status-code range, which is a common source
 * of bugs where a proxy-generated 502 gets treated as success.
 */
export interface PaginationMeta {
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ResponseMeta {
  readonly requestId: string;
  readonly timestamp: string;
  readonly pagination?: PaginationMeta;
}

export interface SuccessEnvelope<T> {
  readonly success: true;
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface ErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: readonly { field?: string | undefined; issue: string }[];
  };
  readonly meta: ResponseMeta;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** A paginated list, as services return it before the interceptor wraps it. */
export interface Paginated<T> {
  readonly items: readonly T[];
  readonly pagination: PaginationMeta;
}

export const PaginationMetaSchema = z.object({
  limit: z.number().int().positive(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const ResponseMetaSchema = z.object({
  requestId: z.string(),
  timestamp: z.string(),
  pagination: PaginationMetaSchema.optional(),
});

export const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.enum(ErrorCode),
    message: z.string(),
    details: z.array(z.object({ field: z.string().optional(), issue: z.string() })).optional(),
  }),
  meta: ResponseMetaSchema,
});

/** Marks a service result as already paginated, so the interceptor lifts it. */
export function paginated<T>(items: readonly T[], pagination: PaginationMeta): Paginated<T> {
  return { items, pagination };
}

export function isPaginated<T>(value: unknown): value is Paginated<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Paginated<T>).items) &&
    typeof (value as Paginated<T>).pagination === 'object'
  );
}

/**
 * A result that is NOT itself a list but carries a page of one.
 *
 * The conversation thread is the case: its payload is a conversation AND its
 * messages, so it cannot be a bare `Paginated`. Without this it put its
 * pagination in `data.pagination` while every other list put it in
 * `meta.pagination` — one envelope with two shapes, which a client has to learn
 * per endpoint.
 */
export interface PaginatedWithin {
  readonly pagination: PaginationMeta;
}

export function carriesPagination(value: unknown): value is PaginatedWithin {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as PaginatedWithin).pagination === 'object' &&
    (value as PaginatedWithin).pagination !== null
  );
}
