/**
 * The global catalogue seed — features (schema.md §9), permissions (§6), the six
 * system roles (§5, §8) and their grants (§7). It creates NO tenant data: no
 * enterprises, no identities, no memberships.
 *
 * IDEMPOTENT. Every insert names the real unique index as its ON CONFLICT
 * target, so a second run inserts nothing. Conflicts DO NOTHING rather than
 * DO UPDATE on purpose: schema.md §8 says template edits apply to future
 * enterprises only, and an existing row may have been amended deliberately.
 * Three of the four targets are PARTIAL indexes, which is why each inference
 * clause has to repeat the index predicate — Postgres cannot infer a partial
 * index from the column list alone.
 *
 *   node --env-file=.env.dev --import tsx scripts/seed.ts
 */
import type { EntityManager } from 'typeorm';
import AppDataSource from '../src/database/data-source';
import {
  FeatureKey,
  FeatureStatus,
  Permission,
  PermissionAction,
  PermissionResource,
  PermissionScope,
  PermissionStatus,
  RoleScope,
  RoleStatus,
  SystemRole,
} from '@/shared/enums';

// ===========================================================================
// 1. Features — schema.md §9
// ===========================================================================

interface FeatureSeed {
  readonly key: FeatureKey;
  readonly name: string;
  readonly description: string;
}

const FEATURES: readonly FeatureSeed[] = [
  {
    key: FeatureKey.UnifiedInbox,
    name: 'Unified Inbox',
    description: 'Direct messages from every connected channel, in one queue.',
  },
  {
    key: FeatureKey.CommentManagement,
    name: 'Comment Management',
    description: 'Comments on published posts, and replying to or hiding them.',
  },
  {
    key: FeatureKey.PostInsights,
    name: 'Post Insights',
    description: 'Published posts and their engagement metrics.',
  },
  {
    key: FeatureKey.CustomerDirectory,
    name: 'Customer Directory',
    description: 'The people who interacted, and their identifiers across platforms.',
  },
];

// ===========================================================================
// 2. Permissions — schema.md §6
// ===========================================================================

/**
 * Which feature gates each resource. `null` means the action is not
 * feature-gated: it is part of running the account, so it must keep working
 * whether or not any feature is active (the LEFT JOIN in §8 relies on this).
 *
 * The Record is exhaustive over PermissionResource, so adding a resource
 * without deciding its gate is a compile error.
 */
const FEATURE_BY_RESOURCE: Readonly<Record<PermissionResource, FeatureKey | null>> = {
  [PermissionResource.Conversations]: FeatureKey.UnifiedInbox,
  [PermissionResource.Comments]: FeatureKey.CommentManagement,
  [PermissionResource.Posts]: FeatureKey.PostInsights,
  [PermissionResource.Customers]: FeatureKey.CustomerDirectory,
  [PermissionResource.Channels]: null,
  [PermissionResource.Members]: null,
  [PermissionResource.Roles]: null,
  [PermissionResource.Features]: null,
  [PermissionResource.Enterprise]: null,
};

/**
 * Which population may hold each permission (§6). `both` is not a convenience
 * default — it is required for every code a staff role holds, because a staff
 * role granted an `enterprise`-scoped permission is exactly the mismatch §5's
 * `scope` exists to prevent. ROLES below is checked against this map before
 * anything is written.
 *
 * `features.decide` is the one genuinely staff-only action: an enterprise
 * approving its own feature request would make gate 1 self-serve.
 */
