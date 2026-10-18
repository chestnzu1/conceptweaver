import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A SPARQL query is to be answered the same way whether the page runs it or a backend does.
 * That holds only while the question knows nothing of either the interface or the app's own
 * model, apart from the one file that reads the model. This test keeps it so.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what the SPARQL question depends on', () => {
  it('is only each other, except for the one file that reads the model', () => {
    expect(files.sort()).toEqual(['contracts.ts', 'http.ts', 'local.ts']);
    for (const file of files) {
      for (const from of imports(file)) {
        // The revision of the model is named as the Structure Explorer names it.
        if (file === 'local.ts' && (from.startsWith('../model/') || from === '../structure/local')) continue;
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
