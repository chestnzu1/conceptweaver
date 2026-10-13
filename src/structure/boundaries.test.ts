import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The explorer's services are to work the same over a backend as over the model in the editor.
 * That holds only while they know nothing of either the interface or the app's own model, apart
 * from the one file that reads the model. This test is what keeps it so.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what the structure services depend on', () => {
  it('is only each other, except for the one file that reads the model', () => {
    expect(files).toContain('contracts.ts');
    for (const file of files) {
      for (const from of imports(file)) {
        if (file === 'local.ts' && from.startsWith('../model/')) continue;
        expect(from.startsWith('./'), `${file} imports ${from}`).toBe(true);
      }
    }
  });

  it('never includes the interface or the store, even where the model is read', () => {
    for (const file of files) {
      for (const from of imports(file)) expect(/react|zustand|components|\/store$/.test(from), `${file} imports ${from}`).toBe(false);
    }
  });

  it('has contracts that depend on nothing at all', () => {
    expect(imports('contracts.ts')).toEqual([]);
  });
});
