import { describe, expect, it } from 'vitest';
import {
  buildPlatformFacts,
  resolveDirectMessageTrigger,
} from '@/modules/inbox/direct-message-projector.service';
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

  /**
   * FROM THE PAYLOAD, not from hand-written facts.
   *
   * The resolver's inputs are only as good as the extraction that feeds it, and
   * the risk in all of this is the field names Meta uses — not the branching.
   * Six story mentions and one story reply in the stored traffic were replayed
   * through `buildPlatformFacts` and classified correctly; these cover the two
   * shapes that have never once arrived, so they have no live evidence at all.
   */
  describe('from a whole messaging event', () => {
    const triggerFor = (event: Record<string, unknown>, isStoryMention = false) =>
      resolveDirectMessageTrigger(
        buildPlatformFacts(
          (event as { message?: Record<string, unknown> }).message ?? {},
          event,
          isStoryMention,
        ),
      );

    /** An m.me link, an ad, or a QR code in the shop. Never yet observed live. */
    it('reads an arrival from a referral payload', () => {
      expect(
        triggerFor({
          sender: { id: '123' },
          message: { mid: 'm1', text: 'hi' },
          referral: { ref: 'AUTUMN', source: 'ADS', type: 'OPEN_THREAD', ad_id: '456' },
        }),
      ).toBe(RewardTriggerKind.ReferralEntry);
    });

    /** An ice breaker or template button. Never yet observed live. */
    it('reads a postback payload', () => {
      expect(
        triggerFor({
          sender: { id: '123' },
          postback: { mid: 'm2', title: 'See the menu', payload: 'MENU' },
        }),
      ).toBe(RewardTriggerKind.PostbackTapped);
    });

    it('reads a quick reply as a tap', () => {
      expect(
        triggerFor({
          sender: { id: '123' },
          message: { mid: 'm3', text: 'Yes', quick_reply: { payload: 'YES' } },
        }),
      ).toBe(RewardTriggerKind.PostbackTapped);
    });

    /**
     * THE SHAPE THAT ACTUALLY ARRIVES, taken from stored traffic: a story reply
     * carries reply_to.story, and the ordinary reply fields sit beside it.
     */
    it('reads a story reply without being confused by the reply fields', () => {
      expect(
        triggerFor({
          sender: { id: '123' },
          message: {
            mid: 'm4',
            text: 'love this',
            reply_to: {
              mid: 'parent',
              is_self_reply: false,
              story: { id: '17900000000000000', url: 'https://example.test/s.jpg' },
            },
          },
        }),
      ).toBe(RewardTriggerKind.StoryReply);
    });

    /** A plain reply to a MESSAGE is not a story reply. */
    it('does not treat an ordinary reply as a story reply', () => {
      expect(
        triggerFor({
          sender: { id: '123' },
          message: { mid: 'm5', text: 'ok', reply_to: { mid: 'parent', is_self_reply: false } },
        }),
      ).toBe(RewardTriggerKind.DirectMessageInbound);
    });

    it('reads a story mention from the normalised attachment flag', () => {
      expect(triggerFor({ sender: { id: '123' }, message: { mid: 'm6' } }, true)).toBe(
        RewardTriggerKind.StoryMention,
      );
    });

    it('leaves an ordinary text message alone', () => {
      expect(triggerFor({ sender: { id: '123' }, message: { mid: 'm7', text: 'Yhy' } })).toBe(
        RewardTriggerKind.DirectMessageInbound,
      );
    });
  });
});
