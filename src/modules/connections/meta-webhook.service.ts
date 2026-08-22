import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { RequestContext } from '@/shared/context';
import { InboundEventType, Platform, SourceKind } from '@/shared/enums';
import { AppException, ErrorCode } from '@/shared/errors';

interface WebhookEntry {
  readonly id?: string;
  readonly time?: number;
  readonly changes?: readonly { readonly field?: string; readonly value?: unknown }[];
  readonly messaging?: readonly Record<string, unknown>[];
}

interface WebhookBody {
  readonly object?: string;
  readonly entry?: readonly WebhookEntry[];
}

export interface IngestSummary {
  readonly accepted: number;
  readonly duplicates: number;
  readonly unmatched: number;
}

@Injectable()
export class MetaWebhookService {
  constructor(
    private readonly config: AppConfigService,
    private readonly inbound: InboundEventRepository,
    private readonly channels: ChannelRepository,
    @InjectPinoLogger(MetaWebhookService.name) private readonly logger: PinoLogger,
  ) {}

  /** The subscription handshake. Meta expects the bare challenge as text/plain. */
  verifySubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    if (mode !== 'subscribe' || !challenge) {
      throw new AppException(ErrorCode.WebhookSignatureInvalid);
    }
    const expected = Buffer.from(this.config.meta.webhookVerifyToken, 'utf8');
    const actual = Buffer.from(token ?? '', 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new AppException(ErrorCode.WebhookSignatureInvalid);
    }
    return challenge;
  }

  /**
   * Verifies the payload signature.
   *
   * Ported verbatim in shape from the socialLift implementation, which runs it
   * against live Meta traffic: the `sha256=` prefix check, an HMAC over the RAW
   * body under the app secret, and timingSafeEqual after a length guard.
   *
   * It MUST be the raw bytes: re-serialising the parsed JSON changes key order
   * and whitespace, and the signature then never matches. That is why the app is
   * bootstrapped with rawBody: true.
   */
  verifySignature(rawBody: Buffer | undefined, header: string | undefined): void {
    if (!rawBody || !header) throw new AppException(ErrorCode.WebhookSignatureInvalid);

    const [algorithm, provided] = header.split('=');
    if (algorithm !== 'sha256' || !provided) {
      throw new AppException(ErrorCode.WebhookSignatureInvalid);
    }

    const expected = createHmac('sha256', this.config.meta.appSecret).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(provided, 'utf8');

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new AppException(ErrorCode.WebhookSignatureInvalid);
    }
  }

  /**
   * Records each entry as its own ledger row.
   *
   * BATCHES ARE EXPLODED ON ARRIVAL. One Meta POST can carry many entries and
   * changes; collapsing them into a single row would mean a retry after a
   * partial failure reprocesses items that already succeeded, and the dedup key
   * would describe a batch that never recurs identically.
   */
  async ingest(body: unknown): Promise<IngestSummary> {
    const parsed = (body ?? {}) as WebhookBody;
    const platform = parsed.object === 'instagram' ? Platform.Instagram : Platform.Facebook;
    const correlationId = RequestContext.correlationId() ?? null;

    let accepted = 0;
    let duplicates = 0;
    let unmatched = 0;

    for (const entry of parsed.entry ?? []) {
      // The enterprise is DERIVED from the channel: a webhook carries no tenant
      // context, and trusting anything in the payload for it would be a
      // cross-tenant write primitive.
      const channel = entry.id
        ? await this.channels.findByPlatformId(platform, entry.id)
        : null;

      if (!channel) {
        // Not ours, or not connected yet. Counted and dropped: storing events we
        // cannot attribute would be an unbounded, untenanted table.
        unmatched += 1;
        continue;
      }

      const items = this.flatten(entry);
      for (const item of items) {
        const result = await this.inbound.insertIgnoringDuplicate({
          enterpriseId: channel.enterpriseId,
          channelId: channel.id,
          sourceKind: SourceKind.Channel,
          sourceId: entry.id ?? null,
          platform,
          eventType: item.eventType,
          platformEventId: item.platformEventId,
          dedupKey: item.dedupKey,
          correlationId,
          payload: item.payload,
          receivedAt: entry.time ? new Date(entry.time * 1000) : null,
        });

        if (result.duplicate) duplicates += 1;
        else accepted += 1;
      }
    }

    // The payload itself is never logged: it carries customer names, handles and
    // message text.
    this.logger.info({ platform, accepted, duplicates, unmatched }, 'meta webhook ingested');
    return { accepted, duplicates, unmatched };
  }

  /** One entry becomes one ledger row per change or per message. */
  private flatten(entry: WebhookEntry): {
    eventType: InboundEventType;
    platformEventId: string | null;
    dedupKey: string;
    payload: unknown;
  }[] {
    const items: {
      eventType: InboundEventType;
      platformEventId: string | null;
      dedupKey: string;
      payload: unknown;
    }[] = [];

    for (const change of entry.changes ?? []) {
      const eventType = mapChangeField(change.field);
      const platformEventId = extractId(change.value);
      items.push({
        eventType,
        platformEventId,
        dedupKey: composeDedupKey(entry, eventType, platformEventId, change.value),
        payload: change,
      });
    }

    for (const message of entry.messaging ?? []) {
      const platformEventId = extractMessageId(message);
      items.push({
        eventType: InboundEventType.DirectMessage,
        platformEventId,
        dedupKey: composeDedupKey(entry, InboundEventType.DirectMessage, platformEventId, message),
        payload: message,
      });
    }

    return items;
  }
}

function mapChangeField(field: string | undefined): InboundEventType {
  switch (field) {
    case 'feed':
    case 'comments':
      return InboundEventType.Comment;
    case 'mention':
    case 'mentions':
      return InboundEventType.Mention;
    case 'messages':
      return InboundEventType.DirectMessage;
    default:
      return InboundEventType.PostUpdate;
  }
}


/**
 * `{platform}:{event_type}:{platform_event_id}` when the platform gives an id,
 * and a payload hash when it does not.
 *
 * CRITICAL: a backfill fetching the same item must compose the SAME key, which
 * is why this depends only on the item's own identity — never on the route it
 * arrived by. If a backfill invented its own event type, every overlapping item
 * would silently duplicate.
 */
function composeDedupKey(
  entry: WebhookEntry,
  eventType: InboundEventType,
  platformEventId: string | null,
  payload: unknown,
): string {
  if (platformEventId) return `meta:${eventType}:${platformEventId}`;
  const hash = createHmac('sha256', 'dedup')
    .update(JSON.stringify({ entryId: entry.id, payload }))
    .digest('hex')
    .slice(0, 40);
  return `meta:${eventType}:h:${hash}`;
}

function extractId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ['comment_id', 'post_id', 'media_id', 'id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

function extractMessageId(message: Record<string, unknown>): string | null {
  const inner = message.message;
  if (typeof inner === 'object' && inner !== null) {
    const mid = (inner as Record<string, unknown>).mid;
    if (typeof mid === 'string' && mid) return mid;
  }
  return null;
}
