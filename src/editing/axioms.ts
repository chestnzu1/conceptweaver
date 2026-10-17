import { Parser } from 'n3';
import { graphOf, readClass as readModelClass, readDataRange as readModelRange, type Graph, type RdfTerm } from '../model/expressions';
import { statements, type Quad, type Statement, type Term as Node } from '../model/unmapped';
import { OBJECT_PROPERTY_CHARACTERISTICS, type AnnotationValue, type Axiom, type ClassExpression, type DataProperty, type DataRange, type EntityType, type Iri, type Literal, type ObjectProperty, type ObjectPropertyCharacteristic, type ObjectPropertyExpression } from './contracts';

/**
 * Axioms as RDF statements, and statements as axioms.
 *
 * A statement is a triple with the blank nodes it reaches (unmapped.ts), which is how OWL 2
 * writes an axiom in RDF: `:Film rdfs:subClassOf [ owl:onProperty :directedBy ; … ]` is one
 * statement and one SubClassOf. What a statement is read as depends on what the ontology says its
 * IRIs are (`:p` in `:a :p :b` is an object property, a data property or an annotation property),
 * so the statements are read together with the declarations among them (`kindsOf`).
 *
 * A statement is given a typed axiom only where that axiom is written back as the very same
 * statement; anything else stays the statement it is (`Unmapped`). An axiom of a change set
 * therefore always names exactly one statement, whichever form it is in.
 */

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The OWL types that declare an entity. */
const DECLARING: Record<string, EntityType> = {
  [OWL + 'Class']: 'Class',
  [OWL + 'ObjectProperty']: 'ObjectProperty',
  [OWL + 'DatatypeProperty']: 'DataProperty',
  [OWL + 'AnnotationProperty']: 'AnnotationProperty',
  [OWL + 'NamedIndividual']: 'NamedIndividual',
  [RDFS + 'Datatype']: 'Datatype',
};
const DECLARED_AS = Object.fromEntries(Object.entries(DECLARING).map(([iri, type]) => [type, iri])) as Record<EntityType, string>;

/** The characteristics of a property, by the type that states them. Functional is either kind's. */
const CHARACTERISTIC: Record<string, ObjectPropertyCharacteristic> = {
  [OWL + 'FunctionalProperty']: 'FunctionalObjectProperty',
  [OWL + 'InverseFunctionalProperty']: 'InverseFunctionalObjectProperty',
  [OWL + 'ReflexiveProperty']: 'ReflexiveObjectProperty',
  [OWL + 'IrreflexiveProperty']: 'IrreflexiveObjectProperty',
  [OWL + 'SymmetricProperty']: 'SymmetricObjectProperty',
  [OWL + 'AsymmetricProperty']: 'AsymmetricObjectProperty',
  [OWL + 'TransitiveProperty']: 'TransitiveObjectProperty',
};
const CHARACTERISTIC_TYPE = Object.fromEntries(Object.entries(CHARACTERISTIC).map(([iri, type]) => [type, iri])) as Record<ObjectPropertyCharacteristic, string>;

/** The annotation properties OWL 2 has built in. */
const BUILT_IN_ANNOTATIONS = new Set([RDFS + 'label', RDFS + 'comment', RDFS + 'seeAlso', RDFS + 'isDefinedBy', OWL + 'deprecated', OWL + 'versionInfo', OWL + 'priorVersion', OWL + 'backwardCompatibleWith', OWL + 'incompatibleWith']);
/** Vocabularies whose properties are annotations unless the ontology declares them otherwise: as the app writes them, undeclared, and as OWL tools read them. */
const ANNOTATION_VOCABULARIES = ['http://www.w3.org/2004/02/skos/core#', 'http://purl.org/dc/terms/', 'http://purl.org/dc/elements/1.1/'];
/** Vocabularies whose terms are never an entity of an ontology. */
const RESERVED = [OWL, RDF, RDFS, XSD];
/** The classes of OWL itself, which an individual can be an instance of. */
const OWL_CLASSES = new Set([OWL + 'Thing', OWL + 'Nothing']);

