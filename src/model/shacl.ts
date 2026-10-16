import { DataFactory, Parser, Writer } from 'n3';
import { uid } from './types';

/**
 * SHACL shapes as the editor holds them (model format 5, roadmap stage SH-1): shape sets, each a
 * shapes graph of its own (a constraint model: what an application or a source accepts), beside
 * the ontology and never part of it.
 *
 * A shape is what SHACL 1.0 (§2.1) says one is: an instance of sh:NodeShape or sh:PropertyShape,
 * the subject of a target, of a constraint parameter or of sh:path, or the value of a parameter
 * that expects a shape (sh:node, sh:property, sh:not, sh:qualifiedValueShape, a member of sh:and,
 * sh:or or sh:xone). It is held as what is said of it, in the order read: each statement a
 * predicate and a value, the value a term, a list, a property path, or another shape, so that
 * every construct of SHACL Core is held as the structure it is, and nothing is lost. Anonymous
 * shapes are shapes of the set referred to by id; named ones are referred to by IRI, wherever
 * they are defined. What the graph says that is about no shape (data, an ontology, a test
 * manifest, property groups) is kept as written and written back.
 *
 * Nothing here turns an OWL restriction into a shape or the other way round (ADR-020).
 */

export const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

// ---------------------------------------------------------------- the model

/** A shapes graph of the project: a constraint model, with what it is for. */
export interface ShapeSet {
  id: string;
  name: string;
  /** What it is for: an application, a data source. */
  description: string;
  /** Where the IRIs of shapes made in the editor go. Empty: the model's namespace. */
  namespace: string;
  shapes: Shape[];
  /** What the shapes graph says besides its shapes, as Turtle, kept as written. */
  extra: string;
  /** The prefixes the shapes graph was written with, for writing it back so. */
  prefixes: Record<string, string>;
}

export interface Shape {
  id: string;
  /** The shape's IRI; none for a blank node. */
  iri?: string;
  /** What is said of the shape, in the order it was said. */
  props: ShapeProp[];
}

/** One statement about a shape: its predicate (a full IRI) and its value. */
export interface ShapeProp {
  p: string;
  v: ShaclValue;
}

export type ShaclTerm = { iri: string } | { lit: string; lang?: string; dt?: string };

/**
 * A value: a term; an anonymous shape of the set, by id; a list; a property path (the value of
 * sh:path); a blank-node structure that is no shape, kept as written (`ttl`, Turtle with full
 * IRIs); or a blank node shared with what is kept as written (`blank`, by its label there).
 */
export type ShaclValue = ShaclTerm | { shape: string } | { list: ShaclValue[] } | { path: ShaclPath } | { ttl: string } | { blank: string };

export type ShaclPath = { iri: string } | { inverse: ShaclPath } | { sequence: ShaclPath[] } | { alternative: ShaclPath[] } | { zeroOrMore: ShaclPath } | { oneOrMore: ShaclPath } | { zeroOrOne: ShaclPath };

/** The kinds of value a parameter takes, which decide how the form edits it. */
export type ParamKind = 'class' | 'property' | 'datatype' | 'term' | 'count' | 'literal' | 'text' | 'boolean' | 'nodeKind' | 'severity' | 'shape' | 'shapes' | 'terms' | 'langs' | 'properties' | 'iri';

export interface ParamInfo {
  local: string;
  label: string;
  group: string;
  kind: ParamKind;
  /** Where it applies: to node shapes, property shapes, or both. */
  on: 'node' | 'property' | 'both';
  /** A constraint parameter: a node with it is a shape (SHACL §2.1). */
  constraint?: boolean;
  about: string;
}

