import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { MediaAnalysisService } from '@/modules/ai/media-analysis.service';
import { AutoReplyService } from '@/modules/inbox/auto-reply.service';
import { GeminiClient } from '@/modules/ai/gemini.client';
import { MEDIA_ANALYSIS_BATCH_SIZE, MEDIA_ANALYSIS_LEASE_SECONDS } from '@/shared/constants';
import { BasePoller } from './base-poller';

/**
 * Describes queued media, one claimed batch at a time.
 *
 * SEPARATE FROM INGEST ON PURPOSE. Downloading a file and asking a model about
 * it takes seconds; a webhook has to be acknowledged in milliseconds. Doing it
 * inline would mean Meta retrying deliveries while we talk to Google, so the
 * ingest path writes a ledger row and this picks it up.
 *
 * SERIAL WITHIN A BATCH, not parallel. Each item is a download plus a model
 * call against a per-key rate limit, and five at once buys little while making
 * a rate-limit response far more likely. The batch size is the throughput
 * control; concurrency within it is not.
 */
@Injectable()
export class MediaAnalysisWorker extends BasePoller {
  protected readonly name = 'media-analysis';

  constructor(
    private readonly analyses: MediaAnalysisRepository,
    private readonly media: MediaAnalysisService,
    private readonly gemini: GeminiClient,
    private readonly assistant: AutoReplyService,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(MediaAnalysisWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected async pollOnce(): Promise<number> {
    /*
     * WITH THE FEATURE OFF THIS DOES NOT CLAIM. Claiming and then failing
     * every row would burn their attempts and park them as `unavailable`, so
     * that switching the feature on later would find a backlog already written
     * off. Not claiming leaves the queue exactly as it was.
     */
    if (!this.gemini.enabled) return 0;

    await this.analyses.reclaimExpiredLeases();

    const claimed = await this.analyses.claimDueBatch(
      this.leaseOwner,
      MEDIA_ANALYSIS_BATCH_SIZE,
      MEDIA_ANALYSIS_LEASE_SECONDS,
    );
    if (claimed.length === 0) return 0;

    for (const item of claimed) {
      /*
       * `analyse` settles its own row on every path, including failure, so one
       * bad piece of media cannot stop the batch or leave a row leased.
       */
      await this.media.analyse(item, this.leaseOwner);

      /*
       * AND ANYTHING THAT WAS WAITING ON IT BECOMES DUE. A photo sent with no
       * text reaches the assistant's queue before this worker has described
       * it, so that reply holds with a line and puts its row back.
       *
       * A NUDGE, NOT A HANDOFF. This used to answer the customer from inside
       * this loop; now it only brings the owed reply forward, and the
       * assistant's own worker does the answering with every guard re-checked
       * there. If this call fails, or this process dies the instant after it,
       * the row still carries its own next attempt — the reply is late rather
       * than lost.
       *
       * `analyse` settles every path including failure, so media that could
       * not be described releases the wait rather than extending it.
       */
      await this.assistant.onMediaDescribed(item.enterpriseId, item.mediaKey);
    }
    return claimed.length;
  }
}
