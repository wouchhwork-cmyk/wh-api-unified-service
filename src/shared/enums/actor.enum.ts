/** Who is acting. `system` covers cron, workers, and webhook-driven writes. */
export enum ActorKind {
  Employee = 'employee',
  Staff = 'staff',
  System = 'system',
}

/**
 * Which population an employment row belongs to (schema.md §3).
 *
 * One table holds both, because they need the same roles, the same assignment
 * and the same audit trail — but they are emphatically not the same people, and
 * the label has to say so. `support` is one of OURS, sitting inside a customer's
 * business to help; calling that row an employee of the business would be a lie
 * in the place it matters most, which is the audit trail.
 */
export enum EmployeeKind {
  /** Works for the business. Its own staff: owner, manager, agent, viewer. */
  Business = 'business',
  /** A Wouchh person assigned to this specific business. Not their employee. */
  Support = 'support',
}
