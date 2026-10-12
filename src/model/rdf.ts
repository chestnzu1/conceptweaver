import { Parser } from 'n3';
import { ANNOTATION_PROPS, standardAnnotation } from './annotations';
import { baseIriOf, localName } from './iri';
import { hierarchyLayout } from './layout';
import { DATATYPES, ENUM_RANGE, emptyModel, newRelation, newTerm, PROP_LINKS, type DataValue, type EnumDatatype, type EnumLiteral, type ExtraField, type Model, type ObjProp, type PropLink, type Relation, type RestrictionSpec, type Term } from './types';
import { allPrefixes, compactIri, expandIri, isAbsoluteIri, ontologyIriOf, STANDARD } from './prefixes';
import { enumOf, isEnumRange } from './datatypes';
import { keyIri } from './governance';
import { CHARACTERISTICS, dataDomain, DEFAULT_PROP, objectProperties, propKey, restrictionSpecs, specsPatch } from './props';
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

/** Annotation properties whose value is written as a link when it is a URL. */
const LINKS = new Set(['skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch', 'rdfs:seeAlso', 'rdfs:isDefinedBy', 'dcterms:source', 'owl:priorVersion', 'owl:backwardCompatibleWith', 'owl:incompatibleWith']);

// ---------------------------------------------------------------- export

/** `raw` is Turtle kept word for word: a class expression the app has no structure for. */
type Val = { id: string } | { lit: string; bool?: boolean; lang?: string; dt?: string } | { bnode: RdfNode } | { list: Val[] } | { raw: string };
/** `id` is a CURIE (":Movie", "owl:Class") or a full IRI in angle brackets. */
interface RdfNode {
  id: string;
  props: [string, Val][];
}

