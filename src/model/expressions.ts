/**
 * OWL class expressions and data ranges, structured: the shared model of every editor of them (a
 * domain, a range, a superclass, a definition) and of reading and writing them. The names are
 * those of the OWL 2 structural specification, and entities are named by IRI, so that the OWL
 * API's objects map onto these one to one (see `functionalSyntax`). Each position has its own
 * type: a class expression, an object property expression (a property or its inverse), a data
 * property, an individual, a data range, a literal; the types do not let a class stand where a
 * datatype has to, or a data property where an object property has to. What has no structure
 * here (a construct of the file the reader does not know) is kept as the Turtle it was read as,
 * and is not edited: `Unparsed`.
 *
 * A domain or a range of a property is a list of axioms, each `rdfs:domain` or `rdfs:range`
 * statement one of its own. Two of them mean both at once (their intersection); one that is a
 * union means either. They are never merged into one another. So are a class's superclasses,
 * equivalent classes and disjoint classes that are expressions (`ClassExpressionAxiom`).
 */

export interface Literal {
  value: string;
  lang?: string;
  /** The datatype's full IRI; none for plain text. */
  datatype?: string;
}

/** Kept as read, with full IRIs: written back word for word, shown, never edited. */
export interface Unparsed {
  type: 'Unparsed';
  turtle: string;
}

export interface ObjectProperty {
  type: 'ObjectProperty';
  iri: string;
}
/** An object property, or the inverse of one (ObjectInverseOf): "inverse hasMember". */
export type ObjectPropertyExpression = ObjectProperty | { type: 'ObjectInverseOf'; property: ObjectProperty };
export interface DataProperty {
  type: 'DataProperty';
  iri: string;
}
export interface NamedIndividual {
  type: 'NamedIndividual';
  iri: string;
}

export type ClassExpression =
  | { type: 'Class'; iri: string }
  | { type: 'ObjectIntersectionOf' | 'ObjectUnionOf'; operands: ClassExpression[] }
  | { type: 'ObjectComplementOf'; operand: ClassExpression }
  | { type: 'ObjectOneOf'; individuals: NamedIndividual[] }
  | { type: 'ObjectSomeValuesFrom' | 'ObjectAllValuesFrom'; property: ObjectPropertyExpression; filler: ClassExpression }
  | { type: 'ObjectHasValue'; property: ObjectPropertyExpression; individual: NamedIndividual }
  | { type: 'ObjectHasSelf'; property: ObjectPropertyExpression }
  | { type: 'ObjectMinCardinality' | 'ObjectMaxCardinality' | 'ObjectExactCardinality'; n: number; property: ObjectPropertyExpression; filler?: ClassExpression }
  | { type: 'DataSomeValuesFrom' | 'DataAllValuesFrom'; property: DataProperty; filler: DataRange }
  | { type: 'DataHasValue'; property: DataProperty; value: Literal }
  | { type: 'DataMinCardinality' | 'DataMaxCardinality' | 'DataExactCardinality'; n: number; property: DataProperty; filler?: DataRange }
  | Unparsed;

export const objectProperty = (iri: string): ObjectProperty => ({ type: 'ObjectProperty', iri });
export const dataProperty = (iri: string): DataProperty => ({ type: 'DataProperty', iri });
export const individual = (iri: string): NamedIndividual => ({ type: 'NamedIndividual', iri });
/** The property an object property expression is, or is the inverse of. */
export const namedProperty = (p: ObjectPropertyExpression | DataProperty): string => (p.type === 'ObjectInverseOf' ? p.property.iri : p.iri);

export type DataRange =
  | { type: 'Datatype'; iri: string }
  | { type: 'DataIntersectionOf' | 'DataUnionOf'; operands: DataRange[] }
  | { type: 'DataComplementOf'; operand: DataRange }
  | { type: 'DataOneOf'; literals: Literal[] }
  | { type: 'DatatypeRestriction'; datatype: string; facets: { facet: string; value: Literal }[] }
  /**
   * One of the model's enumerated datatypes, by its id: written as its IRI where it has one, and
   * in place (a list of its values) where it has none. Its values are edited where it is defined.
   */
  | { type: 'Enumeration'; datatype: string }
  | Unparsed;

/** One rdfs:domain or rdfs:range statement: its own id, which edits name, and what it says. */
export interface ClassAxiom {
  id: string;
  expression: ClassExpression;
}
export interface DataRangeAxiom {
  id: string;
  range: DataRange;
}

/**
 * What an axiom of a class says of it with an expression: that the class is a subclass of it
 * (SubClassOf), the same class as it (EquivalentClasses), or has no member in common with it
 * (DisjointClasses). The three are never the same statement, and never merged.
 */
export type ClassAxiomKind = 'SubClassOf' | 'EquivalentClasses' | 'DisjointClasses';
export const CLASS_AXIOM_KINDS: ClassAxiomKind[] = ['SubClassOf', 'EquivalentClasses', 'DisjointClasses'];
/** One such axiom of a class: rdfs:subClassOf, owl:equivalentClass or owl:disjointWith and an expression. */
export interface ClassExpressionAxiom {
  id: string;
  kind: ClassAxiomKind;
  expression: ClassExpression;
}

import { Parser } from 'n3';

