import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config';
import { AssistantReplyRepository } from '@/database/repositories/assistant-reply.repository';
import { AutoReplyService } from '@/modules/inbox/auto-reply.service';
import { ASSISTANT_REPLY_BATCH_SIZE, ASSISTANT_REPLY_LEASE_SECONDS } from '@/shared/constants';
import { BasePoller } from './base-poller';

/**
 * Answers the messages the assistant owes a reply to, a claimed batch at a
 * time.
 *
 * SEPARATE FROM INGEST ON PURPOSE, for the same reason the analysis worker
 * is. Drafting is a model call and sending is an HTTP call; a webhook has to
 * be acknowledged in milliseconds. Doing it inline meant Meta retrying
 * deliveries while we talked to OpenAI — and worse, it meant the obligation
 * to answer lived on this process's stack rather than in the database, so a
 * restart lost replies silently.
 *
 * SERIAL WITHIN A BATCH, not parallel. Each item is a model call against a
 * per-key rate limit, and five at once buys little while making a 429 far
 * more likely — which we have already met on this path. The batch size is
 * the throughput control; concurrency inside it is not.
 */
@Injectable()
export class AssistantReplyWorker extends BasePoller {
  protected readonly name = 'assistant-reply';

  constructor(
    private readonly replies: AssistantReplyRepository,
    private readonly assistant: AutoReplyService,
    protected readonly config: AppConfigService,
    @InjectPinoLogger(AssistantReplyWorker.name) protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected async pollOnce(): Promise<number> {
    /*
     * A LAPSED LEASE GOES BACK IN THE QUEUE. The row is returned as failed
     * rather than pending, so it keeps the attempt it spent: a reply whose
     * worker died mid-model-call has genuinely been tried, and a lease that
     * kept lapsing would otherwise retry it forever.
     */
    await this.replies.reclaimExpiredLeases();

    const claimed = await this.replies.claimDueBatch(
      this.leaseOwner,
      ASSISTANT_REPLY_BATCH_SIZE,
      ASSISTANT_REPLY_LEASE_SECONDS,
    );
    if (claimed.length === 0) return 0;

    for (const item of claimed) {
      /*
       * `attempt` settles its own row on every path, including failure, so
       * one bad conversation cannot stop the batch or leave a row leased to
       * a worker that has moved on.
       *
       * THE SWITCHES ARE CHECKED IN THERE, NOT HERE. The analysis worker
       * refuses to claim at all when its feature is off, because claiming
       * and failing would burn attempts and write off a backlog. This one
       * claims and settles as `skipped`, because "the switch was off when
       * this message arrived" is the honest answer and a message that was
       * not answered at the time should not be answered an hour later when
       * somebody flips it on.
       */
      await this.assistant.attempt(item, this.leaseOwner);
    }
    return claimed.length;
  }
}
