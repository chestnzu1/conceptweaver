import { Parser } from 'n3';
import { addIsA, addLink, addPropLink, removeIsA, removeLink, removePropLink, type Edit, type LinkKind } from './axioms';
import type { Entity } from './external';
import { allPrefixes, compactIri } from './prefixes';
import { newProp, newRelation, newTerm, type MappingMeta, type Model, type PropLink, type Term } from './types';
import { resolveModel } from './vocab';

/**
 * Mappings between this ontology and others.
 *
 * A mapping is an ordinary axiom of the model whose two ends belong to different ontologies:
 * a relation between a local entity and an external one. Nothing about it is special to the
 * reasoner, the RDF export or the canvas, which is the point: they all see it as what it is.
 * This module is the view of those axioms as mappings, and the bookkeeping kept beside them.
 *
 * The predicates are not interchangeable. owl:equivalentClass says two classes have the same
 * members and lets a reasoner conclude things; owl:sameAs says two names denote one individual;
 * skos:exactMatch says two concepts can be used for one another in retrieval and concludes nothing.
 */

export type EntityKind = 'class' | 'object property' | 'data property' | 'individual';

export interface MappingPredicate {
  id: string;
  group: 'OWL' | 'SKOS';
  label: string;
  /** The kinds of entity it can stand between; both ends are of the same kind. */
  kinds: EntityKind[];
  /** Holds both ways, so that source and target can be swapped without changing the meaning. */
  symmetric: boolean;
  about: string;
}

export const MAPPING_PREDICATES: MappingPredicate[] = [
  { id: 'owl:equivalentClass', group: 'OWL', label: 'equivalent class', kinds: ['class'], symmetric: true, about: 'The two classes have exactly the same members. A reasoner treats everything said of one as said of the other.' },
  { id: 'rdfs:subClassOf', group: 'OWL', label: 'subclass of', kinds: ['class'], symmetric: false, about: 'Every member of the source class is a member of the target class.' },
  { id: 'owl:disjointWith', group: 'OWL', label: 'disjoint with', kinds: ['class'], symmetric: true, about: 'Nothing can be a member of both classes.' },
  { id: 'owl:equivalentProperty', group: 'OWL', label: 'equivalent property', kinds: ['object property', 'data property'], symmetric: true, about: 'The two properties relate exactly the same things.' },
  { id: 'rdfs:subPropertyOf', group: 'OWL', label: 'sub-property of', kinds: ['object property', 'data property'], symmetric: false, about: 'Whatever is related by the source property is related by the target property.' },
  { id: 'owl:inverseOf', group: 'OWL', label: 'inverse of', kinds: ['object property'], symmetric: true, about: 'The source property read backwards is the target property.' },
  { id: 'owl:sameAs', group: 'OWL', label: 'same as', kinds: ['individual'], symmetric: true, about: 'Two names for one and the same individual. Everything said of one holds of the other.' },
  { id: 'owl:differentFrom', group: 'OWL', label: 'different from', kinds: ['individual'], symmetric: true, about: 'The two are definitely not the same individual.' },
  { id: 'skos:exactMatch', group: 'SKOS', label: 'exact match', kinds: ['class', 'individual'], symmetric: true, about: 'The two concepts can be used interchangeably across applications. A statement about concepts as catalogue entries, not about class membership: no reasoner concludes anything from it.' },
  { id: 'skos:closeMatch', group: 'SKOS', label: 'close match', kinds: ['class', 'individual'], symmetric: true, about: 'Similar enough to be used for one another in some applications.' },
  { id: 'skos:broadMatch', group: 'SKOS', label: 'broad match', kinds: ['class', 'individual'], symmetric: false, about: 'The target concept is broader than the source concept.' },
  { id: 'skos:narrowMatch', group: 'SKOS', label: 'narrow match', kinds: ['class', 'individual'], symmetric: false, about: 'The target concept is narrower than the source concept.' },
  { id: 'skos:relatedMatch', group: 'SKOS', label: 'related match', kinds: ['class', 'individual'], symmetric: true, about: 'The two concepts are associated, without one being broader.' },
];

