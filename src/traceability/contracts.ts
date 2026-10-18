import type { Model } from '../model/types';
import type { CallOptions, ElementKind, ElementRef, LogicalChange, LogicalModel, MappingSource, SemanticMapping, StrategyId, TransformationConfig } from '../logical/contracts';

/**
 * Deriving a logical data model from the ontology (roadmap LM-3; SYSTEM_ARCHITECTURE.md §13.4;
 * FR-M18-1 to FR-M18-6, ADR-024). The service reads the ontology as it is and proposes LDM
 * elements; nothing is written until the user accepts proposals, and the ontology is never written
 * at all (NFR-17). Constraints that OWL axioms might suggest are offered as candidates only, never
 * chosen to begin with (NFR-18).
 *
 * As the other services (src/structure, src/logical): plain data only, questions and proposals by
 * id, refusals typed, no view or store.
 */

export type ProposalKind = 'entity' | 'attribute' | 'relationship' | 'specialization' | 'domain' | 'constraint';

/** Where a proposal comes from: an ontology entity's IRI and label, and the axioms it was read from (OWL functional syntax). */
export type ProposalSource = MappingSource;

/**
 * One thing the transformation offers to make or change. It carries the logical change set it
 * would apply, so that accepted proposals go in as one step of the LDM's history, with the
 * semantic mappings they imply. `candidate` marks a constraint (a mandatory end or attribute, a
 * maximum, a key, a rule): never chosen to begin with.
 */
export interface TransformationProposal {
  id: string;
  kind: ProposalKind;
  /** What it offers, in words: "Entity from class Film". */
  title: string;
  sources: ProposalSource[];
  /** The elements it would make or change, in words. */
  elements: string[];
  changes: LogicalChange[];
  strategy: string;
  rationale: string;
  /** Where OWL and the LDM differ, in words. */
  difference: string;
  /** Other proposals that have to be accepted with it, by id. */
  requires: string[];
  candidate: boolean;
}

/** A class or property the transformation left alone, and why. */
export interface SkippedSource {
  iri: string;
  name: string;
  reason: string;
}

/** What the transformation worked out for one LDM and one configuration. Plain data: it travels from a worker. */
export interface TransformationResult {
  /** The LDM the proposals are for. */
  model: string;
  /** Its revision when the proposals were worked out. */
  baseRevision: string;
  config: TransformationConfig;
  origin: { ontology: string; revision: string; version?: string };
  /** The classes that were in scope, by IRI. */
  scope: { classes: string[] };
  proposals: TransformationProposal[];
  skipped: SkippedSource[];
  at: number;
}

/** What to propose from, and into. The ontology is read from the service's host, as it is now. */
export interface ProposeRequest {
  /** The LDM to propose into. */
  model: string;
  config: TransformationConfig;
}

export interface AcceptRequest {
  result: TransformationResult;
  /** The ids of the proposals accepted. A proposal whose `requires` is not among them is refused. */
  accepted: string[];
}

/** Proposals from the ontology, and their application as one logical change set (LM-3). */
export interface TransformationService {
  /** Works out proposals for the LDM under a configuration. Never changes the LDM or the ontology. */
  propose(request: ProposeRequest, options?: CallOptions): Promise<TransformationResult>;
  /** Applies the accepted proposals as one logical change set, with their mappings, and saves the configuration with the LDM. */
  apply(request: AcceptRequest, options?: CallOptions): Promise<{ model: string; revision: string; applied: number }>;
}

/** The ontology a proposal is read from: its model, and what it is called and which revision it is. */
export interface OntologySnapshot {
  model: Model;
  ontology: string;
  revision: string;
  version?: string;
}

/** The ontology and the LDM as the worker reads them. */
export interface ProposalJob {
  ontology: Model;
  origin: TransformationResult['origin'];
  target: LogicalModel;
  config: TransformationConfig;
}

/** What a proposal's target is, by kind, for a reader: used in words and in tests. */
export const refKind = (ref: ElementRef): keyof ElementRef => Object.keys(ref)[0] as keyof ElementRef;

// ---------------------------------------------------------------- traceability and impact (stage LM-4)

/**
 * Whether a mapping still holds: *current* while the ontology still states every source axiom as
 * it was; *stale* when one is no longer stated or another has been added; *broken* when a source
 * entity or a target element is gone; *mismatched* when the mapping's typed strategy makes a
 * different kind of element than the one it targets. Worked out, never stored
 * (SYSTEM_ARCHITECTURE.md §13.7).
 */
export type MappingStatus = 'current' | 'stale' | 'broken' | 'mismatched';

export interface MappingChange {
  kind: 'source-removed' | 'source-added' | 'source-changed' | 'target-removed';
  /** The ontology source the change is about. */
  source?: string;
  /** The LDM element the change is about. */
  target?: ElementRef;
  /** Axioms that were recorded and are no longer stated, or that are now stated and were not recorded. */
  removed: string[];
  added: string[];
  /** In words. */
  text: string;
}

