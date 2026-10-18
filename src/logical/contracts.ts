/**
 * Logical data models (roadmap stage LM-1; SYSTEM_ARCHITECTURE.md §13.3 to §13.5,
 * DATA_ARCHITECTURE.md §11): how an application organises its data, in entities, attributes with
 * logical types, relationships with cardinality and optionality, keys, generalizations and
 * business rules. An artifact of its own beside the ontology and the shape sets (ADR-022): several
 * per project, each with its own identity and revisions, never stored in OWL entity structures or
 * written into the ontology's RDF. Logical, not physical: no database's types, no tables, no DDL
 * (ADR-026).
 *
 * As the other services (src/structure, src/editing): plain data only, questions by id of a named
 * revision, refusals typed. An LDM is changed only by logical change sets (ADR-023), never by
 * axioms.
 */

// ---------------------------------------------------------------- the metamodel

/** The logical data types: technology-neutral, by what a value is, not how a database keeps it. */
export const BASE_TYPES = ['text', 'integer', 'decimal', 'boolean', 'date', 'time', 'dateTime', 'duration', 'binary', 'identifier'] as const;
export type BaseTypeName = (typeof BASE_TYPES)[number];

export type BaseType =
  | { base: 'text'; maxLength?: number }
  | { base: 'integer' }
  | { base: 'decimal'; precision?: number; scale?: number }
  | { base: 'boolean' | 'date' | 'time' | 'dateTime' | 'duration' | 'binary' | 'identifier' };

/** An attribute's type: a base type, or a named domain of the LDM by its id. */
export type LogicalType = BaseType | { domain: string };

/** A named, reusable type: a base type narrowed by length, range, pattern or a list of values. */
export interface LogicalDomain {
  id: string;
  name: string;
  definition: string;
  base: BaseType;
  constraints: { minLength?: number; maxLength?: number; pattern?: string; min?: string; max?: string; values?: { code: string; label: string }[] };
}

export interface LogicalAttribute {
  id: string;
  /** Unique in its entity, the attributes it inherits included. */
  name: string;
  definition: string;
  type: LogicalType;
  /** True unless the user chose mandatory: nothing is mandatory by default (NFR-18). */
  optional: boolean;
  derived?: boolean;
}

/**
 * A member of a key: an attribute of the entity (or one it inherits), or, for an identifying
 * relationship whose child the entity is, the relationship's parent end (the identity borrowed).
 */
export type KeyMember = { attribute: string } | { end: { relationship: string; end: 0 | 1 } };

export interface Key {
  id: string;
  kind: 'primary' | 'candidate';
  name: string;
  members: KeyMember[];
}

export interface LogicalEntity {
  id: string;
  /** Unique in the LDM. */
  name: string;
  definition: string;
  /** A supertype with no instances of its own. */
  abstract?: boolean;
  attributes: LogicalAttribute[];
  /** At most one primary. */
  keys: Key[];
}

/** One end of a relationship: the entity there, how the other end calls it, and how many of it. */
export interface RelationshipEnd {
  entity: string;
  role: string;
  /** 0: optional; 1 or more: mandatory. */
  min: number;
  max: number | 'many';
}

/**
 * A binary relationship (the same entity at both ends for a recursive one). When identifying,
 * ends[0] is the child, whose identity includes that of the parent at ends[1].
 */
export interface Relationship {
  id: string;
  name: string;
  definition: string;
  ends: [RelationshipEnd, RelationshipEnd];
  identifying: boolean;
}

export interface Generalization {
  id: string;
  supertype: string;
  subtypes: string[];
  /** Every instance of the supertype is an instance of a subtype. */
  complete: boolean;
  /** No instance is of two subtypes. */
  exclusive: boolean;
  /** An attribute of the supertype that says which subtype. */
  discriminator?: string;
}

/** An element of an LDM, by kind and id. */
export const ELEMENT_KINDS = ['entity', 'attribute', 'key', 'relationship', 'generalization', 'rule', 'domain', 'mapping', 'diagram'] as const;
/** The kind of an element: `keyof ElementRef` is never, because ElementRef is a union of single-key shapes. */
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type ElementRef = { entity: string } | { attribute: string } | { key: string } | { relationship: string } | { generalization: string } | { rule: string } | { domain: string } | { mapping: string } | { diagram: string };