export const mappingPredicate = (id: string) => MAPPING_PREDICATES.find((p) => p.id === id);

/** An end of a mapping: an entity of the model, described. */
export interface MappedEntity {
  ref: Entity;
  iri: string;
  name: string;
  kind: EntityKind;
  /** Id of the external ontology it belongs to ('' if not known); undefined for an entity of this ontology. */
  external?: string;
}

export interface Mapping {
  key: string;
  source: MappedEntity;
  predicate: string;
  target: MappedEntity;
  /** The relations that state it, when it is stated by relations. */
  rels: string[];
  meta?: MappingMeta;
}

export const mappingKey = (source: string, predicate: string, target: string) => `${source} ${predicate} ${target}`;

const termKind = (t: Term): EntityKind => (t.type === 'concept' ? 'class' : t.type === 'property' ? 'data property' : 'individual');

export function describe(model: Model, ref: Entity): MappedEntity | undefined {
  if (ref.kind === 'term') {
    const t = model.terms.find((x) => x.id === ref.id);
    return t?.iri ? { ref, iri: t.iri, name: t.name || 'Unnamed', kind: termKind(t), ...(t.external !== undefined ? { external: t.external } : {}) } : undefined;
  }
  const p = model.props.find((x) => x.id === ref.id);
  return p?.iri ? { ref, iri: p.iri, name: p.name, kind: 'object property', ...(p.external !== undefined ? { external: p.external } : {}) } : undefined;
}

const LINK_OF: Record<string, LinkKind> = { 'owl:equivalentClass': 'equivalentClass', 'owl:disjointWith': 'disjointWith', 'owl:equivalentProperty': 'equivalentProperty', 'owl:sameAs': 'sameAs', 'owl:differentFrom': 'differentFrom' };
const PROP_LINK_OF: Record<string, PropLink> = { 'rdfs:subPropertyOf': 'parents', 'owl:equivalentProperty': 'equivalents', 'owl:inverseOf': 'inverses' };
const PREDICATE_OF_LINK: Partial<Record<PropLink, string>> = { parents: 'rdfs:subPropertyOf', equivalents: 'owl:equivalentProperty', inverses: 'owl:inverseOf' };

/**
 * Every mapping the model asserts: each statement with a mapping predicate that has an external
 * entity at one end or both, in the direction it was stated. Read from the axioms themselves,
 * so one made on the canvas or in the entity editor is listed like one made in the workbench.
 */
export function listMappings(model: Model): Mapping[] {
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const meta = new Map(model.mappings.map((m) => [mappingKey(m.source, m.predicate, m.target), m]));
  const out = new Map<string, Mapping>();
  const put = (source: MappedEntity | undefined, predicate: string, target: MappedEntity | undefined, rel?: string) => {
    if (!source || !target || (source.external === undefined && target.external === undefined)) return;
    const key = mappingKey(source.iri, predicate, target.iri);
    const hit = out.get(key);
    if (hit) rel && hit.rels.push(rel);
    else out.set(key, { key, source, predicate, target, rels: rel ? [rel] : [], ...(meta.has(key) ? { meta: meta.get(key) } : {}) });
  };
  const term = (id: string) => (byId.has(id) ? describe(model, { kind: 'term', id }) : undefined);
  for (const r of resolveModel(model).relations) {
    const a = byId.get(r.from);
    const b = byId.get(r.to);
    if (!a || !b || (a.external === undefined && b.external === undefined)) continue;
    let predicate = r.predicate;
    if (!predicate && r.kind === 'generalization' && a.type === b.type && a.type !== 'instance' && model.mode !== 'skos') predicate = a.type === 'concept' ? 'rdfs:subClassOf' : 'rdfs:subPropertyOf';
    if (predicate && mappingPredicate(predicate)) put(term(r.from), predicate, term(r.to), r.id);
  }
  for (const p of model.props) {
    for (const [link, predicate] of Object.entries(PREDICATE_OF_LINK) as [PropLink, string][]) {
      for (const other of p[link] ?? []) put(describe(model, { kind: 'prop', id: p.id }), predicate, describe(model, { kind: 'prop', id: other }));
    }
  }
  return [...out.values()];
}

