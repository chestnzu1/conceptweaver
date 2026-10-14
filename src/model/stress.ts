import { arrangeAsHierarchy } from './layout';
import { emptyModel, newProp, newRelation, newTerm, DATATYPES, type Model, type Quantifier } from './types';

/**
 * A synthetic ontology for testing at scale: `classes` classes in a deep hierarchy, plus
 * object properties, data properties, individuals and facts in proportion (about 1.5 terms
 * and 4 relationships per class). The same numbers always give the same model.
 */
export function stressModel(classes = 650): Model {
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const m = emptyModel(`Stress test (${classes} classes)`);
  m.description = 'Generated to test the app with a large model.';
  m.vocab.enabled = true;
  const rel = (from: string, to: string, patch: Partial<ReturnType<typeof newRelation>> = {}) => m.relations.push(newRelation({ from, to, ...patch }));

  // Classes: a few roots, each new class under a recent one so that branches run deep.
  const colours = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', ''];
  const cls: { id: string; depth: number; root: number }[] = [];
  const roots = Math.max(4, Math.round(classes / 80));
  for (let i = 0; i < classes; i++) {
    const parent = i < roots ? undefined : cls[Math.max(0, i - 1 - Math.floor(rand() * rand() * i))];
    const root = parent ? parent.root : i;
    const t = newTerm({ name: `Class ${i + 1}`, color: colours[root % colours.length], description: i % 3 ? `Description of class ${i + 1}.` : '' });
    m.terms.push(t);
    cls.push({ id: t.id, depth: parent ? parent.depth + 1 : 0, root });
    if (parent) rel(t.id, parent.id, { kind: 'generalization' });
  }
  // Some classes have a second parent from the same branch, higher up.
  for (let i = roots * 4; i < classes; i += 19) {
    const other = cls.find((c, j) => j < i && c.root === cls[i].root && c.depth < cls[i].depth - 1 && j % 3 === 0);
    if (other) rel(cls[i].id, other.id, { kind: 'generalization' });
  }
  for (let i = 0; i + 1 < roots; i += 2) rel(cls[i].id, cls[i + 1].id, { predicate: 'owl:disjointWith' });

  // Object properties, some with characteristics, an inverse or a parent, half with a domain and range.
  const chars = ['transitive', 'symmetric', 'functional', 'asymmetric', 'irreflexive', 'inverseFunctional'];
  const nProps = Math.round(classes / 9);
  for (let i = 0; i < nProps; i++) {
    const p = newProp({ name: `relates ${i + 1}`, chars: i % 4 === 0 ? [chars[(i / 4) % chars.length]] : [] });
    if (i % 2 === 0) {
      p.domain = [cls[Math.floor(rand() * roots * 3)].id];
      p.range = [cls[Math.floor(rand() * roots * 3)].id];
    }
    // Only a property with no domain and no characteristic (an odd-numbered one) is used as a
    // parent or an inverse, so that facts passed on to it cannot contradict anything.
    if (i % 7 === 3 && i % 2 === 0) p.parents = [m.props[i - 1].id];
    if (i % 10 === 6) p.inverses = [m.props[i - 1].id];
    m.props.push(p);
  }
  const quantifiers: Quantifier[] = ['some', 'some', 'some', 'only', 'min', 'max', 'exactly'];
  for (let i = 0; i < classes * 1.4; i++) {
    const q = pick(quantifiers);
    rel(pick(cls).id, pick(cls).id, { label: pick(m.props).name, ...(q !== 'some' ? { restriction: q } : {}), ...(q === 'min' || q === 'max' || q === 'exactly' ? { restrictionN: 1 + Math.floor(rand() * 3) } : {}) });
  }
  // A handful of relationships nobody has classified.
  for (let i = 0; i < classes / 16; i++) rel(pick(cls).id, pick(cls).id, { label: `linked ${1 + (i % 6)}` });

  // Data properties, each had by one to three classes.
  for (let i = 0; i < classes / 7; i++) {
    const t = newTerm({ name: `Attribute ${i + 1}`, type: 'property', range: DATATYPES[i % DATATYPES.length].id });
    m.terms.push(t);
    for (let k = 0; k <= i % 3; k++) rel(pick(cls).id, t.id, { kind: 'property' });
  }

  // Individuals with a type, and facts between them.
  const individuals: string[] = [];
  for (let i = 0; i < classes / 3; i++) {
    const t = newTerm({ name: `Individual ${i + 1}`, type: 'instance' });
    m.terms.push(t);
    individuals.push(t.id);
    rel(t.id, pick(cls).id, { kind: 'generalization' });
  }
  // Facts use the properties without a domain, so that the random data stays consistent.
  const free = m.props.filter((p) => !p.domain && !p.chars.some((c) => c === 'functional' || c === 'inverseFunctional' || c === 'asymmetric' || c === 'irreflexive'));
  for (let i = 0; i < classes * 0.8; i++) rel(pick(individuals), pick(individuals), { label: pick(free).name });

  arrangeAsHierarchy(m);
  return m;
}
