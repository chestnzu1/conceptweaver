import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The transformation reads the ontology and proposes logical data model elements; it is not the
 * editor (SYSTEM_ARCHITECTURE.md §13.4). That holds only while its engine and services know
 * nothing of the interface, the store, the ontology's editing or RDF: they take the models as
 * plain data and give plain data back, so that they can run in a worker and, one day, behind a
 * service. The contract depends on nothing at all.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('what the transformation depends on', () => {
  it('is its own files, the ontology read-only, and the logical models', () => {
    expect(files.sort()).toEqual(['contracts.ts', 'conversions.ts', 'impact.ts', 'impactWorker.ts', 'local.ts', 'transform.ts', 'worker.ts']);
    const allowed = new Set(['../model/types', '../model/expressions', '../model/iri', '../model/unmapped', '../logical/contracts', '../logical/rules', '../logical/edits', '../logical/strategies']);
    for (const file of files) {
      for (const from of imports(file)) {
        if (from.startsWith('./') || allowed.has(from)) continue;
        throw new Error(`${file} imports ${from}`);
      }
    }
  });

  it('takes the model’s type as a type only, never its runtime', () => {
    for (const file of files) {
      for (const line of readFileSync(here + file, 'utf8').split('\n')) {
        if (!line.includes("from '../model/types'")) continue;
        expect(line, file).toMatch(/^import type /);
      }
    }
  });

  it('never includes the interface, the store, the ontology’s editing, or RDF', () => {
    for (const file of files) {
      for (const from of imports(file)) expect(/react|zustand|components|\/store$|\/state\/|editing|rdf|n3/.test(from), `${file} imports ${from}`).toBe(false);
    }
  });

  it('has a contract that depends on nothing at all', () => {
    expect(imports('contracts.ts')).toEqual(['../model/types', '../logical/contracts']);
    for (const line of readFileSync(here + 'contracts.ts', 'utf8').split('\n').filter((l) => l.startsWith('import'))) expect(line).toMatch(/^import type /);
  });
});
