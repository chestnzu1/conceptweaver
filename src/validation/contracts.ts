import type { DlReport, EngineId, JobState, OntologyRef } from '../reasoning/contracts';

/**
 * Validation as a job: three kinds of check of one revision of an ontology, worked out away from
 * the page, given up whenever they are no longer wanted, and reported for that revision only.
 *
 *   owl      Does the ontology contradict itself? Answered by a reasoner, the app's own or the
 *            OWL 2 DL one, with its justifications. Open world: what is not stated is unknown.
 *   shacl    Does the data have the shape it is required to have? Answered by a SHACL engine
 *            over a data graph and the shapes graph. Closed world: what is missing is a violation.
 *   quality  Is the ontology well made? Rules of thumb, each of which can be switched off.
 *
 * As with reasoning (src/reasoning/contracts.ts): every job names the revision it is about and is
 * refused for one the ontology has moved on from; starting answers at once, `status` says how it
 * goes, `cancel` stops it, and `report` waits for what it found. Everything is plain data.
 *
 * Findings name entities by the editor's ids where the editor holds them, and by IRI too where
 * they have one; a quick fix travels as what it does, in words, and is applied where the model is.
 */

export type { OntologyRef };

export type Category = 'owl' | 'shacl' | 'quality';
export type Level = 'error' | 'warning' | 'info';
export type EntityType = 'class' | 'object property' | 'data property' | 'individual' | 'relationship' | 'shape' | 'ontology' | 'data';

export interface EntityRef {
  kind: 'term' | 'prop' | 'rel' | 'shape' | 'model' | 'external';
  /** Term id, property key, relation id, shape id, or for something outside the model its IRI. */
  id: string;
  name: string;
  type: EntityType;
  iri?: string;
}

/** A SHACL validation result as the standard reports it. A field the engine did not give is absent. */
export interface ShaclDetail {
  focusNode: string;
  /** The line of the data graph's file on which statements about the focus node begin, where the file was Turtle and the node is named. */
  line?: number;
  /** As SPARQL writes a property path: a property, or `^:p`, `:a / :b` and the like. */
  resultPath?: string;
  value?: string;
  sourceShape: string;
  sourceConstraintComponent: string;
  resultSeverity: string;
  resultMessage: string[];
  /** The parameter of the source shape that gives the constraint, by its local name: `minCount` for sh:MinCountConstraintComponent. */
  parameter?: string;
}

export interface Finding {
  id: string;
  category: Category;
  severity: Level;
  /** The rule, constraint or kind of contradiction, in words. */
  rule: string;
  ruleId: string;
  message: string;
  /** For OWL: the reasoner's own justification. For the rest: why it matters. Absent when there is none. */
  explanation?: string;
  suggestion?: string;
  entity?: EntityRef;
  /** The property or axiom concerned, as text. */
  property?: string;
  /** Terms and relationships to spotlight on the canvas. */
  terms: string[];
  rels: string[];
  shacl?: ShaclDetail;
  /** The shape a finding is about: for SHACL, the source shape itself, which may be a property shape or another shape inside one. */
  shapeId?: string;
  /** A quick fix: what it does, in words. It is applied where the model is (`fixOf` in src/validation/local.ts). */
  fix?: Fix;
  /**
   * For a finding of the OWL 2 DL reasoner: its justifications, each a smallest set of asserted
   * axioms from which the finding follows, in Manchester syntax. They are the reasoner's own.
   */
  justifications?: { text: string; entities: JustifiedEntity[] }[][];
  /** Why there is no justification, when the reasoner gave none. */
  justificationNote?: string;
  /** Which reasoner found it, when it was not the app's own. */
  engine?: string;
}

/** An entity an axiom of a justification mentions, with how it is written in that axiom. */
export type JustifiedEntity = EntityRef & { token?: string };

export interface OwlSummary {
  /** Which reasoner this is the answer of. */
  engine: EngineId;
  /** Its name, with its version where it has one: "HermiT 1.4.5.456". */
  engineName: string;
  /**
   * not-applicable: a SKOS concept scheme has no OWL semantics to contradict.
   * unknown: the reasoner gave no answer (it could not be reached, failed, or cannot reason over this ontology).
   */
  status: 'consistent' | 'inconsistent' | 'unknown' | 'not-applicable';
  /**
   * Whether "consistent" is proved. Only a complete reasoner that finished over all of the
   * ontology proves it; from the app's own rules it means that no contradiction was found.
   */
  proved: boolean;
  contradictions: number;
  unsatisfiable: string[];
  asserted: number;
  inferred: number;
  /** The reasoner stopped early or left something out, so "consistent" is about what it looked at. */
  partial: boolean;
  profile: string;
  ms: number;
  /** What kept the reasoner from answering, or from answering for all of the ontology. */
  errors?: string[];
  notes?: string[];
}