const PERMISSION_SCOPES: Readonly<Record<Permission, PermissionScope>> = {
  [Permission.ConversationsView]: PermissionScope.Both,
  [Permission.ConversationsReply]: PermissionScope.Both,
  [Permission.ConversationsAssign]: PermissionScope.Enterprise,
  [Permission.ConversationsManage]: PermissionScope.Both,

  [Permission.CommentsView]: PermissionScope.Both,
  [Permission.CommentsReply]: PermissionScope.Enterprise,
  [Permission.CommentsHide]: PermissionScope.Enterprise,
  [Permission.CommentsDelete]: PermissionScope.Enterprise,

  [Permission.PostsView]: PermissionScope.Both,

  [Permission.ChannelsView]: PermissionScope.Both,
  [Permission.ChannelsConnect]: PermissionScope.Both,
  [Permission.ChannelsManage]: PermissionScope.Both,

  [Permission.CustomersView]: PermissionScope.Both,
  [Permission.CustomersManage]: PermissionScope.Enterprise,

  [Permission.MembersView]: PermissionScope.Both,
  [Permission.MembersInvite]: PermissionScope.Enterprise,
  [Permission.MembersManage]: PermissionScope.Enterprise,

  [Permission.RolesView]: PermissionScope.Both,
  [Permission.RolesManage]: PermissionScope.Enterprise,

  [Permission.FeaturesView]: PermissionScope.Both,
  [Permission.FeaturesRequest]: PermissionScope.Enterprise,
  [Permission.FeaturesDecide]: PermissionScope.Staff,

  [Permission.EnterpriseView]: PermissionScope.Both,
  [Permission.EnterpriseManage]: PermissionScope.Enterprise,
};

/** Shown in the role editor UI (§6), so it describes the action, not the code. */
const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  [Permission.ConversationsView]: 'See direct-message conversations and their messages.',
  [Permission.ConversationsReply]: 'Send a reply in a direct-message conversation.',
  [Permission.ConversationsAssign]: 'Assign a conversation to a team member.',
  [Permission.ConversationsManage]: 'Administer inbox sync: re-run conversation backfills, change inbox settings.',

  [Permission.CommentsView]: 'See comments on published posts.',
  [Permission.CommentsReply]: 'Reply to a comment.',
  [Permission.CommentsHide]: 'Hide a comment on the platform.',
  [Permission.CommentsDelete]: 'Delete a comment on the platform.',

  [Permission.PostsView]: 'See published posts and their metrics.',

  [Permission.ChannelsView]: 'See connected channels and their sync state.',
  [Permission.ChannelsConnect]: 'Start a provider connection and connect a channel.',
  [Permission.ChannelsManage]: 'Reconnect, disconnect, and administer sync for a channel.',

  [Permission.CustomersView]: 'See customer records and their platform identifiers.',
  [Permission.CustomersManage]: 'Edit, merge, and archive customer records.',

  [Permission.MembersView]: 'See the people who belong to this enterprise.',
  [Permission.MembersInvite]: 'Invite a person to this enterprise.',
  [Permission.MembersManage]: "Change a member's roles, or suspend them.",

  [Permission.RolesView]: 'See roles and the permissions they grant.',
  [Permission.RolesManage]: 'Create, edit, and archive roles.',

  [Permission.FeaturesView]: 'See which features this enterprise has.',
  [Permission.FeaturesRequest]: 'Request access to a feature.',
  [Permission.FeaturesDecide]: "Approve or decline an enterprise's feature request.",

  [Permission.EnterpriseView]: 'See the enterprise profile and settings.',
  [Permission.EnterpriseManage]: 'Change enterprise settings and billing.',
};

interface PermissionSeed {
  readonly code: Permission;
  readonly resource: PermissionResource;
  /**
   * Not typed as PermissionAction: `features.decide` splits to "decide", which
   * the enum does not declare. The column is VARCHAR(50) free text and the code
   * is authoritative, so the row is right either way — see UNDECLARED_ACTIONS.
   */
  readonly action: string;
  readonly featureKey: FeatureKey | null;
  readonly scope: PermissionScope;
  readonly description: string;
}

function isResource(value: string): value is PermissionResource {
  return (Object.values(PermissionResource) as readonly string[]).includes(value);
}

