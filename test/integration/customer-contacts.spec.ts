import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { EnterpriseRepository } from '@/database/repositories/enterprise.repository';
import { PostRepository } from '@/database/repositories/post.repository';
import { ChannelRepository } from '@/database/repositories/channel.repository';
import { SyncJobRepository } from '@/database/repositories/sync-job.repository';
import { CatalogueService } from '@/modules/catalogue/catalogue.service';
import type { AuditService } from '@/modules/audit/audit.service';
import { IdentifierKind } from '@/shared/enums';
import { ErrorCode } from '@/shared/errors';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

function silentLogger(): never {
  return {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as never;
}

/**
 * A colleague putting a contact detail on a customer by hand.
 *
 * THE INVARIANT WORTH MOST HERE IS PARITY. The same number can arrive three
 * ways — typed on this form, recorded by the assistant from a chat, or read
 * off a platform — and all three must produce the SAME row. If they do not,
 * `identifier_value` is not a canonical column, it is a free-text one, and
 * the person is quietly two records.
 */
describe('a colleague editing a customer’s contact details', () => {
  let db: DataSource;
  let service: CatalogueService;
  let customers: CustomerRepository;

  let enterpriseId: number;
  let customerRefId: string;
  let customerId: number;
  let otherCustomerId: number;

  const recorded: unknown[] = [];

  beforeAll(async () => {
    db = await createTestDataSource();
    customers = new CustomerRepository(db);
    service = new CatalogueService(
      new PostRepository(db),
      customers,
      {
        record: (entry: unknown) => {
          recorded.push(entry);
          return Promise.resolve();
        },
      } as unknown as AuditService,
      new ChannelRepository(db),
      new SyncJobRepository(db),
      new EnterpriseRepository(db),
      silentLogger(),
    );
  });
  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await truncateTenantData(db);
    recorded.length = 0;
    enterpriseId = await seedEnterprise(db, 'Acme', 'acme');

    const rows: { id: string; ref_id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1,'Aditya','direct_message') RETURNING id, ref_id`,
      [enterpriseId],
    );
    customerId = Number(rows[0]?.id);
    customerRefId = String(rows[0]?.ref_id);

    const others: { id: string }[] = await db.query(
      `INSERT INTO customers (enterprise_id, display_name, first_source)
       VALUES ($1,'Someone Else','direct_message') RETURNING id`,
      [enterpriseId],
    );
    otherCustomerId = Number(others[0]?.id);
  });

  const stored = async (): Promise<
    { identifier_value: string; identifier_value_raw: string; status: string }[]
  > =>
    db.query(
      `SELECT identifier_value, identifier_value_raw, status
         FROM customer_identifiers
        WHERE enterprise_id = $1 AND customer_id = $2
        ORDER BY id`,
      [enterpriseId, customerId],
    );

  describe('adding one', () => {
    it('stores a typed number in the same shape the assistant would', async () => {
      const result = await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888 8888 88',
      });

      expect(result.value).toBe('+918888888888');
      expect((await stored())[0]?.identifier_value).toBe('+918888888888');
    });

    it('keeps what the colleague typed beside it', async () => {
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888 8888 88',
      });

      expect((await stored())[0]?.identifier_value_raw).toBe('8888 8888 88');
    });

    it('lower-cases an email', async () => {
      const result = await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Email,
        value: 'Aditya.Patil@Example.COM',
      });

      expect(result.value).toBe('aditya.patil@example.com');
    });

    it('takes a stated country over the business’s own', async () => {
      const result = await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '07400 123456',
        country: 'GB',
      });

      expect(result.value).toBe('+447400123456');
    });

    it('refuses something that is not a usable number rather than storing it', async () => {
      await expect(
        service.setCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Mobile,
          value: '12345',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.ContactNotUsable });

      expect(await stored()).toEqual([]);
    });

    it('refuses an address that is not one', async () => {
      await expect(
        service.setCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Email,
          value: 'aditya at example dot com',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.ContactNotUsable });
    });

    it('says so when another customer already holds it', async () => {
      /*
       * The insert is ON CONFLICT DO NOTHING, which is right for a reply
       * race and wrong for a form: without this check the colleague is told
       * it worked and finds nothing there — while two records quietly claim
       * one person.
       */
      await customers.linkIdentifier({
        enterpriseId,
        customerId: otherCustomerId,
        identifierKind: IdentifierKind.Mobile,
        identifierValue: '+918888888888',
      });

      await expect(
        service.setCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Mobile,
          value: '8888888888',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.ContactTaken });
    });

    it('does not mistake the customer’s own number for somebody else’s', async () => {
      // Re-saving a value they already have is a no-op, not a conflict.
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      });

      await expect(
        service.setCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Mobile,
          value: '+91 88888 88888',
        }),
      ).resolves.toMatchObject({ value: '+918888888888' });
    });

    it('records the value in the audit trail, because that is the question asked later', async () => {
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      });

      expect(recorded[0]).toMatchObject({
        metadata: { kind: 'mobile', value: '+918888888888', country: 'IN' },
      });
    });
  });

  describe('correcting one', () => {
    it('leaves only the new value on the record', async () => {
      // A typo being corrected must not leave both numbers behind.
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      });

      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '9876543210',
        replaces: '+918888888888',
      });

      const active = (await stored()).filter((row) => row.status === 'active');
      expect(active.map((row) => row.identifier_value)).toEqual(['+919876543210']);
    });

    it('keeps the old one as released rather than deleting it', async () => {
      // "She was reachable there until Tuesday" is a question somebody asks.
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      });
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '9876543210',
        replaces: '+918888888888',
      });

      const old = (await stored()).find((row) => row.identifier_value === '+918888888888');
      expect(old?.status).toBe('released');
    });

    it('refuses to replace something that is not on the record', async () => {
      await expect(
        service.setCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Mobile,
          value: '9876543210',
          replaces: '+910000000000',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.ContactNotFound });
    });
  });

  describe('removing one', () => {
    it('releases it and frees the value', async () => {
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      });

      await service.removeCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '+918888888888',
      });

      expect((await stored())[0]?.status).toBe('released');
      expect(
        await customers.identifierOwner(enterpriseId, IdentifierKind.Mobile, '+918888888888'),
      ).toBeNull();
    });

    it('matches a value typed the way a person writes it', async () => {
      // A form sends back what is on screen, not what is in the column.
      await service.setCustomerContact(enterpriseId, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      });

      await expect(
        service.removeCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Mobile,
          value: '8888 8888 88',
        }),
      ).resolves.toMatchObject({ value: '+918888888888' });
    });

    it('says so when it was never there', async () => {
      await expect(
        service.removeCustomerContact(enterpriseId, customerRefId, {
          kind: IdentifierKind.Email,
          value: 'nobody@example.com',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.ContactNotFound });
    });
  });

  it('never reaches a customer of another business', async () => {
    const rival = await seedEnterprise(db, 'Rival', 'rival');

    await expect(
      service.setCustomerContact(rival, customerRefId, {
        kind: IdentifierKind.Mobile,
        value: '8888888888',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CustomerNotFound });
  });
});
