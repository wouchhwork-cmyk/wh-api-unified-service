#!/usr/bin/env node
/**
 * Guard for destructive database scripts (db:drop, and db:reset which chains it).
 * The TypeORM CLI has no such guard of its own — backend-design.md §5.1.
 */
if (process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production') {
  console.error('refused: NODE_ENV=%s — db:drop is never allowed here', process.env.NODE_ENV);
  process.exit(1);
}