const fail = (error: string): Edit => ({ error });
const q = (s: string) => `“${s}”`;

export interface NewMeta {
  method?: MappingMeta['method'];
  score?: number;
  comment?: string;
  author?: string;
  status?: MappingMeta['status'];
  now?: number;
}

/**
 * Asserts a mapping from `source` to `target`. It is checked like any other axiom (kinds that
 * fit the predicate, no repeat, no flat contradiction of what is already stated) and nothing is
 * asserted that the user did not choose: there is no default predicate.
 */
export function addMapping(model: Model, sourceRef: Entity, predicate: string, targetRef: Entity, meta: NewMeta = {}): Edit {
  const def = mappingPredicate(predicate);
  const source = describe(model, sourceRef);
  const target = describe(model, targetRef);
  if (!def) return fail('Choose how the two are related.');
  if (!source || !target) return fail('Both entities need an IRI to be mapped.');
  if (source.iri === target.iri) return fail('That is one and the same entity: there is nothing to map.');
  if (source.external === undefined && target.external === undefined) return fail(`${q(source.name)} and ${q(target.name)} are both entities of this ontology. A mapping is between this ontology and another; state this in the entity editor instead.`);
  if (model.mode === 'skos' && def.group === 'OWL') return fail(`This is a SKOS concept scheme, where ${def.id} has no meaning. Use a SKOS mapping property such as skos:exactMatch, or convert the model to an ontology first.`);
  if (source.kind !== target.kind) return fail(`${q(source.name)} is ${article(source.kind)} and ${q(target.name)} is ${article(target.kind)}. ${def.id} relates two entities of the same kind.`);
  if (!def.kinds.includes(source.kind)) {
    const instead = MAPPING_PREDICATES.filter((p) => p.kinds.includes(source.kind)).map((p) => p.id);
    return fail(`${def.id} is for ${def.kinds.map(plural).join(' or ')}, not for ${plural(source.kind)}. For ${plural(source.kind)} use ${instead.join(', ')}.`);
  }
  const existing = listMappings(model);
  const same = existing.find((m) => m.predicate === predicate && ((m.source.iri === source.iri && m.target.iri === target.iri) || (def.symmetric && m.source.iri === target.iri && m.target.iri === source.iri)));
  if (same) return fail(`${q(source.name)} ${def.label} ${q(target.name)} is already stated.`);

  let edit: Edit;
  if (sourceRef.kind === 'prop' && targetRef.kind === 'prop') {
    edit = addPropLink(model, sourceRef.id, targetRef.id, PROP_LINK_OF[predicate]);
  } else if (sourceRef.kind === 'term' && targetRef.kind === 'term') {
    if (predicate === 'rdfs:subClassOf' || predicate === 'rdfs:subPropertyOf') edit = addIsA(model, sourceRef.id, targetRef.id);
    else if (LINK_OF[predicate]) edit = addLink(model, sourceRef.id, targetRef.id, LINK_OF[predicate]);
    else {
      // A SKOS mapping property: a statement of its own kind, from which nothing is inferred.
      const on = model.vocab.enabled ? model : { ...model, vocab: { ...model.vocab, enabled: true } };
      edit = { model: { ...on, relations: [...on.relations, newRelation({ from: sourceRef.id, to: targetRef.id, predicate })] } };
    }
  } else {
    return fail('An object property can only be mapped to an object property.');
  }
  if (edit.error !== undefined) return edit;
  const entry: MappingMeta = { source: source.iri, predicate, target: target.iri, created: meta.now ?? Date.now(), method: meta.method ?? 'manual', status: meta.status ?? 'proposed', ...(meta.score !== undefined ? { score: meta.score } : {}), ...(meta.comment ? { comment: meta.comment } : {}), ...(meta.author ? { author: meta.author } : {}) };
  const key = mappingKey(entry.source, entry.predicate, entry.target);
  return { model: { ...edit.model, mappings: [...edit.model.mappings.filter((m) => mappingKey(m.source, m.predicate, m.target) !== key), entry] }, note: edit.note };
}