/** An element a mapping targets, as it is now. */
export interface TargetDescription {
  ref: ElementRef;
  /** What it is called; its id when it is gone. */
  name: string;
  exists: boolean;
  /** It differs from what the mapping last made of it. */
  customised: boolean;
}

/** A mapping with what its status is made of. */
export interface MappingDescription {
  mapping: SemanticMapping;
  status: MappingStatus;
  customised: boolean;
  changes: MappingChange[];
  targets: TargetDescription[];
  sources: { iri: string; label?: string; name?: string; exists: boolean }[];
}

/** What an LDM covers, both ways (FR-M18-9). */
export interface Coverage {
  model: string;
  /** How many classes the recorded derivation reads; null when the LDM records no derivation. */
  scope: number | null;
  /** Classes in scope that no mapping names. */
  unrepresented: { iri: string; name: string }[];
  /** Elements with no mapping targeting them. */
  unsourced: { ref: ElementRef; name: string }[];
  counts: { elements: number; sourced: number };
}

/** Where a mapping's LDM stands in the ontology (FR-M18-8, FR-M18-10). Plain data, as the services give it. */
export interface TraceabilityReport {
  model: string;
  /** The LDM's revision when the report was worked out. */
  baseRevision: string;
  /** The ontology as it was read. */
  ontology: { ontology: string; revision: string; version?: string };
  mappings: MappingDescription[];
  coverage: Coverage;
  at: number;
}

/** The kind of change an impact item reports (FR-M18-11). */
export type ImpactKind = 'not-represented' | 'source-removed' | 'target-removed' | 'type-changed' | 'cardinality-changed' | 'hierarchy-changed' | 'restriction-changed' | 'renamed' | 'axiom-changed';

/** One thing an ontology change means for an LDM. */
export interface ImpactItem {
  id: string;
  kind: ImpactKind;
  /** The mapping it concerns, where one does. */
  mapping?: string;
  target?: ElementRef;
  sources: string[];
  /** In words: what is affected. */
  title: string;
  detail: string;
  customised: boolean;
  /** The axioms the change is made of, where it is an axiom change. */
  changed?: { removed: string[]; added: string[] };
}

/** An impact report of one LDM (FR-M18-11). */
export interface ImpactReport {
  model: string;
  baseRevision: string;
  ontology: { ontology: string; revision: string; version?: string };
  /** Which two states the report is between, in words. */
  compared: { from: string; to: string };
  mappings: MappingDescription[];
  coverage: Coverage;
  items: ImpactItem[];
  at: number;
}

/**
 * What to compare: the ontology now against each mapping's origin (the default), or two of the
 * project's saved versions. A report between versions offers no synchronization: it is a reading
 * of the past, not a state to move an LDM to.
 */
export interface ImpactRequest {
  model: string;
  between?: { from: { version: string }; to: { version: string } | 'current' };
}

export interface SynchronizeRequest {
  model: string;
  /** Fingerprints of proposals turned down before: left out while their sources are as they were. */
  dismissed?: string[];
}

/** What a synchronization offers to do. */
export type SynchronizationKind = 'add' | 'update' | 'remove' | 'record';

/**
 * One reviewed change to an LDM after an ontology change (FR-M18-12). It carries the logical
 * changes it would make, including the mapping origin it moves; `customised` marks a proposal
 * about an element the user changed, never chosen to begin with.
 */
export interface SynchronizationProposal {
  id: string;
  kind: SynchronizationKind;
  title: string;
  item?: string;
  /** The mappings it synchronizes. */
  mappings: string[];
  sources: ProposalSource[];
  elements: string[];
  changes: LogicalChange[];
  strategy: string;
  rationale: string;
  difference: string;
  /** Other proposals that have to be accepted with it. */
  requires: string[];
  /** Proposals it cannot go with, because they change the same elements. */
  excludes: string[];
  customised: boolean;
  /** Changes when what the ontology states of its sources changes, so that a dismissal can be held until then. */
  fingerprint: string;
}

export interface SynchronizationResult {
  model: string;
  baseRevision: string;
  ontology: ImpactReport['ontology'];
  report: ImpactReport;
  proposals: SynchronizationProposal[];
  at: number;
}

export interface ApplySynchronizationRequest {
  result: SynchronizationResult;
  /** The ids of the proposals accepted. */
  accepted: string[];
}

/** An element a mapping targets, for tracing. */
export interface TracedTarget {
  ref: ElementRef;
  name: string;
  exists: boolean;
}

/** A mapping seen from one of its sides. */
export interface TracedMapping {
  model: string;
  modelName: string;
  mapping: SemanticMapping;
  status: MappingStatus;
  customised: boolean;
  targets: TracedTarget[];
}

/** Traceability both ways (FR-M18-9): from an LDM element, or from an ontology entity. */
export interface TraceQuery {
  /** The LDM, for an element query. */
  model?: string;
  element?: ElementRef;
  /** The ontology entity, for a source query. */
  iri?: string;
}

export interface TraceResult {
  /** Where an element query started, and what it is called. */
  element?: { ref: ElementRef; name: string };
  /** Where a source query started. */
  iri?: string;
  /** Every mapping found, in every LDM, with its targets. */
  mappings: TracedMapping[];
  /** The sources of the element asked about, with the axioms the ontology states now. */
  sources: ProposalSource[];
}

