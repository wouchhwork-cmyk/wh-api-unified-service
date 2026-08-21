import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';
import { snakeCase } from './snake-case';

/**
 * Implements schema.md's database↔code contract: the database is snake_case,
 * application code is camelCase, and the mapping is PURELY MECHANICAL.
 *
 * Doing it here, once, is what makes per-column `name:` overrides unnecessary —
 * and a hand-written alias is a review rejection, because it breaks the
 * guarantee that every column name round-trips losslessly.
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override tableName(className: string, customName?: string): string {
    return customName ?? snakeCase(className);
  }

  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    const prefix = embeddedPrefixes.length ? `${embeddedPrefixes.map(snakeCase).join('_')}_` : '';
    return prefix + (customName ?? snakeCase(propertyName));
  }

  override relationName(propertyName: string): string {
    return snakeCase(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snakeCase(`${relationName}_${referencedColumnName}`);
  }

  override joinTableName(firstTableName: string, secondTableName: string): string {
    return snakeCase(`${firstTableName}_${secondTableName}`);
  }

  override joinTableColumnName(
    tableName: string,
    propertyName: string,
    columnName?: string,
  ): string {
    return snakeCase(`${tableName}_${columnName ?? propertyName}`);
  }
}
