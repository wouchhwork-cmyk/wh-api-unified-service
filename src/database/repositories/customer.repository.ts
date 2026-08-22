import { Injectable } from '@nestjs/common';
import {
  CustomerFirstSource,
  CustomerStatus,
  IdentifierKind,
  IdentifierSource,
  IdentifierStatus,
  IdentifierVerificationStatus,
  Platform,
} from '@/shared/enums';
import { BaseRepository } from './base.repository';

export interface ResolveIdentifierInput {
  readonly enterpriseId: number;
  readonly identifierKind: IdentifierKind;
  /** The NORMALIZED canonical value — never the raw form. */
  readonly identifierValue: string;
}

export interface CustomerResolution {
  readonly customerId: number;
  readonly identifierId: number;
  readonly created: boolean;
}

export interface CreateCustomerInput extends ResolveIdentifierInput {
  readonly identifierValueRaw: string | null;
  readonly displayName: string | null;
  readonly firstSource: CustomerFirstSource;
  readonly firstChannelId: number | null;
  readonly source: IdentifierSource;
  readonly verificationStatus: IdentifierVerificationStatus;
}

export interface CustomerDirectoryRow {
  readonly id: number;
  readonly refId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly firstSource: string | null;
  readonly conversationCount: number;
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly status: string;
  readonly isBlocked: boolean;
}

