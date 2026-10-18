import { bounds } from './geometry';
import { withoutEntities } from './domains';
import { namedClasses, type ClassAxiom } from './expressions';
import { nameKey, propOf } from './identity';
import { objectProperties } from './props';
import { fromTurtle } from './rdf';
import { detectFormat, FORMAT_LABEL } from './rdfFormats';
import { PROP_LINKS, newProp, newRelation, newTerm, uid, type ExternalRef, type Model, type ObjProp, type Relation, type Term } from './types';

/**
 * Other ontologies, and the three different things that can be done with one:
 *
 *   refer to it   It becomes a dependency (owl:imports). Its axioms hold in this ontology, but
 *                 stay its own: they are not written into this model.
 *   reuse         One of its entities is used here under its own IRI, for instance as a
 *                 superclass. Only the reference is in this model, not the entity's definition.
 *   copy          Chosen entities are copied in with their definitions. From then on they are
 *                 this model's to maintain, still under their original IRIs.
 *
 * An external ontology is read with the same reader as any other, into a model of its own that
 * is never mixed into the active one except by these explicit steps.
 */

export interface ExternalSummary {
  ref: Omit<ExternalRef, 'id' | 'addedAt' | 'imports'>;
  model: Model;
}

const namespaceOf = (iri: string) => iri.slice(0, Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);

/**
 * Reads an ontology from Turtle and describes it, without touching the active model. One in
 * another syntax is made Turtle before it is given here (asTurtle in rdfFormats.ts), which is
 * also how it is then kept; what arrives in another syntax all the same was not converted.
 */
export function readExternal(text: string, source: string, sourceKind: ExternalRef['sourceKind']): ExternalSummary {
  const format = detectFormat(text, source);
  if (format !== 'turtle') throw new Error(`This is ${FORMAT_LABEL[format]}, which has to be converted to Turtle before it is read here.`);
  const model = fromTurtle(text, source.replace(/\.[^.]+$/, ''));
  if (!model.terms.length && !model.props.length) throw new Error('No classes, properties or individuals were found in it.');
  const version = /owl:versionIRI\s+<([^>]+)>|<http:\/\/www\.w3\.org\/2002\/07\/owl#versionIRI>\s+<([^>]+)>/.exec(text);
  const count = (type: Term['type']) => model.terms.filter((t) => t.type === type).length;
  return {
    model,
    ref: {
      name: model.name,
      iri: model.ontologyIri,
      ...(version ? { versionIri: version[1] ?? version[2] } : {}),
      namespace: model.baseIri,
      source,
      sourceKind,
      classes: count('concept'),
      objectProperties: model.props.length,
      dataProperties: count('property'),
      individuals: count('instance'),
    },
  };
}

export interface Collision {
  iri: string;
  name: string;
  /** What differs between the entity here and the one there, if anything does. */
  conflict?: string;
}

const KIND: Record<Term['type'], string> = { concept: 'class', property: 'data property', instance: 'individual' };

/** Entities of the external ontology whose IRI is already the IRI of an entity defined in the active model. */
export function collisions(model: Model, ext: Model): Collision[] {
  const mine = new Map<string, { name: string; kind: string }>();
  for (const t of model.terms) if (t.iri && t.external === undefined) mine.set(t.iri, { name: t.name, kind: KIND[t.type] });
  for (const p of model.props) if (p.iri && p.external === undefined) mine.set(p.iri, { name: p.name, kind: 'object property' });
  const out: Collision[] = [];
  const check = (iri: string | undefined, name: string, kind: string) => {
    const here = iri ? mine.get(iri) : undefined;
    if (!here) return;
    const conflict = here.kind !== kind ? `a ${here.kind} here, a ${kind} there` : here.name.trim().toLowerCase() !== name.trim().toLowerCase() ? `called “${here.name}” here, “${name}” there` : undefined;
    out.push({ iri: iri!, name, ...(conflict ? { conflict } : {}) });
  };
  for (const t of ext.terms) check(t.iri, t.name, KIND[t.type]);
  for (const p of ext.props) check(p.iri, p.name, 'object property');
  return out;
}