export interface BusinessRule {
  id: string;
  name: string;
  /** In words, always. */
  statement: string;
  kind: 'constraint' | 'derivation';
  appliesTo: ElementRef[];
  /** A formal expression, later (FR-M17-9). */
  expression?: string;
  status: 'proposed' | 'accepted';
}

/**
 * Where a mapping's source was in the ontology when the mapping was made: its IRI, the axioms
 * used (OWL functional syntax), and the label it had then, so that a renamed source can be told
 * from one that was always called this.
 */
export interface MappingSource {
  iri: string;
  axioms: string[];
  /** The source's label when the mapping was made. */
  label?: string;
}

/**
 * What a mapping does, as a stable id (roadmap LM-4). The catalogue in ./strategies.ts says which
 * kind of LDM element each id makes and which ontology sources it reads; the free text in
 * `SemanticMapping.strategy` stays as the words a reader sees.
 */
export const STRATEGY_IDS = [
  'OWL_CLASS_TO_LDM_ENTITY',
  'OWL_CLASS_TO_LDM_REFERENCE_ENTITY',
  'OWL_CLASSES_TO_LDM_ENTITY',
  'OWL_ENUMERATION_TO_LDM_DOMAIN',
  'OWL_ENUMERATION_TO_LDM_REFERENCE_ENTITY',
  'OWL_ENUMERATED_DATATYPE_TO_LDM_DOMAIN',
  'OWL_HIERARCHY_ROLLUP_TO_LDM_ENTITY',
  'OWL_SUBCLASS_TO_LDM_SPECIALIZATION',
  'OWL_SUBCLASS_TO_LDM_ROLLDOWN',
  'OWL_DATA_PROPERTY_TO_LDM_ATTRIBUTE',
  'OWL_OBJECT_PROPERTY_TO_LDM_RELATIONSHIP',
  'OWL_OBJECT_PROPERTY_TO_LDM_INVERSE_PAIR',
  'OWL_OBJECT_PROPERTY_TO_LDM_ASSOCIATION',
  'OWL_OBJECT_PROPERTY_TO_LDM_DOMAIN_ATTRIBUTE',
  'OWL_RESTRICTION_TO_LDM_MANDATORY_ATTRIBUTE',
  'OWL_RESTRICTION_TO_LDM_RULE',
  'OWL_RESTRICTION_TO_LDM_MANDATORY_END',
  'OWL_RESTRICTION_TO_LDM_CARDINALITY_END',
  'OWL_HAS_KEY_TO_LDM_KEY',
] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

/** A conversion a mapping went through: the strategy it followed before, the one it follows now, and when. */
export interface MappingConversion {
  from?: StrategyId;
  to: StrategyId;
  at: number;
}

/**
 * Where elements came from in the ontology (stage LM-4): sources by IRI and by the axioms used
 * (OWL functional syntax), targets by id, with the strategy, the rationale and the ontology
 * revision it was made from. Its status is worked out against the ontology, never stored.
 */
export interface SemanticMapping {
  id: string;
  sources: MappingSource[];
  targets: ElementRef[];
  strategy: string;
  /** What the mapping does, as a catalogue id; absent on a mapping made before ids existed, until it is classified. */
  strategyId?: StrategyId;
  rationale: string;
  origin: { ontology: string; revision: string; version?: string };
  /** What the mapping last made of its targets: a target that differs from it was customised. */
  baseline: Record<string, unknown>;
  made: { by: 'transformation' | 'hand' | 'synchronization' | 'assistant'; at: number; author?: string };
  /** The last reviewed conversion of the mapping's target element, where there was one. */
  converted?: MappingConversion;
}

/** Where entities sit on a diagram of the LDM (stage LM-2): the picture, never the meaning. */
export interface LogicalDiagram {
  id: string;
  name: string;
  positions: Record<string, { x: number; y: number }>;
}

// ---------------------------------------------------------------- derivation (stage LM-3)

/** Where a name comes from: the ontology's label, or the last part of its IRI. */
export const NAMING_SOURCES = ['label', 'localName'] as const;
export type NamingSource = (typeof NAMING_SOURCES)[number];

