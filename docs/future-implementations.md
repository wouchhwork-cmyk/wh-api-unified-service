# Future implementations

Designs that were worked out, deliberately not shipped, and should not have to
be worked out again. Each entry says what the design was, how far the code
already goes, what stopped it, and what would have to be true to finish it.

This is not the backlog (`docs/backlog.md`), which is things that are missing
or wrong. These are things that are *correct to leave out for now*.

---

## Multiple operational countries per business

**Deferred:** 18 November 2026. **Size:** M, plus whatever currency and
timezone turn out to cost.

### The problem it solves

A phone number without a country is not a phone number. `8888888888` is a
valid mobile in several countries and a different person in each, so something
has to supply the missing country before a number can be stored. There are
only three candidates, and two of them are bad:

| Approach | Why it fails |
|---|---|
| Assume one | Wrong in the way that is hardest to catch. Produces a number that looks right, belongs to somebody else, and gets dialled. |
| Ask every time | Correct and unusable. The ordinary case is a business in one country talking to customers in that country; a form that interrogates them on every number is a form nobody fills in. |
| **Have the business state it once** | What we do. |

Today the business states **one** country (`enterprises.country`), and that one
country settles every bare number. Crucially this is a *declaration*, not a
guess — which is the whole distinction the rule rests on.

### Why one country is not enough forever

A business registered in one country and selling into three has one registered
address and three markets. Its customers' numbers are not all from the
registered country, and reading them as if they were is the exact failure the
rule exists to prevent — just with extra steps.

### The design

Add `enterprises.operational_countries jsonb NOT NULL DEFAULT '[]'`, holding
ISO 3166-1 alpha-2 codes. Separate from `country`, which stays as the
registered address.

Resolution order for a phone number becomes:

1. **The number itself**, when written with a leading `+`. Explicit, and true
   wherever the business trades.
2. **A country somebody stated** — the `country` argument on
   `record_customer_details`, or the picker on the portal form.
3. **The business's one operational country**, when it has exactly one.
4. Otherwise **ask**, offering the operational countries as the choices.

Migration is expand-only and backfills `operational_countries` from `country`
as a one-element array, so every existing business reproduces today's
behaviour exactly and nobody is asked anything on deploy.

### What is already built

**`cleanContact` already implements all of it.** See
`src/shared/utils/normalize/contact.normalize.ts`. It takes `operatesIn` as a
**list** and already distinguishes none from one from many:

- one entry settles the country silently
- zero or two or more returns `{ ok: false, problem: 'needs_country', choices }`

The `choices` field is there to be offered to whoever is entering the number.
Both callers already handle `needs_country` as a distinct outcome from
`unreadable`:

- `ToolRunnerService` tells the model to ask the customer, naming the choices
- `CatalogueService` throws `ContactNeedsCountry`, which is its own error code
  with its own message, separate from `ContactNotUsable`

So the function, the two call sites, the error codes and the model-facing
copy are all written against a list. What is deferred is only the **column**,
the **settings UI**, and the **picker**. Both services feed the list today
through a one-line private helper:

```ts
private async businessCountries(enterpriseId: number): Promise<string[]> {
  const country = await this.enterprises.countryById(enterpriseId);
  return country ? [country] : [];
}
```

Replacing that one method in each service with a read of
`operational_countries` is most of the work.

### What stopped it

**Currency and timezone are single-valued and would have to move with it.**
`enterprises.currency_code` and `enterprises.timezone` are one each, and a
business trading in three countries plausibly wants three currencies and
three timezones — or deliberately wants one of each regardless, which is a
different product decision rather than an obvious one.

Shipping multiple countries while currency and timezone stay single would
create a business that is explicitly multi-country for phone numbers and
implicitly single-country for money and time. That inconsistency is worse
than the limitation it removes, because it is invisible until somebody is
charged in the wrong currency or sent a summary cut at the wrong midnight.

### What has to be true to pick it up

Decide first, for a business trading in several countries:

1. Is there one currency, or one per country? If per-country, what does a
   total across them mean, and who converts?
2. Is there one timezone, or one per country? Every "today" boundary, reward
   cap period and daily summary reads `enterprises.timezone` — see the
   entity comment. Splitting it means deciding whose day a cross-border
   order falls in.
3. Does a customer belong to a country, or only their phone number? A
   customer record has no country today, and adding one raises whether it is
   derived from their number or stated separately.

Answer those and the phone-number half is a column, a settings control and a
picker. Start it without answering them and the inconsistency above is what
ships.
