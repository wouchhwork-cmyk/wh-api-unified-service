export interface SplitName {
  readonly firstName: string | null;
  readonly lastName: string | null;
}

/**
 * Splits a person's name on the FIRST space: everything before it is the given
 * name, everything after is the rest.
 *
 * Deliberately naive, and documented as such. Names do not decompose reliably —
 * "Maria del Carmen Fernandez" has a two-word given name, plenty of cultures put
 * the family name first, and many people have one name only. So this is a
 * convenience for sorting and greeting, never an authority: display_name keeps
 * the platform's own string untouched, and that is what gets shown.
 *
 * NOT for handles. "some_handle_99" split into a first name is nonsense, so
 * the caller decides whether the value is a name at all.
 */
export function splitPersonName(value: string | null | undefined): SplitName {
  if (!value) return { firstName: null, lastName: null };

  // Collapse any run of whitespace, including the non-breaking spaces that
  // arrive from platform profiles.
  const parts = value.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);

  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0] ?? null, lastName: null };

  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(' ') };
}
