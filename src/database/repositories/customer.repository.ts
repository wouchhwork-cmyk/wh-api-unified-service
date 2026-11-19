import { Injectable } from '@nestjs/common';
import {
  ACCOUNT_IDENTIFIER_KINDS_BY_PLATFORM,
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
import { platformIdentityJoin } from './customer-identity.sql';

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
  /**
   * Somebody is waiting for a person on this one.
   *
   * ON THE LIST, not only on the record. A flag you have to open thirty
   * customers to find is a flag nobody acts on.
   */
  /**
   * Waiting for a person on AT LEAST ONE of their inboxes.
   *
   * Both switches are per channel; a directory row is per person. A list
   * answers "is there anything here", and the conversation answers where.
   */
  readonly needsHuman: boolean;
  /**
   * The assistant is quiet on at least one of their inboxes.
   *
   * ON THE LIST for the reason `needsHuman` is: a pause nobody can see is a
   * pause nobody lifts, and an assistant silently off looks exactly like one
   * that is broken.
   */
  readonly automationPaused: boolean;
}

/**
 * What the assistant is told about the person it is answering.
 *
 * DELIBERATELY NOT EVERYTHING ON THE ROW. `notes` and `tags` are colleagues
 * writing to each other about a customer, and this codebase already decided
 * once what happens when a model is handed those — internal notes are
 * skipped when a thread is read, because "a model given them will quote them
 * back to that customer". A tag reading `chargeback risk` is the same
 * hazard in fewer words.
 *
 * What is here is what the person already knows about themselves: their
 * name, the language they use, and the fact that they have written before.
 *
 * `timezone` and `first_seen_at` were selected here and never read by
 * anything. Harmless in that they reached a service rather than a model, and
 * dropped anyway: personal data fetched for no purpose is how a field ends
 * up used later because it was already there.
 */
/** What this business holds about somebody, as opposed to what a platform says. */
export interface OwnIdentity {
  readonly displayName: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

export interface AssistantCustomerRow {
  /**
   * WHERE A NAME CAME FROM, KEPT APART — and this used to be one COALESCE.
   *
   * Collapsed, the assistant cannot tell a name this business recorded from
   * a handle somebody picked on Instagram, so it states a handle as a fact
   * about a person: asked "what's my name?", it answered "Your name is
   * genzrelics". That is not their name, nobody told us it was, and the
   * customer is the one person who knows it is wrong.
   *
   * The two are genuinely different claims. Ours was typed by a colleague
   * about a customer; the platform's is what they call themselves in public,
   * and the handle is not even that — it is an address.
   */
  readonly ownDisplayName: string | null;
  readonly ownFirstName: string | null;
  readonly platformDisplayName: string | null;
  readonly platformFirstName: string | null;
  /** The @handle on the account this conversation is with. An address. */
  readonly handle: string | null;
  /**
   * What the platform says about them — follows, verified, follower count.
   *
   * The raw bag rather than named columns: it is written by whatever last
   * learned something, a missing key means "we were not told" rather than
   * "no", and naming them here would make every new signal a migration.
   */
  readonly platformMetadata: Record<string, unknown> | null;
  readonly preferredLanguage: string | null;
  readonly locale: string | null;
  readonly conversationCount: number;
}

@Injectable()
export class CustomerRepository extends BaseRepository {
  /**
   * THE hot lookup: resolve an inbound identifier to a customer, within one
   * enterprise. One index probe on customer_identifiers_value_uniq, and the
   * predicate matches the index exactly (active, not deleted).
   */
  /**
   * A customer by their public handle, scoped to the tenant.
   *
   * `first_seen_at` comes back because the reward engine's tenure condition
   * needs it, and fetching it here saves a second round trip on a path that
   * already has the row open.
   */
  async findByRefId(
    enterpriseId: number,
    refId: string,
  ): Promise<{ id: number; refId: string; firstSeenAt: Date | null } | null> {
    const rows = await this.query<{ id: number; refId: string; firstSeenAt: Date | null }>(
      `SELECT id, ref_id AS "refId", first_seen_at AS "firstSeenAt"
         FROM customers
        WHERE enterprise_id = $1 AND ref_id = $2 AND is_deleted = false`,
      [enterpriseId, refId],
    );
    return rows[0] ?? null;
  }

