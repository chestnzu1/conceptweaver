import { noLayout, normalizeLayout, type GraphLayout } from '../layout/types';
import { noStyle, normalizeGraphStyle, type GraphStyle } from './graphStyle';
import { STANDARD } from './prefixes';

export type TermType = 'concept' | 'property' | 'instance';
export type RelKind = 'association' | 'generalization' | 'property';

export const TERM_TYPES: { value: TermType; label: string }[] = [
  { value: 'concept', label: 'Concept' },
  { value: 'property', label: 'Property' },
  { value: 'instance', label: 'Instance' },
];

export const REL_KINDS: { value: RelKind; label: string }[] = [
  { value: 'association', label: 'Relationship' },
  { value: 'generalization', label: 'Is a (generalization)' },
  { value: 'property', label: 'Has property (domain)' },
];

/** Datatypes offered as the range of a data property. */
export const DATATYPES: { id: string; label: string }[] = [
  { id: 'xsd:string', label: 'text' },
  { id: 'rdf:langString', label: 'text with a language' },
  { id: 'xsd:integer', label: 'whole number' },
  { id: 'xsd:decimal', label: 'decimal number' },
  { id: 'xsd:double', label: 'floating-point number' },
  { id: 'xsd:boolean', label: 'true / false' },
  { id: 'xsd:date', label: 'date' },
  { id: 'xsd:dateTime', label: 'date and time' },
  { id: 'xsd:time', label: 'time' },
  { id: 'xsd:gYear', label: 'year' },
  { id: 'xsd:duration', label: 'duration' },
  { id: 'xsd:anyURI', label: 'link (URI)' },
];

/**
 * The kinds of term. A property term is a data property: its values are literals such as text
 * or dates. Object properties, which link two terms, are the relationships (see ObjProp).
 */
export const TYPE_CHOICES: { value: TermType; label: string; patch: Pick<Term, 'type'> }[] = [
  { value: 'concept', label: 'Class / concept', patch: { type: 'concept' } },
  { value: 'property', label: 'Data property', patch: { type: 'property' } },
  { value: 'instance', label: 'Individual', patch: { type: 'instance' } },
];

export const typeChoice = (t: Pick<Term, 'type'>): TermType => t.type;

/**
 * An object property of an ontology: a named, reusable kind of relationship. A relationship on
 * the canvas is a use of it by naming it in `Relation.prop`, and carries its name as its label.
 */
/** The properties a description is read from, and written back with. */
export const DESCRIPTION_PROPERTIES = ['skos:definition', 'rdfs:comment', 'dcterms:description'] as const;
export type DescriptionProperty = (typeof DESCRIPTION_PROPERTIES)[number];
/** The properties the ontology's own name is read from, and written back with. */
export const NAME_PROPERTIES = ['rdfs:label', 'skos:prefLabel', 'dcterms:title'] as const;
export type NameProperty = (typeof NAME_PROPERTIES)[number];

export interface ObjProp {
  /**
   * What the property is known by inside the model: relationships and other properties refer to
   * it by this. It never changes and is never written to RDF, where the IRI identifies it. Two
   * properties may have the same name (from two ontologies, say); never the same id.
   */
  id: string;
  name: string;
  description: string;
  /**
   * The property the description was read from, where it is not the one this app writes
   * (skos:definition; for the ontology itself rdfs:comment): it is written back with that one.
   */
  describedBy?: DescriptionProperty;
  /**
   * The language the name and the description were written in, where it is not the model's
   * (`lang`): '' for none. They are written back in it.
   */
  nameLang?: string;
  descriptionLang?: string;
  /** Term ids. Left out, the domain (or range) follows the relationships that use the property. */
  domain?: string[];
  range?: string[];
  /** Ids from CHARACTERISTICS, e.g. "transitive". */
  chars: string[];
  /**
   * Other object properties, by id: the ones it specialises (rdfs:subPropertyOf), its inverses,
   * and the ones it is equivalent to or disjoint with. The last three hold both ways and are
   * stored on one of the two properties.
   */
  parents?: string[];
  inverses?: string[];
  equivalents?: string[];
  disjoints?: string[];
  /** Annotations other than the name and description, as on a term. */
  fields?: ExtraField[];
  /** Full IRI: kept from an import, or made once from the name. */
  iri?: string;
  /**
   * The IRI only stands in: it was made before the entity had a name, and is replaced once, by
   * one made from the first name it is given (see withIris). Not set on any other IRI.
   */
  pendingIri?: true;
  /** Defined in another ontology and only referred to here: the id of that ontology, or '' if it is not known. */
  external?: string;
}

/** The lists of other properties an object property can carry. */
export const PROP_LINKS = ['parents', 'inverses', 'equivalents', 'disjoints'] as const;
export type PropLink = (typeof PROP_LINKS)[number];

/** A literal value an individual has for a data property. */
export interface DataValue {
  /** Id of the data property term. */
  prop: string;
  value: string;
  lang?: string;
  /** Datatype stated on the value itself, when it is not simply the property's range. */
  dt?: string;
}

/** One of the values of an enumerated datatype: a literal, with its datatype or its language where it has one. */
export interface EnumLiteral {
  value: string;
  /** The datatype it is written with ("xsd:integer"). Left out, it is plain text. */
  dt?: string;
  /** A language tag, which only text can have. */
  lang?: string;
}

