import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No controller may reach a repository.
 *
 * The rule is the project's, not this test's: Controller → Service →
 * Repository, one direction. A controller that reads a repository is not
 * obviously broken, which is exactly the problem — five of them did, each for
 * what looked like a single harmless lookup, and one of those lookups was the
 * tenant-scoping check that made conversation assignment safe. That rule ended
 * up in the layer least likely to be re-read when assignment changed.
 *
 * Asserted over the source rather than the DI graph, because the failure is one
 * of intent: a controller can only inject a repository if somebody imported it,
 * and the import is the moment to catch it.
 */
const MODULES_DIR = join(process.cwd(), 'src', 'modules');

function controllerFiles(): string[] {
  const found: string[] = [];
  for (const moduleName of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!moduleName.isDirectory()) continue;
    const dir = join(MODULES_DIR, moduleName.name);
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.controller.ts')) found.push(join(dir, entry));
    }
  }
  return found;
}

describe('controllers do not reach past the service layer', () => {
  it('finds the controllers at all, so a passing run means something', () => {
    // Without this the suite would pass silently if the layout ever moved.
    expect(controllerFiles().length).toBeGreaterThan(5);
  });

  it('imports no repository it could call', () => {
    /*
     * VALUE imports only. `import type { MessageRow } from '...repository'` is
     * not a layering violation: a type cannot be injected and cannot reach the
     * database, and the controller is using it to map a row the SERVICE handed
     * back. Two controllers do exactly that and are right to.
     *
     * What matters is importing the class itself, which is the only form that
     * can end up in a constructor.
     */
    const offenders = controllerFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source
          .split('\n')
          .some(
            (line) =>
              /from '@\/database\/repositories\//.test(line) && !line.includes('import type'),
          );
      })
      .map((file) => file.slice(MODULES_DIR.length + 1));

    // Named, not counted: a failure should say which controller to fix.
    expect(offenders).toEqual([]);
  });

  it('injects no repository', () => {
    // The import is the usual tell, but a type-only or re-exported reference
    // would slip past it; the constructor parameter is the thing that matters.
    const offenders = controllerFiles()
      .filter((file) => /private readonly \w+: \w*Repository\b/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(MODULES_DIR.length + 1));

    expect(offenders).toEqual([]);
  });
});
