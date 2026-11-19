import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import type { ChatWire } from './ai.provider';

/** A UUID and nothing else. This value becomes part of a filename. */
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One exchange with a model, written down whole.
 *
 * `request` and `response` are the provider's own bodies. Everything beside
 * them is what this service knew at the time — which call it was, what it was
 * answering, and what we made of the reply.
 */
export interface CapturedCall {
  readonly callRef: string;
  readonly enterpriseId: number;
  readonly at: string;
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly messageId: number | null;
  /** Which pass of the tool loop this was: 0 is the first ask. */
  readonly round: number;
  readonly durationMs: number;
  readonly request: unknown;
  readonly response: unknown;
  /**
   * What the envelope was read as.
   *
   * KEPT BESIDE THE RAW ANSWER rather than instead of it, because the gap
   * between them is the interesting part: a reply that parsed into nothing
   * looks identical in the ledger to one the model never structured.
   */
  readonly parsed: unknown;
  readonly usage: unknown;
}

/**
 * The exact bodies of a model call, kept on disk for somebody debugging one.
 *
 * WHY THIS EXISTS AT ALL, given `model_calls` and the replay endpoint. Those
 * two answer different questions and neither answers this one:
 *
 *   model_calls   what it cost and how long it took. Metadata by design —
 *                 the comment on the entity says so, and that choice stands.
 *   /prompt       what we WOULD send if we built it again now, checked
 *                 against a fingerprint. A reconstruction, and it says so.
 *   here          what actually went out, and what actually came back.
 *
 * The third became necessary when tools arrived. One reply is now up to four
 * exchanges — ask, run a tool, ask again with the result — and until now
 * nothing tied them together or showed the model's own words in between.
 *
 * OFF UNLESS SWITCHED ON, and refused in prod by the env schema: these files
 * are whole conversations in plain text. See `AI_WIRE_CAPTURE_ENABLED`.
 *
 * NOTHING HERE MAY BREAK A REPLY. Every method swallows its own failures and
 * logs them. A debugging instrument that takes down the thing it is watching
 * is worse than not having one.
 */
@Injectable()
export class WireCaptureService {
  constructor(
    private readonly config: AppConfigService,
    @InjectPinoLogger(WireCaptureService.name) private readonly logger: PinoLogger,
  ) {}

  get enabled(): boolean {
    return this.config.aiWireCapture.enabled;
  }

  /**
   * Writes one exchange, if capture is on.
   *
   * The filename leads with the timestamp so an ordinary directory listing
   * is in call order, and ends with the call ref so a reader can find one
   * from a ledger row without opening anything.
   */
  async record(call: CapturedCall, wire: ChatWire | undefined): Promise<void> {
    if (!this.enabled || !wire || !REF.test(call.callRef)) return;

    try {
      const dir = this.directory();
      await mkdir(dir, { recursive: true });
      const name = `${call.at.replace(/[:.]/g, '-')}-${call.callRef}.json`;
      await writeFile(
        join(dir, name),
        JSON.stringify({ ...call, request: wire.request, response: wire.response }, null, 2),
        'utf8',
      );
      await this.prune(dir);
    } catch (error) {
      /* Deliberately swallowed: see the class comment. The reply this was
       * watching has already been produced and must still be sent. */
      this.logger.warn(
        { err: error, callRef: call.callRef },
        'could not write the wire capture for this call',
      );
    }
  }

  /**
   * One call's exchange, by its ref.
   *
   * TENANT SCOPED ON THE WAY OUT. The enterprise is stored in the file and
   * checked here — a filename is not an authorisation, and a ref id that
   * leaked would otherwise read another business's conversation.
   */
  async read(enterpriseId: number, callRef: string): Promise<CapturedCall | null> {
    if (!this.enabled || !REF.test(callRef)) return null;

    try {
      const dir = this.directory();
      const match = (await readdir(dir)).find((file) => file.endsWith(`${callRef}.json`));
      if (!match) return null;

      const parsed: unknown = JSON.parse(await readFile(join(dir, match), 'utf8'));
      const call = parsed as CapturedCall;
      return call.enterpriseId === enterpriseId ? call : null;
    } catch {
      /* A missing directory is the ordinary case before the first call. */
      return null;
    }
  }

  /** Every captured exchange for one message, oldest round first. */
  async readForMessage(enterpriseId: number, messageId: number): Promise<CapturedCall[]> {
    if (!this.enabled) return [];

    try {
      const dir = this.directory();
      const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
      const found: CapturedCall[] = [];
      for (const file of files) {
        try {
          const call = JSON.parse(await readFile(join(dir, file), 'utf8')) as CapturedCall;
          if (call.enterpriseId === enterpriseId && call.messageId === messageId) found.push(call);
        } catch {
          /* One unreadable file must not hide the rest of the exchange. */
        }
      }
      return found.sort((a, b) => a.round - b.round);
    } catch {
      return [];
    }
  }

  /**
   * Keeps the directory under its ceiling, oldest first.
   *
   * The names sort chronologically, so "oldest" needs no stat call.
   */
  private async prune(dir: string): Promise<void> {
    const max = this.config.aiWireCapture.maxFiles;
    const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
    for (const file of files.slice(0, Math.max(0, files.length - max))) {
      await unlink(join(dir, file)).catch(() => undefined);
    }
  }

  private directory(): string {
    return resolve(process.cwd(), this.config.aiWireCapture.dir);
  }
}
