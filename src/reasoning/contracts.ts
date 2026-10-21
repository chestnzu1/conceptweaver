/**
 * Reasoning as a job: asked for one revision of an ontology, worked out away from the page, given
 * up whenever it is no longer wanted, and answered for that revision only.
 *
 * Two engines answer, on purpose differently (see src/model/reasoning.ts):
 *
 *   fast  The app's own rule reasoner. It runs in the browser, in a worker, over the model in the
 *         editor, and its answer is that model's: facts about its terms by the ids the editor
 *         gives them, which only the editor that holds the model can read. A backend does not
 *         offer it.
 *   dl    A complete OWL 2 DL reasoner (HermiT), in the reasoning service beside the app or in a
 *         backend. Its answer names entities by IRI.
 *
 * So that a backend can take the place of the local service:
 *
 *   - Every job names the ontology and the revision it is about; a job for a revision the
 *     ontology has moved on from is refused (`stale-revision`), and an answer says which
 *     revision it is of.
 *   - Starting a job answers at once; how it goes is asked (`status`), and it can always be
 *     given up (`cancel`). Its answer is waited for with `result`.
 *   - Everything is plain data, so that it can travel as JSON.
 */

export interface OntologyRef {
  ontologyId: string;
  revisionId: string;
}

export type EngineId = 'fast' | 'dl';

/** queued: not begun. running: under way. done: answered. failed: it could not answer. cancelled: given up. */
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ReasoningJob extends OntologyRef {
  job: string;
  engine: EngineId;
  state: JobState;
  /** What it is doing, in words, while it runs. */
  phase: string;
  /** Why it failed. */
  error?: string;
  /** Its answer had already been worked out for this revision and reasoner, and was reused. */
  cached?: boolean;
}

// ---------------------------------------------------------------- the fast reasoner's answer

/** A contradiction the fast reasoner found, in words, with the terms and relationships it is about (by the editor's ids). */
export interface Conflict {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  because: string;
  terms: string[];
  rels: string[];
}

/**
 * The fast reasoner's work: every fact it knows, stated or derived, with the facts each was
 * derived from, and the contradictions it found. What it means in words is worked out from this
 * where it is shown.
 */
export interface Derivation {
  /** Subject, predicate, object, the relationship that states it ('' for a derived fact), and the facts it was derived from, by index (none for a stated one). */
  facts: [string, string, string, string, number[] | null][];
  /** Names of what is not a term: object properties, literals, datatypes. */
  labels: [string, string][];
  /** The members of each enumeration. */
  members: [string, string[]][];
  /** How many facts are stated. */
  asserted: number;
  truncated: boolean;
  conflicts: Conflict[];
}

// ---------------------------------------------------------------- the OWL 2 DL reasoner's answer

/** An entity that an axiom mentions, as the service names it. */
export interface AxiomEntity {
  iri: string;
  /** Class, ObjectProperty, DataProperty, NamedIndividual, Datatype, AnnotationProperty. */
  kind: string;
  name: string;
}

/** An asserted axiom, in Manchester syntax, with what it is about. */
export interface AxiomText {
  text: string;
  type?: string;
  entities: AxiomEntity[];
}

/** One smallest set of asserted axioms from which the conclusion follows. */
export interface Justification {
  axioms: AxiomText[];
}

export interface DlExplanation {
  kind: 'unsatisfiable' | 'inconsistent';
  /** IRI of the class, for an unsatisfiable one. */
  subject?: string;
  justifications: Justification[];
  /** Why there is no justification, when there is none. */
  note?: string;
}

export interface DlViolation {
  rule: string;
  text: string;
  entities: AxiomEntity[];
}

/** The answer of the reasoning service, as it sends it: IRIs throughout. */
export interface DlReport {
  engine: string;
  engineVersion: string;
  owlapi?: string;
  /** complete: reasoned as OWL 2 DL. partial: reasoned, with something left out or taken loosely. failed: no result. */
  status: 'complete' | 'partial' | 'failed';
  consistency: 'consistent' | 'inconsistent' | 'unknown';
  /** How long the service worked. */
  ms: number;
  axioms?: number;
  logicalAxioms?: number;
  profile?: { owl2dl: boolean; violations: DlViolation[]; violationCount: number; undeclared: string[]; undeclaredCount: number; owl2el?: boolean; elViolationCount?: number };
  /** Which reasoner answered, and why: the one asked for, or, asked to choose, ELK for OWL 2 EL and HermiT otherwise. */
  choice?: { requested: 'auto' | 'hermit' | 'elk'; reasoner: string; why: string };
  imports?: { resolved: string[]; missing: string[] };
  unsatisfiable?: string[];
  /** Each class with the classes directly above it in the inferred hierarchy. */
  subclasses?: { sub: string; sup: string }[];
  equivalents?: string[][];
  /** Each individual with the most specific classes it is entailed to be an instance of. */
  types?: { individual: string; class: string }[];
  same?: string[][];
  relations?: { subject: string; property: string; object: string }[];
  explanations?: DlExplanation[];
  errors: string[];
  warnings: string[];
  /** The limits it was worked out under: how long the service allowed, and the heap it had. */
  limits?: { timeoutMs: number; maxHeapMb?: number };
  /** Added here, not by the service: where it was asked, how long the round trip took, and whether it answered at all. */
  url?: string;
  roundTripMs?: number;
  unreachable?: boolean;
}

// ---------------------------------------------------------------- the service

export type ReasoningAnswer = (OntologyRef & { engine: 'fast'; derivation: Derivation }) | (OntologyRef & { engine: 'dl'; report: DlReport });

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. The job itself goes on: `cancel` stops it. */
  signal?: AbortSignal;
}

export interface ReasoningService {
  /** Starts reasoning about a revision with an engine, and answers with the job at once. */
  start(query: OntologyRef & { engine: EngineId }, options?: CallOptions): Promise<ReasoningJob>;
  /** How a job is going. */
  status(job: string, options?: CallOptions): Promise<ReasoningJob>;
  /** Stops a job, if it has not finished. */
  cancel(job: string): Promise<ReasoningJob>;
  /** The answer of a job, once it has one; refused when it failed or was cancelled. */
  result(job: string, options?: CallOptions): Promise<ReasoningAnswer>;
}

/**
 * stale-revision: the ontology has moved on from the revision named. not-found: there is no such
 * ontology or job. cancelled: the job was stopped. failed: it could not answer. aborted: the
 * question was given up. busy: the service has as much work as it takes; ask again when a job
 * has finished (a backend bounds how much it reasons over at once). invalid: the question is not
 * one the service can take. unsupported: the service does not offer what was asked for (a backend
 * does not reason with the app's own fast engine).
 */
export type ReasoningErrorCode = 'stale-revision' | 'not-found' | 'cancelled' | 'failed' | 'aborted' | 'busy' | 'invalid' | 'unsupported';

export class ReasoningError extends Error {
  constructor(
    readonly code: ReasoningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReasoningError';
  }
}