/** How a name is cased. `asis` keeps what the source says, and changes only its separators. */
export const NAMING_CASES = ['asis', 'lower', 'upper', 'pascal', 'camel'] as const;
export type NamingCase = (typeof NAMING_CASES)[number];

/** What joins the words of a name. Empty: none, as in PascalCase. */
export const NAMING_SEPARATORS = [' ', '', '_', '-'] as const;
export type NamingSeparator = (typeof NAMING_SEPARATORS)[number];

/** What a subclass hierarchy becomes: a specialization, one rolled-up entity, or attributes rolled down. */
export const HIERARCHY_STRATEGIES = ['specialization', 'rollup', 'rolldown'] as const;
export type HierarchyStrategy = (typeof HIERARCHY_STRATEGIES)[number];

/** What an object property becomes: a relationship, or (where both ends are many) an associative entity. */
export const OBJECT_PROPERTY_STRATEGIES = ['relationship', 'associative'] as const;
export type ObjectPropertyStrategy = (typeof OBJECT_PROPERTY_STRATEGIES)[number];

/** Which classes of the ontology a transformation reads. */
export interface TransformationScope {
  kind: 'all' | 'branch' | 'classes';
  /** Class IRIs: the root of a branch, or the classes chosen. */
  classes: string[];
  /** Include the classes of the ontologies it imports, as far as they are loaded here. */
  withImports: boolean;
}

/**
 * How an LDM is derived from the ontology (FR-M18-5). Kept with the LDM, so that running the
 * transformation again works from the same choices.
 */
export interface TransformationConfig {
  scope: TransformationScope;
  naming: { from: NamingSource; case: NamingCase; separator: NamingSeparator; singular: boolean };
  /** XSD datatype IRIs that differ from the standard logical type they would be given. */
  datatypes: Record<string, BaseTypeName>;
  hierarchy: HierarchyStrategy;
  objectProperties: ObjectPropertyStrategy;
  /** Read definitions from the ontology's descriptions. */
  definitions: boolean;
}

/** One logical data model. */
export interface LogicalModel {
  /** Unique in the project, never reused. */
  id: string;
  name: string;
  description: string;
  /** Which application or use it serves. */
  purpose: string;
  /** Moves when this LDM changes, and only then. */
  revision: string;
  domains: LogicalDomain[];
  entities: LogicalEntity[];
  relationships: Relationship[];
  generalizations: Generalization[];
  rules: BusinessRule[];
  mappings: SemanticMapping[];
  diagrams: LogicalDiagram[];
  /** How it was last derived from the ontology (stage LM-3), where it was. */
  derivation?: TransformationConfig;
}

// ---------------------------------------------------------------- changes

/** An element as a change adds or removes it: whole, so that its inverse is known. */
export type LogicalElement =
  | { kind: 'entity'; entity: LogicalEntity }
  | { kind: 'attribute'; entity: string; attribute: LogicalAttribute }
  | { kind: 'key'; entity: string; key: Key }
  | { kind: 'relationship'; relationship: Relationship }
  | { kind: 'generalization'; generalization: Generalization }
  | { kind: 'rule'; rule: BusinessRule }
  | { kind: 'domain'; domain: LogicalDomain }
  | { kind: 'mapping'; mapping: SemanticMapping }
  | { kind: 'diagram'; diagram: LogicalDiagram };

/** What an update is of: an element, or the LDM's own name, description and purpose. */
export type UpdateTarget = ElementRef | { model: true };

export type LogicalChange =
  | { op: 'add'; element: LogicalElement }
  /** The element exactly as it is: removed only if it still is. */
  | { op: 'remove'; element: LogicalElement }
  /** Fields of one element, as they are (before) and are to be (after); refused if they are not as `before` says. */
  | { op: 'update'; target: UpdateTarget; before: Record<string, unknown>; after: Record<string, unknown> };

/** The unit of an LDM edit (ADR-023), the counterpart of the ontology's ChangeSet. */
export interface LogicalChangeSet {
  /** The LDM. */
  model: string;
  /** The LDM's revision it was made against. */
  baseRevision: string;
  changes: LogicalChange[];
  /** For the history: what the user did, in words. */
  summary: string;
}

// ---------------------------------------------------------------- refusals

export type LogicalErrorCode = 'invalid' | 'refused' | 'stale-revision' | 'not-found' | 'aborted' | 'conversion-required';

