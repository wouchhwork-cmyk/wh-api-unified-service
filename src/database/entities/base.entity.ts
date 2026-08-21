import {
  Column,
  CreateDateColumn,
  Generated,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * What schema.md says EVERY table has: id, created_at, updated_at, is_deleted.
 *
 * `updated_at` is trigger-maintained in the database (migration 1 installs the
 * trigger). The @UpdateDateColumn here keeps the in-memory entity fresh after a
 * save; the database remains the authority, so a write that bypasses the ORM
 * still stamps it.
 */
export abstract class BaseEntity {
  // No transformer here: PrimaryGeneratedColumn's numeric options do not accept
  // one. The global int8 parser in pg-types.ts converts every BIGINT instead.
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  /** Soft delete, and ONLY soft delete. No status enum anywhere contains 'deleted'. */
  @Column({ type: 'boolean', default: false })
  isDeleted!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * Tables a client can address also carry `ref_id` — a UUID exposed as `refId`.
 * THE NUMERIC `id` IS NEVER SENT TO A CLIENT. The ledger tables deliberately
 * have no ref_id: they are internal, and a UUID plus its unique index on the
 * highest-volume tables is pure write cost.
 */
export abstract class PublicEntity extends BaseEntity {
  @Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
  @Generated('uuid')
  refId!: string;
}
