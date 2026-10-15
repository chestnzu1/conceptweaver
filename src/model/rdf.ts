import { Parser } from 'n3';
import { ANNOTATION_PROPS, standardAnnotation } from './annotations';
import { baseIriOf, localName } from './iri';
import { arrangeAsHierarchy } from '../layout/graph';
import { DATATYPES, ENUM_RANGE, emptyModel, type DescriptionProperty, type NameProperty, newRelation, newTerm, PROP_LINKS, uid, type DataValue, type EnumDatatype, type EnumLiteral, type ExtraField, type Model, type ObjProp, type PropLink, type Relation, type RestrictionSpec, type Term } from './types';
import { allPrefixes, compactIri, expandIri, isAbsoluteIri, ontologyIriOf, STANDARD } from './prefixes';
import { enumOf, isEnumRange } from './datatypes';
import { propDatatype } from './domains';
import { classesOfUnion, graphOf, readClass, readDataRange, withIrisIn, type ClassAxiom, type ClassExpression, type DataProperty, type DataRange, type DataRangeAxiom, type Graph, type Literal, type ObjectPropertyExpression, type ClassAxiomKind } from './expressions';
import { keyIri } from './governance';
import { linkProps } from './identity';
import { CHARACTERISTICS, dataDomain, DEFAULT_PROP, objectProperties, restrictionSpecs, specsPatch } from './props';
import { jsonLdNodes, statements } from './unmapped';
import { resolveModel, STD_PROPS } from './vocab';

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dct: 'http://purl.org/dc/terms/',
};

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** How each list of related object properties is written. */
const LINK_PREDICATE: Record<PropLink, string> = { parents: 'rdfs:subPropertyOf', inverses: 'owl:inverseOf', equivalents: 'owl:equivalentProperty', disjoints: 'owl:propertyDisjointWith' };

