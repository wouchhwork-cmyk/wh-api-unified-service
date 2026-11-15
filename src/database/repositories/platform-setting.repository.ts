import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';

export interface PlatformSettingRow {
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByEmployeeId: number | null;
}

/**
 * Configuration staff change without a deploy.
 *
 * NOT TENANT-SCOPED, and so it deliberately does not call `requireEnterprise`.
 * Every other repository here refuses to run without a business; this one
 * describes how the product itself behaves, and the guard that keeps it safe
 * is the platform-admin check on the controller rather than a column.
 */
@Injectable()
export class PlatformSettingRepository extends BaseRepository {
  async find(key: string): Promise<PlatformSettingRow | null> {
    const rows = await this.query<PlatformSettingRow>(
      `SELECT key, value, version, updated_at AS "updatedAt",
              updated_by_employee_id AS "updatedByEmployeeId"
         FROM platform_settings
        WHERE key = $1 AND is_deleted = false`,
      [key],
    );
    return rows[0] ?? null;
  }

  /**
   * Writes a setting and bumps its version in the same statement.
   *
   * THE VERSION IS WHAT OTHER ROWS POINT AT. A media analysis records the
   * prompt version that produced it, so the number has to move on every
   * change — computed here rather than passed in, because a caller that
   * supplies its own version is a caller that can repeat one.
   *
   * Upsert rather than update: a setting that has never been written should
   * start existing when somebody first sets it, not fail.
   */
  async put(
    key: string,
    value: Record<string, unknown>,
    updatedByEmployeeId: number | null,
  ): Promise<PlatformSettingRow> {
    const { rows } = await this.mutate<PlatformSettingRow>(
      `INSERT INTO platform_settings (key, value, version, updated_by_employee_id)
       VALUES ($1, $2::jsonb, 1, $3)
       ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              version = platform_settings.version + 1,
              updated_by_employee_id = EXCLUDED.updated_by_employee_id,
              updated_at = now()
       RETURNING key, value, version, updated_at AS "updatedAt",
                 updated_by_employee_id AS "updatedByEmployeeId"`,
      [key, JSON.stringify(value), updatedByEmployeeId],
    );
    const row = rows[0];
    if (!row) throw new Error(`platform setting ${key} was not written`);
    return row;
  }
}
