import { standardAnnotation } from './annotations';
import { expandIri, isAbsoluteIri } from './prefixes';
import { objectProperties, propKey } from './props';
import { DATATYPES, ENUM_RANGE, META_GROUPS, uid, type EntityKind, type ExtraField, type GovernanceConfig, type MetaField, type Model, type Term, type ValueType } from './types';

/**
 * Governance and catalogue metadata: who owns an entity, how sensitive it is, where its data
 * lives, how good that data is. None of it is logic. Every value is an annotation on the entity
 * (the same list the Annotations panel edits), stated with a property of an established
 * vocabulary where there is one, so nothing here changes what a class means.
 *
 * Which fields exist is not built into the screens: they are drawn from the registry below,
 * and a model can add fields of its own and change which kinds of entity each applies to.
 */

export const KIND_LABEL: Record<EntityKind, string> = {
  class: 'Class / concept',
  objectProperty: 'Object property',
  dataProperty: 'Data property',
  individual: 'Individual',
  businessAsset: 'Business data asset',
  technicalAsset: 'Technical data asset',
};
export const KIND_SHORT: Record<EntityKind, string> = { class: 'Class', objectProperty: 'Obj. prop.', dataProperty: 'Data prop.', individual: 'Individual', businessAsset: 'Business asset', technicalAsset: 'Technical asset' };

export const TYPE_LABEL: Record<ValueType, string> = {
  text: 'Text',
  longtext: 'Long text',
  date: 'Date',
  dateTime: 'Date and time',
  integer: 'Whole number',
  number: 'Number',
  boolean: 'Yes / no',
  iri: 'Link (IRI)',
  entity: 'Entity or name',
  choice: 'Controlled vocabulary',
};

/** The datatype a value of each type is written with; text, choices and references have none. */
const DATATYPE: Partial<Record<ValueType, string>> = { date: 'xsd:date', dateTime: 'xsd:dateTime', integer: 'xsd:integer', number: 'xsd:decimal', boolean: 'xsd:boolean' };

const [C, O, D, I, B, T]: EntityKind[] = ['class', 'objectProperty', 'dataProperty', 'individual', 'businessAsset', 'technicalAsset'];
const ALL = [C, O, D, I, B, T];
type Def = Omit<MetaField, 'order' | 'multiple' | 'required' | 'about'> & { about?: string; multiple?: boolean };
const group = (name: MetaField['group'], defs: Def[]): MetaField[] => defs.map((d, i) => ({ about: '', multiple: false, required: false, ...d, group: name, order: (i + 1) * 10 }));
const g = (id: string, label: string, property: string, type: ValueType, appliesTo: EntityKind[], rest: Partial<Def> = {}): Def => ({ id, label, property, type, appliesTo, group: 'General', ...rest });

/**
 * The standard fields. `property` is the RDF property a value is stated with. Where no
 * established vocabulary has a fitting one it is left empty, and the field becomes an
 * annotation property of the model's own namespace, named after the field.
 */
