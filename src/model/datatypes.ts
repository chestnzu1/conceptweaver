import type { Edit } from './axioms';
import { validateLiteral } from './literals';
import { compactIri } from './prefixes';
import { DATATYPES, ENUM_RANGE, isLang, uid, type EnumDatatype, type EnumLiteral, type Model } from './types';

/**
 * Enumerated datatypes: datatypes that are a list of literal values (DataOneOf). They are kept
 * in the model beside the terms, not among them. A datatype is not a class and its values are
 * not individuals, and nothing here lets the two be mixed up: a data property names one as its
 * range, and that is the only place it is used.
 */

export const enumRange = (id: string) => ENUM_RANGE + id;
export const isEnumRange = (range: string | undefined): boolean => !!range && range.startsWith(ENUM_RANGE);

/** The enumerated datatype a range names, if it names one that exists. */
export const enumOf = (model: Pick<Model, 'datatypes'>, range: string | undefined): EnumDatatype | undefined => (isEnumRange(range) ? model.datatypes.find((d) => d.id === range!.slice(ENUM_RANGE.length)) : undefined);

/** What a range is called where it is shown: "date" for xsd:date, the name for an enumerated datatype. */
export function rangeLabel(model: Pick<Model, 'datatypes'>, range: string | undefined, long = false): string {
  if (!range) return '';
  if (isEnumRange(range)) return enumOf(model, range)?.name || 'enumeration';
  return long ? range : (range.split(':')[1] ?? range);
}

/** The data properties that have a datatype as their range. */
export const usersOf = (model: Model, id: string) => model.terms.filter((t) => t.type === 'property' && t.range === enumRange(id));

const sameLiteral = (a: EnumLiteral, b: EnumLiteral) => a.value === b.value && (a.dt ?? '') === (b.dt ?? '') && (a.lang ?? '') === (b.lang ?? '');
const q = (s: string) => `“${s}”`;

const NUMERIC = new Set(['xsd:integer', 'xsd:decimal', 'xsd:double']);
const truth = (s: string) => (s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : undefined);

/**
 * Whether a value, as it is written, is the literal a datatype lists. Text is the same text. A
 * number is the same number however it is written ("01" is 1), and true is 1: to call those
 * two values would be to find a contradiction where OWL has none.
 */
export function denotes(listed: EnumLiteral, value: string, lang = ''): boolean {
  if ((listed.lang ?? '') !== lang) return false;
  if (listed.value === value) return true;
  if (listed.dt && NUMERIC.has(listed.dt)) return value.trim() !== '' && Number.isFinite(Number(value)) && Number(listed.value) === Number(value);
  if (listed.dt === 'xsd:boolean') return truth(value) !== undefined && truth(listed.value) === truth(value);
  return false;
}

/** A literal as it is written in Turtle: "active", "3"^^xsd:integer, "actif"@fr. */
export const literalText = (v: EnumLiteral): string => JSON.stringify(v.value) + (v.lang ? '@' + v.lang : v.dt && v.dt !== 'xsd:string' ? '^^' + v.dt : '');

/** A new enumerated datatype with no values yet. Its name has to be its own. */
export function addDatatype(model: Model, name: string): Edit & { id?: string } {
  const clean = name.trim();
  if (!clean) return { error: 'The datatype needs a name.' };
  if (model.datatypes.some((d) => d.name.trim().toLowerCase() === clean.toLowerCase())) return { error: `There is already a datatype called ${q(clean)}.` };
  const d: EnumDatatype = { id: 'd' + uid(), name: clean, description: '', values: [] };
  return { model: { ...model, datatypes: [...model.datatypes, d] }, id: d.id };
}

export function updateDatatype(model: Model, id: string, patch: Partial<Pick<EnumDatatype, 'name' | 'description'>>): Edit {
  const d = model.datatypes.find((x) => x.id === id);
  if (!d) return { error: 'That datatype no longer exists.' };
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) return { error: 'The datatype needs a name.' };
  if (name && model.datatypes.some((x) => x.id !== id && x.name.trim().toLowerCase() === name.toLowerCase())) return { error: `There is already a datatype called ${q(name)}.` };
  // Named from now on: a datatype written in place has no name to change.
  return { model: { ...model, datatypes: model.datatypes.map((x) => (x.id === id ? { ...x, ...patch, ...(name ? { name } : {}) } : x)) } };
}