/** Why a change cannot be made, in words, with the element it is about. */
export interface LogicalRefusal {
  code: 'invalid' | 'refused';
  message: string;
  element?: ElementRef | { model: true };
}

export class LogicalError extends Error {
  constructor(
    readonly code: LogicalErrorCode,
    message: string,
    readonly refusals: LogicalRefusal[] = [],
  ) {
    super(message);
    this.name = 'LogicalError';
  }
}

export interface CallOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------- the services

/** An LDM in a list: what it is, and how much is in it. */
export interface LogicalModelInfo {
  id: string;
  name: string;
  description: string;
  purpose: string;
  revision: string;
  counts: { entities: number; attributes: number; relationships: number; keys: number; generalizations: number; rules: number; domains: number };
}

export interface LogicalModelRef {
  model: string;
  /** The revision asked about; refused as stale when the LDM has moved on. The current one when absent. */
  revision?: string;
}

/** An entity as a list shows it. */
export interface EntityRow {
  id: string;
  name: string;
  definition: string;
  attributes: number;
  hasPrimaryKey: boolean;
  supertypes: string[];
}

/** An element with what it is related to. */
export type ElementDescription =
  | {
      kind: 'entity';
      entity: LogicalEntity;
      /** Attributes inherited from supertypes, nearest first, with the supertype each is from. */
      inherited: { from: string; attribute: LogicalAttribute }[];
      /** Keys inherited from supertypes, nearest first, with the supertype each is from. */
      inheritedKeys: { from: string; key: Key }[];
      supertypes: string[];
      subtypes: string[];
      relationships: Relationship[];
      generalizations: Generalization[];
      rules: BusinessRule[];
    }
  | { kind: 'attribute'; entity: string; attribute: LogicalAttribute; inKeys: string[]; rules: BusinessRule[] }
  | { kind: 'key'; entity: string; key: Key }
  | { kind: 'relationship'; relationship: Relationship; rules: BusinessRule[] }
  | { kind: 'generalization'; generalization: Generalization }
  | { kind: 'rule'; rule: BusinessRule }
  | { kind: 'domain'; domain: LogicalDomain; usedBy: { entity: string; attribute: string }[] }
  | { kind: 'mapping'; mapping: SemanticMapping }
  | { kind: 'diagram'; diagram: LogicalDiagram };

/** Read-only questions about the project's LDMs (FR-M17-16). */
export interface LogicalModelQueryService {
  models(options?: CallOptions): Promise<LogicalModelInfo[]>;
  /** The whole LDM: for an editor, an export, a comparison. */
  model(ref: LogicalModelRef, options?: CallOptions): Promise<LogicalModel>;
  /** Entities, searched by name or definition, a page at a time, in the order of their names. */
  entities(query: LogicalModelRef & { search?: string; offset?: number; limit?: number }, options?: CallOptions): Promise<{ revision: string; total: number; offset: number; items: EntityRow[] }>;
  describe(query: LogicalModelRef & { element: ElementRef }, options?: CallOptions): Promise<{ revision: string; description: ElementDescription }>;
  /** The relationships an entity takes part in. */
  relationships(query: LogicalModelRef & { entity: string }, options?: CallOptions): Promise<{ revision: string; items: Relationship[] }>;
}

/** Changes to the project's LDMs (FR-M17-1, FR-M17-14): each one step of the history. */
export interface LogicalModelEditService {
  create(input: { name: string; description?: string; purpose?: string }, options?: CallOptions): Promise<{ model: string; revision: string }>;
  /** A copy with new ids throughout, independent of the original. */
  duplicate(input: { model: string; name?: string }, options?: CallOptions): Promise<{ model: string; revision: string }>;
  remove(input: { model: string }, options?: CallOptions): Promise<void>;
  /** An LDM from its exchange format (exchange.ts); a new id if the project has its id already, a new name if it has its name. */
  import(input: { document: string }, options?: CallOptions): Promise<{ model: string; revision: string; name: string }>;
  validate(changeSet: LogicalChangeSet, options?: CallOptions): Promise<{ ok: boolean; refusals: LogicalRefusal[] }>;
  apply(changeSet: LogicalChangeSet, options?: CallOptions): Promise<{ model: string; revision: string }>;
}