/** SHACL 1.0 Core, parameter by parameter, as the form offers them. */
export const PARAMS: ParamInfo[] = [
  { local: 'targetClass', label: 'Target class', group: 'Targets', kind: 'class', on: 'both', about: 'Every instance of the class is validated.' },
  { local: 'targetNode', label: 'Target node', group: 'Targets', kind: 'term', on: 'both', about: 'This node is validated.' },
  { local: 'targetSubjectsOf', label: 'Target subjects of', group: 'Targets', kind: 'property', on: 'both', about: 'Everything that has the property is validated.' },
  { local: 'targetObjectsOf', label: 'Target objects of', group: 'Targets', kind: 'property', on: 'both', about: 'Everything that is a value of the property is validated.' },
  { local: 'class', label: 'Class', group: 'Value type', kind: 'class', on: 'both', constraint: true, about: 'Each value is an instance of the class (in the data graph).' },
  { local: 'datatype', label: 'Datatype', group: 'Value type', kind: 'datatype', on: 'both', constraint: true, about: 'Each value is a literal of the datatype, well formed.' },
  { local: 'nodeKind', label: 'Node kind', group: 'Value type', kind: 'nodeKind', on: 'both', constraint: true, about: 'Each value is an IRI, a blank node or a literal, or one of two.' },
  { local: 'minCount', label: 'Min count', group: 'Cardinality', kind: 'count', on: 'property', constraint: true, about: 'At least this many values.' },
  { local: 'maxCount', label: 'Max count', group: 'Cardinality', kind: 'count', on: 'property', constraint: true, about: 'At most this many values.' },
  { local: 'minInclusive', label: 'Min inclusive', group: 'Value range', kind: 'literal', on: 'both', constraint: true, about: 'Each value is at least this.' },
  { local: 'minExclusive', label: 'Min exclusive', group: 'Value range', kind: 'literal', on: 'both', constraint: true, about: 'Each value is more than this.' },
  { local: 'maxInclusive', label: 'Max inclusive', group: 'Value range', kind: 'literal', on: 'both', constraint: true, about: 'Each value is at most this.' },
  { local: 'maxExclusive', label: 'Max exclusive', group: 'Value range', kind: 'literal', on: 'both', constraint: true, about: 'Each value is less than this.' },
  { local: 'minLength', label: 'Min length', group: 'String', kind: 'count', on: 'both', constraint: true, about: 'Each value is at least this many characters long.' },
  { local: 'maxLength', label: 'Max length', group: 'String', kind: 'count', on: 'both', constraint: true, about: 'Each value is at most this many characters long.' },
  { local: 'pattern', label: 'Pattern', group: 'String', kind: 'text', on: 'both', constraint: true, about: 'Each value matches the regular expression.' },
  { local: 'flags', label: 'Flags', group: 'String', kind: 'text', on: 'both', constraint: true, about: 'The regular expression flags of the pattern, such as i.' },
  { local: 'languageIn', label: 'Language in', group: 'String', kind: 'langs', on: 'both', constraint: true, about: 'Each value has one of these language tags.' },
  { local: 'uniqueLang', label: 'Unique language', group: 'String', kind: 'boolean', on: 'property', constraint: true, about: 'No two values have the same language tag.' },
  { local: 'equals', label: 'Equals', group: 'Property pair', kind: 'property', on: 'both', constraint: true, about: 'The values are exactly the values of this property.' },
  { local: 'disjoint', label: 'Disjoint', group: 'Property pair', kind: 'property', on: 'both', constraint: true, about: 'No value is a value of this property.' },
  { local: 'lessThan', label: 'Less than', group: 'Property pair', kind: 'property', on: 'property', constraint: true, about: 'Each value is less than every value of this property.' },
  { local: 'lessThanOrEquals', label: 'Less than or equals', group: 'Property pair', kind: 'property', on: 'property', constraint: true, about: 'Each value is at most every value of this property.' },
  { local: 'not', label: 'Not', group: 'Logical', kind: 'shape', on: 'both', constraint: true, about: 'Each value does not conform to the shape.' },
  { local: 'and', label: 'And', group: 'Logical', kind: 'shapes', on: 'both', constraint: true, about: 'Each value conforms to all of the shapes.' },
  { local: 'or', label: 'Or', group: 'Logical', kind: 'shapes', on: 'both', constraint: true, about: 'Each value conforms to at least one of the shapes.' },
  { local: 'xone', label: 'Exactly one', group: 'Logical', kind: 'shapes', on: 'both', constraint: true, about: 'Each value conforms to exactly one of the shapes.' },
  { local: 'node', label: 'Node', group: 'Shape-based', kind: 'shape', on: 'both', constraint: true, about: 'Each value conforms to the node shape.' },
  { local: 'property', label: 'Property', group: 'Shape-based', kind: 'shape', on: 'both', constraint: true, about: 'The focus node conforms to the property shape.' },
  { local: 'qualifiedValueShape', label: 'Qualified value shape', group: 'Shape-based', kind: 'shape', on: 'property', constraint: true, about: 'So many values conform to the shape (with qualified min or max count).' },
  { local: 'qualifiedMinCount', label: 'Qualified min count', group: 'Shape-based', kind: 'count', on: 'property', constraint: true, about: 'At least this many values conform to the qualified value shape.' },
  { local: 'qualifiedMaxCount', label: 'Qualified max count', group: 'Shape-based', kind: 'count', on: 'property', constraint: true, about: 'At most this many values conform to the qualified value shape.' },
  { local: 'qualifiedValueShapesDisjoint', label: 'Qualified value shapes disjoint', group: 'Shape-based', kind: 'boolean', on: 'property', constraint: true, about: 'A value counts only if it conforms to none of the sibling qualified value shapes.' },
  { local: 'closed', label: 'Closed', group: 'Other', kind: 'boolean', on: 'node', constraint: true, about: 'The focus node has no properties but those of the shape’s property shapes, and those ignored.' },
  { local: 'ignoredProperties', label: 'Ignored properties', group: 'Other', kind: 'properties', on: 'node', constraint: true, about: 'Properties a closed shape lets through.' },
  { local: 'hasValue', label: 'Has value', group: 'Other', kind: 'term', on: 'both', constraint: true, about: 'One of the values is this.' },
  { local: 'in', label: 'In', group: 'Other', kind: 'terms', on: 'both', constraint: true, about: 'Each value is one of these.' },
  { local: 'severity', label: 'Severity', group: 'Reporting', kind: 'severity', on: 'both', about: 'How a result of the shape is reported.' },
  { local: 'message', label: 'Message', group: 'Reporting', kind: 'literal', on: 'both', about: 'What a result of the shape says.' },
  { local: 'deactivated', label: 'Deactivated', group: 'Reporting', kind: 'boolean', on: 'both', about: 'The shape is not validated.' },
  { local: 'name', label: 'Name', group: 'Not validated', kind: 'literal', on: 'property', about: 'What the property is called, in forms and reports.' },
  { local: 'description', label: 'Description', group: 'Not validated', kind: 'literal', on: 'property', about: 'What the property is for.' },
  { local: 'order', label: 'Order', group: 'Not validated', kind: 'literal', on: 'property', about: 'Where the property comes in a form.' },
  { local: 'group', label: 'Group', group: 'Not validated', kind: 'iri', on: 'property', about: 'The property group it is shown in.' },
  { local: 'defaultValue', label: 'Default value', group: 'Not validated', kind: 'term', on: 'property', about: 'The value a form starts with.' },
];

