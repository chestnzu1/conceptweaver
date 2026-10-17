import { standardAnnotation } from './annotations';
import { STANDARD } from './prefixes';
import { DESCRIPTION_PROPERTIES, NAME_PROPERTIES, type ExtraField, type Model } from './types';

/** An entity with a name and a description, and fields in other languages. */
export interface Labeled {
  name: string;
  description?: string;
  nameLang?: string;
  descriptionLang?: string;
  fields?: ExtraField[];
}

const LABEL_KEYS = new Set<string>(NAME_PROPERTIES);
const DESCRIPTION_KEYS = new Set<string>(DESCRIPTION_PROPERTIES);
const LOCAL = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;

/** The standard name of a field key, written as a prefixed name or as its full IRI. */
export function standardFieldKey(key: string): string | undefined {
  const k = key.trim();
  if (!k) return undefined;
  const curie = standardAnnotation(k);
  if (curie) return curie;
  for (const p of STANDARD) {
    if (!k.startsWith(p.iri)) continue;
    const local = k.slice(p.iri.length);
    if (LOCAL.test(local)) return `${p.prefix}:${local}`;
  }
  return undefined;
}

const sameLang = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

/**
 * The first field of the entity that is a name in `lang`: rdfs:label, skos:prefLabel or
 * dcterms:title, written as a prefixed name or a full IRI. -1 if it has none.
 */
export function labelFieldAt(fields: ExtraField[] | undefined, lang: string): number {
  return fieldAt(fields, lang, LABEL_KEYS);
}

/** The first field of the entity that is a definition in `lang`; -1 if it has none. */
export function descriptionFieldAt(fields: ExtraField[] | undefined, lang: string): number {
  return fieldAt(fields, lang, DESCRIPTION_KEYS);
}

function fieldAt(fields: ExtraField[] | undefined, lang: string, keys: Set<string>): number {
  if (!lang || !fields?.length) return -1;
  return fields.findIndex((f) => !f.iri && !f.dt && f.value.trim() !== '' && sameLang(f.lang, lang) && keys.has(standardFieldKey(f.key) ?? ''));
}

/** The entity's name in `lang`; its own name when that is in `lang`, or when it has none in it. */
export function nameIn(x: Labeled, modelLang: string, lang: string): string {
  if (!lang) return x.name;
  if (x.name.trim() && sameLang(x.nameLang ?? modelLang, lang)) return x.name;
  const at = labelFieldAt(x.fields, lang);
  return at >= 0 ? x.fields![at].value : x.name;
}

/** The entity's description in `lang`; its own description when that is in `lang`, or when it has none in it. */
export function descriptionIn(x: Labeled, modelLang: string, lang: string): string {
  if (!lang) return x.description ?? '';
  if ((x.description ?? '').trim() && sameLang(x.descriptionLang ?? modelLang, lang)) return x.description!;
  const at = descriptionFieldAt(x.fields, lang);
  return at >= 0 ? x.fields![at].value : (x.description ?? '');
}

/**
 * Every language the model has names, descriptions or annotations in: its own, and each entity's
 * own and its fields'. The model's language first, then the rest alphabetically. Empty for a
 * model with no language at all.
 */
export function modelLanguages(m: Model): string[] {
  const found = new Set<string>();
  const add = (lang: string | undefined) => {
    if (lang) found.add(lang.toLowerCase());
  };
  add(m.lang);
  add(m.nameLang);
  add(m.descriptionLang);
  for (const x of [...m.terms, ...m.props, ...m.annProps, ...m.datatypes]) {
    add(x.nameLang);
    add(x.descriptionLang);
    for (const f of (x as { fields?: ExtraField[] }).fields ?? []) add(f.lang);
  }
  const primary = m.lang.toLowerCase();
  return [...(primary ? [primary] : []), ...[...found].filter((l) => l !== primary).sort()];
}

/** A language tag's name in the reader's locale, e.g. "en" → "English"; the tag itself if unknown. */
export function languageName(tag: string): string {
  if (!tag) return 'untagged';
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
