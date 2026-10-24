import { describe, expect, it } from 'vitest';
import { resolveDirectMessageTrigger } from '@/modules/inbox/direct-message-projector.service';
import { RewardTriggerKind } from '@/shared/enums';

/**
 * Which reward trigger an inbound DM actually is.
 *
 * Four triggers in the catalogue — story_mention, story_reply, referral_entry,
 * postback_tapped — were configurable, saved, listed, and could NEVER fire: the
 * worker mapped a conversation kind through a three-entry table, so everything
 * arriving in the DM thread was `direct_message_inbound`. A business built two
 * programmes on story_mention and got silence.
 *
 * The facts that tell them apart were already on the message. These tests pin
 * the precedence, which is the part that will rot first.
 */
describe('resolveDirectMessageTrigger', () => {
  it('is an ordinary direct message when nothing marks it', () => {
    expect(resolveDirectMessageTrigger({})).toBe(RewardTriggerKind.DirectMessageInbound);
  });

  it('reads a story mention', () => {
    expect(resolveDirectMessageTrigger({ isStoryMention: true })).toBe(
      RewardTriggerKind.StoryMention,
    );
  });

  /** THEY REPLIED TO OURS, which is not the same act as mentioning us. */
  it('reads a story reply, and does not confuse it with a mention', () => {
    const trigger = resolveDirectMessageTrigger({
      replyToStoryId: '17900000000000000',
      replyToStoryUrl: 'https://example.test/story.jpg',
    });
    expect(trigger).toBe(RewardTriggerKind.StoryReply);
    expect(trigger).not.toBe(RewardTriggerKind.StoryMention);
  });

  it('reads an arrival from an ad, link or QR code', () => {
    expect(resolveDirectMessageTrigger({ referral: { source: 'ADS', ref: 'AUTUMN' } })).toBe(
      RewardTriggerKind.ReferralEntry,
    );
  });

  it('reads a tapped button, however the tap is reported', () => {
    expect(resolveDirectMessageTrigger({ isPostback: true })).toBe(
      RewardTriggerKind.PostbackTapped,
    );
    expect(resolveDirectMessageTrigger({ postbackPayload: 'MENU' })).toBe(
      RewardTriggerKind.PostbackTapped,
    );
    expect(resolveDirectMessageTrigger({ quickReplyPayload: 'YES' })).toBe(
      RewardTriggerKind.PostbackTapped,
    );
  });

  /**
   * EXACTLY ONE TRIGGER PER EVENT, and this is why the order is fixed.
   *
   * A story mention arrives as a direct message, so if both could fire, one
   * action would pay a story_mention rule AND a direct_message_inbound rule.
   * The specific one wins; the general one never sees it.
   */
  it('lets the most specific fact win when several are present', () => {
    expect(
      resolveDirectMessageTrigger({
        isStoryMention: true,
        replyToStoryId: '179',
        referral: { ref: 'X' },
        isPostback: true,
      }),
    ).toBe(RewardTriggerKind.StoryMention);

    expect(resolveDirectMessageTrigger({ replyToStoryId: '179', referral: { ref: 'X' } })).toBe(
      RewardTriggerKind.StoryReply,
    );

    /* The campaign arrival outranks the tap that carried it. */
    expect(
      resolveDirectMessageTrigger({ referral: { ref: 'X' }, postbackPayload: 'GET_OFFER' }),
    ).toBe(RewardTriggerKind.ReferralEntry);
  });

  /**
   * A FACT PRESENT BUT FALSE IS NOT THE SAME AS ABSENT.
   *
   * `replyIsSelfReply: false` sits next to these on real payloads, and a
   * truthiness check on the wrong key would reclassify ordinary messages.
   */
  it('ignores a story-mention flag that is explicitly false', () => {
    expect(resolveDirectMessageTrigger({ isStoryMention: false })).toBe(
      RewardTriggerKind.DirectMessageInbound,
    );
  });
});
