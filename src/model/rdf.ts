import { Parser } from 'n3';
import { ANNOTATION_PROPS, standardAnnotation } from './annotations';
import { baseIriOf, localName } from './iri';
import { hierarchyLayout } from './layout';
import { DATATYPES, emptyModel, newRelation, newTerm, type Model, type ObjProp, type Relation, type Term } from './types';
import { allPrefixes, compactIri, expandIri, ontologyIriOf, STANDARD } from './prefixes';
import { CHARACTERISTICS, dataDomain, DEFAULT_PROP, objectProperties, propKey, quantifierOf } from './props';
import { resolveModel, STD_PROPS } from './vocab';

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dct: 'http://purl.org/dc/terms/',
};

const XSD = 'http://www.w3.org/2001/XMLSchema#';

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

function toRdf(model: Model): { base: string; nodes: RdfNode[]; ref: Map<string, string> } {
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
  const annotate = (n: RdfNode, t: Term) => {
    for (const f of t.fields) {
      const key = f.key.trim();
      const value = f.value.trim();
      if (!key || !value) continue;
      let pred = standardAnnotation(key);
      if (!pred) {
        pred = custom.get(key.toLowerCase());
        if (!pred) {
          pred = ':' + unique(localName(key, true));
          custom.set(key.toLowerCase(), pred);
          annProps.push({ id: pred, props: [['rdf:type', { id: 'owl:AnnotationProperty' }], ['rdfs:label', { lit: key }]] });
        }
      }
      if (pred === 'owl:deprecated' && /^(true|false)$/i.test(value)) n.props.push([pred, { lit: value.toLowerCase(), bool: true }]);
      else if (LINKS.has(pred) && /^https?:\/\/[^\s<>"]+$/.test(value)) n.props.push([pred, { id: `<${value}>` }]);
      else n.props.push([pred, f.lang ? { lit: value, lang: f.lang } : { lit: value }]);
    }
  };
  const nodes = new Map<string, RdfNode>();

  if (m.mode === 'skos') {
    // A SKOS concept scheme: every term is a concept in it, "is a" is skos:broader.
    const scheme: RdfNode = { id: modelIri, props: [['rdf:type', { id: 'skos:ConceptScheme' }], ['skos:prefLabel', text(m.name)]] };
    if (m.description) scheme.props.push(['dcterms:description', text(m.description)]);
    for (const t of m.terms) {
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
      if (hasBroader.has(t.id)) continue;
      nodes.get(t.id)!.props.push(['skos:topConceptOf', { id: scheme.id }]);
      scheme.props.push(['skos:hasTopConcept', { id: ref.get(t.id)! }]);
    }
    return { base, nodes: [scheme, ...annProps, ...own.values(), ...m.terms.map((t) => nodes.get(t.id)!)], ref };
  }

  const ontology: RdfNode = { id: modelIri, props: [['rdf:type', { id: 'owl:Ontology' }], ['rdfs:label', text(m.name)]] };
  if (m.description) ontology.props.push(['rdfs:comment', text(m.description)]);

  for (const t of m.terms) {
    const type = t.type === 'concept' ? 'owl:Class' : t.type === 'property' ? 'owl:DatatypeProperty' : 'owl:NamedIndividual';
    const n: RdfNode = { id: ref.get(t.id)!, props: [['rdf:type', { id: type }], ['rdfs:label', text(t.name)]] };
    if (t.description) n.props.push(['skos:definition', text(t.description)]);
    for (const syn of t.synonyms.split(',')) if (syn.trim()) n.props.push(['skos:altLabel', text(syn.trim())]);
    annotate(n, t);
    nodes.set(t.id, n);
  }

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
    n.props.push(['rdfs:label', text(v.name)]);
    if (v.description) n.props.push(['skos:definition', text(v.description)]);
    if (v.parent && propRef.has(v.parent)) n.props.push(['rdfs:subPropertyOf', { id: propRef.get(v.parent)! }]);
    if (v.inverseOf && propRef.has(v.inverseOf)) n.props.push(['owl:inverseOf', { id: propRef.get(v.inverseOf)! }]);
    if (v.domain.length) n.props.push(['rdfs:domain', classes(v.domain.map((id) => ref.get(id)!))]);
    if (v.range.length) n.props.push(['rdfs:range', classes(v.range.map((id) => ref.get(id)!))]);
    return n;
  });
  // A class restricted by a property: "every member has it to some / only / N members of the target".
  const restrict = (r: Relation, property: string, target: string, data: boolean): Val => {
    const q = quantifierOf(r);
    const count: Val = { lit: String(r.restrictionN ?? 1), dt: 'xsd:nonNegativeInteger' };
    const body: [string, Val][] =
      q === 'some'
        ? [['owl:someValuesFrom', { id: target }]]
        : q === 'only'
          ? [['owl:allValuesFrom', { id: target }]]
          : [[q === 'min' ? 'owl:minQualifiedCardinality' : q === 'max' ? 'owl:maxQualifiedCardinality' : 'owl:qualifiedCardinality', count], [data ? 'owl:onDataRange' : 'owl:onClass', { id: target }]];
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
      A.props.push([pred, bRef]);
    } else if (r.kind === 'property' && b.type === 'property') {
      // A class that has a data property is restricted by it: its members have such a value.
      // The property's own domain and datatype are written on the property below.
      if (a.type === 'concept') A.props.push(['rdfs:subClassOf', restrict(r, bRef.id, b.range ?? 'rdfs:Literal', true)]);
    } else {
      const declared = r.kind === 'association' && !r.plain ? propRef.get(propKey(r.label)) : undefined;
      if (declared && a.type === 'concept' && b.type === 'concept') {
        A.props.push(['rdfs:subClassOf', restrict(r, declared, bRef.id, false)]);
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
    for (const axiom of t.axioms ?? []) {
      const at = axiom.indexOf(' ');
      if (at > 0) nodes.get(t.id)!.props.push([axiom.slice(0, at), { raw: axiom.slice(at + 1) }]);
    }
  }
  for (const t of m.terms) {
    if (t.type !== 'property') continue;
    const n = nodes.get(t.id)!;
    const dom = dataDomain(m, t).ids.filter((id) => byId.get(id)?.type === 'concept');
    if (dom.length) n.props.push(['rdfs:domain', classes(dom.map((id) => ref.get(id)!))]);
    if (t.range) n.props.push(['rdfs:range', { id: t.range }]);
  }
  const of = (type: Term['type']) => m.terms.filter((t) => t.type === type).map((t) => nodes.get(t.id)!);
  return { base, nodes: [ontology, ...annProps, ...of('concept'), ...objProps, ...of('property'), ...of('instance')], ref };
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
  const body = nodes.map((n) => `${n.id} ${ttlBody(n, '    ')} .`).join('\n\n');
  // The default namespace, the model's own prefixes (all of them: they are part of the ontology
  // whether or not anything uses them yet), and the standard ones that occur.
  const always = new Set(['owl', 'rdf', 'rdfs', 'skos']);
  const head = [
    `@prefix : <${base}> .`,
    ...[...m.prefixes].sort((a, b) => a.prefix.localeCompare(b.prefix)).map((p) => `@prefix ${p.prefix}: <${p.iri}> .`),
    ...[...STANDARD]
      .sort((a, b) => a.prefix.localeCompare(b.prefix))
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
  const full = (curie: string) => NS[curie.split(':')[0] as keyof typeof NS] + curie.split(':')[1];

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
      if (!s.startsWith('_:') && !builtin(s)) ensure(s, 'concept');
      os.forEach((o) => ensure(o, 'concept'));
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
      const items: string[] = [];
      for (let list: N3Term | undefined = t; list && list.value !== NS.rdf + 'nil' && items.length < 500; list = objs(key(list), NS.rdf + 'rest')[0]) {
        const first = objs(key(list), NS.rdf + 'first')[0];
        if (first) items.push(expression(first, seen));
      }
      return `( ${items.join(' ')} )`;
    }
    const parts = [...preds].flatMap(([p, os]) => os.map((o) => `${p === NS.rdf + 'type' ? 'a' : shortIri(p)} ${expression(o, seen)}`));
    return `[ ${parts.join(' ; ')} ]`;
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
      return relate(c, prop.value, 'property', '', undefined, how);
    }
    return objProps.has(prop.value) && classes.has(fillers[0].value) && relate(c, fillers[0].value, 'association', propLabel(prop.value), undefined, how);
  };

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
    for (const o of objs(c, NS.owl + 'equivalentClass')) if (o.termType === 'BlankNode') keep(c, 'owl:equivalentClass', o);
    named(objs(c, NS.skos + 'broader')).forEach((o) => relate(c, o, 'generalization'));
    named(objs(c, NS.skos + 'narrower')).forEach((o) => relate(o, c, 'generalization'));
  }
  // Each object property is declared with what the file says about it. Only restrictions put
  // it between particular classes; a domain and range alone do not, so nothing is drawn for them.
  const charOf = new Map(CHARACTERISTICS.map((c) => [NS.owl + c.owl.slice(4), c.id]));
  const other = (p: string, pred: string) => named(objs(p, pred)).filter((x) => objProps.has(x)).map((x) => propKey(propLabel(x)))[0];
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
    const inverse = other(p, NS.owl + 'inverseOf');
    const parent = other(p, NS.rdfs + 'subPropertyOf');
    if (inverse) entry.inverseOf = inverse;
    if (parent) entry.parent = parent;
    m.props.push(entry);
  }

  // Data properties become property terms. Only a restriction attaches one to a class (above);
  // a domain that says more than "the classes that have it" is kept as the property's domain.
  for (const p of dataProps) {
    const t = ensure(p, 'property');
    const datatype = objs(p, NS.rdfs + 'range').map((o) => (o.value.startsWith(XSD) ? 'xsd:' + o.value.slice(XSD.length) : o.value === NS.rdf + 'langString' ? 'rdf:langString' : ''));
    const known = datatype.find((d) => DATATYPES.some((x) => x.id === d));
    if (known) t.range = known;
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
    types.forEach((t) => relate(s, t, 'generalization'));
  }
  for (const [s, preds] of spo) {
    if (!terms.has(s)) continue;
    for (const [p, os] of preds) {
      if (objProps.has(p)) named(os).forEach((o) => relate(s, o, 'association', propLabel(p)));
    }
  }

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
        if (sp.vocab === 'owl') m.vocab.enabled = true;
      }
    }
  }

  // Remaining annotations on a term become its metadata fields.
  const curieNs: Record<string, string> = { rdfs: NS.rdfs, owl: NS.owl, skos: NS.skos, dcterms: NS.dct };
  const known = new Map(ANNOTATION_PROPS.map((p) => [curieNs[p.id.split(':')[0]] + p.id.split(':')[1], p.id]));
  known.set(NS.rdfs + 'label', 'rdfs:label');
  const names = new Set([NS.rdfs + 'label', NS.skos + 'prefLabel']);
  const descriptions = new Set([NS.skos + 'definition', NS.rdfs + 'comment']);
  for (const [iri, t] of terms) {
    for (const [pred, os] of spo.get(iri) ?? []) {
      const key = known.get(pred) ?? (annotationProps.has(pred) ? propLabel(pred) : undefined);
      if (!key) continue;
      for (const o of os) {
        if (o.termType === 'BlankNode' || (o.termType === 'NamedNode' && terms.has(o.value))) continue;
        // Whatever already became the name, the description or a synonym isn't repeated.
        if ((names.has(pred) && o.value === t.name) || (descriptions.has(pred) && o.value === t.description)) continue;
        if (pred === NS.skos + 'altLabel' && inPref(o)) continue;
        t.fields.push({ key, value: o.value, ...(o.termType === 'Literal' && o.language ? { lang: o.language } : {}) });
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
export function termIris(m: Model): Map<string, string> {
  const { base, ref } = toRdf(m);
  const out = new Map<string, string>();
  for (const [id, r] of ref) out.set(r.startsWith('<') ? r.slice(1, -1) : (expandIri(m, r) ?? base + r.slice(1)), id);
  return out;
}
