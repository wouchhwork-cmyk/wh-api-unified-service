/** Who is acting. `system` covers cron, workers, and webhook-driven writes. */
export enum ActorKind {
  EnterpriseMember = 'enterprise_member',
  Staff = 'staff',
  System = 'system',
}

/** schema.md §3 — which population a membership row belongs to. */
export enum MemberKind {
  /** Works for the business. */
  Enterprise = 'enterprise',
  /** A Wouchh person assigned to this specific business. */
  Staff = 'staff',
}