/** Text that is a URL. */
const LINK_TEXT = /^https?:\/\/[^\s<>"]+$/;

/** Annotation properties whose value is written as a link when it is a URL, unless it was read as text. */
const LINKS = new Set(['skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch', 'rdfs:seeAlso', 'rdfs:isDefinedBy', 'dcterms:source', 'owl:priorVersion', 'owl:backwardCompatibleWith', 'owl:incompatibleWith']);

// ---------------------------------------------------------------- export

/** `raw` is Turtle kept word for word: a class expression the app has no structure for. */
type Val = { id: string } | { lit: string; bool?: boolean; lang?: string; dt?: string } | { bnode: RdfNode } | { list: Val[] } | { raw: string; ttl?: string };
/** `id` is a CURIE (":Movie", "owl:Class") or a full IRI in angle brackets. */
interface RdfNode {
  id: string;
  props: [string, Val][];
}

function toRdf(model: Model): { base: string; nodes: RdfNode[]; ref: Map<string, string>; propRef: Map<string, string> } {
  // Each relationship joined to the property it uses (identity.ts), with the standard properties in force.
  const m = resolveModel(linkProps(model));
  const base = baseIriOf(m);
  const used = new Set<string>();
  const unique = (s: string) => {
    let out = s;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = `${s}_${i}`;
    used.add(out.toLowerCase());
    return out;
  };
  const ref = new Map<string, string>();
  // An IRI is written with a prefix where one covers it, and in full otherwise. Names taken in
  // the default namespace are remembered so that generated ones keep clear of them.
  const short = (iri: string) => {
    const curie = compactIri(m, iri);
    if (curie?.startsWith(':')) used.add(curie.slice(1).toLowerCase());
    return curie ?? `<${iri}>`;
  };
  for (const t of m.terms) if (t.iri) ref.set(t.id, short(t.iri));
  for (const t of m.terms) {
    if (!ref.has(t.id)) ref.set(t.id, ':' + unique(localName(t.name, t.type === 'property')));
  }
  const byId = new Map(m.terms.map((t) => [t.id, t]));

  /** A literal in the model's language (names, definitions and synonyms are written in it). */
  // In the model's language, or in the one a name or description was read in where that was another ('' for none).
  const text = (value: string, lang = m.lang): Val => (lang ? { lit: value, lang } : { lit: value });
  const modelIri = `<${ontologyIriOf(m)}>`;
  const custom = new Map<string, string>();
  const annProps: RdfNode[] = [];
  // Metadata fields are annotations: standard properties as they are, the rest as properties of the model's own.
  // Properties of other vocabularies used as annotations are declared as annotation properties,
  // so that an OWL reader takes them for what they are and reads no logic into them.
  const declaredAnn = new Set<string>();
  const declare = (pred: string) => {
    if (declaredAnn.has(pred) || /^(rdfs|owl|skos|dcterms):/.test(pred)) return;
    declaredAnn.add(pred);
    annProps.push({ id: pred, props: [['rdf:type', { id: 'owl:AnnotationProperty' }]] });
  };
  const metrics = new Map<string, string>();
  const literalOf = (f: ExtraField, value: string): Val =>
    f.dt === 'xsd:boolean' && /^(true|false)$/.test(value) ? { lit: value, bool: true } : f.dt ? { lit: value, dt: f.dt } : f.lang ? { lit: value, lang: f.lang } : { lit: value };
  const annotate = (n: RdfNode, t: { fields: ExtraField[] }) => {
    for (const f of t.fields) {
      const key = f.key.trim();
      const value = f.value.trim();
      if (!key || !value) continue;
      if (f.measure) {
        // A quality measurement (DQV): the value, and the metric it is a measurement of.
        let metric = standardAnnotation(key) ?? (keyIri(m, key) ? short(keyIri(m, key)!) : metrics.get(key.toLowerCase()));
        if (!metric) {
          metric = ':' + unique(localName(key, true));
          metrics.set(key.toLowerCase(), metric);
          annProps.push({ id: metric, props: [['rdf:type', { id: 'dqv:Metric' }], ['rdfs:label', { lit: key }]] });
        }
        declare('dqv:hasQualityMeasurement');
        n.props.push(['dqv:hasQualityMeasurement', { bnode: { id: '', props: [['rdf:type', { id: 'dqv:QualityMeasurement' }], ['dqv:isMeasurementOf', { id: metric }], ['dqv:value', literalOf(f, value)]] } }]);
        continue;
      }
      let pred = standardAnnotation(key);
      if (pred) declare(pred);
      else if (keyIri(m, key)) {
        pred = short(keyIri(m, key)!);
        declare(pred);
      } else {
        pred = custom.get(key.toLowerCase());
        if (!pred) {
          pred = ':' + unique(localName(key, true));
          custom.set(key.toLowerCase(), pred);
          annProps.push({ id: pred, props: [['rdf:type', { id: 'owl:AnnotationProperty' }], ['rdfs:label', { lit: key }]] });
        }
      }
      if (f.iri && isAbsoluteIri(value)) n.props.push([pred, { id: short(value) }]);
      else if (pred === 'owl:deprecated' && /^(true|false)$/i.test(value)) n.props.push([pred, { lit: value.toLowerCase(), bool: true }]);
      else if (LINKS.has(pred) && f.iri !== false && LINK_TEXT.test(value)) n.props.push([pred, { id: `<${value}>` }]);
      // Text is written as it was given, spaces and all: only an empty one is left out.
      else n.props.push([pred, literalOf(f, f.value)]);
    }
  };
  const nodes = new Map<string, RdfNode>();

  if (m.mode === 'skos') {
    // A SKOS concept scheme: every term is a concept in it, "is a" is skos:broader.
    const scheme: RdfNode = { id: modelIri, props: [['rdf:type', { id: 'skos:ConceptScheme' }], [m.namedBy ?? 'skos:prefLabel', text(m.name, m.nameLang)]] };
    if (m.description) scheme.props.push([m.describedBy ?? 'dcterms:description', text(m.description, m.descriptionLang)]);
    for (const t of m.terms) {
      // A concept of another scheme is referred to, not described: it is not in this scheme.
      if (t.external !== undefined) {
        nodes.set(t.id, { id: ref.get(t.id)!, props: [['rdf:type', { id: 'skos:Concept' }]] });
        continue;
      }
      const n: RdfNode = { id: ref.get(t.id)!, props: [['rdf:type', { id: 'skos:Concept' }], ['skos:prefLabel', text(t.name, t.nameLang)]] };
      if (t.description) n.props.push([t.describedBy ?? 'skos:definition', text(t.description, t.descriptionLang)]);
      for (const syn of t.synonyms.split(',')) if (syn.trim()) n.props.push(['skos:altLabel', text(syn.trim())]);
      annotate(n, t);
      n.props.push(['skos:inScheme', { id: scheme.id }]);
      nodes.set(t.id, n);
    }
    const own = new Map<string, RdfNode>();
    const hasBroader = new Set<string>();
    for (const r of m.relations) {
      const A = nodes.get(r.from);
      const B = nodes.get(r.to);
      if (!A || !B || A === B) continue;
      const label = r.label.trim();
      let pred = r.predicate ?? (r.kind === 'generalization' ? 'skos:broader' : label ? undefined : 'skos:related');
      if (!pred) {
        // A relationship of the user's own is still an association in SKOS terms.
        let p = own.get(label.toLowerCase());
        if (!p) {
          p = { id: ':' + unique(localName(label, true)), props: [['rdf:type', { id: 'rdf:Property' }], ['rdfs:subPropertyOf', { id: 'skos:related' }], ['rdfs:label', text(label)]] };
          own.set(label.toLowerCase(), p);
        }
        pred = p.id;
      }
      if (pred === 'skos:broader') hasBroader.add(r.from);
      A.props.push([pred, { id: B.id }]);
    }
    for (const t of m.terms) {
      if (hasBroader.has(t.id) || t.external !== undefined) continue;
      nodes.get(t.id)!.props.push(['skos:topConceptOf', { id: scheme.id }]);
      scheme.props.push(['skos:hasTopConcept', { id: ref.get(t.id)! }]);
    }
    return { base, nodes: [scheme, ...annProps, ...own.values(), ...m.terms.map((t) => nodes.get(t.id)!)], ref, propRef: new Map() };
  }

  const ontology: RdfNode = { id: modelIri, props: [['rdf:type', { id: 'owl:Ontology' }], [m.namedBy ?? 'rdfs:label', text(m.name, m.nameLang)]] };
  if (m.description) ontology.props.push([m.describedBy ?? 'rdfs:comment', text(m.description, m.descriptionLang)]);
  // Dependencies: the ontologies whose axioms this one takes over. Their content is not written here.
  for (const e of m.externals) if (e.imports && e.iri) ontology.props.push(['owl:imports', { id: `<${e.iri}>` }]);

  for (const t of m.terms) {
    const type = t.type === 'concept' ? 'owl:Class' : t.type === 'property' ? 'owl:DatatypeProperty' : 'owl:NamedIndividual';
    const n: RdfNode = { id: ref.get(t.id)!, props: [['rdf:type', { id: type }], ['rdfs:label', text(t.name, t.nameLang)]] };
    // An entity of another ontology is only declared: its label and definition are that ontology's to state.
    if (t.external !== undefined) {
      nodes.set(t.id, { id: n.id, props: [n.props[0]] });
      continue;
    }
    if (t.description) n.props.push([t.describedBy ?? 'skos:definition', text(t.description, t.descriptionLang)]);
    for (const syn of t.synonyms.split(',')) if (syn.trim()) n.props.push(['skos:altLabel', text(syn.trim())]);
    annotate(n, t);
    nodes.set(t.id, n);
  }

  // Enumerated datatypes: each a datatype equivalent to a list of literals. A datatype is not a
  // class and its values are not individuals; nothing here is typed owl:Class or owl:NamedIndividual.
  const literalVal = (v: EnumLiteral): Val => (v.lang ? { lit: v.value, lang: v.lang } : v.dt && v.dt !== 'xsd:string' ? { lit: v.value, dt: v.dt } : { lit: v.value });
  const literalList = (d: EnumDatatype): Val => ({ bnode: { id: '', props: [['rdf:type', { id: 'rdfs:Datatype' }], ['owl:oneOf', { list: d.values.map(literalVal) }]] } });
  const datatypeRef = new Map<string, string>();
  for (const d of m.datatypes) if (!d.anonymous && d.iri) datatypeRef.set(d.id, short(d.iri));
  for (const d of m.datatypes) if (!d.anonymous && !d.iri) datatypeRef.set(d.id, ':' + unique(localName(d.name || 'Datatype', false)));
  const datatypeNodes: RdfNode[] = m.datatypes
    .filter((d) => !d.anonymous)
    .map((d) => ({
      id: datatypeRef.get(d.id)!,
      props: [['rdf:type', { id: 'rdfs:Datatype' }], ['rdfs:label', text(d.name, d.nameLang)], ...(d.description ? [[d.describedBy ?? 'skos:definition', text(d.description, d.descriptionLang)] as [string, Val]] : []), ...(d.values.length ? [['owl:equivalentClass', literalList(d)] as [string, Val]] : [])],
    }));
  /** A range as it is written: a standard datatype or a named one by name, a nameless enumeration as its list. */
  const rangeVal = (range: string | undefined): Val | undefined => {
    if (!range) return undefined;
    if (!isEnumRange(range)) return { id: range };
    const d = enumOf(m, range);
    if (!d) return undefined;
    return d.anonymous ? (d.values.length ? literalList(d) : undefined) : { id: datatypeRef.get(d.id)! };
  };

  // A domain or range that follows the uses is the class they start from (point to), or "any of
  // these", which OWL writes as a union; listing them one by one would mean "all of these at once".
  const classes = (refs: string[]): Val =>
    // Sorted, so that the same set always reads the same whatever order it was built in.
    refs.length === 1 ? { id: refs[0] } : { bnode: { id: '', props: [['rdf:type', { id: 'owl:Class' }], ['owl:unionOf', { list: [...refs].sort().map((id) => ({ id })) }]] } };
  // A domain or range stated as axioms: each is one statement, its expression written as OWL
  // writes it in RDF, operands in the order they are held (as they were read).
  const blank = (type: string, props: [string, Val][]): Val => ({ bnode: { id: '', props: [['rdf:type', { id: type }], ...props] } });
  const iriVal = (iri: string): Val => ({ id: short(iri) });
  const literal = (l: Literal): Val => (l.lang ? { lit: l.value, lang: l.lang } : l.datatype === XSD + 'boolean' && /^(true|false)$/.test(l.value) ? { lit: l.value, bool: true } : l.datatype ? { lit: l.value, dt: short(l.datatype) } : { lit: l.value });
  const count = (n: number): Val => ({ lit: String(n), dt: 'xsd:nonNegativeInteger' });
  // An expression kept as read has its IRIs in full; in Turtle they are shortened as everywhere else.
  const kept = (turtle: string): Val => ({ raw: turtle, ttl: withIrisIn(turtle, (iri) => (short(iri).startsWith('<') ? undefined : short(iri)), false) });
  // A restriction on the inverse of a property names it in place: [ owl:inverseOf :p ].
  const propertyVal = (p: ObjectPropertyExpression | DataProperty): Val => (p.type === 'ObjectInverseOf' ? { bnode: { id: '', props: [['owl:inverseOf', iriVal(p.property.iri)]] } } : iriVal(p.iri));
  const restriction = (property: ObjectPropertyExpression | DataProperty, props: [string, Val][]): Val => blank('owl:Restriction', [['owl:onProperty', propertyVal(property)], ...props]);
  const CARD: Record<string, [string, string]> = { Min: ['owl:minCardinality', 'owl:minQualifiedCardinality'], Max: ['owl:maxCardinality', 'owl:maxQualifiedCardinality'], Exact: ['owl:cardinality', 'owl:qualifiedCardinality'] };
  const classVal = (e: ClassExpression): Val => {
    switch (e.type) {
      case 'Class':
        return iriVal(e.iri);
      case 'ObjectUnionOf':
      case 'ObjectIntersectionOf':
        return blank('owl:Class', [[e.type === 'ObjectUnionOf' ? 'owl:unionOf' : 'owl:intersectionOf', { list: e.operands.map(classVal) }]]);
      case 'ObjectComplementOf':
        return blank('owl:Class', [['owl:complementOf', classVal(e.operand)]]);
      case 'ObjectOneOf':
        return blank('owl:Class', [['owl:oneOf', { list: e.individuals.map((i) => iriVal(i.iri)) }]]);
      case 'ObjectSomeValuesFrom':
      case 'ObjectAllValuesFrom':
        return restriction(e.property, [[e.type === 'ObjectSomeValuesFrom' ? 'owl:someValuesFrom' : 'owl:allValuesFrom', classVal(e.filler)]]);
      case 'DataSomeValuesFrom':
      case 'DataAllValuesFrom':
        return restriction(e.property, [[e.type === 'DataSomeValuesFrom' ? 'owl:someValuesFrom' : 'owl:allValuesFrom', dataVal(e.filler) ?? { id: 'rdfs:Literal' }]]);
      case 'ObjectHasValue':
        return restriction(e.property, [['owl:hasValue', iriVal(e.individual.iri)]]);
      case 'DataHasValue':
        return restriction(e.property, [['owl:hasValue', literal(e.value)]]);
      case 'ObjectHasSelf':
        return restriction(e.property, [['owl:hasSelf', { lit: 'true', bool: true }]]);
      case 'ObjectMinCardinality':
      case 'ObjectMaxCardinality':
      case 'ObjectExactCardinality': {
        const [plainCard, qualified] = CARD[e.type.slice('Object'.length, -'Cardinality'.length)];
        return restriction(e.property, e.filler ? [[qualified, count(e.n)], ['owl:onClass', classVal(e.filler)]] : [[plainCard, count(e.n)]]);
      }
      case 'DataMinCardinality':
      case 'DataMaxCardinality':
      case 'DataExactCardinality': {
        const [plainCard, qualified] = CARD[e.type.slice('Data'.length, -'Cardinality'.length)];
        return restriction(e.property, e.filler ? [[qualified, count(e.n)], ['owl:onDataRange', dataVal(e.filler) ?? { id: 'rdfs:Literal' }]] : [[plainCard, count(e.n)]]);
      }
      case 'Unparsed':
        return kept(e.turtle);
    }
  };
  function dataVal(r: DataRange): Val | undefined {
    switch (r.type) {
      case 'Datatype':
        return iriVal(r.iri);
      case 'Enumeration':
        return rangeVal(ENUM_RANGE + r.datatype);
      case 'DataUnionOf':
      case 'DataIntersectionOf':
        return blank('rdfs:Datatype', [[r.type === 'DataUnionOf' ? 'owl:unionOf' : 'owl:intersectionOf', { list: r.operands.map(dataVal).filter((x): x is Val => !!x) }]]);
      case 'DataComplementOf': {
        const operand = dataVal(r.operand);
        return operand && blank('rdfs:Datatype', [['owl:datatypeComplementOf', operand]]);
      }
      case 'DataOneOf':
        return blank('rdfs:Datatype', [['owl:oneOf', { list: r.literals.map(literal) }]]);
      case 'DatatypeRestriction':
        return blank('rdfs:Datatype', [['owl:onDatatype', iriVal(r.datatype)], ['owl:withRestrictions', { list: r.facets.map((f): Val => ({ bnode: { id: '', props: [[short(f.facet), literal(f.value)]] } })) }]]);
      case 'Unparsed':
        return kept(r.turtle);
    }
  }

  // Object properties: each is declared once, with its domain, range and characteristics, and
  // the relationships between terms are uses of it.
  const views = objectProperties(m);
  const propRef = new Map<string, string>();
  for (const v of views) if (v.iri) propRef.set(v.id, short(v.iri));
  for (const v of views) if (!v.iri) propRef.set(v.id, ':' + unique(localName(v.name, true)));
  const objProps: RdfNode[] = views.map((v) => {
    const n: RdfNode = { id: propRef.get(v.id)!, props: [['rdf:type', { id: 'owl:ObjectProperty' }]] };
    for (const c of CHARACTERISTICS) if (v.chars.includes(c.id)) n.props.push(['rdf:type', { id: c.owl }]);
    if (v.external === undefined) {
      n.props.push(['rdfs:label', text(v.name, v.nameLang)]);
      if (v.description) n.props.push([v.describedBy ?? 'skos:definition', text(v.description, v.descriptionLang)]);
      annotate(n, v);
    }
    for (const link of PROP_LINKS) for (const k of v[link]) if (propRef.has(k)) n.props.push([LINK_PREDICATE[link], { id: propRef.get(k)! }]);
    // Where an external property is used here says nothing about its domain or range; only what is stated by hand is written.
    if (!v.domainAuto) for (const a of v.domains) n.props.push(['rdfs:domain', classVal(a.expression)]);
    else if (v.usedFrom.length && v.external === undefined) n.props.push(['rdfs:domain', classes(v.usedFrom.map((id) => ref.get(id)!))]);
    if (!v.rangeAuto) for (const a of v.ranges) n.props.push(['rdfs:range', classVal(a.expression)]);
    else if (v.usedTo.length && v.external === undefined) n.props.push(['rdfs:range', classes(v.usedTo.map((id) => ref.get(id)!))]);
    return n;
  });
  // A class restricted by a property: "every member has it to some / only / N members of the target".
  const restrict = (spec: RestrictionSpec, property: string, to: string | Val, data: boolean): Val => {
    // What the values have to be: a class or a datatype by name, or a list of literals written in place.
    const target: Val = typeof to === 'string' ? { id: to } : to;
    const q = spec.restriction;
    const count: Val = { lit: String(spec.restrictionN ?? 1), dt: 'xsd:nonNegativeInteger' };
    const body: [string, Val][] =
      q === 'some'
        ? [['owl:someValuesFrom', target]]
        : q === 'only'
          ? [['owl:allValuesFrom', target]]
          : [[q === 'min' ? 'owl:minQualifiedCardinality' : q === 'max' ? 'owl:maxQualifiedCardinality' : 'owl:qualifiedCardinality', count], [data ? 'owl:onDataRange' : 'owl:onClass', target]];
    return { bnode: { id: '', props: [['rdf:type', { id: 'owl:Restriction' }], ['owl:onProperty', { id: property }], ...body] } };
  };
  // Axioms of many members that were read as one are written as one, while every pair of them is still stated.
  const whole = wholeGroups(m);
  // Relationship labels that are not object properties are plain RDF properties: stated as they
  // are drawn, with no claim about their kind, domain or range.
  const plain = new Map<string, string>();
  const plainProps: RdfNode[] = [];
  for (const r of m.relations) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!a || !b) continue;
    const A = nodes.get(a.id)!;
    const bRef = { id: ref.get(b.id)! };
    if (r.predicate) {
      if (r.group && whole.has(r.group) && !r.statedAlone) continue;
      A.props.push([r.predicate, bRef]);
    } else if (r.kind === 'generalization') {
      const pred =
        a.type === 'instance' && b.type === 'concept' ? 'rdf:type' : a.type === 'property' && b.type === 'property' ? 'rdfs:subPropertyOf' : 'rdfs:subClassOf';
      // A class membership is one rdf:type triple, however many times it happens to be drawn.
      if (pred === 'rdf:type' && A.props.some(([p, v]) => p === pred && 'id' in v && v.id === bRef.id)) continue;
      A.props.push([pred, bRef]);
    } else if (r.kind === 'property' && b.type === 'property') {
      // A class that has a data property is restricted by it: its members have such a value.
      // The property's own domain and datatype are written on the property below.
      // One superclass for each restriction the relationship states.
      if (a.type === 'concept') for (const spec of restrictionSpecs(r)) A.props.push(['rdfs:subClassOf', restrict(spec, bRef.id, rangeVal(propDatatype(b)) ?? 'rdfs:Literal', true)]);
    } else {
      const declared = r.kind === 'association' && r.prop !== undefined ? propRef.get(r.prop) : undefined;
      if (declared && a.type === 'concept' && b.type === 'concept') {
        for (const spec of restrictionSpecs(r)) A.props.push(['rdfs:subClassOf', restrict(spec, declared, bRef.id, false)]);
        continue;
      }
      let p = declared;
      if (!p) {
        const label = r.label.trim() || (r.kind === 'property' ? 'has' : DEFAULT_PROP);
        p = plain.get(label.toLowerCase());
        if (!p) {
          p = ':' + unique(localName(label, true));
          plain.set(label.toLowerCase(), p);
          plainProps.push({ id: p, props: [['rdf:type', { id: 'rdf:Property' }], ['rdfs:label', text(label)]] });
        }
      }
      // A fact about two individuals, or a relationship nobody has given a meaning yet.
      A.props.push([p, bRef]);
    }
  }
  objProps.push(...plainProps);
  // A class's axioms that are expressions, each written as the statement of its kind.
  const AXIOM_PREDICATE: Record<ClassAxiomKind, string> = { SubClassOf: 'rdfs:subClassOf', EquivalentClasses: 'owl:equivalentClass', DisjointClasses: 'owl:disjointWith' };
  for (const t of m.terms) {
    if (t.external !== undefined) continue;
    for (const a of t.classAxioms ?? []) nodes.get(t.id)!.props.push([AXIOM_PREDICATE[a.kind], classVal(a.expression)]);
  }
  for (const t of m.terms) {
    if (t.type !== 'property' || t.external !== undefined) continue;
    const n = nodes.get(t.id)!;
    // The second type goes right after the first, as it does for an object property's characteristics.
    if (t.functional) n.props.splice(1, 0, ['rdf:type', { id: 'owl:FunctionalProperty' }]);
    const dom = dataDomain(m, t);
    if (!dom.auto) for (const a of dom.axioms) n.props.push(['rdfs:domain', classVal(a.expression)]);
    else if (dom.attached.length) n.props.push(['rdfs:domain', classes(dom.attached.map((id) => ref.get(id)!))]);
    for (const a of t.ranges ?? []) {
      const range = dataVal(a.range);
      if (range) n.props.push(['rdfs:range', range]);
    }
  }
  // What individuals are stated to have as values of data properties.
  for (const t of m.terms) {
    if (t.type !== 'instance') continue;
    for (const v of t.values ?? []) {
      const prop = byId.get(v.prop);
      if (prop?.type !== 'property') continue;
      // A value of an enumerated datatype is written the way that datatype lists it.
      const range = propDatatype(prop);
      const listed = enumOf(m, range);
      const dt = v.dt ?? (listed ? listed.values.find((x) => x.value === v.value && (x.lang ?? '') === (v.lang ?? ''))?.dt : range);
      const plain = !dt || dt === 'xsd:string' || dt === 'rdf:langString';
      nodes.get(t.id)!.props.push([ref.get(prop.id)!, v.lang ? { lit: v.value, lang: v.lang } : plain ? { lit: v.value } : { lit: v.value, dt }]);
    }
  }
  // An enumeration: the class is exactly the individuals listed (owl:equivalentClass with owl:oneOf).
  // The list is a class expression of its own. No triple here says "class oneOf individual".
  const allDifferent: RdfNode[] = [];
  for (const t of m.terms) {
    if (t.type !== 'concept' || t.external !== undefined || !t.oneOf?.length) continue;
    const members = t.oneOf.filter((id) => byId.has(id)).map((id): Val => ({ id: ref.get(id)! }));
    if (!members.length) continue;
    nodes.get(t.id)!.props.push(['owl:equivalentClass', { bnode: { id: '', props: [['rdf:type', { id: 'owl:Class' }], ['owl:oneOf', { list: members }]] } }]);
    // That the members are different individuals is said only where it was asked for.
    if (t.allDifferent && members.length > 1) allDifferent.push({ id: '', props: [['rdf:type', { id: 'owl:AllDifferent' }], ['owl:distinctMembers', { list: members }]] });
  }
  for (const g of whole.values()) allDifferent.push({ id: '', props: [['rdf:type', { id: g.predicate === 'owl:disjointWith' ? 'owl:AllDisjointClasses' : 'owl:AllDifferent' }], ['owl:members', { list: g.members.map((id): Val => ({ id: ref.get(id)! })) }]] });
  const of = (type: Term['type']) => m.terms.filter((t) => t.type === type).map((t) => nodes.get(t.id)!);
  return { base, nodes: [ontology, ...annProps, ...of('concept'), ...objProps, ...datatypeNodes, ...of('property'), ...of('instance'), ...allDifferent], ref, propRef };
}