function isAction(value: string): value is PermissionAction {
  return (Object.values(PermissionAction) as readonly string[]).includes(value);
}

/**
 * `code` is redundant with resource + action by construction (§6), so the two
 * parts are split back out of it rather than restated — restating them is how
 * they drift.
 *
 * The resource half is checked against PermissionResource and a mismatch is
 * FATAL: resource is what FEATURE_BY_RESOURCE keys on, so an unrecognised one
 * would silently produce an ungated permission. The action half is only
 * reported, because PermissionAction is genuinely incomplete today.
 */
function toPermissionSeed(code: Permission): PermissionSeed {
  const parts = code.split('.');
  const resource = parts[0];
  const action = parts[1];

  if (parts.length !== 2 || resource === undefined || action === undefined) {
    throw new Error(`permission "${code}" is not <resource>.<action>`);
  }
  if (!isResource(resource)) {
    throw new Error(`permission "${code}" names resource "${resource}", absent from PermissionResource`);
  }

  return {
    code,
    resource,
    action,
    featureKey: FEATURE_BY_RESOURCE[resource],
    scope: PERMISSION_SCOPES[code],
    description: PERMISSION_DESCRIPTIONS[code],
  };
}

const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);
const PERMISSION_CATALOGUE: readonly PermissionSeed[] = ALL_PERMISSIONS.map(toPermissionSeed);

/**
 * Action halves used by a Permission code that PermissionAction does not
 * declare. Computed rather than listed, so it stays empty once the enum catches
 * up and no domain string literal has to be written here. Today it holds
 * "decide" (from `features.decide`).
 */
const UNDECLARED_ACTIONS: readonly string[] = [
  ...new Set(PERMISSION_CATALOGUE.map((seed) => seed.action).filter((action) => !isAction(action))),
];

const ACTION_OF: ReadonlyMap<Permission, string> = new Map(
  PERMISSION_CATALOGUE.map((seed) => [seed.code, seed.action]),
);

function actionOf(code: Permission): string {
  const action = ACTION_OF.get(code);
  if (action === undefined) throw new Error(`permission "${code}" is not in the catalogue`);
  return action;
}

// ===========================================================================
// 3. Roles — schema.md §5, §8
// ===========================================================================

/** Holdable by an enterprise role: everything except the staff-only codes. */
const ENTERPRISE_PERMISSIONS = ALL_PERMISSIONS.filter(
  (code) => PERMISSION_SCOPES[code] !== PermissionScope.Staff,
);

/** Holdable by a staff role. */
const STAFF_PERMISSIONS = ALL_PERMISSIONS.filter(
  (code) => PERMISSION_SCOPES[code] !== PermissionScope.Enterprise,
);

/**
 * The agent's ceiling, as actions rather than a hand-listed set: an agent works
 * the queue and never reconfigures the account. Every action that changes
 * configuration or destroys platform data — manage, connect, invite, request,
 * delete — is excluded by being absent here, which keeps viewer ⊂ agent ⊂
 * manager ⊂ owner true by construction.
 */
const AGENT_ACTIONS: readonly string[] = [
  PermissionAction.View,
  PermissionAction.Reply,
  PermissionAction.Assign,
  PermissionAction.Hide,
];

interface RoleSeed {
  readonly name: SystemRole;
  readonly scope: RoleScope;
  readonly description: string;
  readonly permissions: readonly Permission[];
}

