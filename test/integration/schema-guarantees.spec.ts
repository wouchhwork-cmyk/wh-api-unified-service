import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createTestDataSource, seedEnterprise, truncateTenantData } from './db.harness';

/**
 * The guarantees the SCHEMA makes, verified against the database that enforces
 * them. These are the claims the design rests on, so they are tested directly
 * rather than through a service that might mask them.
 */
describe('schema guarantees', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = await createTestDataSource();
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await truncateTenantData(db);
  });

  describe('tenant isolation is structural, not conventional', () => {
    it('REJECTS granting one business a role that belongs to another', async () => {
      const acme = await seedEnterprise(db, 'Acme', 'acme');
      const zenith = await seedEnterprise(db, 'Zenith', 'zenith');

      const identity: { id: string }[] = await db.query(
        `INSERT INTO identities (email, password_hash, first_name)
         VALUES ('a@x.test', 'h', 'A') RETURNING id`,
      );
      const member: { id: string }[] = await db.query(
        `INSERT INTO enterprise_members (identity_id, enterprise_id) VALUES ($1, $2) RETURNING id`,
        [identity[0]?.id, acme],
      );
      // The role belongs to Zenith.
      const role: { id: string }[] = await db.query(
        `INSERT INTO roles (enterprise_id, name) VALUES ($1, 'owner') RETURNING id`,
        [zenith],
      );

      // Acme's member + Zenith's role: the composite foreign key makes this
      // combination unrepresentable, so the DATABASE refuses it.
      await expect(
        db.query(
          `INSERT INTO member_roles (enterprise_id, member_id, role_id) VALUES ($1, $2, $3)`,
          [acme, member[0]?.id, role[0]?.id],
        ),
      ).rejects.toThrow(/member_roles_role_fk|foreign key/i);
    });

    it('REJECTS a conversation pointing at another tenant’s channel', async () => {
      const acme = await seedEnterprise(db, 'Acme', 'acme');
      const zenith = await seedEnterprise(db, 'Zenith', 'zenith');

      const connection: { id: string }[] = await db.query(
        `INSERT INTO provider_connections
           (enterprise_id, provider, provider_category, provider_user_id, access_token)
         VALUES ($1, 'meta', 'social', 'u1', 'env') RETURNING id`,
        [zenith],
      );
      const channel: { id: string }[] = await db.query(
        `INSERT INTO channels
           (provider_connection_id, enterprise_id, platform, channel_kind, platform_channel_id)
         VALUES ($1, $2, 'facebook', 'page', 'p1') RETURNING id`,
        [connection[0]?.id, zenith],
      );
      const customer: { id: string }[] = await db.query(
        `INSERT INTO customers (enterprise_id, first_source) VALUES ($1, 'manual') RETURNING id`,
        [acme],
      );

      await expect(
        db.query(
          `INSERT INTO conversations
             (enterprise_id, channel_id, customer_id, platform, conversation_kind, platform_thread_id)
           VALUES ($1, $2, $3, 'facebook', 'direct_message', 'dm:1')`,
          [acme, channel[0]?.id, customer[0]?.id],
        ),
      ).rejects.toThrow(/conversations_channel_fk|foreign key/i);
    });
  });

  describe('customer identifiers are per enterprise', () => {
    it('allows the same email for two enterprises, and rejects a duplicate within one', async () => {
      const acme = await seedEnterprise(db, 'Acme', 'acme');
      const zenith = await seedEnterprise(db, 'Zenith', 'zenith');

      const makeCustomer = async (enterpriseId: number): Promise<string> => {
        const rows: { id: string }[] = await db.query(
          `INSERT INTO customers (enterprise_id, first_source) VALUES ($1, 'manual') RETURNING id`,
          [enterpriseId],
        );
        return rows[0]!.id;
      };
      const addEmail = (enterpriseId: number, customerId: string) =>
        db.query(
          `INSERT INTO customer_identifiers
             (enterprise_id, customer_id, identifier_kind, identifier_value, source)
           VALUES ($1, $2, 'email', 'priya@example.test', 'self_declared')`,
          [enterpriseId, customerId],
        );

      const acmeCustomer = await makeCustomer(acme);
      const zenithCustomer = await makeCustomer(zenith);

      // The same human, known to both businesses: two ordinary rows.
      await addEmail(acme, acmeCustomer);
      await addEmail(zenith, zenithCustomer);

      // The same value twice inside ONE business: rejected.
      await expect(addEmail(acme, acmeCustomer)).rejects.toThrow(
        /customer_identifiers_value_uniq|duplicate key/i,
      );
    });

    it('allows a RELEASED identifier to be claimed by a different customer', async () => {
      const acme = await seedEnterprise(db, 'Acme', 'acme');
      const newCustomer = async (): Promise<string> => {
        const rows: { id: string }[] = await db.query(
          `INSERT INTO customers (enterprise_id, first_source) VALUES ($1,'manual') RETURNING id`,
          [acme],
        );
        return rows[0]!.id;
      };
      const vikram = await newCustomer();
      const sneha = await newCustomer();

      await db.query(
        `INSERT INTO customer_identifiers
           (enterprise_id, customer_id, identifier_kind, identifier_value, source, is_primary)
         VALUES ($1, $2, 'mobile', '+919900112233', 'self_declared', true)`,
        [acme, vikram],
      );

      // A carrier reassigned the number. Releasing frees the value while the
      // history stays intact — which is why the unique index is partial.
      await db.query(
        `UPDATE customer_identifiers SET status = 'released', released_at = now()
          WHERE enterprise_id = $1 AND identifier_value = '+919900112233'`,
        [acme],
      );

      await expect(
        db.query(
          `INSERT INTO customer_identifiers
             (enterprise_id, customer_id, identifier_kind, identifier_value, source, is_primary)
           VALUES ($1, $2, 'mobile', '+919900112233', 'agent_entered', true)`,
          [acme, sneha],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('identity invariants', () => {
    it('REJECTS an identity with neither an email nor a mobile', async () => {
      await expect(
        db.query(`INSERT INTO identities (password_hash, first_name) VALUES ('h', 'Ghost')`),
      ).rejects.toThrow(/identities_has_credential_chk|check constraint/i);
    });

    it('treats emails case-insensitively for uniqueness', async () => {
      await db.query(
        `INSERT INTO identities (email, password_hash, first_name) VALUES ('bob@x.test','h','Bob')`,
      );
      await expect(
        db.query(
          `INSERT INTO identities (email, password_hash, first_name) VALUES ('BOB@x.test','h','Bob2')`,
        ),
      ).rejects.toThrow(/identities_email_uniq|duplicate key/i);
    });
  });

  describe('ledger idempotency', () => {
    it('collides a redelivered event, including when enterprise_id is NULL', async () => {
      const insert = (enterpriseId: number | null, key: string) =>
        db.query(
          `INSERT INTO inbound_events (enterprise_id, source_kind, platform, event_type, dedup_key)
           VALUES ($1, 'system', 'internal', 'post_update', $2)`,
          [enterpriseId, key],
        );

      await insert(null, 'sys:x:1');
      // COALESCE(enterprise_id, 0) in the index is what makes NULLs collide; a
      // plain composite index would treat every system event as distinct.
      await expect(insert(null, 'sys:x:1')).rejects.toThrow(
        /inbound_events_dedup_uniq|duplicate key/i,
      );
    });
  });

  describe('audit trail', () => {
    it('keeps updated_at equal to created_at, so a later write is detectable', async () => {
      const enterprise = await seedEnterprise(db, 'Acme', 'acme');
      await db.query(
        `INSERT INTO audit_logs (enterprise_id, actor_kind, action, entity_type)
         VALUES ($1, 'system', 'created', 'enterprise')`,
        [enterprise],
      );
      const rows: { untouched: boolean }[] = await db.query(
        `SELECT (updated_at = created_at) AS untouched FROM audit_logs LIMIT 1`,
      );
      // The tripwire: on every legitimate row these are equal forever, so
      // WHERE updated_at <> created_at cheaply finds anything that bypassed the
      // service layer.
      expect(rows[0]?.untouched).toBe(true);
    });
  });

  describe('the updated_at trigger', () => {
    it('advances updated_at on a normal update', async () => {
      const enterprise = await seedEnterprise(db, 'Acme', 'acme');
      await db.query(`UPDATE enterprises SET city = 'Pune' WHERE id = $1`, [enterprise]);
      const rows: { advanced: boolean }[] = await db.query(
        `SELECT (updated_at > created_at) AS advanced FROM enterprises WHERE id = $1`,
        [enterprise],
      );
      expect(rows[0]?.advanced).toBe(true);
    });
  });
});
