import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads .env.dev (then .env.local, which wins) into process.env before any test
 * imports the config.
 *
 * Done here rather than with node --env-file because that path makes Node parse
 * the TypeScript itself, and its type stripping cannot handle the decorators the
 * entities rely on. Vitest's own transform can, so the env has to arrive through
 * a setup file instead.
 */
function load(file: string, required: boolean): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch (error) {
    if (required) throw error;
    return;
  }

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;

    const key = trimmed.slice(0, equals).trim();
    // Strip an inline comment, then surrounding quotes.
    const raw = trimmed.slice(equals + 1).replace(/\s+#.*$/, '').trim();
    const value = raw.replace(/^["']|["']$/g, '');

    // Earlier files lose to later ones, and a real environment variable wins
    // over both — the same precedence the running service has.
    process.env[key] = value;
  }
}

load('.env.dev', true);
load('.env.local', false);
