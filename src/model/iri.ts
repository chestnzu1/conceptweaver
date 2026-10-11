import type { Model } from './types';

/** A name that only stands in until the user types a real one; no IRI is made from it. */
const PLACEHOLDER = /^new (class|concept|data property|individual|term|property( \d+)?)$/i;

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

/**
 * Gives an IRI to every named term and object property that has none yet, in the model's base
 * namespace. An IRI is made once, from the name the entity has at that moment, and is never
 * changed afterwards: renaming an entity changes its label, not its identity.
 */
export function withIris(m: Model): Model {
  const needs = (x: { iri?: string; name: string }) => !x.iri && !!x.name.trim() && !PLACEHOLDER.test(x.name.trim());
  if (!m.terms.some(needs) && !m.props.some(needs)) return m;
  const base = baseIriOf(m);
  const used = new Set<string>();
  // The first IRIs settle the default namespace, so that it does not shift when the model is renamed.
  const baseIri = m.baseIri.trim() ? m.baseIri : base;
  for (const x of [...m.terms, ...m.props]) if (x.iri) used.add(x.iri.toLowerCase());
  const mint = (name: string, camel: boolean) => {
    const local = localName(name, camel);
    let iri = base + local;
    for (let i = 2; used.has(iri.toLowerCase()); i++) iri = `${base}${local}_${i}`;
    used.add(iri.toLowerCase());
    return iri;
  };
  return {
    ...m,
    baseIri,
    terms: m.terms.map((t) => (needs(t) ? { ...t, iri: mint(t.name, t.type === 'property') } : t)),
    props: m.props.map((p) => (needs(p) ? { ...p, iri: mint(p.name, true) } : p)),
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
  return { ...m, props, terms: terms.map((t) => (t.axioms?.some((a) => inText(a) !== a) ? { ...t, axioms: t.axioms.map(inText) } : t)) };
}
