import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Logical data models are to be the same whether the editor keeps them or a backend does
 * (SYSTEM_ARCHITECTURE.md §13), and apart from the ontology (ADR-022). That holds only while the
 * contract knows nothing of either, and the service nothing of the interface, the ontology's
 * editing or its RDF. This test keeps it so.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what the logical models depend on', () => {
  it('is each other, and the project they are kept in', () => {
    expect(files.sort()).toEqual(['contracts.ts', 'exchange.ts', 'local.ts', 'rules.ts', 'text.ts']);
    for (const file of files) {
      for (const from of imports(file)) {
        if (from.startsWith('./') || from === '../model/types') continue;
        throw new Error(`${file} imports ${from}`);
      }
    }
  });

  it('takes nothing of the project but its type', () => {
    for (const file of files) {
      const text = readFileSync(here + file, 'utf8');
      for (const line of text.split('\n').filter((l) => l.includes("from '../model/types'"))) expect(line, file).toMatch(/^import type /);
    }
  });

  it('never includes the interface, the store, or the ontology’s editing', () => {
    for (const file of files) {
      for (const from of imports(file)) expect(/react|zustand|components|\/store$|\/state\/|editing|rdf|n3/.test(from), `${file} imports ${from}`).toBe(false);
    }
  });

  it('has a contract that depends on nothing at all', () => {
    expect(imports('contracts.ts')).toEqual([]);
  });
});