export const DEFAULT_FIELDS: MetaField[] = [
  ...group('General', [
    g('name', 'Business name', 'rdfs:label', 'text', ALL, { bind: 'name', about: 'The name people know it by: its label. Changing it does not change the IRI.' }),
    g('definition', 'Business definition', 'skos:definition', 'longtext', ALL, { bind: 'description', about: 'What it means, in business terms.' }),
    g('entityType', 'Entity type', 'rdf:type', 'text', ALL, { bind: 'type', about: 'What kind of entity it is in the model.' }),
    g('domain', 'Business domain', 'dcat:theme', 'entity', ALL, { multiple: true, about: 'The subject area it belongs to, such as Customer Management.' }),
    g('keywords', 'Tags and keywords', 'dcat:keyword', 'text', ALL, { multiple: true, about: 'Words to find it by.' }),
    g('altLabels', 'Alternative labels', 'skos:altLabel', 'text', [C, D, I, B, T], { bind: 'synonyms', multiple: true, about: 'Other names it goes by: its synonyms.' }),
    g('note', 'Notes', 'skos:note', 'longtext', [C, D, I, B, T], { about: 'A general remark about it.' }),
    g('scopeNote', 'Scope note', 'skos:scopeNote', 'longtext', [C], { about: 'What it does and does not cover.' }),
    g('concepts', 'Related semantic concepts', 'dcterms:subject', 'entity', [B, T], { multiple: true, about: 'The classes or concepts this asset holds data about.' }),
  ]),
  ...group('Governance', [
    g('owner', 'Data owner', 'dcterms:rightsHolder', 'entity', [C, O, D, I, B], { about: 'The person or organisation accountable for it.' }),
    g('steward', 'Data steward', 'dcat:contactPoint', 'entity', ALL, { about: 'Who looks after it day to day, and whom to ask about it.' }),
    g('technicalOwner', 'Technical owner', '', 'entity', [D, T], { about: 'Who runs the system it lives in.' }),
    g('department', 'Responsible department', 'dcterms:publisher', 'entity', [C, B, T], { about: 'The department that makes it available.' }),
    g('sensitivity', 'Sensitivity classification', 'dcterms:accessRights', 'choice', [C, D, B, T], { options: ['Public', 'Internal', 'Confidential', 'Restricted'], about: 'Who may see it.' }),
    g('status', 'Lifecycle status', 'adms:status', 'choice', ALL, { options: ['Draft', 'Under Review', 'Approved', 'Deprecated'], about: 'Where it stands in its review.' }),
    g('policies', 'Governance policies', 'dcterms:conformsTo', 'entity', [D, B, T], { multiple: true, about: 'The policies and standards it has to follow.' }),
  ]),
  ...group('Technical', [
    g('source', 'Source system', 'dcterms:source', 'entity', [D, T], { about: 'The system the data comes from.' }),
    g('database', 'Database', '', 'text', [D, T]),
    g('schema', 'Schema', '', 'text', [D, T]),
    g('table', 'Table', '', 'text', [D, T]),
    g('column', 'Column', '', 'text', [D, T]),
    g('range', 'Data type', 'rdfs:range', 'choice', [D], { bind: 'range', about: 'The datatype of the property’s values: its range.' }),
    g('physicalType', 'Physical data type', '', 'text', [T], { about: 'The type it has where it is stored, such as VARCHAR(40).' }),
    g('format', 'Data format', 'dcterms:format', 'text', [D, T], { about: 'The file format or media type, such as text/csv.' }),
    g('location', 'Storage location', 'dcat:accessURL', 'iri', [T], { about: 'Where it can be reached.' }),
    g('assets', 'Related data assets', 'dcterms:relation', 'entity', [C, D, B, T], { multiple: true, about: 'Datasets and other assets that go with it.' }),
    g('services', 'Associated APIs or data products', 'dcat:accessService', 'entity', [B, T], { multiple: true }),
    g('upstream', 'Upstream dependencies', 'prov:wasDerivedFrom', 'entity', [T], { multiple: true, about: 'What it is derived from.' }),
    g('downstream', 'Downstream dependencies', 'dcterms:isRequiredBy', 'entity', [T], { multiple: true, about: 'What depends on it.' }),
  ]),
  ...group('Operational', [
    g('created', 'Creation date', 'dcterms:created', 'date', ALL),
    g('modified', 'Last modified date', 'dcterms:modified', 'date', ALL),
    g('creator', 'Created by', 'dcterms:creator', 'entity', ALL),
    g('modifiedBy', 'Last modified by', 'prov:wasAttributedTo', 'entity', ALL, { about: 'Who its present state is attributed to.' }),
    g('version', 'Version', 'owl:versionInfo', 'text', ALL),
    g('refresh', 'Refresh frequency', 'dcterms:accrualPeriodicity', 'choice', [B, T], { options: ['Continuous', 'Hourly', 'Daily', 'Weekly', 'Monthly', 'Quarterly', 'Annual', 'Irregular'], about: 'How often the data is renewed.' }),
  ]),
  ...group('Data quality', [
    g('qualityStatus', 'Quality status', '', 'choice', [D, B, T], { options: ['Not assessed', 'Passed', 'Warning', 'Failed'] }),
    ...(['Quality score', 'Completeness', 'Accuracy', 'Validity', 'Freshness'] as const).map((label) =>
      g(label === 'Quality score' ? 'qualityScore' : label.toLowerCase(), label, '', 'number', [D, B, T], { measure: true, min: 0, max: 100, about: 'A measurement from 0 to 100, recorded as a DQV quality measurement.' }),
    ),
    g('validation', 'Related validation results', '', 'text', ALL, { bind: 'validation', about: 'What the model’s quality rules have to say about this entity.' }),
  ]),
];