export const OWL = 'http://www.w3.org/2002/07/owl#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The predicate each kind of class axiom is written with in RDF. */
export const CLASS_AXIOM_PREDICATE: Record<ClassAxiomKind, string> = { SubClassOf: RDFS + 'subClassOf', EquivalentClasses: OWL + 'equivalentClass', DisjointClasses: OWL + 'disjointWith' };

// ---------------------------------------------------------------- reading from RDF

export interface RdfTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

/** What the reader needs of a graph: the objects of a node and predicate, and what a property is. */
export interface Graph {
  objects(node: RdfTerm, predicate: string): RdfTerm[];
  /** Every predicate of a node with its objects. */
  predicates(node: RdfTerm): Map<string, RdfTerm[]>;
  /** Whether a property is an object or a data property, where the graph says. */
  kind(property: string): 'object' | 'data' | undefined;
}

const RESTRICTION_KEYS = ['onProperty', 'someValuesFrom', 'allValuesFrom', 'hasValue', 'hasSelf', 'minCardinality', 'maxCardinality', 'cardinality', 'minQualifiedCardinality', 'maxQualifiedCardinality', 'qualifiedCardinality', 'onClass', 'onDataRange'].map((k) => OWL + k);

/** The items of an RDF list, if it is a proper one: every cell with one item and one rest, ending in nil. */
function listOf(g: Graph, head: RdfTerm | undefined): RdfTerm[] | undefined {
  const items: RdfTerm[] = [];
  const seen = new Set<string>();
  for (let cell = head; cell; ) {
    if (cell.termType === 'NamedNode' && cell.value === RDF + 'nil') return items;
    if (cell.termType !== 'BlankNode' || seen.has(cell.value)) return undefined;
    seen.add(cell.value);
    const own = g.predicates(cell);
    const first = own.get(RDF + 'first') ?? [];
    const rest = own.get(RDF + 'rest') ?? [];
    if (first.length !== 1 || rest.length !== 1 || [...own.keys()].some((p) => p !== RDF + 'first' && p !== RDF + 'rest')) return undefined;
    items.push(first[0]);
    cell = rest[0];
  }
  return undefined;
}

const literalOf = (t: RdfTerm): Literal => {
  const dt = t.datatype?.value;
  return { value: t.value, ...(t.language ? { lang: t.language } : dt && dt !== XSD + 'string' && dt !== RDF + 'langString' ? { datatype: dt } : {}) };
};

/** A node as canonical Turtle with full IRIs: blank nodes and lists written in place. */
export function turtleOf(g: Graph, t: RdfTerm, seen = new Set<string>()): string {
  if (t.termType === 'NamedNode') return t.value === RDF + 'nil' ? '()' : `<${t.value}>`;
  if (t.termType === 'Literal') {
    const l = literalOf(t);
    return JSON.stringify(l.value) + (l.lang ? '@' + l.lang : l.datatype ? `^^<${l.datatype}>` : '');
  }
  if (seen.has(t.value)) return '[]';
  seen.add(t.value);
  const items = listOf(g, t);
  if (items) return `( ${items.map((x) => turtleOf(g, x, seen)).join(' ')} )`;
  const parts = [...g.predicates(t)].flatMap(([p, os]) => os.map((o) => `<${p}> ${turtleOf(g, o, seen)}`)).sort();
  return parts.length ? `[ ${parts.join(' ; ')} ]` : '[]';
}

const unparsed = (g: Graph, t: RdfTerm): Unparsed => ({ type: 'Unparsed', turtle: turtleOf(g, t) });

/** Only these predicates (and an rdf:type among `types`) on a blank node. */
function only(g: Graph, t: RdfTerm, preds: string[], types: string[] = []): boolean {
  for (const [p, os] of g.predicates(t)) {
    if (preds.includes(p)) continue;
    if (p === RDF + 'type' && os.every((o) => types.includes(o.value))) continue;
    return false;
  }
  return true;
}

const single = (g: Graph, t: RdfTerm, p: string): RdfTerm | undefined => {
  const os = g.objects(t, p);
  return os.length === 1 ? os[0] : undefined;
};

/** A class expression as the graph states it; Unparsed for what has no structure here. */
export function readClass(g: Graph, t: RdfTerm): ClassExpression {
  if (t.termType === 'NamedNode') return { type: 'Class', iri: t.value };
  if (t.termType !== 'BlankNode') return unparsed(g, t);
  const preds = g.predicates(t);
  const CLASS = [OWL + 'Class', RDFS + 'Class'];
  for (const [key, type] of [['intersectionOf', 'ObjectIntersectionOf'], ['unionOf', 'ObjectUnionOf']] as const) {
    if (!preds.has(OWL + key)) continue;
    const items = only(g, t, [OWL + key], CLASS) ? listOf(g, single(g, t, OWL + key)) : undefined;
    if (!items || items.length < 2) return unparsed(g, t);
    return { type, operands: items.map((x) => readClass(g, x)) };
  }
  if (preds.has(OWL + 'complementOf')) {
    const x = only(g, t, [OWL + 'complementOf'], CLASS) ? single(g, t, OWL + 'complementOf') : undefined;
    return x ? { type: 'ObjectComplementOf', operand: readClass(g, x) } : unparsed(g, t);
  }
  if (preds.has(OWL + 'oneOf')) {
    const items = only(g, t, [OWL + 'oneOf'], CLASS) ? listOf(g, single(g, t, OWL + 'oneOf')) : undefined;
    return items?.length && items.every((x) => x.termType === 'NamedNode') ? { type: 'ObjectOneOf', individuals: items.map((x) => individual(x.value)) } : unparsed(g, t);
  }
  if (preds.has(OWL + 'onProperty')) return readRestriction(g, t) ?? unparsed(g, t);
  return unparsed(g, t);
}

