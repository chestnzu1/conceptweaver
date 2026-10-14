import type { ExtraField, Model } from './types';
import { renameIris } from './unmapped';

/** A name that only stands in until the user types a real one; no IRI is made from it. */
const PLACEHOLDER = /^new (class|concept|data property|individual|term|property( \d+)?|datatype( \d+)?)$/i;

/** The last part of an IRI made from a name: "Release date" → "ReleaseDate" (or "releaseDate" for a property). */
export function localName(name: string, camel: boolean): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let s = parts.map((p, i) => (camel && i === 0 ? p[0].toLowerCase() : p[0].toUpperCase()) + p.slice(1)).join('');
  if (!s) s = camel ? 'relatedTo' : 'Term';
  if (/^\p{N}/u.test(s)) s = '_' + s;
  return s;
}

/** The namespace new IRIs are made in: the model's base IRI, or one derived from its name. */
export function baseIriOf(m: Model): string {
  const slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
  const base = m.baseIri.trim() || `http://example.org/${slug}#`;
  return /[#/]$/.test(base) ? base : base + '#';
}

/** What an entity is called in an IRI that stands in until it has a name, by its kind. */
const STAND_IN = { concept: 'Class', property: 'Data property', instance: 'Individual', prop: 'Object property', datatype: 'Datatype' } as const;

/**
 * Gives every entity an IRI, in the model's base namespace, from the moment it exists (FR-M1-2).
 * An entity with a name gets one made from it. One without a name yet, or with a name that only
 * stands in ("New class"), gets one that stands in too, marked `pendingIri`: the first real name
 * it is given replaces it, once, and whatever referred to it follows. After that an IRI is never
 * changed by a rename: renaming an entity changes its label, not its identity.
 */
export function withIris(m: Model): Model {
  const named = (x: { name: string }) => !!x.name.trim() && !PLACEHOLDER.test(x.name.trim());
  const needs = (x: { iri?: string; name: string; pendingIri?: true }) => !x.iri || (!!x.pendingIri && named(x));
  const datatypes = m.datatypes ?? [];
  const lacks = (d: { iri?: string; name: string; pendingIri?: true; anonymous?: boolean }) => !d.anonymous && needs(d);
  if (!m.terms.some(needs) && !m.props.some(needs) && !datatypes.some(lacks)) return m;
  const base = baseIriOf(m);
  const used = new Set<string>();
  // The first IRIs settle the default namespace, so that it does not shift when the model is renamed.
  const baseIri = m.baseIri.trim() ? m.baseIri : base;
  for (const x of [...m.terms, ...m.props, ...datatypes]) if (x.iri) used.add(x.iri.toLowerCase());
  const mint = (name: string, camel: boolean) => {
    const local = localName(name, camel);
    let iri = base + local;
    for (let i = 2; used.has(iri.toLowerCase()); i++) iri = `${base}${local}_${i}`;
    used.add(iri.toLowerCase());
    return iri;
  };
  // Stand-in IRIs replaced by ones made from a name: what referred to them follows.
  const replaced = new Map<string, string>();
  const give = <T extends { iri?: string; name: string; pendingIri?: true }>(x: T, camel: boolean, standIn: string): T => {
    if (!needs(x)) return x;
    if (named(x)) {
      const iri = mint(x.name, camel);
      if (x.iri) replaced.set(x.iri, iri);
      const { pendingIri: _was, ...rest } = x;
      return { ...rest, iri } as T;
    }
    return { ...x, iri: mint(x.name.trim() || standIn, camel), pendingIri: true };
  };
  const skos = m.mode === 'skos';
  const out: Model = {
    ...m,
    baseIri,
    terms: m.terms.map((t) => give(t, t.type === 'property', skos ? 'Concept' : STAND_IN[t.type])),
    props: m.props.map((p) => give(p, true, STAND_IN.prop)),
    // A datatype is named like a class: StatusCode.
    ...(datatypes.some(lacks) ? { datatypes: datatypes.map((d) => (d.anonymous ? d : give(d, false, STAND_IN.datatype))) } : {}),
  };
  return replaced.size ? followIris(out, replaced) : out;
}

/**
 * Makes whatever refers to entities by IRI follow when their IRIs change (old → new): class
 * expressions kept as text, annotations that point at them, SHACL shapes, the records of
 * mappings and of suggestions turned down, and the statements kept as they were read. The
 * entities themselves are not touched.
 */
export function followIris(m: Model, changed: Map<string, string>): Model {
  if (!changed.size) return m;
  const swap = (x: string) => changed.get(x) ?? x;
  const inText = (text: string) => text.replace(/<([^<>\s]*)>/g, (all, iri: string) => (changed.has(iri) ? `<${changed.get(iri)}>` : all));
  const all = (list: string[]) => (list.some((x) => changed.has(x)) ? list.map(swap) : list);
  const refs = <T extends { fields?: ExtraField[] }>(x: T): T => (x.fields?.some((f) => f.iri && changed.has(f.value)) ? { ...x, fields: x.fields.map((f) => (f.iri && changed.has(f.value) ? { ...f, value: swap(f.value) } : f)) } : x);
  return {
    ...m,
    terms: m.terms.map((t) => {
      const out = refs(t);
      return out.axioms?.some((a) => inText(a) !== a) ? { ...out, axioms: out.axioms.map(inText) } : out;
    }),
    props: m.props.map(refs),
    shapes: {
      extra: inText(m.shapes.extra),
      nodes: m.shapes.nodes.map((n) => ({
        ...n,
        targetClass: all(n.targetClass),
        targetNode: all(n.targetNode),
        targetSubjectsOf: all(n.targetSubjectsOf),
        targetObjectsOf: all(n.targetObjectsOf),
        properties: n.properties.map((s) => ({
          ...s,
          path: swap(s.path),
          ...(s.class ? { class: swap(s.class) } : {}),
          ...(s.hasValue?.iri ? { hasValue: { ...s.hasValue, v: swap(s.hasValue.v) } } : {}),
          ...(s.in ? { in: s.in.map((v) => (v.iri ? { ...v, v: swap(v.v) } : v)) } : {}),
        })),
      })),
    },
    mappings: m.mappings.map((x) => (changed.has(x.source) || changed.has(x.target) ? { ...x, source: swap(x.source), target: swap(x.target) } : x)),
    rejected: m.rejected.map((r) => r.split('|').map(swap).join('|')),
    ...(m.unmapped ? { unmapped: renameIris(m.unmapped, changed) } : {}),
  };
}

/**
 * Moves every entity whose IRI is in one namespace into another, keeping the last part of each
 * IRI: http://old.org/ns#Actor becomes http://new.org/ns#Actor. Entities in any other namespace
 * are left alone. This changes identifiers, so it is only ever done when the user asks for it.
 */
export function moveNamespace(m: Model, from: string, to: string): Model {
  if (!from || from === to) return m;
  const taken = new Set([...m.terms, ...m.props].filter((x) => x.iri && !x.iri.startsWith(from)).map((x) => x.iri!.toLowerCase()));
  const moved = (iri: string | undefined) => {
    if (!iri?.startsWith(from)) return iri;
    // Should the new namespace already hold that name, the moved one gets a number rather than colliding.
    let next = to + iri.slice(from.length);
    for (let i = 2; taken.has(next.toLowerCase()); i++) next = `${to}${iri.slice(from.length)}_${i}`;
    taken.add(next.toLowerCase());
    return next;
  };
  const renamed = new Map<string, string>();
  const term = <T extends { iri?: string }>(x: T): T => {
    const iri = moved(x.iri);
    if (iri === x.iri) return x;
    renamed.set(x.iri!, iri!);
    return { ...x, iri };
  };
  const terms = m.terms.map(term);
  const props = m.props.map(term);
  // Class expressions kept as text mention IRIs in full; those follow too.
  const inText = (axiom: string) => axiom.replace(/<([^>]*)>/g, (all, iri: string) => (renamed.has(iri) ? `<${renamed.get(iri)}>` : all));
  // So do annotations that point at a moved entity.
  const refs = <T extends { fields?: ExtraField[] }>(x: T): T => (x.fields?.some((f) => f.iri && renamed.has(f.value)) ? { ...x, fields: x.fields.map((f) => (f.iri && renamed.has(f.value) ? { ...f, value: renamed.get(f.value)! } : f)) } : x);
  // And so do the statements kept as they were read.
  const unmapped = renameIris(m.unmapped, renamed);
  return { ...m, props: props.map(refs), terms: terms.map((t) => refs(t.axioms?.some((a) => inText(a) !== a) ? { ...t, axioms: t.axioms.map(inText) } : t)), ...(unmapped ? { unmapped } : {}) };
}

/** Where the last part of an IRI starts: after its final # or /. */
export const iriCut = (iri: string) => Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1;

/** Which entity an IRI belongs to: a term by id, or an object property by id. */
export type IriOwner = { term: string } | { prop: string };

/**
 * Gives an entity another identifier: the last part of its IRI, after the namespace. The label
 * is not touched, and neither is the namespace (that is what the ontology settings are for).
 * Whatever refers to the entity by IRI follows: kept class expressions, SHACL shapes, and the
 * records of mappings. Refused, with the reason, if the name cannot be part of an IRI or the
 * IRI is already taken.
 */
export function setIriSuffix(m: Model, owner: IriOwner, suffix: string): { model: Model; note?: string; error?: undefined } | { error: string; model?: undefined; note?: undefined } {
  const entity = 'term' in owner ? m.terms.find((t) => t.id === owner.term) : m.props.find((p) => p.id === owner.prop);
  if (!entity) return { error: 'That entity no longer exists.' };
  if (entity.external !== undefined) return { error: 'This entity belongs to another ontology, so its IRI is not this model’s to change.' };
  const local = suffix.trim();
  if (!local) return { error: 'The IRI needs a last part: it cannot be empty.' };
  const bad = local.match(/[\s<>"{}|\\^`#/]/);
  if (bad) return { error: bad[0] === '#' || bad[0] === '/' ? `“${bad[0]}” ends the namespace, so it cannot be in the last part of the IRI. The namespace is changed in the ontology settings.` : `${/\s/.test(bad[0]) ? 'A space' : `“${bad[0]}”`} cannot be part of an IRI.` };
  const base = baseIriOf(m);
  const old = entity.iri;
  const next = (old ? old.slice(0, iriCut(old)) : base) + local;
  if (next === old) return { model: m };
  const taken = [...m.terms, ...m.props].find((x) => x !== entity && x.iri?.toLowerCase() === next.toLowerCase());
  if (taken) return { error: `“${taken.name || 'Unnamed'}” already has the IRI <${taken.iri}>.` };

  // Chosen by hand: it no longer stands in for one to be made from a name.
  const set = <T extends { iri?: string; pendingIri?: true }>(x: T): T => {
    const { pendingIri: _was, ...rest } = x;
    return { ...rest, iri: next } as T;
  };
  const moved: Model = {
    ...m,
    // The first IRI settles the default namespace, as it does when one is made from a name.
    baseIri: m.baseIri.trim() ? m.baseIri : base,
    terms: m.terms.map((t) => (t === entity ? set(t) : t)),
    props: m.props.map((p) => (p === entity ? set(p) : p)),
  };
  // Whatever refers to it by IRI keeps referring to it.
  return { model: old ? followIris(moved, new Map([[old, next]])) : moved };
}