/**
 * A datatype defined by listing its values: StatusCode is exactly "active", "inactive",
 * "pending" (a datatype equivalent to an owl:oneOf of literals). It is a datatype and nothing
 * else: not a class, not a term on the canvas, and its values are literals, not individuals.
 */
export interface EnumDatatype {
  id: string;
  name: string;
  description: string;
  /**
   * The property the description was read from, where it is not the one this app writes
   * (skos:definition; for the ontology itself rdfs:comment): it is written back with that one.
   */
  describedBy?: DescriptionProperty;
  /**
   * The language the name and the description were written in, where it is not the model's
   * (`lang`): '' for none. They are written back in it.
   */
  nameLang?: string;
  descriptionLang?: string;
  values: EnumLiteral[];
  /** Full IRI: kept from an import, or made once from the name. */
  iri?: string;
  /**
   * The IRI only stands in: it was made before the entity had a name, and is replaced once, by
   * one made from the first name it is given (see withIris). Not set on any other IRI.
   */
  pendingIri?: true;
  /** Written in place wherever it is the range of a property, with no name of its own, as some files have it. */
  anonymous?: boolean;
}

/** How a data property refers to an enumerated datatype as its range. */
export const ENUM_RANGE = 'enum:';

export const COLORS = ['', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;

export interface ExtraField {
  key: string;
  value: string;
  /** Language tag of the value, e.g. "nl". */
  lang?: string;
  /** Datatype of a value that is not text: "xsd:date", "xsd:decimal", "xsd:boolean" and the like. */
  dt?: string;
  /** The value is an IRI (an entity of this model or a resource elsewhere), not text. */
  iri?: boolean;
  /** A quality measurement: the property names the metric that was measured (dqv:isMeasurementOf). */
  measure?: boolean;
}

/** What the model is: an OWL ontology, or a SKOS concept scheme (thesaurus, taxonomy, glossary). */
export type ModelMode = 'ontology' | 'skos';

export interface Term {
  id: string;
  name: string;
  description: string;
  /**
   * The property the description was read from, where it is not the one this app writes
   * (skos:definition; for the ontology itself rdfs:comment): it is written back with that one.
   */
  describedBy?: DescriptionProperty;
  /**
   * The language the name and the description were written in, where it is not the model's
   * (`lang`): '' for none. They are written back in it.
   */
  nameLang?: string;
  descriptionLang?: string;
  type: TermType;
  color: string;
  x: number;
  y: number;
  synonyms: string;
  fields: ExtraField[];
  /** Full IRI: kept from an import, or made once from the name (see withIris). */
  iri?: string;
  /**
   * The IRI only stands in: it was made before the entity had a name, and is replaced once, by
   * one made from the first name it is given (see withIris). Not set on any other IRI.
   */
  pendingIri?: true;
  /**
   * For a data property: the datatype of its values. Either one of the standard ones, by name
   * ("xsd:date"), or an enumerated datatype of the model, as "enum:" and its id (see EnumDatatype).
   */
  range?: string;
  /** For a data property: the classes that can have it, when set by hand. Otherwise the classes it is attached to. */
  domain?: string[];
  /**
   * Asserted axioms about a class that have no drawing of their own, kept word for word: a
   * predicate and a class expression in Turtle, such as
   * "rdfs:subClassOf [ owl:intersectionOf ( … ) ]". They come from imported ontologies.
   */
  axioms?: string[];
  /** For a data property: each thing has at most one value (owl:FunctionalProperty). */
  functional?: boolean;
  /** For an individual: the literal values it has for data properties. */
  values?: DataValue[];
  /**
   * For a class that is defined by listing its members: the individuals it consists of, by term
   * id (owl:equivalentClass [ owl:oneOf ( … ) ]). Present, even when empty, the class is an
   * enumeration; absent, it is an ordinary class. Either way it is a class and nothing else.
   */
  oneOf?: string[];
  /**
   * For an enumeration: its members are stated to be different individuals (owl:AllDifferent).
   * Unless this is set nothing is assumed about that: two members may be one and the same thing.
   */
  allDifferent?: boolean;
  /**
   * Defined in another ontology and only referred to here, under its own IRI: the id of that
   * ontology (see Model.externals), or '' if it is not known. Its definition is not part of
   * this model and is not exported with it; statements made about it here are.
   */
  external?: string;
}

export interface Relation {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: RelKind;
  description: string;
  fromCard: string;
  toCard: string;
  /** Standard RDFS/OWL property this relation stands for, e.g. "owl:sameAs". */
  predicate?: string;
  /**
   * How a class is restricted by this relationship, when it uses an object property or has a
   * data property: every member has some / only / at least, at most or exactly N values of the
   * target class or datatype. "some" when not set.
   */
  restriction?: Quantifier;
  /** The number for min, max and exactly. */
  restrictionN?: number;
  /**
   * Further restrictions the same relationship states beside that first one: "directs some Film"
   * and also "directs only Film", or "min 1" together with "max 3".
   */
  more?: RestrictionSpec[];
  /**
   * The object property this relationship is a use of, by id (an association only). Its label is
   * then that property's name, in whatever case it was written, and follows it when the property
   * is renamed (see identity.ts).
   */
  prop?: string;
  /** Kept as a plain relationship even though its label is the name of an object property. */
  plain?: boolean;
}

export type Quantifier = 'some' | 'only' | 'min' | 'max' | 'exactly';
/** One restriction by a relationship: its quantifier, and the number where it has one. */
export interface RestrictionSpec {
  restriction: Quantifier;
  restrictionN?: number;
}
export const QUANTIFIERS: { id: Quantifier; about: string }[] = [
  { id: 'some', about: 'at least one such value' },
  { id: 'only', about: 'no values of any other kind' },
  { id: 'min', about: 'at least N such values' },
  { id: 'max', about: 'at most N such values' },
  { id: 'exactly', about: 'exactly N such values' },
];

/** A namespace prefix: "ex" for http://example.org/ns#, so that an IRI can be written ex:Actor. */
export interface Prefix {
  prefix: string;
  iri: string;
}

/**
 * The version of the model format this code writes. 1: object properties are known by their
 * name, lower-cased. 2 (from 2026-10-14): by an id of their own, which relationships and other
 * properties refer to. A model of version 1 is read and brought up to date by normalizeModel.
 */
export const MODEL_VERSION = 2;

export interface Model {
  format: 'conceptweaver';
  version: typeof MODEL_VERSION;
  name: string;
  description: string;
  /**
   * The property the description was read from, where it is not the one this app writes
   * (skos:definition; for the ontology itself rdfs:comment): it is written back with that one.
   */
  describedBy?: DescriptionProperty;
  /**
   * For the ontology's own name: the property it was read from where it is not the one written
   * (rdfs:label; skos:prefLabel for a vocabulary), and the language of the name and description
   * where it is not the model's ('' for none). They are written back so.
   */
  namedBy?: NameProperty;
  nameLang?: string;
  descriptionLang?: string;
  /** The default namespace: where the IRIs of new entities are made. */
  baseIri: string;
  /** The IRI of the ontology itself. Empty: the default namespace without its final # or /. */
  ontologyIri: string;
  /** The model's own namespace prefixes, beside the default namespace and the standard ones. */
  prefixes: Prefix[];
  mode: ModelMode;
  /** Language of the names, descriptions and synonyms, e.g. "en"; empty for untagged. */
  lang: string;
  /** Optional RDFS/OWL layer: whether it is on, and which relation labels map to which standard property. */
  vocab: { enabled: boolean; map: Record<string, string> };
  /** Declared object properties. A relationship is a use of one when it names it (Relation.prop). */
  props: ObjProp[];
  terms: Term[];
  relations: Relation[];
  shapes: Shapes;
  quality: QualityConfig;
  externals: ExternalRef[];
  mappings: MappingMeta[];
  /** Suggested mappings the user turned down ("source IRI|target IRI"), so they are not suggested again. */
  rejected: string[];
  /** How the governance metadata fields are set up for this model: fields of its own, and changes to the standard ones. */
  governance: GovernanceConfig;
  /** How the graph is drawn. Like the positions of the terms it is no part of the ontology and is never written to RDF. */
  style: GraphStyle;
  /** How the graph is arranged: which layout and its settings. Like the style, no part of the ontology and never written to RDF. */
  layout: GraphLayout;
  /** The enumerated datatypes of the model: datatypes defined by listing their values. */
  datatypes: EnumDatatype[];
  /**
   * Statements of an ontology that was read which the model has no place for (property chains,
   * keys, axiom annotations, an ontology's version IRI, …), kept as they were and written back
   * with it: Turtle, one statement at a time, with full IRIs (see unmapped.ts). Not shown or
   * edited here. Left out when there are none.
   */
  unmapped?: string;
}

/** The kinds of entity a metadata field can apply to. The last two are metadata profiles an entity is given. */
export const ENTITY_KINDS = ['class', 'objectProperty', 'dataProperty', 'individual', 'businessAsset', 'technicalAsset'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const VALUE_TYPES = ['text', 'longtext', 'date', 'dateTime', 'integer', 'number', 'boolean', 'iri', 'entity', 'choice'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];
export const META_GROUPS = ['General', 'Governance', 'Technical', 'Operational', 'Data quality', 'Custom'] as const;
export type MetaGroup = (typeof META_GROUPS)[number];

/** One metadata field of the registry: what it is called, the RDF property it is stored as, and what its values are. */
export interface MetaField {
  id: string;
  label: string;
  about: string;
  /**
   * The property its values are stated with: a prefixed name (dcterms:modified) or a full IRI.
   * Empty: a property of the model's own namespace, named after the field.
   */
  property: string;
  appliesTo: EntityKind[];
  type: ValueType;
  multiple: boolean;
  required: boolean;
  /** The values to choose from, for a controlled vocabulary. */
  options?: string[];
  group: MetaGroup;
  order: number;
  /** Shows something the entity already has (its name, definition, synonyms, kind, datatype, findings) rather than a field of its own. */
  bind?: 'name' | 'description' | 'synonyms' | 'type' | 'range' | 'validation';
  /** A quality metric: its values are DQV quality measurements. */
  measure?: boolean;
  /** The lowest and highest number allowed. */
  min?: number;
  max?: number;
  /** Added by the user, as opposed to one of the standard fields. */
  custom?: boolean;
}

export interface GovernanceConfig {
  custom: MetaField[];
  /** What the user changed about a standard field, by its id. */
  overrides: Record<string, { appliesTo?: EntityKind[]; required?: boolean }>;
}

/** A value in a SHACL constraint: an IRI, or a literal with its datatype or language. */
export interface ShapeValue {
  v: string;
  iri?: boolean;
  dt?: string;
  lang?: string;
}

export type ShaclSeverity = 'Violation' | 'Warning' | 'Info';
export const NODE_KINDS = ['IRI', 'Literal', 'BlankNode', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral'] as const;

/** One sh:property of a node shape: what the values reached by a path must be like. Entities are named by IRI. */
export interface PropertyShape {
  id: string;
  /** IRI of the property the values are reached by; `inverse` follows it backwards (sh:inversePath). */
  path: string;
  inverse?: boolean;
  name?: string;
  message?: string;
  severity?: ShaclSeverity;
  minCount?: number;
  maxCount?: number;
  /** A datatype as a prefixed name (xsd:string) or a full IRI. */
  datatype?: string;
  class?: string;
  nodeKind?: (typeof NODE_KINDS)[number];
  pattern?: string;
  flags?: string;
  in?: ShapeValue[];
  hasValue?: ShapeValue;
  minInclusive?: ShapeValue;
  maxInclusive?: ShapeValue;
  minExclusive?: ShapeValue;
  maxExclusive?: ShapeValue;
  minLength?: number;
  maxLength?: number;
  uniqueLang?: boolean;
  languageIn?: string[];
  /** IRI of a node shape every value must conform to. */
  node?: string;
}

/** A SHACL node shape as the shape editor holds it. */
export interface ShapeDef {
  id: string;
  iri: string;
  name: string;
  targetClass: string[];
  targetNode: string[];
  targetSubjectsOf: string[];
  targetObjectsOf: string[];
  severity?: ShaclSeverity;
  message?: string;
  closed?: boolean;
  deactivated?: boolean;
  properties: PropertyShape[];
}

/**
 * The model's SHACL shapes graph. It is kept apart from the ontology: shapes say what data
 * must look like, they assert nothing about the classes. `nodes` are the shapes the editor
 * understands; `extra` is Turtle for imported shapes that use more of SHACL than the editor has
 * fields for, kept as written.
 */
export interface Shapes {
  nodes: ShapeDef[];
  extra: string;
}

/**
 * Another ontology this one knows about. Only this description is in the model; the
 * ontology's content is cached in the browser and is never merged into the model by itself.
 */
export interface ExternalRef {
  id: string;
  name: string;
  /** The IRI of that ontology, as it states it. */
  iri: string;
  versionIri?: string;
  namespace: string;
  /** Where it came from: a file name, a URL, or the name of a saved model. */
  source: string;
  sourceKind: 'file' | 'url' | 'model' | 'unknown';
  addedAt: number;
  classes: number;
  objectProperties: number;
  dataProperties: number;
  individuals: number;
  /** A dependency: this ontology imports it (owl:imports), so its axioms hold here too. */
  imports: boolean;
}

export const MAPPING_STATUS = ['proposed', 'approved', 'needs review'] as const;

/**
 * What is recorded about a mapping beside the mapping itself: who made it, how, and whether it
 * has been reviewed. The mapping is an axiom of the ontology; this is bookkeeping about it and
 * is kept apart. `source`, `predicate` and `target` say which mapping it belongs to.
 */
export interface MappingMeta {
  source: string;
  predicate: string;
  target: string;
  created: number;
  method: 'manual' | 'suggested' | 'imported';
  /** The similarity the suggestion had. A heuristic, not a probability that the mapping is right. */
  score?: number;
  author?: string;
  comment?: string;
  status: (typeof MAPPING_STATUS)[number];
}

/** Which quality rules the user switched off, and which of the ones that are off by default they switched on. */
export interface QualityConfig {
  off: string[];
  on: string[];
}

export const MAX_TERMS = 50_000;
export const MAX_RELATIONS = 100_000;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
}

export function emptyModel(name = 'Untitled model'): Model {
  return { format: 'conceptweaver', version: MODEL_VERSION, name, description: '', baseIri: '', ontologyIri: '', prefixes: [], mode: 'ontology', lang: '', vocab: { enabled: false, map: {} }, props: [], terms: [], relations: [], shapes: { nodes: [], extra: '' }, quality: { off: [], on: [] }, externals: [], mappings: [], rejected: [], governance: { custom: [], overrides: {} }, style: noStyle(), layout: noLayout(), datatypes: [] };
}

export function newTerm(p: Partial<Term> = {}): Term {
  return {
    id: uid(),
    name: '',
    description: '',
    type: 'concept',
    color: '',
    x: 0,
    y: 0,
    synonyms: '',
    fields: [],
    ...p,
  };
}

export function newProp(p: Partial<ObjProp> & { name: string }): ObjProp {
  return { id: uid(), description: '', chars: [], ...p };
}

export function newRelation(p: Partial<Relation> & { from: string; to: string }): Relation {
  return {
    id: uid(),
    label: '',
    kind: 'association',
    description: '',
    fromCard: '',
    toCard: '',
    ...p,
  };
}

/** What a class membership (an individual's rdf:type) is called wherever it is shown. */
export const INSTANCE_OF = 'Is Instance Of';

/** Text shown on the canvas for a relation. `instanceOf`: it states that an individual is a member of a class. */
export function relLabel(r: Relation, skos = false, instanceOf = false): string {
  if (r.label) return r.label;
  if (instanceOf) return INSTANCE_OF;
  if (r.predicate) return r.predicate;
  if (r.kind === 'generalization') return skos ? 'broader' : 'is a';
  if (r.kind === 'property') return 'has';
  return '';
}

const STD = /^(rdfs?|owl|skos):[A-Za-z]+$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const moreSpecs = (v: unknown): RestrictionSpec[] =>
  (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
    .filter((s) => s && typeof s === 'object' && QUANTIFIERS.some((q) => q.id === s.restriction))
    .map((s) => ({ restriction: s.restriction as Quantifier, ...(typeof s.restrictionN === 'number' && s.restrictionN >= 0 ? { restrictionN: Math.floor(s.restrictionN) } : {}) }));

const fieldList = (v: unknown): ExtraField[] =>
  Array.isArray(v)
    ? (v as Record<string, unknown>[])
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
          key: str(f.key),
          value: str(f.value),
          ...(LANG.test(str(f.lang)) ? { lang: str(f.lang).toLowerCase() } : {}),
          ...(/^(xsd|rdf):[A-Za-z]+$/.test(str(f.dt)) ? { dt: str(f.dt) } : {}),
          ...(f.iri === true ? { iri: true } : {}),
          ...(f.measure === true ? { measure: true } : {}),
        }))
    : [];