function toRdf(model: Model): { base: string; nodes: RdfNode[]; ref: Map<string, string>; propRef: Map<string, string> } {
  const m = resolveModel(model);
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
  const text = (value: string): Val => (m.lang ? { lit: value, lang: m.lang } : { lit: value });
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
      else if (LINKS.has(pred) && /^https?:\/\/[^\s<>"]+$/.test(value)) n.props.push([pred, { id: `<${value}>` }]);
      else n.props.push([pred, literalOf(f, value)]);
    }
  };
  const nodes = new Map<string, RdfNode>();

  if (m.mode === 'skos') {
    // A SKOS concept scheme: every term is a concept in it, "is a" is skos:broader.
    const scheme: RdfNode = { id: modelIri, props: [['rdf:type', { id: 'skos:ConceptScheme' }], ['skos:prefLabel', text(m.name)]] };
    if (m.description) scheme.props.push(['dcterms:description', text(m.description)]);
    for (const t of m.terms) {
      // A concept of another scheme is referred to, not described: it is not in this scheme.
      if (t.external !== undefined) {
        nodes.set(t.id, { id: ref.get(t.id)!, props: [['rdf:type', { id: 'skos:Concept' }]] });
        continue;
      }
      const n: RdfNode = { id: ref.get(t.id)!, props: [['rdf:type', { id: 'skos:Concept' }], ['skos:prefLabel', text(t.name)]] };
      if (t.description) n.props.push(['skos:definition', text(t.description)]);
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

  const ontology: RdfNode = { id: modelIri, props: [['rdf:type', { id: 'owl:Ontology' }], ['rdfs:label', text(m.name)]] };
  if (m.description) ontology.props.push(['rdfs:comment', text(m.description)]);
  // Dependencies: the ontologies whose axioms this one takes over. Their content is not written here.
  for (const e of m.externals) if (e.imports && e.iri) ontology.props.push(['owl:imports', { id: `<${e.iri}>` }]);

  for (const t of m.terms) {
    const type = t.type === 'concept' ? 'owl:Class' : t.type === 'property' ? 'owl:DatatypeProperty' : 'owl:NamedIndividual';
    const n: RdfNode = { id: ref.get(t.id)!, props: [['rdf:type', { id: type }], ['rdfs:label', text(t.name)]] };
    // An entity of another ontology is only declared: its label and definition are that ontology's to state.
    if (t.external !== undefined) {
      nodes.set(t.id, { id: n.id, props: [n.props[0]] });
      continue;
    }
    if (t.description) n.props.push(['skos:definition', text(t.description)]);
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
      props: [['rdf:type', { id: 'rdfs:Datatype' }], ['rdfs:label', text(d.name)], ...(d.description ? [['skos:definition', text(d.description)] as [string, Val]] : []), ...(d.values.length ? [['owl:equivalentClass', literalList(d)] as [string, Val]] : [])],
    }));
  /** A range as it is written: a standard datatype or a named one by name, a nameless enumeration as its list. */
  const rangeVal = (range: string | undefined): Val | undefined => {
    if (!range) return undefined;
    if (!isEnumRange(range)) return { id: range };
    const d = enumOf(m, range);
    if (!d) return undefined;
    return d.anonymous ? (d.values.length ? literalList(d) : undefined) : { id: datatypeRef.get(d.id)! };
  };

  // Associations become object properties, one per distinct label.
  // Several domains (or ranges) mean "any of these", which OWL writes as a union; listing them
  // one by one would mean "all of these at once".
  const classes = (refs: string[]): Val =>
    // Sorted, so that the same set always reads the same whatever order it was built in.
    refs.length === 1 ? { id: refs[0] } : { bnode: { id: '', props: [['rdf:type', { id: 'owl:Class' }], ['owl:unionOf', { list: [...refs].sort().map((id) => ({ id })) }]] } };

  // Object properties: each is declared once, with its domain, range and characteristics, and
  // the relationships between terms are uses of it.
  const views = objectProperties(m);
  const propRef = new Map<string, string>();
  for (const v of views) if (v.iri) propRef.set(v.key, short(v.iri));
  for (const v of views) if (!v.iri) propRef.set(v.key, ':' + unique(localName(v.name, true)));
  const objProps: RdfNode[] = views.map((v) => {
    const n: RdfNode = { id: propRef.get(v.key)!, props: [['rdf:type', { id: 'owl:ObjectProperty' }]] };
    for (const c of CHARACTERISTICS) if (v.chars.includes(c.id)) n.props.push(['rdf:type', { id: c.owl }]);
    if (v.external === undefined) {
      n.props.push(['rdfs:label', text(v.name)]);
      if (v.description) n.props.push(['skos:definition', text(v.description)]);
      annotate(n, v);
    }
    for (const link of PROP_LINKS) for (const k of v[link]) if (propRef.has(k)) n.props.push([LINK_PREDICATE[link], { id: propRef.get(k)! }]);
    // Where an external property is used here says nothing about its domain or range; only one set by hand is stated.
    if (v.domain.length && !(v.external !== undefined && v.domainAuto)) n.props.push(['rdfs:domain', classes(v.domain.map((id) => ref.get(id)!))]);
    if (v.range.length && !(v.external !== undefined && v.rangeAuto)) n.props.push(['rdfs:range', classes(v.range.map((id) => ref.get(id)!))]);
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
      if (a.type === 'concept') for (const spec of restrictionSpecs(r)) A.props.push(['rdfs:subClassOf', restrict(spec, bRef.id, rangeVal(b.range) ?? 'rdfs:Literal', true)]);
    } else {
      const declared = r.kind === 'association' && !r.plain ? propRef.get(propKey(r.label)) : undefined;
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
  // Asserted class expressions the app has no drawing for are written back exactly as they came.
  for (const t of m.terms) {
    if (t.external !== undefined) continue;
    for (const axiom of t.axioms ?? []) {
      const at = axiom.indexOf(' ');
      if (at > 0) nodes.get(t.id)!.props.push([axiom.slice(0, at), { raw: axiom.slice(at + 1) }]);
    }
  }
  for (const t of m.terms) {
    if (t.type !== 'property' || t.external !== undefined) continue;
    const n = nodes.get(t.id)!;
    // The second type goes right after the first, as it does for an object property's characteristics.
    if (t.functional) n.props.splice(1, 0, ['rdf:type', { id: 'owl:FunctionalProperty' }]);
    const dom = dataDomain(m, t).ids.filter((id) => byId.get(id)?.type === 'concept');
    if (dom.length) n.props.push(['rdfs:domain', classes(dom.map((id) => ref.get(id)!))]);
    const range = rangeVal(t.range);
    if (range) n.props.push(['rdfs:range', range]);
  }
  // What individuals are stated to have as values of data properties.
  for (const t of m.terms) {
    if (t.type !== 'instance') continue;
    for (const v of t.values ?? []) {
      const prop = byId.get(v.prop);
      if (prop?.type !== 'property') continue;
      // A value of an enumerated datatype is written the way that datatype lists it.
      const listed = enumOf(m, prop.range);
      const dt = v.dt ?? (listed ? listed.values.find((x) => x.value === v.value && (x.lang ?? '') === (v.lang ?? ''))?.dt : prop.range);
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
  const of = (type: Term['type']) => m.terms.filter((t) => t.type === type).map((t) => nodes.get(t.id)!);
  return { base, nodes: [ontology, ...annProps, ...of('concept'), ...objProps, ...datatypeNodes, ...of('property'), ...of('instance'), ...allDifferent], ref, propRef };
}

function ttlBody(n: RdfNode, indent: string): string {
  const grouped = new Map<string, Val[]>();
  for (const [p, v] of n.props) grouped.set(p, [...(grouped.get(p) ?? []), v]);
  const val = (v: Val): string =>
    'raw' in v ? v.raw : 'list' in v ? `( ${v.list.map(val).join(' ')} )` : 'id' in v ? v.id : 'lit' in v ? (v.bool ? v.lit : JSON.stringify(v.lit) + (v.lang ? '@' + v.lang : v.dt ? '^^' + v.dt : '')) : `[ ${ttlBody(v.bnode, indent + '    ').replace(/\s*\n\s*/g, ' ')} ]`;
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
  return head.join('\n') + '\n\n' + body + '\n';
}

export function toJsonLd(m: Model): string {
  const { base, nodes } = toRdf(m);
  const iri = (id: string) => (id.startsWith('<') ? id.slice(1, -1) : id.startsWith(':') ? base + id.slice(1) : id);
  const context = Object.fromEntries([...STANDARD, ...m.prefixes].map((p) => [p.prefix, p.iri]).sort((a, b) => a[0].localeCompare(b[0])));
  const one = (v: Val, isType = false): unknown =>
    'raw' in v
      ? undefined
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
                ? { '@value': v.lit, '@type': v.dt }
                : v.lit
          : conv(v.bnode);
  const conv = (n: RdfNode): Record<string, unknown> => {
    const o: Record<string, unknown[]> = {};
    for (const [p, v] of n.props) {
      const key = p === 'rdf:type' ? '@type' : iri(p);
      const value = one(v, key === '@type');
      // Class expressions kept as Turtle text have no JSON-LD form here.
      if (value === undefined) continue;
      (o[key] ??= []).push(value);
    }
    const flat: Record<string, unknown> = n.id ? { '@id': iri(n.id) } : {};
    for (const [k, vs] of Object.entries(o)) flat[k] = vs.length === 1 ? vs[0] : vs;
    return flat;
  };
  return JSON.stringify({ '@context': context, '@graph': nodes.map(conv) }, null, 2);
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
        name: literal(iri, NS.rdfs + 'label', NS.skos + 'prefLabel', NS.dct + 'title') || humanize(iri, false),
        description: literal(iri, NS.skos + 'definition', NS.rdfs + 'comment', NS.dct + 'description'),
        synonyms: objs(iri, NS.skos + 'altLabel').filter(inPref).map((o) => o.value).join(', '),
      });
      terms.set(iri, t);
      m.terms.push(t);
    }
    return t;
  };
  const relKeys = new Set<string>();
  const relate = (from: string, to: string, kind: Relation['kind'], label = '', predicate?: string, restriction?: Pick<Relation, 'restriction' | 'restrictionN' | 'plain'>) => {
    const a = terms.get(from);
    const b = terms.get(to);
    const k = `${from}|${to}|${kind}|${label}|${predicate ?? ''}|${restriction?.restriction ?? ''}`;
    if (!a || !b) return false;
    if (relKeys.has(k)) return true;
    relKeys.add(k);
    m.relations.push(newRelation({ from: a.id, to: b.id, kind, label, ...(predicate ? { predicate } : {}), ...restriction }));
    return true;
  };
  // Several restrictions by one property on one target are one relationship that states them all.
  const restricted = new Map<string, Relation>();
  const restrictBy = (from: string, to: string, kind: Relation['kind'], label: string, how: Pick<Relation, 'restriction' | 'restrictionN'>): boolean => {
    const k = `${from}|${to}|${kind}|${label}`;
    const drawn = restricted.get(k);
    if (drawn) {
      Object.assign(drawn, specsPatch([...restrictionSpecs(drawn), { restriction: how.restriction ?? 'some', restrictionN: how.restrictionN }]));
      for (const key of ['restriction', 'restrictionN', 'more'] as const) if (drawn[key] === undefined) delete drawn[key];
      return true;
    }
    const before = m.relations.length;
    if (!relate(from, to, kind, label, undefined, how)) return false;
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

  // Classes: declared ones first, then anything used in a class position.
  for (const type of [NS.owl + 'Class', NS.rdfs + 'Class', NS.skos + 'Concept']) for (const c of typed(type)) ensure(c, 'concept');
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

  /** A class expression as Turtle, with the well-known namespaces shortened. */
  const PREFIXES: [string, string][] = [['owl:', NS.owl], ['rdfs:', NS.rdfs], ['rdf:', NS.rdf], ['xsd:', XSD], ['skos:', NS.skos]];
  const shortIri = (iri: string) => {
    const hit = PREFIXES.find(([, ns]) => iri.startsWith(ns) && /^[A-Za-z][\w-]*$/.test(iri.slice(ns.length)));
    return hit ? hit[0] + iri.slice(hit[1].length) : `<${iri}>`;
  };
  const expression = (t: N3Term, seen = new Set<string>()): string => {
    if (t.termType === 'NamedNode') return t.value === NS.rdf + 'nil' ? '()' : shortIri(t.value);
    if (t.termType === 'Literal') {
      const dt = t.datatype?.value;
      return JSON.stringify(t.value) + (t.language ? '@' + t.language : dt && dt !== XSD + 'string' && dt !== NS.rdf + 'langString' ? '^^' + shortIri(dt) : '');
    }
    const id = key(t);
    if (seen.has(id) || seen.size > 200) return '[]';
    seen.add(id);
    const preds = spo.get(id) ?? new Map<string, N3Term[]>();
    if (preds.has(NS.rdf + 'first')) {
      // A list is written as one if it is one: every cell with one item and one rest, ending in nil.
      // One that forks, stops short or comes back on itself is written cell by cell below, so that
      // it reads back as the same broken list and is not mended into something its author never wrote.
      const cells: string[] = [];
      let proper = true;
      for (let list: N3Term = t; list.value !== NS.rdf + 'nil'; list = objs(key(list), NS.rdf + 'rest')[0]) {
        const cell = key(list);
        if (cells.includes(cell) || objs(cell, NS.rdf + 'first').length !== 1 || objs(cell, NS.rdf + 'rest').length !== 1) {
          proper = false;
          break;
        }
        cells.push(cell);
      }
      if (proper) return `( ${cells.map((cell) => expression(objs(cell, NS.rdf + 'first')[0], seen)).join(' ')} )`;
    }
    const parts = [...preds].flatMap(([p, os]) => os.map((o) => `${p === NS.rdf + 'type' ? 'a' : shortIri(p)} ${expression(o, seen)}`));
    return parts.length ? `[ ${parts.join(' ; ')} ]` : '[]';
  };
  const keep = (c: string, predicate: string, o: N3Term) => {
    const t = terms.get(c);
    if (t) t.axioms = [...(t.axioms ?? []), `${predicate} ${expression(o)}`];
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
      ensure(prop.value, 'property');
      return restrictBy(c, prop.value, 'property', '', how);
    }
    return objProps.has(prop.value) && classes.has(fillers[0].value) && restrictBy(c, fillers[0].value, 'association', propLabel(prop.value), how);
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
      if (o.termType === 'NamedNode') {
        relate(c, o.value, 'generalization');
        continue;
      }
      // An anonymous superclass. The restrictions the app can draw become relationships; any
      // other class expression is kept word for word, so that nothing asserted is lost.
      if (!drawRestriction(c, o)) keep(c, 'rdfs:subClassOf', o);
    }
    for (const o of objs(c, NS.owl + 'equivalentClass')) {
      if (o.termType !== 'BlankNode') continue;
      // A class equivalent to a list of named individuals is an enumeration, which the app can edit.
      // The first such list is taken; any other expression is kept word for word.
      const listed = enumerations.has(c) ? undefined : enumerationOf(o);
      if (listed) enumerations.set(c, listed);
      else keep(c, 'owl:equivalentClass', o);
    }
    named(objs(c, NS.skos + 'broader')).forEach((o) => relate(c, o, 'generalization'));
    named(objs(c, NS.skos + 'narrower')).forEach((o) => relate(o, c, 'generalization'));
  }
  // Each object property is declared with what the file says about it. Only restrictions put
  // it between particular classes; a domain and range alone do not, so nothing is drawn for them.
  const propEntries = new Map<string, ObjProp>();
  const expandCurie = (curie: string) => (curie.startsWith('owl:') ? NS.owl : NS.rdfs) + curie.split(':')[1];
  const charOf = new Map(CHARACTERISTICS.map((c) => [NS.owl + c.owl.slice(4), c.id]));
  const others = (p: string, pred: string) => [...new Set(named(objs(p, pred)).filter((x) => objProps.has(x) && x !== p).map((x) => propKey(propLabel(x))))];
  /** The same terms, whatever the order. */
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  for (const p of objProps) {
    const domain = [...new Set(objs(p, NS.rdfs + 'domain').flatMap(expand))].filter((c) => terms.has(c)).map((c) => terms.get(c)!.id);
    const range = [...new Set(objs(p, NS.rdfs + 'range').flatMap(expand))].filter((c) => terms.has(c)).map((c) => terms.get(c)!.id);
    if (m.props.some((x) => propKey(x.name) === propKey(propLabel(p)))) continue;
    const entry: ObjProp = {
      name: propLabel(p),
      iri: p,
      description: literal(p, NS.skos + 'definition', NS.rdfs + 'comment'),
      chars: objs(p, NS.rdf + 'type').map((o) => charOf.get(o.value)).filter((c): c is string => !!c),
    };
    // A domain or range that only repeats where the property is used is left to follow its use.
    const uses = m.relations.filter((r) => r.kind === 'association' && !r.predicate && propKey(r.label) === propKey(entry.name));
    if (domain.length && !same(domain, [...new Set(uses.map((r) => r.from))])) entry.domain = domain;
    if (range.length && !same(range, [...new Set(uses.map((r) => r.to))])) entry.range = range;
    for (const link of PROP_LINKS) {
      const keys = others(p, expandCurie(LINK_PREDICATE[link])).filter((k) => k !== propKey(entry.name));
      // Kept on whichever property the file states it, even where both do: nothing stated is dropped.
      if (keys.length) entry[link] = keys;
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
    const values = objs(iri, NS.owl + 'equivalentClass').map(literalsOf).find(Boolean);
    if (!values) continue;
    const d: EnumDatatype = { id: 'd' + m.datatypes.length + '-' + iri.replace(/[^A-Za-z0-9]+/g, '').slice(-24), name: literal(iri, NS.rdfs + 'label', NS.skos + 'prefLabel') || humanize(iri, false), description: literal(iri, NS.skos + 'definition', NS.rdfs + 'comment'), values, iri };
    m.datatypes.push(d);
    datatypeOfIri.set(iri, d);
  }
  for (const p of dataProps) {
    const t = ensure(p, 'property');
    const ranges = objs(p, NS.rdfs + 'range');
    const datatype = ranges.map((o) => (o.value.startsWith(XSD) ? 'xsd:' + o.value.slice(XSD.length) : o.value === NS.rdf + 'langString' ? 'rdf:langString' : ''));
    const known = datatype.find((d) => DATATYPES.some((x) => x.id === d));
    if (known) t.range = known;
    // A range that is an enumerated datatype: one with a name, or a list of literals written in place.
    let taken: N3Term | undefined;
    for (const o of known ? [] : ranges) {
      let d = o.termType === 'NamedNode' ? datatypeOfIri.get(o.value) : undefined;
      const inline = d ? undefined : literalsOf(o);
      if (inline) {
        d = { id: 'd' + m.datatypes.length + '-' + t.id, name: `${t.name} values`, description: '', values: inline, anonymous: true };
        m.datatypes.push(d);
      }
      if (d) {
        t.range = ENUM_RANGE + d.id;
        taken = o;
        break;
      }
    }
    // A data range written in place that is none of those (a datatype narrowed by facets, a union,
    // a list that is not one of literals) is kept word for word, as an anonymous class expression is.
    for (const o of ranges) if (o.termType === 'BlankNode' && o !== taken) keep(p, 'rdfs:range', o);
    if (objs(p, NS.rdf + 'type').some((o) => o.value === NS.owl + 'FunctionalProperty')) t.functional = true;
    const domain = [...new Set(objs(p, NS.rdfs + 'domain').flatMap(expand))].filter((c) => terms.has(c)).map((c) => terms.get(c)!.id);
    const owners = [...new Set(m.relations.filter((r) => r.kind === 'property' && r.to === t.id).map((r) => r.from))];
    if (domain.length && !same(domain, owners)) t.domain = domain;
  }
  for (const p of dataProps) named(objs(p, NS.rdfs + 'subPropertyOf')).forEach((o) => relate(p, o, 'generalization'));

  // Individuals and the facts stated about them.
  for (const [s, preds] of spo) {
    if (s.startsWith('_:') || terms.has(s)) continue;
    const types = named(preds.get(NS.rdf + 'type') ?? []);
    const isIndividual = (preds.get(NS.rdf + 'type') ?? []).some((o) => o.value === NS.owl + 'NamedIndividual');
    if (!isIndividual && !types.some((t) => classes.has(t))) continue;
    ensure(s, 'instance');
    for (const t of types) {
      // What a declared individual is an instance of is a class, even if the file says nothing else about it.
      if (isIndividual && !terms.has(t) && !objProps.has(t) && !dataProps.has(t) && !annotationProps.has(t)) {
        ensure(t, 'concept');
        classes.add(t);
      }
      // Only membership of a class is one: owl:NamedIndividual and the like are declarations, not memberships.
      if (classes.has(t)) relate(s, t, 'generalization');
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
      if (objProps.has(p)) named(os).forEach((o) => relate(s, o, 'association', propLabel(p)));
      // The literal values an individual has for a data property.
      const prop = dataProps.has(p) ? terms.get(p) : undefined;
      if (!prop || subject.type !== 'instance') continue;
      for (const o of os) {
        if (o.termType !== 'Literal') continue;
        const dt = datatypeId(o.datatype?.value);
        const own = dt && dt !== 'xsd:string' && dt !== 'rdf:langString' && dt !== prop.range && DATATYPES.some((d) => d.id === dt) ? dt : undefined;
        const value: DataValue = { prop: prop.id, value: o.value, ...(o.language ? { lang: o.language } : {}), ...(own ? { dt: own } : {}) };
        subject.values = [...(subject.values ?? []), value];
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
  const pairwise = (type: string, predicate: string, ...lists: string[]) => {
    for (const node of [...spo.keys()].filter((n) => objs(n, NS.rdf + 'type').some((o) => o.value === NS.owl + type))) {
      const all = members(node, ...lists.map((l) => NS.owl + l));
      // "All different" said of exactly the members of an enumeration belongs to that enumeration:
      // it is kept as one statement there, not as a relationship between every two members.
      if (type === 'AllDifferent') {
        const set = new Set(all.map((iri) => terms.get(iri)?.id));
        const owner = m.terms.find((t) => t.oneOf && t.oneOf.length === set.size && t.oneOf.length > 1 && t.oneOf.every((id) => set.has(id)));
        if (owner) {
          owner.allDifferent = true;
          continue;
        }
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const [a, b] = [propEntries.get(all[i]), propEntries.get(all[j])];
          if (a && b && predicate === 'owl:propertyDisjointWith') {
            const [ka, kb] = [propKey(a.name), propKey(b.name)];
            if (ka !== kb && !a.disjoints?.includes(kb) && !b.disjoints?.includes(ka)) a.disjoints = [...(a.disjoints ?? []), kb];
          } else if (terms.has(all[i]) && terms.has(all[j]) && !relKeys.has(`${all[j]}|${all[i]}|association||${predicate}|`)) {
            if (relate(all[i], all[j], 'association', '', predicate)) m.vocab.enabled = true;
          }
        }
      }
    }
  };
  pairwise('AllDisjointClasses', 'owl:disjointWith', 'members');
  pairwise('AllDifferent', 'owl:differentFrom', 'distinctMembers', 'members');
  pairwise('AllDisjointProperties', 'owl:propertyDisjointWith', 'members');

  // Statements made with a plain rdf:Property are relationships nobody has classified yet.
  for (const p of typed(NS.rdf + 'Property')) {
    if (objProps.has(p) || dataProps.has(p) || annotationProps.has(p)) continue;
    for (const [sub, preds] of spo) {
      // Marked plain, so that it stays one even if an object property has the same name.
      if (terms.has(sub)) named(preds.get(p) ?? []).forEach((o) => relate(sub, o, 'association', propLabel(p), undefined, { plain: true }));
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
        if (sp.id === 'rdfs:subPropertyOf' && relKeys.has(`${s}|${o}|generalization|||`)) continue;
        // A symmetric statement is often written in both directions; one relation is enough.
        if (sp.symmetric && relKeys.has(`${o}|${s}|association||${sp.id}|`)) continue;
        relate(s, o, 'association', '', sp.id);
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
  const defaultNs = declared.get('');
  /** Whether a property is one of the file's own: in its default namespace, or anywhere if it has none. */
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
    // A property of the file's own namespace, or one it names, goes by that name. Any other keeps
    // its IRI, so that it is written back as the property it is.
    return own(pred) || literal(pred, NS.rdfs + 'label', NS.skos + 'prefLabel') ? propLabel(pred) : byIri(pred);
  };
  const typedValue = (o: N3Term): Pick<ExtraField, 'lang' | 'dt' | 'iri'> => {
    if (o.termType === 'NamedNode') return { iri: true };
    if (o.language) return { lang: o.language };
    const dt = o.datatype?.value.startsWith(XSD) ? 'xsd:' + o.datatype.value.slice(XSD.length) : undefined;
    return dt && dt !== 'xsd:string' ? { dt } : {};
  };
  const names = new Set([NS.rdfs + 'label', NS.skos + 'prefLabel', NS.dct + 'title']);
  const descriptions = new Set([NS.skos + 'definition', NS.rdfs + 'comment', NS.dct + 'description']);
  const annotated: [string, { name: string; description: string; fields?: ExtraField[] }, boolean][] = [...[...terms].map(([iri, t]): [string, Term, boolean] => [iri, t, true]), ...[...propEntries].map(([iri, p]): [string, ObjProp, boolean] => [iri, p, false])];
  for (const [iri, t, hasSynonyms] of annotated) {
    for (const [pred, os] of spo.get(iri) ?? []) {
      if (pred === QM + 'hasQualityMeasurement') {
        // Quality measurements (DQV): each is filed under the metric it measures.
        for (const o of os) {
          const metric = objs(key(o), QM + 'isMeasurementOf').find((x) => x.termType === 'NamedNode');
          const value = objs(key(o), QM + 'value')[0];
          if (!metric || !value || value.termType === 'BlankNode') continue;
          (t.fields ??= []).push({ key: annotationKey(metric.value) ?? (own(metric.value) ? propLabel(metric.value) : byIri(metric.value)), value: value.value, ...typedValue(value), measure: true });
        }
        continue;
      }
      const key_ = annotationKey(pred);
      if (!key_) continue;
      for (const o of os) {
        // A statement between two terms of the model that is a relationship was drawn as one.
        if (o.termType === 'BlankNode' || (o.termType === 'NamedNode' && terms.has(o.value) && drawn(pred))) continue;
        // Whatever already became the name, the description or a synonym isn't repeated.
        // The same words in another language are another annotation, and are kept.
        if (inPref(o) && ((names.has(pred) && o.value === t.name) || (descriptions.has(pred) && o.value === t.description))) continue;
        if (hasSynonyms && pred === NS.skos + 'altLabel' && inPref(o)) continue;
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
    m.name = literal(header, NS.skos + 'prefLabel', NS.rdfs + 'label', NS.dct + 'title') || m.name;
    m.description = literal(header, NS.dct + 'description', NS.rdfs + 'comment', NS.skos + 'definition');
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
    const standard = STANDARD.some((p) => p.prefix === prefix || p.iri === ns);
    if (prefix && !standard && /^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix) && !m.prefixes.some((p) => p.iri === ns)) m.prefixes.push({ prefix, iri: ns });
  }
  if (header && !header.startsWith('_:')) m.ontologyIri = header;
  // Ontologies this one imports are dependencies. Their content is not in the file, so they are
  // recorded as known by IRI only until the user supplies them.
  for (const o of header ? named(objs(header, NS.owl + 'imports')) : []) {
    m.externals.push({ id: 'x' + m.externals.length + '-' + o.replace(/[^A-Za-z0-9]+/g, '').slice(-24), name: humanize(o.replace(/[#/]$/, ''), false), iri: o, namespace: /[#/]$/.test(o) ? o : o + '#', source: '', sourceKind: 'unknown', addedAt: 0, classes: 0, objectProperties: 0, dataProperties: 0, individuals: 0, imports: true });
  }
  // An entity outside the default namespace of which the file says nothing but what kind of
  // thing it is, is one it refers to rather than defines: an entity of another ontology.
  const ownedBy = (iri: string) => m.externals.find((e) => iri.startsWith(e.namespace) || iri.startsWith(e.iri))?.id ?? '';
  const onlyDeclared = (iri: string) => [...(spo.get(iri)?.keys() ?? [])].every((p) => p === NS.rdf + 'type');
  if (m.baseIri) {
    for (const [iri, t] of terms) if (!iri.startsWith(m.baseIri) && onlyDeclared(iri)) t.external = ownedBy(iri);
    for (const [iri, p] of propEntries) if (!iri.startsWith(m.baseIri) && onlyDeclared(iri) && !p.domain && !p.range) p.external = ownedBy(iri);
  }

  const pos = hierarchyLayout(m);
  for (const t of m.terms) Object.assign(t, pos.get(t.id));
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
 * the term (its id) or the object property (its key) it stands for. This is how what a reasoner
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
