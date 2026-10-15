import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the views show of reasoning and validation they are given: the answers of jobs that run
 * away from the page (src/reasoning, src/validation), through the store. A view that ran the
 * reasoner or the checks itself would hold up the page while it worked, and would have to change
 * for the ontology to be checked anywhere else. This test keeps them from it.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
const imports = (file: string) => [...readFileSync(here + file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('the views', () => {
  it('never import the reasoner or the validation engine', () => {
    for (const file of files) for (const from of imports(file)) expect(['../model/reasoner', '../model/validation'], `${file} imports ${from}`).not.toContain(from);
  });
});
