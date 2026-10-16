import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { isExpiredMediaUrl } from '@/modules/inbox/attachment-normalizer';
import { SyncJobKind, SyncTriggerKind } from '@/shared/enums';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  CustomerRepository,
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
    private readonly channels: ChannelRepository,
    private readonly syncJobs: SyncJobRepository,
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