export const PARAM = new Map(PARAMS.map((p) => [SH + p.local, p]));
const TARGETS = new Set(['targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf'].map((l) => SH + l));
const CONSTRAINT = new Set([...PARAMS.filter((p) => p.constraint).map((p) => SH + p.local), SH + 'path', SH + 'sparql']);
const SHAPE_VALUED = new Set(['node', 'property', 'not', 'qualifiedValueShape'].map((l) => SH + l));
const SHAPE_LISTS = new Set(['and', 'or', 'xone'].map((l) => SH + l));
const PATH_FORMS: Record<string, 'inverse' | 'alternative' | 'zeroOrMore' | 'oneOrMore' | 'zeroOrOne'> = {
  [SH + 'inversePath']: 'inverse',
  [SH + 'alternativePath']: 'alternative',
  [SH + 'zeroOrMorePath']: 'zeroOrMore',
  [SH + 'oneOrMorePath']: 'oneOrMore',
  [SH + 'zeroOrOnePath']: 'zeroOrOne',
};
const PATH_PREDICATE = Object.fromEntries(Object.entries(PATH_FORMS).map(([k, v]) => [v, k])) as Record<string, string>;

/** A property shape is one with a path. */
export const isPropertyShape = (s: Shape): boolean => s.props.some((x) => x.p === SH + 'path');
export const pathOf = (s: Shape): ShaclPath | undefined => {
  const v = s.props.find((x) => x.p === SH + 'path')?.v;
  return v && 'path' in v ? v.path : undefined;
};
/** The values of one predicate of a shape. */
export const valuesOf = (s: Shape, p: string): ShaclValue[] => s.props.filter((x) => x.p === p).map((x) => x.v);

export const newShapeSet = (name: string, namespace = ''): ShapeSet => ({ id: uid(), name, description: '', namespace, shapes: [], extra: '', prefixes: {} });

// ---------------------------------------------------------------- reading

interface T {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}
interface Q {
  subject: T;
  predicate: T;
  object: T;
}

export interface ReadShapes {
  shapes: Shape[];
  extra: string;
  prefixes: Record<string, string>;
}

/**
 * Reads a shapes graph written in Turtle: its shapes, as structures, and whatever else it says,
 * kept as written. `base` resolves relative IRIs, as the document's address would.
 */
export function readShapes(text: string, base?: string): ReadShapes {
  const prefixes: Record<string, string> = {};
  const quads = new Parser(base ? { baseIRI: base } : {}).parse(text, null, (p: string, ns: { value: string }) => {
    if (p) prefixes[p] = ns.value;
  }) as unknown as Q[];
  return fromQuads(quads, prefixes);
}