/** Every field of a model: the standard ones as the model has adjusted them, then its own. */
export function registry(model: Pick<Model, 'governance'>): MetaField[] {
  const { custom, overrides } = model.governance;
  const rank = (f: MetaField) => META_GROUPS.indexOf(f.group);
  return [...DEFAULT_FIELDS.map((f) => (overrides[f.id] ? { ...f, ...overrides[f.id] } : f)), ...custom].sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.label.localeCompare(b.label));
}

/** The name a field's values are filed under in an entity's annotations. */
export const fieldKey = (f: Pick<MetaField, 'property' | 'label'>): string => (f.property.trim() ? (standardAnnotation(f.property) ?? f.property.trim()) : f.label.trim());
const norm = (key: string) => (standardAnnotation(key) ?? key.trim()).toLowerCase();
export const sameKey = (a: string, b: string) => norm(a) === norm(b);

/**
 * The IRI an annotation key written as a prefixed name or as a full IRI stands for; undefined
 * for a plain name, which becomes a property of the model's own namespace.
 */
export function keyIri(m: Model, key: string): string | undefined {
  const k = key.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(k) || /^urn:\S+$/i.test(k)) return isAbsoluteIri(k) ? k : undefined;
  const at = k.indexOf(':');
  if (at <= 0 || /\s/.test(k)) return undefined;
  return expandIri(m, k);
}

// ---------------------------------------------------------------- which entity, which kind

export type MetaOwner = { term: string } | { prop: string };

/** The metadata profile an entity is given: stated as its dcterms:type. */
export const PROFILE_KEY = 'dcterms:type';
const PROFILES: [string, EntityKind][] = [
  ['Business data asset', 'businessAsset'],
  ['Technical data asset', 'technicalAsset'],
];
const TERM_KIND: Record<Term['type'], EntityKind> = { concept: 'class', property: 'dataProperty', instance: 'individual' };

/** What a term is by its place in the model, whatever profile it has been given. */
export const structuralKind = (model: Model, t: Pick<Term, 'type'>): EntityKind => (model.mode === 'skos' ? 'class' : TERM_KIND[t.type]);

export function termKind(model: Model, t: Pick<Term, 'type' | 'fields'>): EntityKind {
  const profile = t.fields.find((f) => sameKey(f.key, PROFILE_KEY) && PROFILES.some(([name]) => name.toLowerCase() === f.value.trim().toLowerCase()));
  return profile ? PROFILES.find(([name]) => name.toLowerCase() === profile.value.trim().toLowerCase())![1] : structuralKind(model, t);
}

/** The annotations of a term with its profile set to `kind`; its own structural kind takes the profile away. */
export function withProfile(model: Model, t: Term, kind: EntityKind): ExtraField[] {
  const rest = t.fields.filter((f) => !(sameKey(f.key, PROFILE_KEY) && PROFILES.some(([name]) => name.toLowerCase() === f.value.trim().toLowerCase())));
  const profile = PROFILES.find(([, k]) => k === kind);
  return profile && kind !== structuralKind(model, t) ? [...rest, { key: PROFILE_KEY, value: profile[0] }] : rest;
}

