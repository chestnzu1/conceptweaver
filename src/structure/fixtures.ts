import type { ClassGraphInput } from './graph';

/** Hierarchies written out in a line, for the tests. */

export const NS = 'http://example.org/o#';

/** "Actor < Person; WorkingActor < Actor, Employee": each class with its stated superclasses. `=` states an equivalence. */
export function graphOf(spec: string): ClassGraphInput {
  const input: ClassGraphInput = { classes: [], subClassOf: [], equivalent: [] };
  const seen = new Set<string>();
  const cls = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      input.classes.push({ iri: NS + name, label: name });
    }
    return NS + name;
  };
  for (const line of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    if (line.includes('=')) {
      const [a, b] = line.split('=').map((s) => cls(s.trim()));
      input.equivalent.push({ a, b });
      continue;
    }
    const [child, parents] = line.split('<').map((s) => s.trim());
    cls(child);
    for (const p of (parents ?? '').split(',').map((s) => s.trim()).filter(Boolean)) input.subClassOf.push({ sub: cls(child), sup: cls(p) });
  }
  return input;
}

/** One class, Top, with `n` direct subclasses, numbered so that label order is number order. */
export function wide(n: number): ClassGraphInput {
  const input: ClassGraphInput = { classes: [{ iri: NS + 'Top', label: 'Top' }], subClassOf: [], equivalent: [] };
  for (let i = 0; i < n; i++) {
    const iri = `${NS}K${String(i).padStart(6, '0')}`;
    input.classes.push({ iri, label: iri.slice(NS.length) });
    input.subClassOf.push({ sub: iri, sup: NS + 'Top' });
  }
  return input;
}

/**
 * A hierarchy of `n` classes for trying things at scale: a few classes at the top, each further
 * class under a recent one so that branches run deep, and about one class in twenty with a
 * second superclass. The same numbers always give the same hierarchy.
 */
export function generated(n: number): ClassGraphInput {
  let seed = 11;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const input: ClassGraphInput = { classes: [], subClassOf: [], equivalent: [] };
  const tops = Math.max(4, Math.round(n / 400));
  const iri = (i: number) => `${NS}G${i}`;
  for (let i = 0; i < n; i++) {
    input.classes.push({ iri: iri(i), label: `Generated class ${i}` });
    if (i < tops) continue;
    const parent = Math.max(0, i - 1 - Math.floor(rand() * rand() * i));
    input.subClassOf.push({ sub: iri(i), sup: iri(parent) });
    // A second superclass from earlier on, which never leads back down: no rings.
    if (i % 20 === 7) {
      const other = Math.floor(rand() * i);
      if (other !== parent) input.subClassOf.push({ sub: iri(i), sup: iri(other) });
    }
  }
  return input;
}

