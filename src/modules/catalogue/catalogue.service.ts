import { AuditService } from '@/modules/audit/audit.service';
import {
  AuditAction,
  AuditEntityType,
  AuditStatus,
  IdentifierKind,
  IdentifierSource,
  IdentifierVerificationStatus,
} from '@/shared/enums';
import { cleanContact } from '@/shared/utils/normalize';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { isExpiredMediaUrl } from '@/modules/inbox/attachment-normalizer';
import { SyncJobKind, SyncTriggerKind } from '@/shared/enums';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  CustomerRepository,
  type OwnIdentity,
  type CustomerDirectoryRow,
} from '@/database/repositories/customer.repository';
import { PostRepository, type PostFeedRow } from '@/database/repositories/post.repository';
import { clampLimit } from '@/shared/utils/page-limit';
import { AppException, ErrorCode } from '@/shared/errors';
import { decodeKeysetCursor, encodeKeysetCursor } from '@/shared/utils/keyset-cursor';

/** What a list returns before the interceptor wraps it in the envelope. */
interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Reads over the things a connected account produced: posts and the people who
 * talked to it.
 *
 * Both lists are keyset-paginated and both fetch one row more than the caller
 * asked for — the cheapest way to know whether another page exists without a
 * second COUNT over the same predicate.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly posts: PostRepository,
    private readonly customers: CustomerRepository,
    private readonly audit: AuditService,
    private readonly channels: ChannelRepository,
    private readonly syncJobs: SyncJobRepository,
    /* For the one column that settles what country a bare national number
     * belongs to. See `cleanContact`. */
    private readonly enterprises: EnterpriseRepository,
    @InjectPinoLogger(CatalogueService.name) private readonly logger: PinoLogger,
  ) {}

  async listPosts(
    enterpriseId: number,
    options: { channelRefId: string | null; limit: number | null; cursor: string | null },
  ): Promise<Page<PostFeedRow>> {
    const limit = clampLimit(options.limit);

    /*
     * The channel filter is resolved to an internal id THROUGH the tenant. A
     * refId from another business resolves to nothing and raises, rather than
     * silently returning that business's posts.
     */
    let channelId: number | null = null;
    if (options.channelRefId) {
      const channel = await this.channels.findByRefId(enterpriseId, options.channelRefId);
      if (!channel) throw new AppException(ErrorCode.ChannelNotFound);
      channelId = channel.id;
    }

    const rows = await this.posts.listFeed({
      enterpriseId,
      channelId,
      limit: limit + 1,
      cursor: decodePostCursor(options.cursor),
    });

    await this.refreshExpiredMedia(enterpriseId, rows);

    return page(rows, limit, (row) => encodeKeysetCursor(row.publishedAt, row.id));
  }

  /**
   * Asks for a fresh walk of any channel whose preview links have died.
   *
   * WHY ON A READ. A post's media url is signed and lasts about four days,
   * while the only thing that refreshes one is a cron at 5am. Those two facts
   * were fine in principle and not in practice: the refresh failed five times
   * one night in September, dead-lettered, and every post on this account was
   * served with a dead link for the nineteen days nobody looked. Somebody
   * opening the page is the moment we learn it is stale, and the moment it is
   * worth fixing.
   *
   * SAFE TO CALL ON EVERY LIST. `enqueueIfAbsent` is unique per channel and
   * kind while a job is live, so a page refreshed in a loop enqueues one job,
   * not one per request. The work happens in the backfill worker; this only
   * asks.
   *
   * Deliberately not awaited for correctness — the caller gets the stale urls
   * THIS time, and the DTO marks them expired so the client shows the permalink
   * rather than a broken image. The repair is for the next load.
   */
  private async refreshExpiredMedia(
    enterpriseId: number,
    rows: readonly PostFeedRow[],
  ): Promise<void> {
    const stale = new Map<number, string>();
    for (const row of rows) {
      if (stale.has(row.channelId)) continue;
      if (isExpiredMediaUrl(row.media?.url) || isExpiredMediaUrl(row.media?.thumbnailUrl)) {
        stale.set(row.channelId, row.channelRefId);
      }
    }
    if (stale.size === 0) return;

    for (const [channelId] of stale) {
      try {
        const queued = await this.syncJobs.enqueueIfAbsent({
          enterpriseId,
          channelId,
          jobKind: SyncJobKind.RefreshPostMetrics,
          triggerKind: SyncTriggerKind.Scheduled,
        });
        if (queued) {
          this.logger.info(
            { enterpriseId, channelId },
            'post previews had expired — a refresh was queued',
          );
        }
      } catch (error) {
        /*
         * Never fails the read. Somebody asked to see their posts; a queue that
         * would not accept a repair job is not a reason to refuse them, and the
         * previews are already marked expired either way.
         */
        this.logger.warn(
          { enterpriseId, channelId, err: error },
          'could not queue a refresh for expired post previews',
        );
      }
    }
  }

  async listCustomers(
    enterpriseId: number,
    options: { search: string | null; limit: number | null; cursor: string | null },
  ): Promise<Page<CustomerDirectoryRow>> {
    const limit = clampLimit(options.limit);

    const rows = await this.customers.listDirectory({
      enterpriseId,
      search: options.search,
      limit: limit + 1,
      cursor: decodeCustomerCursor(options.cursor),
    });

    return page(rows, limit, (row) => encodeKeysetCursor(row.lastSeenAt, row.id));
  }
  /**
   * One customer, with every fact kept beside where it came from.
   *
   * FOR CHECKING, which is a different job from the directory. A list needs
   * one name per row and resolves it; somebody opening a record wants to
   * know whether that name was typed by a colleague, supplied by the
   * platform, or recorded by the assistant from something the customer
   * said — and which of their contact details anybody has actually
   * verified.
   *
   * The tool calls come with it, bounded, because they are the audit trail
   * for the half of this record the assistant wrote. "Why does it say her
   * number is this" is answered by the row that recorded it and the message
   * it cited.
   */
  async readCustomer(
    enterpriseId: number,
    refId: string,
  ): Promise<{
    /* NonNullable: the not-found case throws below, so a caller never has
     * to re-check what this already refused to return. */
    customer: NonNullable<Awaited<ReturnType<CustomerRepository['fullProfile']>>>;
    identifiers: Awaited<ReturnType<CustomerRepository['allIdentifiers']>>;
  }> {
    const customer = await this.customers.fullProfile(enterpriseId, refId);
    if (!customer) throw new AppException(ErrorCode.CustomerNotFound);

    return {
      customer,
      identifiers: await this.customers.allIdentifiers(enterpriseId, customer.id),
    };
  }

  /**
   * Sets the name this business gives somebody.
   *
   * THE HALF THAT WINS. A customer's name resolves ours-then-the-platform's,
   * and this is the only thing that writes ours — without it the fallback
   * was the whole of the answer and "a name typed here outranks Instagram"
   * described nothing.
   *
   * AUDITED WITH WHAT ACTUALLY CHANGED, from the row rather than from the
   * request: a request asking for the name it already holds changes nothing,
   * and a trail that recorded the ask would claim an edit that never
   * happened. Clearing a name is recorded as what it is — handing the
   * customer back to whatever the platform calls them — because somebody
   * reading this later needs to know the blank was chosen.
   */
  async setCustomerIdentity(
    enterpriseId: number,
    refId: string,
    input: {
      displayName?: string | null | undefined;
      firstName?: string | null | undefined;
      lastName?: string | null | undefined;
    },
  ): Promise<OwnIdentity> {
    const changed = await this.customers.setOwnIdentity(enterpriseId, refId, input);
    if (!changed) throw new AppException(ErrorCode.CustomerNotFound);

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Customer,
      entityId: changed.id,
      enterpriseId,
      status: AuditStatus.Success,
      metadata: {
        /* The name is the point of the change, so it is the one thing worth
         * recording — and it is a name somebody at this business chose, not
         * a contact detail. */
        before: changed.before,
        after: changed.after,
        clearedToPlatform: changed.after.displayName === null,
      },
    });

    return changed.after;
  }

  /**
   * The country this business stated for itself, as a one-item list.
   *
   * A LIST BECAUSE `cleanContact` DISTINGUISHES NONE FROM ONE, and those are
   * genuinely different answers: one country settles what a bare number is
   * without asking anybody, and none means the question has to be put. The
   * business has exactly one country today — see the entity for why — so
   * this is always one item or none.
   */
  private async businessCountries(enterpriseId: number): Promise<string[]> {
    const country = await this.enterprises.countryById(enterpriseId);
    return country ? [country] : [];
  }

  /**
   * Puts a contact detail on a customer's record, or changes one.
   *
   * THE SAME CLEANING THE ASSISTANT GETS, deliberately. `cleanContact` is
   * shared with `record_customer_details` so a number added here and the
   * same number recorded from a chat produce the SAME row — otherwise the
   * uniqueness `identifier_value` exists to provide is not uniqueness, and
   * one person quietly becomes two records.
   *
   * ADDED BY A COLLEAGUE IS STILL UNVERIFIED. Somebody typing a number into
   * a form has not checked it either; they have copied it from somewhere.
   * The source says a person at this business entered it, which is a
   * stronger claim than a customer saying it in a chat and a weaker one
   * than anybody having confirmed it works.
   *
   * REPLACING IS RELEASE-THEN-ADD, in that order, so a typo being corrected
   * does not leave both the old and the new on the record. The old value is
   * released rather than deleted — see `releaseIdentifier`.
   */
  async setCustomerContact(
    enterpriseId: number,
    refId: string,
    input: {
      kind: IdentifierKind;
      value: string;
      country?: string | null | undefined;
      /** The existing value this one replaces. Absent means add a new one. */
      replaces?: string | null | undefined;
    },
  ): Promise<{ kind: IdentifierKind; value: string; replaced: string | null }> {
    const customer = await this.customers.fullProfile(enterpriseId, refId);
    if (!customer) throw new AppException(ErrorCode.CustomerNotFound);

    const clean = cleanContact({
      kind: input.kind,
      value: input.value,
      stated: input.country,
      /* The country this business stated for itself — a declaration, not a
       * guess, which is what lets a bare number through without the form
       * having to ask. */
      operatesIn:
        input.kind === IdentifierKind.Email ? [] : await this.businessCountries(enterpriseId),
    });
    if (!clean.ok) {
      throw new AppException(
        clean.problem === 'needs_country'
          ? ErrorCode.ContactNeedsCountry
          : ErrorCode.ContactNotUsable,
      );
    }
    const contact = clean.contact;

    /*
     * CHECKED BEFORE, NOT AFTER. The insert is ON CONFLICT DO NOTHING,
     * which is right for a reply race and wrong for a form: a colleague
     * would be told it worked and find nothing there. Worse, the row may
     * belong to a DIFFERENT customer, and silently doing nothing hides two
     * records claiming one person.
     */
    const owner = await this.customers.identifierOwner(enterpriseId, input.kind, contact.canonical);
    if (owner !== null && owner !== customer.id) throw new AppException(ErrorCode.ContactTaken);

    /* Released FIRST, so correcting a typo cannot leave both on the record.
     * A replacement that is really the same value after cleaning would
     * otherwise release the row it is about to re-add. */
    let replaced: string | null = null;
    if (input.replaces && input.replaces !== contact.canonical) {
      const gone = await this.customers.releaseIdentifier({
        enterpriseId,
        customerId: customer.id,
        identifierKind: input.kind,
        identifierValue: input.replaces,
      });
      if (!gone) throw new AppException(ErrorCode.ContactNotFound);
      replaced = input.replaces;
    }

    await this.customers.linkIdentifier({
      enterpriseId,
      customerId: customer.id,
      identifierKind: input.kind,
      identifierValue: contact.canonical,
      identifierValueRaw: input.value.trim(),
      ...(contact.mobile ? { mobile: contact.mobile } : {}),
      source: IdentifierSource.AgentEntered,
      verification: IdentifierVerificationStatus.Unverified,
    });

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Customer,
      entityId: customer.id,
      enterpriseId,
      status: AuditStatus.Success,
      /* THE VALUE IS THE POINT OF THE CHANGE, so it is recorded — this trail
       * is how "why does her record say this number" gets answered, and a
       * row saying only "a contact changed" answers nothing. */
      metadata: {
        kind: input.kind,
        value: contact.canonical,
        replaced,
        /* Which country it was read as, always — not a flag saying whether
         * anybody guessed, because nobody guesses any more. */
        country: contact.mobile?.countryCode ?? null,
      },
    });

    return { kind: input.kind, value: contact.canonical, replaced };
  }

  /**
   * Takes a contact detail off a record.
   *
   * CLEANED BEFORE IT IS MATCHED, because what the caller holds is what was
   * stored — but a caller that rebuilt it from a form would send the typed
   * shape, and matching on the raw string would silently remove nothing.
   */
  async removeCustomerContact(
    enterpriseId: number,
    refId: string,
    input: { kind: IdentifierKind; value: string },
  ): Promise<{ kind: IdentifierKind; value: string }> {
    const customer = await this.customers.fullProfile(enterpriseId, refId);
    if (!customer) throw new AppException(ErrorCode.CustomerNotFound);

    const clean = cleanContact({
      kind: input.kind,
      value: input.value,
      operatesIn:
        input.kind === IdentifierKind.Email ? [] : await this.businessCountries(enterpriseId),
    });
    /* Falls back to the raw string on purpose: removing is matching, and a
     * value that cannot be cleaned may still be sitting on the record from
     * before it was cleaned at all. */
    const value = clean.ok ? clean.contact.canonical : input.value.trim();

    const gone = await this.customers.releaseIdentifier({
      enterpriseId,
      customerId: customer.id,
      identifierKind: input.kind,
      identifierValue: value,
    });
    if (!gone) throw new AppException(ErrorCode.ContactNotFound);

    await this.audit.record({
      action: AuditAction.Updated,
      entityType: AuditEntityType.Customer,
      entityId: customer.id,
      enterpriseId,
      status: AuditStatus.Success,
      metadata: { kind: input.kind, removed: value },
    });

    return { kind: input.kind, value };
  }
}

function page<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasMore && last ? cursorOf(last) : null,
    hasMore,
  };
}

function decodePostCursor(cursor: string | null): { publishedAt: Date | null; id: number } | null {
  const parsed = decodeKeysetCursor(cursor);
  return parsed && { publishedAt: parsed.at, id: parsed.id };
}

function decodeCustomerCursor(
  cursor: string | null,
): { lastSeenAt: Date | null; id: number } | null {
  const parsed = decodeKeysetCursor(cursor);
  return parsed && { lastSeenAt: parsed.at, id: parsed.id };
}