/** One entity as the metadata page sees it, whether it is a term or an object property. */
export interface MetaEntity {
  owner: MetaOwner;
  /** The term id, or "prop:" and the property's key. */
  id: string;
  name: string;
  description: string;
  synonyms: string;
  iri?: string;
  kind: EntityKind;
  structural: EntityKind;
  fields: ExtraField[];
  range?: string;
  external: boolean;
}

export function metaEntities(model: Model): MetaEntity[] {
  const terms = model.terms.map((t): MetaEntity => ({ owner: { term: t.id }, id: t.id, name: t.name, description: t.description, synonyms: t.synonyms, iri: t.iri, kind: termKind(model, t), structural: structuralKind(model, t), fields: t.fields, range: t.range, external: t.external !== undefined }));
  if (model.mode === 'skos') return terms;
  const props = objectProperties(model).map((p): MetaEntity => ({ owner: { prop: p.key }, id: 'prop:' + p.key, name: p.name, description: p.description, synonyms: '', iri: p.iri, kind: 'objectProperty', structural: 'objectProperty', fields: p.fields ?? [], external: p.external !== undefined }));
  return [...terms, ...props];
}

export function metaEntity(model: Model, owner: MetaOwner): MetaEntity | undefined {
  if ('term' in owner) {
    const t = model.terms.find((x) => x.id === owner.term);
    return t && { owner, id: t.id, name: t.name, description: t.description, synonyms: t.synonyms, iri: t.iri, kind: termKind(model, t), structural: structuralKind(model, t), fields: t.fields, range: t.range, external: t.external !== undefined };
  }
  return metaEntities(model).find((e) => 'prop' in e.owner && e.owner.prop === propKey(owner.prop));
}

/** The fields that apply to a kind of entity, in the order they are shown. */
export const fieldsFor = (model: Model, kind: EntityKind): MetaField[] => registry(model).filter((f) => f.appliesTo.includes(kind) && !(f.bind === 'synonyms' && kind === 'objectProperty'));

// ---------------------------------------------------------------- values

export interface MetaValue {
  value: string;
  /** An IRI: an entity of the model, or a resource elsewhere. */
  iri?: boolean;
  lang?: string;
}

const KIND_TYPE: Record<EntityKind, string> = { class: 'owl:Class', objectProperty: 'owl:ObjectProperty', dataProperty: 'owl:DatatypeProperty', individual: 'owl:NamedIndividual', businessAsset: '', technicalAsset: '' };

/** What an entity has for a field. A field bound to the name, definition or synonyms reads those. */
export function valuesOf(model: Model, e: MetaEntity, f: MetaField): MetaValue[] {
  const one = (v: string | undefined) => (v?.trim() ? [{ value: v }] : []);
  switch (f.bind) {
    case 'name':
      return one(e.name);
    case 'description':
      return one(e.description);
    case 'synonyms':
      return e.synonyms.split(',').map((s) => s.trim()).filter(Boolean).map((value) => ({ value }));
    case 'type':
      return [{ value: model.mode === 'skos' ? 'Concept (skos:Concept)' : `${KIND_LABEL[e.structural]} (${KIND_TYPE[e.structural]})` }];
    case 'range':
      return one(e.range);
    case 'validation':
      return [];
  }
  const key = fieldKey(f);
  return e.fields.filter((x) => sameKey(x.key, key) && x.value.trim() && !(sameKey(key, PROFILE_KEY) && PROFILES.some(([n]) => n.toLowerCase() === x.value.trim().toLowerCase()))).map((x) => ({ value: x.value, ...(x.iri ? { iri: true } : {}), ...(x.lang ? { lang: x.lang } : {}) }));
}