const kindList = (v: unknown): EntityKind[] => ENTITY_KINDS.filter((k) => Array.isArray(v) && v.includes(k));

export function normalizeGovernance(raw: unknown): GovernanceConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const custom: MetaField[] = [];
  for (const f of (Array.isArray(o.custom) ? o.custom : []) as Record<string, unknown>[]) {
    if (!f || typeof f !== 'object' || !str(f.id) || !str(f.label).trim() || custom.some((x) => x.id === str(f.id))) continue;
    const options = Array.isArray(f.options) ? [...new Set(f.options.map((x) => str(x).trim()).filter(Boolean))] : [];
    custom.push({
      id: str(f.id),
      label: str(f.label).trim(),
      about: str(f.about),
      property: str(f.property).trim(),
      appliesTo: kindList(f.appliesTo),
      type: (VALUE_TYPES as readonly string[]).includes(str(f.type)) ? (f.type as ValueType) : 'text',
      multiple: f.multiple === true,
      required: f.required === true,
      ...(options.length ? { options } : {}),
      group: (META_GROUPS as readonly string[]).includes(str(f.group)) ? (f.group as MetaGroup) : 'Custom',
      order: num(f.order),
      ...(typeof f.min === 'number' ? { min: f.min } : {}),
      ...(typeof f.max === 'number' ? { max: f.max } : {}),
      custom: true,
    });
  }
  const overrides: GovernanceConfig['overrides'] = {};
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [id, v] of Object.entries(o.overrides as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v !== 'object') continue;
      const entry = { ...(Array.isArray(v.appliesTo) ? { appliesTo: kindList(v.appliesTo) } : {}), ...(typeof v.required === 'boolean' ? { required: v.required } : {}) };
      if (Object.keys(entry).length) overrides[id] = entry;
    }
  }
  return { custom, overrides };
}

