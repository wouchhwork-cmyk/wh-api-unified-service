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
    if (existing) return existing;

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
  async listDirectory(
    enterpriseId: number,
    limit: number,
    cursor: { lastSeenAt: Date; id: number } | null,
  ): Promise<
    {
      id: number;
      refId: string;
      displayName: string | null;
      lastSeenAt: Date | null;
      conversationCount: number;
    }[]
  > {
    const params: unknown[] = [this.requireEnterprise(enterpriseId), limit];
    let keyset = '';
    if (cursor) {
      // Keyset pagination on the same columns the index is built on, with id as
      // the stable tiebreaker, so a page can neither skip nor repeat a row.
      keyset = `AND (last_seen_at, id) < ($3, $4)`;
      params.push(cursor.lastSeenAt, cursor.id);
    }

    return this.query(
      `SELECT id, ref_id AS "refId", display_name AS "displayName",
              last_seen_at AS "lastSeenAt", conversation_count AS "conversationCount"
         FROM customers
        WHERE enterprise_id = $1
          AND status <> 'merged'
          AND is_deleted = false
          ${keyset}
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
