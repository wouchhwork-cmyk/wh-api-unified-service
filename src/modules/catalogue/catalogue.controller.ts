import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import type { ScopedActorContext } from '@/shared/context';
import {
  CustomerDirectoryQuerySchema,
  PostFeedQuerySchema,
} from '@/shared/contracts/catalogue/catalogue.contract';
import type { CustomerDirectoryRow } from '@/database/repositories/customer.repository';
import type { PostFeedRow } from '@/database/repositories/post.repository';
import { CatalogueService } from './catalogue.service';
import { DEFAULT_PAGE_SIZE } from '@/shared/constants';

/**
 * Reads over what a connected account produced.
 *
 * Two separate permissions, because they are two separate commercial features:
 * a business can be entitled to post insights without the customer directory.
 * Both are feature-gated through the permission itself — the effective set is
 * resolved per request, so revoking `post_insights` closes this route
 * immediately rather than at token expiry.
 */
@ApiTags('catalogue')
@Controller({ version: '1' })
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('posts')
  @RequirePermission(Permission.PostsView)
  @ApiOperation({
    summary: 'Posts published by the connected accounts',
    description:
      'Cursor-paginated, newest first. A post with no publish time from the platform sorts last ' +
      'rather than first, so the feed reads chronologically.',
  })
  async posts(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Query() query: unknown,
  ): Promise<Paginated<unknown>> {
    const parsed = PostFeedQuerySchema.parse(query);
    const limit = parsed.limit ?? DEFAULT_PAGE_SIZE;

    const result = await this.catalogue.listPosts(actor.enterpriseId, {
      channelRefId: parsed.channelRefId ?? null,
      limit,
      cursor: parsed.cursor ?? null,
    });

    return paginated(result.items.map(toPostSummary), {
      limit,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  }

  @Get('customers')
  @RequirePermission(Permission.CustomersView)
  @ApiOperation({
    summary: 'The customer directory',
    description: 'Cursor-paginated, most recently seen first. `search` matches the display name.',
  })
  async customers(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Query() query: unknown,
  ): Promise<Paginated<unknown>> {
    const parsed = CustomerDirectoryQuerySchema.parse(query);
    const limit = parsed.limit ?? DEFAULT_PAGE_SIZE;

    const result = await this.catalogue.listCustomers(actor.enterpriseId, {
      search: parsed.search ?? null,
      limit,
      cursor: parsed.cursor ?? null,
    });

    return paginated(result.items.map(toCustomerSummary), {
      limit,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  }
}

/**
 * Internal ids never leave the process — a client addresses a post by ref_id.
 * The numeric id is a join key and leaking it would expose row counts.
 */
function toPostSummary(row: PostFeedRow): Record<string, unknown> {
  return {
    refId: row.refId,
    platform: row.platform,
    postKind: row.postKind,
    status: row.status,
    caption: row.caption,
    permalinkUrl: row.permalinkUrl,
    publishedAt: row.publishedAt,
    commentCount: Number(row.commentCount),
    likeCount: Number(row.likeCount),
    channelRefId: row.channelRefId,
    channelName: row.channelName,
  };
}

function toCustomerSummary(row: CustomerDirectoryRow): Record<string, unknown> {
  return {
    refId: row.refId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    firstSource: row.firstSource,
    conversationCount: Number(row.conversationCount),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
    isBlocked: row.isBlocked,
  };
}
