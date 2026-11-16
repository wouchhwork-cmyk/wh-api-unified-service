/**
 * How a customer's name and picture are resolved, in one place.
 *
 * TWO SOURCES, IN ORDER. What this business holds about somebody wins; what
 * a platform says about them is the fallback. The customer row is ours —
 * anything a colleague types there outranks Instagram, permanently, and is
 * never overwritten by a profile refresh. Only when it is empty does the
 * platform's own view answer.
 *
 * WHICH ACCOUNT, WHERE IT IS KNOWN. Somebody reachable on Instagram and
 * Facebook has a name and a picture on each, and they differ — as do two
 * Instagram accounts merged into one customer. A read that already knows
 * which account it is rendering asks for that one, which is why
 * `conversations.customer_identifier_id` exists and is now selected. A read
 * with no account in hand, like the customer directory, takes the freshest.
 *
 * A LATERAL RATHER THAN A JOIN, because exactly one row is wanted per
 * customer and the ordering decides which. A plain join would multiply rows
 * by however many platforms somebody is reachable on, and every caller would
 * have to de-duplicate — which is the kind of thing that works until the day
 * a customer is reachable on two.
 *
 * NO INPUT REACHES THIS. Every argument is an alias or a column reference
 * written by a repository; nothing here is ever built from a request.
 */
export interface IdentityJoinOptions {
  /** The alias the customers table carries in the query. */
  readonly customer: string;
  /** The alias to give the resolved profile. */
  readonly as: string;
  /**
   * A column naming the ACCOUNT this read is about, when it has one —
   * `cv.customer_identifier_id` on a conversation. Omitted means "whichever
   * profile was refreshed last".
   */
  readonly preferIdentifier?: string;
}

export function platformIdentityJoin(options: IdentityJoinOptions): string {
  const { customer, as, preferIdentifier } = options;
  /*
   * THE ACCOUNT THEY ARE WRITING FROM, not merely their platform. Somebody
   * with two Instagram accounts merged into one customer has a name and a
   * picture on each, and the one to show is the one that sent the message.
   * Preferring the platform would pick between them arbitrarily.
   */
  const preference = preferIdentifier
    ? `(pp.customer_identifier_id = ${preferIdentifier}) DESC,`
    : '';

  return `LEFT JOIN LATERAL (
            SELECT pp.display_name, pp.first_name, pp.last_name, pp.avatar_url,
                   /* The platform's own read on them — follow flags,
                    * verification, reach — which belongs to the account and
                    * not to the person. */
                   pp.metadata
              FROM customer_platform_profiles pp
             WHERE pp.enterprise_id = ${customer}.enterprise_id
               AND pp.customer_id = ${customer}.id
               AND pp.is_deleted = false
             ORDER BY ${preference} pp.fetched_at DESC NULLS LAST, pp.id DESC
             LIMIT 1
          ) ${as} ON true`;
}

/** Ours if we have it, otherwise the platform's. */
export function resolvedIdentity(customer: string, profile: string) {
  return {
    displayName: `COALESCE(${customer}.display_name, ${profile}.display_name)`,
    firstName: `COALESCE(${customer}.first_name, ${profile}.first_name)`,
    lastName: `COALESCE(${customer}.last_name, ${profile}.last_name)`,
    avatarUrl: `COALESCE(${customer}.avatar_url, ${profile}.avatar_url)`,
  };
}
