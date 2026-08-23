import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { InboundEventRepository } from '@/database/repositories/inbound-event.repository';
import { RequestContext } from '@/shared/context';
import { InboundEventType, Platform, SourceKind } from '@/shared/enums';
import { inboundDedupKey, inboundDedupKeyFromPayload } from '@/modules/ledger/dedup-key.util';
import { AppException, ErrorCode } from '@/shared/errors';
import { resolveWebhookVerifyToken } from './webhook-verify-token';

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
  /** Items that could not be stored. Meta will not resend these. */
  readonly failed: number;
}

@Injectable()
export class MetaWebhookService {
  constructor(
    private readonly config: AppConfigService,
    private readonly inbound: InboundEventRepository,
    private readonly channels: ChannelRepository,
    @InjectPinoLogger(MetaWebhookService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Refuses everything when the integration is not configured.
   *
   * With META_ENABLED=false the app secret and verify token are empty strings,
   * and an HMAC under an empty key is one an attacker can compute. The route is
   * registered unconditionally, so the guard has to live here.
   */
  private assertConfigured(): void {
    if (!this.config.meta.enabled || !this.config.meta.appSecret) {
      throw new AppException(ErrorCode.MetaNotConfigured);
    }
  }

  /** The subscription handshake. Meta expects the bare challenge as text/plain. */
  verifySubscription(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): string {
    this.assertConfigured();
    if (mode !== 'subscribe' || !challenge) {
      throw new AppException(ErrorCode.WebhookSignatureInvalid);
    }
    // Configured if there is one, derived from the app secret otherwise — so
    // nobody has to invent a string, and the handshake works as soon as Meta is
    // configured at all.
    const resolved = resolveWebhookVerifyToken(
      this.config.meta.webhookVerifyToken,
      this.config.meta.appSecret,
    );
    if (!resolved) throw new AppException(ErrorCode.MetaNotConfigured);

    const expected = Buffer.from(resolved, 'utf8');
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
    this.assertConfigured();
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
    let failed = 0;

    for (const entry of parsed.entry ?? []) {
      // The enterprise is DERIVED from the channel: a webhook carries no tenant
      // context, and trusting anything in the payload for it would be a
      // cross-tenant write primitive.
      const channels = entry.id ? await this.channels.findAllByPlatformId(platform, entry.id) : [];

      if (channels.length === 0) {
        // Not ours, or not connected yet. Counted and dropped: storing events we
        // cannot attribute would be an unbounded, untenanted table.
        unmatched += 1;
        continue;
      }

      const items = this.flatten(entry, platform);

      // One ledger row per item PER CHANNEL. Two enterprises connected to the
      // same Page each get their own copy, and the dedup key is scoped by
      // enterprise, so the copies do not collide with each other.
      for (const channel of channels) {
        for (const item of items) {
          /*
           * PER-ITEM ISOLATION, and it is the difference between losing one
           * event and losing the subscription.
           *
           * One unstorable item used to fail the whole delivery. Meta retries a
           * non-2xx delivery for a while and then DISABLES the subscription —
           * after which the inbox silently stops filling and nothing in this
           * service knows why. A single malformed payload, or one row that trips
           * a constraint we did not anticipate, could therefore take the
           * integration down permanently.
           *
           * So a failed item is counted and logged, and the delivery still
           * answers 200 for everything that stored. Meta will not resend the
           * ones that failed — that is the trade — which is why the count is
           * surfaced and logged at error rather than swallowed.
           */
          try {
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
          } catch (error) {
            failed += 1;
            // No payload: it carries customer names, handles and message text.
            this.logger.error(
              {
                err: error,
                enterpriseId: channel.enterpriseId,
                channelId: channel.id,
                eventType: item.eventType,
                platformEventId: item.platformEventId,
              },
              'could not store one webhook item — the rest of the delivery continues, and Meta will not resend it',
            );
          }
        }
      }
    }

    // The payload itself is never logged: it carries customer names, handles and
    // message text.
    this.logger.info(
      { platform, accepted, duplicates, unmatched, failed },
      'meta webhook ingested',
    );
    return { accepted, duplicates, unmatched, failed };
  }

  /** One entry becomes one ledger row per change or per message. */
  private flatten(
    entry: WebhookEntry,
    platform: Platform,
  ): {
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
      const eventType = mapChangeField(change.field, change.value);
      const platformEventId = extractId(change.value);
      const verb = extractVerb(change.value);
      items.push({
        eventType,
        platformEventId,
        dedupKey: composeDedupKey(platform, eventType, platformEventId, verb, change),
        payload: change,
      });
    }

    for (const message of entry.messaging ?? []) {
      const platformEventId = extractMessageId(message);
      items.push({
        eventType: InboundEventType.DirectMessage,
        platformEventId,
        // A message id already identifies one event; there is no verb.
        dedupKey: composeDedupKey(
          platform,
          InboundEventType.DirectMessage,
          platformEventId,
          null,
          message,
        ),
        payload: message,
      });
    }

    return items;
  }
}

/**
 * Which projector an entry's change belongs to.
 *
 * `feed` IS NOT ONLY COMMENTS. Facebook's feed field covers posts, photos,
 * videos, shares, likes and comments, discriminated by `value.item` — and this
 * mapped the whole field to Comment, so a post published after the connection
 * was routed to the comment projector, skipped there as "not a comment", and
 * never reached the posts table until the next daily metrics refresh happened to
 * walk past it.
 *
 * The value is inspected rather than only the field, because the field alone
 * genuinely does not say.
 */
function mapChangeField(field: string | undefined, value: unknown): InboundEventType {
  switch (field) {
    case 'feed': {
      const item = readItem(value);
      // A comment is the only feed item the inbox treats as a conversation.
      // Everything else — status, photo, video, share — is a change to a POST.
      return item === 'comment' ? InboundEventType.Comment : InboundEventType.PostUpdate;
    }
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
 * Composes the dedup key using the SHARED scheme, so a backfill fetching the
 * same item produces the same key and the second copy collides. A second,
 * private implementation here was the bug: it diverged from
 * dedup-key.util.ts and from schema.md.
 *
 * An id alone is not enough for a Facebook `feed` change. One comment id can
 * carry several distinct events over its life — added, edited, hidden, removed —
 * so keying on the id alone made every event after the first collide and be
 * discarded. The verb is therefore part of the key.
 */
function composeDedupKey(
  platform: Platform,
  eventType: InboundEventType,
  platformEventId: string | null,
  verb: string | null,
  payload: unknown,
): string {
  if (platformEventId) {
    const identity = verb ? `${platformEventId}:${verb}` : platformEventId;
    return inboundDedupKey(platform, eventType, identity);
  }
  // No id: collapse identical payloads, which is correct — two identical
  // notifications mean the same refresh.
  return inboundDedupKeyFromPayload(platform, eventType, payload);
}

/** `add` / `edit` / `hide` / `remove` — what HAPPENED, not just to what. */
function extractVerb(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const verb = (value as Record<string, unknown>).verb;
  return typeof verb === 'string' && verb ? verb : null;
}

/** Facebook's feed discriminator: comment, status, photo, video, share, like. */
function readItem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = (value as { item?: unknown }).item;
  return typeof item === 'string' ? item : null;
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