/** Validates untrusted JSON and returns a well-formed model. Throws on anything unusable. */
const langs = (x: Record<string, unknown>): { nameLang?: string; descriptionLang?: string } => ({
  ...(typeof x.nameLang === 'string' && (x.nameLang === '' || LANG.test(x.nameLang)) ? { nameLang: x.nameLang.toLowerCase() } : {}),
  ...(typeof x.descriptionLang === 'string' && (x.descriptionLang === '' || LANG.test(x.descriptionLang)) ? { descriptionLang: x.descriptionLang.toLowerCase() } : {}),
});
const describedBy = (v: unknown): { describedBy?: DescriptionProperty } => ((DESCRIPTION_PROPERTIES as readonly string[]).includes(v as string) ? { describedBy: v as DescriptionProperty } : {});

export function normalizeModel(raw: unknown): Model {
  if (!raw || typeof raw !== 'object') throw new Error('Not a model file.');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.terms) || !Array.isArray(o.relations)) {
    throw new Error('Not a ConceptWeaver model: expected "terms" and "relations" arrays.');
  }
  if (o.terms.length > MAX_TERMS || o.relations.length > MAX_RELATIONS) {
    throw new Error('Model is too large.');
  }
  // The enumerated datatypes come first: a data property may name one as its range.
  const datatypes: EnumDatatype[] = [];
  for (const d of (Array.isArray(o.datatypes) ? o.datatypes : []) as Record<string, unknown>[]) {
    if (!d || typeof d !== 'object' || !str(d.id) || datatypes.some((x) => x.id === str(d.id))) continue;
    const values: EnumLiteral[] = [];
    for (const v of (Array.isArray(d.values) ? d.values : []) as Record<string, unknown>[]) {
      if (!v || typeof v !== 'object' || typeof v.value !== 'string') continue;
      const lit: EnumLiteral = { value: v.value, ...(str(v.dt) ? { dt: str(v.dt) } : {}), ...(LANG.test(str(v.lang)) ? { lang: str(v.lang).toLowerCase() } : {}) };
      if (!values.some((x) => x.value === lit.value && (x.dt ?? '') === (lit.dt ?? '') && (x.lang ?? '') === (lit.lang ?? ''))) values.push(lit);
    }
    datatypes.push({ id: str(d.id), name: str(d.name), description: str(d.description), ...describedBy(d.describedBy), ...langs(d), values, ...(str(d.iri) ? { iri: str(d.iri), ...(d.pendingIri === true ? { pendingIri: true as const } : {}) } : {}), ...(d.anonymous === true ? { anonymous: true } : {}) });
  }
  const knownRange = (range: string) => DATATYPES.some((x) => x.id === range) || (range.startsWith(ENUM_RANGE) && datatypes.some((x) => x.id === range.slice(ENUM_RANGE.length)));
  const ids = new Set<string>();
  const terms: Term[] = [];
  for (const t of o.terms as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object') continue;
    const id = str(t.id) || uid();
    if (ids.has(id)) continue;
    ids.add(id);
    const type = str(t.type);
    const color = str(t.color);
    terms.push({
      id,
      name: str(t.name),
      description: str(t.description),
      ...describedBy(t.describedBy),
      ...langs(t),
      type: type === 'property' || type === 'instance' ? type : 'concept',
      color: (COLORS as readonly string[]).includes(color) ? color : '',
      x: num(t.x),
      y: num(t.y),
      synonyms: str(t.synonyms),
      fields: fieldList(t.fields),
      ...(str(t.iri) ? { iri: str(t.iri), ...(t.pendingIri === true ? { pendingIri: true as const } : {}) } : {}),
      ...(knownRange(str(t.range)) ? { range: str(t.range) } : {}),
      ...(Array.isArray(t.axioms) && t.axioms.length ? { axioms: t.axioms.map((a) => str(a)).filter(Boolean) } : {}),
      ...(t.functional === true ? { functional: true } : {}),
      ...(typeof t.external === 'string' ? { external: t.external } : {}),
    });
  }
  // An individual's values can only be for terms that exist.
  for (const t of o.terms as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.values)) continue;
    const term = terms.find((x) => x.id === str(t.id));
    const values = (t.values as Record<string, unknown>[])
      .filter((v) => v && typeof v === 'object' && ids.has(str(v.prop)) && str(v.value) !== '')
      .map((v): DataValue => ({ prop: str(v.prop), value: str(v.value), ...(LANG.test(str(v.lang)) ? { lang: str(v.lang).toLowerCase() } : {}), ...(DATATYPES.some((d) => d.id === str(v.dt)) || /^xsd:[A-Za-z]+$/.test(str(v.dt)) ? { dt: str(v.dt) } : {}) }));
    if (term && values.length) term.values = values;
  }
  // An enumeration can only list terms that exist, each once, and not the class itself.
  for (const t of o.terms as Record<string, unknown>[]) {
    const term = t && typeof t === 'object' && Array.isArray(t.oneOf) ? terms.find((x) => x.id === str(t.id)) : undefined;
    if (!term) continue;
    term.oneOf = [...new Set((t.oneOf as unknown[]).map((x) => str(x)).filter((id) => ids.has(id) && id !== term.id))];
    if (t.allDifferent === true) term.allDifferent = true;
  }
  // A data property's hand-set domain can only name terms that exist.
  for (const [i, t] of (o.terms as Record<string, unknown>[]).entries()) {
    const term = t && typeof t === 'object' ? terms.find((x) => x.id === str(t.id)) : undefined;
    if (term && Array.isArray(t.domain) && i >= 0) term.domain = [...new Set(t.domain.map((x) => str(x)).filter((id) => ids.has(id)))];
  }
  const relIds = new Set<string>();
  const relations: Relation[] = [];
  for (const r of o.relations as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const from = str(r.from);
    const to = str(r.to);
    if (!ids.has(from) || !ids.has(to)) continue;
    let id = str(r.id) || uid();
    if (relIds.has(id)) id = uid();
    relIds.add(id);
    const kind = str(r.kind);
    relations.push({
      id,
      from,
      to,
      label: str(r.label),
      kind: kind === 'generalization' || kind === 'property' ? kind : 'association',
      ...(QUANTIFIERS.some((q) => q.id === r.restriction) ? { restriction: r.restriction as Quantifier } : {}),
      ...(typeof r.restrictionN === 'number' && r.restrictionN >= 0 ? { restrictionN: Math.floor(r.restrictionN) } : {}),
      ...(moreSpecs(r.more).length ? { more: moreSpecs(r.more) } : {}),
      ...(str(r.prop) ? { prop: str(r.prop) } : {}),
      ...(r.plain === true ? { plain: true } : {}),
      description: str(r.description),
      fromCard: str(r.fromCard),
      toCard: str(r.toCard),
      ...(STD.test(str(r.predicate)) ? { predicate: str(r.predicate) } : {}),
    });
  }
  const v = (o.vocab && typeof o.vocab === 'object' ? o.vocab : {}) as Record<string, unknown>;
  const map: Record<string, string> = {};
  if (v.map && typeof v.map === 'object') {
    for (const [k, p] of Object.entries(v.map as Record<string, unknown>)) if (STD.test(str(p))) map[k.trim().toLowerCase()] = str(p);
  }
  // Format 1 knew an object property by its name, lower-cased: no two could share one, and every
  // reference to one was that name. From format 2 each has an id, and references are ids.
  const byName = !(typeof o.version === 'number' && o.version >= 2);
  const props: ObjProp[] = [];
  const key = (name: string) => name.trim().toLowerCase();
  const idList = (v: unknown) => (Array.isArray(v) ? { list: [...new Set(v.map((x) => str(x)).filter((id) => ids.has(id)))] } : undefined);
  const read: { raw: Record<string, unknown>; entry: ObjProp }[] = [];
  for (const p of (Array.isArray(o.props) ? o.props : []) as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || !str(p.name).trim()) continue;
    if (byName && props.some((x) => key(x.name) === key(str(p.name)))) continue;
    let id = byName ? '' : str(p.id);
    if (!id || props.some((x) => x.id === id)) id = uid();
    const domain = idList(p.domain);
    const range = idList(p.range);
    const entry: ObjProp = {
      id,
      name: str(p.name).trim(),
      description: str(p.description),
      ...describedBy(p.describedBy),
      ...langs(p),
      chars: Array.isArray(p.chars) ? [...new Set(p.chars.map((c) => str(c)).filter(Boolean))] : [],
      ...(domain ? { domain: domain.list } : {}),
      ...(range ? { range: range.list } : {}),
      ...(str(p.iri) ? { iri: str(p.iri), ...(p.pendingIri === true ? { pendingIri: true as const } : {}) } : {}),
      ...(fieldList(p.fields).length ? { fields: fieldList(p.fields) } : {}),
      ...(typeof p.external === 'string' ? { external: p.external } : {}),
    };
    props.push(entry);
    read.push({ raw: p, entry });
  }
  // The links between properties, once all of them are known. A name in format 1 that no
  // property had pointed at nothing (and was never exported): it is not kept.
  const propIds = new Set(props.map((p) => p.id));
  const idOfName = new Map(props.map((p) => [key(p.name), p.id]));
  for (const { raw, entry } of read) {
    // Models from before a property could have several: one parent, one inverse.
    const legacy: Record<PropLink, unknown> = { parents: raw.parent, inverses: raw.inverseOf, equivalents: undefined, disjoints: undefined };
    for (const link of PROP_LINKS) {
      const refs = [...(Array.isArray(raw[link]) ? (raw[link] as unknown[]) : []), legacy[link]].map((x) => str(x)).filter(Boolean);
      const list = [...new Set(refs.map((x) => (byName ? idOfName.get(key(x)) : propIds.has(x) ? x : undefined)).filter((x): x is string => !!x && x !== entry.id))];
      if (list.length) entry[link] = list;
    }
  }
  // Models from the short-lived version that drew an object property as a term of its own:
  // each becomes a declared property, used between every domain and range term it had.
  const rawTerms = new Map((o.terms as Record<string, unknown>[]).filter((t) => t && typeof t === 'object').map((t) => [str(t.id), t]));
  for (const t of [...terms]) {
    if (t.type !== 'property' || rawTerms.get(t.id)?.propKind !== 'object') continue;
    const domain = relations.filter((r) => r.kind === 'property' && r.to === t.id).map((r) => r.from);
    const range = (o.relations as Record<string, unknown>[]).filter((r) => r && r.kind === 'range' && r.from === t.id && ids.has(str(r.to))).map((r) => str(r.to));
    if (!props.some((x) => key(x.name) === key(t.name)) && t.name.trim()) {
      props.push(newProp({ name: t.name.trim(), description: t.description, ...(domain.length ? { domain } : {}), ...(range.length ? { range } : {}) }));
    }
    terms.splice(terms.indexOf(t), 1);
    ids.delete(t.id);
    for (let i = relations.length - 1; i >= 0; i--) if (relations[i].from === t.id || relations[i].to === t.id) relations.splice(i, 1);
    for (const d of domain) for (const r of range) relations.push(newRelation({ from: d, to: r, label: t.name.trim() }));
  }
  return {
    format: 'conceptweaver',
    version: MODEL_VERSION,
    name: str(o.name, 'Untitled model') || 'Untitled model',
    description: str(o.description),
    ...describedBy(o.describedBy),
    ...langs(o),
    ...((NAME_PROPERTIES as readonly string[]).includes(str(o.namedBy)) ? { namedBy: str(o.namedBy) as NameProperty } : {}),
    baseIri: str(o.baseIri),
    ontologyIri: str(o.ontologyIri),
    prefixes: (Array.isArray(o.prefixes) ? (o.prefixes as Record<string, unknown>[]) : [])
      .filter((p) => p && typeof p === 'object' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(str(p.prefix)) && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(str(p.iri)))
      .map((p) => ({ prefix: str(p.prefix), iri: str(p.iri) }))
      // A prefix that only repeats a standard one (a model saved before dcat, prov, dqv and adms were standard) is not kept.
      .filter((p) => !STANDARD.some((s) => s.prefix === p.prefix && s.iri === p.iri)),
    mode: o.mode === 'skos' ? 'skos' : 'ontology',
    lang: LANG.test(str(o.lang)) ? str(o.lang).toLowerCase() : '',
    vocab: { enabled: v.enabled === true, map },
    props,
    terms,
    relations,
    shapes: normalizeShapes(o.shapes),
    externals: (Array.isArray(o.externals) ? (o.externals as Record<string, unknown>[]) : [])
      .filter((e) => e && typeof e === 'object' && str(e.id))
      .map((e): ExternalRef => {
        const kind = str(e.sourceKind);
        return {
          id: str(e.id),
          name: str(e.name) || str(e.iri) || 'External ontology',
          iri: str(e.iri),
          ...(str(e.versionIri) ? { versionIri: str(e.versionIri) } : {}),
          namespace: str(e.namespace),
          source: str(e.source),
          sourceKind: kind === 'file' || kind === 'url' || kind === 'model' ? kind : 'unknown',
          addedAt: num(e.addedAt),
          classes: num(e.classes),
          objectProperties: num(e.objectProperties),
          dataProperties: num(e.dataProperties),
          individuals: num(e.individuals),
          imports: e.imports === true,
        };
      }),
    mappings: (Array.isArray(o.mappings) ? (o.mappings as Record<string, unknown>[]) : [])
      .filter((x) => x && typeof x === 'object' && str(x.source) && str(x.predicate) && str(x.target))
      .map((x): MappingMeta => ({
        source: str(x.source),
        predicate: str(x.predicate),
        target: str(x.target),
        created: num(x.created),
        method: x.method === 'suggested' || x.method === 'imported' ? x.method : 'manual',
        ...(typeof x.score === 'number' ? { score: x.score } : {}),
        ...(str(x.author) ? { author: str(x.author) } : {}),
        ...(str(x.comment) ? { comment: str(x.comment) } : {}),
        status: (MAPPING_STATUS as readonly string[]).includes(str(x.status)) ? (str(x.status) as MappingMeta['status']) : 'proposed',
      })),
    rejected: Array.isArray(o.rejected) ? [...new Set(o.rejected.map((x) => str(x)).filter(Boolean))] : [],
    governance: normalizeGovernance(o.governance),
    style: normalizeGraphStyle(o.style, new Set(terms.map((t) => t.id)), new Set(relations.map((r) => r.id))),
    layout: normalizeLayout(o.layout, new Set(terms.map((t) => t.id))),
    datatypes,
    ...(typeof o.unmapped === 'string' && o.unmapped.trim() ? { unmapped: o.unmapped } : {}),
    quality: {
      off: Array.isArray((o.quality as QualityConfig | undefined)?.off) ? [...new Set((o.quality as QualityConfig).off.map((x) => str(x)).filter(Boolean))] : [],
      on: Array.isArray((o.quality as QualityConfig | undefined)?.on) ? [...new Set((o.quality as QualityConfig).on.map((x) => str(x)).filter(Boolean))] : [],
    },
  };
}