const ROLES: readonly RoleSeed[] = [
  {
    name: SystemRole.Owner,
    scope: RoleScope.Enterprise,
    description: 'Full control of the enterprise, including settings and billing.',
    permissions: ENTERPRISE_PERMISSIONS,
  },
  {
    name: SystemRole.Manager,
    scope: RoleScope.Enterprise,
    description: 'Every feature action plus member and role management; no billing.',
    // enterprise.manage is the billing and settings surface §8 withholds from
    // manager; there is no separate billing.* code to exclude.
    permissions: ENTERPRISE_PERMISSIONS.filter((code) => code !== Permission.EnterpriseManage),
  },
  {
    name: SystemRole.Agent,
    scope: RoleScope.Enterprise,
    description: 'Works the inbox and comments; cannot change configuration.',
    permissions: ENTERPRISE_PERMISSIONS.filter((code) => AGENT_ACTIONS.includes(actionOf(code))),
  },
  {
    name: SystemRole.Viewer,
    scope: RoleScope.Enterprise,
    description: 'Read-only across every granted feature.',
    permissions: ENTERPRISE_PERMISSIONS.filter((code) => actionOf(code) === PermissionAction.View),
  },
  {
    name: SystemRole.Support,
    scope: RoleScope.Staff,
    description: 'Read-only across assigned enterprises, plus replying where a conversation is escalated.',
    permissions: [
      ...STAFF_PERMISSIONS.filter((code) => actionOf(code) === PermissionAction.View),
      Permission.ConversationsReply,
    ],
  },
  {
    name: SystemRole.Ops,
    scope: RoleScope.Staff,
    description: 'Connection and sync administration across assigned enterprises.',
    // Listed explicitly because there is no sync.* code: sync_jobs hang off a
    // channel (§15), so channel administration IS connection-side sync
    // administration, and conversations.manage is its inbox-side half.
    permissions: [
      Permission.ChannelsView,
      Permission.ChannelsConnect,
      Permission.ChannelsManage,
      Permission.ConversationsManage,
    ],
  },
];

/**
 * The grant set and the scope map are two statements of the same rule, so they
 * are reconciled before the transaction opens. A staff role holding an
 * `enterprise`-scoped code (or the reverse) is a seed bug that would otherwise
 * only surface as a confusing denial at assignment time.
 */