/**
 * An expression as the reader reads it from RDF. The reader's types also allow an enumerated
 * datatype of the model's own, by its id, which is never read from RDF: apart from that the two
 * are the same structure, so what it reads is an expression of the contract.
 */
const readClass = (g: Graph, t: RdfTerm) => readModelClass(g, t) as ClassExpression;
const readDataRange = (g: Graph, t: RdfTerm) => readModelRange(g, t) as DataRange;

/** What the statements of an ontology say its IRIs are. */
export interface Kinds {
  /** The ontology's own IRI, where it is declared. */
  ontology?: Iri;
  /** What each IRI is declared as; an IRI may be declared as several things (punning). */
  declared: Map<Iri, Set<EntityType>>;
}

export function kindsOf(stmts: Statement[]): Kinds {
  const declared = new Map<Iri, Set<EntityType>>();
  let ontology: Iri | undefined;
  const declare = (iri: Iri, type: EntityType) => (declared.get(iri) ?? declared.set(iri, new Set()).get(iri)!).add(type);
  for (const s of stmts) {
    for (const q of s.quads) {
      if (q.predicate.value !== RDF + 'type' || q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue;
      const type = DECLARING[q.object.value];
      if (type) declare(q.subject.value, type);
      else if (q.object.value === OWL + 'Ontology') ontology ??= q.subject.value;
      // A characteristic only an object property has says what the property is.
      else if (CHARACTERISTIC[q.object.value] && q.object.value !== OWL + 'FunctionalProperty') declare(q.subject.value, 'ObjectProperty');
    }
  }
  return { ontology, declared };
}

type PropertyKind = 'object' | 'data' | 'annotation';

/** What a property is, where that is known and is one thing only. */
function propertyKind(kinds: Kinds, iri: Iri): PropertyKind | undefined {
  const d = kinds.declared.get(iri);
  const found = new Set<PropertyKind>();
  if (d?.has('ObjectProperty')) found.add('object');
  if (d?.has('DataProperty')) found.add('data');
  if (d?.has('AnnotationProperty') || BUILT_IN_ANNOTATIONS.has(iri)) found.add('annotation');
  if (!found.size && ANNOTATION_VOCABULARIES.some((ns) => iri.startsWith(ns))) found.add('annotation');
  return found.size === 1 ? [...found][0] : undefined;
}

const isA = (kinds: Kinds, iri: Iri, type: EntityType) => !!kinds.declared.get(iri)?.has(type);
const reserved = (iri: Iri) => RESERVED.some((ns) => iri.startsWith(ns));
const named = (iri: Iri): ClassExpression => ({ type: 'Class', iri });

const literalOf = (t: RdfTerm): Literal => {
  const dt = t.datatype?.value;
  return { value: t.value, ...(t.language ? { lang: t.language } : dt && dt !== XSD + 'string' && dt !== RDF + 'langString' ? { datatype: dt } : {}) };
};
const annotationValue = (t: RdfTerm): AnnotationValue | undefined => (t.termType === 'NamedNode' ? { iri: t.value } : t.termType === 'Literal' ? literalOf(t) : undefined);

/** The items of an RDF list in one statement, if it is a proper one. */
function listOf(g: Graph, head: RdfTerm | undefined): RdfTerm[] | undefined {
  const items: RdfTerm[] = [];
  for (let cell = head, steps = 0; cell && steps < 10_000; steps++) {
    if (cell.termType === 'NamedNode' && cell.value === RDF + 'nil') return items;
    if (cell.termType !== 'BlankNode') return undefined;
    const first = g.objects(cell, RDF + 'first');
    const rest = g.objects(cell, RDF + 'rest');
    if (first.length !== 1 || rest.length !== 1) return undefined;
    items.push(first[0]);
    cell = rest[0];
  }
  return undefined;
}

/** An object property expression as a chain or a key states it: a declared object property, or an inverse of one. */
function objectPropertyExpression(g: Graph, kinds: Kinds, t: RdfTerm): ObjectPropertyExpression | undefined {
  if (t.termType === 'NamedNode') return isA(kinds, t.value, 'ObjectProperty') ? { type: 'ObjectProperty', iri: t.value } : undefined;
  if (t.termType !== 'BlankNode') return undefined;
  const inverse = g.objects(t, OWL + 'inverseOf');
  if (inverse.length !== 1 || inverse[0].termType !== 'NamedNode' || !isA(kinds, inverse[0].value, 'ObjectProperty')) return undefined;
  return { type: 'ObjectInverseOf', property: { type: 'ObjectProperty', iri: inverse[0].value } };
}

/** The axiom a statement is, if it has a typed form here. */
function typedOf(s: Statement, kinds: Kinds): Axiom | undefined {
  const g = graphOf(s.quads, (p) => {
    const k = propertyKind(kinds, p);
    return k === 'object' || k === 'data' ? k : undefined;
  });
  const roots = s.quads.filter((q) => q.subject.termType === 'NamedNode');
  if (roots.length === 1) return tripleAxiom(g, kinds, roots[0].subject.value, roots[0].predicate.value, roots[0].object);
  if (roots.length) return undefined;
  // A statement about a blank node that nothing points at: n-ary disjointness and difference.
  const pointedAt = new Set(s.quads.filter((q) => q.object.termType === 'BlankNode').map((q) => q.object.value));
  const top = [...new Set(s.quads.map((q) => q.subject).filter((t) => !pointedAt.has(t.value)).map((t) => t.value))];
  if (top.length !== 1) return undefined;
  const node: RdfTerm = { termType: 'BlankNode', value: top[0] };
  const type = g.objects(node, RDF + 'type').map((t) => t.value);
  if (type.length !== 1) return undefined;
  // A negative property assertion: a blank node saying what is not the case.
  if (type[0] === OWL + 'NegativePropertyAssertion') {
    const source = g.objects(node, OWL + 'sourceIndividual');
    const property = g.objects(node, OWL + 'assertionProperty');
    const target = g.objects(node, OWL + 'targetIndividual');
    const value = g.objects(node, OWL + 'targetValue');
    const allowed = new Set([RDF + 'type', OWL + 'sourceIndividual', OWL + 'assertionProperty', OWL + 'targetIndividual', OWL + 'targetValue']);
    if (s.quads.some((q) => !allowed.has(q.predicate.value))) return undefined;
    if (source.length !== 1 || source[0].termType !== 'NamedNode' || property.length !== 1 || property[0].termType !== 'NamedNode') return undefined;
    const pk = propertyKind(kinds, property[0].value);
    if (pk === 'object' && target.length === 1 && target[0].termType === 'NamedNode' && !value.length) {
      return { type: 'NegativeObjectPropertyAssertion', property: property[0].value, source: source[0].value, target: target[0].value };
    }
    if (pk === 'data' && value.length === 1 && value[0].termType === 'Literal' && !target.length) {
      return { type: 'NegativeDataPropertyAssertion', property: property[0].value, source: source[0].value, value: literalOf(value[0]) };
    }
    return undefined;
  }
  const members = listOf(g, g.objects(node, OWL + 'members')[0]);
  if (!members || type.length !== 1) return undefined;
  if (type[0] === OWL + 'AllDisjointClasses') return { type: 'DisjointClasses', classes: members.map((m) => readClass(g, m)) };
  if (!members.every((m) => m.termType === 'NamedNode')) return undefined;
  const iris = members.map((m) => m.value);
  if (type[0] === OWL + 'AllDifferent') return { type: 'DifferentIndividuals', individuals: iris };
  if (type[0] === OWL + 'AllDisjointProperties') {
    const k = new Set(iris.map((p) => propertyKind(kinds, p)));
    return k.size === 1 && k.has('object') ? { type: 'DisjointObjectProperties', properties: iris } : k.size === 1 && k.has('data') ? { type: 'DisjointDataProperties', properties: iris } : undefined;
  }
  return undefined;
}

/** The axiom of a statement that is one triple about a named subject, with whatever its object reaches. */
function tripleAxiom(g: Graph, kinds: Kinds, s: Iri, p: Iri, o: RdfTerm): Axiom | undefined {
  const iri = o.termType === 'NamedNode' ? o.value : undefined;
  const k = propertyKind(kinds, s);
  switch (p) {
    case RDF + 'type': {
      if (iri && DECLARING[iri]) return { type: 'Declaration', entity: DECLARING[iri], iri: s };
      if (iri === OWL + 'Ontology') return { type: 'Ontology', iri: s };
      if (iri && CHARACTERISTIC[iri]) return k === 'object' ? { type: CHARACTERISTIC[iri], property: s } : k === 'data' && iri === OWL + 'FunctionalProperty' ? { type: 'FunctionalDataProperty', property: s } : undefined;
      if (iri && reserved(iri) && !OWL_CLASSES.has(iri)) return undefined;
      return { type: 'ClassAssertion', class: readClass(g, o), individual: s };
    }
    case RDFS + 'subClassOf':
      return { type: 'SubClassOf', sub: named(s), sup: readClass(g, o) };
    case OWL + 'equivalentClass':
      return isA(kinds, s, 'Datatype') ? { type: 'DatatypeDefinition', datatype: s, range: readDataRange(g, o) } : { type: 'EquivalentClasses', classes: [named(s), readClass(g, o)] };
    case OWL + 'disjointWith':
      return { type: 'DisjointClasses', classes: [named(s), readClass(g, o)] };
    case RDFS + 'subPropertyOf':
      if (!iri || k !== propertyKind(kinds, iri)) return undefined;
      return k === 'object' ? { type: 'SubObjectPropertyOf', sub: s, sup: iri } : k === 'data' ? { type: 'SubDataPropertyOf', sub: s, sup: iri } : k === 'annotation' ? { type: 'SubAnnotationPropertyOf', sub: s, sup: iri } : undefined;
    case OWL + 'inverseOf':
      return iri && k === 'object' ? { type: 'InverseObjectProperties', first: s, second: iri } : undefined;
    case OWL + 'equivalentProperty':
    case OWL + 'propertyDisjointWith': {
      if (!iri || k !== propertyKind(kinds, iri) || (k !== 'object' && k !== 'data')) return undefined;
      const which = p === OWL + 'equivalentProperty' ? 'Equivalent' : 'Disjoint';
      return { type: `${which}${k === 'object' ? 'Object' : 'Data'}Properties` as const, properties: [s, iri] };
    }
    case RDFS + 'domain':
      return k === 'object' ? { type: 'ObjectPropertyDomain', property: s, domain: readClass(g, o) } : k === 'data' ? { type: 'DataPropertyDomain', property: s, domain: readClass(g, o) } : undefined;
    case RDFS + 'range':
      return k === 'object' ? { type: 'ObjectPropertyRange', property: s, range: readClass(g, o) } : k === 'data' ? { type: 'DataPropertyRange', property: s, range: readDataRange(g, o) } : undefined;
    case OWL + 'sameAs':
      return iri ? { type: 'SameIndividual', individuals: [s, iri] } : undefined;
    case OWL + 'differentFrom':
      return iri ? { type: 'DifferentIndividuals', individuals: [s, iri] } : undefined;
    case OWL + 'propertyChainAxiom': {
      if (!isA(kinds, s, 'ObjectProperty')) return undefined;
      const items = listOf(g, o);
      if (!items?.length) return undefined;
      const chain = items.map((m) => objectPropertyExpression(g, kinds, m));
      return chain.every((x): x is ObjectPropertyExpression => x !== undefined) ? { type: 'SubPropertyChainOf', chain, sup: s } : undefined;
    }
    case OWL + 'hasKey': {
      if (!isA(kinds, s, 'Class')) return undefined;
      const items = listOf(g, o);
      if (!items?.length) return undefined;
      const properties: (ObjectProperty | DataProperty)[] = [];
      for (const m of items) {
        if (m.termType !== 'NamedNode') return undefined;
        if (isA(kinds, m.value, 'ObjectProperty')) properties.push({ type: 'ObjectProperty', iri: m.value });
        else if (isA(kinds, m.value, 'DataProperty')) properties.push({ type: 'DataProperty', iri: m.value });
        else return undefined;
      }
      return { type: 'HasKey', class: s, properties };
    }
    case OWL + 'disjointUnionOf': {
      if (!isA(kinds, s, 'Class')) return undefined;
      const items = listOf(g, o);
      return items && items.length >= 2 ? { type: 'DisjointUnion', class: s, classes: items.map((m) => readClass(g, m)) } : undefined;
    }
  }
  const pk = propertyKind(kinds, p);
  if (s === kinds.ontology) {
    if (p === OWL + 'imports') return iri ? { type: 'Import', ontology: s, iri } : undefined;
    const value = pk === 'annotation' ? annotationValue(o) : undefined;
    return value && { type: 'OntologyAnnotation', ontology: s, property: p, value };
  }
  if (pk === 'annotation') {
    const value = annotationValue(o);
    return value && { type: 'AnnotationAssertion', property: p, subject: s, value };
  }
  if (pk === 'object' && iri) return { type: 'ObjectPropertyAssertion', property: p, source: s, target: iri };
  if (pk === 'data' && o.termType === 'Literal') return { type: 'DataPropertyAssertion', property: p, source: s, value: literalOf(o) };
  return undefined;
}

/** The axiom a statement is: a typed one where that writes back as the same statement, else the statement as it is. */
export function axiomOf(s: Statement, kinds: Kinds): Axiom {
  const typed = typedOf(s, kinds);
  return typed && statementOf(typed) === s.text ? typed : { type: 'Unmapped', turtle: s.text };
}

// ---------------------------------------------------------------- writing

/** Quads for one axiom, with blank nodes of their own. */
class Writer {
  quads: Quad[] = [];
  private blanks = 0;

  iri = (value: Iri): Node => ({ termType: 'NamedNode', value });
  blank = (): Node => ({ termType: 'BlankNode', value: 'w' + this.blanks++ });
  literal = (l: Literal): Node => ({ termType: 'Literal', value: l.value, language: l.lang ?? '', datatype: { value: l.datatype ?? (l.lang ? RDF + 'langString' : XSD + 'string') } });
  add = (subject: Node, predicate: Iri, object: Node): Node => {
    this.quads.push({ subject, predicate: this.iri(predicate), object });
    return subject;
  };
  node = (type: Iri, props: [Iri, Node][]): Node => {
    const b = this.add(this.blank(), RDF + 'type', this.iri(type));
    for (const [p, o] of props) this.add(b, p, o);
    return b;
  };
  list = (items: Node[]): Node => {
    let head: Node = this.iri(RDF + 'nil');
    for (const item of [...items].reverse()) {
      const cell = this.blank();
      this.add(cell, RDF + 'first', item);
      this.add(cell, RDF + 'rest', head);
      head = cell;
    }
    return head;
  };
  /** Turtle kept as it was read: its triples, with blank nodes of this writer's own. */
  kept = (turtle: string): Node => {
    const parsed = new Parser().parse(`<urn:x:s> <urn:x:p> ${turtle} .`) as unknown as Quad[];
    const renamed = new Map<string, Node>();
    const own = (t: Node): Node => (t.termType !== 'BlankNode' ? t : (renamed.get(t.value) ?? renamed.set(t.value, this.blank()).get(t.value)!));
    let top: Node | undefined;
    for (const q of parsed) {
      if (q.subject.value === 'urn:x:s' && q.predicate.value === 'urn:x:p') top = own(q.object);
      else this.quads.push({ subject: own(q.subject), predicate: q.predicate, object: own(q.object) });
    }
    if (!top) throw new Error('Not a Turtle object: ' + turtle);
    return top;
  };
  property = (p: ObjectPropertyExpression | DataProperty): Node => {
    if (p.type !== 'ObjectInverseOf') return this.iri(p.iri);
    const b = this.blank();
    this.add(b, OWL + 'inverseOf', this.iri(p.property.iri));
    return b;
  };
  restriction = (p: ObjectPropertyExpression | DataProperty, props: [Iri, Node][]): Node => this.node(OWL + 'Restriction', [[OWL + 'onProperty', this.property(p)], ...props]);
  count = (n: number): Node => this.literal({ value: String(n), datatype: XSD + 'nonNegativeInteger' });

  cls = (e: ClassExpression): Node => {
    switch (e.type) {
      case 'Class':
        return this.iri(e.iri);
      case 'ObjectIntersectionOf':
      case 'ObjectUnionOf':
        return this.node(OWL + 'Class', [[OWL + (e.type === 'ObjectUnionOf' ? 'unionOf' : 'intersectionOf'), this.list(e.operands.map(this.cls))]]);
      case 'ObjectComplementOf':
        return this.node(OWL + 'Class', [[OWL + 'complementOf', this.cls(e.operand)]]);
      case 'ObjectOneOf':
        return this.node(OWL + 'Class', [[OWL + 'oneOf', this.list(e.individuals.map((i) => this.iri(i.iri)))]]);
      case 'ObjectSomeValuesFrom':
      case 'ObjectAllValuesFrom':
        return this.restriction(e.property, [[OWL + (e.type === 'ObjectSomeValuesFrom' ? 'someValuesFrom' : 'allValuesFrom'), this.cls(e.filler)]]);
      case 'DataSomeValuesFrom':
      case 'DataAllValuesFrom':
        return this.restriction(e.property, [[OWL + (e.type === 'DataSomeValuesFrom' ? 'someValuesFrom' : 'allValuesFrom'), this.range(e.filler)]]);
      case 'ObjectHasValue':
        return this.restriction(e.property, [[OWL + 'hasValue', this.iri(e.individual.iri)]]);
      case 'DataHasValue':
        return this.restriction(e.property, [[OWL + 'hasValue', this.literal(e.value)]]);
      case 'ObjectHasSelf':
        return this.restriction(e.property, [[OWL + 'hasSelf', this.literal({ value: 'true', datatype: XSD + 'boolean' })]]);
      case 'ObjectMinCardinality':
      case 'ObjectMaxCardinality':
      case 'ObjectExactCardinality':
      case 'DataMinCardinality':
      case 'DataMaxCardinality':
      case 'DataExactCardinality': {
        const which = e.type.includes('Min') ? 'min' : e.type.includes('Max') ? 'max' : '';
        const n = this.count(e.n);
        if (!e.filler) return this.restriction(e.property, [[OWL + (which ? which + 'Cardinality' : 'cardinality'), n]]);
        const filler: [Iri, Node] = e.type.startsWith('Data') ? [OWL + 'onDataRange', this.range(e.filler as DataRange)] : [OWL + 'onClass', this.cls(e.filler as ClassExpression)];
        return this.restriction(e.property, [[OWL + (which ? which + 'QualifiedCardinality' : 'qualifiedCardinality'), n], filler]);
      }
      case 'Unparsed':
        return this.kept(e.turtle);
    }
  };

  range = (r: DataRange): Node => {
    switch (r.type) {
      case 'Datatype':
        return this.iri(r.iri);
      case 'DataIntersectionOf':
      case 'DataUnionOf':
        return this.node(RDFS + 'Datatype', [[OWL + (r.type === 'DataUnionOf' ? 'unionOf' : 'intersectionOf'), this.list(r.operands.map(this.range))]]);
      case 'DataComplementOf':
        return this.node(RDFS + 'Datatype', [[OWL + 'datatypeComplementOf', this.range(r.operand)]]);
      case 'DataOneOf':
        return this.node(RDFS + 'Datatype', [[OWL + 'oneOf', this.list(r.literals.map(this.literal))]]);
      case 'DatatypeRestriction':
        return this.node(RDFS + 'Datatype', [
          [OWL + 'onDatatype', this.iri(r.datatype)],
          [
            OWL + 'withRestrictions',
            this.list(
              r.facets.map((f) => {
                const b = this.blank();
                this.add(b, f.facet, this.literal(f.value));
                return b;
              }),
            ),
          ],
        ]);
      case 'Unparsed':
        return this.kept(r.turtle);
    }
  };

  annotationValue = (v: AnnotationValue): Node => ('iri' in v ? this.iri(v.iri) : this.literal(v));

  /** An n-ary statement written as a blank node of its own: owl:AllDisjointClasses and the like. */
  all = (type: Iri, members: Node[]) => this.node(type, [[OWL + 'members', this.list(members)]]);

  axiom = (a: Axiom): void => {
    const s = (iri: Iri) => this.iri(iri);
    // Stated of two things in RDF, as a triple from the first (which has to be named); of more, as a blank node.
    const pair = (items: Node[], predicate: Iri, all: Iri) => {
      if (items.length === 2 && items[0].termType === 'NamedNode') this.add(items[0], predicate, items[1]);
      else if (all && items.length > 2) this.all(all, items);
      else throw new Error(`${a.type} of ${items.length} cannot be written as one statement.`);
    };
    switch (a.type) {
      case 'Declaration':
        this.add(s(a.iri), RDF + 'type', s(DECLARED_AS[a.entity]));
        return;
      case 'Ontology':
        this.add(s(a.iri), RDF + 'type', s(OWL + 'Ontology'));
        return;
      case 'SubClassOf':
        if (a.sub.type !== 'Class') throw new Error('A general class axiom has no typed form here yet.');
        this.add(s(a.sub.iri), RDFS + 'subClassOf', this.cls(a.sup));
        return;
      case 'EquivalentClasses':
        return pair(a.classes.map(this.cls), OWL + 'equivalentClass', '');
      case 'DisjointClasses':
        return pair(a.classes.map(this.cls), OWL + 'disjointWith', OWL + 'AllDisjointClasses');
      case 'ClassAssertion':
        this.add(s(a.individual), RDF + 'type', this.cls(a.class));
        return;
      case 'ObjectPropertyAssertion':
        this.add(s(a.source), a.property, s(a.target));
        return;
      case 'DataPropertyAssertion':
        this.add(s(a.source), a.property, this.literal(a.value));
        return;
      case 'SameIndividual':
        return pair(a.individuals.map(s), OWL + 'sameAs', '');
      case 'DifferentIndividuals':
        return pair(a.individuals.map(s), OWL + 'differentFrom', OWL + 'AllDifferent');
      case 'SubObjectPropertyOf':
      case 'SubDataPropertyOf':
      case 'SubAnnotationPropertyOf':
        this.add(s(a.sub), RDFS + 'subPropertyOf', s(a.sup));
        return;
      case 'SubPropertyChainOf':
        this.add(s(a.sup), OWL + 'propertyChainAxiom', this.list(a.chain.map((p) => this.property(p))));
        return;
      case 'HasKey':
        this.add(s(a.class), OWL + 'hasKey', this.list(a.properties.map((p) => s(p.iri))));
        return;
      case 'DisjointUnion':
        this.add(s(a.class), OWL + 'disjointUnionOf', this.list(a.classes.map(this.cls)));
        return;
      case 'NegativeObjectPropertyAssertion':
        this.node(OWL + 'NegativePropertyAssertion', [
          [OWL + 'sourceIndividual', s(a.source)],
          [OWL + 'assertionProperty', s(a.property)],
          [OWL + 'targetIndividual', s(a.target)],
        ]);
        return;
      case 'NegativeDataPropertyAssertion':
        this.node(OWL + 'NegativePropertyAssertion', [
          [OWL + 'sourceIndividual', s(a.source)],
          [OWL + 'assertionProperty', s(a.property)],
          [OWL + 'targetValue', this.literal(a.value)],
        ]);
        return;
      case 'EquivalentObjectProperties':
      case 'EquivalentDataProperties':
        return pair(a.properties.map(s), OWL + 'equivalentProperty', '');
      case 'DisjointObjectProperties':
      case 'DisjointDataProperties':
        return pair(a.properties.map(s), OWL + 'propertyDisjointWith', OWL + 'AllDisjointProperties');
      case 'InverseObjectProperties':
        this.add(s(a.first), OWL + 'inverseOf', s(a.second));
        return;
      case 'ObjectPropertyDomain':
      case 'DataPropertyDomain':
        this.add(s(a.property), RDFS + 'domain', this.cls(a.domain));
        return;
      case 'ObjectPropertyRange':
        this.add(s(a.property), RDFS + 'range', this.cls(a.range));
        return;
      case 'DataPropertyRange':
        this.add(s(a.property), RDFS + 'range', this.range(a.range));
        return;
      case 'FunctionalDataProperty':
        this.add(s(a.property), RDF + 'type', s(OWL + 'FunctionalProperty'));
        return;
      case 'DatatypeDefinition':
        this.add(s(a.datatype), OWL + 'equivalentClass', this.range(a.range));
        return;
      case 'AnnotationAssertion':
        this.add(s(a.subject), a.property, this.annotationValue(a.value));
        return;
      case 'OntologyAnnotation':
        this.add(s(a.ontology), a.property, this.annotationValue(a.value));
        return;
      case 'Import':
        this.add(s(a.ontology), OWL + 'imports', s(a.iri));
        return;
      case 'Unmapped':
        this.quads.push(...(new Parser().parse(a.turtle) as unknown as Quad[]));
        return;
      default:
        if ((OBJECT_PROPERTY_CHARACTERISTICS as readonly string[]).includes(a.type)) {
          this.add(s(a.property), RDF + 'type', s(CHARACTERISTIC_TYPE[a.type]));
          return;
        }
        throw new Error(`An axiom of an unknown type: ${(a as { type: string }).type}.`);
    }
  };
}

/**
 * The statement an axiom is, as canonical Turtle: what it is compared by, and what is added to
 * an ontology or taken from it. Nothing for an axiom that is not one statement (malformed
 * Turtle, an n-ary axiom RDF writes as several statements, an expression it cannot write).
 */
export function statementOf(a: Axiom): string | undefined {
  const w = new Writer();
  try {
    w.axiom(a);
  } catch {
    return undefined;
  }
  const found = statements(w.quads);
  return found.length === 1 ? found[0].text : undefined;
}

/** An axiom in a few words, for saying which one a refusal is about: its type, the local names of its IRIs, and its literal. */
export function brief(a: Axiom): string {
  if (a.type === 'Unmapped') return a.turtle.length > 120 ? a.turtle.slice(0, 117) + '…' : a.turtle;
  const parts: string[] = [];
  const short = (iri: string) => {
    const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
    return cut >= 0 && cut < iri.length - 1 ? iri.slice(cut + 1) : iri;
  };
  const walk = (x: unknown, key = '') => {
    if (typeof x === 'string') {
      if (key === 'value') parts.push(JSON.stringify(x));
      else if (key !== 'type' && key !== 'entity' && key !== 'lang' && key !== 'datatype' && key !== 'turtle') parts.push(short(x));
    } else if (Array.isArray(x)) x.forEach((v) => walk(v));
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, k);
  };
  walk(a);
  return `${a.type}(${parts.join(' ')})`;
}
