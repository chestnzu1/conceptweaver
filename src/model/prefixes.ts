import { baseIriOf } from './iri';
import type { Model, Prefix } from './types';

/** Namespaces fixed by their standards. They are always available and cannot be redefined. */
export const STANDARD: Prefix[] = [
  { prefix: 'rdf', iri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' },
  { prefix: 'rdfs', iri: 'http://www.w3.org/2000/01/rdf-schema#' },
  { prefix: 'owl', iri: 'http://www.w3.org/2002/07/owl#' },
  { prefix: 'xsd', iri: 'http://www.w3.org/2001/XMLSchema#' },
  { prefix: 'skos', iri: 'http://www.w3.org/2004/02/skos/core#' },
  { prefix: 'dcterms', iri: 'http://purl.org/dc/terms/' },
];

const PREFIX_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** An absolute IRI: a scheme, a colon, and no spaces or characters Turtle cannot hold between < and >. */
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/;
/** What may follow a prefix in a prefixed name without escaping. */
const LOCAL = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;

export const isAbsoluteIri = (s: string) => ABSOLUTE.test(s);

/** The IRI of the ontology itself: as configured, or else the default namespace without its last character. */
export function ontologyIriOf(m: Model): string {
  return m.ontologyIri.trim() || baseIriOf(m).replace(/[#/]$/, '');
}

/**
 * Every prefix in force, in the order abbreviation tries them: the model's own prefixes first,
 * then its default namespace (the empty prefix), then the standard ones.
 */
export function allPrefixes(m: Model): (Prefix & { kind: 'custom' | 'default' | 'standard' })[] {
  return [...m.prefixes.map((p) => ({ ...p, kind: 'custom' as const })), { prefix: '', iri: baseIriOf(m), kind: 'default' as const }, ...STANDARD.map((p) => ({ ...p, kind: 'standard' as const }))];
}

/**
 * The prefixed form of an IRI ("ex:Actor", or ":Actor" in the default namespace), or undefined
 * if no prefix covers it. Only how the IRI is written: the IRI itself is never touched.
 */
export function compactIri(m: Model, iri: string): string | undefined {
  let best: Prefix | undefined;
  for (const p of allPrefixes(m)) {
    // The longest namespace wins; among equals the first, so a named prefix beats the default.
    if (iri.startsWith(p.iri) && LOCAL.test(iri.slice(p.iri.length)) && (!best || p.iri.length > best.iri.length)) best = p;
  }
  return best ? `${best.prefix}:${iri.slice(best.iri.length)}` : undefined;
}

/** The full IRI for a prefixed name, or undefined if the prefix is not known. */
export function expandIri(m: Model, curie: string): string | undefined {
  const at = curie.indexOf(':');
  const p = at < 0 ? undefined : allPrefixes(m).find((x) => x.prefix === curie.slice(0, at));
  return p ? p.iri + curie.slice(at + 1) : undefined;
}

export interface SettingsDraft {
  ontologyIri: string;
  baseIri: string;
  prefixes: Prefix[];
}

/**
 * What is wrong with a set of ontology settings, as messages for the user; empty when it can
 * be saved. `rows[i]` is the problem with the i-th custom prefix, if it has one.
 */
export function validateSettings(d: SettingsDraft): { ontologyIri?: string; baseIri?: string; rows: (string | undefined)[]; ok: boolean } {
  const out: ReturnType<typeof validateSettings> = { rows: [], ok: true };
  const base = d.baseIri.trim();
  if (d.ontologyIri.trim() && !isAbsoluteIri(d.ontologyIri.trim())) out.ontologyIri = 'Not an IRI. It should look like http://example.org/ontology';
  if (base && !isAbsoluteIri(base)) out.baseIri = 'Not an IRI. It should look like http://example.org/ontology#';
  else if (base && !/[#/:]$/.test(base)) out.baseIri = 'A namespace ends with # or /, so that names can be added to it.';
  d.prefixes.forEach((p, i) => {
    const name = p.prefix.trim();
    const iri = p.iri.trim();
    const standard = STANDARD.find((s) => s.prefix.toLowerCase() === name.toLowerCase());
    let problem: string | undefined;
    if (!name && !iri) problem = 'Fill it in or remove it.';
    else if (!PREFIX_NAME.test(name)) problem = 'A prefix is letters, digits, _ or -, starting with a letter.';
    else if (standard) problem = `“${standard.prefix}” is a standard prefix and always means ${standard.iri}`;
    else if (d.prefixes.some((q, j) => j < i && q.prefix.trim().toLowerCase() === name.toLowerCase())) problem = `“${name}” is defined twice.`;
    else if (!isAbsoluteIri(iri)) problem = 'The namespace is not an IRI.';
    else if (!/[#/:]$/.test(iri)) problem = 'A namespace ends with # or /.';
    else if (STANDARD.some((s) => s.iri === iri)) problem = `That namespace already has the standard prefix “${STANDARD.find((s) => s.iri === iri)!.prefix}”.`;
    else if (d.prefixes.some((q, j) => j < i && q.iri.trim() === iri)) problem = 'Another prefix already stands for this namespace.';
    out.rows.push(problem);
  });
  out.ok = !out.ontologyIri && !out.baseIri && out.rows.every((r) => !r);
  return out;
}
