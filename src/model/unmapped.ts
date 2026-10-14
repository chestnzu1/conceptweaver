import { Parser } from 'n3';

/**
 * Statements as whole units, for keeping what the reader has no place for (TD-01, step 1).
 *
 * A statement is a triple together with the blank nodes it reaches: a restriction with its
 * property and filler, a list with its cells, an axiom annotation with what it annotates. Where
 * blank nodes are shared between triples, all of them are one statement, so that nothing is
 * kept in half. Each statement has a canonical text, the same whatever the blank nodes were
 * called and whatever order the triples came in, so that two documents can be compared statement
 * by statement; and it is written as Turtle that reads back as the same statement.
 */

export interface Term {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}
export interface Quad {
  subject: Term;
  predicate: Term;
  object: Term;
}

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const LANG_STRING = RDF + 'langString';

export interface Statement {
  /** Canonical Turtle: full IRIs, blank nodes written in place where they can be, everything in a fixed order. */
  text: string;
  quads: Quad[];
}

const isBlank = (t: Term) => t.termType === 'BlankNode';
const blankKey = (t: Term) => '_:' + t.value;

function literal(t: Term): string {
  const dt = t.datatype?.value;
  return JSON.stringify(t.value) + (t.language ? '@' + t.language : dt && dt !== XSD_STRING && dt !== LANG_STRING ? `^^<${dt}>` : '');
}

/** Groups the quads into statements and gives each its canonical text. */
export function statements(quads: Quad[]): Statement[] {
  // Blank nodes joined by any triple are one structure (union-find over the blank nodes).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = x; parent.get(c) !== r; ) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const touch = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const q of quads) {
    const s = isBlank(q.subject) ? blankKey(q.subject) : undefined;
    const o = isBlank(q.object) ? blankKey(q.object) : undefined;
    if (s) touch(s);
    if (o) touch(o);
    if (s && o) parent.set(find(s), find(o));
  }
  // A triple with no blank node is a statement of its own; every other one belongs to its structure.
  const groups = new Map<string, Quad[]>();
  const single: Quad[][] = [];
  for (const q of quads) {
    const b = isBlank(q.subject) ? blankKey(q.subject) : isBlank(q.object) ? blankKey(q.object) : undefined;
    if (!b) single.push([q]);
    else {
      const root = find(b);
      (groups.get(root) ?? groups.set(root, []).get(root)!).push(q);
    }
  }
  return [...single, ...groups.values()].map((qs) => ({ text: canonical(qs), quads: qs }));
}

/**
 * The canonical text of one statement. Blank nodes that are the object of exactly one triple of
 * it, and lead nowhere back, are written in place (`[ … ]`, a list as `( … )`); the others, which
 * are rare (a blank node pointed at from two places), get labels in the order a fixed walk
 * meets them.
 */
function canonical(qs: Quad[]): string {
  const out = new Map<string, Quad[]>();
  const pointedAt = new Map<string, number>();
  for (const q of qs) {
    const s = isBlank(q.subject) ? blankKey(q.subject) : '<' + q.subject.value + '>';
    (out.get(s) ?? out.set(s, []).get(s)!).push(q);
    if (isBlank(q.object)) pointedAt.set(blankKey(q.object), (pointedAt.get(blankKey(q.object)) ?? 0) + 1);
  }
  const labelled = new Map<string, string>();
  const inline = (b: string) => (pointedAt.get(b) ?? 0) === 1 && !labelled.has(b);
  const visiting = new Set<string>();

  const term = (t: Term): string => {
    if (t.termType === 'Literal') return literal(t);
    if (t.termType === 'NamedNode') return '<' + t.value + '>';
    const b = blankKey(t);
    if (inline(b) && !visiting.has(b)) return node(b);
    if (!labelled.has(b)) labelled.set(b, '_:b' + labelled.size);
    return labelled.get(b)!;
  };
  /** A blank node written in place: a list if it is a proper one, otherwise its properties. */
  const node = (b: string): string => {
    visiting.add(b);
    const items = asList(b);
    const text = items ? `( ${items.map(term).join(' ')} )` : `[ ${props(out.get(b) ?? [])} ]`;
    visiting.delete(b);
    return text;
  };
  const asList = (b: string): Term[] | undefined => {
    const items: Term[] = [];
    const seen = new Set<string>();
    for (let cell = b; cell !== RDF + 'nil'; ) {
      const own = out.get(cell) ?? [];
      const first = own.filter((q) => q.predicate.value === RDF + 'first');
      const rest = own.filter((q) => q.predicate.value === RDF + 'rest');
      if (seen.has(cell) || own.length !== 2 || first.length !== 1 || rest.length !== 1) return undefined;
      // A cell that is pointed at from elsewhere is not only a list's: written as triples.
      if (cell !== b && (pointedAt.get(cell) ?? 0) !== 1) return undefined;
      seen.add(cell);
      items.push(first[0].object);
      const next = rest[0].object;
      if (next.termType === 'NamedNode' && next.value === RDF + 'nil') return items;
      if (!isBlank(next)) return undefined;
      cell = blankKey(next);
    }
    return items;
  };
  const props = (list: Quad[]) =>
    list
      .map((q) => `<${q.predicate.value}> ${term(q.object)}`)
      .sort()
      .join(' ; ');

  // The roots: named subjects, and blank nodes that nothing points at. Their statements first, in order.
  const roots = [...out.keys()].filter((s) => !s.startsWith('_:') || !pointedAt.has(s));
  const lines = roots.map((s) => (s.startsWith('_:') ? `${node(s)} .` : out.get(s)!.map((q) => `${s} ${props([q])} .`).join('\n')));
  // Whatever is left (blank nodes pointed at twice, or in a cycle) is written as triples of its
  // own, until writing them labels no more.
  const written = new Set<string>();
  for (let more = true; more; ) {
    more = false;
    for (const [s, list] of out) {
      if (!s.startsWith('_:') || !labelled.has(s) || written.has(s)) continue;
      written.add(s);
      more = true;
      lines.push(`${labelled.get(s)} ${props(list)} .`);
    }
  }
  return lines.sort().join('\n');
}