/** The property a restriction is on: one by name, or the inverse of one (a blank node with owl:inverseOf and nothing else). */
function onProperty(g: Graph, prop: RdfTerm | undefined): { iri: string; inverse: boolean } | undefined {
  if (prop?.termType === 'NamedNode') return { iri: prop.value, inverse: false };
  if (prop?.termType !== 'BlankNode' || !only(g, prop, [OWL + 'inverseOf'], [OWL + 'ObjectProperty'])) return undefined;
  const of = single(g, prop, OWL + 'inverseOf');
  return of?.termType === 'NamedNode' ? { iri: of.value, inverse: true } : undefined;
}

function readRestriction(g: Graph, t: RdfTerm): ClassExpression | undefined {
  if (!only(g, t, RESTRICTION_KEYS, [OWL + 'Restriction'])) return undefined;
  const on = onProperty(g, single(g, t, OWL + 'onProperty'));
  if (!on) return undefined;
  const iri = on.iri;
  const has = (k: string) => g.objects(t, OWL + k).length > 0;
  const one = (k: string) => single(g, t, OWL + k);
  // Object or data: as the graph declares the property, or else by what the filler is.
  const filler = one('someValuesFrom') ?? one('allValuesFrom') ?? one('onClass') ?? one('onDataRange');
  const dataFiller = (x: RdfTerm | undefined) => !!x && ((x.termType === 'NamedNode' && (x.value.startsWith(XSD) || x.value === RDFS + 'Literal' || x.value === RDF + 'langString')) || (x.termType === 'BlankNode' && g.objects(x, RDF + 'type').some((o) => o.value === RDFS + 'Datatype')));
  // An inverse is of an object property, always.
  const data = !on.inverse && (g.kind(iri) === 'data' || (g.kind(iri) === undefined && (dataFiller(filler) || has('onDataRange') || one('hasValue')?.termType === 'Literal')));
  const property: ObjectPropertyExpression = on.inverse ? { type: 'ObjectInverseOf', property: objectProperty(iri) } : objectProperty(iri);
  const dp = dataProperty(iri);
  const count = (k: string): number | undefined => {
    const n = one(k);
    return n?.termType === 'Literal' && /^\d+$/.test(n.value) ? Number(n.value) : undefined;
  };
  const fields = [...g.predicates(t).keys()].filter((p) => p !== RDF + 'type' && p !== OWL + 'onProperty');
  if (fields.length === 1 && has('someValuesFrom')) return data ? { type: 'DataSomeValuesFrom', property: dp, filler: readDataRange(g, one('someValuesFrom')!) } : { type: 'ObjectSomeValuesFrom', property, filler: readClass(g, one('someValuesFrom')!) };
  if (fields.length === 1 && has('allValuesFrom')) return data ? { type: 'DataAllValuesFrom', property: dp, filler: readDataRange(g, one('allValuesFrom')!) } : { type: 'ObjectAllValuesFrom', property, filler: readClass(g, one('allValuesFrom')!) };
  if (fields.length === 1 && has('hasValue')) {
    const v = one('hasValue')!;
    if (v.termType === 'Literal') return data ? { type: 'DataHasValue', property: dp, value: literalOf(v) } : undefined;
    return v.termType === 'NamedNode' && !data ? { type: 'ObjectHasValue', property, individual: individual(v.value) } : undefined;
  }
  // owl:hasSelf takes true, and only true.
  if (fields.length === 1 && has('hasSelf') && !data && one('hasSelf')?.termType === 'Literal' && /^(true|1)$/.test(one('hasSelf')!.value)) return { type: 'ObjectHasSelf', property };
  const kinds = [['min', 'minCardinality', 'minQualifiedCardinality'], ['max', 'maxCardinality', 'maxQualifiedCardinality'], ['exact', 'cardinality', 'qualifiedCardinality']] as const;
  for (const [which, plain, qualified] of kinds) {
    const name = (which === 'min' ? 'Min' : which === 'max' ? 'Max' : 'Exact') + 'Cardinality';
    if (fields.length === 1 && has(plain) && count(plain) !== undefined) return (data ? { type: 'Data' + name, n: count(plain)!, property: dp } : { type: 'Object' + name, n: count(plain)!, property }) as ClassExpression;
    if (fields.length === 2 && has(qualified) && count(qualified) !== undefined) {
      const f = data ? one('onDataRange') : one('onClass');
      if (!f) return undefined;
      return data ? ({ type: 'Data' + name, n: count(qualified)!, property: dp, filler: readDataRange(g, f) } as ClassExpression) : ({ type: 'Object' + name, n: count(qualified)!, property, filler: readClass(g, f) } as ClassExpression);
    }
  }
  return undefined;
}