function assertScopesAgree(): void {
  const problems: string[] = [];

  for (const role of ROLES) {
    const allowed = role.scope === RoleScope.Staff ? STAFF_PERMISSIONS : ENTERPRISE_PERMISSIONS;
    for (const code of role.permissions) {
      if (!allowed.includes(code)) {
        problems.push(
          `role "${role.name}" (scope ${role.scope}) is granted "${code}", whose scope is ` +
            `"${PERMISSION_SCOPES[code]}"`,
        );
      }
    }
    const duplicates = role.permissions.length - new Set(role.permissions).size;
    if (duplicates > 0) problems.push(`role "${role.name}" lists ${duplicates} duplicate permission(s)`);
  }

  if (problems.length > 0) {
    throw new Error(`seed definition is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

// ===========================================================================
// Persistence
// ===========================================================================

async function run<T>(manager: EntityManager, sql: string, parameters: readonly unknown[]): Promise<T[]> {
  return (await manager.query(sql, parameters as unknown[])) as T[];
}

/**
 * Resolves the surrogate ids the child inserts need. Reading them back rather
 * than trusting RETURNING is what makes the script idempotent: on a second run
 * every insert returns nothing, and the rows already there are the ones to
 * reference.
 */
async function idsByKey(
  manager: EntityManager,
  sql: string,
  parameters: readonly unknown[],
  expected: readonly string[],
  label: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await run<{ id: number; k: string }>(manager, sql, parameters);
  const byKey = new Map(rows.map((row) => [row.k, row.id]));

  const missing = expected.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    throw new Error(`${label} not found after insert: ${missing.join(', ')}`);
  }
  return byKey;
}

interface Summary {
  readonly table: string;
  readonly inserted: number;
  readonly existing: number;
}

async function seedFeatures(manager: EntityManager): Promise<[Summary, ReadonlyMap<string, number>]> {
  const inserted = await run<{ key: string }>(
    manager,
    `INSERT INTO features ("key", name, description, status)
     SELECT s."key", s.name, s.description, $4
       FROM unnest($1::varchar[], $2::varchar[], $3::text[]) AS s("key", name, description)
     ON CONFLICT ("key") WHERE is_deleted = false
     DO NOTHING
     RETURNING "key"`,
    [
      FEATURES.map((feature) => feature.key),
      FEATURES.map((feature) => feature.name),
      FEATURES.map((feature) => feature.description),
      FeatureStatus.Active,
    ],
  );

  const keys = FEATURES.map((feature) => feature.key);
  const byKey = await idsByKey(
    manager,
    `SELECT id, "key" AS k FROM features WHERE "key" = ANY($1::varchar[]) AND is_deleted = false`,
    [keys],
    keys,
    'features',
  );

  return [
    { table: 'features', inserted: inserted.length, existing: FEATURES.length - inserted.length },
    byKey,
  ];
}

async function seedPermissions(
  manager: EntityManager,
  featureIds: ReadonlyMap<string, number>,
): Promise<[Summary, ReadonlyMap<string, number>]> {
  const featureIdFor = (key: FeatureKey | null): number | null => {
    if (key === null) return null;
    const id = featureIds.get(key);
    if (id === undefined) throw new Error(`feature "${key}" gates a permission but was not seeded`);
    return id;
  };

  const inserted = await run<{ code: string }>(
    manager,
    `INSERT INTO permissions (code, resource, action, feature_id, scope, description, status)
     SELECT s.code, s.resource, s.action, s.feature_id, s.scope, s.description, $7
       FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::bigint[], $5::varchar[], $6::varchar[])
            AS s(code, resource, action, feature_id, scope, description)
     ON CONFLICT (code) WHERE is_deleted = false
     DO NOTHING
     RETURNING code`,
    [
      PERMISSION_CATALOGUE.map((seed) => seed.code),
      PERMISSION_CATALOGUE.map((seed) => seed.resource),
      PERMISSION_CATALOGUE.map((seed) => seed.action),
      PERMISSION_CATALOGUE.map((seed) => featureIdFor(seed.featureKey)),
      PERMISSION_CATALOGUE.map((seed) => seed.scope),
      PERMISSION_CATALOGUE.map((seed) => seed.description),
      PermissionStatus.Active,
    ],
  );

  const codes = PERMISSION_CATALOGUE.map((seed) => seed.code);
  const byCode = await idsByKey(
    manager,
    `SELECT id, code AS k FROM permissions WHERE code = ANY($1::varchar[]) AND is_deleted = false`,
    [codes],
    codes,
    'permissions',
  );

  return [
    {
      table: 'permissions',
      inserted: inserted.length,
      existing: PERMISSION_CATALOGUE.length - inserted.length,
    },
    byCode,
  ];
}

async function seedRoles(manager: EntityManager): Promise<[Summary, ReadonlyMap<string, number>]> {
  // enterprise_id stays NULL for all six. The four enterprise-scoped rows are
  // TEMPLATES: member_roles' composite FK routes through enterprise_id, so a
  // NULL-enterprise role cannot be assigned to anyone (§8), and enterprise
  // creation copies them into the new tenant instead.
  const inserted = await run<{ name: string }>(
    manager,
    `INSERT INTO roles (enterprise_id, scope, name, description, is_system, status)
     SELECT NULL, s.scope, s.name, s.description, true, $4
       FROM unnest($1::varchar[], $2::varchar[], $3::varchar[]) AS s(scope, name, description)
     ON CONFLICT (name) WHERE is_deleted = false AND enterprise_id IS NULL
     DO NOTHING
     RETURNING name`,
    [
      ROLES.map((role) => role.scope),
      ROLES.map((role) => role.name),
      ROLES.map((role) => role.description),
      RoleStatus.Active,
    ],
  );

  const names = ROLES.map((role) => role.name);
  const byName = await idsByKey(
    manager,
    `SELECT id, name AS k FROM roles
       WHERE name = ANY($1::varchar[]) AND enterprise_id IS NULL AND is_deleted = false`,
    [names],
    names,
    'roles',
  );

  return [{ table: 'roles', inserted: inserted.length, existing: ROLES.length - inserted.length }, byName];
}

interface GrantReport {
  readonly summary: Summary;
  readonly insertedByRole: ReadonlyMap<string, number>;
}

async function seedRolePermissions(
  manager: EntityManager,
  roleIds: ReadonlyMap<string, number>,
  permissionIds: ReadonlyMap<string, number>,
): Promise<GrantReport> {
  const roleIdColumn: number[] = [];
  const permissionIdColumn: number[] = [];
  const roleNameById = new Map<number, string>();

  for (const role of ROLES) {
    const roleId = roleIds.get(role.name);
    if (roleId === undefined) throw new Error(`role "${role.name}" was not seeded`);
    roleNameById.set(roleId, role.name);

    for (const code of role.permissions) {
      const permissionId = permissionIds.get(code);
      if (permissionId === undefined) throw new Error(`permission "${code}" was not seeded`);
      roleIdColumn.push(roleId);
      permissionIdColumn.push(permissionId);
    }
  }

  const inserted = await run<{ role_id: number }>(
    manager,
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT s.role_id, s.permission_id
       FROM unnest($1::bigint[], $2::bigint[]) AS s(role_id, permission_id)
     ON CONFLICT (role_id, permission_id) WHERE is_deleted = false
     DO NOTHING
     RETURNING role_id`,
    [roleIdColumn, permissionIdColumn],
  );

  const insertedByRole = new Map<string, number>();
  for (const row of inserted) {
    const name = roleNameById.get(row.role_id) ?? String(row.role_id);
    insertedByRole.set(name, (insertedByRole.get(name) ?? 0) + 1);
  }

  return {
    summary: {
      table: 'role_permissions',
      inserted: inserted.length,
      existing: roleIdColumn.length - inserted.length,
    },
    insertedByRole,
  };
}

