import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';
import { AssistantToolCallRepository } from '@/database/repositories/assistant-tool-call.repository';
import { CallbackRequestRepository } from '@/database/repositories/callback-request.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { ToolRunnerService, type ToolContext } from '@/modules/ai/tools/tool-runner.service';
import { ToolName } from '@/modules/ai/tools/tool.specs';
import { IdentifierKind } from '@/shared/enums';
import { ToolOutcome } from '@/modules/ai/tools/tool-result';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/** The runner logs; nothing here asserts on it. */
function silentLogger(): never {
  return {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as never;
}

/**
 * What happens when the assistant asks this service to do something.
 *
 * AGAINST REAL POSTGRES, because the guarantees that matter here are the
 * ones a mock cannot have: the partial unique index that stops a second
 * colleague ringing the same person, the tenant scope on every read, and
 * the evidence check that makes a recorded name checkable afterwards.
 *
 * THE RUNNER NEVER THROWS, and most of these hold that. A tool is an
 * improvement on an answer, never a prerequisite for one — a lookup that
 * fails must come back as something the model can say out loud, not as an
 * exception that takes down a reply somebody is waiting for.
 */
describe('the assistant using a tool', () => {
  let db: DataSource;
  let runner: ToolRunnerService;
  let messages: MessageRepository;
  let callbacks: CallbackRequestRepository;
  let ledger: AssistantToolCallRepository;
  let customers: CustomerRepository;

  let enterpriseId: number;
  let otherEnterpriseId: number;
  let conversationId: number;
  let customerId: number;
  let identifierId: number;

  beforeAll(async () => {
    db = await createTestDataSource();
    customers = new CustomerRepository(db);
    messages = new MessageRepository(db);
    callbacks = new CallbackRequestRepository(db);
    ledger = new AssistantToolCallRepository(db);
    runner = new ToolRunnerService(
      customers,
      messages,
      new MediaAnalysisRepository(db),
      new MessageAttachmentRepository(db),
      ledger,
      callbacks,
      new EnterpriseRepository(db),
      new ConversationRepository(db),
      new RewardWalletRepository(db),
      new RewardEntitlementRepository(db),
      silentLogger(),
    );
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');
    otherEnterpriseId = await seedEnterprise(db, 'Rival', 'rival');

    const connection: { id: string }[] = await db.query(
      `INSERT INTO provider_connections
         (enterprise_id, provider, provider_category, provider_user_id, access_token)
       VALUES ($1,'meta','social','fbu','envelope') RETURNING id`,
      [enterpriseId],
    );
    const channel: { id: string }[] = await db.query(
      `INSERT INTO channels
         (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
       VALUES ($1,$2,'instagram','page','PAGE_1') RETURNING id`,
      [connection[0]?.id, enterpriseId],
    );
    const customer: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source, first_channel_id)
       VALUES ($1,NULL,'direct_message',$2) RETURNING id`,
      [enterpriseId, channel[0]?.id],
    );
    customerId = Number(customer[0]?.id);

    const identifier: { id: string }[] = await db.query(
      `INSERT INTO customer_identifiers
         (enterprise_id, customer_id, identifier_kind, identifier_value, identifier_value_raw,
          verification_status, source, status)
       VALUES ($1,$2,'instagram_username','genzrelics','genzrelics','verified','platform','active')
       RETURNING id`,
      [enterpriseId, customerId],
    );
    identifierId = Number(identifier[0]?.id);

    const conversation: { id: string }[] = await db.query(
      `INSERT INTO conversations
         (enterprise_id, channel_id, customer_id, platform, conversation_kind,
          platform_thread_id, status)
       VALUES ($1,$2,$3,'instagram','direct_message','thread-1','open') RETURNING id`,
      [enterpriseId, channel[0]?.id, customerId],
    );
    conversationId = Number(conversation[0]?.id);
  });

  function ctx(over: Partial<ToolContext> = {}): ToolContext {
    return {
      enterpriseId,
      conversationId,
      customerId,
      customerIdentifierId: identifierId,
      messageId: null,
      modelCallId: null,
      round: 1,
      ...over,
    };
  }

  async function addMessage(body: string, direction: 'inbound' | 'outbound' = 'inbound') {
    const row: { ref_id: string; id: string }[] = await db.query(
      `INSERT INTO messages
         (enterprise_id, conversation_id, direction, message_kind, body, status)
       VALUES ($1,$2,$3,'text',$4,'delivered') RETURNING ref_id, id`,
      [enterpriseId, conversationId, direction, body],
    );
    return { refId: String(row[0]?.ref_id), id: Number(row[0]?.id) };
  }

  const ask = (
    name: string,
    args: Record<string, unknown> = {},
    because = 'because I need it',
  ) => ({
    name,
    args,
    because,
  });

  describe('a tool it invented', () => {
    it('is told so rather than silently ignored', async () => {
      // A model that invented a tool needs to know it did, or it answers as
      // though the call succeeded.
      const run = await runner.run(ask('send_them_money'), ctx());

      expect(run.outcome).toBe(ToolOutcome.Unknown);
      expect(run.note).toContain('there is no tool called');
    });

    it('is recorded, because it still says something about the model', async () => {
      await runner.run(ask('send_them_money'), ctx());

      const rows = await ledger.recent(enterpriseId, conversationId, 10);
      expect(rows[0]?.toolName).toBe('send_them_money');
      expect(rows[0]?.outcome).toBe(ToolOutcome.Unknown);
    });
  });

  describe('looking the customer up', () => {
    it('keeps the name we recorded apart from the one on their profile', async () => {
      await customers.setDeclaredIdentity(enterpriseId, customerId, {
        displayName: 'Rahul Sharma',
      });

      const run = await runner.run(ask(ToolName.CustomerDetails), ctx());
      const data = run.data as Record<string, unknown>;

      expect(run.outcome).toBe(ToolOutcome.Ok);
      expect(data.name_we_recorded).toBe('Rahul Sharma');
      expect(data.handle).toBe('@genzrelics');
    });

    it('says nothing rather than false about a signal we were never told', async () => {
      /*
       * A missing key means "the platform has not told us", which is not
       * "no" — and answering no is the model telling a customer something
       * about their own account that we never learned.
       */
      const run = await runner.run(ask(ToolName.CustomerDetails), ctx());
      const data = run.data as Record<string, unknown>;

      expect(data.follows_this_business).toBeNull();
      expect(data.followers).toBeNull();
    });
  });

  describe('going back for a message', () => {
    it('returns the one its notes point at', async () => {
      const target = await addMessage('the wedding is on 30 Nov');

      const run = await runner.run(
        ask(ToolName.OneMessage, { message_id: target.refId, before: 0, after: 0 }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Ok);
      expect(run.data).toHaveLength(1);
      expect((run.data as { text: string }[])[0]?.text).toBe('the wedding is on 30 Nov');
    });

    it('returns the messages around it when asked, in order', async () => {
      await addMessage('one');
      await addMessage('two');
      const target = await addMessage('three');
      await addMessage('four');
      await addMessage('five');

      const run = await runner.run(
        ask(ToolName.OneMessage, { message_id: target.refId, before: 2, after: 1 }),
        ctx(),
      );

      expect((run.data as { text: string }[]).map((row) => row.text)).toEqual([
        'one',
        'two',
        'three',
        'four',
      ]);
    });

    it('caps the window however much it asks for', async () => {
      // A model told it may ask for context will ask for a lot of it.
      const target = await addMessage('anchor');
      const run = await runner.run(
        ask(ToolName.OneMessage, { message_id: target.refId, before: 500, after: 500 }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Ok);
      expect((run.data as unknown[]).length).toBeLessThanOrEqual(21);
    });

    it('refuses a shortened id rather than guessing at it', async () => {
      const run = await runner.run(ask(ToolName.OneMessage, { message_id: 'dffe0a1a' }), ctx());

      expect(run.outcome).toBe(ToolOutcome.Empty);
      expect(run.note).toContain('not a full message id');
    });

    it('will not reach a message in another conversation', async () => {
      /*
       * Which is also what a laundered id in a customer's message would be.
       * The model is told the same thing either way, because the difference
       * is none of its business.
       */
      const elsewhere: { ref_id: string }[] = await db.query(
        `INSERT INTO conversations
           (enterprise_id, channel_id, customer_id, platform, conversation_kind,
            platform_thread_id, status)
         VALUES ($1,(SELECT id FROM channels WHERE enterprise_id=$1 LIMIT 1),$2,
                 'instagram','direct_message','thread-2','open')
         RETURNING ref_id`,
        [enterpriseId, customerId],
      );
      const other: { ref_id: string }[] = await db.query(
        `INSERT INTO messages (enterprise_id, conversation_id, direction, message_kind, body, status)
         VALUES ($1,(SELECT id FROM conversations WHERE ref_id=$2),'inbound','text','secret','delivered')
         RETURNING ref_id`,
        [enterpriseId, elsewhere[0]?.ref_id],
      );

      const run = await runner.run(
        ask(ToolName.OneMessage, { message_id: other[0]?.ref_id }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Empty);
      expect(run.note).toContain('no message with that id in this conversation');
    });
  });

  describe('asking for more of the conversation', () => {
    it('returns the most recent, oldest first, with ids to go back for', async () => {
      for (const text of ['one', 'two', 'three', 'four']) await addMessage(text);

      const run = await runner.run(ask(ToolName.EarlierMessages, { count: 3 }), ctx());
      const rows = run.data as { id: string; text: string }[];

      expect(rows.map((row) => row.text)).toEqual(['two', 'three', 'four']);
      expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('caps at a hundred however much it asks for', async () => {
      // A model offered "more context" will take all of it: context feels
      // free to something that does not see the bill.
      await addMessage('only one');

      const run = await runner.run(ask(ToolName.EarlierMessages, { count: 5000 }), ctx());
      expect(run.outcome).toBe(ToolOutcome.Ok);
      expect((run.data as unknown[]).length).toBeLessThanOrEqual(100);
    });

    it('falls back to a sensible number when it does not say how many', async () => {
      await addMessage('one');
      const run = await runner.run(ask(ToolName.EarlierMessages, {}), ctx());

      expect(run.outcome).toBe(ToolOutcome.Ok);
      expect(run.data).toHaveLength(1);
    });

    it('says when that is the whole conversation, so it stops asking', async () => {
      await addMessage('one');
      await addMessage('two');

      const run = await runner.run(ask(ToolName.EarlierMessages, { count: 50 }), ctx());
      expect(run.note).toContain('that is the whole conversation');
    });

    it('points at the other half of the pair rather than inlining media', async () => {
      /*
       * A hundred messages with their descriptions spelled out is a prompt
       * nobody can afford, and the wrong answer besides: what this tool
       * answers is "where is the thing I am looking for".
       */
      for (let i = 0; i < 3; i += 1) await addMessage(`message ${i}`);

      const run = await runner.run(ask(ToolName.EarlierMessages, { count: 2 }), ctx());
      expect(run.note).toContain('use get_one_message on any id here');
    });

    it('leaves internal notes out, which are colleagues talking to each other', async () => {
      await addMessage('what they said');
      await db.query(
        `INSERT INTO messages
           (enterprise_id, conversation_id, direction, message_kind, body, status, is_internal_note)
         VALUES ($1,$2,'outbound','text','do not refund this one','sent',true)`,
        [enterpriseId, conversationId],
      );

      const run = await runner.run(ask(ToolName.EarlierMessages, { count: 50 }), ctx());
      const texts = (run.data as { text: string }[]).map((row) => row.text);

      expect(texts).toEqual(['what they said']);
    });

    it('will not reach another business’s conversation', async () => {
      await addMessage('ours');
      const run = await runner.run(
        ask(ToolName.EarlierMessages, { count: 10 }),
        ctx({ enterpriseId: otherEnterpriseId }),
      );

      expect(run.outcome).toBe(ToolOutcome.Empty);
    });
  });

  describe('asking for a callback', () => {
    it('records one, and says a person will ring rather than that it is ringing', async () => {
      const run = await runner.run(
        ask(ToolName.Callback, { phone: '9876543210', reason: 'wants to change an order' }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Ok);
      expect(run.note).toContain('A colleague will ring them');

      const open = await callbacks.findOpen(enterpriseId, conversationId);
      expect(open?.reason).toBe('wants to change an order');
    });

    it('does not book a second one on the same conversation', async () => {
      /*
       * A customer asking "did you get that?" is asking to be reassured,
       * and the obvious reading is to make sure — which is a second
       * colleague ringing the same person about the same thing. The prompt
       * asks the model not to; the index is what makes asking unnecessary.
       */
      await runner.run(ask(ToolName.Callback, { phone: '9876543210', reason: 'first' }), ctx());
      const second = await runner.run(
        ask(ToolName.Callback, { phone: '9876543210', reason: 'second' }),
        ctx({ round: 2 }),
      );

      expect((second.data as { already_requested: boolean }).already_requested).toBe(true);
      expect(second.note).toContain('already outstanding');

      const rows: { count: string }[] = await db.query(
        `SELECT count(*) FROM callback_requests WHERE enterprise_id = $1`,
        [enterpriseId],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it('asks for what it is missing instead of inventing a number', async () => {
      const run = await runner.run(ask(ToolName.Callback, { reason: 'wants a call' }), ctx());

      expect(run.outcome).toBe(ToolOutcome.Incomplete);
      expect(run.note).toContain('phone');
      expect(run.note).toContain('rather than guessing');
    });
  });

  describe('recording what the customer said about themselves', () => {
    it('records a name and cites the message it was said in', async () => {
      const said = await addMessage("it's Rahul by the way");

      const run = await runner.run(
        ask(ToolName.RecordCustomer, { said_in_message_id: said.refId, name: 'Rahul' }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Ok);
      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.ownDisplayName).toBe('Rahul');
    });

    it('refuses without a message it can point at', async () => {
      // The evidence is what makes the record a claim rather than an
      // assertion — a name with a message behind it that a person can open.
      const run = await runner.run(
        ask(ToolName.RecordCustomer, { name: 'Rahul', said_in_message_id: 'not-an-id' }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Empty);
      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.ownDisplayName).toBeNull();
    });

    it('will not cite a message from another conversation', async () => {
      const elsewhere: { ref_id: string }[] = await db.query(
        `INSERT INTO conversations
           (enterprise_id, channel_id, customer_id, platform, conversation_kind,
            platform_thread_id, status)
         VALUES ($1,(SELECT id FROM channels WHERE enterprise_id=$1 LIMIT 1),$2,
                 'instagram','direct_message','thread-3','open')
         RETURNING ref_id`,
        [enterpriseId, customerId],
      );
      const other: { ref_id: string }[] = await db.query(
        `INSERT INTO messages (enterprise_id, conversation_id, direction, message_kind, body, status)
         VALUES ($1,(SELECT id FROM conversations WHERE ref_id=$2),'inbound','text','x','delivered')
         RETURNING ref_id`,
        [enterpriseId, elsewhere[0]?.ref_id],
      );

      const run = await runner.run(
        ask(ToolName.RecordCustomer, {
          said_in_message_id: other[0]?.ref_id,
          name: 'Someone Else',
        }),
        ctx(),
      );

      expect(run.outcome).toBe(ToolOutcome.Empty);
      expect(run.note).toContain('not in this conversation');
    });

    it('will not overwrite a name a colleague already recorded', async () => {
      /*
       * Somebody who typed a correction does not get it undone by a chat.
       * Reported back rather than replaced, so the model can mention the
       * difference or hand over instead of silently changing it.
       */
      await customers.setDeclaredIdentity(enterpriseId, customerId, {
        displayName: 'Rahul Sharma',
      });
      const said = await addMessage('call me Raj');

      const run = await runner.run(
        ask(ToolName.RecordCustomer, { said_in_message_id: said.refId, name: 'Raj' }),
        ctx(),
      );

      expect(run.note).toContain('already records them as "Rahul Sharma"');
      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.ownDisplayName).toBe('Rahul Sharma');
    });

    it('replaces a handle sitting in the name field, which nobody chose', async () => {
      /*
       * THE LIVE FAILURE. A customer said "it's aditya patil"; the guard
       * refused, reporting that this business already records them as
       * "genzrelics" — their Instagram handle, copied into the name column
       * by code predating the identity split. No colleague ever typed it,
       * so there was nothing to protect, and the record ended up reading
       * first name Aditya, last name Patil, display name genzrelics.
       *
       * The guard is for a typed correction. A value that is simply what
       * the platform calls them has no such claim.
       */
      await customers.setDeclaredIdentity(enterpriseId, customerId, {
        displayName: 'genzrelics',
      });
      const said = await addMessage("it's aditya patil");

      const run = await runner.run(
        ask(ToolName.RecordCustomer, {
          said_in_message_id: said.refId,
          name: 'Aditya Patil',
          first_name: 'Aditya',
          last_name: 'Patil',
        }),
        ctx(),
      );

      // Null when it had no complaint to make, which is the wanted answer.
      expect(run.note ?? '').not.toContain('already records them');
      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.ownDisplayName).toBe('Aditya Patil');
      expect(profile?.ownFirstName).toBe('Aditya');
    });

    it('records the language they asked to be answered in', async () => {
      const said = await addMessage('reply in Hindi please');

      await runner.run(
        ask(ToolName.RecordCustomer, {
          said_in_message_id: said.refId,
          preferred_language: 'Hindi',
        }),
        ctx(),
      );

      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.preferredLanguage).toBe('Hindi');
    });

    it('leaves every field it was not given exactly as it was', async () => {
      // Recording a number must not blank a name that was never mentioned.
      await customers.setDeclaredIdentity(enterpriseId, customerId, { firstName: 'Aditya' });
      const said = await addMessage('my number is 8888888888');

      await runner.run(
        ask(ToolName.RecordCustomer, { said_in_message_id: said.refId, phone: '8888888888' }),
        ctx(),
      );

      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.ownFirstName).toBe('Aditya');
    });

    it('records a contact unverified, because nobody checked it', async () => {
      const said = await addMessage('my number is 9876543210');

      await runner.run(
        ask(ToolName.RecordCustomer, {
          said_in_message_id: said.refId,
          phone: '9876543210',
        }),
        ctx(),
      );

      const contacts = await customers.contactIdentifiers(enterpriseId, customerId);
      expect(contacts[0]?.identifierValue).toBe('+919876543210');
      expect(contacts[0]?.verificationStatus).toBe('unverified');
    });
  });

  /*
   * WRITTEN FROM A LIVE FAILURE. A customer typed "8888 8888 88" and that
   * string went into `identifier_value` — the canonical column every lookup
   * reads — with the three decomposition columns beside it left null. The
   * normalizers already existed; this path had never called them.
   */
  describe('a contact being made fit to store', () => {
    async function record(args: Record<string, unknown>): Promise<string | null> {
      const said = await addMessage('here it is');
      const run = await runner.run(
        ask(ToolName.RecordCustomer, { said_in_message_id: said.refId, ...args }),
        ctx(),
      );
      return run.note;
    }

    async function stored(): Promise<
      {
        identifier_kind: string;
        identifier_value: string;
        identifier_value_raw: string | null;
        country_code: string | null;
        calling_code: string | null;
        national_number: string | null;
      }[]
    > {
      return db.query(
        `SELECT identifier_kind, identifier_value, identifier_value_raw,
                country_code, calling_code, national_number
           FROM customer_identifiers
          WHERE enterprise_id = $1 AND customer_id = $2 AND source = 'self_declared'
          ORDER BY id`,
        [enterpriseId, customerId],
      );
    }

    it('stores the number in full international form, not as it was typed', async () => {
      await record({ phone: '8888 8888 88' });

      const rows = await stored();
      expect(rows[0]?.identifier_value).toBe('+918888888888');
    });

    it('keeps what they actually typed beside it', async () => {
      // The raw column exists for support and display. It held the canonical
      // value until now, which made it worth exactly nothing.
      await record({ phone: '8888 8888 88' });

      const rows = await stored();
      expect(rows[0]?.identifier_value_raw).toBe('8888 8888 88');
    });

    it('fills the three columns a number is decomposed into', async () => {
      // +1 covers twenty territories, so the country is NOT recoverable from
      // the number afterwards. All four are written together or none are.
      await record({ phone: '+91 98765 43210' });

      const rows = await stored();
      expect(rows[0]?.country_code).toBe('IN');
      expect(rows[0]?.calling_code).toBe('91');
      expect(rows[0]?.national_number).toBe('9876543210');
    });

    it('does not store the same person twice for typing it differently', async () => {
      // The whole point of a canonical column. These were two rows before.
      await record({ phone: '8888 8888 88' });
      await record({ phone: '+918888888888' });

      expect((await stored()).length).toBe(1);
    });

    it('reads a bare number as the country this business stated, silently', async () => {
      /*
       * NOT AN ASSUMPTION, which is why nothing is said about it. The
       * business stated its country; a bare number is read as that one
       * because of a declaration, not a guess. Where no country is stated
       * at all, `cleanContact` returns needs_country and the model is told
       * to ask — see the unit tests for that branch.
       */
      const note = await record({ phone: '9876543210' });

      const rows = await stored();
      expect(rows[0]?.identifier_value).toBe('+919876543210');
      /* The note always carries the read-back warning now; what must NOT be
       * there is any mention of a country having been assumed. */
      expect(note).not.toContain('read as');
    });

    it('takes a country the customer stated over the business’s own', async () => {
      await record({ phone: '07400 123456', country: 'GB' });

      const rows = await stored();
      expect(rows[0]?.identifier_value).toBe('+447400123456');
    });

    it('ignores a country written as a word rather than a code', async () => {
      // A model given a free-text field will eventually write "India", and
      // feeding that to the parser is how a valid number becomes a null.
      await record({ phone: '9876543210', country: 'India' });

      const rows = await stored();
      expect(rows[0]?.identifier_value).toBe('+919876543210');
    });

    it('refuses digits that form no real number rather than storing them', async () => {
      // Worse than no record: a number somebody will eventually ring.
      const note = await record({ phone: '12345' });

      expect(await stored()).toEqual([]);
      expect(note).toContain('NOT recorded');
    });

    it('lower-cases an email and trims it', async () => {
      await record({ email: '  Aditya.Patil@Example.COM ' });

      const rows = await stored();
      expect(rows[0]?.identifier_value).toBe('aditya.patil@example.com');
      expect(rows[0]?.identifier_value_raw).toBe('Aditya.Patil@Example.COM');
    });

    it('refuses an address that is not one', async () => {
      const note = await record({ email: 'aditya at example dot com' });

      expect(await stored()).toEqual([]);
      expect(note).toContain('not a usable email address');
    });

    it('refuses a number that is on another customer’s record, and says not to claim otherwise', async () => {
      /*
       * CAUGHT LIVE, AND THE WORST CLASS OF BUG HERE. A customer gave their
       * number in a chat; a colleague had already typed it onto a DIFFERENT
       * customer of the same business. The unique index is per enterprise,
       * not per customer, so ON CONFLICT DO NOTHING did nothing — and this
       * tool reported the number as recorded, so the assistant told them
       * "I have updated that number to your account for you."
       *
       * Nothing had been updated. Everybody believed it had.
       */
      const other: { id: string }[] = await db.query(
        `INSERT INTO customers (enterprise_id, display_name, first_source)
         VALUES ($1,'Somebody Else','direct_message') RETURNING id`,
        [enterpriseId],
      );
      await customers.linkIdentifier({
        enterpriseId,
        customerId: Number(other[0]?.id),
        identifierKind: IdentifierKind.Mobile,
        identifierValue: '+919999999999',
      });

      const note = await record({ phone: '9999999999' });

      expect(await stored()).toEqual([]);
      expect(note).toContain("DIFFERENT customer's record");
      expect(note).toContain('Do NOT tell them it is saved');
    });

    it('hands back the record as it stands, not the request it was given', async () => {
      /*
       * THE STRUCTURAL FIX FOR THE WORST THING THIS SERVICE HAS DONE. The
       * tool used to echo its own arguments back as `recorded`, so a write
       * that silently did nothing still reported the value — and the
       * assistant told a customer "I have updated that number to your
       * account for you." Everything returned now comes from a read taken
       * AFTER the writes, so a value that did not land cannot appear.
       */
      await record({ name: 'Aditya Patil', phone: '8888888888' });

      const said = await addMessage('and my email');
      const run = await runner.run(
        ask(ToolName.RecordCustomer, {
          said_in_message_id: said.refId,
          email: 'aditya@example.com',
        }),
        ctx(),
      );

      const data = JSON.stringify(run.data);
      /* The number from the EARLIER call is present, because it is on the
       * record — not because this call mentioned it. */
      expect(data).toContain('+918888888888');
      expect(data).toContain('aditya@example.com');
      expect(run.note).toContain('read back after writing');
    });

    it('does not report a contact it did not manage to store', async () => {
      // The model writes its reply from what came back. A tool that reports
      // a value it did not store is a tool that writes a lie for it.
      const other: { id: string }[] = await db.query(
        `INSERT INTO customers (enterprise_id, display_name, first_source)
         VALUES ($1,'Somebody Else','direct_message') RETURNING id`,
        [enterpriseId],
      );
      await customers.linkIdentifier({
        enterpriseId,
        customerId: Number(other[0]?.id),
        identifierKind: IdentifierKind.Mobile,
        identifierValue: '+919999999999',
      });

      const said = await addMessage('here it is');
      const run = await runner.run(
        ask(ToolName.RecordCustomer, {
          said_in_message_id: said.refId,
          phone: '9999999999',
        }),
        ctx(),
      );

      expect(JSON.stringify(run.data)).not.toContain('9999999999');
    });

    it('still accepts a number the customer already has themselves', async () => {
      // Re-stating their own number is not a conflict with anybody.
      await record({ phone: '8888888888' });
      await record({ phone: '+918888888888' });

      expect((await stored()).length).toBe(1);
    });

    it('still records the name when the number beside it is refused', async () => {
      // One bad field must not take the rest of the write with it.
      await record({ name: 'Aditya Patil', phone: '12345' });

      const profile = await customers.assistantProfile(enterpriseId, customerId, identifierId);
      expect(profile?.ownDisplayName).toBe('Aditya Patil');
    });
  });

  /*
   * A WHOLE MODULE THAT NOTHING COULD REACH. Reward wallets, awards and
   * entitlements have all existed since the scheme shipped and no tool ever
   * exposed any of them — so "how many points do I have" was unanswerable by
   * a service that knew the answer exactly.
   */
  describe('what they have earned', () => {
    async function wallet(balance: number, pending = 0): Promise<void> {
      await db.query(
        `INSERT INTO reward_wallets
           (enterprise_id, customer_id, account_kind, wallet_kind, currency_code,
            balance, pending_balance, lifetime_earned)
         VALUES ($1,$2,'customer','points',NULL,$3,$4,$3)`,
        [enterpriseId, customerId, balance, pending],
      );
    }

    it('answers with the balance, what is pending, and what they have earned', async () => {
      await wallet(250, 40);

      const run = await runner.run(ask(ToolName.RewardBalance), ctx());
      const data = JSON.stringify(run.data);

      expect(data).toContain('250');
      expect(data).toContain('40');
      expect(run.outcome).toBe(ToolOutcome.Ok);
    });

    it('says they have nothing rather than that there is no scheme', async () => {
      // Two different answers, and a model given the first will say the
      // second unless the difference is spelled out.
      const run = await runner.run(ask(ToolName.RewardBalance), ctx());

      expect(run.note).toContain('not the same as the business having no scheme');
    });

    it('never reaches another business’s wallet', async () => {
      await wallet(999);

      const run = await runner.run(
        ask(ToolName.RewardBalance),
        ctx({ enterpriseId: otherEnterpriseId }),
      );

      expect(JSON.stringify(run.data)).not.toContain('999');
    });
  });

  /*
   * SIDEWAYS, NOT DEEPER. Measured on a live record: one customer with 32
   * threads against one business — 26 mentions, 5 comment threads and the
   * single direct message the assistant was reading. It told them "I don't
   * have access to personal history" with thirty-one of them beside it.
   */
  describe('the same person, elsewhere', () => {
    async function otherThread(kind: string, body: string): Promise<number> {
      const rows: { id: string }[] = await db.query(
        `INSERT INTO conversations
           (enterprise_id, channel_id, customer_id, platform, conversation_kind,
            platform_thread_id, status, last_message_at, message_count)
         VALUES ($1,(SELECT id FROM channels WHERE enterprise_id=$1 LIMIT 1),$2,'instagram',$3,
                 'thread-' || md5(random()::text),'open', now(), 1)
         RETURNING id`,
        [enterpriseId, customerId, kind],
      );
      const id = Number(rows[0]?.id);
      await db.query(
        `INSERT INTO messages (enterprise_id, conversation_id, direction, message_kind, body, status)
         VALUES ($1,$2,'inbound','text',$3,'delivered')`,
        [enterpriseId, id, body],
      );
      return id;
    }

    it('finds the threads this one is not', async () => {
      await otherThread('comment_thread', 'is this still available?');

      const run = await runner.run(ask(ToolName.OtherChats, { count: 5 }), ctx());

      expect(JSON.stringify(run.data)).toContain('comment_thread');
      expect(JSON.stringify(run.data)).toContain('is this still available?');
    });

    it('leaves out the conversation they are standing in', async () => {
      await addMessage('something in this thread');

      const run = await runner.run(ask(ToolName.OtherChats, { count: 5 }), ctx());

      expect(JSON.stringify(run.data ?? '')).not.toContain('something in this thread');
    });

    it('carries the last thing said when a thread has no notes', async () => {
      // None of that customer's 26 mentions had ever been summarised, so a
      // list built on notes alone would have been 26 blank rows.
      await otherThread('mention', 'tagged you in my story');

      const run = await runner.run(ask(ToolName.OtherChats, { count: 5 }), ctx());

      expect(JSON.stringify(run.data)).toContain('tagged you in my story');
    });

    it('says there may be more when it hit the number asked for', async () => {
      // A model handed five of thirty-two will answer as though five was all.
      await otherThread('mention', 'one');
      await otherThread('mention', 'two');

      const run = await runner.run(ask(ToolName.OtherChats, { count: 2 }), ctx());

      expect(run.note).toContain('there may be older ones');
    });

    it('bounds a count the model asked too much of', async () => {
      await otherThread('mention', 'only one');

      const run = await runner.run(ask(ToolName.OtherChats, { count: 9999 }), ctx());

      expect(run.outcome).toBe(ToolOutcome.Ok);
    });

    it('says plainly when this is the only one', async () => {
      const run = await runner.run(ask(ToolName.OtherChats, { count: 5 }), ctx());

      expect(run.note).toContain('only conversation');
    });

    it('never reaches another business’s threads', async () => {
      await otherThread('comment_thread', 'private to acme');

      const run = await runner.run(
        ask(ToolName.OtherChats, { count: 5 }),
        ctx({ enterpriseId: otherEnterpriseId }),
      );

      expect(JSON.stringify(run.data ?? '')).not.toContain('private to acme');
    });
  });

  describe('the record it leaves', () => {
    it('keeps the reason the model gave, which is why it is a column', async () => {
      await runner.run(
        ask(ToolName.CustomerDetails, {}, 'they asked how many followers they have'),
        ctx({ round: 2, messageId: null }),
      );

      const rows = await ledger.recent(enterpriseId, conversationId, 10);
      expect(rows[0]?.because).toBe('they asked how many followers they have');
      expect(rows[0]?.round).toBe(2);
      expect(rows[0]?.effect).toBe('read');
    });

    it('never shows one business another’s tool calls', async () => {
      await runner.run(ask(ToolName.CustomerDetails), ctx());

      expect(await ledger.recent(otherEnterpriseId, conversationId, 10)).toEqual([]);
    });
  });
});