/** Takes a datatype out of the model. The properties that had it as their range are left without one. */
export function removeDatatype(model: Model, id: string): Edit {
  const d = model.datatypes.find((x) => x.id === id);
  if (!d) return { model };
  const users = usersOf(model, id);
  return {
    model: { ...model, datatypes: model.datatypes.filter((x) => x.id !== id), terms: model.terms.map((t) => (users.includes(t) ? (({ range: _, ...rest }) => rest)(t) : t)) },
    ...(users.length ? { note: `${q(d.name)} is gone. ${users.map((t) => q(t.name)).join(', ')} ${users.length === 1 ? 'has' : 'have'} no range now.` } : {}),
  };
}

/**
 * Adds a value to a datatype. It has to be a literal that can be written: of the datatype it
 * claims, with a language only where it is text, and not already among the values.
 */
export function addEnumValue(model: Model, id: string, draft: { value: string; dt?: string; lang?: string }): Edit {
  const d = model.datatypes.find((x) => x.id === id);
  if (!d) return { error: 'That datatype no longer exists.' };
  const dt = draft.dt && draft.dt !== 'xsd:string' ? draft.dt : undefined;
  const lang = draft.lang?.trim().toLowerCase() || undefined;
  // Text is kept as typed, spaces inside it and all; anything else has no use for spaces around it.
  const value = dt ? draft.value.trim() : draft.value;
  if (!value.trim()) return { error: 'Enter a value.' };
  if (dt && !DATATYPES.some((x) => x.id === dt)) return { error: `${q(dt)} is not a datatype the app knows.` };
  const bad = validateLiteral(value, dt);
  if (bad) return { error: bad };
  if (lang && !isLang(lang)) return { error: `${q(lang)} is not a language code. Use one like en, nl or zh.` };
  if (lang && dt) return { error: `A language only goes with text. This value is ${DATATYPES.find((x) => x.id === dt)?.label ?? dt}.` };
  const literal: EnumLiteral = { value, ...(dt ? { dt } : {}), ...(lang ? { lang } : {}) };
  if (d.values.some((v) => sameLiteral(v, literal))) return { error: `${literalText(literal)} is already one of the values of ${q(d.name)}.` };
  return { model: { ...model, datatypes: model.datatypes.map((x) => (x.id === id ? { ...x, values: [...x.values, literal] } : x)) } };
}

export function removeEnumValue(model: Model, id: string, index: number): Model {
  return { ...model, datatypes: model.datatypes.map((x) => (x.id === id ? { ...x, values: x.values.filter((_, i) => i !== index) } : x)) };
}

/**
 * Whether a value an individual has for a property is one its range allows, where the range is
 * an enumerated datatype: the reason it is not, or undefined when it is, or when the range is
 * not an enumeration at all.
 */
export function outsideEnumeration(model: Model, range: string | undefined, v: { value: string; lang?: string; dt?: string }): string | undefined {
  const d = enumOf(model, range);
  if (!d) return undefined;
  const fits = d.values.some((x) => x.value === v.value && (x.lang ?? '') === (v.lang ?? '') && (!v.dt || (x.dt ?? 'xsd:string') === v.dt));
  return fits ? undefined : `${JSON.stringify(v.value)}${v.lang ? '@' + v.lang : ''} is not one of the values of ${q(d.name)}: ${d.values.map(literalText).join(', ') || 'it has none yet'}.`;
}

/** The datatype as it is written to RDF, for showing: a named datatype equivalent to a list of literals, or the list alone. */
export function datatypeTurtle(model: Model, d: EnumDatatype): string {
  const list = `[ a rdfs:Datatype ; owl:oneOf ( ${d.values.map(literalText).join(' ')} ) ]`;
  if (d.anonymous) return d.values.length ? list : '(no values yet: nothing is written for it)';
  const name = d.iri ? (compactIri(model, d.iri) ?? `<${d.iri}>`) : ':…';
  return d.values.length ? `${name} a rdfs:Datatype ;\n    owl:equivalentClass ${list} .` : `${name} a rdfs:Datatype .`;
}