const SEVERITIES = ['Violation', 'Warning', 'Info'];
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x)).filter(Boolean))] : []);
function shapeValue(v: unknown): ShapeValue | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.v !== 'string') return undefined;
  return { v: o.v, ...(o.iri === true ? { iri: true } : {}), ...(str(o.dt) ? { dt: str(o.dt) } : {}), ...(LANG.test(str(o.lang)) ? { lang: str(o.lang).toLowerCase() } : {}) };
}

/** Validates the shapes part of untrusted JSON. A model saved before shapes existed has none. */
export function normalizeShapes(raw: unknown): Shapes {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nodes: ShapeDef[] = [];
  for (const n of (Array.isArray(o.nodes) ? o.nodes : []) as Record<string, unknown>[]) {
    if (!n || typeof n !== 'object' || !str(n.iri)) continue;
    const properties: PropertyShape[] = [];
    for (const p of (Array.isArray(n.properties) ? n.properties : []) as Record<string, unknown>[]) {
      if (!p || typeof p !== 'object') continue;
      const out: PropertyShape = { id: str(p.id) || uid(), path: str(p.path) };
      if (p.inverse === true) out.inverse = true;
      for (const k of ['name', 'message', 'datatype', 'class', 'pattern', 'flags', 'node'] as const) if (str(p[k])) out[k] = str(p[k]);
      if (SEVERITIES.includes(str(p.severity))) out.severity = str(p.severity) as ShaclSeverity;
      for (const k of ['minCount', 'maxCount', 'minLength', 'maxLength'] as const) if (count(p[k]) !== undefined) out[k] = count(p[k]);
      if ((NODE_KINDS as readonly string[]).includes(str(p.nodeKind))) out.nodeKind = str(p.nodeKind) as PropertyShape['nodeKind'];
      for (const k of ['hasValue', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const) if (shapeValue(p[k])) out[k] = shapeValue(p[k]);
      if (Array.isArray(p.in)) out.in = p.in.map(shapeValue).filter((x): x is ShapeValue => !!x);
      if (p.uniqueLang === true) out.uniqueLang = true;
      if (Array.isArray(p.languageIn)) out.languageIn = strs(p.languageIn);
      properties.push(out);
    }
    nodes.push({
      id: str(n.id) || uid(),
      iri: str(n.iri),
      name: str(n.name),
      targetClass: strs(n.targetClass),
      targetNode: strs(n.targetNode),
      targetSubjectsOf: strs(n.targetSubjectsOf),
      targetObjectsOf: strs(n.targetObjectsOf),
      ...(SEVERITIES.includes(str(n.severity)) ? { severity: str(n.severity) as ShaclSeverity } : {}),
      ...(str(n.message) ? { message: str(n.message) } : {}),
      ...(n.closed === true ? { closed: true } : {}),
      ...(n.deactivated === true ? { deactivated: true } : {}),
      properties,
    });
  }
  return { nodes, extra: str(o.extra) };
}

/** Name of a relation kind as shown in menus; SKOS calls a generalization "broader". */
export function kindLabel(kind: RelKind, skos: boolean): string {
  if (skos) return kind === 'generalization' ? 'Broader' : kind === 'property' ? 'Has property (not SKOS)' : 'Association';
  return REL_KINDS.find((k) => k.value === kind)!.label;
}

export const isLang = (s: string) => LANG.test(s);