function fromQuads(quads: Q[], prefixes: Record<string, string>): ReadShapes {
  const key = (t: T) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  const blank = (t: T) => t.termType === 'BlankNode';
  const bySubject = new Map<string, number[]>();
  const pointedAt = new Map<string, number>();
  quads.forEach((q, i) => {
    (bySubject.get(key(q.subject)) ?? bySubject.set(key(q.subject), []).get(key(q.subject))!).push(i);
    if (blank(q.object)) pointedAt.set(key(q.object), (pointedAt.get(key(q.object)) ?? 0) + 1);
  });
  const consumed = new Set<number>();
  const own = (k: string) => (bySubject.get(k) ?? []).map((i) => quads[i]);

  /** The cells of a well-formed list that only the list points at, with its items; none for anything else. */
  const listAt = (t: T): { cells: string[]; items: T[] } | undefined => {
    if (t.termType === 'NamedNode' && t.value === RDF + 'nil') return { cells: [], items: [] };
    const cells: string[] = [];
    const items: T[] = [];
    for (let cell = t; ; ) {
      if (!blank(cell)) return undefined;
      const k = key(cell);
      const qs = own(k);
      const first = qs.filter((q) => q.predicate.value === RDF + 'first');
      const rest = qs.filter((q) => q.predicate.value === RDF + 'rest');
      if (cells.includes(k) || qs.length !== 2 || first.length !== 1 || rest.length !== 1 || (pointedAt.get(k) ?? 0) !== 1) return undefined;
      cells.push(k);
      items.push(first[0].object);
      const next = rest[0].object;
      if (next.termType === 'NamedNode' && next.value === RDF + 'nil') return { cells, items };
      cell = next;
    }
  };

  // Which nodes are shapes (SHACL §2.1).
  const shapeKeys = new Set<string>();
  for (const q of quads) {
    const p = q.predicate.value;
    if (p === RDF + 'type' && (q.object.value === SH + 'NodeShape' || q.object.value === SH + 'PropertyShape')) shapeKeys.add(key(q.subject));
    if (TARGETS.has(p) || CONSTRAINT.has(p)) shapeKeys.add(key(q.subject));
    if (SHAPE_VALUED.has(p) && q.object.termType !== 'Literal') shapeKeys.add(key(q.object));
    if (SHAPE_LISTS.has(p)) for (const item of listAt(q.object)?.items ?? []) if (item.termType !== 'Literal') shapeKeys.add(key(item));
  }
  // A named shape is held where the graph says something of it; anonymous ones always.
  const held = [...new Set([...bySubject.keys(), ...shapeKeys])].filter((k) => shapeKeys.has(k) && (k.startsWith('_:') || bySubject.has(k)));
  const ids = new Map(held.map((k) => [k, uid()]));

  const consume = (k: string) => (bySubject.get(k) ?? []).forEach((i) => consumed.add(i));
  // A blank node kept as written gets a label of its own, unlike any of another reading: a set that
  // gathers several graphs never joins two blank nodes by accident. A shape's is its id.
  const labels = new Map<string, string>();
  const labelOf = (k: string) => ids.get(k) ?? labels.get(k) ?? (labels.set(k, 'k' + uid()), labels.get(k)!);

  /** A blank node that is no shape and no list, pointed at once, and leads only to more of the same: written in place as Turtle. */
  const tree = (t: T, seen = new Set<string>()): string | undefined => {
    const k = key(t);
    if (!blank(t) || shapeKeys.has(k) || seen.has(k) || (pointedAt.get(k) ?? 0) !== 1) return undefined;
    seen.add(k);
    const list = listAt(t);
    if (list) {
      const parts = list.items.map((x) => (blank(x) ? tree(x, seen) : termText(x)));
      return parts.every((x) => x !== undefined) ? `( ${parts.join(' ')} )` : undefined;
    }
    const parts: string[] = [];
    for (const q of own(k)) {
      const o = blank(q.object) ? tree(q.object, seen) : termText(q.object);
      if (o === undefined) return undefined;
      parts.push(`<${q.predicate.value}> ${o}`);
    }
    return parts.length ? `[ ${parts.join(' ; ')} ]` : '[]';
  };
  const consumeTree = (t: T) => {
    if (!blank(t)) return;
    const k = key(t);
    for (const q of own(k)) {
      consumed.add(quads.indexOf(q));
      consumeTree(q.object);
    }
  };

  const path = (t: T): ShaclPath | undefined => {
    if (t.termType === 'NamedNode') return { iri: t.value };
    if (!blank(t) || (pointedAt.get(key(t)) ?? 0) !== 1) return undefined;
    const list = listAt(t);
    if (list) {
      const steps = list.items.map(path);
      if (steps.length < 2 || steps.some((x) => !x)) return undefined;
      list.cells.forEach(consume);
      return { sequence: steps as ShaclPath[] };
    }
    const qs = own(key(t));
    if (qs.length !== 1) return undefined;
    const form = PATH_FORMS[qs[0].predicate.value];
    if (!form) return undefined;
    if (form === 'alternative') {
      const alt = listAt(qs[0].object);
      const steps = alt?.items.map(path);
      if (!alt || !steps || steps.length < 2 || steps.some((x) => !x)) return undefined;
      consume(key(t));
      alt.cells.forEach(consume);
      return { alternative: steps as ShaclPath[] };
    }
    const inner = path(qs[0].object);
    if (!inner) return undefined;
    consume(key(t));
    return { [form]: inner } as ShaclPath;
  };

  const value = (o: T): ShaclValue => {
    if (o.termType === 'NamedNode') return { iri: o.value };
    if (o.termType === 'Literal') return termOf(o);
    const k = key(o);
    if (ids.has(k)) return { shape: ids.get(k)! };
    const list = listAt(o);
    if (list) {
      list.cells.forEach(consume);
      return { list: list.items.map(value) };
    }
    const text = tree(o);
    if (text !== undefined) {
      consumeTree(o);
      return { ttl: text };
    }
    return { blank: labelOf(k) };
  };

  const shapes: Shape[] = held.map((k) => {
    const props: ShapeProp[] = [];
    for (const i of bySubject.get(k) ?? []) {
      const q = quads[i];
      consumed.add(i);
      let v: ShaclValue | undefined;
      if (q.predicate.value === SH + 'path') {
        const p = path(q.object);
        if (p) v = { path: p };
      }
      props.push({ p: q.predicate.value, v: v ?? value(q.object) });
    }
    const id = ids.get(k)!;
    return k.startsWith('_:') ? { id, props } : { id, iri: k, props };
  });

  // What is about no shape is kept as written; a shape it points at is pointed at by the label the shapes are written with.
  const rest = quads.filter((_, i) => !consumed.has(i));
  let extra = '';
  if (rest.length) {
    const b = (t: T) => (blank(t) ? DataFactory.blankNode(labelOf(key(t))) : t);
    const writer = new Writer({ prefixes });
    writer.addQuads(rest.map((q) => DataFactory.quad(b(q.subject) as never, q.predicate as never, b(q.object) as never)) as never);
    writer.end((_e: unknown, result: string) => (extra = result.trim() ? result.trim() + '\n' : ''));
  }
  return { shapes, extra, prefixes };
}