const DATE = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|[+-]\d\d:\d\d)?$/;
const DATE_TIME = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)?$/;
const realDate = (s: string) => {
  const [y, m, d] = s.replace(/^-/, '').slice(0, 10).split('-').map(Number);
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Why a value cannot be a value of the field, or undefined if it can. */
export function checkValue(f: Pick<MetaField, 'type' | 'options' | 'min' | 'max' | 'label'>, v: MetaValue): string | undefined {
  const s = v.value.trim();
  if (!s) return 'A value cannot be empty.';
  const options = f.type === 'choice' ? (f.options ?? []) : [];
  switch (f.type) {
    case 'date':
      return DATE.test(s) && realDate(s) ? undefined : `“${s}” is not a date. A date is written as 2026-10-12.`;
    case 'dateTime':
      return DATE_TIME.test(s) && realDate(s) ? undefined : `“${s}” is not a date and time. It is written as 2026-10-12T09:30:00.`;
    case 'integer':
    case 'number': {
      if (!(f.type === 'integer' ? /^[+-]?\d+$/ : /^[+-]?(\d+(\.\d*)?|\.\d+)$/).test(s)) return `“${s}” is not a ${f.type === 'integer' ? 'whole number' : 'number'}.`;
      const n = Number(s);
      if (f.min !== undefined && n < f.min) return `${f.label} cannot be less than ${f.min}.`;
      if (f.max !== undefined && n > f.max) return `${f.label} cannot be more than ${f.max}.`;
      return undefined;
    }
    case 'boolean':
      return s === 'true' || s === 'false' ? undefined : `“${s}” is not true or false.`;
    case 'iri':
      return isAbsoluteIri(s) ? undefined : `“${s}” is not a link. It has to be a full IRI, such as https://example.org/data.`;
    case 'choice':
      return !options.length || options.some((o) => o.toLowerCase() === s.toLowerCase()) ? undefined : `“${s}” is not one of ${options.join(', ')}.`;
    case 'entity':
      return v.iri && !isAbsoluteIri(s) ? `“${s}” is not an IRI.` : undefined;
  }
  return undefined;
}

/** Why the values cannot be what an entity has for the field, or undefined if they can. */
export function checkValues(f: MetaField, values: MetaValue[]): string | undefined {
  if (f.bind === 'type' || f.bind === 'validation') return `${f.label} is not set here.`;
  if (!f.multiple && values.length > 1) return `${f.label} takes one value.`;
  if (f.bind === 'name' && !values.some((v) => v.value.trim())) return 'An entity needs a name.';
  if (f.bind === 'range') return values.every((v) => DATATYPES.some((d) => d.id === v.value) || v.value.startsWith(ENUM_RANGE)) ? undefined : 'That is not a datatype the app knows.';
  if (f.bind === 'synonyms' && values.some((v) => v.value.includes(','))) return 'An alternative label cannot contain a comma: the labels are kept as a list separated by commas.';
  for (const v of values) {
    const problem = checkValue(f, v);
    if (problem) return problem;
  }
  return undefined;
}

/** An entity's annotations with the values of one field replaced. The other annotations stay as they are, in place. */
export function writeValues(fields: ExtraField[], f: MetaField, values: MetaValue[]): ExtraField[] {
  const key = fieldKey(f);
  const dt = DATATYPE[f.type];
  const seen = new Set<string>();
  const fresh: ExtraField[] = [];
  for (const v of values) {
    const value = f.type === 'choice' ? (f.options?.find((o) => o.toLowerCase() === v.value.trim().toLowerCase()) ?? v.value.trim()) : v.value.trim();
    const iri = f.type === 'iri' || (f.type === 'entity' && !!v.iri);
    const id = `${iri ? 'i' : 'l'}|${value}|${v.lang ?? ''}`;
    if (!value || seen.has(id)) continue;
    seen.add(id);
    fresh.push({ key, value, ...(v.lang && !iri && !dt ? { lang: v.lang } : {}), ...(dt ? { dt } : {}), ...(iri ? { iri: true } : {}), ...(f.measure ? { measure: true } : {}) });
  }
  const at = fields.findIndex((x) => sameKey(x.key, key));
  const rest = fields.filter((x) => !sameKey(x.key, key));
  const index = at < 0 ? rest.length : fields.slice(0, at).filter((x) => !sameKey(x.key, key)).length;
  return [...rest.slice(0, index), ...fresh, ...rest.slice(index)];
}

// ---------------------------------------------------------------- governance rules

export interface MetaProblem {
  entity: MetaEntity;
  field: MetaField;
  kind: 'missing' | 'invalid';
  message: string;
}

/** Required fields without a value, and values that are not what their field takes. */
export function metaProblems(model: Model, entities = metaEntities(model)): MetaProblem[] {
  const out: MetaProblem[] = [];
  const byKind = new Map<EntityKind, MetaField[]>();
  for (const e of entities) {
    // An entity of another ontology is described there, not here.
    if (e.external) continue;
    const fields = byKind.get(e.kind) ?? byKind.set(e.kind, fieldsFor(model, e.kind)).get(e.kind)!;
    for (const f of fields) {
      if (f.bind === 'type' || f.bind === 'validation') continue;
      const values = valuesOf(model, e, f);
      if (f.required && !values.length) out.push({ entity: e, field: f, kind: 'missing', message: `“${e.name || 'Unnamed'}” has no ${f.label.toLowerCase()}, which is required for a ${KIND_LABEL[e.kind].toLowerCase()}.` });
      if (f.bind) continue;
      if (!f.multiple && values.length > 1) out.push({ entity: e, field: f, kind: 'invalid', message: `“${e.name || 'Unnamed'}” has ${values.length} values for ${f.label.toLowerCase()}, which takes one.` });
      for (const v of values) {
        const problem = checkValue(f, v);
        if (problem) out.push({ entity: e, field: f, kind: 'invalid', message: `${f.label} of “${e.name || 'Unnamed'}”: ${problem}` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- configuring the registry

type Change = { model: Model; note?: string; error?: undefined } | { error: string; model?: undefined; note?: undefined };

const rekey = (fields: ExtraField[] | undefined, from: string, to: string) => (fields?.some((x) => sameKey(x.key, from)) ? fields.map((x) => (sameKey(x.key, from) ? { ...x, key: to } : x)) : fields);

/** Why a field cannot be set up like this, or undefined if it can. */
function fieldProblem(m: Model, f: MetaField): string | undefined {
  if (!f.label.trim()) return 'A field needs a name.';
  const property = f.property.trim();
  if (property && !standardAnnotation(property) && !keyIri(m, property)) {
    const prefix = property.includes(':') ? property.slice(0, property.indexOf(':')) : '';
    return prefix && !/\s/.test(property) ? `The prefix “${prefix}” is not known. Add it in the ontology settings, or write the property as a full IRI.` : 'The RDF property has to be a prefixed name (dcterms:audience) or a full IRI. Leave it empty for a property of the model’s own namespace.';
  }
  const clash = registry(m).find((x) => x.id !== f.id && (sameKey(fieldKey(x), fieldKey(f)) || x.label.trim().toLowerCase() === f.label.trim().toLowerCase()));
  if (clash) return clash.label.trim().toLowerCase() === f.label.trim().toLowerCase() ? `There is already a field called “${clash.label}”.` : `“${clash.label}” is already stored as ${fieldKey(f)}. Two fields on one property would show the same values.`;
  if (f.type === 'choice' && !f.options?.length) return 'A controlled vocabulary needs at least one value to choose from.';
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) return 'The lowest number allowed is above the highest.';
  return undefined;
}

const config = (m: Model, governance: GovernanceConfig): Model => ({ ...m, governance });

export function addCustomField(m: Model, draft: Partial<MetaField> & { label: string }): Change {
  const f: MetaField = { about: '', property: '', appliesTo: ['class', 'objectProperty', 'dataProperty', 'individual', 'businessAsset', 'technicalAsset'], type: 'text', multiple: false, required: false, group: 'Custom', order: (Math.max(0, ...m.governance.custom.map((x) => x.order)) || 0) + 10, ...draft, label: draft.label.trim(), id: 'f' + uid(), custom: true };
  const problem = fieldProblem(m, f);
  return problem ? { error: problem } : { model: config(m, { ...m.governance, custom: [...m.governance.custom, f] }) };
}

/** Changes a field of the model's own. Renaming it, or giving it another property, moves its values along. */
export function updateCustomField(m: Model, id: string, patch: Partial<MetaField>): Change {
  const old = m.governance.custom.find((f) => f.id === id);
  if (!old) return { error: 'That field no longer exists.' };
  const next: MetaField = { ...old, ...patch, id, custom: true, label: (patch.label ?? old.label).trim(), property: (patch.property ?? old.property).trim() };
  if (next.type !== 'choice') delete next.options;
  if (next.type !== 'number' && next.type !== 'integer') {
    delete next.min;
    delete next.max;
  }
  const problem = fieldProblem(m, next);
  if (problem) return { error: problem };
  const [from, to] = [fieldKey(old), fieldKey(next)];
  const moved = from !== to;
  return {
    model: {
      ...config(m, { ...m.governance, custom: m.governance.custom.map((f) => (f.id === id ? next : f)) }),
      ...(moved ? { terms: m.terms.map((t) => (rekey(t.fields, from, to) === t.fields ? t : { ...t, fields: rekey(t.fields, from, to)! })), props: m.props.map((p) => (rekey(p.fields, from, to) === p.fields ? p : { ...p, fields: rekey(p.fields, from, to)! })) } : {}),
    },
  };
}

/** Takes a field of the model's own out of the registry. Values entities have for it stay, as ordinary annotations. */
export function removeCustomField(m: Model, id: string): Change {
  const f = m.governance.custom.find((x) => x.id === id);
  if (!f) return { model: m };
  const key = fieldKey(f);
  const used = [...m.terms, ...m.props].filter((x) => x.fields?.some((v) => sameKey(v.key, key))).length;
  return { model: config(m, { ...m.governance, custom: m.governance.custom.filter((x) => x.id !== id) }), ...(used ? { note: `“${f.label}” is no longer a field. The values ${used} ${used === 1 ? 'entity has' : 'entities have'} for it are kept as annotations.` } : {}) };
}

/** Changes which kinds of entity a standard field applies to, or whether it is required. Only what differs from the standard is kept. */
export function overrideField(m: Model, id: string, patch: { appliesTo?: EntityKind[]; required?: boolean }): Change {
  const base = DEFAULT_FIELDS.find((f) => f.id === id);
  if (!base) return { error: 'That is not a standard field.' };
  const merged = { ...m.governance.overrides[id], ...patch };
  const same = (a: EntityKind[], b: EntityKind[]) => a.length === b.length && a.every((k) => b.includes(k));
  if (merged.appliesTo && same(merged.appliesTo, base.appliesTo)) delete merged.appliesTo;
  if (merged.required === base.required) delete merged.required;
  const overrides = { ...m.governance.overrides };
  if (Object.keys(merged).length) overrides[id] = merged;
  else delete overrides[id];
  return { model: config(m, { ...m.governance, overrides }) };
}

/** Text an entity can be found by through its metadata: the values, and the names of the entities they point to. */
export function metaText(e: MetaEntity, nameOf: (iri: string) => string | undefined): string {
  return e.fields.map((f) => (f.iri ? `${nameOf(f.value) ?? ''} ${f.value}` : f.value)).join('\n');
}
