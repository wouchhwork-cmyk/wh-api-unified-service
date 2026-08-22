import { Injectable } from '@nestjs/common';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import {
  CustomerRepository,
  type CustomerDirectoryRow,
} from '@/database/repositories/customer.repository';
import { PostRepository, type PostFeedRow } from '@/database/repositories/post.repository';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@/shared/constants';
import { AppException, ErrorCode } from '@/shared/errors';

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

    return page(rows, limit, (row) => encodeCursor(row.publishedAt, row.id));
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

    return page(rows, limit, (row) => encodeCursor(row.lastSeenAt, row.id));
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

function clampLimit(limit: number | null): number {
  if (limit === null) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
}

/** The cursor is opaque to clients: base64 of the sort key, nothing more. */
function encodeCursor(at: Date | null, id: number): string {
  return Buffer.from(JSON.stringify({ t: at?.toISOString() ?? null, i: id })).toString('base64url');
}

function decodeCursor(cursor: string | null): { at: Date | null; id: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t: string | null;
      i: number;
    };
    if (typeof parsed.i !== 'number') return null;
    return { at: parsed.t ? new Date(parsed.t) : null, id: parsed.i };
  } catch {
    // A malformed cursor restarts from the top rather than erroring: the value
    // is opaque, so there is nothing useful to tell the caller.
    return null;
  }
}

function decodePostCursor(cursor: string | null): { publishedAt: Date | null; id: number } | null {
  const parsed = decodeCursor(cursor);
  return parsed && { publishedAt: parsed.at, id: parsed.id };
}

function decodeCustomerCursor(
  cursor: string | null,
): { lastSeenAt: Date | null; id: number } | null {
  const parsed = decodeCursor(cursor);
  return parsed && { lastSeenAt: parsed.at, id: parsed.id };
}