/** An entity of an external ontology: a term of its model, or one of its object properties. */
export type ExtEntity = { term: string; prop?: undefined } | { prop: string; term?: undefined };

/** An entity of the active model. */
export type Entity = { kind: 'term'; id: string } | { kind: 'prop'; id: string };

/** Where the next entity brought in goes on the canvas: in a column to the right of what is there. */
function placer(model: Model) {
  const b = bounds(model.terms);
  let n = model.terms.filter((t) => t.external !== undefined).length;
  return () => {
    const at = { x: Math.round((b?.x1 ?? 0) + 240 + Math.floor(n / 12) * 200), y: Math.round((b?.y0 ?? 0) + (n % 12) * 70) };
    n++;
    return at;
  };
}

/**
 * A data property's range as it can be stated in another model: a datatype of the ontology's
 * own that is enumerated is named by its IRI there, and left out where it has none.
 */
function portableRanges(t: Term, ext: Model, model: Model): Pick<Term, 'ranges'> {
  const enums = new Set(model.datatypes.map((d) => d.id));
  const ranges = t.ranges?.flatMap((a) => {
    if (a.range.type !== 'Enumeration' || enums.has(a.range.datatype)) return [a];
    const iri = ext.datatypes.find((d) => d.id === (a.range as { datatype: string }).datatype)?.iri;
    return iri ? [{ ...a, range: { type: 'Datatype' as const, iri } }] : [];
  });
  return ranges?.length ? { ranges } : {};
}

/**
 * Makes an external entity usable in the active model: a reference to it, under its own IRI,
 * that can be chosen as a superclass, a domain, a range or a filler. Its definition stays where
 * it is. If the model already has an entity with that IRI, that one is used.
 */
export function reuseEntity(model: Model, ref: Pick<ExternalRef, 'id' | 'name' | 'namespace'>, ext: Model, entity: ExtEntity): { model: Model; entity: Entity; added: boolean } {
  if (entity.term !== undefined) {
    const t = ext.terms.find((x) => x.id === entity.term);
    if (!t?.iri) throw new Error('That entity has no IRI, so it cannot be referred to.');
    const here = model.terms.find((x) => x.iri === t.iri);
    if (here) return { model, entity: { kind: 'term', id: here.id }, added: false };
    const stub = newTerm({ name: t.name, type: t.type, iri: t.iri, description: t.description, external: ref.id, ...portableRanges(t, ext, model), ...placer(model)() });
    return { model: { ...model, terms: [...model.terms, stub] }, entity: { kind: 'term', id: stub.id }, added: true };
  }
  const p = ext.props.find((x) => x.id === entity.prop);
  if (!p?.iri) throw new Error('That property has no IRI, so it cannot be referred to.');
  const here = model.props.find((x) => x.iri === p.iri);
  if (here) return { model, entity: { kind: 'prop', id: here.id }, added: false };
  // It keeps its name, even where a property of the model has the same one: they are told apart by IRI.
  const stub = newProp({ name: p.name, description: p.description, iri: p.iri, external: ref.id });
  return { model: { ...model, props: [...model.props, stub] }, entity: { kind: 'prop', id: stub.id }, added: true };
}

export interface CopyResult {
  model: Model;
  /** Entities copied in, now maintained here. */
  copied: number;
  /** Entities left alone because the model already has one with that IRI. */
  skipped: string[];
  /** External entities that the copied ones refer to and that were not copied: kept as references. */
  referenced: number;
}

/**
 * Copies chosen entities of an external ontology into the model, with what the ontology says
 * about them: annotations, superclasses, restrictions, domains and ranges. The copies keep
 * their IRIs but are this model's own from then on. Nothing that is already in the model is
 * overwritten. `attach` is for working out what an imported ontology adds, not for editing: it
 * also brings in what the ontology says about entities the model only refers to.
 */