// ===========================================================================
// Entry point
// ===========================================================================

function report(summaries: readonly Summary[], insertedByRole: ReadonlyMap<string, number>): void {
  const width = Math.max(...summaries.map((summary) => summary.table.length));

  console.log('seed — global catalogue (no tenant data)\n');
  for (const summary of summaries) {
    console.log(
      `  ${summary.table.padEnd(width)}  ${String(summary.inserted).padStart(3)} inserted, ` +
        `${String(summary.existing).padStart(3)} already present`,
    );
  }

  console.log('\n  grants per system role');
  for (const role of ROLES) {
    const added = insertedByRole.get(role.name) ?? 0;
    console.log(
      `    ${role.name.padEnd(8)} ${role.scope.padEnd(10)} ` +
        `${String(role.permissions.length).padStart(2)} permissions (${added} new)`,
    );
  }
}

async function main(): Promise<void> {
  assertScopesAgree();

  if (UNDECLARED_ACTIONS.length > 0) {
    console.warn(
      `warning: ${UNDECLARED_ACTIONS.join(', ')} — used as the action half of a Permission code but ` +
        'absent from PermissionAction. The rows are still correct; the enum needs the member.',
    );
  }

  await AppDataSource.initialize();
  try {
    // One transaction: a half-seeded catalogue is worse than none, because the
    // permissions rows that did land would look complete to the access check.
    const { summaries, insertedByRole } = await AppDataSource.transaction(async (manager) => {
      const [featureSummary, featureIds] = await seedFeatures(manager);
      const [permissionSummary, permissionIds] = await seedPermissions(manager, featureIds);
      const [roleSummary, roleIds] = await seedRoles(manager);
      const grants = await seedRolePermissions(manager, roleIds, permissionIds);

      return {
        summaries: [featureSummary, permissionSummary, roleSummary, grants.summary],
        insertedByRole: grants.insertedByRole,
      };
    });

    report(summaries, insertedByRole);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
