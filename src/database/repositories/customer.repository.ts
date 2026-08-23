import { Injectable } from '@nestjs/common';
import {
  HANDLE_IDENTIFIER_KINDS,
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
  readonly firstName: string | null;
  readonly lastName: string | null;
  /**
   * The platform handle, read from customer_identifiers rather than the customer
   * row — it IS an identifier, and duplicating it onto customers would leave two
   * copies to disagree.
   */
  readonly handle: string | null;
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
    /*
     * The handle kinds are parameter $3 ALWAYS, before any conditional filter.
     * Numbering them after the optional search term made $3 mean different
     * things depending on the arguments, which is how a query silently reads the
     * wrong parameter.
     */
    const params: unknown[] = [
      this.requireEnterprise(input.enterpriseId),
      input.limit,
      [...HANDLE_IDENTIFIER_KINDS],
    ];
    const filters: string[] = [];

    if (input.search) {
      // A CONTAINS match, which normally forbids an index — customers_name_trgm_idx
      // (gin_trgm_ops) exists precisely for this shape.
      params.push(`%${input.search}%`);
      /*
       * Handles are searched as well as names. Somebody looking for a customer
       * types what they saw, and on Instagram what they saw was the handle —
       * matching only display_name would miss anyone whose name we know but
       * whose handle was what the agent remembered.
       */
      filters.push(
        `AND (
             display_name ILIKE $${params.length}
          OR EXISTS (
               SELECT 1 FROM customer_identifiers ci
                WHERE ci.customer_id = customers.id
                  AND ci.enterprise_id = customers.enterprise_id
                  AND ci.identifier_kind = ANY($3)
                  AND ci.identifier_value ILIKE $${params.length}
                  AND ci.is_deleted = false
             )
        )`,
      );
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
              first_name AS "firstName", last_name AS "lastName",
              /*
               * The handle, taken from the identifier that holds it. LIMIT 1 with
               * a deterministic order so a customer who somehow has two never
               * returns a different one per request.
               */
              (SELECT ci.identifier_value
                 FROM customer_identifiers ci
                WHERE ci.customer_id = customers.id
                  AND ci.enterprise_id = customers.enterprise_id
                  AND ci.identifier_kind = ANY($3)
                  AND ci.is_deleted = false
                ORDER BY ci.is_primary DESC, ci.id
                LIMIT 1)                    AS "handle",
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

  /**
   * Fills in a customer's name, found by the platform id we already know them by.
   *
   * Separate from the message projection ON PURPOSE. A name comes from the
   * conversation's participants edge, which is profile data about the thread, not
   * content of any message — so tying it to a message event means dedup silences
   * it: the second walk of a thread inserts no new events, the projector never
   * runs, and the customer stays nameless forever.
   *
   * Guarded on display_name IS NULL, so a re-walk can fill a gap but never
   * overwrite a name already held. Returns whether a row was actually named.
   */
  async nameByIdentifier(input: {
    enterpriseId: number;
    identifierKind: IdentifierKind;
    identifierValue: string;
    displayName: string;
    /**
     * Split by the CALLER, not derived here: only the caller knows whether the
     * string is a person's name or a handle, and decomposing
     * "some_handle_99" into a first name is nonsense.
     */
    firstName?: string | null;
    lastName?: string | null;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      /*
       * COALESCE per column rather than one blanket overwrite, so a walk fills
       * the gaps it finds without discarding anything already held.
       *
       * last_name is deliberately absent from the WHERE predicate: plenty of
       * people legitimately have none, and including it would make this update
       * fire on every re-walk forever.
       */
      `UPDATE customers cu
          SET display_name = COALESCE(cu.display_name, $4),
              first_name   = COALESCE(cu.first_name, $5),
              last_name    = COALESCE(cu.last_name, $6),
              updated_at   = now()
        WHERE cu.enterprise_id = $1
          AND (cu.display_name IS NULL OR cu.first_name IS NULL)
          AND cu.is_deleted = false
          AND EXISTS (
            SELECT 1 FROM customer_identifiers ci
             WHERE ci.customer_id = cu.id
               AND ci.enterprise_id = cu.enterprise_id
               AND ci.identifier_kind = $2
               AND ci.identifier_value = $3
               AND ci.is_deleted = false
          )`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.identifierKind,
        input.identifierValue,
        input.displayName,
        input.firstName ?? null,
        input.lastName ?? null,
      ],
    );
    return affected > 0;
  }

  /**
   * Resolves a customer by one of their platform identifiers.
   *
   * Separate from resolveOrCreate because this must NOT create: it answers "do
   * we already know this person" for callers that only want to enrich a record
   * they did not open.
   */
  async findIdByIdentifier(input: {
    enterpriseId: number;
    identifierKind: IdentifierKind;
    identifierValue: string;
  }): Promise<number | null> {
    const rows = await this.query<{ id: number }>(
      `SELECT cu.id
         FROM customers cu
         JOIN customer_identifiers ci ON ci.customer_id = cu.id
                                     AND ci.enterprise_id = cu.enterprise_id
        WHERE cu.enterprise_id = $1
          AND cu.is_deleted = false
          AND ci.identifier_kind = $2
          AND ci.identifier_value = $3
          AND ci.is_deleted = false
          /*
           * status = 'active' matters twice over. It is what makes this match
           * customer_identifiers_value_uniq, which is partial on exactly this
           * predicate — so without it the query cannot use the index. And a
           * RELEASED identifier is one a carrier reassigned: the whole point of
           * that status is that the value may now belong to somebody else, and
           * a LIMIT 1 with no ORDER BY was free to return either of them.
           */
          AND ci.status = $4
        LIMIT 1`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.identifierKind,
        input.identifierValue,
        IdentifierStatus.Active,
      ],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Records an ADDITIONAL way to reach the same person — an Instagram handle
   * alongside the numeric id, say.
   *
   * Never primary: the id is what the platform keys on and what survives a
   * rename, so a handle is a label, not the identity. The schema anticipated
   * instagram_username and nothing had ever written one.
   *
   * ON CONFLICT DO NOTHING against the same partial unique index resolveOrCreate
   * uses, so re-walking a thread is idempotent. A handle that later belongs to
   * somebody else is a known limitation of storing handles at all, which is
   * exactly why it is not the identity.
   */
  async linkIdentifier(input: {
    enterpriseId: number;
    customerId: number;
    identifierKind: IdentifierKind;
    identifierValue: string;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      `INSERT INTO customer_identifiers
         (enterprise_id, customer_id, identifier_kind, identifier_value, identifier_value_raw,
          is_primary, verification_status, source, first_seen_at, last_seen_at, status)
       VALUES ($1, $2, $3, $4, $4, false, $5, $6, now(), now(), 'active')
       ON CONFLICT (enterprise_id, identifier_kind, identifier_value)
         WHERE status = 'active' AND is_deleted = false
       DO NOTHING
       -- Without RETURNING, an INSERT reports zero affected rows whether it
       -- inserted or not, so this method claimed "already linked" every single
       -- time, including the time it did the linking.
       RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.customerId,
        input.identifierKind,
        input.identifierValue,
        IdentifierVerificationStatus.Verified,
        IdentifierSource.Platform,
      ],
    );
    return affected > 0;
  }
}