export interface ShaclSummary {
  /** skipped: there were no shapes. failed: the shapes or data could not be read, or the engine gave up. */
  status: 'conforms' | 'violations' | 'skipped' | 'failed';
  error?: string;
  violations: number;
  warnings: number;
  infos: number;
  shapes: number;
  dataTriples: number;
  dataSource: string;
  includesOntology: boolean;
  /** The shape set validated with, when one was chosen; every set when absent. */
  shapeSet?: { id: string; name: string };
  /** The standard validation report, as Turtle. */
  report?: string;
  ms: number;
}

export interface QualitySummary {
  errors: number;
  warnings: number;
  suggestions: number;
  rulesOn: number;
  rulesTotal: number;
  ms: number;
}

/**
 * What SHACL validates: the model's own RDF, or one of the model's data graphs (Model.dataGraphs),
 * RDF read from a file and kept with the model, never part of the ontology.
 */
export interface DataGraph {
  source: 'model' | 'graph';
  /** For a data graph: its id, its name, and the fingerprint of its content. */
  id?: string;
  name?: string;
  fingerprint?: string;
  /** For a data graph, in a query: its content, as Turtle; absent when it is not in this browser. A report leaves it out. */
  text?: string;
  /** For a data graph read from Turtle: the text is the file's own, so findings can say on which line of it their focus node is. */
  lines?: boolean;
  /** For a data graph: also give the engine the ontology's triples, so that subclasses count. */
  includeOntology: boolean;
}

export const MODEL_DATA: DataGraph = { source: 'model', includeOntology: true };

/** Whether two data graphs are the same data: the model's own, or one graph with the same content, taken the same way. */
export const sameData = (a: DataGraph, b: DataGraph): boolean => a === b || (a.source === b.source && (a.source === 'model' || (a.id === b.id && a.fingerprint === b.fingerprint && a.includeOntology === b.includeOntology)));

/** A data graph as a report tells of it: without its content. */
export const describedData = ({ text: _text, ...data }: DataGraph): DataGraph => data;

/** What a quick fix does, in words: a label, and exactly what would change. */
export interface Fix {
  label: string;
  preview: string;
}

export const CATEGORIES: Category[] = ['owl', 'shacl', 'quality'];

/** Which checks to run: one category, or all of them. */
export type Scope = 'all' | Category;

/** What a validation job found about one revision. */
export interface ValidationReport extends OntologyRef {
  at: number;
  /** A fingerprint of the model validated: the ontology as RDF, the shapes and the rule settings. The data graph and shape set are said apart. */
  fingerprint: string;
  data: DataGraph;
  /** The shape set SHACL validated with; every set when absent. */
  shapeSet?: string;
  entities: number;
  owl?: OwlSummary;
  shacl?: ShaclSummary;
  quality?: QualitySummary;
  findings: Finding[];
  /** What the OWL 2 DL reasoner answered, when the run asked it. */
  dl?: { report: DlReport };
}

export interface ValidationQuery extends OntologyRef {
  categories: Category[];
  /** The data graph SHACL validates. */
  data: DataGraph;
  /** The shape set SHACL validates with, by its id; every set when absent. */
  shapeSet?: string;
  /** Which reasoner answers the OWL questions. */
  engine: EngineId;
  /** The OWL checks reason over the ontology together with the ones it imports, as far as they are to hand. */
  imports?: boolean;
  /** An earlier report of the same revision and data, whose other categories are kept as they were. */
  previous?: ValidationReport;
}

export interface ValidationJob extends OntologyRef {
  job: string;
  categories: Category[];
  state: JobState;
  /** What it is doing, in words, while it runs. */
  phase: string;
  error?: string;
}

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. The job itself goes on: `cancel` stops it. */
  signal?: AbortSignal;
}

export interface ValidationService {
  start(query: ValidationQuery, options?: CallOptions): Promise<ValidationJob>;
  status(job: string, options?: CallOptions): Promise<ValidationJob>;
  cancel(job: string): Promise<ValidationJob>;
  /** What a job found, once it has finished; refused when it failed or was cancelled. */
  report(job: string, options?: CallOptions): Promise<ValidationReport>;
}

/** As for reasoning: stale-revision, not-found, cancelled, failed, aborted. */
export type ValidationErrorCode = 'stale-revision' | 'not-found' | 'cancelled' | 'failed' | 'aborted';

export class ValidationError extends Error {
  constructor(
    readonly code: ValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
