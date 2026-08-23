#!/usr/bin/env node
/**
 * Guard for destructive database scripts (db:drop, and db:reset which chains it).
 * The TypeORM CLI has no such guard of its own — backend-design.md §5.1.
 *
 * IT ASSERTS ON THE RESOLVED TARGET, NOT ON A LABEL.
 *
 * It used to check NODE_ENV alone, and that is exactly the check the failure mode
 * defeats: every db:* script passes `--env-file=.env.dev`, and Node lets a real
 * exported environment variable win over the file. So a developer who exported
 * production DB_HOST and DB_NAME earlier in the same terminal passed this guard —
 * NODE_ENV resolves to `dev` from the file — while the connection went to
 * production. The drop succeeded and the migrate and seed that followed made it
 * look like an ordinary run.
 *
 * The host and the database name are what actually decide what gets destroyed, so
 * they are what is checked. Run with the same --env-file as the script it guards,
 * so it resolves the same values that script will.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'postgres', 'db']);

/** A name that says, in itself, that this database is disposable. */
const DISPOSABLE_NAME = /_(dev|test|local)$/;

const host = (process.env.DB_HOST ?? '').trim().toLowerCase();
const name = (process.env.DB_NAME ?? '').trim();
const nodeEnv = process.env.NODE_ENV ?? 'unset';

const problems = [];

if (nodeEnv === 'prod' || nodeEnv === 'production') {
  problems.push(`NODE_ENV is ${nodeEnv}`);
}
if (!host) {
  problems.push('DB_HOST is not set, so the target cannot be established');
} else if (!LOCAL_HOSTS.has(host)) {
  // Compose service names are allowed above; anything else is somebody's server.
  problems.push(`DB_HOST is "${host}", which is not a local or compose host`);
}
if (!name) {
  problems.push('DB_NAME is not set, so the target cannot be established');
} else if (!DISPOSABLE_NAME.test(name)) {
  problems.push(`DB_NAME is "${name}", which does not end in _dev, _test or _local`);
}

if (problems.length > 0) {
  console.error('refused: this would destroy data on a target that is not disposable.');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\nresolved target: ${process.env.DB_USER ?? '?'}@${host || '?'}:` +
      `${process.env.DB_PORT ?? '?'}/${name || '?'} (NODE_ENV=${nodeEnv})`,
  );
  console.error(
    '\nIf that target is genuinely wrong, note that an exported DB_HOST or DB_NAME\n' +
      'beats --env-file: check your shell before changing this guard.',
  );
  process.exit(1);
}

console.log(`target checked: ${process.env.DB_USER ?? '?'}@${host}:${process.env.DB_PORT ?? '?'}/${name}`);