function termOf(o: T): ShaclTerm {
  if (o.termType === 'NamedNode') return { iri: o.value };
  const dt = o.datatype?.value;
  return { lit: o.value, ...(o.language ? { lang: o.language } : dt && dt !== XSD + 'string' && dt !== RDF + 'langString' ? { dt } : {}) };
}

function termText(o: T): string {
  if (o.termType === 'NamedNode') return `<${o.value}>`;
  const t = termOf(o) as { lit: string; lang?: string; dt?: string };
  return JSON.stringify(t.lit) + (t.lang ? '@' + t.lang : t.dt ? `^^<${t.dt}>` : '');
}

// ---------------------------------------------------------------- writing

/** The prefixes SHACL is written with, besides the model's and the set's own. */
/** The app's own statements about shapes: cw:fromAxiom, the axiom a shape proposed from the ontology came from (proposals.ts). */
export const CW_SHAPES = 'https://conceptweaver.app/shapes#';
export const STANDARD_PREFIXES: Record<string, string> = { sh: SH, rdf: RDF, rdfs: RDFS, xsd: XSD, owl: OWL, cw: CW_SHAPES };

const LOCAL = /^(?:[A-Za-z0-9_](?:[\w.-]*[\w-])?)?$/;

export interface WriteOptions {
  /** Prefixes to write IRIs with, besides the standard ones (the model's, the set's). */
  prefixes?: Record<string, string>;
  /** Every anonymous shape by its label, none in place: for the validator, which then names the very shape a result is of. */
  labelled?: boolean;
}

/** A shape set as Turtle: its shapes, then what it keeps as written. */
export function shapeSetTurtle(set: Pick<ShapeSet, 'shapes' | 'extra' | 'prefixes'>, options: WriteOptions = {}): string {
  const known = { ...STANDARD_PREFIXES, ...set.prefixes, ...options.prefixes };
  const byNs = Object.entries(known)
    .filter(([, ns]) => ns)
    .sort((a, b) => b[1].length - a[1].length);
  const used = new Map<string, string>();
  const name = (iri: string) => {
    for (const [p, ns] of byNs) {
      if (iri.startsWith(ns) && LOCAL.test(iri.slice(ns.length))) {
        used.set(p, ns);
        return `${p}:${iri.slice(ns.length)}`;
      }
    }
    return `<${iri}>`;
  };
  const literal = (t: { lit: string; lang?: string; dt?: string }) => {
    if (t.lang) return `${JSON.stringify(t.lit)}@${t.lang}`;
    if (t.dt === XSD + 'integer' && /^[+-]?\d+$/.test(t.lit)) return t.lit;
    if (t.dt === XSD + 'decimal' && /^[+-]?\d*\.\d+$/.test(t.lit)) return t.lit;
    if (t.dt === XSD + 'boolean' && /^(true|false)$/.test(t.lit)) return t.lit;
    return JSON.stringify(t.lit) + (t.dt ? `^^${name(t.dt)}` : '');
  };

  const byId = new Map(set.shapes.map((s) => [s.id, s]));
  // How many times each anonymous shape is pointed at; one pointed at once, and not from what is kept as written, is written in place.
  const refs = new Map<string, number>();
  const count = (v: ShaclValue) => {
    if ('shape' in v) refs.set(v.shape, (refs.get(v.shape) ?? 0) + 1);
    else if ('list' in v) v.list.forEach(count);
  };
  for (const s of set.shapes) for (const x of s.props) count(x.v);
  const inExtra = (id: string) => set.extra.includes('_:' + id);
  const inPlace = (s: Shape) => !options.labelled && !s.iri && refs.get(s.id) === 1 && !inExtra(s.id);
  const subject = (s: Shape) => (s.iri ? name(s.iri) : `_:${s.id}`);

  const pathText = (p: ShaclPath): string => {
    if ('iri' in p) return name(p.iri);
    if ('sequence' in p) return `( ${p.sequence.map(pathText).join(' ')} )`;
    used.set('sh', SH);
    if ('alternative' in p) return `[ sh:alternativePath ( ${p.alternative.map(pathText).join(' ')} ) ]`;
    const [form, inner] = Object.entries(p)[0] as [string, ShaclPath];
    return `[ sh:${PATH_PREDICATE[form].slice(SH.length)} ${pathText(inner)} ]`;
  };
  const writing = new Set<string>();
  const value = (v: ShaclValue, indent: string): string => {
    if ('iri' in v) return name(v.iri);
    if ('lit' in v) return literal(v);
    if ('list' in v) return `( ${v.list.map((x) => value(x, indent)).join(' ')} )`;
    if ('path' in v) return pathText(v.path);
    if ('ttl' in v) return v.ttl;
    if ('blank' in v) return `_:${v.blank}`;
    const s = byId.get(v.shape);
    if (!s) return '[]';
    if (!inPlace(s) || writing.has(s.id)) return subject(s);
    return block(s, indent);
  };
  const props = (s: Shape, indent: string) =>
    s.props.map((x) => `${x.p === RDF + 'type' ? 'a' : name(x.p)} ${value(x.v, indent + '    ')}`).join(` ;\n${indent}`);
  /** A shape written in place: its statements between brackets. */
  const block = (s: Shape, indent: string): string => {
    if (!s.props.length) return '[]';
    writing.add(s.id);
    const text = `[\n${indent}    ${props(s, indent + '    ')}\n${indent}]`;
    writing.delete(s.id);
    return text;
  };

  const blocks: string[] = [];
  for (const s of set.shapes) {
    if (inPlace(s) || !s.props.length) continue;
    writing.add(s.id);
    blocks.push(`${subject(s)}\n    ${props(s, '    ')} .`);
    writing.delete(s.id);
  }
  // A shape pointed at by nothing but written in place would be lost: one with no referrer is written as itself above.
  const head = [...used].sort((a, b) => a[0].localeCompare(b[0])).map(([p, ns]) => `@prefix ${p}: <${ns}> .`);
  const own = blocks.length ? `${head.join('\n')}\n\n${blocks.join('\n\n')}\n` : '';
  const extra = set.extra.trim();
  return own + (own && extra ? '\n' : '') + (extra ? extra + '\n' : '');
}

