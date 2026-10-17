import { noLayout, normalizeLayout, type GraphLayout } from '../layout/types';
import { noStyle, normalizeGraphStyle, type GraphStyle } from './graphStyle';
import { classExpressionAxiomFrom, classExpressionFrom, dataRangeFrom, expressionOfTurtle, rangeOfKey, WELL_KNOWN, type ClassAxiom, type ClassAxiomKind, type ClassExpression, type ClassExpressionAxiom, type DataRangeAxiom } from './expressions';
import { statementsOf } from './unmapped';
import { withIris } from './iri';
import { compactIri, STANDARD } from './prefixes';
import { shapeSetsFrom, type ShapeSet } from './shacl';
import type { LogicalModel } from '../logical/contracts';
import { logicalModelsFrom } from '../logical/rules';
import { shapeSetOfFormat4 } from './shapesLegacy';

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
  /**
   * The property's domain and range: an axiom for each rdfs:domain (rdfs:range) statement. All of
   * them hold at once, so that two axioms mean both (their intersection); "either" is one axiom
   * that is a union. Left out, the domain (or range) follows the relationships that use the
   * property, and is written as the class they start from (point to), or the union of those.
   * Empty: there is none.
   */
  domains?: ClassAxiom[];
  ranges?: ClassAxiom[];
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
  /**
   * The chains it is the head of (owl:propertyChainAxiom): it holds from the start of the first
   * property to the end of the last. Each is an axiom of its own.
   */
  chains?: PropertyChain[];
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

/**
 * An annotation property of an ontology: a named, reusable property whose values are annotations
 * (labels, notes, sources) rather than relationships or literal data. It is an entity of its own:
 * declared, listed and arranged under the ones it specialises (rdfs:subPropertyOf), with a
 * domain and a range. An entity's annotation with it is a field of that entity (ExtraField), by
 * the property's name or IRI.
 */
