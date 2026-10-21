import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Edits are to be the same change sets whether the editor applies them or a backend does. That
 * holds only while the contract knows nothing of either, and the service nothing of the
 * interface. This test keeps it so.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what editing depends on', () => {
  it('is the model, read and written, and the revisions the other services name', () => {
    expect(files.sort()).toEqual(['axioms.ts', 'contracts.ts', 'http.ts', 'local.ts']);
    for (const file of files) {
      for (const from of imports(file)) {
        if (from.startsWith('./') || from === 'n3' || from.startsWith('../model/') || from === '../structure/local') continue;
        throw new Error(`${file} imports ${from}`);
      }
    }
  });

  it('never includes the interface or the store', () => {
    for (const file of files) {
      for (const from of imports(file)) expect(/react|zustand|components|\/store$|\/state\//.test(from), `${file} imports ${from}`).toBe(false);
    }
  });

  it('has a contract that depends on nothing at all', () => {
    expect(imports('contracts.ts')).toEqual([]);
  });
});
