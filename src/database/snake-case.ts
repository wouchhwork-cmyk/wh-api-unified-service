/**
 * camelCase → snake_case, the exact inverse of the mapping schema.md declares.
 *
 * Only legal names round-trip, which is why the schema forbids run-together
 * words and acronym runs: `refid` would map to `refid`, not `ref_id`.
 */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1_$2')
    .toLowerCase();
}