@Injectable()
export class CustomerRepository extends BaseRepository {
  /**
   * THE hot lookup: resolve an inbound identifier to a customer, within one
   * enterprise. One index probe on customer_identifiers_value_uniq, and the
   * predicate matches the index exactly (active, not deleted).
   */
  async findByIdentifier(input: ResolveIdentifierInput): Promise<CustomerResolution | null> {
    const rows = await this.query<{ customer_id: number; id: number }>(
      `SELECT customer_id, id
         FROM customer_identifiers
        WHERE enterprise_id = $1
          AND identifier_kind = $2
          AND identifier_value = $3
          AND status = 'active'
          AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(input.enterpriseId), input.identifierKind, input.identifierValue],
    );
    const row = rows[0];
    return row ? { customerId: row.customer_id, identifierId: row.id, created: false } : null;
  }

  /**
   * Resolves an inbound identifier, creating the customer if it is new.
   *
   * The ON CONFLICT path is what matters: a burst of comments from a first-time
   * customer arrives concurrently, and without it two events would each create a
   * customer record that then needs merging. The conflict target repeats the
   * partial index predicate, because Postgres cannot infer a partial index from
   * the column list.
   *
   * Runs inside the caller's transaction; it opens none of its own.
   */
  async resolveOrCreate(input: CreateCustomerInput): Promise<CustomerResolution> {
    const existing = await this.findByIdentifier(input);
    if (existing) {
      /*
       * Backfill the name once we learn it, and only then.
       *
       * A customer first seen through a direct message has NO name: Meta's
       * messaging payload carries a sender id and nothing else. The same person
       * commenting later does carry a username — but resolveOrCreate returned
       * early, so that name was thrown away and the directory showed a blank row
       * forever.
       *
       * Guarded on display_name IS NULL so a later, poorer source can never
       * overwrite a name we already hold, and skipped entirely when this event
       * brought no name.
       */
      if (input.displayName) {
        await this.mutate(
          `UPDATE customers
              SET display_name = $2, updated_at = now()
            WHERE id = $1 AND enterprise_id = $3 AND display_name IS NULL`,
          [existing.customerId, input.displayName, this.requireEnterprise(input.enterpriseId)],
        );
      }
      return existing;
    }

    const enterpriseId = this.requireEnterprise(input.enterpriseId);

    const customerRows = await this.mutate<{ id: number }>(
      `INSERT INTO customers
         (enterprise_id, display_name, first_source, first_channel_id, last_channel_id,
          first_seen_at, last_seen_at, status)
       VALUES ($1, $2, $3, $4, $4, now(), now(), $5)
       RETURNING id`,
      [
        enterpriseId,
        input.displayName,
        input.firstSource,
        input.firstChannelId,
        CustomerStatus.Active,
      ],
    );
    const customerId = customerRows.rows[0]?.id;
    if (customerId === undefined) throw new Error('customers insert returned no row');

    const identifierRows = await this.mutate<{ id: number; customer_id: number }>(
      `INSERT INTO customer_identifiers
         (enterprise_id, customer_id, identifier_kind, identifier_value, identifier_value_raw,
          is_primary, verification_status, source, first_seen_at, last_seen_at, status)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, now(), now(), $8)
       ON CONFLICT (enterprise_id, identifier_kind, identifier_value)
         WHERE status = 'active' AND is_deleted = false
       DO NOTHING
       RETURNING id, customer_id`,
      [
        enterpriseId,
        customerId,
        input.identifierKind,
        input.identifierValue,
        input.identifierValueRaw,
        input.verificationStatus,
        input.source,
        IdentifierStatus.Active,
      ],
    );

    const identifier = identifierRows.rows[0];
    if (identifier) {
      return { customerId, identifierId: identifier.id, created: true };
    }

    /*
     * The conflict fired: a concurrent event created this identifier between our
     * lookup and our insert. The customer row we just wrote is an orphan, so it
     * is removed and the winner's row is used. Deleting is safe because nothing
     * references it yet — it was created microseconds ago inside this
     * transaction.
     */
    await this.mutate(`DELETE FROM customers WHERE id = $1 AND enterprise_id = $2`, [
      customerId,
      enterpriseId,
    ]);

    const winner = await this.findByIdentifier(input);
    if (!winner) throw new Error('identifier conflicted but could not be resolved');
    return winner;
  }

  /** Keeps the directory's sort key and default reply target current. */
  async touchLastSeen(
    enterpriseId: number,
    customerId: number,
    channelId: number | null,
  ): Promise<void> {
    await this.mutate(
      `UPDATE customers
          SET last_seen_at = now(),
              last_channel_id = COALESCE($3, last_channel_id)
        WHERE id = $2 AND enterprise_id = $1`,
      [this.requireEnterprise(enterpriseId), customerId, channelId],
    );
  }

  /**
   * Records where a customer engages, and how much.
   *
   * Maintained by the projector rather than aggregated on read: computing it
   * would mean scanning the two largest domain tables on every customer list
   * render. The conflict target matches customer_engagements_uniq.
   */
  async recordEngagement(input: {
    enterpriseId: number;
    customerId: number;
    channelId: number;
    platform: Platform;
    inbound: boolean;
    conversationId: number | null;
  }): Promise<void> {
    await this.mutate(
      `INSERT INTO customer_engagements
         (enterprise_id, customer_id, channel_id, platform, first_engaged_at, last_engaged_at,
          inbound_message_count, outbound_message_count, last_conversation_id)
       VALUES ($1, $2, $3, $4, now(), now(), $5, $6, $7)
       ON CONFLICT (enterprise_id, customer_id, channel_id) WHERE is_deleted = false
       DO UPDATE SET
         last_engaged_at        = now(),
         inbound_message_count  = customer_engagements.inbound_message_count + $5,
         outbound_message_count = customer_engagements.outbound_message_count + $6,
         last_conversation_id   = COALESCE(EXCLUDED.last_conversation_id,
                                           customer_engagements.last_conversation_id)`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.customerId,
        input.channelId,
        input.platform,
        input.inbound ? 1 : 0,
        input.inbound ? 0 : 1,
        input.conversationId,
      ],
    );
  }

  /** The customer directory, newest activity first, cursor-paginated. */
  async listDirectory(input: {
    enterpriseId: number;
    search: string | null;
    limit: number;
    cursor: { lastSeenAt: Date | null; id: number } | null;
  }): Promise<CustomerDirectoryRow[]> {
    const params: unknown[] = [this.requireEnterprise(input.enterpriseId), input.limit];
    const filters: string[] = [];

    if (input.search) {
      // A CONTAINS match, which normally forbids an index — customers_name_trgm_idx
      // (gin_trgm_ops) exists precisely for this shape.
      params.push(`%${input.search}%`);
      filters.push(`AND display_name ILIKE $${params.length}`);
    }
    if (input.cursor) {
      params.push(input.cursor.lastSeenAt, input.cursor.id);
      const at = `$${params.length - 1}::timestamptz`;
      const id = `$${params.length}`;
      /*
       * The null case is handled EXPLICITLY. The previous `(last_seen_at, id) <
       * ($3, $4)` looked right, but row comparison against NULL yields NULL, so
       * with ORDER BY ... NULLS LAST every customer who had never been seen was
       * silently dropped from page two onward — the exact rows that sort last.
       */
      filters.push(
        `AND (
             (${at} IS NOT NULL AND last_seen_at IS NOT NULL
                AND (last_seen_at, id) < (${at}, ${id}))
          OR (${at} IS NOT NULL AND last_seen_at IS NULL)
          OR (${at} IS NULL AND last_seen_at IS NULL AND id < ${id})
        )`,
      );
    }

    return this.query<CustomerDirectoryRow>(
      `SELECT id, ref_id AS "refId", display_name AS "displayName",
              avatar_url AS "avatarUrl", first_source AS "firstSource",
              /*
               * COUNTED, not read from customers.conversation_count: that column
               * is declared DEFAULT 0 and no code has ever written to it, so
               * returning it would report 0 for every customer forever. The
               * subquery is an index-only probe of conversations_customer_idx
               * (enterprise_id, customer_id, ...), and a computed count cannot
               * drift the way a denormalised counter does.
               */
              (SELECT count(*) FROM conversations cv
                WHERE cv.enterprise_id = customers.enterprise_id
                  AND cv.customer_id = customers.id
                  AND cv.is_deleted = false)  AS "conversationCount",
              first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
              status, (blocked_at IS NOT NULL) AS "isBlocked"
         FROM customers
        WHERE enterprise_id = $1
          AND status <> 'merged'
          AND is_deleted = false
          AND merged_into_customer_id IS NULL
          ${filters.join('\n          ')}
        ORDER BY last_seen_at DESC NULLS LAST, id DESC
        LIMIT $2`,
      params,
    );
  }

  /** Trigram search. ILIKE '%x%' over a million rows per keystroke is not survivable. */
  async searchByName(
    enterpriseId: number,
    term: string,
    limit: number,
  ): Promise<{ id: number; refId: string; displayName: string | null }[]> {
    return this.query(
      `SELECT id, ref_id AS "refId", display_name AS "displayName"
         FROM customers
        WHERE enterprise_id = $1
          AND display_name ILIKE '%' || $2 || '%'
          AND status <> 'merged'
          AND is_deleted = false
        ORDER BY last_seen_at DESC NULLS LAST, id DESC
        LIMIT $3`,
      [this.requireEnterprise(enterpriseId), term, limit],
    );
  }
}
