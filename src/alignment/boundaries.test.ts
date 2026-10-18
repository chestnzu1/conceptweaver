import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Alignment is to be asked for the same way whether the page answers or a backend does. That
 * holds only while the contract knows nothing of the page, and the service nothing of the
 * interface. This test keeps it so.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what alignment depends on', () => {
  it('is the model and its alignment, its matcher, and its own contract', () => {
    expect(files.sort()).toEqual(['contracts.ts', 'local.ts']);
    for (const file of files) {
      for (const from of imports(file)) {
        if (from.startsWith('./') || from.startsWith('../model/')) continue;
        throw new Error(`${file} imports ${from}`);
      }
    }
  });

  it('never includes the interface or the store', () => {
    for (const file of files) {
      for (const from of imports(file)) expect(/react|zustand|components|\/store$|\/state\//.test(from), `${file} imports ${from}`).toBe(false);
    }
  });

  it('has a contract that depends on the model only', () => {
    for (const from of imports('contracts.ts')) expect(from.startsWith('../model/'), `contracts.ts imports ${from}`).toBe(true);
  });
});