export interface AnnotationProp {
  id: string;
  name: string;
  description: string;
  /** The property the description was read from, and the languages, as on a term. */
  describedBy?: DescriptionProperty;
  nameLang?: string;
  descriptionLang?: string;
  /** The annotation properties it specialises, by id (rdfs:subPropertyOf). */
  parents?: string[];
  /**
   * What it applies to: an axiom for each rdfs:domain statement, all of which hold at once.
   * Empty or left out: none is stated.
   */
  domains?: ClassAxiom[];
  /** What its values are: an axiom for each rdfs:range statement. Empty or left out: none is stated. */
  ranges?: ClassAxiom[];
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

/** A literal value an individual has for a data property. */
export interface DataValue {
  /** Id of the data property term. */
  prop: string;
  value: string;
  lang?: string;
  /** Datatype stated on the value itself, when it is not simply the property's range. */
  dt?: string;
}

/**
 * One property of a property chain, by id: an object property, used the way it is (or, with
 * `inverse`, from its object to its subject, as owl:inverseOf states it).
 */
export interface ChainProperty {
  prop: string;
  inverse?: true;
}

/**
 * A property chain (owl:propertyChainAxiom) of the object property it is stated on: whenever the
 * first property holds from a to b, the second from b to c, and so on, the property itself holds
 * from a to the last one's end.
 */
export interface PropertyChain {
  id: string;
  properties: ChainProperty[];
}

/** One property of a key: an object property (its id), or a data property (its term id). */
export type KeyProperty = { prop: string } | { data: string };

/**
 * A key of a class (owl:hasKey): the properties whose values, together, tell one member from
 * another. Each is an object property of the model or a data property (a term).
 */
export interface HasKey {
  id: string;
  properties: KeyProperty[];
}

/**
 * A class that is exactly the union of its members (owl:disjointUnionOf), which are also stated
 * to be pairwise disjoint: a member is in the class if and only if it is in one of them.
 */
export interface DisjointUnion {
  id: string;
  classes: ClassExpression[];
}

/**
 * A negative property assertion (owl:NegativePropertyAssertion): an individual does not have a
 * value for a property. An object assertion names the other individual; a data assertion gives
 * the literal it does not have.
 */
export type NegativeAssertion =
  | { id: string; kind: 'object'; prop: string; inverse?: true; target: string }
  | { id: string; kind: 'data'; prop: string; value: string; lang?: string; dt?: string };

/**
 * An annotation on an axiom (owl:Axiom): the axiom stays as it is, and this says something about
 * it — where it came from, why it holds. The axiom is named by its subject (a full IRI), its
 * property (a full IRI) and its target (as the Turtle it is, which is a literal for a data
 * axiom), and the annotation is a field, as on an entity.
 */
export interface AxiomAnnotation {
  id: string;
  subject: string;
  property: string;
  target: string;
  fields: ExtraField[];
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

/**
 * How a datatype is named where one is chosen from a list: a standard one by its prefixed name
 * ("xsd:date"), an enumerated datatype of the model as "enum:" and its id.
 */
export const ENUM_RANGE = 'enum:';

export const COLORS = ['', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'] as const;

export interface ExtraField {
  key: string;
  value: string;
  /** Language tag of the value, e.g. "nl". */
  lang?: string;
  /** Datatype of a value that is not text: "xsd:date", "xsd:decimal", "xsd:boolean" and the like. */
  dt?: string;
  /**
   * true: the value is an IRI (an entity of this model or a resource elsewhere), not text. false:
   * it is text, though it looks like a link (as it was read). Not set: text, unless it is a link
   * under a property whose values are links (rdfs:seeAlso and the like), as one typed in is taken.
   */
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
   * For a data property: its range, an axiom for each rdfs:range statement, all of which hold at
   * once. Most often one datatype: a standard one, or an enumerated datatype of the model (see
   * EnumDatatype). None: it has no range.
   */
  ranges?: DataRangeAxiom[];
  /**
   * For a data property: its domain, an axiom for each rdfs:domain statement, when set by hand
   * (as an object property's is). Left out, it is the classes it is attached to.
   */
  domains?: ClassAxiom[];
  /**
   * For a class: what it is stated to be a subclass of, equivalent to or disjoint with, where that
   * is a class expression and not something drawn (a named superclass, a restriction by one
   * property on a named class, an enumeration): "Person and (hasAge some xsd:integer[>= 18])".
   * Each is an axiom of its own, of the kind it was stated as; none is merged with another.
   */
  classAxioms?: ClassExpressionAxiom[];
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
  /** For a class: its keys (owl:hasKey), each the properties that together identify a member. */
  keys?: HasKey[];
  /** For a class: the unions it is exactly (owl:disjointUnionOf), each of classes that do not overlap. */
  disjointUnions?: DisjointUnion[];
  /** For an individual: what it is stated not to have (owl:NegativePropertyAssertion). */
  negativeAssertions?: NegativeAssertion[];
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
  /**
   * The axiom of many members this relationship was read from (owl:AllDisjointClasses,
   * owl:AllDifferent): it is one of the pairs of it. Relationships that share it are written back
   * as that one axiom while every two of its members are still stated to be disjoint (or
   * different); otherwise each is written as the pair it is.
   */
  group?: string;
  /** Of a relationship of a `group`: the pair was stated on its own as well, and is written so beside the axiom. */
  statedAlone?: boolean;
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
 * properties refer to. 3 (from 2026-10-14): a domain or range is a list of axioms, each a class
 * expression (or for a data property's range a data range), where it was a list of classes that
 * meant their union, and a data property's range one datatype. 4 (from 2026-10-14): a class's
 * superclasses, equivalent classes and disjoint classes that are expressions are axioms with a
 * structured expression (Term.classAxioms), where they were kept as Turtle text (Term.axioms). 5
 * (from 2026-10-15): the SHACL shapes are shape sets, several named shapes graphs each holding
 * every SHACL Core construct as structure (shacl.ts), where they were one graph of node shapes in
 * fixed fields with Turtle for the rest (`shapes`). 6 (from 2026-10-17): the project's logical data
 * models (`logicalModels`, src/logical), none for a model of an earlier format. 7 (from 2026-10-17):
 * annotation properties are entities of their own (`annProps`), where an annotation was only a
 * metadata field of the entity it annotated; a model of an earlier format has none until one is
 * declared. 8 (from 2026-10-17): property chains (`ObjProp.chains`), keys, disjoint unions and
 * negative assertions (`Term.keys`, `Term.disjointUnions`, `Term.negativeAssertions`), and
 * annotations on axioms (`axiomAnnotations`), where they were kept as Turtle text in `unmapped`.
 * A model of an earlier version is read and brought up to date by normalizeModel.
 */
export const MODEL_VERSION = 8;

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
  /**
   * Declared annotation properties: the vocabulary of the annotations an entity can carry
   * (rdfs:label in another language, a source, a note of its own), each an entity with a domain
   * and a range. A field of an entity is an annotation with one when its key names it or is its IRI.
   */
  annProps: AnnotationProp[];
  terms: Term[];
  relations: Relation[];
  /** The SHACL shape sets: constraint models beside the ontology, never part of it (shacl.ts). */
  shapeSets: ShapeSet[];
  /** The data graphs SHACL validates, beside the model's own individuals: what each is, its content kept in this browser (dataGraphs.ts). */
  dataGraphs: DataGraphRef[];
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
   * The project's logical data models (src/logical, roadmap LM-1): artifacts of their own beside
   * the ontology and the shape sets, each with its own revisions. No part of the ontology, never
   * written to RDF, and not followed by the ontology's revision (MODEL_PARTS).
   */
  logicalModels: LogicalModel[];
  /**
   * Annotations stated on the axioms themselves (owl:Axiom), rather than on an entity: each says
   * something about one statement — where it came from, why it holds. Left out when there are none.
   */
  axiomAnnotations?: AxiomAnnotation[];
  /**
   * Statements of an ontology that was read which the model has no place for (an ontology's
   * version IRI, SWRL rules, …), kept as they were and written back with it: Turtle, one statement
   * at a time, with full IRIs (see unmapped.ts). Not shown or edited here. Left out when there are
   * none.
   */
  unmapped?: string;
}

/**
 * What each part of a model is (TD-20). *revision*: what the ontology's revision follows: the
 * ontology, and the shape sets and data graphs validated with it; a change to any of these is a
 * new revision, and what was worked out for the old one is not current. *picture*: how it is
 * drawn. *logical*: the logical data models, which have revisions of their own (ADR-023).
 * *format*: the file's own marks. A field added to Model has to be put here, or the code does not
 * compile.
 */
export const MODEL_PARTS: Record<keyof Model, 'revision' | 'picture' | 'logical' | 'format'> = {
  format: 'format',
  version: 'format',
  name: 'revision',
  description: 'revision',
  describedBy: 'revision',
  namedBy: 'revision',
  nameLang: 'revision',
  descriptionLang: 'revision',
  baseIri: 'revision',
  ontologyIri: 'revision',
  prefixes: 'revision',
  mode: 'revision',
  lang: 'revision',
  vocab: 'revision',
  props: 'revision',
  annProps: 'revision',
  terms: 'revision',
  relations: 'revision',
  shapeSets: 'revision',
  dataGraphs: 'revision',
  quality: 'revision',
  externals: 'revision',
  mappings: 'revision',
  rejected: 'revision',
  governance: 'revision',
  datatypes: 'revision',
  axiomAnnotations: 'revision',
  unmapped: 'revision',
  style: 'picture',
  layout: 'picture',
  logicalModels: 'logical',
};

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

/**
 * Another ontology this one knows about. Only this description is in the model; the
 * ontology's content is cached in the browser and is never merged into the model by itself.
 */
/**
 * A data graph of the model: RDF that the shapes are validated against, kept with the model by
 * what it is, its content (as Turtle) in this browser's IndexedDB under its id. It is no part of
 * the ontology and is never written into it.
 */
export interface DataGraphRef {
  id: string;
  name: string;
  /** The file it was read from, and its syntax. */
  file: string;
  format: string;
  triples: number;
  /** A fingerprint of its content: a graph replaced by another file is other data to validate. */
  fingerprint: string;
  /** Validated together with the ontology's triples, so that a shape for a class reaches its subclasses' instances. */
  includeOntology: boolean;
  /** When it was read, or last replaced. */
  read: number;
}

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

/**
 * Bounds on what a model file may hold, against a file that is not what it says it is. A model too
 * large to draw is drawn around the terms chosen (culling.ts, GRAPH_LIMIT), and the Structure
 * Explorer answers at 200,000 classes, so these are well above what is drawn.
 */
export const MAX_TERMS = 250_000;
export const MAX_RELATIONS = 1_000_000;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
}

export function emptyModel(name = 'Untitled model'): Model {
  return { format: 'conceptweaver', version: MODEL_VERSION, name, description: '', baseIri: '', ontologyIri: '', prefixes: [], mode: 'ontology', lang: '', vocab: { enabled: false, map: {} }, props: [], annProps: [], terms: [], relations: [], shapeSets: [], dataGraphs: [], quality: { off: [], on: [] }, externals: [], mappings: [], rejected: [], governance: { custom: [], overrides: {} }, style: noStyle(), layout: noLayout(), datatypes: [], logicalModels: [] };
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

export function newAnnotationProp(p: Partial<AnnotationProp> & { name: string }): AnnotationProp {
  return { id: uid(), description: '', ...p };
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
          ...(f.iri === true ? { iri: true } : f.iri === false ? { iri: false } : {}),
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
  const enums = new Set(datatypes.map((d) => d.id));
  // Format 3 states a domain or range as axioms; before it, as a list of classes that meant their
  // union, and a data property's range as one datatype. Those are read below, once every term is.
  const version = typeof o.version === 'number' ? o.version : 1;
  const classAxioms = (v: unknown): ClassAxiom[] | undefined => {
    if (version < 3 || !Array.isArray(v)) return undefined;
    const out: ClassAxiom[] = [];
    for (const a of v as Record<string, unknown>[]) {
      const expression = a && typeof a === 'object' ? classExpressionFrom(a.expression) : undefined;
      if (expression) out.push({ id: str(a.id) && !out.some((x) => x.id === a.id) ? str(a.id) : uid(), expression });
    }
    return out;
  };
  const rangeAxioms = (v: unknown): DataRangeAxiom[] | undefined => {
    if (version < 3 || !Array.isArray(v)) return undefined;
    const out: DataRangeAxiom[] = [];
    for (const a of v as Record<string, unknown>[]) {
      const range = a && typeof a === 'object' ? dataRangeFrom(a.range, 0, enums) : undefined;
      if (range) out.push({ id: str(a.id) && !out.some((x) => x.id === a.id) ? str(a.id) : uid(), range });
    }
    return out.length ? out : undefined;
  };
  const classAxiomsOf = (v: unknown): ClassExpressionAxiom[] => {
    const out: ClassExpressionAxiom[] = [];
    for (const a of Array.isArray(v) ? v : []) {
      const read = classExpressionAxiomFrom(a);
      if (read) out.push({ ...read, id: read.id && !out.some((x) => x.id === read.id) ? read.id : uid() });
    }
    return out;
  };
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
      ...(type === 'property' && rangeAxioms(t.ranges) ? { ranges: rangeAxioms(t.ranges) } : {}),
      ...(type === 'property' && classAxioms(t.domains) ? { domains: classAxioms(t.domains) } : {}),
      ...(version >= 4 && type !== 'property' && type !== 'instance' && classAxiomsOf(t.classAxioms).length ? { classAxioms: classAxiomsOf(t.classAxioms) } : {}),
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
  // Before format 3: a data property's hand-set domain, a list of terms, and its range, one
  // datatype. Before format 4: what a term had that was kept as Turtle text.
  const legacy: ClassLists = new Map();
  for (const t of version < 4 ? (o.terms as Record<string, unknown>[]) : []) {
    const term = t && typeof t === 'object' ? terms.find((x) => x.id === str(t.id)) : undefined;
    if (!term) continue;
    const texts = Array.isArray(t.axioms) ? t.axioms.map((a) => str(a)).filter(Boolean) : [];
    const datatype = str(t.range);
    const entry = {
      ...(texts.length ? { texts } : {}),
      ...(version < 3 && term.type === 'property' && Array.isArray(t.domain) ? { domain: [...new Set(t.domain.map((x) => str(x)).filter((id) => ids.has(id)))] } : {}),
      ...(version < 3 && term.type === 'property' && (DATATYPES.some((x) => x.id === datatype) || (datatype.startsWith(ENUM_RANGE) && enums.has(datatype.slice(ENUM_RANGE.length)))) ? { datatype } : {}),
    };
    if (Object.keys(entry).length || (version < 3 && term.type === 'property')) legacy.set(term.id, entry);
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
      ...(str(r.group) ? { group: str(r.group) } : {}),
      ...(r.statedAlone === true ? { statedAlone: true } : {}),
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
    const domain = version < 3 ? idList(p.domain) : undefined;
    const range = version < 3 ? idList(p.range) : undefined;
    const entry: ObjProp = {
      id,
      name: str(p.name).trim(),
      description: str(p.description),
      ...describedBy(p.describedBy),
      ...langs(p),
      chars: Array.isArray(p.chars) ? [...new Set(p.chars.map((c) => str(c)).filter(Boolean))] : [],
      ...(classAxioms(p.domains) ? { domains: classAxioms(p.domains) } : {}),
      ...(classAxioms(p.ranges) ? { ranges: classAxioms(p.ranges) } : {}),
      ...(str(p.iri) ? { iri: str(p.iri), ...(p.pendingIri === true ? { pendingIri: true as const } : {}) } : {}),
      ...(fieldList(p.fields).length ? { fields: fieldList(p.fields) } : {}),
      ...(typeof p.external === 'string' ? { external: p.external } : {}),
    };
    props.push(entry);
    read.push({ raw: p, entry });
    if (domain || range) legacy.set(entry.id, { ...(domain ? { domain: domain.list } : {}), ...(range ? { range: range.list } : {}) });
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
  // Property chains (format 8): each step is an object property of the model.
  for (const { raw, entry } of read) {
    const chains: PropertyChain[] = [];
    for (const c of (Array.isArray(raw.chains) ? raw.chains : []) as Record<string, unknown>[]) {
      if (!c || typeof c !== 'object') continue;
      const properties: ChainProperty[] = [];
      for (const p of (Array.isArray(c.properties) ? c.properties : []) as Record<string, unknown>[]) {
        if (!p || typeof p !== 'object' || !propIds.has(str(p.prop))) continue;
        properties.push({ prop: str(p.prop), ...(p.inverse === true ? { inverse: true as const } : {}) });
      }
      const id = str(c.id);
      if (properties.length) chains.push({ id: id && !chains.some((x) => x.id === id) ? id : uid(), properties });
    }
    if (chains.length) entry.chains = chains;
  }
  // Annotation properties are entities of their own (format 7). An earlier format has none.
  const annProps: AnnotationProp[] = [];
  const annRead: { raw: Record<string, unknown>; entry: AnnotationProp }[] = [];
  for (const p of (Array.isArray(o.annProps) ? o.annProps : []) as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || !str(p.name).trim()) continue;
    let id = str(p.id);
    if (!id || annProps.some((x) => x.id === id) || props.some((x) => x.id === id)) id = uid();
    const entry: AnnotationProp = {
      id,
      name: str(p.name).trim(),
      description: str(p.description),
      ...describedBy(p.describedBy),
      ...langs(p),
      ...(classAxioms(p.domains) ? { domains: classAxioms(p.domains) } : {}),
      ...(classAxioms(p.ranges) ? { ranges: classAxioms(p.ranges) } : {}),
      ...(fieldList(p.fields).length ? { fields: fieldList(p.fields) } : {}),
      ...(str(p.iri) ? { iri: str(p.iri), ...(p.pendingIri === true ? { pendingIri: true as const } : {}) } : {}),
      ...(typeof p.external === 'string' ? { external: p.external } : {}),
    };
    annProps.push(entry);
    annRead.push({ raw: p, entry });
  }
  const annIds = new Set(annProps.map((p) => p.id));
  for (const { raw, entry } of annRead) {
    const parents = [...new Set((Array.isArray(raw.parents) ? raw.parents : []).map((x) => str(x)).filter((id) => annIds.has(id) && id !== entry.id))];
    if (parents.length) entry.parents = parents;
  }
  // Models from the short-lived version that drew an object property as a term of its own:
  // each becomes a declared property, used between every domain and range term it had.
  const rawTerms = new Map((o.terms as Record<string, unknown>[]).filter((t) => t && typeof t === 'object').map((t) => [str(t.id), t]));
  for (const t of [...terms]) {
    if (t.type !== 'property' || rawTerms.get(t.id)?.propKind !== 'object') continue;
    const domain = relations.filter((r) => r.kind === 'property' && r.to === t.id).map((r) => r.from);
    const range = (o.relations as Record<string, unknown>[]).filter((r) => r && r.kind === 'range' && r.from === t.id && ids.has(str(r.to))).map((r) => str(r.to));
    if (!props.some((x) => key(x.name) === key(t.name)) && t.name.trim()) {
      const made = newProp({ name: t.name.trim(), description: t.description });
      props.push(made);
      if (domain.length || range.length) legacy.set(made.id, { ...(domain.length ? { domain } : {}), ...(range.length ? { range } : {}) });
    }
    terms.splice(terms.indexOf(t), 1);
    ids.delete(t.id);
    for (let i = relations.length - 1; i >= 0; i--) if (relations[i].from === t.id || relations[i].to === t.id) relations.splice(i, 1);
    for (const d of domain) for (const r of range) relations.push(newRelation({ from: d, to: r, label: t.name.trim() }));
  }
  // Keys, disjoint unions and negative assertions (format 8). A key or an assertion can only
  // name entities that are in the model; a disjoint union's members are class expressions, read
  // as a class axiom's is.
  const termById = new Map(terms.map((t) => [t.id, t]));
  const dataPropIds = new Set(terms.filter((t) => t.type === 'property').map((t) => t.id));
  const literalDt = (v: unknown): string | undefined => {
    const dt = str(v);
    return DATATYPES.some((d) => d.id === dt) || /^xsd:[A-Za-z]+$/.test(dt) || /^<[^<>]+>$/.test(dt) ? dt : undefined;
  };
  for (const [id, raw] of rawTerms) {
    const term = termById.get(id);
    if (!term || version < 8) continue;
    const keys: HasKey[] = [];
    for (const k of (Array.isArray(raw.keys) ? raw.keys : []) as Record<string, unknown>[]) {
      if (!k || typeof k !== 'object') continue;
      const properties: KeyProperty[] = [];
      for (const p of (Array.isArray(k.properties) ? k.properties : []) as Record<string, unknown>[]) {
        if (!p || typeof p !== 'object') continue;
        if (propIds.has(str(p.prop))) properties.push({ prop: str(p.prop) });
        else if (dataPropIds.has(str(p.data))) properties.push({ data: str(p.data) });
      }
      const keyId = str(k.id);
      if (properties.length) keys.push({ id: keyId && !keys.some((x) => x.id === keyId) ? keyId : uid(), properties });
    }
    if (keys.length) term.keys = keys;
    const unions: DisjointUnion[] = [];
    for (const u of (Array.isArray(raw.disjointUnions) ? raw.disjointUnions : []) as Record<string, unknown>[]) {
      if (!u || typeof u !== 'object') continue;
      const classes = (Array.isArray(u.classes) ? u.classes : []).map((c) => classExpressionFrom(c)).filter((c): c is ClassExpression => !!c);
      const unionId = str(u.id);
      if (classes.length >= 2) unions.push({ id: unionId && !unions.some((x) => x.id === unionId) ? unionId : uid(), classes });
    }
    if (unions.length) term.disjointUnions = unions;
    const negatives: NegativeAssertion[] = [];
    for (const n of (Array.isArray(raw.negativeAssertions) ? raw.negativeAssertions : []) as Record<string, unknown>[]) {
      if (!n || typeof n !== 'object') continue;
      const stated = str(n.id);
      const id = stated && !negatives.some((x) => x.id === stated) ? stated : uid();
      if (n.kind === 'object' && propIds.has(str(n.prop)) && ids.has(str(n.target))) {
        negatives.push({ id, kind: 'object', prop: str(n.prop), ...(n.inverse === true ? { inverse: true as const } : {}), target: str(n.target) });
      } else if (n.kind === 'data' && dataPropIds.has(str(n.prop))) {
        const dt = literalDt(n.dt);
        negatives.push({ id, kind: 'data', prop: str(n.prop), value: str(n.value), ...(LANG.test(str(n.lang)) ? { lang: str(n.lang).toLowerCase() } : {}), ...(dt ? { dt } : {}) });
      }
    }
    if (negatives.length) term.negativeAssertions = negatives;
  }
  // Annotations on axioms (format 8): the axiom is named by its subject, property and target,
  // and the annotation itself is a field, as on an entity.
  const axiomAnnotations: AxiomAnnotation[] = [];
  for (const a of (version >= 8 && Array.isArray(o.axiomAnnotations) ? o.axiomAnnotations : []) as Record<string, unknown>[]) {
    if (!a || typeof a !== 'object' || !str(a.subject) || !str(a.property) || !str(a.target)) continue;
    const fields = fieldList(a.fields);
    if (!fields.length) continue;
    const stated = str(a.id);
    axiomAnnotations.push({ id: stated && !axiomAnnotations.some((x) => x.id === stated) ? stated : uid(), subject: str(a.subject), property: str(a.property), target: str(a.target), fields });
  }
  const model: Model = {
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
    annProps,
    terms,
    relations,
    // Format 5 has shape sets; an earlier one had one graph of shapes, which becomes one set.
    shapeSets: Array.isArray(o.shapeSets) ? shapeSetsFrom(o.shapeSets) : shapeSetOfFormat4(o.shapes),
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
    dataGraphs: (Array.isArray(o.dataGraphs) ? (o.dataGraphs as Record<string, unknown>[]) : [])
      .filter((g) => g && typeof g === 'object' && str(g.id))
      .map((g): DataGraphRef => ({ id: str(g.id), name: str(g.name) || str(g.file) || 'Data', file: str(g.file), format: str(g.format) || 'turtle', triples: num(g.triples), fingerprint: str(g.fingerprint), includeOntology: g.includeOntology !== false, read: num(g.read) })),
    // Format 6 has logical data models; an earlier one has none.
    logicalModels: logicalModelsFrom(o.logicalModels),
    ...(axiomAnnotations.length ? { axiomAnnotations } : {}),
    ...(typeof o.unmapped === 'string' && o.unmapped.trim() ? { unmapped: o.unmapped } : {}),
    quality: {
      off: Array.isArray((o.quality as QualityConfig | undefined)?.off) ? [...new Set((o.quality as QualityConfig).off.map((x) => str(x)).filter(Boolean))] : [],
      on: Array.isArray((o.quality as QualityConfig | undefined)?.on) ? [...new Set((o.quality as QualityConfig).on.map((x) => str(x)).filter(Boolean))] : [],
    },
  };
  return version < 4 ? withClassLists(model, legacy) : model;
}

/**
 * Domains and ranges given as lists of classes (by term id), a data property's datatype by the
 * name it is chosen by, and what a model before format 4 kept as Turtle text with the term.
 */
export type ClassLists = Map<string, { domain?: string[]; range?: string[]; datatype?: string; texts?: string[] }>;

/** The predicate a kept text starts with, and the kind of class axiom it is. */
const KEPT_AS: Record<string, ClassAxiomKind> = { 'rdfs:subClassOf': 'SubClassOf', 'owl:equivalentClass': 'EquivalentClasses', 'owl:disjointWith': 'DisjointClasses' };

/**
 * A model of an earlier format with its domains, ranges and class expressions as axioms. What
 * they meant is what those formats wrote to RDF, and that is kept:
 *
 * - (formats 1 and 2) a list of one class was that class, a list of several was their union
 *   (one rdfs:domain statement with an owl:unionOf, its classes in the order of their names as
 *   written), an empty list no domain at all, and none at all a domain that follows the uses. A
 *   data property's datatype is one axiom, and a range written in place that the model kept as
 *   text (rdfs:range [ … ]) becomes the axiom it states, before it, as it was written;
 * - (formats 1 to 3) a superclass, equivalent class or disjoint class kept as text
 *   ("rdfs:subClassOf [ … ]") becomes the axiom of that kind it states, in the same order;
 *   anything else kept as text is kept as the statement it is, with what the model has no place
 *   for (Model.unmapped).
 *
 * Classes are named by IRI in an axiom; entities that had none get theirs first.
 */
export function withClassLists(m: Model, legacy: ClassLists): Model {
  if (!legacy.size) return m;
  const named = withIris(m);
  const iriOf = new Map(named.terms.map((t) => [t.id, t.iri!]));
  const written = (iri: string) => compactIri(named, iri) ?? `<${iri}>`;
  const axioms = (ids: string[]): ClassAxiom[] => {
    const iris = ids.map((id) => iriOf.get(id)).filter((x): x is string => !!x);
    if (!iris.length) return [];
    const sorted = [...iris].sort((a, b) => (written(a) < written(b) ? -1 : written(a) > written(b) ? 1 : 0));
    return [{ id: uid(), expression: sorted.length === 1 ? { type: 'Class', iri: sorted[0] } : { type: 'ObjectUnionOf', operands: sorted.map((iri) => ({ type: 'Class', iri })) } }];
  };
  // Text kept with a term that is no class axiom or range is kept as the statement it is.
  const kept: string[] = [];
  const out: Model = {
    ...named,
    props: named.props.map((p) => {
      const was = legacy.get(p.id);
      return was ? { ...p, ...(was.domain ? { domains: axioms(was.domain) } : {}), ...(was.range ? { ranges: axioms(was.range) } : {}) } : p;
    }),
    terms: named.terms.map((t) => {
      const was = legacy.get(t.id);
      if (!was) return t;
      const out: Term = { ...t };
      if (was.domain) out.domains = axioms(was.domain);
      const ranges: DataRangeAxiom[] = [];
      const classAxioms: ClassExpressionAxiom[] = [];
      for (const text of was.texts ?? []) {
        const at = text.indexOf(' ');
        const pred = at > 0 ? text.slice(0, at) : '';
        const body = text.slice(at + 1);
        const range = pred === 'rdfs:range' && t.type === 'property' ? expressionOfTurtle(body, 'data') : undefined;
        const kind = t.type === 'concept' ? KEPT_AS[pred] : undefined;
        const expression = kind ? expressionOfTurtle(body, 'class') : undefined;
        if (range) ranges.push({ id: uid(), range });
        else if (kind) classAxioms.push({ id: uid(), kind, expression: expression ?? { type: 'Unparsed', turtle: body } });
        else {
          try {
            kept.push(...statementsOf(`${WELL_KNOWN}<${t.iri}> ${text} .`).map((s) => s.text));
          } catch {
            // Not Turtle at all: it is kept where it can be seen, as a comment.
            kept.push(`# Kept with <${t.iri}>, not readable as Turtle: ${text.replace(/\s+/g, ' ')}`);
          }
        }
      }
      const datatype = was.datatype ? rangeOfKey(was.datatype) : undefined;
      if (datatype) ranges.push({ id: uid(), range: datatype });
      if (ranges.length) out.ranges = ranges;
      if (classAxioms.length) out.classAxioms = classAxioms;
      return out;
    }),
  };
  if (!kept.length) return out;
  return { ...out, unmapped: [...(out.unmapped ?? '').split('\n').filter(Boolean), ...kept].sort().join('\n') + '\n' };
}

/** Name of a relation kind as shown in menus; SKOS calls a generalization "broader". */
export function kindLabel(kind: RelKind, skos: boolean): string {
  if (skos) return kind === 'generalization' ? 'Broader' : kind === 'property' ? 'Has property (not SKOS)' : 'Association';
  return REL_KINDS.find((k) => k.value === kind)!.label;
}

export const isLang = (s: string) => LANG.test(s);