// ---------------------------------------------------------------- property paths, as SPARQL writes them

/** A path as SPARQL 1.1 writes it: ex:a / ex:b, ^ex:p, ex:a | ex:b, ex:p*, ex:p+, ex:p?. */
export function pathToSparql(p: ShaclPath, name: (iri: string) => string, outer = 0): string {
  // How tightly each binds, as SPARQL's grammar has it: | then / then ^ then * + ?. A part that
  // binds less tightly than where it stands is put in brackets: (^ex:p)*, ^(ex:a / ex:b).
  const wrap = (text: string, level: number) => (outer > level ? `(${text})` : text);
  if ('iri' in p) return name(p.iri);
  if ('alternative' in p) return wrap(p.alternative.map((x) => pathToSparql(x, name, 1)).join(' | '), 0);
  if ('sequence' in p) return wrap(p.sequence.map((x) => pathToSparql(x, name, 2)).join(' / '), 1);
  if ('inverse' in p) return wrap('^' + pathToSparql(p.inverse, name, 3), 2);
  const [form, inner] = Object.entries(p)[0] as [string, ShaclPath];
  return pathToSparql(inner, name, 4) + { zeroOrMore: '*', oneOrMore: '+', zeroOrOne: '?' }[form];
}

/** Reads a path written as SPARQL does; `resolve` gives the IRI of a prefixed name or a bare name, or nothing. Throws, saying where, what does not read. */
export function sparqlToPath(text: string, resolve: (name: string) => string | undefined): ShaclPath {
  const tokens = [...text.matchAll(/\s*(<[^>]*>|[()|/^*+?]|[^\s()|/^*+?<>]+)/g)].map((m) => m[1]);
  if (tokens.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw new Error('The path has characters that are not part of a path.');
  let i = 0;
  const peek = () => tokens[i];
  const alternative = (): ShaclPath => {
    const parts = [sequence()];
    while (peek() === '|') {
      i++;
      parts.push(sequence());
    }
    return parts.length === 1 ? parts[0] : { alternative: parts };
  };
  const sequence = (): ShaclPath => {
    const parts = [unary()];
    while (peek() === '/') {
      i++;
      parts.push(unary());
    }
    return parts.length === 1 ? parts[0] : { sequence: parts };
  };
  const unary = (): ShaclPath => {
    if (peek() === '^') {
      i++;
      return { inverse: unary() };
    }
    let p = primary();
    for (let op = peek(); op === '*' || op === '+' || op === '?'; op = peek()) {
      i++;
      p = op === '*' ? { zeroOrMore: p } : op === '+' ? { oneOrMore: p } : { zeroOrOne: p };
    }
    return p;
  };
  const primary = (): ShaclPath => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('The path ends where a property was expected.');
    if (t === '(') {
      const p = alternative();
      if (tokens[i++] !== ')') throw new Error('A closing ) is missing.');
      return p;
    }
    if (t.startsWith('<')) return { iri: t.slice(1, -1) };
    const iri = resolve(t);
    if (!iri) throw new Error(`“${t}” is not a property this model knows, nor a prefixed name.`);
    return { iri };
  };
  if (!text.trim()) throw new Error('The path is empty.');
  const p = alternative();
  if (i < tokens.length) throw new Error(`Nothing more was expected here: “${tokens[i]}”.`);
  return p;
}

/** Every IRI a path goes by. */
export const pathIris = (p: ShaclPath): string[] =>
  'iri' in p ? [p.iri] : 'sequence' in p ? p.sequence.flatMap(pathIris) : 'alternative' in p ? p.alternative.flatMap(pathIris) : pathIris(Object.values(p)[0] as ShaclPath);

// ---------------------------------------------------------------- following the model

