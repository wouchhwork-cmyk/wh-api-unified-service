import { describe, expect, it, vi } from 'vitest';
import { ToolRunnerService } from '@/modules/ai/tools/tool-runner.service';
import { ToolName } from '@/modules/ai/tools/tool.specs';
import type { RequestedTool } from '@/modules/ai/tools/tool.contract';

/**
 * What a reward lookup is allowed to hand back.
 *
 * A UNIT TEST AND NOT AN INTEGRATION ONE, deliberately. The guarantee is
 * about a MAPPING — that the field carrying a redemption code is never
 * copied into what the model sees — and proving that against real Postgres
 * would mean standing up a programme, a rule and an award to assert one
 * absence. The absence is the whole point, so it is tested where it lives.
 *
 * WHY IT MATTERS. A redemption code is a bearer value: whoever reads it can
 * spend the reward. A model is an easy thing to talk one out of, and a code
 * read aloud in a public comment thread is spent by whoever sees it first.
 */
function runnerWith(
  entitlements: unknown[],
  wallets: unknown[] = [],
  entries: unknown[] = [],
): ToolRunnerService {
  const stub = (value: unknown) => ({
    listCustomerWallets: vi.fn().mockResolvedValue(value),
    listCustomerEntries: vi.fn().mockResolvedValue(entries),
  });

  return new ToolRunnerService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    /* The ledger write is fire-and-forget; the run must not depend on it. */
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    stub(wallets) as never,
    { listForCustomer: vi.fn().mockResolvedValue(entitlements) } as never,
    { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
  );
}

const ask = (args: Record<string, unknown> = {}): RequestedTool => ({
  name: ToolName.RewardBalance,
  args,
  because: 'they asked what they have',
});

const CONTEXT = {
  enterpriseId: 1,
  conversationId: 2,
  customerId: 3,
  customerIdentifierId: 4,
  messageId: null,
  modelCallId: null,
  round: 1,
};

const ENTITLEMENT = {
  id: 1,
  refId: 'ent-ref',
  itemRef: 'free_coffee',
  status: 'issued',
  redemptionCode: 'SECRET-CODE-123',
  issuedAt: new Date('2026-11-01T00:00:00Z'),
  expiresAt: new Date('2026-12-01T00:00:00Z'),
};

describe('handing back what somebody has earned', () => {
  it('never includes the redemption code', async () => {
    const run = await runnerWith([ENTITLEMENT]).run(ask(), CONTEXT);

    expect(JSON.stringify(run.data)).not.toContain('SECRET-CODE-123');
  });

  it('still says the reward exists, and what it is for', async () => {
    // Withholding the code must not withhold the fact. "You have a free
    // coffee waiting" is the answer; the code is a separate decision.
    const run = await runnerWith([ENTITLEMENT]).run(ask(), CONTEXT);

    expect(JSON.stringify(run.data)).toContain('free_coffee');
    expect(JSON.stringify(run.data)).toContain('issued');
  });

  it('says when it lapses, because that changes what to tell them', async () => {
    const run = await runnerWith([ENTITLEMENT]).run(ask(), CONTEXT);

    expect(JSON.stringify(run.data)).toContain('2026-12-01');
  });

  it('tells the model where to send somebody who needs the code', async () => {
    const run = await runnerWith([ENTITLEMENT]).run(ask(), CONTEXT);

    expect(run.note).toContain('hand over to a colleague');
  });

  it('reports a balance with what is pending kept separate', async () => {
    // Earned and usable are not the same number, and the gap between them
    // is exactly what somebody disputes.
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 250,
          pendingBalance: 40,
          lifetimeEarned: 290,
        },
      ],
    ).run(ask(), CONTEXT);

    const data = JSON.stringify(run.data);
    expect(data).toContain('"balance":250');
    expect(data).toContain('"pending":40');
  });
});

/**
 * How a balance got to where it is.
 *
 * WRITTEN FROM A LIVE FAILURE. Asked for a balance the assistant gave one,
 * correctly — 2520 points. Asked "how i earned the 2520 points? Can you tell
 * day or order wise" it said it could not check and handed over, while the
 * whole ledger sat one join away from the rule that granted each entry.
 */
describe('how the balance was reached', () => {
  const ENTRY = {
    entryKind: 'earn',
    amount: 10,
    balanceAfter: 2570,
    occurredAtUtc: new Date('2026-11-19T10:56:30Z'),
    reasonCode: null,
    triggerKind: 'direct_message_inbound',
    programName: 'Diwali Loyalty',
    walletKind: 'points',
    currencyCode: null,
  };

  it('is not fetched when nobody asked for it', async () => {
    // The common question is "what is my balance", and a statement on every
    // one of those is a paragraph nobody reads, paid for on every reply.
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 2570,
          pendingBalance: 0,
          lifetimeEarned: 2570,
        },
      ],
      [ENTRY],
    ).run(ask(), CONTEXT);

    expect(JSON.stringify(run.data)).not.toContain('how_it_was_earned');
  });

  it('says what they did to earn it, not what the column calls it', async () => {
    // `direct_message_inbound` in front of a customer is a database leaking.
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 2570,
          pendingBalance: 0,
          lifetimeEarned: 2570,
        },
      ],
      [ENTRY],
    ).run(ask({ history: 5 }), CONTEXT);

    const data = JSON.stringify(run.data);
    expect(data).toContain('sending a direct message');
    expect(data).not.toContain('direct_message_inbound');
  });

  it('carries the date, the amount and the programme that granted it', async () => {
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 2570,
          pendingBalance: 0,
          lifetimeEarned: 2570,
        },
      ],
      [ENTRY],
    ).run(ask({ history: 5 }), CONTEXT);

    const data = JSON.stringify(run.data);
    expect(data).toContain('2026-11-19');
    expect(data).toContain('Diwali Loyalty');
    expect(data).toContain('"amount":10');
  });

  it('keeps an unmapped trigger readable rather than dropping it', async () => {
    // A rule added after the wording map was written must still answer.
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 2570,
          pendingBalance: 0,
          lifetimeEarned: 2570,
        },
      ],
      [{ ...ENTRY, triggerKind: 'some_new_trigger' }],
    ).run(ask({ history: 5 }), CONTEXT);

    expect(JSON.stringify(run.data)).toContain('some new trigger');
  });

  it('refuses to be talked into a cash value for points', async () => {
    /*
     * ASKED LIVE: "Of the points, how many dollars or points". A model
     * holding a bare number will invent a rate, and a made-up exchange rate
     * quoted to a customer is a price this business never set.
     */
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 2570,
          pendingBalance: 0,
          lifetimeEarned: 2570,
        },
      ],
    ).run(ask(), CONTEXT);

    expect(run.note).toContain('NO cash value');
    expect(run.note).toContain('Do not convert them to money');
  });

  it('says nothing about cash value when the wallet really is money', async () => {
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'credit',
          currencyCode: 'INR',
          balance: 500,
          pendingBalance: 0,
          lifetimeEarned: 500,
        },
      ],
    ).run(ask(), CONTEXT);

    expect(run.note).not.toContain('NO cash value');
  });

  it('warns there are older entries when it filled the count asked for', async () => {
    const run = await runnerWith(
      [],
      [
        {
          walletKind: 'points',
          currencyCode: null,
          balance: 2570,
          pendingBalance: 0,
          lifetimeEarned: 2570,
        },
      ],
      [ENTRY, ENTRY],
    ).run(ask({ history: 2 }), CONTEXT);

    expect(run.note).toContain('there are likely older ones');
  });
});