/** A data range as the graph states it; Unparsed for what has no structure here. */
export function readDataRange(g: Graph, t: RdfTerm): DataRange {
  if (t.termType === 'NamedNode') return { type: 'Datatype', iri: t.value };
  if (t.termType !== 'BlankNode') return unparsed(g, t);
  const preds = g.predicates(t);
  const DT = [RDFS + 'Datatype'];
  for (const [key, type] of [['intersectionOf', 'DataIntersectionOf'], ['unionOf', 'DataUnionOf']] as const) {
    if (!preds.has(OWL + key)) continue;
    const items = only(g, t, [OWL + key], DT) ? listOf(g, single(g, t, OWL + key)) : undefined;
    if (!items || items.length < 2) return unparsed(g, t);
    return { type, operands: items.map((x) => readDataRange(g, x)) };
  }
  if (preds.has(OWL + 'datatypeComplementOf')) {
    const x = only(g, t, [OWL + 'datatypeComplementOf'], DT) ? single(g, t, OWL + 'datatypeComplementOf') : undefined;
    return x ? { type: 'DataComplementOf', operand: readDataRange(g, x) } : unparsed(g, t);
  }
  if (preds.has(OWL + 'oneOf')) {
    const items = only(g, t, [OWL + 'oneOf'], DT) ? listOf(g, single(g, t, OWL + 'oneOf')) : undefined;
    return items?.length && items.every((x) => x.termType === 'Literal') ? { type: 'DataOneOf', literals: items.map(literalOf) } : unparsed(g, t);
  }
  if (preds.has(OWL + 'onDatatype')) {
    const on = only(g, t, [OWL + 'onDatatype', OWL + 'withRestrictions'], DT) ? single(g, t, OWL + 'onDatatype') : undefined;
    const facets = listOf(g, single(g, t, OWL + 'withRestrictions'));
    if (on?.termType !== 'NamedNode' || !facets?.length) return unparsed(g, t);
    const read: { facet: string; value: Literal }[] = [];
    for (const f of facets) {
      const own = f.termType === 'BlankNode' ? [...g.predicates(f)] : [];
      if (own.length !== 1 || own[0][1].length !== 1 || own[0][1][0].termType !== 'Literal') return unparsed(g, t);
      read.push({ facet: own[0][0], value: literalOf(own[0][1][0]) });
    }
    return { type: 'DatatypeRestriction', datatype: on.value, facets: read };
  }
  return unparsed(g, t);
}

// ---------------------------------------------------------------- walking expressions

/** An IRI in angle brackets, or a literal in double quotes (which an IRI-like text inside is part of). */
const IRI_OR_TEXT = /"(?:[^"\\]|\\.)*"|<([^<>\s]*)>/g;

/**
 * Turtle kept as read with each IRI in it written another way: `as` gives what to write for an
 * IRI (in angle brackets, or a prefixed name), or nothing to leave it. Text in literals is left alone.
 */
export const withIrisIn = (turtle: string, as: (iri: string) => string | undefined, bracket = true): string =>
  turtle.replace(IRI_OR_TEXT, (all, iri: string | undefined) => {
    const to = iri === undefined ? undefined : as(iri);
    return to === undefined ? all : bracket ? `<${to}>` : to;
  });

/** Every IRI an expression names, the properties included. */
export function irisOf(e: ClassExpression | DataRange): string[] {
  switch (e.type) {
    case 'Class':
    case 'Datatype':
      return [e.iri];
    case 'ObjectIntersectionOf':
    case 'ObjectUnionOf':
      return e.operands.flatMap(irisOf);
    case 'DataIntersectionOf':
    case 'DataUnionOf':
      return e.operands.flatMap(irisOf);
    case 'ObjectComplementOf':
    case 'DataComplementOf':
      return irisOf(e.operand);
    case 'ObjectOneOf':
      return e.individuals.map((i) => i.iri);
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return [namedProperty(e.property), ...irisOf(e.filler)];
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom':
      return [namedProperty(e.property), ...irisOf(e.filler)];
    case 'ObjectHasValue':
      return [namedProperty(e.property), e.individual.iri];
    case 'ObjectHasSelf':
    case 'DataHasValue':
      return [namedProperty(e.property)];
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return [namedProperty(e.property), ...(e.filler ? irisOf(e.filler) : [])];
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return [namedProperty(e.property), ...(e.filler ? irisOf(e.filler) : [])];
    case 'DatatypeRestriction':
      return [e.datatype];
    case 'DataOneOf':
    case 'Enumeration':
      return [];
    case 'Unparsed':
      return [...e.turtle.matchAll(IRI_OR_TEXT)].filter((x) => x[1] !== undefined).map((x) => x[1]);
  }
}

