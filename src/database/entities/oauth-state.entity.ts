import { Column, Entity } from 'typeorm';
import { bigintTransformer } from '../bigint.transformer';
import { BaseEntity } from './base.entity';

/**
 * One outstanding OAuth authorization attempt.
 *
 * The `state` parameter is the ONLY CSRF defence in an OAuth redirect, and a
 * signature alone does not make it safe: a signed token is replayable for as
 * long as it is valid, so an intercepted callback URL could be used again to
 * attach a second Facebook authorization to the same business — or, if the same
 * URL reaches an attacker, to bind their account under someone else's state.
 *
 * A row per attempt makes it single-use in the only way that survives
 * concurrency: consumption is one conditional UPDATE, so of two simultaneous
 * callbacks carrying the same state, exactly one wins.
 *
 * No `ref_id`: a client never addresses this. The nonce inside the signed token
 * is the only handle, and it is never a client's to choose.
 */
@Entity('oauth_states')
export class OauthState extends BaseEntity {
  /** From the signed token. Unique, so a replay finds a consumed row. */
  @Column({ type: 'varchar', length: 64 })
  nonce!: string;

  /**
   * Who started the flow. Held here as well as in the token so the callback
   * takes its identity from a row it just consumed, rather than from a string
   * that came back through the browser.
   */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  enterpriseId!: number;

  @Column({ type: 'bigint', nullable: true, transformer: bigintTransformer })
  employeeId!: number | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  /** Set by the consuming UPDATE. Its presence is what makes a replay fail. */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;
}