/** A value with its IRIs renamed where `changed` says. */
function renamedValue(v: ShaclValue, changed: Map<string, string>): ShaclValue {
  if ('iri' in v) return changed.has(v.iri) ? { iri: changed.get(v.iri)! } : v;
  if ('lit' in v) return v.dt && changed.has(v.dt) ? { ...v, dt: changed.get(v.dt)! } : v;
  if ('list' in v) return { list: v.list.map((x) => renamedValue(x, changed)) };
  if ('path' in v) return { path: renamedPath(v.path, changed) };
  if ('ttl' in v) return { ttl: v.ttl.replace(/<([^>]*)>/g, (m, iri: string) => (changed.has(iri) ? `<${changed.get(iri)}>` : m)) };
  return v;
}
function renamedPath(p: ShaclPath, changed: Map<string, string>): ShaclPath {
  if ('iri' in p) return changed.has(p.iri) ? { iri: changed.get(p.iri)! } : p;
  if ('sequence' in p) return { sequence: p.sequence.map((x) => renamedPath(x, changed)) };
  if ('alternative' in p) return { alternative: p.alternative.map((x) => renamedPath(x, changed)) };
  const [form, inner] = Object.entries(p)[0] as [string, ShaclPath];
  return { [form]: renamedPath(inner, changed) } as ShaclPath;
}

/** Turtle with the IRIs that changed renamed, its prefixes and blank-node labels kept; the same text where none is in it. */
export function renamedTurtle(text: string, changed: Map<string, string>): string {
  if (!text.trim() || !changed.size) return text;
  const prefixes: Record<string, string> = {};
  let quads: Q[];
  try {
    quads = new Parser({ blankNodePrefix: '' }).parse(text, null, (p: string, ns: { value: string }) => {
      if (p) prefixes[p] = ns.value;
    }) as unknown as Q[];
  } catch {
    return text;
  }
  const swap = (t: T) => (t.termType === 'NamedNode' && changed.has(t.value) ? DataFactory.namedNode(changed.get(t.value)!) : t);
  if (!quads.some((q) => [q.subject, q.predicate, q.object].some((t) => t.termType === 'NamedNode' && changed.has(t.value)))) return text;
  let out = text;
  const writer = new Writer({ prefixes });
  writer.addQuads(quads.map((q) => DataFactory.quad(swap(q.subject) as never, swap(q.predicate) as never, swap(q.object) as never)) as never);
  writer.end((_e: unknown, result: string) => (out = result.trim() ? result.trim() + '\n' : ''));
  return out;
}

/** The shape sets with the IRIs that changed renamed: of entities, of shapes, in what is kept as written too. The same object where nothing changed. */
export function renamedSets(sets: ShapeSet[], changed: Map<string, string>): ShapeSet[] {
  if (!changed.size) return sets;
  let any = false;
  const next = sets.map((set) => {
    const shapes = set.shapes.map((s) => {
      const props = s.props.map((x) => {
        // The axiom a shape came from names IRIs in its text: a new IRI is the same axiom.
        const v = x.p === CW_SHAPES + 'fromAxiom' && 'lit' in x.v ? { ...x.v, lit: x.v.lit.replace(/<([^>]*)>/g, (m, iri: string) => (changed.has(iri) ? `<${changed.get(iri)}>` : m)) } : renamedValue(x.v, changed);
        const p = changed.get(x.p) ?? x.p;
        return JSON.stringify(v) === JSON.stringify(x.v) && p === x.p ? x : { p, v };
      });
      const iri = s.iri && changed.has(s.iri) ? changed.get(s.iri) : s.iri;
      return props.every((x, i) => x === s.props[i]) && iri === s.iri ? s : { ...s, ...(iri ? { iri } : {}), props };
    });
    const extra = renamedTurtle(set.extra, changed);
    if (shapes.every((s, i) => s === set.shapes[i]) && extra === set.extra) return set;
    any = true;
    return { ...set, shapes, extra };
  });
  return any ? next : sets;
}

