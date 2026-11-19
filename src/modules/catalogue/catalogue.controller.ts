import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentScopedActor, RequirePermission } from '@/shared/decorators';
import { Permission } from '@/shared/enums';
import { paginated, type Paginated } from '@/shared/contracts/envelope';
import type { ScopedActorContext } from '@/shared/context';
import {
  CustomerDirectoryQuerySchema,
  CustomerContactSchema,
  CustomerContactRemovalSchema,
  CustomerIdentityUpdateSchema,
  PostFeedQuerySchema,
} from '@/shared/contracts/catalogue/catalogue.contract';
import type { CustomerDirectoryRow } from '@/database/repositories/customer.repository';
import type { PostFeedRow } from '@/database/repositories/post.repository';
import { isExpiredMediaUrl, mediaUrlExpiresAt } from '@/modules/inbox/attachment-normalizer';
import { CatalogueService } from './catalogue.service';
import { DEFAULT_PAGE_SIZE } from '@/shared/constants';
import { RefIdParamSchema } from '@/shared/contracts/params.contract';

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
  @Get('customers/:refId')
  @RequirePermission(Permission.CustomersView)
  @ApiOperation({
    summary: 'One customer, with every fact beside where it came from',
    description:
      'For checking a record rather than listing them. The directory resolves a single name ' +
      'because a list needs one; this keeps them apart — what a colleague typed, what the ' +
      'platform supplied, and what the assistant recorded from something the customer said are ' +
      'three different claims, and only the first is something this business decided. Each way ' +
      'of reaching them comes with its source and whether anybody verified it: a number the ' +
      'assistant took from a chat and one a colleague confirmed are the same string and not the ' +
      'same fact.',
  })
  async customer(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refId: string,
  ): Promise<unknown> {
    const read = await this.catalogue.readCustomer(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
    );
    return toCustomerDetail(read);
  }

  @Patch('customers/:refId')
  @RequirePermission(Permission.CustomersManage)
  @ApiOperation({
    summary: 'Set the name this business gives a customer',
    description:
      'What is stored here OUTRANKS the name the platform supplies, permanently: a profile ' +
      'refresh can never overwrite it. Sending null for a field hands that field back to the ' +
      'platform, which is what somebody who typed a name by mistake wants; leaving a field out ' +
      'leaves it alone. The two are deliberately different.',
  })
  async updateCustomer(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalogue.setCustomerIdentity(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
      CustomerIdentityUpdateSchema.parse(body),
    );
  }

  /**
   * Adds a phone number or email address to a record, or corrects one.
   *
   * ONE ENDPOINT FOR BOTH, because they are one action from where the
   * person doing it stands: `replaces` names the value being corrected and
   * the old one is released in the same call. Two endpoints would let a
   * form add the new value, fail to remove the old, and leave a record
   * carrying a number that was already known to be wrong.
   */
  @Post('customers/:refId/contacts')
  @RequirePermission(Permission.CustomersManage)
  @ApiOperation({
    summary: 'Add or correct a customer’s phone number or email',
    description:
      'Cleaned by the same code the assistant uses, so a number typed here and the same number ' +
      'recorded from a chat become one record rather than two: stored in full international ' +
      'form with its country, an email lower-cased. A bare national number is read as this ' +
      'business’s own country and the response says so. Saved UNVERIFIED — somebody typing a ' +
      'number has copied it from somewhere, not checked it. Send `replaces` with the existing ' +
      'value to correct one; the old value is released, not deleted, so it stays answerable ' +
      'who was reachable there and when.',
  })
  async addCustomerContact(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalogue.setCustomerContact(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
      CustomerContactSchema.parse(body),
    );
  }

  /**
   * Takes one off the record.
   *
   * POST RATHER THAN DELETE because what identifies the row is a value, not
   * an id we are willing to publish — and a DELETE carrying a body is a
   * thing proxies and clients disagree about.
   */
  @Post('customers/:refId/contacts/remove')
  @RequirePermission(Permission.CustomersManage)
  @ApiOperation({
    summary: 'Take a phone number or email off a customer’s record',
    description:
      'Released rather than deleted: the row stays with the date it stopped applying, because ' +
      '"this number was on their record until Tuesday" is a question somebody will ask. The ' +
      'value is freed for whoever actually owns it.',
  })
  async removeCustomerContact(
    @CurrentScopedActor() actor: ScopedActorContext,
    @Param('refId') refId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.catalogue.removeCustomerContact(
      actor.enterpriseId,
      RefIdParamSchema.parse(refId),
      CustomerContactRemovalSchema.parse(body),
    );
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
    shareCount: Number(row.shareCount),
    /*
     * Null rather than an empty object when there is no preview, so a client can
     * branch on presence.
     *
     * AND WHETHER THE LINK STILL WORKS, which the client could not previously
     * find out except by trying it. These urls are signed and short-lived —
     * about four days — and the advice here used to be that a client should
     * "treat a broken image as normal and fall back to the permalink". That
     * asks the browser to fail first, and leaves it unable to tell an expired
     * link from a genuine fault: one is certain and permanent, the other is
     * worth a retry.
     *
     * `oe` on the url is the expiry, so this costs nothing to answer honestly.
     */
    media: mediaWithExpiry(row.media),
    channelRefId: row.channelRefId,
    channelName: row.channelName,
  };
}