/** The expression with IRIs changed (old → new). The same object when none of them is in it. */
export function renamed<T extends ClassExpression | DataRange>(e: T, changed: Map<string, string>): T {
  if (!changed.size || !irisOf(e).some((iri) => changed.has(iri))) return e;
  const iri = (x: string) => changed.get(x) ?? x;
  const op = (p: ObjectPropertyExpression): ObjectPropertyExpression => (p.type === 'ObjectInverseOf' ? { ...p, property: objectProperty(iri(p.property.iri)) } : objectProperty(iri(p.iri)));
  const dp = (p: DataProperty): DataProperty => dataProperty(iri(p.iri));
  const c = (x: ClassExpression) => renamed(x, changed);
  const d = (x: DataRange) => renamed(x, changed);
  const x = e as ClassExpression | DataRange;
  switch (x.type) {
    case 'Class':
    case 'Datatype':
      return { ...x, iri: iri(x.iri) } as T;
    case 'ObjectIntersectionOf':
    case 'ObjectUnionOf':
      return { ...x, operands: x.operands.map(c) } as T;
    case 'DataIntersectionOf':
    case 'DataUnionOf':
      return { ...x, operands: x.operands.map(d) } as T;
    case 'ObjectComplementOf':
      return { ...x, operand: c(x.operand) } as T;
    case 'DataComplementOf':
      return { ...x, operand: d(x.operand) } as T;
    case 'ObjectOneOf':
      return { ...x, individuals: x.individuals.map((i) => individual(iri(i.iri))) } as T;
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return { ...x, property: op(x.property), filler: c(x.filler) } as T;
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom':
      return { ...x, property: dp(x.property), filler: d(x.filler) } as T;
    case 'ObjectHasValue':
      return { ...x, property: op(x.property), individual: individual(iri(x.individual.iri)) } as T;
    case 'ObjectHasSelf':
      return { ...x, property: op(x.property) } as T;
    case 'DataHasValue':
      return { ...x, property: dp(x.property) } as T;
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return { ...x, property: op(x.property), ...(x.filler ? { filler: c(x.filler) } : {}) } as T;
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return { ...x, property: dp(x.property), ...(x.filler ? { filler: d(x.filler) } : {}) } as T;
    case 'DatatypeRestriction':
      return { ...x, datatype: iri(x.datatype) } as T;
    case 'Unparsed':
      return { ...x, turtle: withIrisIn(x.turtle, (i) => changed.get(i)) } as T;
    default:
      return e;
  }
}

/**
 * Whether something that is (or is a kind of) the classes `isA` says belongs to an expression:
 * true or false where that follows from named classes, unions, intersections and complements
 * of them; undefined where it cannot be told here (a restriction, a list of individuals, an
 * expression kept as read).
 */
export function fits(e: ClassExpression, isA: (classIri: string) => boolean): boolean | undefined {
  switch (e.type) {
    case 'Class':
      return e.iri === OWL + 'Thing' || isA(e.iri);
    case 'ObjectUnionOf': {
      const each = e.operands.map((x) => fits(x, isA));
      return each.includes(true) ? true : each.includes(undefined) ? undefined : false;
    }
    case 'ObjectIntersectionOf': {
      const each = e.operands.map((x) => fits(x, isA));
      return each.includes(false) ? false : each.includes(undefined) ? undefined : true;
    }
    default:
      return undefined;
  }
}

/** The named classes an expression is a union or an intersection of (or is): those it is about, as a domain or range. */
export function namedClasses(e: ClassExpression): string[] {
  if (e.type === 'Class') return [e.iri];
  return e.type === 'ObjectUnionOf' || e.type === 'ObjectIntersectionOf' ? e.operands.flatMap(namedClasses) : [];
}

/** The named classes that whatever is in an expression belongs to, for certain: it, or every class it is an intersection of. */
export function impliedClasses(e: ClassExpression): string[] {
  if (e.type === 'Class') return [e.iri];
  return e.type === 'ObjectIntersectionOf' ? e.operands.flatMap(impliedClasses) : [];
}

/** The named classes an expression is made of, where it is nothing but a class or a union of classes. */
export function classesOfUnion(e: ClassExpression): string[] | undefined {
  if (e.type === 'Class') return [e.iri];
  if (e.type === 'ObjectUnionOf' && e.operands.every((x) => x.type === 'Class')) return e.operands.map((x) => (x as { iri: string }).iri);
  return undefined;
}

/** The parts of an expression kept as they were read (Unparsed), as their Turtle. */
export function unparsedIn(e: ClassExpression | DataRange): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.type === 'Unparsed' && typeof o.turtle === 'string') out.push(o.turtle);
      else Object.values(o).forEach(walk);
    }
  };
  walk(e);
  return out;
}

/** The same expression? Structure, not text: lists of operands are compared as written. */
export const same = (a: ClassExpression | DataRange, b: ClassExpression | DataRange): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The expression without what names any of `iris` (entities that are deleted): an operand of a
 * union or an intersection goes, and the rest stays (one left is that one); anything else that
 * names one goes as a whole. Undefined when nothing is left. The same object when it names none.
 */
export function without<T extends ClassExpression | DataRange>(e: T, iris: Set<string>, enums: Set<string> = new Set()): T | undefined {
  const names = (x: ClassExpression | DataRange): boolean => irisOf(x).some((i) => iris.has(i)) || enumsOf(x).some((d) => enums.has(d));
  if (!names(e)) return e;
  const x = e as ClassExpression | DataRange;
  if (x.type === 'ObjectUnionOf' || x.type === 'ObjectIntersectionOf' || x.type === 'DataUnionOf' || x.type === 'DataIntersectionOf') {
    const left = (x.operands as (ClassExpression | DataRange)[]).map((o) => without(o, iris, enums)).filter((o) => o !== undefined);
    if (!left.length) return undefined;
    return (left.length === 1 ? left[0] : { ...x, operands: left }) as T;
  }
  return undefined;
}