/** Every IRI the shapes point at as a class, a node or a property, with the shape and how. */
export function shapeReferences(sets: ShapeSet[]): { iri: string; set: ShapeSet; shape: Shape; as: string }[] {
  const out: { iri: string; set: ShapeSet; shape: Shape; as: string }[] = [];
  for (const set of sets) {
    for (const shape of set.shapes) {
      for (const { p, v } of shape.props) {
        const info = PARAM.get(p);
        if (p === SH + 'path' && 'path' in v) for (const iri of pathIris(v.path)) out.push({ iri, set, shape, as: 'property path' });
        else if (info && 'iri' in v && (info.kind === 'class' || info.kind === 'property')) out.push({ iri: v.iri, set, shape, as: info.label.toLowerCase() });
        else if (info && 'list' in v && info.kind === 'properties') for (const x of v.list) if ('iri' in x) out.push({ iri: x.iri, set, shape, as: info.label.toLowerCase() });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the model's file

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function valueFrom(raw: unknown, depth = 0): ShaclValue | undefined {
  if (!raw || typeof raw !== 'object' || depth > 64) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.iri === 'string') return { iri: o.iri };
  if (typeof o.lit === 'string') return { lit: o.lit, ...(str(o.lang) ? { lang: str(o.lang) } : str(o.dt) ? { dt: str(o.dt) } : {}) };
  if (typeof o.shape === 'string') return { shape: o.shape };
  if (Array.isArray(o.list)) return { list: o.list.map((x) => valueFrom(x, depth + 1)).filter((x): x is ShaclValue => !!x) };
  if (o.path && typeof o.path === 'object') {
    const p = pathFrom(o.path, depth + 1);
    return p ? { path: p } : undefined;
  }
  if (typeof o.ttl === 'string') return { ttl: o.ttl };
  if (typeof o.blank === 'string' && /^[\w.-]+$/.test(o.blank)) return { blank: o.blank };
  return undefined;
}

function pathFrom(raw: unknown, depth = 0): ShaclPath | undefined {
  if (!raw || typeof raw !== 'object' || depth > 64) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.iri === 'string') return { iri: o.iri };
  for (const k of ['sequence', 'alternative'] as const) {
    if (Array.isArray(o[k])) {
      const parts = (o[k] as unknown[]).map((x) => pathFrom(x, depth + 1));
      return parts.length >= 2 && parts.every(Boolean) ? ({ [k]: parts } as ShaclPath) : undefined;
    }
  }
  for (const k of ['inverse', 'zeroOrMore', 'oneOrMore', 'zeroOrOne'] as const) {
    if (o[k]) {
      const inner = pathFrom(o[k], depth + 1);
      return inner ? ({ [k]: inner } as ShaclPath) : undefined;
    }
  }
  return undefined;
}

/** The shape sets of a model file of format 5, as well formed as they can be made; none for anything else. */
export function shapeSetsFrom(raw: unknown): ShapeSet[] {
  if (!Array.isArray(raw)) return [];
  const out: ShapeSet[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const shapes: Shape[] = [];
    for (const s of (Array.isArray(r.shapes) ? r.shapes : []) as Record<string, unknown>[]) {
      if (!s || typeof s !== 'object' || !str(s.id)) continue;
      const props = (Array.isArray(s.props) ? s.props : [])
        .map((x: Record<string, unknown>) => (x && typeof x === 'object' && str(x.p) ? { p: str(x.p), v: valueFrom(x.v) } : undefined))
        .filter((x): x is ShapeProp => !!x && !!x.v);
      shapes.push({ id: str(s.id), ...(str(s.iri) ? { iri: str(s.iri) } : {}), props });
    }
    const prefixes: Record<string, string> = {};
    if (r.prefixes && typeof r.prefixes === 'object') for (const [k, v] of Object.entries(r.prefixes as Record<string, unknown>)) if (typeof v === 'string') prefixes[k] = v;
    out.push({ id: str(r.id) || uid(), name: str(r.name) || 'Shapes', description: str(r.description), namespace: str(r.namespace), shapes, extra: str(r.extra), prefixes });
  }
  return out;
}

// ---------------------------------------------------------------- one term, as Turtle writes it

/** A term as Turtle writes it: a name or <IRI>, "text", "text"@en, "2020-01-01"^^xsd:date, 18, true. */
export function termToText(t: ShaclTerm, name: (iri: string) => string): string {
  if ('iri' in t) return name(t.iri);
  if (t.lang) return `${JSON.stringify(t.lit)}@${t.lang}`;
  if ((t.dt === XSD + 'integer' && /^[+-]?\d+$/.test(t.lit)) || (t.dt === XSD + 'decimal' && /^[+-]?\d*\.\d+$/.test(t.lit)) || (t.dt === XSD + 'boolean' && /^(true|false)$/.test(t.lit))) return t.lit;
  return JSON.stringify(t.lit) + (t.dt ? `^^${name(t.dt)}` : '');
}

/**
 * Reads one term written as Turtle writes it; `resolve` gives the IRI of a prefixed name or of a
 * bare name (an entity's), or nothing. Throws, saying why, what does not read.
 */
export function termFromText(text: string, resolve: (name: string) => string | undefined): ShaclTerm {
  const s = text.trim();
  if (!s) throw new Error('Nothing is written.');
  if (/^[+-]?\d+$/.test(s)) return { lit: s, dt: XSD + 'integer' };
  if (/^[+-]?\d*\.\d+$/.test(s)) return { lit: s, dt: XSD + 'decimal' };
  if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s)) return { lit: s, dt: XSD + 'double' };
  if (s === 'true' || s === 'false') return { lit: s, dt: XSD + 'boolean' };
  const quoted = /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z]+(?:-[A-Za-z0-9]+)*)|\^\^(.+))?$/.exec(s);
  if (quoted) {
    let lit: string;
    try {
      lit = JSON.parse(`"${quoted[1]}"`);
    } catch {
      throw new Error('The text in quotes has an escape that does not read.');
    }
    if (quoted[2]) return { lit, lang: quoted[2].toLowerCase() };
    if (quoted[3]) {
      const dt = quoted[3].startsWith('<') && quoted[3].endsWith('>') ? quoted[3].slice(1, -1) : resolve(quoted[3]);
      if (!dt) throw new Error(`“${quoted[3]}” is not a datatype this model knows, nor a prefixed name.`);
      return dt === XSD + 'string' ? { lit } : { lit, dt };
    }
    return { lit };
  }
  if (s.startsWith('<') && s.endsWith('>') && !/[\s<>"]/.test(s.slice(1, -1))) return { iri: s.slice(1, -1) };
  const iri = resolve(s);
  if (!iri) throw new Error(`“${s}” is neither a name this model knows, nor a prefixed name, nor a literal ("text", 18, true).`);
  return { iri };
}