/** A mapping made by hand (FR-M18-8): the sources are read from the ontology as it is. */
export interface MappingInput {
  model: string;
  sources: { iri: string }[];
  targets: ElementRef[];
  strategyId: StrategyId;
  rationale: string;
}

export interface MappingEdit {
  model: string;
  mapping: string;
  sources: { iri: string }[];
  targets: ElementRef[];
  /** The strategy the mapping follows now. One that makes a different kind of element needs a reviewed conversion. */
  strategyId: StrategyId;
  rationale: string;
}

/** One choice a conversion has to take before it can be applied. */
export interface ConversionDecision {
  name: string;
  label: string;
  choices: { value: string; label: string }[];
  chosen: string;
}

/**
 * What changing a mapping's strategy would do to its target element, worked out before anything
 * is written (roadmap LM-4). It carries the element changes alone; applying it adds the mapping's
 * own update after them, as one change set. Nothing here is committed.
 */
export interface ConversionPreview {
  model: string;
  mapping: string;
  /** The LDM's revision this was worked out against; an LDM that moved since refuses it. */
  baseRevision: string;
  /** The mapping's target element as it is now. */
  from: { strategyId?: StrategyId; ref: ElementRef; kind: ElementKind; name: string };
  /** What it would become. */
  to: { strategyId: StrategyId; kind: ElementKind; name: string };
  /** What the conversion makes, changes and takes away, in words. */
  creates: string[];
  modifies: string[];
  removes: string[];
  /** What happens to keys and constraints: the part of a conversion that is easy to miss. */
  keys: string[];
  constraints: string[];
  decisions: ConversionDecision[];
  warnings: string[];
  /** Why the conversion cannot be made as it stands; nothing is ever applied with one. */
  conflicts: string[];
  /** The element changes, without the mapping's own update. */
  changes: LogicalChange[];
  /** The mapping as it would be, with the sources and rationale the form had when it was previewed. */
  mappingAfter: { sources: MappingSource[]; targets: ElementRef[]; strategyId: StrategyId; strategy: string; baseline: Record<string, unknown>; rationale: string };
  at: number;
}

/** What to convert, and the choices taken so far. */
export interface ConversionQuery {
  model: string;
  mapping: string;
  to: StrategyId;
  decisions?: Record<string, string>;
  /** The sources and rationale as the form has them: kept with the mapping if the conversion is applied. */
  sources?: { iri: string }[];
  rationale?: string;
}

/**
 * Traceability, impact and synchronization (roadmap LM-4; SYSTEM_ARCHITECTURE.md §13.7 to
 * §13.9; FR-M18-8 to FR-M18-14, ADR-025). Reports are plain data; synchronization proposals are
 * accepted, never imposed; the ontology is read and never written, and an LDM never moves by
 * itself.
 */
export interface TraceabilityService {
  /** Every mapping of an LDM with its status, customisation and coverage. */
  report(query: { model: string }, options?: CallOptions): Promise<TraceabilityReport>;
  /** The impact of the ontology on an LDM: each mapping's origin against now, or two saved versions. */
  impact(query: ImpactRequest, options?: CallOptions): Promise<ImpactReport>;
  /** The impact report together with reviewed proposals for the LDM (origin against now only). */
  synchronize(query: SynchronizeRequest, options?: CallOptions): Promise<SynchronizationResult>;
  /** Applies the accepted proposals as one logical change set, moving their mappings' origins. */
  apply(request: ApplySynchronizationRequest, options?: CallOptions): Promise<{ model: string; revision: string; applied: number }>;
  /** From an LDM element to its sources, or from an ontology entity to every element made from it. */
  trace(query: TraceQuery, options?: CallOptions): Promise<TraceResult>;
  addMapping(input: MappingInput, options?: CallOptions): Promise<{ model: string; revision: string; mapping: string }>;
  editMapping(input: MappingEdit, options?: CallOptions): Promise<{ model: string; revision: string }>;
  removeMapping(input: { model: string; mapping: string }, options?: CallOptions): Promise<{ model: string; revision: string }>;
  /** What changing a mapping's strategy would make of its target element. Never changes anything. */
  previewConversion(query: ConversionQuery, options?: CallOptions): Promise<ConversionPreview>;
  /** Applies a reviewed preview as one logical change set, with the mapping's own update, or refuses it whole. */
  applyConversion(preview: ConversionPreview, options?: CallOptions): Promise<{ model: string; revision: string }>;
}

/** The ontology and the LDM as the impact worker reads them. */
export interface ImpactJob {
  kind: 'impact';
  ontology: Model;
  /** An earlier ontology, for two saved versions; absent: each mapping's origin. */
  before?: Model;
  origin: { ontology: string; revision: string; version?: string };
  target: LogicalModel;
  dismissed?: string[];
  synchronize: boolean;
}

export interface ImpactAnswer {
  report: ImpactReport;
  proposals: SynchronizationProposal[];
}