  /**
   * When we first saw this customer, by internal id.
   *
   * Fetched LAZILY by the reward evaluator — only when a rule actually carries
   * a tenure condition. Loading it on every projected event to serve a
   * condition most rules do not use would be a query per message for nothing.
   */
  async findFirstSeenAt(enterpriseId: number, customerId: number): Promise<Date | null> {
    const rows = await this.query<{ firstSeenAt: Date | null }>(
      `SELECT first_seen_at AS "firstSeenAt"
         FROM customers
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false`,
      [enterpriseId, customerId],
    );
    return rows[0]?.firstSeenAt ?? null;
  }

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
    /**
     * Whether this message OPENED the conversation.
     *
     * conversation_count sat at 0 next to message counts that were being
     * maintained properly, so the one number saying "how many separate threads
     * has this person started on this channel" was the one number that was
     * wrong. It cannot be derived here — every message would look like a new
     * thread — so the caller, which just upserted the conversation, says.
     */
    conversationCreated?: boolean;
  }): Promise<void> {
    await this.mutate(
      `INSERT INTO customer_engagements
         (enterprise_id, customer_id, channel_id, platform, first_engaged_at, last_engaged_at,
          inbound_message_count, outbound_message_count, conversation_count, last_conversation_id)
       VALUES ($1, $2, $3, $4, now(), now(), $5, $6, $8, $7)
       ON CONFLICT (enterprise_id, customer_id, channel_id) WHERE is_deleted = false
       DO UPDATE SET
         last_engaged_at        = now(),
         inbound_message_count  = customer_engagements.inbound_message_count + $5,
         outbound_message_count = customer_engagements.outbound_message_count + $6,
         conversation_count     = customer_engagements.conversation_count + $8,
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
        input.conversationCreated === true ? 1 : 0,
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
       * THREE PLACES A NAME CAN BE, and all three are searched.
       *
       * What this business holds, what the platform calls them, and the
       * handle. The middle one became load-bearing when names moved to their
       * own table: searching only `customers.display_name` would return
       * nothing for every customer who arrived through Instagram, which is
       * all of them — silently, with no error to explain it.
       *
       * The handle is here because somebody looking for a customer types
       * what they saw, and on Instagram what they saw was the handle.
       */
      filters.push(
        `AND (
             cu.display_name ILIKE $${params.length}
          OR EXISTS (
               SELECT 1 FROM customer_platform_profiles pp
                WHERE pp.enterprise_id = cu.enterprise_id
                  AND pp.customer_id = cu.id
                  AND pp.is_deleted = false
                  AND pp.display_name ILIKE $${params.length}
             )
          OR EXISTS (
               SELECT 1 FROM customer_identifiers ci
                WHERE ci.customer_id = cu.id
                  AND ci.enterprise_id = cu.enterprise_id
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
             (${at} IS NOT NULL AND cu.last_seen_at IS NOT NULL
                AND (cu.last_seen_at, cu.id) < (${at}, ${id}))
          OR (${at} IS NOT NULL AND cu.last_seen_at IS NULL)
          OR (${at} IS NULL AND cu.last_seen_at IS NULL AND cu.id < ${id})
        )`,
      );
    }

    return this.query<CustomerDirectoryRow>(
      `SELECT cu.id, cu.ref_id AS "refId",
              /*
               * OURS FIRST, THE PLATFORM'S SECOND. The customer row is what
               * this business holds; the profile is what Instagram or
               * Facebook calls them. A name typed here outranks a platform's
               * permanently and is never overwritten by a refresh.
               *
               * No account is preferred: a directory is not rendering a
               * conversation, so the freshest profile is the right answer.
               */
              COALESCE(cu.display_name, cpp.display_name) AS "displayName",
              COALESCE(cu.first_name, cpp.first_name) AS "firstName",
              COALESCE(cu.last_name, cpp.last_name) AS "lastName",
              /*
               * The handle, taken from the identifier that holds it. LIMIT 1 with
               * a deterministic order so a customer who somehow has two never
               * returns a different one per request.
               */
              (SELECT ci.identifier_value
                 FROM customer_identifiers ci
                WHERE ci.customer_id = cu.id
                  AND ci.enterprise_id = cu.enterprise_id
                  AND ci.identifier_kind = ANY($3)
                  AND ci.is_deleted = false
                ORDER BY ci.is_primary DESC, ci.id
                LIMIT 1)                    AS "handle",
              COALESCE(cu.avatar_url, cpp.avatar_url) AS "avatarUrl",
              cu.first_source AS "firstSource",
              /*
               * COUNTED, not read from customers.conversation_count: that column
               * is declared DEFAULT 0 and no code has ever written to it, so
               * returning it would report 0 for every customer forever. The
               * subquery is an index-only probe of conversations_customer_idx
               * (enterprise_id, customer_id, ...), and a computed count cannot
               * drift the way a denormalised counter does.
               */
              (SELECT count(*) FROM conversations cv
                WHERE cv.enterprise_id = cu.enterprise_id
                  AND cv.customer_id = cu.id
                  AND cv.is_deleted = false)  AS "conversationCount",
              cu.first_seen_at AS "firstSeenAt", cu.last_seen_at AS "lastSeenAt",
              cu.status, (cu.blocked_at IS NOT NULL) AS "isBlocked",
              /*
               * WAITING SOMEWHERE, AND QUIET SOMEWHERE. Both switches are per
               * connected account and a directory row is per person, so these
               * say only that AT LEAST ONE of their inboxes has a flag on it.
               * That is what a list is for; which inbox, and the buttons to
               * do anything about it, live with the conversation.
               *
               * EXISTS rather than a join: one row is enough to answer each,
               * and joining would multiply a customer by their channels.
               */
              EXISTS (SELECT 1 FROM customer_assistant_states st
                       WHERE st.enterprise_id = cu.enterprise_id
                         AND st.customer_id = cu.id
                         AND st.needs_human = true
                         AND st.is_deleted = false) AS "needsHuman",
              EXISTS (SELECT 1 FROM customer_assistant_states st
                       WHERE st.enterprise_id = cu.enterprise_id
                         AND st.customer_id = cu.id
                         AND st.automation_paused_at IS NOT NULL
                         AND (st.automation_resumes_at IS NULL
                              OR st.automation_resumes_at > now())
                         AND st.is_deleted = false) AS "automationPaused"
         FROM customers cu
         ${platformIdentityJoin({ customer: 'cu', as: 'cpp' })}
        WHERE cu.enterprise_id = $1
          AND cu.status <> 'merged'
          AND cu.is_deleted = false
          AND cu.merged_into_customer_id IS NULL
          ${filters.join('\n          ')}
        ORDER BY cu.last_seen_at DESC NULLS LAST, cu.id DESC
        LIMIT $2`,
      params,
    );
  }

  /**
   * Trigram search over both names.
   *
   * BOTH, BECAUSE THERE ARE NOW TWO. What this business holds about somebody
   * and what a platform calls them are different columns in different
   * tables, and a search that read only the first would return nothing at
   * all for every customer who arrived through Instagram — which is all of
   * them. Silently: no error, no empty result to explain, just a directory
   * that stopped finding people.
   *
   * The platform side is an EXISTS rather than a column on the join above,
   * because a match may be on a profile that is not the freshest — somebody
   * searching an old handle should still find the person who used it.
   *
   * ILIKE '%x%' over a million rows per keystroke is not survivable without
   * the trigram indexes behind both sides.
   */
  async searchByName(
    enterpriseId: number,
    term: string,
    limit: number,
  ): Promise<{ id: number; refId: string; displayName: string | null }[]> {
    return this.query(
      `SELECT cu.id, cu.ref_id AS "refId",
              COALESCE(cu.display_name, cpp.display_name) AS "displayName"
         FROM customers cu
         ${platformIdentityJoin({ customer: 'cu', as: 'cpp' })}
        WHERE cu.enterprise_id = $1
          AND cu.status <> 'merged'
          AND cu.is_deleted = false
          AND (
            cu.display_name ILIKE '%' || $2 || '%'
            OR EXISTS (
              SELECT 1 FROM customer_platform_profiles pp
               WHERE pp.enterprise_id = cu.enterprise_id
                 AND pp.customer_id = cu.id
                 AND pp.is_deleted = false
                 AND pp.display_name ILIKE '%' || $2 || '%'
            )
          )
        ORDER BY cu.last_seen_at DESC NULLS LAST, cu.id DESC
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
  /**
   * Applies a platform profile to a customer: picture, real name, and the
   * facts that have no column of their own.
   *
   * DISTINCT FROM nameByIdentifier, which fills gaps and never overwrites. This
   * one is authoritative — it is the platform's own answer to "who is this",
   * fetched deliberately — so it replaces what is there, EXCEPT where the
   * platform gave nothing.
   *
   * avatar_url is a decaying link: Meta's profile picture URL expires after a
   * few days. `profileFetchedAt` records when it was taken so a refresh knows
   * how stale it is, rather than the UI discovering a broken image.
   */
  /**
   * What a platform says about one account, kept as that platform's own view.
   *
   * IT NO LONGER TOUCHES THE CUSTOMER'S NAME. It used to write
   * `display_name = COALESCE($3, display_name)` straight onto the customer,
   * so the last platform to answer won — and the moment anybody can type a
   * name into this product, the next refresh would overwrite it without a
   * word.
   *
   * THE ACCOUNT IS RESOLVED HERE WHEN THE CALLER CANNOT NAME IT. A thread
   * knows exactly which account it is with and passes that; a profile walk
   * knows only a scoped id, and a conversation recorded before the column
   * was populated knows neither. One rule, in one place: the account id
   * where one exists, the handle where it does not.
   *
   * THE METADATA GOES HERE AND NOWHERE ELSE. It used to be merged onto the
   * customer as well, so the follow flags and follower count of whichever
   * platform answered last overwrote the others — the same collapse the
   * names suffered, in a jsonb bag where nobody would see it happening. A
   * person who follows a business on Instagram and not on Facebook has two
   * true answers, and only a row per account can hold both.
   */
  async applyPlatformProfile(input: {
    enterpriseId: number;
    customerId: number;
    platform: Platform;
    /** The account, when the caller knows it. Resolved below when it does not. */
    customerIdentifierId: number | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    /** follower_count, is_verified_user, the two follow flags. */
    profile: Record<string, unknown>;
  }): Promise<boolean> {
    const enterpriseId = this.requireEnterprise(input.enterpriseId);
    const identifierId =
      input.customerIdentifierId ??
      (await this.accountIdentifierFor(enterpriseId, input.customerId, input.platform));

    /*
     * No account, no profile. A customer reached by something this table
     * cannot attribute — an import, a manual entry — has no platform view to
     * record, and inventing a row for one would be worse than holding none.
     */
    if (identifierId === null) return false;

    const { rows } = await this.mutate<{ id: string }>(
      `INSERT INTO customer_platform_profiles
         (enterprise_id, customer_identifier_id, customer_id, platform,
          display_name, first_name, last_name, avatar_url, metadata, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, now())
       ON CONFLICT (enterprise_id, customer_identifier_id) DO UPDATE
          SET display_name = COALESCE(EXCLUDED.display_name, customer_platform_profiles.display_name),
              first_name   = COALESCE(EXCLUDED.first_name, customer_platform_profiles.first_name),
              last_name    = COALESCE(EXCLUDED.last_name, customer_platform_profiles.last_name),
              avatar_url   = COALESCE(EXCLUDED.avatar_url, customer_platform_profiles.avatar_url),
              /* Merged, not replaced: a refresh that learned one new thing
                 must not erase what an earlier one learned. */
              metadata     = customer_platform_profiles.metadata || EXCLUDED.metadata,
              fetched_at   = now(),
              updated_at   = now()
       RETURNING id`,
      [
        enterpriseId,
        identifierId,
        input.customerId,
        input.platform,
        input.displayName,
        input.firstName,
        input.lastName,
        input.avatarUrl,
        JSON.stringify(input.profile),
      ],
    );

    return rows.length > 0;
  }

  /**
   * Which identifier IS this person's account on a platform.
   *
   * THE ACCOUNT ID BEFORE THE HANDLE. One Instagram account is two rows
   * here — `instagram_user_id` and `instagram_username` — and only the first
   * is stable: people change their handle, and a profile filed under the old
   * one is a profile nobody finds again. The handle answers only where no
   * user id was ever recorded, which happens when a customer was first seen
   * through a comment.
   */
  async accountIdentifierFor(
    enterpriseId: number,
    customerId: number,
    platform: Platform,
  ): Promise<number | null> {
    const kinds = ACCOUNT_IDENTIFIER_KINDS_BY_PLATFORM[platform];
    if (!kinds || kinds.length === 0) return null;

    const rows = await this.query<{ id: string }>(
      `SELECT ci.id
         FROM customer_identifiers ci
        WHERE ci.enterprise_id = $1
          AND ci.customer_id = $2
          AND ci.is_deleted = false
          AND ci.identifier_kind = ANY($3::varchar[])
        ORDER BY (ci.identifier_kind = $4) DESC, ci.id
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), customerId, [...kinds], kinds[0]],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

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
    /**
     * WHERE IT CAME FROM, and therefore how much it can be trusted.
     *
     * Defaulted to what every existing caller means — a handle the platform
     * handed us, which we saw ourselves. A phone number somebody TYPED IN A
     * CHAT is a different thing entirely: nobody checked it, the person who
     * gave it may have mistyped it, and recording it as verified would let
     * it be used for exactly the things verification is supposed to gate.
     */
    source?: IdentifierSource;
    verification?: IdentifierVerificationStatus;
    /**
     * EXACTLY WHAT ARRIVED, when that differs from the canonical form.
     *
     * `identifier_value` is the normalised value every index and lookup
     * uses; this column is what the human actually wrote, kept for display
     * and for support. They were written from the same variable until a
     * customer typed "8888 8888 88" in a chat and both columns got it
     * verbatim — so the stored number matched no lookup, and the raw
     * column recorded nothing the canonical one did not.
     *
     * Absent means the two are the same, which is the ordinary case for a
     * platform-scoped id.
     */
    identifierValueRaw?: string | undefined;
    /**
     * The decomposition, for a phone number.
     *
     * THE SCHEMA HAS ALWAYS HAD THESE THREE COLUMNS and this method has
     * always left them null. They are not decoration: +1 covers twenty
     * territories, so the country is NOT recoverable from the number, and
     * agents search by the national part because that is how locals write
     * it. See `normalizeMobile`, which produces all four together.
     */
    mobile?: { countryCode: string; callingCode: string; nationalNumber: string } | undefined;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      `INSERT INTO customer_identifiers
         (enterprise_id, customer_id, identifier_kind, identifier_value, identifier_value_raw,
          country_code, calling_code, national_number,
          is_primary, verification_status, source, first_seen_at, last_seen_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, now(), now(), 'active')
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
        input.identifierValueRaw ?? input.identifierValue,
        input.mobile?.countryCode ?? null,
        input.mobile?.callingCode ?? null,
        input.mobile?.nationalNumber ?? null,
        input.verification ?? IdentifierVerificationStatus.Verified,
        input.source ?? IdentifierSource.Platform,
      ],
    );
    return affected > 0;
  }
  /**
   * What is needed to decide whether this customer's picture is worth refetching.
   *
   * The Instagram scoped id comes from the identifier table rather than the
   * customer row, because a customer can be reached on more than one platform
   * and only the Instagram one has a profile edge we can read.
   */
  async findAvatarRefreshTarget(
    enterpriseId: number,
    customerId: number,
  ): Promise<{ scopedId: string; avatarUrl: string | null; fetchedAt: Date | null } | null> {
    const rows = await this.query<{
      scopedId: string;
      avatarUrl: string | null;
      /* A real timestamp column now, where it used to be a string dug out of
       * a jsonb bag. The caller compares it rather than parsing it. */
      fetchedAt: Date | null;
    }>(
      /*
       * FROM THE PROFILE, NOT THE CUSTOMER. Both columns this used to read
       * moved: the avatar to the account it belongs to, and the fetch time
       * to a real timestamp column beside it. Left pointing at the customer
       * it would have found null for everybody and concluded that nobody has
       * an avatar worth refreshing — a decision to do nothing, taken
       * silently, on every customer.
       */
      `SELECT ci.identifier_value AS "scopedId",
              pp.avatar_url       AS "avatarUrl",
              pp.fetched_at       AS "fetchedAt"
         FROM customers cu
         JOIN customer_identifiers ci
           ON ci.customer_id = cu.id
          AND ci.enterprise_id = cu.enterprise_id
          AND ci.identifier_kind = $3
          AND ci.is_deleted = false
         LEFT JOIN customer_platform_profiles pp
           ON pp.enterprise_id = ci.enterprise_id
          AND pp.customer_identifier_id = ci.id
          AND pp.is_deleted = false
        WHERE cu.enterprise_id = $1 AND cu.id = $2 AND cu.is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), customerId, IdentifierKind.InstagramUserId],
    );
    return rows[0] ?? null;
  }

  /**
   * The person behind a conversation, for the assistant answering them.
   *
   * One primary-key probe inside the tenant. It runs once per drafted reply,
   * on a path that is already making a model call measured in seconds, so
   * the round trip costs nothing worth saving by folding it into the thread
   * read and making that query serve two masters.
   */
  async assistantProfile(
    enterpriseId: number,
    customerId: number,
    /* The account this conversation is with, so the assistant greets them by
     * the name they are writing under rather than by another platform's. */
    customerIdentifierId: number | null = null,
  ): Promise<AssistantCustomerRow | null> {
    const rows = await this.query<AssistantCustomerRow>(
      `SELECT cu.display_name AS "ownDisplayName",
              cu.first_name AS "ownFirstName",
              cpp.display_name AS "platformDisplayName",
              cpp.first_name AS "platformFirstName",
              handle.identifier_value AS "handle",
              cpp.metadata AS "platformMetadata",
              cu.preferred_language AS "preferredLanguage", cu.locale,
              cu.conversation_count AS "conversationCount"
         FROM customers cu
         ${platformIdentityJoin({ customer: 'cu', as: 'cpp', preferIdentifier: '$3' })}
         /*
          * THE @HANDLE, which is an address rather than a name and has to be
          * offered as one. Newest first so a rename wins, and only the kinds
          * that actually hold a handle — an Instagram user id is an opaque
          * scoped number nobody would ever be called.
          */
         LEFT JOIN LATERAL (
           SELECT ci.identifier_value
             FROM customer_identifiers ci
            WHERE ci.enterprise_id = cu.enterprise_id
              AND ci.customer_id = cu.id
              AND ci.identifier_kind = ANY($4::varchar[])
              AND ci.is_deleted = false
            ORDER BY ci.updated_at DESC, ci.id DESC
            LIMIT 1
         ) handle ON true
        WHERE cu.enterprise_id = $1 AND cu.id = $2 AND cu.is_deleted = false
        LIMIT 1`,
      [
        this.requireEnterprise(enterpriseId),
        customerId,
        customerIdentifierId,
        [...HANDLE_IDENTIFIER_KINDS],
      ],
    );
    return rows[0] ?? null;
  }
  /**
   * Everything this business holds about one customer, for somebody
   * checking it.
   *
   * WHOSE EACH FACT IS, kept apart all the way through. The directory
   * resolves a single name because a list needs one; this is the page
   * somebody opens to find out whether a name came from a colleague, from
   * the platform, or from the assistant recording what a customer said —
   * and collapsing the three is exactly what makes that unanswerable.
   */
  async fullProfile(
    enterpriseId: number,
    refId: string,
  ): Promise<{
    id: number;
    refId: string;
    ownDisplayName: string | null;
    ownFirstName: string | null;
    ownLastName: string | null;
    platformDisplayName: string | null;
    platformFirstName: string | null;
    platformLastName: string | null;
    avatarUrl: string | null;
    platformMetadata: Record<string, unknown> | null;
    preferredLanguage: string | null;
    locale: string | null;
    firstSource: string | null;
    conversationCount: number;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
    status: string | null;
  } | null> {
    const rows = await this.query<{
      id: string;
      refId: string;
      ownDisplayName: string | null;
      ownFirstName: string | null;
      ownLastName: string | null;
      platformDisplayName: string | null;
      platformFirstName: string | null;
      platformLastName: string | null;
      avatarUrl: string | null;
      platformMetadata: Record<string, unknown> | null;
      preferredLanguage: string | null;
      locale: string | null;
      firstSource: string | null;
      conversationCount: number;
      firstSeenAt: Date | null;
      lastSeenAt: Date | null;
      status: string | null;
    }>(
      `SELECT cu.id, cu.ref_id AS "refId",
              cu.display_name AS "ownDisplayName",
              cu.first_name AS "ownFirstName",
              cu.last_name AS "ownLastName",
              cpp.display_name AS "platformDisplayName",
              cpp.first_name AS "platformFirstName",
              cpp.last_name AS "platformLastName",
              COALESCE(cu.avatar_url, cpp.avatar_url) AS "avatarUrl",
              cpp.metadata AS "platformMetadata",
              cu.preferred_language AS "preferredLanguage",
              cu.locale, cu.first_source AS "firstSource",
              cu.conversation_count AS "conversationCount",
              cu.first_seen_at AS "firstSeenAt", cu.last_seen_at AS "lastSeenAt",
              cu.status
         FROM customers cu
         ${platformIdentityJoin({ customer: 'cu', as: 'cpp' })}
        WHERE cu.enterprise_id = $1 AND cu.ref_id = $2::uuid AND cu.is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), refId],
    );

    const row = rows[0];
    return row
      ? {
          ...row,
          id: Number(row.id),
          conversationCount: Number(row.conversationCount),
        }
      : null;
  }

  /**
   * Every way this customer is known or reachable, with where it came from.
   *
   * ALL KINDS, unlike `contactIdentifiers` — somebody verifying a record
   * wants to see the platform ids and handles too, because "which account
   * is this" is half of what they are checking. The source and the
   * verification come back with each, which is the whole point: a number
   * the assistant recorded from a chat and one a colleague confirmed are
   * the same string and not the same fact.
   */
  /**
   * Takes a contact detail off a customer's record.
   *
   * RELEASED, NOT DELETED. The row stays with `released_at` set and its
   * status changed, because "this number was on their record until Tuesday"
   * is a fact somebody will need — a colleague who rang it, a message sent
   * to it — and a DELETE makes that unanswerable. It also frees the value:
   * the partial unique index covers active rows only, so the same number can
   * later be added to whoever actually owns it.
   *
   * PLATFORM IDS ARE NOT RELEASABLE HERE. A scoped id or a handle is how a
   * conversation is addressed, not a detail somebody typed, and removing one
   * would orphan the thread rather than tidy a record. The caller passes the
   * kind and this refuses anything that is not a contact.
   */
  /**
   * Whether a person is waiting here, and whether the assistant has been
   * told to be quiet here.
   *
   * SCOPED TO A CHANNEL, because both switches are. A colleague who pauses
   * the assistant to type to somebody on one account has said nothing about
   * the other accounts that person also writes to.
   *
   * A MISSING ROW IS THE ORDINARY STATE, not an error: nobody waiting, the
   * assistant answering. Rows exist only where somebody changed something,
   * so the overwhelming majority of customers never have one.
   *
   * THE PAUSE IS DECIDED IN SQL. "Paused" is two columns and the clock — a
   * resume time already past means it has come back — and a caller
   * rebuilding that would eventually get it right in one place and wrong in
   * another.
   */
  async assistantState(
    enterpriseId: number,
    customerId: number,
    channelId: number,
  ): Promise<{
    needsHuman: boolean;
    needsHumanReason: string | null;
    needsHumanSince: Date | null;
    /** When a colleague last marked a handoff here as handled. */
    resolvedAt: Date | null;
    paused: boolean;
    resumesAt: Date | null;
  }> {
    const rows = await this.query<{
      needsHuman: boolean;
      needsHumanReason: string | null;
      needsHumanSince: Date | null;
      resolvedAt: Date | null;
      paused: boolean;
      resumesAt: Date | null;
    }>(
      `SELECT needs_human AS "needsHuman",
              needs_human_reason AS "needsHumanReason",
              needs_human_since AS "needsHumanSince",
              needs_human_resolved_at AS "resolvedAt",
              (automation_paused_at IS NOT NULL
                AND (automation_resumes_at IS NULL OR automation_resumes_at > now())) AS "paused",
              automation_resumes_at AS "resumesAt"
         FROM customer_assistant_states
        WHERE enterprise_id = $1 AND customer_id = $2 AND channel_id = $3
          AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), customerId, channelId],
    );
    return (
      rows[0] ?? {
        needsHuman: false,
        needsHumanReason: null,
        needsHumanSince: null,
        resolvedAt: null,
        paused: false,
        resumesAt: null,
      }
    );
  }

  /**
   * Records that somebody needs a person here, or that one has been.
   *
   * UPSERT, because the row may not exist: a customer gets one the first
   * time anybody changes anything about them on a channel.
   *
   * RAISING DOES NOT RESET THE CLOCK. `needs_human_since` is how long they
   * have waited, which is the only urgency there is — an assistant that
   * re-raises on every message would keep moving it to now, so the longest
   * wait would always read as the newest.
   */
  async setNeedsHuman(input: {
    enterpriseId: number;
    customerId: number;
    channelId: number;
    needsHuman: boolean;
    reason?: string | null;
    messageId?: number | null;
    /** Who marked it handled, when a person did. */
    resolvedByEmployeeId?: number | null;
  }): Promise<void> {
    await this.mutate(
      `INSERT INTO customer_assistant_states
         (enterprise_id, customer_id, channel_id, needs_human, needs_human_reason,
          needs_human_since, needs_human_message_id)
       /*
        * EVERY PARAMETER IS CAST. Postgres infers a parameter's type from
        * where it is used, and inside a CASE whose arms are a parameter and
        * NULL there is nothing to infer from — so it
        * falls back to text and the insert fails with "column is of type
        * bigint but expression is of type text". Caught in testing, where
        * the reply went out and the flag silently did not.
        */
       VALUES ($1, $2, $3, $4,
               CASE WHEN $4 THEN $5::text ELSE NULL END,
               CASE WHEN $4 THEN now() ELSE NULL END,
               CASE WHEN $4 THEN $6::bigint ELSE NULL END)
       ON CONFLICT (enterprise_id, customer_id, channel_id) WHERE is_deleted = false
       DO UPDATE SET
         needs_human = EXCLUDED.needs_human,
         needs_human_reason = CASE WHEN EXCLUDED.needs_human
           THEN COALESCE(EXCLUDED.needs_human_reason, customer_assistant_states.needs_human_reason)
           ELSE NULL END,
         -- COALESCE keeps the original time across a re-raise.
         needs_human_since = CASE WHEN EXCLUDED.needs_human
           THEN COALESCE(customer_assistant_states.needs_human_since, now())
           ELSE NULL END,
         needs_human_message_id = CASE WHEN EXCLUDED.needs_human
           THEN COALESCE(EXCLUDED.needs_human_message_id, customer_assistant_states.needs_human_message_id)
           ELSE NULL END,
         /*
          * STAMPED ONLY ON THE TRANSITION FROM RAISED TO CLEARED, so it
          * records a colleague actually closing something rather than every
          * write that happens to set the flag false. Kept through a later
          * raise: "a previous one was closed" is worth knowing, and the live
          * one is described by needs_human_since beside it.
          */
         needs_human_resolved_at = CASE
           WHEN NOT EXCLUDED.needs_human AND customer_assistant_states.needs_human
             THEN now()
           ELSE customer_assistant_states.needs_human_resolved_at END,
         needs_human_resolved_by = CASE
           WHEN NOT EXCLUDED.needs_human AND customer_assistant_states.needs_human
             THEN $7::bigint
           ELSE customer_assistant_states.needs_human_resolved_by END,
         updated_at = now()`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.customerId,
        input.channelId,
        input.needsHuman,
        input.reason ?? null,
        input.messageId ?? null,
        input.resolvedByEmployeeId ?? null,
      ],
    );
  }

  /**
   * Stops or restarts the assistant for one person on one channel.
   *
   * `resumesAt` is optional and is the thing that stops a pause becoming
   * permanent by being forgotten.
   */
  async setAutomationPause(input: {
    enterpriseId: number;
    customerId: number;
    channelId: number;
    paused: boolean;
    byEmployeeId?: number | null;
    resumesAt?: Date | null;
  }): Promise<void> {
    await this.mutate(
      `INSERT INTO customer_assistant_states
         (enterprise_id, customer_id, channel_id,
          automation_paused_at, automation_paused_by, automation_resumes_at)
       /* Cast for the reason setNeedsHuman casts — see the note there. */
       VALUES ($1, $2, $3,
               CASE WHEN $4 THEN now() ELSE NULL END,
               CASE WHEN $4 THEN $5::bigint ELSE NULL END,
               CASE WHEN $4 THEN $6::timestamptz ELSE NULL END)
       ON CONFLICT (enterprise_id, customer_id, channel_id) WHERE is_deleted = false
       DO UPDATE SET
         -- COALESCE so re-pausing an already paused one keeps the time it
         -- actually started, which is what somebody reading it wants.
         automation_paused_at = CASE WHEN $4
           THEN COALESCE(customer_assistant_states.automation_paused_at, now())
           ELSE NULL END,
         automation_paused_by = CASE WHEN $4 THEN $5::bigint ELSE NULL END,
         automation_resumes_at = CASE WHEN $4 THEN $6::timestamptz ELSE NULL END,
         updated_at = now()`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.customerId,
        input.channelId,
        input.paused,
        input.byEmployeeId ?? null,
        input.resumesAt ?? null,
      ],
    );
  }

  async releaseIdentifier(input: {
    enterpriseId: number;
    customerId: number;
    identifierKind: IdentifierKind;
    identifierValue: string;
  }): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE customer_identifiers
          SET status = 'released', released_at = now(), updated_at = now()
        WHERE enterprise_id = $1 AND customer_id = $2
          AND identifier_kind = $3 AND identifier_value = $4
          AND status = 'active' AND is_deleted = false
        RETURNING id`,
      [
        this.requireEnterprise(input.enterpriseId),
        input.customerId,
        input.identifierKind,
        input.identifierValue,
      ],
    );
    return affected > 0;
  }

  /**
   * Whether this value is already on somebody ELSE's record here.
   *
   * ASKED BEFORE A COLLEAGUE IS TOLD THEIR CHANGE WORKED. The insert is
   * `ON CONFLICT DO NOTHING`, which is right for the assistant — a race
   * between two replies must not fail one of them — but on a form it means
   * a colleague types a number, gets a success, and finds it absent. Worse,
   * the conflicting row may belong to a different customer entirely, and
   * silently doing nothing hides that two records are claiming one person.
   */
  async identifierOwner(
    enterpriseId: number,
    identifierKind: IdentifierKind,
    identifierValue: string,
  ): Promise<number | null> {
    const rows = await this.query<{ customerId: string }>(
      `SELECT customer_id AS "customerId"
         FROM customer_identifiers
        WHERE enterprise_id = $1 AND identifier_kind = $2 AND identifier_value = $3
          AND status = 'active' AND is_deleted = false
        LIMIT 1`,
      [this.requireEnterprise(enterpriseId), identifierKind, identifierValue],
    );
    return rows[0] ? Number(rows[0].customerId) : null;
  }

  async allIdentifiers(
    enterpriseId: number,
    customerId: number,
  ): Promise<
    {
      identifierKind: string;
      identifierValue: string;
      verificationStatus: string;
      source: string;
      isPrimary: boolean;
      firstSeenAt: Date | null;
    }[]
  > {
    return this.query(
      `SELECT identifier_kind AS "identifierKind",
              identifier_value AS "identifierValue",
              verification_status AS "verificationStatus",
              source, is_primary AS "isPrimary",
              first_seen_at AS "firstSeenAt"
         FROM customer_identifiers
        WHERE enterprise_id = $1 AND customer_id = $2
          AND status = 'active' AND is_deleted = false
        ORDER BY is_primary DESC, identifier_kind ASC, id ASC`,
      [this.requireEnterprise(enterpriseId), customerId],
    );
  }

  /**
   * How to reach them, where they have told us.
   *
   * EMAILS AND NUMBERS ONLY. The other identifier kinds are platform ids
   * and handles — an address for a conversation, not for a person — and the
   * assistant asking "how do I reach them" means the second.
   *
   * The verification status comes back with each, because it decides what
   * may be done with it: a number somebody typed into a chat is not a
   * number anybody checked, and the difference is the whole reason the
   * column exists.
   */
  async contactIdentifiers(
    enterpriseId: number,
    customerId: number,
  ): Promise<{ identifierKind: string; identifierValue: string; verificationStatus: string }[]> {
    return this.query(
      `SELECT identifier_kind AS "identifierKind",
              identifier_value AS "identifierValue",
              verification_status AS "verificationStatus"
         FROM customer_identifiers
        WHERE enterprise_id = $1 AND customer_id = $2
          AND identifier_kind = ANY($3::varchar[])
          AND status = 'active' AND is_deleted = false
        ORDER BY is_primary DESC, updated_at DESC, id DESC`,
      [
        this.requireEnterprise(enterpriseId),
        customerId,
        [IdentifierKind.Mobile, IdentifierKind.Email, IdentifierKind.WhatsAppNumber],
      ],
    );
  }

  /**
   * Records what a customer said about themselves, from inside a
   * conversation.
   *
   * BY ROW ID, unlike `setOwnIdentity`, which is the console's door and
   * takes the public ref. This one is reached from a conversation that
   * already holds the customer, and routing it through a ref lookup would
   * be a second query to arrive where we already are.
   *
   * IT WRITES THE SAME COLUMNS THE CONSOLE WRITES, deliberately. "The name
   * this business holds" is one fact with one home, whether a colleague
   * typed it or a customer said it — a parallel set of "what the assistant
   * thinks" columns would be two answers to one question and no way to
   * choose. Who said so is answered by the tool ledger, which carries the
   * message it was learned from.
   *
   * ABSENT MEANS DO NOT TOUCH. Each field is COALESCEd onto its own
   * current value, so recording a phone number cannot blank a name that
   * was never mentioned. There is no way to CLEAR a field from here, and
   * that is deliberate: clearing is a correction, and corrections belong to
   * the people who can see the whole record.
   */
  async setDeclaredIdentity(
    enterpriseId: number,
    customerId: number,
    fields: {
      displayName?: string | undefined;
      firstName?: string | undefined;
      lastName?: string | undefined;
      preferredLanguage?: string | undefined;
    },
  ): Promise<boolean> {
    const { affected } = await this.mutate(
      `UPDATE customers
          SET display_name = COALESCE($3, display_name),
              first_name = COALESCE($4, first_name),
              last_name = COALESCE($5, last_name),
              preferred_language = COALESCE($6, preferred_language),
              updated_at = now()
        WHERE enterprise_id = $1 AND id = $2 AND is_deleted = false`,
      [
        this.requireEnterprise(enterpriseId),
        customerId,
        fields.displayName ?? null,
        fields.firstName ?? null,
        fields.lastName ?? null,
        fields.preferredLanguage ?? null,
      ],
    );
    return affected > 0;
  }

  /**
   * The name THIS BUSINESS gives somebody.
   *
   * THE OTHER HALF OF THE SPLIT. The customer row is ours and the platform
   * profile is the fallback — but until this existed, nothing could write
   * the half that wins, so "ours outranks theirs" was a rule that could
   * never fire. A fallback with no primary is just a slower way of reading
   * the platform.
   *
   * ABSENT AND NULL ARE DIFFERENT, which is why each column has its own
   * COALESCE on a sentinel rather than one blanket update. Leaving a field
   * out means "do not touch it"; passing null means "hand it back to the
   * platform", which is what somebody who typed a name by mistake wants.
   * Collapsing the two would make clearing a name impossible.
   *
   * Returns what it held before, so the caller can record what actually
   * changed rather than what was asked for.
   */
  async setOwnIdentity(
    enterpriseId: number,
    refId: string,
    input: {
      /*
       * ABSENT AND NULL ARE DIFFERENT, and `exactOptionalPropertyTypes`
       * makes the compiler say so: leaving a field out means "do not touch
       * it", passing null means "hand it back to the platform". Writing
       * `?: string | null` would quietly let one stand for the other.
       */
      displayName?: string | null | undefined;
      firstName?: string | null | undefined;
      lastName?: string | null | undefined;
    },
  ): Promise<{ id: number; before: OwnIdentity; after: OwnIdentity } | null> {
    const touch = <T>(value: T | undefined): T | null | undefined =>
      value === undefined ? undefined : value;

    const { rows } = await this.mutate<{
      id: string;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      was_display_name: string | null;
      was_first_name: string | null;
      was_last_name: string | null;
    }>(
      `UPDATE customers cu
          SET display_name = CASE WHEN $3::boolean THEN $4 ELSE cu.display_name END,
              first_name   = CASE WHEN $5::boolean THEN $6 ELSE cu.first_name END,
              last_name    = CASE WHEN $7::boolean THEN $8 ELSE cu.last_name END,
              updated_at   = now()
         FROM customers was
        WHERE was.id = cu.id
          AND cu.enterprise_id = $1 AND cu.ref_id = $2 AND cu.is_deleted = false
      RETURNING cu.id, cu.display_name, cu.first_name, cu.last_name,
                was.display_name AS was_display_name,
                was.first_name AS was_first_name,
                was.last_name AS was_last_name`,
      [
        this.requireEnterprise(enterpriseId),
        refId,
        touch(input.displayName) !== undefined,
        input.displayName ?? null,
        touch(input.firstName) !== undefined,
        input.firstName ?? null,
        touch(input.lastName) !== undefined,
        input.lastName ?? null,
      ],
    );

    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      before: {
        displayName: row.was_display_name,
        firstName: row.was_first_name,
        lastName: row.was_last_name,
      },
      after: {
        displayName: row.display_name,
        firstName: row.first_name,
        lastName: row.last_name,
      },
    };
  }
}