const article = (k: EntityKind) => (k === 'individual' || k === 'object property' ? 'an ' : 'a ') + k;
const plural = (k: EntityKind) => (k === 'class' ? 'classes' : k === 'individual' ? 'individuals' : k === 'object property' ? 'object properties' : 'data properties');

/** Withdraws a mapping: that axiom and its bookkeeping, and nothing else. The entities stay. */
export function removeMapping(model: Model, m: Mapping): Model {
  let out = model;
  const { source, target, predicate } = m;
  if (source.ref.kind === 'prop' && target.ref.kind === 'prop') out = removePropLink(out, source.ref.id, target.ref.id, PROP_LINK_OF[predicate]);
  else if (predicate === 'rdfs:subClassOf' || predicate === 'rdfs:subPropertyOf') out = removeIsA(out, source.ref.id, target.ref.id);
  else if (LINK_OF[predicate]) out = removeLink(out, source.ref.id, target.ref.id, LINK_OF[predicate]);
  if (m.rels.length) {
    const gone = new Set(m.rels);
    out = { ...out, relations: out.relations.filter((r) => !gone.has(r.id)) };
  }
  return { ...out, mappings: out.mappings.filter((x) => mappingKey(x.source, x.predicate, x.target) !== m.key) };
}

/** Changes what is recorded about a mapping, starting a record if there was none. */
export function setMappingMeta(model: Model, m: Mapping, patch: Partial<Pick<MappingMeta, 'status' | 'comment' | 'author'>>, now = Date.now()): Model {
  const base: MappingMeta = m.meta ?? { source: m.source.iri, predicate: m.predicate, target: m.target.iri, created: now, method: 'manual', status: 'proposed' };
  const next = { ...base, ...patch };
  if (!next.comment) delete next.comment;
  if (!next.author) delete next.author;
  return { ...model, mappings: [...model.mappings.filter((x) => mappingKey(x.source, x.predicate, x.target) !== m.key), next] };
}

// ---------------------------------------------------------------- what looks odd

export interface MappingIssue {
  severity: 'warning' | 'info';
  message: string;
  mappings: string[];
}

/**
 * Mapping patterns worth a second look. None of them is a contradiction (those are the
 * reasoner's to find), and a mapping between two entities with different names is not one of
 * them: names are not what makes entities the same.
 */