/**
 * A post's preview, with the one fact the client cannot work out for itself.
 *
 * `expired` is the answer to "will this render?", decided from the url's own
 * `oe` rather than by waiting for a 403. `expiresAt` is included so a client
 * holding a list for a while can tell the difference between a link that is
 * about to die and one that died weeks ago.
 */
function mediaWithExpiry(
  media: { url?: string; thumbnailUrl?: string; type?: string } | null,
): Record<string, unknown> | null {
  if (!media || Object.keys(media).length === 0) return null;

  // The thumbnail is the fallback the client reaches for, so it is no use
  // knowing the main url died while silently handing over a dead thumbnail too.
  const expiresAt = mediaUrlExpiresAt(media.url) ?? mediaUrlExpiresAt(media.thumbnailUrl);

  return {
    ...media,
    expiresAt: expiresAt?.toISOString() ?? null,
    expired: isExpiredMediaUrl(media.url) || isExpiredMediaUrl(media.thumbnailUrl),
  };
}

function toCustomerSummary(row: CustomerDirectoryRow): Record<string, unknown> {
  return {
    refId: row.refId,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    /*
     * Exposed separately from displayName even though they often carry the same
     * text: a client that wants to render "@handle" needs to know it IS a
     * handle, and one that wants to greet somebody needs the given name.
     */
    handle: row.handle,
    avatarUrl: row.avatarUrl,
    firstSource: row.firstSource,
    conversationCount: Number(row.conversationCount),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
    isBlocked: row.isBlocked,
    /*
     * Waiting for a person SOMEWHERE. Both switches are per channel, and a
     * directory row is per person — so this says only that at least one of
     * their inboxes has a flag on it, which is exactly what a list is for.
     * Which inbox, and the buttons to do anything about it, live where the
     * conversation does.
     */
    needsHuman: row.needsHuman,
    automationPaused: row.automationPaused,
  };
}

/**
 * One customer's whole record, for somebody checking it.
 *
 * NAMED BY WHERE EACH PART CAME FROM. A name this business typed and a name
 * read off a public profile are different claims about a person, and a
 * record that collapses them cannot answer "who says so" — which is the
 * question somebody opening this is usually here to ask.
 */
function toCustomerDetail(read: {
  customer: {
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
  };
  identifiers: {
    identifierKind: string;
    identifierValue: string;
    verificationStatus: string;
    source: string;
    isPrimary: boolean;
    firstSeenAt: Date | null;
  }[];
}): Record<string, unknown> {
  const customer = read.customer;
  const platform = customer.platformMetadata ?? {};
  const flag = (key: string): boolean | null =>
    typeof platform[key] === 'boolean' ? platform[key] : null;

  return {
    refId: customer.refId,
    names: {
      business: {
        displayName: customer.ownDisplayName,
        firstName: customer.ownFirstName,
        lastName: customer.ownLastName,
      },
      platform: {
        displayName: customer.platformDisplayName,
        firstName: customer.platformFirstName,
        lastName: customer.platformLastName,
      },
    },
    avatarUrl: customer.avatarUrl,
    preferredLanguage: customer.preferredLanguage,
    locale: customer.locale,
    firstSource: customer.firstSource,
    conversationCount: customer.conversationCount,
    firstSeenAt: customer.firstSeenAt,
    lastSeenAt: customer.lastSeenAt,
    status: customer.status,
    /*
     * ABSENT STAYS ABSENT. A missing key means the platform has not told us,
     * which is not the same as no — and a false here would be this business
     * asserting something about somebody's own account.
     */
    platformSignals: {
      followsUs: flag('followsUs'),
      weFollowThem: flag('weFollowThem'),
      isVerified: flag('isVerified'),
      followerCount: typeof platform.followerCount === 'number' ? platform.followerCount : null,
      fetchedAt: typeof platform.profileFetchedAt === 'string' ? platform.profileFetchedAt : null,
    },
    identifiers: read.identifiers.map((row) => ({
      kind: row.identifierKind,
      value: row.identifierValue,
      verificationStatus: row.verificationStatus,
      /* Said as a boolean as well, because "verified" is the one bit a
       * reader acts on and `verificationStatus` carries four values. */
      verified: row.verificationStatus === 'verified',
      source: row.source,
      isPrimary: row.isPrimary,
      firstSeenAt: row.firstSeenAt,
    })),
  };
}