/**
 * The axioms of many members (Relation.group) that can be written as the one axiom they were read
 * as: those of more than two members of which every two are still stated to be disjoint (or
 * different), by a relationship of the group or by another one. Written so, they say exactly what
 * their pairs say. A group an edit has left a pair short of is written as its pairs.
 */
function wholeGroups(m: Model): Map<string, { predicate: string; members: string[] }> {
  const byGroup = new Map<string, Relation[]>();
  for (const r of m.relations) if (r.group && (r.predicate === 'owl:disjointWith' || r.predicate === 'owl:differentFrom') && r.from !== r.to) (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push(r);
  const out = new Map<string, { predicate: string; members: string[] }>();
  if (!byGroup.size) return out;
  const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const stated = new Map<string, Set<string>>();
  for (const r of m.relations) if (r.predicate) (stated.get(r.predicate) ?? stated.set(r.predicate, new Set()).get(r.predicate)!).add(pair(r.from, r.to));
  for (const [group, rels] of byGroup) {
    const predicate = rels[0].predicate!;
    if (rels.some((r) => r.predicate !== predicate)) continue;
    const members = [...new Set(rels.flatMap((r) => [r.from, r.to]))];
    const said = stated.get(predicate)!;
    if (members.length > 2 && members.every((a, i) => members.slice(i + 1).every((b) => said.has(pair(a, b))))) out.set(group, { predicate, members });
  }
  return out;
}

function ttlBody(n: RdfNode, indent: string): string {
  const grouped = new Map<string, Val[]>();
  for (const [p, v] of n.props) grouped.set(p, [...(grouped.get(p) ?? []), v]);
  const val = (v: Val): string =>
    'raw' in v ? (v.ttl ?? v.raw) : 'list' in v ? `( ${v.list.map(val).join(' ')} )` : 'id' in v ? v.id : 'lit' in v ? (v.bool ? v.lit : JSON.stringify(v.lit) + (v.lang ? '@' + v.lang : v.dt ? '^^' + v.dt : '')) : `[ ${ttlBody(v.bnode, indent + '    ').replace(/\s*\n\s*/g, ' ')} ]`;
  return [...grouped]
    .map(([p, vs]) => `${p === 'rdf:type' ? 'a' : p} ${vs.map(val).join(' , ')}`)
    .join(` ;\n${indent}`);
}

export function toTurtle(m: Model): string {
  const { base, nodes } = toRdf(m);
  // A node without a name of its own (an owl:AllDifferent axiom) is written as a blank node.
  const body = nodes.map((n) => `${n.id || '[]'} ${ttlBody(n, '    ')} .`).join('\n\n');
  // The default namespace, the model's own prefixes (all of them: they are part of the ontology
  // whether or not anything uses them yet), and the standard ones that occur.
  const always = new Set(['owl', 'rdf', 'rdfs', 'skos']);
  const head = [
    `@prefix : <${base}> .`,
    ...[...m.prefixes].sort((a, b) => a.prefix.localeCompare(b.prefix)).map((p) => `@prefix ${p.prefix}: <${p.iri}> .`),
    ...[...STANDARD]
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
      .filter((p) => !m.prefixes.some((x) => x.prefix === p.prefix))
      .filter((p) => always.has(p.prefix) || new RegExp(`(^|[\\s^(\\[])${p.prefix}:`, 'm').test(body))
      .map((p) => `@prefix ${p.prefix}: <${p.iri}> .`),
  ];
  // Statements kept as they were read, which the model has no place for (Model.unmapped).
  const kept = m.unmapped?.trim() ? `\n# Kept as they were read: statements this editor has no place for.\n${m.unmapped.trim()}\n` : '';
  return head.join('\n') + '\n\n' + body + '\n' + kept;
}

export function toJsonLd(m: Model): string {
  const { base, nodes } = toRdf(m);
  const iri = (id: string) => (id.startsWith('<') ? id.slice(1, -1) : id.startsWith(':') ? base + id.slice(1) : id);
  const context = Object.fromEntries([...STANDARD, ...m.prefixes].map((p) => [p.prefix, p.iri]).sort((a, b) => a[0].localeCompare(b[0])));
  // An expression kept as Turtle (full IRIs) is written as the nodes it is made of.
  const rawNodes = (turtle: string): unknown => {
    let quads: { subject: N3Term; predicate: N3Term; object: N3Term }[];
    try {
      quads = new Parser().parse(`<urn:x:s> <urn:x:p> ${turtle} .`) as unknown as typeof quads;
    } catch {
      return undefined;
    }
    const g = graphOf(quads);
    const node = (t: N3Term, seen: Set<string>): unknown => {
      if (t.termType === 'NamedNode') return { '@id': t.value };
      if (t.termType === 'Literal') return t.language ? { '@value': t.value, '@language': t.language } : t.datatype && t.datatype.value !== XSD + 'string' ? { '@value': t.value, '@type': t.datatype.value } : t.value;
      if (seen.has(t.value)) return {};
      seen.add(t.value);
      const items: unknown[] = [];
      for (let cell: N3Term | undefined = t; cell && cell.termType === 'BlankNode'; ) {
        const own = g.predicates(cell);
        if (own.size !== 2 || own.get(NS.rdf + 'first')?.length !== 1 || own.get(NS.rdf + 'rest')?.length !== 1) break;
        items.push(node(own.get(NS.rdf + 'first')![0], seen));
        cell = own.get(NS.rdf + 'rest')![0];
        if (cell.termType === 'NamedNode' && cell.value === NS.rdf + 'nil') return { '@list': items };
      }
      const out: Record<string, unknown[]> = {};
      for (const [p, os] of g.predicates(t)) {
        if (p === NS.rdf + 'type') out['@type'] = os.map((o) => o.value);
        else out[p] = os.map((o) => node(o, seen));
      }
      return out;
    };
    const top = quads.find((q) => q.subject.value === 'urn:x:s' && q.predicate.value === 'urn:x:p');
    return top && node(top.object, new Set());
  };
  const one = (v: Val, isType = false): unknown =>
    'raw' in v
      ? rawNodes(v.raw)
      : 'list' in v
      ? { '@list': v.list.map((x) => one(x)) }
      : 'id' in v
        ? isType
          ? iri(v.id)
          : { '@id': iri(v.id) }
        : 'lit' in v
          ? v.bool
            ? v.lit === 'true'
            : v.lang
              ? { '@value': v.lit, '@language': v.lang }
              : v.dt
                ? { '@value': v.lit, '@type': iri(v.dt) }
                : v.lit
          : conv(v.bnode);
  const conv = (n: RdfNode): Record<string, unknown> => {
    const o: Record<string, unknown[]> = {};
    for (const [p, v] of n.props) {
      const key = p === 'rdf:type' ? '@type' : iri(p);
      const value = one(v, key === '@type');
      // Text kept that does not read as Turtle has no JSON-LD form.
      if (value === undefined) continue;
      (o[key] ??= []).push(value);
    }
    const flat: Record<string, unknown> = n.id ? { '@id': iri(n.id) } : {};
    for (const [k, vs] of Object.entries(o)) flat[k] = vs.length === 1 ? vs[0] : vs;
    return flat;
  };
  return JSON.stringify({ '@context': context, '@graph': [...nodes.map(conv), ...(m.unmapped?.trim() ? jsonLdNodes(m.unmapped) : [])] }, null, 2);
}

// ---------------------------------------------------------------- import

interface N3Term {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

const humanize = (iri: string, lower: boolean): string => {
  const local = decodeURIComponent(iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1)) || iri;
  const words = local.replace(/[_-]+/g, ' ').replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').trim();
  return lower ? words.toLowerCase() : words;
};

/** Builds a model from Turtle / N-Triples text, reading the common OWL, RDFS and SKOS patterns. */
export function fromTurtle(text: string, fallbackName = 'Imported model'): Model {
  // The file's own prefix declarations are kept: they are how its author abbreviates its IRIs.
  const declared = new Map<string, string>();
  const quads = new Parser().parse(text, null, (prefix: string, ns: { value: string }) => declared.set(prefix, ns.value)) as unknown as { subject: N3Term; predicate: N3Term; object: N3Term }[];
  const key = (t: N3Term) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
  const spo = new Map<string, Map<string, N3Term[]>>();
  for (const q of quads) {
    const s = spo.get(key(q.subject)) ?? spo.set(key(q.subject), new Map()).get(key(q.subject))!;
    s.set(q.predicate.value, [...(s.get(q.predicate.value) ?? []), q.object]);
  }
  const objs = (s: string, p: string) => spo.get(s)?.get(p) ?? [];
  // What the reader takes into the model, statement by statement. A statement it takes nothing
  // from is kept as it was, and written back (see unmapped.ts and Model.unmapped).
  const termKey = (t: N3Term) => (t.termType === 'Literal' ? JSON.stringify([t.value, t.language ?? '', t.datatype?.value ?? '']) : key(t));
  const quadKey = (s: string, p: string, o: N3Term) => `${s}\u0001${p}\u0001${termKey(o)}`;
  const used = new Set<string>();
  const iriTerm = (value: string): N3Term => ({ termType: 'NamedNode', value });
  /** Marks a statement as taken: one object, or every object of the subject and predicate. */
  const mark = (s: string, p: string, o?: N3Term | string) => {
    for (const x of o === undefined ? objs(s, p) : [typeof o === 'string' ? iriTerm(o) : o]) used.add(quadKey(s, p, x));
  };
  /** Marks a blank node and everything below it as taken: a restriction, a list, an expression kept as text. */
  const markTree = (t: N3Term, seen = new Set<string>()) => {
    if (t.termType !== 'BlankNode' || seen.has(key(t))) return;
    seen.add(key(t));
    for (const [p, os] of spo.get(key(t)) ?? []) {
      for (const o of os) {
        used.add(quadKey(key(t), p, o));
        markTree(o, seen);
      }
    }
  };
  const markWith = (s: string, p: string, o: N3Term) => {
    mark(s, p, o);
    markTree(o);
  };
  // The language most names are written in becomes the model's language; labels in other
  // languages are kept as metadata fields.
  const langs = new Map<string, number>();
  for (const q of quads) {
    if (q.object.termType === 'Literal' && (q.predicate.value === NS.rdfs + 'label' || q.predicate.value === NS.skos + 'prefLabel')) {
      langs.set(q.object.language ?? '', (langs.get(q.object.language ?? '') ?? 0) + 1);
    }
  }
  const pref = [...langs].sort((a, b) => b[1] - a[1] || (a[0] === 'en' ? -1 : b[0] === 'en' ? 1 : 0))[0]?.[0] ?? '';
  const inPref = (o: N3Term) => !o.language || o.language === pref;
  const literal = (s: string, ...preds: string[]): string => {
    for (const p of preds) {
      const ls = objs(s, p).filter((o) => o.termType === 'Literal');
      const best = ls.find((l) => (l.language ?? '') === pref) ?? ls.find((l) => !l.language) ?? ls[0];
      if (best) return best.value;
    }
    return '';
  };
  /** The same, for a value the model takes (a name, a description): the statement it came from is marked as taken. */
  const take = (s: string, ...preds: string[]): string => takeFrom(s, ...preds)?.value ?? '';
  /** The value taken, the property it was taken from, and its language ('' for none). */
  const takeFrom = (s: string, ...preds: string[]): { value: string; pred: string; lang: string } | undefined => {
    for (const p of preds) {
      const ls = objs(s, p).filter((o) => o.termType === 'Literal');
      const best = ls.find((l) => (l.language ?? '') === pref) ?? ls.find((l) => !l.language) ?? ls[0];
      if (best) {
        mark(s, p, best);
        return { value: best.value, pred: p, lang: best.language ?? '' };
      }
    }
    return undefined;
  };
  /** A name taken, with the language it was written in where that is not the model's. */
  const nameOf = (s: string, preds: string[], otherwise: string): { name: string; nameLang?: string } => {
    const got = takeFrom(s, ...preds);
    return got ? { name: got.value, ...(got.lang !== pref ? { nameLang: got.lang } : {}) } : { name: otherwise };
  };
  // A description is written back with the property it was read from, where that is not the one written by default.
  const DESCRIBED: Record<string, DescriptionProperty> = { [NS.skos + 'definition']: 'skos:definition', [NS.rdfs + 'comment']: 'rdfs:comment', [NS.dct + 'description']: 'dcterms:description' };
  const describe = (s: string, preds: string[], usual: DescriptionProperty): { description: string; describedBy?: DescriptionProperty; descriptionLang?: string } => {
    const got = takeFrom(s, ...preds);
    const by = got && DESCRIBED[got.pred];
    return { description: got?.value ?? '', ...(by && by !== usual ? { describedBy: by } : {}), ...(got && got.lang !== pref ? { descriptionLang: got.lang } : {}) };
  };
  const typed = (type: string) => [...spo.keys()].filter((s) => !s.startsWith('_:') && objs(s, NS.rdf + 'type').some((o) => o.value === type));
  const builtin = (iri: string) => iri.startsWith(NS.owl) || iri.startsWith(NS.rdfs) || iri.startsWith(NS.rdf);
  const named = (ts: N3Term[]) => ts.filter((t) => t.termType === 'NamedNode' && !builtin(t.value)).map((t) => t.value);
  /** A class expression as the named classes it mentions (handles owl:unionOf lists). */
  const expand = (t: N3Term): string[] => {
    if (t.termType === 'NamedNode') return builtin(t.value) ? [] : [t.value];
    if (t.termType !== 'BlankNode') return [];
    const out: string[] = [];
    for (let list = objs(key(t), NS.owl + 'unionOf')[0], guard = 0; list && list.value !== NS.rdf + 'nil' && guard < 1000; guard++) {
      out.push(...named(objs(key(list), NS.rdf + 'first')));
      list = objs(key(list), NS.rdf + 'rest')[0];
    }
    return out;
  };

  const m = emptyModel(fallbackName);
  m.lang = pref;
  const terms = new Map<string, Term>();
  const ensure = (iri: string, type: Term['type']): Term => {
    let t = terms.get(iri);
    if (!t) {
      t = newTerm({
        iri,
        type,
        ...nameOf(iri, [NS.rdfs + 'label', NS.skos + 'prefLabel', NS.dct + 'title'], humanize(iri, false)),
        ...describe(iri, [NS.skos + 'definition', NS.rdfs + 'comment', NS.dct + 'description'], 'skos:definition'),
        synonyms: objs(iri, NS.skos + 'altLabel').filter(inPref).map((o) => o.value).join(', '),
      });
      for (const o of objs(iri, NS.skos + 'altLabel').filter(inPref)) mark(iri, NS.skos + 'altLabel', o);
      terms.set(iri, t);
      m.terms.push(t);
    }
    return t;
  };
  const relKeys = new Set<string>();
  // A use of an object property carries the property's id (`prop`), so that two properties with one label stay two.
  const relate = (from: string, to: string, kind: Relation['kind'], label = '', predicate?: string, restriction?: Pick<Relation, 'restriction' | 'restrictionN' | 'plain' | 'prop'>) => {
    const a = terms.get(from);
    const b = terms.get(to);
    const k = `${from}|${to}|${kind}|${restriction?.prop ?? label}|${predicate ?? ''}|${restriction?.restriction ?? ''}`;
    if (!a || !b) return false;
    if (relKeys.has(k)) return true;
    relKeys.add(k);
    m.relations.push(newRelation({ from: a.id, to: b.id, kind, label, ...(predicate ? { predicate } : {}), ...restriction }));
    return true;
  };
  // Several restrictions by one property on one target are one relationship that states them all.
  const restricted = new Map<string, Relation>();
  const restrictBy = (from: string, to: string, kind: Relation['kind'], label: string, how: Pick<Relation, 'restriction' | 'restrictionN'>, prop?: string): boolean => {
    const k = `${from}|${to}|${kind}|${prop ?? label}`;
    const drawn = restricted.get(k);
    if (drawn) {
      Object.assign(drawn, specsPatch([...restrictionSpecs(drawn), { restriction: how.restriction ?? 'some', restrictionN: how.restrictionN }]));
      for (const key of ['restriction', 'restrictionN', 'more'] as const) if (drawn[key] === undefined) delete drawn[key];
      return true;
    }
    const before = m.relations.length;
    if (!relate(from, to, kind, label, undefined, prop !== undefined ? { ...how, prop } : how)) return false;
    if (m.relations.length > before) restricted.set(k, m.relations[before]);
    return true;
  };
  const full = (curie: string) => NS[curie.split(':')[0] as keyof typeof NS] + curie.split(':')[1];

  // Named datatypes of the file. They are datatypes, and are kept from being taken for classes below.
  const datatypeIris = new Set(typed(NS.rdfs + 'Datatype').filter((d) => !d.startsWith(XSD) && !builtin(d)));
  const objProps = new Set(typed(NS.owl + 'ObjectProperty'));
  const annotationProps = new Set(typed(NS.owl + 'AnnotationProperty'));
  const dataProps = new Set(typed(NS.owl + 'DatatypeProperty').filter((p) => !objProps.has(p) && !annotationProps.has(p)));
  const propLabel = (p: string) => literal(p, NS.rdfs + 'label', NS.skos + 'prefLabel') || humanize(p, true);
  // Each object property's id in the model, made now: its uses are read before its declaration.
  const propIdOf = new Map([...objProps].map((p) => [p, uid()]));

  // Classes: declared ones first, then anything used in a class position.
  for (const type of [NS.owl + 'Class', NS.rdfs + 'Class', NS.skos + 'Concept']) {
    for (const c of typed(type)) {
      ensure(c, 'concept');
      mark(c, NS.rdf + 'type', type);
    }
  }
  for (const [s, preds] of spo) {
    for (const p of [NS.rdfs + 'subClassOf', NS.skos + 'broader', NS.skos + 'narrower', NS.owl + 'equivalentClass', NS.owl + 'disjointWith', NS.owl + 'complementOf']) {
      const os = named(preds.get(p) ?? []);
      if (!os.length) continue;
      if (!s.startsWith('_:') && !builtin(s) && !datatypeIris.has(s)) ensure(s, 'concept');
      os.filter((o) => !datatypeIris.has(o)).forEach((o) => ensure(o, 'concept'));
    }
  }
  for (const p of [...objProps, ...dataProps]) {
    for (const pred of objProps.has(p) ? ['domain', 'range'] : ['domain']) {
      objs(p, NS.rdfs + pred).flatMap(expand).forEach((c) => ensure(c, 'concept'));
    }
  }
  const classes = new Set(terms.keys());

  // Class expressions and data ranges are read as the structures they are (expressions.ts).
  const graph: Graph = {
    objects: (t, p) => objs(key(t), p),
    predicates: (t) => spo.get(key(t)) ?? new Map<string, N3Term[]>(),
    kind: (p) => (objProps.has(p) ? 'object' : dataProps.has(p) ? 'data' : undefined),
  };
  /** A class axiom with an expression: kept with the class, of the kind it was stated as, never merged with another. */
  const state = (c: string, kind: ClassAxiomKind, o: N3Term) => {
    const t = terms.get(c);
    if (t) t.classAxioms = [...(t.classAxioms ?? []), { id: uid(), kind, expression: readClass(graph, o) }];
  };
  /** Turns a restriction into a relationship if it is one of the kinds the app draws; says whether it did. */
  const drawRestriction = (c: string, o: N3Term): boolean => {
    const b = key(o);
    const prop = objs(b, NS.owl + 'onProperty')[0];
    if (!prop || prop.termType !== 'NamedNode') return false;
    // The restriction's quantifier, and for a cardinality its number.
    const card = (['min', 'max', 'exactly'] as const).find((q) => objs(b, NS.owl + (q === 'exactly' ? 'qualifiedCardinality' : q + 'QualifiedCardinality')).length);
    const how: Pick<Relation, 'restriction' | 'restrictionN'> = card
      ? { restriction: card, restrictionN: Number(objs(b, NS.owl + (card === 'exactly' ? 'qualifiedCardinality' : card + 'QualifiedCardinality'))[0].value) || 0 }
      : objs(b, NS.owl + 'allValuesFrom').length
        ? { restriction: 'only' }
        : {};
    const fillers = ['someValuesFrom', 'allValuesFrom', 'onClass', 'onDataRange'].flatMap((f) => objs(b, NS.owl + f));
    // Exactly one filler, and it has to be a name: a nested expression cannot be drawn as one line.
    if (fillers.length !== 1 || fillers[0].termType !== 'NamedNode') return false;
    if (dataProps.has(prop.value)) {
      // A line to a data property says nothing of the values but the property's range: it is written
      // back with that range, or rdfs:Literal where there is none. A restriction to another datatype
      // than that is not one, and stays an axiom of the class with its own filler.
      const ranges = objs(prop.value, NS.rdfs + 'range');
      const said = ranges.length === 1 && ranges[0].termType === 'NamedNode' ? ranges[0].value : ranges.length ? undefined : NS.rdfs + 'Literal';
      if (fillers[0].value !== said) return false;
      ensure(prop.value, 'property');
      return restrictBy(c, prop.value, 'property', '', how);
    }
    return objProps.has(prop.value) && classes.has(fillers[0].value) && restrictBy(c, fillers[0].value, 'association', propLabel(prop.value), how, propIdOf.get(prop.value));
  };

  /**
   * The individuals a class expression lists, if it is nothing but such a list: a blank node with
   * owl:oneOf and a well-formed RDF list of named things. Anything else gives undefined.
   */
  const enumerationOf = (o: N3Term): string[] | undefined => {
    const preds = spo.get(key(o));
    const head = preds?.get(NS.owl + 'oneOf');
    if (!preds || head?.length !== 1) return undefined;
    // Besides the list it may say that it is a class, and nothing more.
    for (const [p, os] of preds) if (p !== NS.owl + 'oneOf' && !(p === NS.rdf + 'type' && os.every((x) => x.value === NS.owl + 'Class' || x.value === NS.rdfs + 'Class'))) return undefined;
    const out: string[] = [];
    const seen = new Set<string>();
    for (let list = head[0]; list.value !== NS.rdf + 'nil'; ) {
      const cell = key(list);
      const first = objs(cell, NS.rdf + 'first');
      const rest = objs(cell, NS.rdf + 'rest');
      // A list that loops, forks, or holds something that is not a named individual is not one the editor can take.
      if (seen.has(cell) || first.length !== 1 || rest.length !== 1 || first[0].termType !== 'NamedNode' || builtin(first[0].value)) return undefined;
      seen.add(cell);
      if (!out.includes(first[0].value)) out.push(first[0].value);
      list = rest[0];
    }
    // A list of nothing says the class has no members at all. The editor writes nothing for an
    // enumeration until it lists something, so that one is kept as written instead.
    return out.length ? out : undefined;
  };
  const enumerations = new Map<string, string[]>();

  // Hierarchy and class-level relations.
  for (const c of classes) {
    for (const o of objs(c, NS.rdfs + 'subClassOf')) {
      // A named superclass is drawn; one that is no class of the model (owl:Thing) is an axiom.
      if (o.termType === 'NamedNode') {
        if (!relate(c, o.value, 'generalization')) state(c, 'SubClassOf', o);
        mark(c, NS.rdfs + 'subClassOf', o);
        continue;
      }
      // An anonymous superclass. The restrictions the app can draw become relationships; any
      // other class expression is an axiom of the class, so that nothing asserted is lost.
      if (!drawRestriction(c, o)) state(c, 'SubClassOf', o);
      markWith(c, NS.rdfs + 'subClassOf', o);
    }
    // A class disjoint with an expression (a named one is a relationship, below).
    for (const o of objs(c, NS.owl + 'disjointWith')) {
      if (o.termType !== 'BlankNode') continue;
      state(c, 'DisjointClasses', o);
      markWith(c, NS.owl + 'disjointWith', o);
    }
    for (const o of objs(c, NS.owl + 'equivalentClass')) {
      if (o.termType !== 'BlankNode') continue;
      // A class equivalent to a list of named individuals is an enumeration, which the app can edit.
      // The first such list is taken; any other expression is an axiom of the class.
      const listed = enumerations.has(c) ? undefined : enumerationOf(o);
      if (listed) enumerations.set(c, listed);
      else state(c, 'EquivalentClasses', o);
      markWith(c, NS.owl + 'equivalentClass', o);
    }
    for (const o of objs(c, NS.skos + 'broader')) if (o.termType === 'NamedNode' && relate(c, o.value, 'generalization')) mark(c, NS.skos + 'broader', o);
    for (const o of objs(c, NS.skos + 'narrower')) if (o.termType === 'NamedNode' && relate(o.value, c, 'generalization')) mark(c, NS.skos + 'narrower', o);
  }
  // Each object property is declared with what the file says about it. Only restrictions put
  // it between particular classes; a domain and range alone do not, so nothing is drawn for them.
  const propEntries = new Map<string, ObjProp>();
  const expandCurie = (curie: string) => (curie.startsWith('owl:') ? NS.owl : NS.rdfs) + curie.split(':')[1];
  const charOf = new Map(CHARACTERISTICS.map((c) => [NS.owl + c.owl.slice(4), c.id]));
  const others = (p: string, pred: string) => {
    const to = named(objs(p, pred)).filter((x) => objProps.has(x) && x !== p);
    for (const x of to) mark(p, pred, x);
    return [...new Set(to.map((x) => propIdOf.get(x)!))];
  };
  /**
   * A domain or range: an axiom for each statement of it, each read as it is stated and taken.
   * Two statements are two axioms, which hold together; they are never merged into one.
   */
  const axiomsOf = (p: string, pred: string): ClassAxiom[] =>
    objs(p, pred).map((o) => {
      markWith(p, pred, o);
      return { id: uid(), expression: readClass(graph, o) };
    });
  /**
   * Whether a domain or range says no more than where the property is used: one axiom, that is
   * the class the uses start from (point to), or the union of exactly those. It is then left to
   * follow its use, and written as it was for as long as the uses stay as they are.
   */
  const followsUse = (axioms: ClassAxiom[], usedIds: string[]) => {
    const named = axioms.length === 1 ? classesOfUnion(axioms[0].expression) : undefined;
    const used = new Set(usedIds.map((id) => m.terms.find((t) => t.id === id)?.iri));
    return !!named && named.length === used.size && named.every((iri) => used.has(iri));
  };
  for (const p of objProps) {
    const domains = axiomsOf(p, NS.rdfs + 'domain');
    const ranges = axiomsOf(p, NS.rdfs + 'range');
    const entry: ObjProp = {
      id: propIdOf.get(p)!,
      ...nameOf(p, [NS.rdfs + 'label', NS.skos + 'prefLabel'], humanize(p, true)),
      iri: p,
      ...describe(p, [NS.skos + 'definition', NS.rdfs + 'comment'], 'skos:definition'),
      chars: objs(p, NS.rdf + 'type').map((o) => charOf.get(o.value)).filter((c): c is string => !!c),
    };
    mark(p, NS.rdf + 'type', NS.owl + 'ObjectProperty');
    for (const o of objs(p, NS.rdf + 'type')) if (charOf.has(o.value)) mark(p, NS.rdf + 'type', o);
    // A domain or range that only repeats where the property is used is left to follow its use.
    const uses = m.relations.filter((r) => r.prop === entry.id);
    if (domains.length && !followsUse(domains, uses.map((r) => r.from))) entry.domains = domains;
    if (ranges.length && !followsUse(ranges, uses.map((r) => r.to))) entry.ranges = ranges;
    for (const link of PROP_LINKS) {
      const ids = others(p, expandCurie(LINK_PREDICATE[link]));
      // Kept on whichever property the file states it, even where both do: nothing stated is dropped.
      if (ids.length) entry[link] = ids;
    }
    m.props.push(entry);
    propEntries.set(p, entry);
  }

  // Data properties become property terms. Only a restriction attaches one to a class (above);
  // a domain that says more than "the classes that have it" is kept as the property's domain.
  /**
   * The literals a data range lists, if it is nothing but such a list: a blank node with
   * owl:oneOf and a well-formed RDF list of literals. Anything else gives undefined.
   */
  const literalsOf = (o: N3Term): EnumLiteral[] | undefined => {
    const preds = o.termType === 'BlankNode' ? spo.get(key(o)) : undefined;
    const head = preds?.get(NS.owl + 'oneOf');
    if (!preds || head?.length !== 1) return undefined;
    for (const [p, os] of preds) if (p !== NS.owl + 'oneOf' && !(p === NS.rdf + 'type' && os.every((x) => x.value === NS.rdfs + 'Datatype'))) return undefined;
    const out: EnumLiteral[] = [];
    const seen = new Set<string>();
    for (let list = head[0]; list.value !== NS.rdf + 'nil'; ) {
      const cell = key(list);
      const first = objs(cell, NS.rdf + 'first');
      const rest = objs(cell, NS.rdf + 'rest');
      if (seen.has(cell) || first.length !== 1 || rest.length !== 1 || first[0].termType !== 'Literal') return undefined;
      seen.add(cell);
      const lit = first[0];
      const iri = lit.datatype?.value;
      // Text has no datatype to speak of; a standard one goes by its short name, any other by its IRI.
      const dt = lit.language || !iri || iri === XSD + 'string' || iri === NS.rdf + 'langString' ? undefined : iri.startsWith(XSD) ? 'xsd:' + iri.slice(XSD.length) : `<${iri}>`;
      const value: EnumLiteral = { value: lit.value, ...(dt ? { dt } : {}), ...(lit.language ? { lang: lit.language } : {}) };
      if (!out.some((x) => x.value === value.value && x.dt === value.dt && x.lang === value.lang)) out.push(value);
      list = rest[0];
    }
    return out.length ? out : undefined;
  };
  // A named datatype that is defined as a list of literals is an enumerated datatype. One defined
  // any other way (by facets, say) is not something the app has an editor for, and is not taken in.
  const datatypeOfIri = new Map<string, EnumDatatype>();
  for (const iri of datatypeIris) {
    const listing = objs(iri, NS.owl + 'equivalentClass').find((o) => literalsOf(o));
    const values = listing && literalsOf(listing);
    if (!listing || !values) continue;
    mark(iri, NS.rdf + 'type', NS.rdfs + 'Datatype');
    markWith(iri, NS.owl + 'equivalentClass', listing);
    const d: EnumDatatype = { id: 'd' + m.datatypes.length + '-' + iri.replace(/[^A-Za-z0-9]+/g, '').slice(-24), ...nameOf(iri, [NS.rdfs + 'label', NS.skos + 'prefLabel'], humanize(iri, false)), ...describe(iri, [NS.skos + 'definition', NS.rdfs + 'comment'], 'skos:definition'), values, iri };
    m.datatypes.push(d);
    datatypeOfIri.set(iri, d);
  }
  for (const p of dataProps) {
    const t = ensure(p, 'property');
    mark(p, NS.rdf + 'type', NS.owl + 'DatatypeProperty');
    // Its range: an axiom for each statement, as for an object property. One that is an
    // enumerated datatype (one with a name, or a list of literals written in place) names it.
    const ranges: DataRangeAxiom[] = [];
    for (const o of objs(p, NS.rdfs + 'range')) {
      markWith(p, NS.rdfs + 'range', o);
      let d = o.termType === 'NamedNode' ? datatypeOfIri.get(o.value) : undefined;
      const inline = d ? undefined : literalsOf(o);
      if (inline) {
        const nth = m.datatypes.filter((x) => x.id.endsWith('-' + t.id)).length;
        d = { id: 'd' + m.datatypes.length + '-' + t.id, name: `${t.name} values${nth ? ' ' + (nth + 1) : ''}`, description: '', values: inline, anonymous: true };
        m.datatypes.push(d);
      }
      ranges.push({ id: uid(), range: d ? { type: 'Enumeration', datatype: d.id } : readDataRange(graph, o) });
    }
    if (ranges.length) t.ranges = ranges;
    if (objs(p, NS.rdf + 'type').some((o) => o.value === NS.owl + 'FunctionalProperty')) {
      t.functional = true;
      mark(p, NS.rdf + 'type', NS.owl + 'FunctionalProperty');
    }
    const domains = axiomsOf(p, NS.rdfs + 'domain');
    const owners = [...new Set(m.relations.filter((r) => r.kind === 'property' && r.to === t.id).map((r) => r.from))];
    if (domains.length && !followsUse(domains, owners)) t.domains = domains;
  }
  for (const p of dataProps) for (const o of objs(p, NS.rdfs + 'subPropertyOf')) if (o.termType === 'NamedNode' && relate(p, o.value, 'generalization')) mark(p, NS.rdfs + 'subPropertyOf', o);

  // Individuals and the facts stated about them.
  for (const [s, preds] of spo) {
    if (s.startsWith('_:') || terms.has(s)) continue;
    const types = named(preds.get(NS.rdf + 'type') ?? []);
    const isIndividual = (preds.get(NS.rdf + 'type') ?? []).some((o) => o.value === NS.owl + 'NamedIndividual');
    if (!isIndividual && !types.some((t) => classes.has(t))) continue;
    ensure(s, 'instance');
    if (isIndividual) mark(s, NS.rdf + 'type', NS.owl + 'NamedIndividual');
    for (const t of types) {
      // What a declared individual is an instance of is a class, even if the file says nothing else about it.
      if (isIndividual && !terms.has(t) && !objProps.has(t) && !dataProps.has(t) && !annotationProps.has(t)) {
        ensure(t, 'concept');
        classes.add(t);
      }
      // Only membership of a class is one: owl:NamedIndividual and the like are declarations, not memberships.
      if (classes.has(t) && relate(s, t, 'generalization')) mark(s, NS.rdf + 'type', t);
    }
  }
  // The members of an enumeration are individuals, whether or not the file declares them as such.
  // One that is something else already (a class, say) is listed all the same, and left for validation to point out.
  for (const [c, listed] of enumerations) {
    const cls = terms.get(c);
    if (!cls) continue;
    cls.oneOf = [...new Set(listed.map((iri) => (terms.get(iri) ?? ensure(iri, 'instance')).id))].filter((id) => id !== cls.id);
  }
  const datatypeId = (iri?: string) => (iri?.startsWith(XSD) ? 'xsd:' + iri.slice(XSD.length) : iri === NS.rdf + 'langString' ? 'rdf:langString' : undefined);
  for (const [s, preds] of spo) {
    const subject = terms.get(s);
    if (!subject) continue;
    for (const [p, os] of preds) {
      if (objProps.has(p)) for (const o of os) if (o.termType === 'NamedNode' && !builtin(o.value) && relate(s, o.value, 'association', propLabel(p), undefined, { prop: propIdOf.get(p)! })) mark(s, p, o);
      // The literal values an individual has for a data property.
      const prop = dataProps.has(p) ? terms.get(p) : undefined;
      if (!prop || subject.type !== 'instance') continue;
      for (const o of os) {
        if (o.termType !== 'Literal') continue;
        const dt = datatypeId(o.datatype?.value);
        // Its own datatype, where it is not the property's: one the editor offers, or any other of XML Schema's, kept as it is.
        const own = dt && dt !== 'xsd:string' && dt !== 'rdf:langString' && dt !== propDatatype(prop) && (DATATYPES.some((d) => d.id === dt) || dt.startsWith('xsd:')) ? dt : undefined;
        const value: DataValue = { prop: prop.id, value: o.value, ...(o.language ? { lang: o.language } : {}), ...(own ? { dt: own } : {}) };
        subject.values = [...(subject.values ?? []), value];
        mark(s, p, o);
      }
    }
  }
  // "All of these are different" (or disjoint) written as one list is the same as saying it of each pair.
  const members = (node: string, ...preds: string[]): string[] => {
    const out: string[] = [];
    for (const pred of preds) {
      for (let list = objs(node, pred)[0], guard = 0; list && list.value !== NS.rdf + 'nil' && guard < 5000; guard++) {
        out.push(...objs(key(list), NS.rdf + 'first').filter((t) => t.termType === 'NamedNode').map((t) => t.value));
        list = objs(key(list), NS.rdf + 'rest')[0];
      }
    }
    return [...new Set(out)];
  };
  /** The relationships that are pairs of an axiom of many members, by the IRIs of their ends and their property. */
  const grouped = new Map<string, Relation>();
  const pairwise = (type: string, predicate: string, ...lists: string[]) => {
    for (const node of [...spo.keys()].filter((n) => objs(n, NS.rdf + 'type').some((o) => o.value === NS.owl + type))) {
      const all = members(node, ...lists.map((l) => NS.owl + l));
      // "All different" said of exactly the members of an enumeration belongs to that enumeration:
      // it is kept as one statement there, not as a relationship between every two members.
      // Read as one statement or as pairs, it is taken.
      markTree({ termType: node.startsWith('_:') ? 'BlankNode' : 'NamedNode', value: node.startsWith('_:') ? node.slice(2) : node });
      if (type === 'AllDifferent') {
        const set = new Set(all.map((iri) => terms.get(iri)?.id));
        const owner = m.terms.find((t) => t.oneOf && t.oneOf.length === set.size && t.oneOf.length > 1 && t.oneOf.every((id) => set.has(id)));
        if (owner) {
          owner.allDifferent = true;
          continue;
        }
      }
      // The pairs of an axiom of more than two members remember it, so that it is written back as the one axiom it was.
      const group = all.length > 2 && predicate !== 'owl:propertyDisjointWith' ? uid() : undefined;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const [a, b] = [propEntries.get(all[i]), propEntries.get(all[j])];
          if (a && b && predicate === 'owl:propertyDisjointWith') {
            if (a !== b && !a.disjoints?.includes(b.id) && !b.disjoints?.includes(a.id)) a.disjoints = [...(a.disjoints ?? []), b.id];
          } else if (terms.has(all[i]) && terms.has(all[j]) && !relKeys.has(`${all[j]}|${all[i]}|association||${predicate}|`)) {
            const before = m.relations.length;
            if (relate(all[i], all[j], 'association', '', predicate)) m.vocab.enabled = true;
            if (group && m.relations.length > before) {
              m.relations[before].group = group;
              grouped.set(`${all[i]}|${all[j]}|${predicate}`, m.relations[before]);
            }
          }
        }
      }
    }
  };
  pairwise('AllDisjointClasses', 'owl:disjointWith', 'members');
  pairwise('AllDifferent', 'owl:differentFrom', 'distinctMembers', 'members');
  pairwise('AllDisjointProperties', 'owl:propertyDisjointWith', 'members');

  // Statements made with a plain rdf:Property are relationships nobody has classified yet.
  const plainProps: string[] = [];
  for (const p of typed(NS.rdf + 'Property')) {
    if (objProps.has(p) || dataProps.has(p) || annotationProps.has(p)) continue;
    let drawnAny = false;
    for (const [sub, preds] of spo) {
      // Marked plain, so that it stays one even if an object property has the same name.
      if (!terms.has(sub)) continue;
      for (const o of preds.get(p) ?? []) {
        if (o.termType !== 'NamedNode' || builtin(o.value) || !relate(sub, o.value, 'association', propLabel(p), undefined, { plain: true })) continue;
        mark(sub, p, o);
        drawnAny = true;
      }
    }
    // The property is then the relationships' label, and declared again when they are written.
    if (drawnAny) {
      mark(p, NS.rdf + 'type', NS.rdf + 'Property');
      take(p, NS.rdfs + 'label', NS.skos + 'prefLabel');
      plainProps.push(p);
    }
  }

  // Other RDFS/OWL statements between known terms keep their standard property. The hierarchy
  // ones were read above, and a datatype property's domain is already its "has property" relation.
  const handled = new Set(['rdfs:subClassOf', 'rdf:type', 'rdfs:domain', 'skos:broader']);
  for (const sp of STD_PROPS) {
    if (handled.has(sp.id)) continue;
    for (const [s, preds] of spo) {
      if (!terms.has(s)) continue;
      for (const o of named(preds.get(full(sp.id)) ?? [])) {
        // Said already as a sub-property, or the other way round for a symmetric one: taken, once.
        if (sp.id === 'rdfs:subPropertyOf' && relKeys.has(`${s}|${o}|generalization|||`)) {
          mark(s, full(sp.id), o);
          continue;
        }
        // A pair of an axiom of many members, stated on its own as well: it is written so too.
        const pairOf = grouped.get(`${s}|${o}|${sp.id}`) ?? (sp.symmetric ? grouped.get(`${o}|${s}|${sp.id}`) : undefined);
        if (pairOf) {
          pairOf.statedAlone = true;
          mark(s, full(sp.id), o);
          continue;
        }
        // A symmetric statement is often written in both directions; one relation is enough.
        if (sp.symmetric && relKeys.has(`${o}|${s}|association||${sp.id}|`)) {
          mark(s, full(sp.id), o);
          continue;
        }
        if (relate(s, o, 'association', '', sp.id)) mark(s, full(sp.id), o);
        if (sp.vocab === 'owl' || sp.id.endsWith('Match')) m.vocab.enabled = true;
      }
    }
  }

  // Remaining annotations on a term become its metadata fields.
  const curieNs: Record<string, string> = { rdfs: NS.rdfs, owl: NS.owl, skos: NS.skos, dcterms: NS.dct };
  const known = new Map(ANNOTATION_PROPS.map((p) => [curieNs[p.id.split(':')[0]] + p.id.split(':')[1], p.id]));
  known.set(NS.rdfs + 'label', 'rdfs:label');
  // The catalogue vocabularies (Dublin Core, DCAT, PROV, DQV, ADMS) are metadata wherever they occur.
  const META_NS = STANDARD.filter((p) => ['dcterms', 'dcat', 'prov', 'dqv', 'adms'].includes(p.prefix));
  const QM = META_NS.find((p) => p.prefix === 'dqv')!.iri;
  // Statements between two terms that were drawn as relationships above are not annotations as well.
  const plainRel = new Set(typed(NS.rdf + 'Property').filter((p) => !objProps.has(p) && !dataProps.has(p) && !annotationProps.has(p)));
  const stdRel = new Set(STD_PROPS.map((sp) => full(sp.id)));
  const drawn = (pred: string) => stdRel.has(pred) || objProps.has(pred) || plainRel.has(pred);
  // The file's own namespace: its default prefix, or failing that (RDF/XML has none) the one most
  // of its terms are in, which becomes the model's base IRI below.
  const nsOf = (iri: string) => iri.slice(0, Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
  const nsCount = new Map<string, number>();
  for (const iri of terms.keys()) nsCount.set(nsOf(iri), (nsCount.get(nsOf(iri)) ?? 0) + 1);
  const defaultNs = declared.get('') ?? [...nsCount].sort((a, b) => b[1] - a[1])[0]?.[0];
  /** Whether a property is one of the file's own: in its namespace, or anywhere if it has none. */
  const own = (iri: string) => defaultNs === undefined || iri.startsWith(defaultNs);
  /** A property of another vocabulary keeps its identity: its prefixed name where the file has a prefix for it, or else its IRI. */
  const byIri = (iri: string): string => {
    const prefix = [...declared].find(([name, ns]) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name) && !STANDARD.some((p) => p.prefix === name || p.iri === ns) && iri.startsWith(ns) && /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(iri.slice(ns.length)));
    return prefix ? `${prefix[0]}:${iri.slice(prefix[1].length)}` : iri;
  };
  /** The name an annotation property is filed under: a standard prefixed name, its label, or failing that its IRI. */
  const annotationKey = (pred: string): string | undefined => {
    const std = known.get(pred);
    if (std) return std;
    // Not where the file itself declares the property an object or data property: there its
    // statements are relationships and values, and it is exported as the property it is.
    const ns = objProps.has(pred) || dataProps.has(pred) ? undefined : META_NS.find((p) => pred.startsWith(p.iri) && /^[A-Za-z][\w-]*$/.test(pred.slice(p.iri.length)));
    if (ns) return `${ns.prefix}:${pred.slice(ns.iri.length)}`;
    if (!annotationProps.has(pred)) return undefined;
    // A property of the file's own namespace goes by its name. Any other keeps its IRI, label or
    // not, so that it is written back as the property it is and not as one of this ontology's.
    return own(pred) ? propLabel(pred) : byIri(pred);
  };
  const typedValue = (o: N3Term): Pick<ExtraField, 'lang' | 'dt' | 'iri'> => {
    if (o.termType === 'NamedNode') return { iri: true };
    if (o.language) return { lang: o.language };
    const dt = o.datatype?.value.startsWith(XSD) ? 'xsd:' + o.datatype.value.slice(XSD.length) : undefined;
    if (dt && dt !== 'xsd:string') return { dt };
    // Text that looks like a link is text all the same: it is written back as text, not as the link it looks like.
    return LINK_TEXT.test(o.value) ? { iri: false } : {};
  };
  /**
   * A property a field was read with: its declaration is taken, and so is its label where the
   * field is filed under it. That is how they are written back.
   */
  const declaredAs = (pred: string, key_: string, type = NS.owl + 'AnnotationProperty') => {
    // The standard vocabularies' own are not declared again when written, so a declaration of one is kept as it was.
    if (![NS.rdfs, NS.owl, NS.skos, NS.dct].some((ns) => pred.startsWith(ns))) mark(pred, NS.rdf + 'type', type);
    if (key_ === literal(pred, NS.rdfs + 'label', NS.skos + 'prefLabel')) take(pred, NS.rdfs + 'label', NS.skos + 'prefLabel');
  };
  const annotated: [string, { name: string; description: string; fields?: ExtraField[] }][] = [...terms, ...propEntries];
  for (const [iri, t] of annotated) {
    for (const [pred, os] of spo.get(iri) ?? []) {
      if (pred === QM + 'hasQualityMeasurement') {
        // Quality measurements (DQV): each is filed under the metric it measures.
        for (const o of os) {
          const metric = objs(key(o), QM + 'isMeasurementOf').find((x) => x.termType === 'NamedNode');
          const value = objs(key(o), QM + 'value')[0];
          if (!metric || !value || value.termType === 'BlankNode') continue;
          const metricKey = annotationKey(metric.value) ?? (own(metric.value) ? propLabel(metric.value) : byIri(metric.value));
          (t.fields ??= []).push({ key: metricKey, value: value.value, ...typedValue(value), measure: true });
          markWith(iri, pred, o);
          declaredAs(pred, '');
          declaredAs(metric.value, metricKey, QM + 'Metric');
        }
        continue;
      }
      const key_ = annotationKey(pred);
      if (!key_) continue;
      for (const o of os) {
        // A statement between two terms of the model that is a relationship was drawn as one.
        if (o.termType === 'BlankNode' || (o.termType === 'NamedNode' && terms.has(o.value) && drawn(pred))) continue;
        // The statement that became the name, the description or a synonym isn't repeated. The same
        // words said again with another property, or in another language, are another statement,
        // and are kept as an annotation.
        if (used.has(quadKey(iri, pred, o))) continue;
        mark(iri, pred, o);
        declaredAs(pred, key_);
        const typed_ = typedValue(o);
        // A link given for one of the linking properties is written back as a link in any case.
        const plainLink = typed_.iri && LINKS.has(key_) && /^https?:\/\//.test(o.value) && !terms.has(o.value);
        // owl:deprecated is written as a boolean whatever it was typed as.
        (t.fields ??= []).push({ key: key_, value: o.value, ...(plainLink || key_ === 'owl:deprecated' ? {} : typed_) });
      }
    }
  }

  // A file of SKOS concepts is a concept scheme; anything else is read as an ontology.
  if (typed(NS.skos + 'Concept').length > typed(NS.owl + 'Class').length) m.mode = 'skos';
  const header = m.mode === 'skos' ? (typed(NS.skos + 'ConceptScheme')[0] ?? typed(NS.owl + 'Ontology')[0]) : typed(NS.owl + 'Ontology')[0];
  if (header) {
    // The ontology's own name and description, with the property and the language they were written with.
    const NAMED: Record<string, NameProperty> = { [NS.skos + 'prefLabel']: 'skos:prefLabel', [NS.rdfs + 'label']: 'rdfs:label', [NS.dct + 'title']: 'dcterms:title' };
    const title = takeFrom(header, NS.skos + 'prefLabel', NS.rdfs + 'label', NS.dct + 'title');
    if (title) {
      m.name = title.value;
      if (NAMED[title.pred] !== (m.mode === 'skos' ? 'skos:prefLabel' : 'rdfs:label')) m.namedBy = NAMED[title.pred];
      if (title.lang !== pref) m.nameLang = title.lang;
    }
    const said = describe(header, [NS.dct + 'description', NS.rdfs + 'comment', NS.skos + 'definition'], m.mode === 'skos' ? 'dcterms:description' : 'rdfs:comment');
    m.description = said.description;
    if (said.describedBy) m.describedBy = said.describedBy;
    if (said.descriptionLang !== undefined) m.descriptionLang = said.descriptionLang;
    for (const type of [NS.owl + 'Ontology', NS.skos + 'ConceptScheme']) mark(header, NS.rdf + 'type', type);
  }
  // Most common namespace among the terms becomes the model's base IRI.
  const counts = new Map<string, number>();
  for (const iri of terms.keys()) {
    const ns = iri.slice(0, Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  // The file's default prefix is its default namespace; failing that, the namespace most terms are in.
  m.baseIri = declared.get('') ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  for (const [prefix, ns] of declared) {
    // The namespace of XML itself, which the OWL API and Protégé declare in every file they write, abbreviates nothing in an ontology.
    const standard = ns === 'http://www.w3.org/XML/1998/namespace' || STANDARD.some((p) => p.prefix === prefix || p.iri === ns);
    if (prefix && !standard && /^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix) && !m.prefixes.some((p) => p.iri === ns)) m.prefixes.push({ prefix, iri: ns });
  }
  if (header && !header.startsWith('_:')) m.ontologyIri = header;
  // Ontologies this one imports are dependencies. Their content is not in the file, so they are
  // recorded as known by IRI only until the user supplies them.
  if (header) mark(header, NS.owl + 'imports');
  // In a vocabulary a relationship of its own is a kind of skos:related, and written so.
  if (m.mode === 'skos') for (const p of plainProps) mark(p, NS.rdfs + 'subPropertyOf', NS.skos + 'related');
  // In a concept scheme, which concepts are in it and which are at its top follow from the
  // hierarchy, and are written so: taken, as the hierarchy is.
  if (header && m.mode === 'skos') {
    mark(header, NS.skos + 'hasTopConcept');
    for (const c of terms.keys()) {
      for (const p of ['inScheme', 'topConceptOf']) for (const o of objs(c, NS.skos + p)) if (o.value === header) mark(c, NS.skos + p, o);
    }
  }
  for (const o of header ? named(objs(header, NS.owl + 'imports')) : []) {
    m.externals.push({ id: 'x' + m.externals.length + '-' + o.replace(/[^A-Za-z0-9]+/g, '').slice(-24), name: humanize(o.replace(/[#/]$/, ''), false), iri: o, namespace: /[#/]$/.test(o) ? o : o + '#', source: '', sourceKind: 'unknown', addedAt: 0, classes: 0, objectProperties: 0, dataProperties: 0, individuals: 0, imports: true });
  }
  // An entity outside the default namespace of which the file says nothing but what kind of
  // thing it is, is one it refers to rather than defines: an entity of another ontology.
  const ownedBy = (iri: string) => m.externals.find((e) => iri.startsWith(e.namespace) || iri.startsWith(e.iri))?.id ?? '';
  const onlyDeclared = (iri: string) => [...(spo.get(iri)?.keys() ?? [])].every((p) => p === NS.rdf + 'type');
  if (m.baseIri) {
    for (const [iri, t] of terms) if (!iri.startsWith(m.baseIri) && onlyDeclared(iri)) t.external = ownedBy(iri);
    for (const [iri, p] of propEntries) if (!iri.startsWith(m.baseIri) && onlyDeclared(iri) && !p.domains && !p.ranges) p.external = ownedBy(iri);
  }

  // What it took nothing from is kept, a whole statement at a time: one taken in part already has
  // its place in the model, and is not said a second time.
  const kept = statements(quads).filter((st) => st.quads.every((q) => !used.has(quadKey(key(q.subject), q.predicate.value, q.object))));
  if (kept.length) m.unmapped = kept.map((st) => st.text).sort().join('\n') + '\n';

  arrangeAsHierarchy(m);
  return m;
}

// ---------------------------------------------------------------- triples

export interface Triple {
  s: string;
  p: string;
  o: string;
  /** The object is a literal rather than a resource. */
  literal: boolean;
}

/** The model as flat subject–predicate–object statements, with IRIs shortened to prefixed names. */
export function toTriples(m: Model): Triple[] {
  const short = (t: N3Term): string => {
    if (t.termType === 'BlankNode') return '_:' + t.value.replace(/^.*?(b\d+)$/, '$1');
    if (t.termType === 'Literal') return JSON.stringify(t.value);
    if (t.value === NS.rdf + 'type') return 'a';
    return compactIri(m, t.value) ?? `<${t.value}>`;
  };
  const quads = new Parser().parse(toTurtle(m)) as unknown as { subject: N3Term; predicate: N3Term; object: N3Term }[];
  return quads.map((q) => ({ s: short(q.subject), p: short(q.predicate), o: short(q.object), literal: q.object.termType === 'Literal' }));
}

/** Prefixes used by the exports and offered to queries, as [prefix, namespace] pairs; the empty prefix is the default namespace. */
export function prefixesOf(m: Model): [string, string][] {
  return allPrefixes(m).map((p): [string, string] => [p.prefix, p.iri]);
}

/** Full IRI of each term in the exports, mapped back to the term's id. */
/** What a reasoner entails beyond what the model states, to be written out as triples of their own. */
export interface Materialized {
  /** Class memberships: an individual and a class, by term id. */
  types: { individual: string; class: string }[];
  /** Relationships between individuals: by term id, with the key of the object property. */
  facts: { from: string; prop: string; to: string }[];
  /** Which reasoner worked them out, for saying so in the file. */
  by: string;
  /** Anything to add about how far the reasoning went. */
  notes?: string[];
  at?: Date;
}

/**
 * The ontology as Turtle, followed by assertions a reasoner entails: inferred class memberships
 * and inferred relationships between individuals, written as the triples that would state them.
 *
 * The asserted ontology comes first and is exactly what toTurtle writes. The inferred triples
 * follow it under a heading that says what they are, each once and none that is already stated.
 * RDF itself cannot mark a triple as inferred: to whatever reads the file, they are assertions.
 * So this is something to ask for, not what an export is by default.
 */
export function toTurtleWithInferred(m: Model, inferred: Materialized): string {
  const { ref, propRef } = toRdf(m);
  const lines = new Set<string>();
  for (const t of inferred.types) if (ref.has(t.individual) && ref.has(t.class)) lines.add(`${ref.get(t.individual)} a ${ref.get(t.class)} .`);
  for (const f of inferred.facts) if (ref.has(f.from) && ref.has(f.to) && propRef.has(f.prop)) lines.add(`${ref.get(f.from)} ${propRef.get(f.prop)} ${ref.get(f.to)} .`);
  const rule = '# ' + '-'.repeat(86);
  const say = (text: string) => text.match(/.{1,84}(\s|$)/g)!.map((l) => `# ${l.trim()}`);
  const types = [...lines].filter((l) => / a [^ ]+ \.$/.test(l)).length;
  const head = [
    rule,
    ...say(`Inferred assertions, materialized on export: ${types} class membership${types === 1 ? '' : 's'} and ${lines.size - types} relationship${lines.size - types === 1 ? '' : 's'} between individuals.`),
    ...say(`They follow from the ontology above and are not asserted in the model it was exported from. Worked out by ${inferred.by} on ${(inferred.at ?? new Date()).toISOString().slice(0, 10)}.`),
    ...(inferred.notes ?? []).flatMap(say),
    ...(lines.size ? [] : say('Nothing follows beyond what is asserted.')),
    rule,
  ];
  return `${toTurtle(m).replace(/\n+$/, '')}\n\n${head.join('\n')}\n${lines.size ? '\n' + [...lines].join('\n') + '\n' : ''}`;
}

export function termIris(m: Model): Map<string, string> {
  return entityIris(m).terms;
}

/**
 * The IRI each entity is written with, the other way round: from an IRI in the exported RDF to
 * the term or the object property (by id) it stands for. This is how what a reasoner
 * says about the RDF is found again in the editor.
 */
export function entityIris(m: Model): { terms: Map<string, string>; props: Map<string, string> } {
  const { base, ref, propRef } = toRdf(m);
  const full = (r: string) => (r.startsWith('<') ? r.slice(1, -1) : (expandIri(m, r) ?? base + r.slice(1)));
  const terms = new Map<string, string>();
  const props = new Map<string, string>();
  for (const [id, r] of ref) terms.set(full(r), id);
  for (const [key, r] of propRef) props.set(full(r), key);
  return { terms, props };
}