export function copyEntities(model: Model, ref: Pick<ExternalRef, 'id' | 'name' | 'namespace'>, ext: Model, chosen: { terms: string[]; props: string[] }, attach = false): CopyResult {
  const place = placer(model);
  const terms = [...model.terms];
  const props = [...model.props];
  const relations = [...model.relations];
  const termByIri = new Map(terms.filter((t) => t.iri).map((t) => [t.iri!, t]));
  const propByIri = new Map(props.filter((p) => p.iri).map((p) => [p.iri!, p]));
  const skipped: string[] = [];
  let copied = 0;
  let referenced = 0;

  const extTerm = new Map(ext.terms.map((t) => [t.id, t]));
  const termId = new Map<string, string>();
  /** Subjects whose statements come along: the copies, and with `attach` the references too. */
  const speaking = new Set<string>();
  for (const id of chosen.terms) {
    const t = extTerm.get(id);
    if (!t?.iri) continue;
    const here = termByIri.get(t.iri);
    if (here) {
      termId.set(id, here.id);
      if (attach && here.external !== undefined) speaking.add(id);
      else skipped.push(t.iri);
      continue;
    }
    const { domains: _d, ranges: _r, values: _v, external: _e, ...rest } = t;
    const copy: Term = { ...rest, ...portableRanges(t, ext, model), id: uid(), ...place() };
    terms.push(copy);
    termByIri.set(t.iri, copy);
    termId.set(id, copy.id);
    speaking.add(id);
    copied++;
  }
  /** The model's term for a term of the external ontology: its copy, or failing that a reference to it. */
  const termFor = (id: string): string | undefined => {
    if (termId.has(id)) return termId.get(id);
    const t = extTerm.get(id);
    if (!t?.iri) return undefined;
    let here = termByIri.get(t.iri);
    if (!here) {
      here = newTerm({ name: t.name, type: t.type, iri: t.iri, description: t.description, external: ref.id, ...portableRanges(t, ext, model), ...place() });
      terms.push(here);
      termByIri.set(t.iri, here);
      referenced++;
    }
    termId.set(id, here.id);
    return here.id;
  };

  // Properties by their id in the external ontology; `propId` gives the model's property for each.
  const extProp = new Map(ext.props.map((p) => [p.id, p]));
  const propId = new Map<string, string>();
  const speakingProps = new Set<string>();
  for (const id of chosen.props) {
    const p = extProp.get(id);
    if (!p?.iri) continue;
    const here = propByIri.get(p.iri);
    if (here) {
      propId.set(id, here.id);
      if (attach && here.external !== undefined) speakingProps.add(id);
      else skipped.push(p.iri);
      continue;
    }
    // It keeps its name, even where a property of the model has the same one: they are told apart by IRI.
    const { domains: _d, ranges: _r, parents: _p, inverses: _i, equivalents: _e, disjoints: _j, external: _x, ...rest } = p;
    const copy: ObjProp = { ...rest, id: uid() };
    props.push(copy);
    propByIri.set(p.iri, copy);
    propId.set(id, copy.id);
    speakingProps.add(id);
    copied++;
  }
  /** The model's property for a property of the external ontology: its copy, or failing that a reference to it. */
  const propFor = (id: string): ObjProp | undefined => {
    const known = propId.get(id);
    if (known) return props.find((p) => p.id === known);
    const p = extProp.get(id);
    if (!p?.iri) return undefined;
    let here = propByIri.get(p.iri);
    if (!here) {
      here = newProp({ name: p.name, description: p.description, iri: p.iri, external: ref.id });
      props.push(here);
      propByIri.set(p.iri, here);
      referenced++;
    }
    propId.set(id, here.id);
    return here;
  };

  /** Axioms as they are, the classes they name that the ontology has brought along as references. */
  const withClassesOf = (axioms: ClassAxiom[]): ClassAxiom[] => {
    for (const a of axioms) for (const iri of namedClasses(a.expression)) for (const [id, t] of extTerm) if (t.iri === iri) termFor(id);
    return axioms;
  };
  // What the ontology says about each copied entity comes along.
  const said = (r: Pick<Relation, 'from' | 'to' | 'kind' | 'predicate' | 'label'>, prop?: string) => `${r.from}|${r.to}|${r.kind}|${r.predicate ?? ''}|${prop ?? nameKey(r.label)}`;
  const stated = new Set(model.relations.map((r) => said(r, propOf(model, r)?.id)));
  for (const r of ext.relations) {
    if (!speaking.has(r.from)) continue;
    const from = termFor(r.from);
    const to = termFor(r.to);
    if (!from || !to) continue;
    const used = propOf(ext, r);
    const prop = used ? propFor(used.id) : undefined;
    const label = prop?.name ?? r.label;
    const k = said({ ...r, from, to, label }, prop?.id);
    if (stated.has(k)) continue;
    stated.add(k);
    const { id: _id, prop: _prop, ...rest } = r;
    relations.push(newRelation({ ...(rest as Relation), from, to, label, ...(prop ? { prop: prop.id } : {}) }));
  }
  for (const id of speaking) {
    const t = extTerm.get(id)!;
    const mine = terms.findIndex((x) => x.id === termId.get(id));
    if (mine < 0) continue;
    // A domain names classes by IRI, which are the same here; those the ontology has come along as references.
    const domains = t.domains && withClassesOf(t.domains);
    const values = t.values?.map((v) => ({ ...v, prop: termFor(v.prop) ?? '' })).filter((v) => v.prop);
    if (domains || values?.length) terms[mine] = { ...terms[mine], ...(domains ? { domains } : {}), ...(values?.length ? { values } : {}) };
  }
  for (const id of speakingProps) {
    const p = extProp.get(id)!;
    const at = props.findIndex((x) => x.iri === p.iri);
    if (at < 0) continue;
    const next: ObjProp = { ...props[at] };
    if (p.domains) next.domains = withClassesOf(p.domains);
    if (p.ranges) next.ranges = withClassesOf(p.ranges);
    if (attach && next.external !== undefined) next.chars = [...new Set([...next.chars, ...p.chars])];
    for (const link of PROP_LINKS) {
      const linked = p[link]?.map((x) => propFor(x)?.id).filter((x): x is string => !!x && x !== next.id);
      if (linked?.length) next[link] = [...new Set([...(next[link] ?? []), ...linked])];
    }
    props[at] = next;
  }
  // The ontology's own equivalences and the like need its standard properties to be read as such.
  const vocab = ext.vocab.enabled && !model.vocab.enabled && relations.some((r) => r.predicate) ? { ...model.vocab, enabled: true } : model.vocab;
  if (!copied && !referenced && relations.length === model.relations.length && props.every((p, i) => p === model.props[i])) return { model, copied: 0, skipped, referenced: 0 };
  return { model: { ...model, vocab, terms, props, relations }, copied, skipped, referenced };
}

