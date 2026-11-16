import { describe, expect, it } from 'vitest';
import { QueueStatus } from '@/database/repositories/queue-ledger.repository';
import { AssistantReplyStatus, MediaAnalysisStatus } from '@/shared/enums';

/**
 * The agreement the shared claim depends on.
 *
 * Each ledger keeps its own status enum, because each has terminal states of
 * its own — a description is `done`, a reply is `sent` or `skipped`. The four
 * below are the ones the shared mechanics bind as parameters, and they only
 * work because both enums spell them identically.
 *
 * A DIVERGENCE WOULD NOT THROW. Rename one of these in one enum and the claim
 * keeps running, matches nothing, and the queue silently stops being worked —
 * noticed by a customer who never got a reply rather than by anything here.
 * That is the entire reason this file exists.
 */
describe('what the shared queue mechanics assume', () => {
  it('spells the four claimable states the same in every ledger', () => {
    expect(MediaAnalysisStatus.Pending).toBe(QueueStatus.Pending);
    expect(MediaAnalysisStatus.InFlight).toBe(QueueStatus.InFlight);
    expect(MediaAnalysisStatus.Failed).toBe(QueueStatus.Failed);
    expect(MediaAnalysisStatus.Unavailable).toBe(QueueStatus.Unavailable);

    expect(AssistantReplyStatus.Pending).toBe(QueueStatus.Pending);
    expect(AssistantReplyStatus.InFlight).toBe(QueueStatus.InFlight);
    expect(AssistantReplyStatus.Failed).toBe(QueueStatus.Failed);
    expect(AssistantReplyStatus.Unavailable).toBe(QueueStatus.Unavailable);
  });

  it('leaves each ledger its own terminal states', () => {
    /* The base must never learn about these: "described" and "answered" are
     * not the same kind of finished, and a shared enum would force them to
     * be. */
    expect(MediaAnalysisStatus.Done).toBe('done');
    expect(AssistantReplyStatus.Sent).toBe('sent');
    expect(AssistantReplyStatus.Skipped).toBe('skipped');
  });
});