/** The statements of a Turtle document. */
export const statementsOf = (turtle: string): Statement[] => statements(new Parser().parse(turtle) as unknown as Quad[]);

/**
 * The statements as JSON-LD node objects, for a JSON-LD export: one for each subject, blank nodes
 * by labels of their own. Lists stay as the rdf:first and rdf:rest triples they are.
 */
export function jsonLdNodes(turtle: string): Record<string, unknown>[] {
  const nodes = new Map<string, Record<string, unknown[]>>();
  const id = (t: Term) => (isBlank(t) ? '_:kept-' + t.value : t.value);
  const value = (t: Term): unknown => {
    if (t.termType !== 'Literal') return { '@id': id(t) };
    const dt = t.datatype?.value;
    return t.language ? { '@value': t.value, '@language': t.language } : dt && dt !== XSD_STRING ? { '@value': t.value, '@type': dt } : { '@value': t.value };
  };
  for (const q of new Parser().parse(turtle) as unknown as Quad[]) {
    const s = id(q.subject);
    const node = nodes.get(s) ?? nodes.set(s, {}).get(s)!;
    if (q.predicate.value === RDF + 'type' && q.object.termType !== 'Literal') (node['@type'] ??= []).push(id(q.object));
    else (node[q.predicate.value] ??= []).push(value(q.object));
  }
  return [...nodes].map(([s, props]) => ({ '@id': s, ...props }));
}

const OWL = 'http://www.w3.org/2002/07/owl#';
/** Kinds of statement kept, by what marks them, in the order they are named. */
const KINDS: { what: string; plural: string; is: (q: Quad) => boolean }[] = [
  { what: 'property chain', plural: 'property chains', is: (q) => q.predicate.value === OWL + 'propertyChainAxiom' },
  { what: 'key', plural: 'keys', is: (q) => q.predicate.value === OWL + 'hasKey' },
  { what: 'annotation on an axiom', plural: 'annotations on axioms', is: (q) => q.predicate.value === RDF + 'type' && q.object.value === OWL + 'Axiom' },
  { what: 'annotation on an annotation', plural: 'annotations on annotations', is: (q) => q.predicate.value === RDF + 'type' && q.object.value === OWL + 'Annotation' },
  { what: 'negative property assertion', plural: 'negative property assertions', is: (q) => q.predicate.value === RDF + 'type' && q.object.value === OWL + 'NegativePropertyAssertion' },
  { what: 'SWRL rule', plural: 'SWRL rules', is: (q) => q.predicate.value === RDF + 'type' && q.object.value === 'http://www.w3.org/2003/11/swrl#Imp' },
];

/**
 * What the kept statements are, counted, for telling whoever opened the file: the kinds that
 * have a name ("2 property chains"), and the rest together ("12 other statements").
 */
export function keptSummary(unmapped: string | undefined): string[] {
  if (!unmapped?.trim()) return [];
  let all: Statement[];
  try {
    all = statementsOf(unmapped);
  } catch {
    return [];
  }
  const counts = new Map<string, number>();
  let other = 0;
  for (const st of all) {
    const kind = KINDS.find((k) => st.quads.some(k.is));
    if (kind) counts.set(kind.what, (counts.get(kind.what) ?? 0) + 1);
    else other++;
  }
  const named = KINDS.filter((k) => counts.has(k.what)).map((k) => `${counts.get(k.what)!.toLocaleString('en')} ${counts.get(k.what) === 1 ? k.what : k.plural}`);
  return other ? [...named, `${other.toLocaleString('en')} ${named.length ? 'other ' : ''}statement${other === 1 ? '' : 's'}`] : named;
}

/** The kept statements with IRIs changed (old → new), as when an entity is given another IRI. */
export function renameIris(unmapped: string | undefined, changed: Map<string, string>): string | undefined {
  if (!unmapped || !changed.size) return unmapped;
  return unmapped.replace(/<([^<>\s]*)>/g, (all, iri: string) => (changed.has(iri) ? `<${changed.get(iri)}>` : all));
}

/**
 * The kept statements without those that mention any of `iris`: what goes with an entity that is
 * deleted, as it would in any other editor. Nothing, when nothing is left.
 */
export function withoutIris(unmapped: string | undefined, iris: Set<string>): string | undefined {
  if (!unmapped || !iris.size) return unmapped;
  const mentions = (q: Quad) => [q.subject, q.predicate, q.object].some((t) => t.termType === 'NamedNode' && iris.has(t.value));
  const all = statementsOf(unmapped);
  const left = all.filter((st) => !st.quads.some(mentions));
  if (left.length === all.length) return unmapped;
  return left.length ? left.map((st) => st.text).sort().join('\n') + '\n' : undefined;
}