const everything = (ext: Model) => ({ terms: ext.terms.map((t) => t.id), props: ext.props.map((p) => p.id) });

/**
 * The key under which the content of an ontology is kept by its ontology IRI: an ontology that
 * another one imports is known by that IRI, not by an id this editor gave it.
 */
export const iriKey = (iri: string) => `iri:${iri}`;

export interface Closure {
  model: Model;
  /** Imports whose content is not available, the ones it imports directly and those they import. */
  missing: ExternalRef[];
}

/**
 * The model together with the content of the ontologies it imports: what a reasoner has to
 * look at, since an imported ontology's axioms hold in the importing one, and so do those of
 * the ontologies that one imports. It is followed transitively, once per ontology, and worked out
 * when needed and never stored; an import whose content is not available is left out and named.
 *
 * `loaded` holds content by the reference's id (the model's own externals) and by `iriKey`
 * (an ontology another one imports, and the same ontologies held by IRI).
 */
export function importsClosure(model: Model, loaded: Map<string, Model>): Closure {
  let out = model;
  const missing: ExternalRef[] = [];
  const seen = new Set<string>();
  const identity = (ref: ExternalRef) => ref.iri || ref.namespace || ref.id;
  const resolve = (ref: ExternalRef): Model | undefined => (ref.iri ? (loaded.get(iriKey(ref.iri)) ?? loaded.get(ref.iri)) : undefined) ?? loaded.get(ref.id);
  // An import found in another ontology is named as the model's own reference to it, where it has one.
  const known = (ref: ExternalRef) => (ref.iri ? (model.externals.find((e) => e.iri === ref.iri) ?? ref) : ref);
  // What is to be read, and then what those ontologies import in turn.
  const queue = model.externals.filter((e) => e.imports);
  while (queue.length) {
    const ref = queue.shift()!;
    if (seen.has(identity(ref))) continue;
    seen.add(identity(ref));
    const ext = resolve(ref);
    if (!ext) {
      missing.push(known(ref));
      continue;
    }
    out = copyEntities(out, ref, ext, everything(ext), true).model;
    for (const next of ext.externals) if (next.imports) queue.push(next);
  }
  return { model: out, missing };
}