export function mappingIssues(model: Model, mappings: Mapping[] = listMappings(model)): MappingIssue[] {
  const out: MappingIssue[] = [];
  const other = (m: Mapping, iri: string) => (m.source.iri === iri ? m.target : m.source);
  // One local entity equivalent to two entities of the same external ontology makes those two equivalent to each other.
  for (const predicate of ['owl:equivalentClass', 'owl:equivalentProperty', 'owl:sameAs']) {
    const byLocal = new Map<string, Mapping[]>();
    for (const m of mappings) {
      if (m.predicate !== predicate) continue;
      const local = m.source.external === undefined ? m.source : m.target.external === undefined ? m.target : undefined;
      if (local) byLocal.set(local.iri, [...(byLocal.get(local.iri) ?? []), m]);
    }
    for (const [iri, list] of byLocal) {
      const perOntology = new Map<string, Mapping[]>();
      for (const m of list) perOntology.set(other(m, iri).external ?? '', [...(perOntology.get(other(m, iri).external ?? '') ?? []), m]);
      for (const same of perOntology.values()) {
        if (same.length < 2) continue;
        const local = same[0].source.iri === iri ? same[0].source : same[0].target;
        out.push({ severity: 'warning', mappings: same.map((m) => m.key), message: `${q(local.name)} is stated to be ${mappingPredicate(predicate)!.label} of ${same.map((m) => q(other(m, iri).name)).join(' and ')}, which are entities of one ontology. That makes them the same as each other, which that ontology may not intend.` });
      }
    }
  }
  // Equivalent and also a subclass: the second says nothing the first does not.
  for (const m of mappings) {
    if (m.predicate !== 'rdfs:subClassOf' && m.predicate !== 'rdfs:subPropertyOf') continue;
    const eq = m.predicate === 'rdfs:subClassOf' ? 'owl:equivalentClass' : 'owl:equivalentProperty';
    const twin = mappings.find((x) => x.predicate === eq && ((x.source.iri === m.source.iri && x.target.iri === m.target.iri) || (x.source.iri === m.target.iri && x.target.iri === m.source.iri)));
    if (twin) out.push({ severity: 'info', mappings: [m.key, twin.key], message: `${q(m.source.name)} is stated to be both equivalent to and a ${m.predicate === 'rdfs:subClassOf' ? 'subclass' : 'sub-property'} of ${q(m.target.name)}. The second follows from the first.` });
  }
  // An OWL equivalence and a SKOS match on one pair say two different kinds of thing; often only one was meant.
  for (const m of mappings) {
    if (m.predicate !== 'skos:exactMatch') continue;
    const twin = mappings.find((x) => (x.predicate === 'owl:equivalentClass' || x.predicate === 'owl:sameAs') && ((x.source.iri === m.source.iri && x.target.iri === m.target.iri) || (x.source.iri === m.target.iri && x.target.iri === m.source.iri)));
    if (twin) out.push({ severity: 'info', mappings: [m.key, twin.key], message: `${q(m.source.name)} and ${q(m.target.name)} are mapped with both skos:exactMatch and ${twin.predicate}. These say different things: one is about concepts in a catalogue, the other is a logical statement a reasoner acts on.` });
  }
  for (const m of mappings) {
    for (const end of [m.source, m.target]) {
      if (end.external === '') out.push({ severity: 'info', mappings: [m.key], message: `${q(end.name)} <${end.iri}> belongs to an ontology that is not in the library, so the mapping cannot be checked against its definition.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- RDF

const NS: Record<string, string> = { owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', skos: 'http://www.w3.org/2004/02/skos/core#', dcterms: 'http://purl.org/dc/terms/', xsd: 'http://www.w3.org/2001/XMLSchema#' };
const CW = 'https://conceptweaver.app/alignment#';
const fullPredicate = (curie: string) => NS[curie.split(':')[0]] + curie.split(':')[1];

/**
 * The mappings by themselves, as RDF: one triple each, in the direction stated, with the
 * entities' own IRIs. With `metadata`, what is recorded about each mapping is added as an
 * annotation on that axiom (owl:Axiom with owl:annotatedSource, -Property, -Target), which is
 * how OWL attaches statements to a statement.
 */
export function mappingsToTurtle(model: Model, opts: { metadata?: boolean } = {}, mappings: Mapping[] = listMappings(model)): string {
  const used = new Map<string, string>();
  const known = [...allPrefixes(model).filter((p) => p.prefix), ...Object.entries(NS).map(([prefix, iri]) => ({ prefix, iri }))];
  // Namespaces of the external ontologies get a prefix of their own where they have none, so the file reads well.
  const extra = new Map<string, string>();
  for (const e of model.externals) if (e.namespace && !known.some((p) => p.iri === e.namespace)) extra.set(e.namespace, (e.name.split(/[^A-Za-z]+/).filter(Boolean)[0] ?? 'ext').toLowerCase().slice(0, 10) + (extra.size ? extra.size + 1 : ''));
  const iri = (x: string) => {
    const base = model.baseIri;
    if (base && x.startsWith(base) && /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(x.slice(base.length))) {
      used.set('', base);
      return ':' + x.slice(base.length);
    }
    const curie = compactIri(model, x);
    if (curie && !curie.startsWith(':')) {
      used.set(curie.split(':')[0], known.find((p) => p.prefix === curie.split(':')[0])!.iri);
      return curie;
    }
    for (const [ns, prefix] of extra) {
      if (x.startsWith(ns) && /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(x.slice(ns.length))) {
        used.set(prefix, ns);
        return `${prefix}:${x.slice(ns.length)}`;
      }
    }
    return `<${x}>`;
  };
  const pred = (curie: string) => {
    used.set(curie.split(':')[0], NS[curie.split(':')[0]]);
    return curie;
  };
  const lines = mappings.map((m) => `${iri(m.source.iri)} ${pred(m.predicate)} ${iri(m.target.iri)} .`);
  const notes: string[] = [];
  if (opts.metadata) {
    for (const m of mappings) {
      if (!m.meta) continue;
      used.set('cw', CW).set('owl', NS.owl).set('dcterms', NS.dcterms).set('xsd', NS.xsd);
      const a = [`a owl:Axiom`, `owl:annotatedSource ${iri(m.source.iri)}`, `owl:annotatedProperty ${pred(m.predicate)}`, `owl:annotatedTarget ${iri(m.target.iri)}`, `cw:method ${JSON.stringify(m.meta.method)}`, `cw:status ${JSON.stringify(m.meta.status)}`];
      if (m.meta.created) a.push(`dcterms:created "${new Date(m.meta.created).toISOString()}"^^xsd:dateTime`);
      if (m.meta.score !== undefined) a.push(`cw:similarity ${m.meta.score.toFixed(2)}`);
      if (m.meta.author) a.push(`dcterms:creator ${JSON.stringify(m.meta.author)}`);
      if (m.meta.comment) used.set('rdfs', NS.rdfs) && a.push(`rdfs:comment ${JSON.stringify(m.meta.comment)}`);
      notes.push(`[] ${a.join(' ;\n    ')} .`);
    }
  }
  const head = [...used].sort((x, y) => x[0].localeCompare(y[0])).map(([p, ns]) => `@prefix ${p}: <${ns}> .`);
  return lines.length ? [head.join('\n'), lines.join('\n'), ...(notes.length ? [notes.join('\n\n')] : [])].join('\n\n') + '\n' : '';
}

export interface MappingImport {
  model: Model;
  added: number;
  /** Mappings in the file that the model already asserts. */
  duplicates: number;
  /** Triples left out, each with the reason. */
  refused: string[];
}

interface T {
  termType: string;
  value: string;
}

/**
 * Reads mappings from Turtle and asserts the ones the model does not have yet. An IRI that is
 * not an entity of the model becomes a reference to an external entity: of the ontology whose
 * namespace it is in if that is in the library, of an unknown one otherwise. `lookup` gives the
 * name and kind of an entity of a library ontology, where its content is at hand.
 */
export function importMappings(model: Model, text: string, lookup: (iri: string) => { name: string; type: Term['type'] | 'object' } | undefined = () => undefined, now = Date.now()): MappingImport {
  const quads = new Parser().parse(text) as unknown as { subject: T; predicate: T; object: T & { value: string } }[];
  const byPredicate = new Map(MAPPING_PREDICATES.map((p) => [fullPredicate(p.id), p]));
  // What the file records about its mappings, by the mapping it is about.
  const notes = new Map<string, Partial<MappingMeta>>();
  const bySubject = new Map<string, Map<string, string>>();
  for (const x of quads) if (x.subject.termType === 'BlankNode') (bySubject.get(x.subject.value) ?? bySubject.set(x.subject.value, new Map()).get(x.subject.value)!).set(x.predicate.value, x.object.value);
  for (const a of bySubject.values()) {
    const [s, p, o] = [a.get(NS.owl + 'annotatedSource'), a.get(NS.owl + 'annotatedProperty'), a.get(NS.owl + 'annotatedTarget')];
    const def = p ? byPredicate.get(p) : undefined;
    if (!s || !o || !def) continue;
    const status = a.get(CW + 'status');
    const created = Date.parse(a.get(NS.dcterms + 'created') ?? '');
    notes.set(mappingKey(s, def.id, o), {
      ...(status === 'approved' || status === 'needs review' || status === 'proposed' ? { status } : {}),
      ...(a.get(NS.rdfs + 'comment') ? { comment: a.get(NS.rdfs + 'comment') } : {}),
      ...(a.get(NS.dcterms + 'creator') ? { author: a.get(NS.dcterms + 'creator') } : {}),
      ...(a.get(CW + 'similarity') ? { score: Number(a.get(CW + 'similarity')) } : {}),
      ...(Number.isFinite(created) ? { created } : {}),
    });
  }

  let out = model;
  let added = 0;
  let duplicates = 0;
  // New references go in a column to the right of what is on the canvas.
  const column = Math.max(0, ...model.terms.map((t) => t.x)) + 240;
  const top = Math.min(0, ...model.terms.map((t) => t.y));
  let placed = 0;
  const refused: string[] = [];
  const short = (iri: string) => compactIri(model, iri) ?? `<${iri}>`;
  const find = (m: Model, iri: string): Entity | undefined => {
    const t = m.terms.find((x) => x.iri === iri);
    if (t) return { kind: 'term', id: t.id };
    const p = m.props.find((x) => x.iri === iri);
    return p ? { kind: 'prop', id: p.id } : undefined;
  };
  for (const x of quads) {
    const def = byPredicate.get(x.predicate.value);
    if (!def || x.subject.termType !== 'NamedNode' || x.object.termType !== 'NamedNode') continue;
    const [s, o] = [x.subject.value, x.object.value];
    let a = find(out, s);
    let b = find(out, o);
    if (!a && !b) {
      refused.push(`${short(s)} ${def.id} ${short(o)}: neither is an entity of this ontology`);
      continue;
    }
    // The end that is not in the model becomes a reference, of the kind the other end is.
    const ensure = (iri: string, like: Entity): Entity | undefined => {
      const known = lookup(iri);
      const model_ = out;
      const owner = model_.externals.find((e) => (e.namespace && iri.startsWith(e.namespace)) || (e.iri && iri.startsWith(e.iri)))?.id ?? '';
      const local = decodeURIComponent(iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1)) || iri;
      const words = local.replace(/[_-]+/g, ' ').replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').trim();
      const likeProp = like.kind === 'prop';
      if (known ? known.type === 'object' : likeProp) {
        // Its own name, even where a property of the model has it: the two are told apart by IRI.
        const stub = newProp({ name: known?.name ?? words.toLowerCase(), iri, external: owner });
        out = { ...out, props: [...out.props, stub] };
        return { kind: 'prop', id: stub.id };
      }
      const type = known && known.type !== 'object' ? known.type : out.terms.find((t) => t.id === like.id)?.type;
      if (!type) return undefined;
      const stub = newTerm({ name: known?.name ?? words, type, iri, external: owner, x: column, y: top + placed++ * 70 });
      out = { ...out, terms: [...out.terms, stub] };
      return { kind: 'term', id: stub.id };
    };
    const before = out;
    a ??= ensure(s, b!);
    b ??= ensure(o, a!);
    if (!a || !b) {
      out = before;
      refused.push(`${short(s)} ${def.id} ${short(o)}: could not tell what kind of entity the unknown one is`);
      continue;
    }
    const note = notes.get(mappingKey(s, def.id, o)) ?? {};
    const edit = addMapping(out, a, def.id, b, { method: 'imported', now: note.created ?? now, ...note });
    if (edit.error !== undefined) {
      out = before;
      if (/already stated/.test(edit.error)) duplicates++;
      else refused.push(`${short(s)} ${def.id} ${short(o)}: ${edit.error}`);
      continue;
    }
    out = edit.model;
    added++;
  }
  return { model: out, added, duplicates, refused };
}

/** The entities of the model that at least one mapping involves, by IRI, with how many. */
export function mappedCounts(mappings: Mapping[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of mappings) for (const e of [m.source, m.target]) out.set(e.iri, (out.get(e.iri) ?? 0) + 1);
  return out;
}

