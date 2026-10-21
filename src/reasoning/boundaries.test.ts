import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Reasoning is to be asked the same way whether the page answers or a backend does. That
 * holds only while the contract knows nothing of either, and the service nothing of the
 * interface. This test keeps it so.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what reasoning depends on', () => {
  it('is the reasoner and the model it reasons about', () => {
    expect(files.sort()).toEqual(['contracts.ts', 'http.ts', 'local.ts', 'worker.ts']);
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

  it('has a contract that depends on nothing at all', () => {
    expect(imports('contracts.ts')).toEqual([]);
  });
});