/** How the model uses an external ontology: which of its entities are referred to, and in how many statements. */
export function externalUse(model: Model, id: string): { entities: number; statements: number } {
  const terms = new Set(model.terms.filter((t) => t.external === id).map((t) => t.id));
  const props = objectProperties(model).filter((p) => p.external === id);
  const statements = model.relations.filter((r) => terms.has(r.from) || terms.has(r.to)).length + props.reduce((n, p) => n + p.rels.length, 0);
  return { entities: terms.size + props.length, statements };
}

/**
 * Takes an external ontology out of the model, with the references to its entities that
 * nothing uses. Refused while statements of the model still refer to its entities: those would
 * have to go too, and that is for the user to decide.
 */
export function removeExternal(model: Model, id: string): { model: Model; error?: undefined } | { error: string; model?: undefined } {
  const use = externalUse(model, id);
  const ref = model.externals.find((e) => e.id === id);
  if (use.statements) return { error: `${use.statements} statement${use.statements === 1 ? '' : 's'} in this ontology still refer to entities of “${ref?.name ?? 'it'}”. Remove those first (the Mappings tab lists them).` };
  const gone = new Set(model.terms.filter((t) => t.external === id).map((t) => t.id));
  // What the domains and ranges said of its entities goes with them.
  const iris = new Set([...model.terms.filter((t) => gone.has(t.id)), ...model.props.filter((p) => p.external === id)].map((x) => x.iri).filter((x): x is string => !!x));
  return {
    model: withoutEntities(
      {
        ...model,
        externals: model.externals.filter((e) => e.id !== id),
        terms: model.terms.filter((t) => !gone.has(t.id)),
        props: model.props.filter((p) => p.external !== id),
      },
      iris,
    ),
  };
}

/** Adds an external ontology to the model's list. One with the same ontology IRI is replaced, keeping its id so references stay. */
export function addExternal(model: Model, summary: ExternalSummary, imports: boolean, now = Date.now()): { model: Model; ref: ExternalRef } {
  const same = model.externals.find((e) => (summary.ref.iri && e.iri === summary.ref.iri) || (!summary.ref.iri && e.namespace === summary.ref.namespace));
  const ref: ExternalRef = { ...summary.ref, id: same?.id ?? 'x' + uid(), addedAt: now, imports: imports || !!same?.imports };
  // References made before the ontology was known (from an imported file) are now known to be its own.
  const owned = (iri?: string) => !!iri && !!ref.namespace && iri.startsWith(ref.namespace);
  // The prefix the ontology itself uses for its namespace is taken over, unless the name is taken, so that its IRIs read as they do there.
  const declared = summary.model.prefixes.find((p) => p.iri === ref.namespace);
  const prefixes = declared && !model.prefixes.some((p) => p.iri === declared.iri || p.prefix === declared.prefix) && ref.namespace !== model.baseIri ? [...model.prefixes, declared] : model.prefixes;
  return {
    ref,
    model: {
      ...model,
      prefixes,
      externals: same ? model.externals.map((e) => (e.id === same.id ? ref : e)) : [...model.externals, ref],
      terms: model.terms.map((t) => (t.external === '' && owned(t.iri) ? { ...t, external: ref.id } : t)),
      props: model.props.map((p) => (p.external === '' && owned(p.iri) ? { ...p, external: ref.id } : p)),
    },
  };
}

export { namespaceOf };