/** The enumerated datatypes of the model (by id) an expression names. */
export function enumsOf(e: ClassExpression | DataRange): string[] {
  switch (e.type) {
    case 'Enumeration':
      return [e.datatype];
    case 'DataUnionOf':
    case 'DataIntersectionOf':
      return e.operands.flatMap(enumsOf);
    case 'DataComplementOf':
      return enumsOf(e.operand);
    case 'ObjectUnionOf':
    case 'ObjectIntersectionOf':
      return e.operands.flatMap(enumsOf);
    case 'ObjectComplementOf':
      return enumsOf(e.operand);
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return enumsOf(e.filler);
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom':
      return enumsOf(e.filler);
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return e.filler ? enumsOf(e.filler) : [];
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return e.filler ? enumsOf(e.filler) : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- from saved JSON

const MAX_DEPTH = 64;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const literalFrom = (v: unknown): Literal | undefined => {
  if (!v || typeof v !== 'object' || typeof (v as Literal).value !== 'string') return undefined;
  const l = v as Literal;
  return { value: l.value, ...(isStr(l.lang) ? { lang: l.lang } : isStr(l.datatype) ? { datatype: l.datatype } : {}) };
};
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
// A property or an individual as saved; an IRI on its own is how format 3 saved one before they had types of their own.
const iriIn = (v: unknown, type: string): string | undefined => (isStr(v) ? v : v && typeof v === 'object' && (v as { type?: unknown }).type === type && isStr((v as { iri?: unknown }).iri) ? (v as { iri: string }).iri : undefined);
const objectPropertyFrom = (v: unknown): ObjectPropertyExpression | undefined => {
  if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'ObjectInverseOf') {
    const of = iriIn((v as { property?: unknown }).property, 'ObjectProperty');
    return of ? { type: 'ObjectInverseOf', property: objectProperty(of) } : undefined;
  }
  const iri = iriIn(v, 'ObjectProperty');
  return iri ? objectProperty(iri) : undefined;
};
const dataPropertyFrom = (v: unknown): DataProperty | undefined => {
  const iri = iriIn(v, 'DataProperty');
  return iri ? dataProperty(iri) : undefined;
};
const individualFrom = (v: unknown): NamedIndividual | undefined => {
  const iri = iriIn(v, 'NamedIndividual');
  return iri ? individual(iri) : undefined;
};

/** A class expression from untrusted JSON (a saved model): checked part by part. Undefined if anything in it is not well formed. */
export function classExpressionFrom(raw: unknown, depth = 0): ClassExpression | undefined {
  if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH) return undefined;
  const o = raw as Record<string, unknown>;
  const sub = (v: unknown) => classExpressionFrom(v, depth + 1);
  const data = (v: unknown) => dataRangeFrom(v, depth + 1);
  switch (o.type) {
    case 'Class':
      return isStr(o.iri) ? { type: 'Class', iri: o.iri } : undefined;
    case 'ObjectIntersectionOf':
    case 'ObjectUnionOf': {
      const operands = Array.isArray(o.operands) ? o.operands.map(sub) : [];
      return operands.length >= 2 && operands.every((x) => x) ? { type: o.type, operands: operands as ClassExpression[] } : undefined;
    }
    case 'ObjectComplementOf': {
      const operand = sub(o.operand);
      return operand && { type: 'ObjectComplementOf', operand };
    }
    case 'ObjectOneOf': {
      const individuals = Array.isArray(o.individuals) ? o.individuals.map(individualFrom) : [];
      return individuals.length && individuals.every((x) => x) ? { type: 'ObjectOneOf', individuals: individuals as NamedIndividual[] } : undefined;
    }
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom': {
      const filler = sub(o.filler);
      const property = objectPropertyFrom(o.property);
      return property && filler ? { type: o.type, property, filler } : undefined;
    }
    case 'ObjectHasValue': {
      const property = objectPropertyFrom(o.property);
      const one = individualFrom(o.individual);
      return property && one ? { type: 'ObjectHasValue', property, individual: one } : undefined;
    }
    case 'ObjectHasSelf': {
      const property = objectPropertyFrom(o.property);
      return property && { type: 'ObjectHasSelf', property };
    }
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality': {
      const filler = o.filler === undefined ? undefined : sub(o.filler);
      const property = objectPropertyFrom(o.property);
      if (!property || count(o.n) === undefined || (o.filler !== undefined && !filler)) return undefined;
      return { type: o.type, n: count(o.n)!, property, ...(filler ? { filler } : {}) };
    }
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom': {
      const filler = data(o.filler);
      const property = dataPropertyFrom(o.property);
      return property && filler ? { type: o.type, property, filler } : undefined;
    }
    case 'DataHasValue': {
      const value = literalFrom(o.value);
      const property = dataPropertyFrom(o.property);
      return property && value ? { type: 'DataHasValue', property, value } : undefined;
    }
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality': {
      const filler = o.filler === undefined ? undefined : data(o.filler);
      const property = dataPropertyFrom(o.property);
      if (!property || count(o.n) === undefined || (o.filler !== undefined && !filler)) return undefined;
      return { type: o.type, n: count(o.n)!, property, ...(filler ? { filler } : {}) };
    }
    case 'Unparsed':
      return isStr(o.turtle) ? { type: 'Unparsed', turtle: o.turtle } : undefined;
    default:
      return undefined;
  }
}

