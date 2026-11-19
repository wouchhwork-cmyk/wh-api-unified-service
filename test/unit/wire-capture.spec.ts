import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WireCaptureService, type CapturedCall } from '@/modules/ai/wire-capture.service';
import type { AppConfigService } from '@/config';

/**
 * Keeping the exact bodies of a model call.
 *
 * WHY THESE ARE THE TESTS THEY ARE. This writes customers' conversations to
 * disk, so the two things worth holding are that it does NOTHING when it was
 * not switched on, and that what it wrote cannot be read by another business
 * — a filename is not an authorisation.
 *
 * The third is that it never throws. It runs after a reply has already been
 * produced and is about to be sent; a debug instrument that takes down the
 * thing it is watching is worse than not having one.
 */
function silentLogger(): never {
  return { warn: () => undefined, error: () => undefined } as never;
}

function call(over: Partial<CapturedCall> = {}): CapturedCall {
  return {
    callRef: '091bae9e-d50c-48e5-a82a-6df3ef9653ce',
    enterpriseId: 1,
    at: new Date('2026-11-18T01:30:25.000Z').toISOString(),
    purpose: 'auto_reply',
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    messageId: 1149,
    round: 0,
    durationMs: 4567,
    request: null,
    response: null,
    parsed: { text: 'The wedding is on November 30, 2026.' },
    usage: { inputTokens: 10197 },
    ...over,
  };
}

const WIRE = { request: { model: 'x', input: ['prompt'] }, response: { output: 'answer' } };

describe('keeping the bodies of a model call', () => {
  let dir: string;

  const serviceWith = (enabled: boolean, maxFiles = 500): WireCaptureService =>
    new WireCaptureService(
      { aiWireCapture: { enabled, dir, maxFiles } } as unknown as AppConfigService,
      silentLogger(),
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wire-'));
  });
  afterEach(async () => {
    process.chdir(process.cwd());
  });

  it('writes nothing at all when it was not switched on', async () => {
    await serviceWith(false).record(call(), WIRE);

    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('keeps both bodies exactly as they were', async () => {
    const service = serviceWith(true);
    await service.record(call(), WIRE);

    const found = await service.read(1, call().callRef);
    expect(found?.request).toEqual(WIRE.request);
    expect(found?.response).toEqual(WIRE.response);
  });

  it('keeps what we made of the answer beside the answer itself', async () => {
    // The gap between the two is the interesting part: a reply that parsed
    // into nothing looks identical in the ledger to one never structured.
    const service = serviceWith(true);
    await service.record(call(), WIRE);

    const found = await service.read(1, call().callRef);
    expect(found?.parsed).toEqual({ text: 'The wedding is on November 30, 2026.' });
  });

  it('never hands one business another’s call', async () => {
    // A ref id is not an authorisation, and these files are conversations.
    const service = serviceWith(true);
    await service.record(call({ enterpriseId: 1 }), WIRE);

    expect(await service.read(2, call().callRef)).toBeNull();
  });

  it('refuses a ref that is not a uuid rather than opening a path', async () => {
    const service = serviceWith(true);

    expect(await service.read(1, '../../etc/passwd')).toBeNull();
  });

  it('returns null for a call it never captured', async () => {
    const service = serviceWith(true);

    expect(await service.read(1, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('gives every round of one reply, in the order they happened', async () => {
    const service = serviceWith(true);
    await service.record(call({ callRef: '11111111-1111-4111-8111-111111111111', round: 2 }), WIRE);
    await service.record(call({ callRef: '22222222-2222-4222-8222-222222222222', round: 0 }), WIRE);
    await service.record(call({ callRef: '33333333-3333-4333-8333-333333333333', round: 1 }), WIRE);

    const rounds = await service.readForMessage(1, 1149);
    expect(rounds.map((round) => round.round)).toEqual([0, 1, 2]);
  });

  it('leaves out another business’s rounds for the same message id', async () => {
    const service = serviceWith(true);
    await service.record(call({ callRef: '11111111-1111-4111-8111-111111111111' }), WIRE);
    await service.record(
      call({ callRef: '22222222-2222-4222-8222-222222222222', enterpriseId: 2 }),
      WIRE,
    );

    expect(await service.readForMessage(1, 1149)).toHaveLength(1);
  });

  it('deletes the oldest once the directory is over its ceiling', async () => {
    // An unbounded debug log on a laptop is how a disk fills up overnight.
    const service = serviceWith(true, 2);
    for (const [index, ref] of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ].entries()) {
      await service.record(
        call({ callRef: ref, at: new Date(Date.UTC(2026, 10, 18, 1, index)).toISOString() }),
        WIRE,
      );
    }

    expect((await readdir(dir)).filter((file) => file.endsWith('.json'))).toHaveLength(2);
  });

  it('survives a file somebody has corrupted', async () => {
    // One unreadable file must not hide the rest of the exchange.
    const service = serviceWith(true);
    await service.record(call(), WIRE);
    await writeFile(join(dir, '2026-11-18-broken.json'), '{not json', 'utf8');

    expect(await service.readForMessage(1, 1149)).toHaveLength(1);
  });

  it('does not throw when the answer carried no bodies', async () => {
    // Capture on, provider returned no wire: nothing to write, nothing to fail.
    await expect(serviceWith(true).record(call(), undefined)).resolves.toBeUndefined();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('writes a name that sorts in call order and ends with the ref', async () => {
    const service = serviceWith(true);
    await service.record(call(), WIRE);

    const [name] = await readdir(dir);
    expect(name?.endsWith(`${call().callRef}.json`)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, name ?? ''), 'utf8')).callRef).toBe(call().callRef);
  });
});