/** A data range from untrusted JSON. `enums`: the ids of the model's enumerated datatypes, the only ones an Enumeration can name. */
export function dataRangeFrom(raw: unknown, depth = 0, enums?: Set<string>): DataRange | undefined {
  if (!raw || typeof raw !== 'object' || depth > MAX_DEPTH) return undefined;
  const o = raw as Record<string, unknown>;
  const sub = (v: unknown) => dataRangeFrom(v, depth + 1, enums);
  switch (o.type) {
    case 'Datatype':
      return isStr(o.iri) ? { type: 'Datatype', iri: o.iri } : undefined;
    case 'DataIntersectionOf':
    case 'DataUnionOf': {
      const operands = Array.isArray(o.operands) ? o.operands.map(sub) : [];
      return operands.length >= 2 && operands.every((x) => x) ? { type: o.type, operands: operands as DataRange[] } : undefined;
    }
    case 'DataComplementOf': {
      const operand = sub(o.operand);
      return operand && { type: 'DataComplementOf', operand };
    }
    case 'DataOneOf': {
      const literals = Array.isArray(o.literals) ? o.literals.map(literalFrom) : [];
      return literals.length && literals.every((x) => x) ? { type: 'DataOneOf', literals: literals as Literal[] } : undefined;
    }
    case 'DatatypeRestriction': {
      const facets = Array.isArray(o.facets) ? (o.facets as Record<string, unknown>[]).map((f) => (f && isStr(f.facet) && literalFrom(f.value) ? { facet: f.facet, value: literalFrom(f.value)! } : undefined)) : [];
      return isStr(o.datatype) && facets.length && facets.every((x) => x) ? { type: 'DatatypeRestriction', datatype: o.datatype, facets: facets as { facet: string; value: Literal }[] } : undefined;
    }
    case 'Enumeration':
      return isStr(o.datatype) && (!enums || enums.has(o.datatype)) ? { type: 'Enumeration', datatype: o.datatype } : undefined;
    case 'Unparsed':
      return isStr(o.turtle) ? { type: 'Unparsed', turtle: o.turtle } : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- datatypes by their short names

const KEY_NS: [string, string][] = [
  ['xsd:', XSD],
  ['rdf:', RDF],
  ['rdfs:', RDFS],
  ['owl:', OWL],
];

/**
 * A datatype from the name it is chosen by in a list: "xsd:date", "rdf:langString", an
 * enumerated datatype of the model as "enum:" and its id, any other as its IRI in angle brackets.
 * This was how a data property's range was stored before model format 3.
 */
export function rangeOfKey(key: string): DataRange | undefined {
  if (key.startsWith('enum:')) return key.length > 5 ? { type: 'Enumeration', datatype: key.slice(5) } : undefined;
  for (const [p, ns] of KEY_NS) if (key.startsWith(p) && /^[A-Za-z][\w-]*$/.test(key.slice(p.length))) return { type: 'Datatype', iri: ns + key.slice(p.length) };
  return /^<[^<>\s]+>$/.test(key) ? { type: 'Datatype', iri: key.slice(1, -1) } : undefined;
}

/** The other way round: the name a datatype is chosen by. Undefined for anything that is not a datatype. */
export function keyOfRange(r: DataRange): string | undefined {
  if (r.type === 'Enumeration') return 'enum:' + r.datatype;
  if (r.type !== 'Datatype') return undefined;
  for (const [p, ns] of KEY_NS) if (r.iri.startsWith(ns) && /^[A-Za-z][\w-]*$/.test(r.iri.slice(ns.length))) return p + r.iri.slice(ns.length);
  return `<${r.iri}>`;
}

// ---------------------------------------------------------------- from Turtle text

interface Quad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
}

/** A graph over parsed triples, for reading expressions from it. */
export function graphOf(quads: Quad[], kind: Graph['kind'] = () => undefined): Graph {
  const k = (t: RdfTerm) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  const spo = new Map<string, Map<string, RdfTerm[]>>();
  for (const q of quads) {
    const s = spo.get(k(q.subject)) ?? spo.set(k(q.subject), new Map()).get(k(q.subject))!;
    s.set(q.predicate.value, [...(s.get(q.predicate.value) ?? []), q.object]);
  }
  return { objects: (t, p) => spo.get(k(t))?.get(p) ?? [], predicates: (t) => spo.get(k(t)) ?? new Map(), kind };
}

export const WELL_KNOWN = `@prefix owl: <${OWL}> .\n@prefix rdf: <${RDF}> .\n@prefix rdfs: <${RDFS}> .\n@prefix xsd: <${XSD}> .\n@prefix skos: <http://www.w3.org/2004/02/skos/core#> .\n`;

/**
 * An expression written as Turtle (the object of a statement, with the prefixes owl, rdf, rdfs,
 * xsd and skos, or full IRIs): as a class expression or as a data range. Undefined if it is not
 * Turtle at all. Models before format 3 kept a data range written in place as such text.
 */
export function expressionOfTurtle(text: string, as: 'class'): ClassExpression | undefined;
export function expressionOfTurtle(text: string, as: 'data'): DataRange | undefined;
export function expressionOfTurtle(text: string, as: 'class' | 'data'): ClassExpression | DataRange | undefined {
  let quads: Quad[];
  try {
    quads = new Parser().parse(`${WELL_KNOWN}<urn:x:s> <urn:x:p> ${text} .`) as unknown as Quad[];
  } catch {
    return undefined;
  }
  const top = quads.filter((q) => q.subject.value === 'urn:x:s' && q.predicate.value === 'urn:x:p');
  if (top.length !== 1) return undefined;
  const g = graphOf(quads);
  return as === 'class' ? readClass(g, top[0].object) : readDataRange(g, top[0].object);
}

// ---------------------------------------------------------------- OWL functional syntax

const fsLiteral = (l: Literal) => `"${l.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${l.lang ? '@' + l.lang : l.datatype ? `^^<${l.datatype}>` : ''}`;
const fsProperty = (p: ObjectPropertyExpression | DataProperty) => (p.type === 'ObjectInverseOf' ? `ObjectInverseOf(<${p.property.iri}>)` : `<${p.iri}>`);

/**
 * An expression in OWL 2 functional-style syntax, with full IRIs: the form the OWL API reads and
 * writes, and the contract with a backend that holds ontologies as OWL API objects. An
 * enumerated datatype of the model is written as `enumAs` gives it (its IRI, or its values in
 * place). Something kept as it was read has no such form: it throws.
 */
export function functionalSyntax(e: ClassExpression | DataRange, enumAs: (id: string) => DataRange | undefined = () => undefined): string {
  const f = (x: ClassExpression | DataRange): string => functionalSyntax(x, enumAs);
  switch (e.type) {
    case 'Class':
    case 'Datatype':
      return `<${e.iri}>`;
    case 'ObjectIntersectionOf':
    case 'ObjectUnionOf':
      return `${e.type}(${e.operands.map(f).join(' ')})`;
    case 'DataIntersectionOf':
    case 'DataUnionOf':
      return `${e.type}(${e.operands.map(f).join(' ')})`;
    case 'ObjectComplementOf':
    case 'DataComplementOf':
      return `${e.type}(${f(e.operand)})`;
    case 'ObjectOneOf':
      return `ObjectOneOf(${e.individuals.map((i) => `<${i.iri}>`).join(' ')})`;
    case 'ObjectSomeValuesFrom':
    case 'ObjectAllValuesFrom':
      return `${e.type}(${fsProperty(e.property)} ${f(e.filler)})`;
    case 'DataSomeValuesFrom':
    case 'DataAllValuesFrom':
      return `${e.type}(${fsProperty(e.property)} ${f(e.filler)})`;
    case 'ObjectHasValue':
      return `ObjectHasValue(${fsProperty(e.property)} <${e.individual.iri}>)`;
    case 'ObjectHasSelf':
      return `ObjectHasSelf(${fsProperty(e.property)})`;
    case 'DataHasValue':
      return `DataHasValue(${fsProperty(e.property)} ${fsLiteral(e.value)})`;
    case 'ObjectMinCardinality':
    case 'ObjectMaxCardinality':
    case 'ObjectExactCardinality':
      return `${e.type}(${e.n} ${fsProperty(e.property)}${e.filler ? ' ' + f(e.filler) : ''})`;
    case 'DataMinCardinality':
    case 'DataMaxCardinality':
    case 'DataExactCardinality':
      return `${e.type}(${e.n} ${fsProperty(e.property)}${e.filler ? ' ' + f(e.filler) : ''})`;
    case 'DataOneOf':
      return `DataOneOf(${e.literals.map(fsLiteral).join(' ')})`;
    case 'DatatypeRestriction':
      return `DatatypeRestriction(<${e.datatype}> ${e.facets.map((x) => `<${x.facet}> ${fsLiteral(x.value)}`).join(' ')})`;
    case 'Enumeration': {
      const as = enumAs(e.datatype);
      if (!as) throw new Error(`The enumerated datatype ${e.datatype} is not in the model.`);
      return f(as);
    }
    case 'Unparsed':
      throw new Error('An expression kept as it was read has no functional syntax here.');
  }
}

/** A class axiom of a class (by IRI) in OWL 2 functional-style syntax. */
export function axiomFunctionalSyntax(classIri: string, a: Pick<ClassExpressionAxiom, 'kind' | 'expression'>, enumAs?: (id: string) => DataRange | undefined): string {
  return `${a.kind}(<${classIri}> ${functionalSyntax(a.expression, enumAs)})`;
}

/** A class axiom from untrusted JSON (a saved model). Undefined if it is not well formed. */
export function classExpressionAxiomFrom(raw: unknown): Omit<ClassExpressionAxiom, 'id'> & { id?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const expression = classExpressionFrom(o.expression);
  if (!expression || !CLASS_AXIOM_KINDS.includes(o.kind as ClassAxiomKind)) return undefined;
  return { ...(isStr(o.id) ? { id: o.id } : {}), kind: o.kind as ClassAxiomKind, expression };
}
