/**
 * What the Structure Explorer asks about an ontology, and what it is answered with.
 *
 * This is the whole of what the explorer's views know about where an ontology lives. Today the
 * answers come from the model in the editor (local.ts); a semantic backend (OWL API, a SPARQL
 * endpoint, a triple store) answers the same questions by implementing `StructureService`, one
 * request for each method. So that this stays possible:
 *
 *   - Entities are named by IRI and by nothing else. A label is for showing, never for finding.
 *   - Every question names the ontology and the revision of it that is meant, and every answer
 *     says which revision it is of.
 *   - Everything is plain data: no maps, sets, functions or class instances, so that an answer
 *     can travel as JSON.
 *   - Every question is asynchronous and can be given up, and a list is answered a page at a
 *     time: nothing here assumes the whole ontology is in the browser.
 *   - Whatever is inferred says which reasoner it is from, of which revision, and how far that
 *     reasoner's answer goes.
 */

export type Iri = string;

/** One revision of one ontology. A revision is what the ontology says; moving terms about on a canvas does not make a new one. */
export interface OntologyRef {
  ontologyId: string;
  revisionId: string;
}

/**
 * asserted: the subclass relationships that are stated, and no others.
 * inferred: the hierarchy a reasoner works out, each class under the classes directly above it.
 */
export type HierarchyMode = 'asserted' | 'inferred';

/** A named class. In a concept scheme, a concept. */
export interface ClassRef {
  iri: Iri;
  /** What to show it as. Two classes can have the same label; they are told apart by IRI. */
  label: string;
  /** Defined in another ontology and only referred to in this one. */
  external?: boolean;
  /** A class of OWL itself, which no ontology defines: owl:Nothing, which the unsatisfiable classes are listed under. */
  builtin?: boolean;
}

export const OWL_NOTHING: Iri = 'http://www.w3.org/2002/07/owl#Nothing';

export interface ReasonerRef {
  id: string;
  name: string;
  version?: string;
}

/** Where an answer comes from, and how far it can be relied on. */
export interface Provenance {
  /** The reasoner the answer is from. None: only what is asserted was read. */
  engine: ReasonerRef | null;
  /** The revision that was reasoned over, or read. */
  revisionId: string;
  /**
   * current: of the revision that was asked about. stale: of an earlier one. unavailable: the
   * reasoner has not been asked. failed: it gave no answer. inconsistent: the ontology
   * contradicts itself, so nothing reliable follows from it.
   */
  status: 'current' | 'stale' | 'unavailable' | 'failed' | 'inconsistent';
  /** incomplete: there may be more than this answer has, because the reasoner is not a complete one or left something out. */
  completeness: 'complete' | 'incomplete';
  /** What was left out or taken loosely, in words. */
  notes: string[];
}

export interface HierarchyQuery extends OntologyRef {
  mode: HierarchyMode;
  /** The class whose direct subclasses are asked for. Left out: the classes at the top (directly under owl:Thing). */
  parentIri?: Iri;
  /** How many to answer with. Left out, the service decides; it may also give fewer than were asked for. */
  limit?: number;
  /** Where to go on from: the `nextCursor` of a page. */
  cursor?: string;
  /**
   * Answer with the page that holds this subclass rather than with the first one, so that a class
   * far down a long list is reached without fetching all that comes before it.
   */
  through?: Iri;
  /**
   * Text to narrow the hierarchy to: only the classes whose label, other labels or IRI contain
   * it are counted and listed, together with the classes that lead down to one.
   */
  filter?: string;
}

/**
 * The same question for several classes at once: the first page of the direct subclasses of
 * each. A hierarchy with many branches open is brought up to date, or opened a level further,
 * in one exchange and not in one for each branch.
 */
export interface BranchesQuery extends OntologyRef {
  mode: HierarchyMode;
  filter?: string;
  /** What to ask for each: as in a HierarchyQuery, without a cursor. A service may refuse more than it cares to answer at once. */
  parents: Pick<HierarchyQuery, 'parentIri' | 'limit' | 'through'>[];
}

/** A class as it stands in the hierarchy. It is one class however many places it is listed in. */
export interface HierarchyNode {
  class: ClassRef;
  /**
   * Classes that are equivalent to it: stated to be, in the asserted hierarchy, where each is
   * still listed in its own right; entailed to be, in the inferred one, where they share this
   * place and `class` is the one of them that speaks for all.
   */
  equivalents: ClassRef[];
  /** How many direct subclasses it has; with a filter, how many of them the filter leaves. */
  childCount: number;
  /** How many classes it is directly under. More than one: it is listed under each of them. */
  parentCount: number;
  /** It is one of a group of classes that are each other's superclasses. Only in the asserted hierarchy: in the inferred one such classes are equivalent. */
  inCycle?: boolean;
  /** With a filter: this class is one the filter found, not only on the way to one. */
  match?: boolean;
  /** In the inferred hierarchy: its place under the parent that was asked about is entailed and nowhere stated. */
  entailedOnly?: boolean;
  /** In the inferred hierarchy: it can never have an instance. Such classes are listed under owl:Nothing and nowhere else. */
  unsatisfiable?: boolean;
}

export interface HierarchyPage extends OntologyRef {
  mode: HierarchyMode;
  parentIri?: Iri;
  /** In order of label. */
  nodes: HierarchyNode[];
  /** Where in the whole list this page starts: 0 for the first. */
  offset: number;
  /** How many there are in all under this parent, on this page or not. */
  total: number;
  /** Present when there are more: what to ask the next page with. */
  nextCursor?: string;
  /** With a filter: how many classes of the whole hierarchy it finds. */
  matched?: number;
  provenance: Provenance;
}

export interface PathQuery extends OntologyRef {
  mode: HierarchyMode;
  classIri: Iri;
  /** How many ways down to give at most. */
  limit?: number;
}

export interface PathResult extends OntologyRef {
  mode: HierarchyMode;
  /**
   * Each a way down the hierarchy to the class: from a class at the top to the class itself, as
   * each is listed there. Shortest first. None, where there is no hierarchy to answer from.
   */
  paths: ClassRef[][];
  /** There may be more ways than these. */
  truncated: boolean;
  provenance: Provenance;
}

export interface SummaryQuery extends OntologyRef {
  classIri: Iri;
  /** The hierarchy its place is to be given in. */
  mode: HierarchyMode;
}

/** Where a class stands in one hierarchy. owl:Thing is level 0, and the classes at the top are level 1. */
export interface HierarchyPosition {
  mode: HierarchyMode;
  /** Its direct superclasses in this hierarchy, and its direct subclasses. */
  superclasses: number;
  subclasses: number;
  /** Every named class below it, by any way down, each counted once. */
  descendants: number;
  /**
   * The fewest and the most levels it is below owl:Thing. They differ where it is reached by ways
   * of different length. Classes that are each other's superclasses count as one level.
   */
  depth: { min: number; max: number };
  /** Every class above it, by any way up: the classes its lines in the hierarchy are under. */
  ancestors: Iri[];
  inCycle: boolean;
  provenance: Provenance;
}

/**
 * The structure of one class at a glance: what is stated of its place in the hierarchy, what a
 * reasoner adds, and how far down and how wide it reaches. What is asserted and what is entailed
 * are kept apart, and the entailed part says which reasoner it is from.
 */
export interface ClassSummary extends OntologyRef {
  class: ClassRef;
  asserted: {
    /** The named classes it is stated to be a subclass of. */
    superclasses: ClassRef[];
    /** How many class expressions without a name it is also stated to be a subclass of. They are not classes in the hierarchy. */
    anonymousSuperclasses: number;
    /** The named classes it is stated to be equivalent to. */
    equivalents: ClassRef[];
  };
  inferred: {
    /** Which reasoner, of which revision, and whether it has an answer at all. The rest is there only when it is current. */
    provenance: Provenance;
    /** The classes directly above it in the inferred hierarchy; `stated` where that is asserted as well. */
    superclasses?: { class: ClassRef; stated: boolean }[];
    /** The classes it is entailed to be equivalent to. */
    equivalents?: ClassRef[];
    unsatisfiable?: boolean;
  };
  /** Its place in the hierarchy that was asked about. Absent where that hierarchy is not to be had. */
  position?: HierarchyPosition;
}

export interface ClassSearchQuery extends OntologyRef {
  /** Text a class is found by: part of its label, of another of its labels, or of its IRI. */
  text: string;
  limit?: number;
}

export interface ClassSearchResult extends OntologyRef {
  /** The best matches first: a label that is the text, then one that starts with it, then one that has it, then the rest. */
  matches: ClassRef[];
  /** How many classes match in all. */
  total: number;
}

// ---------------------------------------------------------------- comparing two classes

/** A property a restriction is on. Told apart by IRI, like everything else. */
export interface PropertyRef {
  iri: Iri;
  label: string;
  /** Whether its values are individuals (an object property) or literals (a data property). */
  type: 'object' | 'data';
}

/** What the values of a restriction belong to: a named class, or a datatype. */
export interface FillerRef {
  /** Of a class, its IRI. A datatype is known by its name. */
  iri?: Iri;
  label: string;
  kind: 'class' | 'datatype';
}

export type Quantifier = 'some' | 'only' | 'min' | 'max' | 'exactly';

/**
 * Something asserted of a class beyond its named superclasses. A restriction is read: which
 * property, how many, of what. A class expression that is kept as it was written (an
 * intersection, a nested restriction, an enumeration) is compared as text and not interpreted.
 */
export type ClassAxiom =
  | { kind: 'restriction'; key: string; property: PropertyRef; quantifier: Quantifier; n?: number; filler: FillerRef; text: string }
  | { kind: 'expression'; key: string; relation: 'subClassOf' | 'equivalentClass' | 'disjointWith'; text: string };

/**
 * How something is known. asserted: it is stated outright. asserted-chain: it follows from
 * stated subclass links alone, one after another. entailed: the reasoner named in the
 * comparison's provenance says so, and the stated links alone do not.
 */
export type Basis = 'asserted' | 'asserted-chain' | 'entailed';

/** How an axiom stands to one of the two classes. */
export interface AxiomStanding {
  /** own: asserted on the class itself. inherited: asserted on a class above it, or on one equivalent to it, and so true of it as well. */
  state: 'own' | 'inherited' | 'absent';
  /** For an inherited axiom: each class it is asserted on, and how the class comes to be under it. */
  from?: { class: ClassRef; basis: Basis }[];
}

/** One axiom implies another: whatever meets the first meets the second. */
export interface AxiomRelation {
  /** stronger: this axiom implies the other. equivalent: each implies the other. */
  kind: 'stronger' | 'equivalent';
  /** The key of the other axiom. */
  than: string;
  /**
   * The subclass relationships between their fillers that this rests on, each with how it is
   * known. None, where the two have the same filler and differ only in how many.
   */
  evidence: { sub: ClassRef; sup: ClassRef; basis: Basis }[];
}

export interface ComparedAxiom {
  axiom: ClassAxiom;
  a: AxiomStanding;
  b: AxiomStanding;
  /** What this axiom is established to imply among the other axioms listed. Never said of two that only look alike. */
  relations: AxiomRelation[];
  /**
   * Keys of axioms on the same property that this one would imply if its filler were a subclass
   * of theirs, where that could not be checked because no reasoner's answer is to be had.
   */
  unverified: string[];
}

/** How a class that is above one of the two stands to each of them. */
export interface ComparedSuperclass {
  class: ClassRef;
  /** A basis, or: self, the class is that one of the two; absent, it is not above it. */
  a: Basis | 'self' | 'absent';
  b: Basis | 'self' | 'absent';
}

export interface ClassRelationship {
  /**
   * same: one class was given twice. equivalent: each is a subclass of the other. a-below-b,
   * b-below-a: one is a subclass of the other and not the reverse, as far as is known.
   * siblings: neither, and they share a direct superclass. unrelated: none of these.
   */
  kind: 'same' | 'equivalent' | 'a-below-b' | 'b-below-a' | 'siblings' | 'unrelated';
  /** How that is known. Absent for siblings and unrelated, which say what is not known to hold. */
  basis?: Basis;
  /** For one below the other through stated links: the classes from the upper one down to the lower one. */
  chain?: ClassRef[];
  /** For siblings, the direct superclasses they share; for unrelated classes, the nearest classes that are above both. */
  shared: ClassRef[];
  /**
   * Whether a reasoner's current answer was consulted. When not, only what is stated was read:
   * more may hold between the two than is said here.
   */
  verified: boolean;
}

/** The two classes can share no instance. */
export interface Disjointness {
  /** asserted: the two are stated to be disjoint. Otherwise it follows from a stated disjointness further up. */
  basis: 'asserted' | 'follows';
  /** The two classes that are stated to be disjoint: the two themselves, or a class above each. */
  between: { a: ClassRef; b: ClassRef };
  /** How each of the two comes to be under its one. Absent where it is that class. */
  aBasis?: Basis;
  bBasis?: Basis;
}

export interface ComparisonQuery extends OntologyRef {
  classAIri: Iri;
  classBIri: Iri;
}

/**
 * Two classes side by side. What is asserted, what is inherited, what a reasoner establishes
 * and what could not be checked are four different things here, each under its own name.
 */
export interface ClassComparison extends OntologyRef {
  a: ClassRef;
  b: ClassRef;
  relationship: ClassRelationship;
  /** Present when the two are disjoint, by statement or by what is stated above them. */
  disjointness?: Disjointness;
  /** Whether a reasoner finds either of them unsatisfiable. Absent without a current answer. */
  unsatisfiable?: { a: boolean; b: boolean };
  /** Every class above either of them: first the ones above both. */
  superclasses: ComparedSuperclass[];
  /** The classes each is stated to be equivalent to and disjoint with. */
  stated: { a: { equivalents: ClassRef[]; disjoints: ClassRef[] }; b: { equivalents: ClassRef[]; disjoints: ClassRef[] } };
  /** Every restriction and kept class expression that is asserted on, or inherited by, either of them. */
  axioms: ComparedAxiom[];
  counts: { shared: number; onlyA: number; onlyB: number; ownA: number; ownB: number; inheritedA: number; inheritedB: number };
  /** The reasoner whose answer was used for whatever is marked as entailed, or why there is none. */
  reasoning: Provenance;
  /** What was not compared or not interpreted, in words. */
  notes: string[];
}

export interface ExplanationQuery extends OntologyRef {
  subClassIri: Iri;
  superClassIri: Iri;
}

/**
 * Why one class is a subclass of another. The statements are asserted axioms that are enough
 * for it: the stated links of a chain, or what the reasoner itself gives as its grounds.
 * Nothing is composed to look like an explanation: where there is none, `available` is false
 * and `reason` says why.
 */
export interface SubclassExplanation extends OntologyRef {
  sub: ClassRef;
  sup: ClassRef;
  available: boolean;
  /** asserted-chain: the statements are the links of the chain. entailed: they are the reasoner's own. */
  basis?: Basis;
  statements: string[];
  reason?: string;
  provenance: Provenance;
}

// ---------------------------------------------------------------- measuring the hierarchy as a whole

/**
 * The numbers a hierarchy is summed up in. Each is of the hierarchy that was asked about,
 * except the two that say so. A number that is not to be had is null, never 0.
 *
 *   classes              named classes.
 *   top                  classes with nothing above them in this hierarchy (directly under owl:Thing).
 *   leaves               classes with nothing below them.
 *   maxDepth             the deepest level any class is on. owl:Thing is level 0.
 *   averageDepth         the mean, over the classes, of the deepest level each is on.
 *   multipleInheritance  classes with more than one direct superclass.
 *   noStatedSuperclass   classes with no named superclass stated for them, whichever hierarchy was asked about.
 *   equivalenceGroups    groups of classes that are equivalent: stated to be, or in the inferred hierarchy entailed to be.
 *   unsatisfiable        classes a reasoner finds can have no instance. Null without a current answer.
 *   inCycles             classes that are stated, one after another, to be each other's superclasses.
 */
export type StructureMetric = 'classes' | 'top' | 'leaves' | 'maxDepth' | 'averageDepth' | 'multipleInheritance' | 'noStatedSuperclass' | 'equivalenceGroups' | 'unsatisfiable' | 'inCycles';

/** How many classes have a number (their level, how many subclasses, how many superclasses) in one range. */
export interface AnalysisBucket {
  from: number;
  /** The last number of the range. Null: this one and everything above it. */
  to: number | null;
  count: number;
  /** What to ask for the classes themselves by. */
  set: string;
}

/** One class at the top with what is under it. */
export interface AnalysisBranch {
  class: ClassRef;
  /** How many named classes the branch holds, the top one among them. */
  classes: number;
  /** How many levels it goes down below its top class. */
  depth: number;
  set: string;
}

/**
 * Something about the structure that is worth a look. None of these says the ontology is wrong:
 * several superclasses, a wide class and a deep branch are all valid OWL. Only an unsatisfiable
 * class is a finding of a reasoner, and it says which.
 */
export interface AnalysisFinding {
  kind: 'unsatisfiable' | 'cycle' | 'redundant-superclass' | 'multiple-inheritance' | 'wide' | 'deep' | 'connected';
  /** How many: classes, or for cycles the groups, or for redundant superclasses the statements. */
  count: number;
  /** For the kinds that are "unusually" something: the number a class has to be above to count. */
  above?: number;
  /** A few of them. */
  examples: ClassRef[];
  set: string;
}

export interface AnalysisQuery extends OntologyRef {
  mode: HierarchyMode;
}

export interface StructureAnalysis extends OntologyRef {
  mode: HierarchyMode;
  metrics: Record<StructureMetric, number | null>;
  /** For the numbers that count classes: what to ask for those classes by. */
  sets: Partial<Record<StructureMetric, string>>;
  /** Classes by the deepest level each is on. */
  depth: AnalysisBucket[];
  /** Classes by how many direct subclasses each has. */
  subclasses: AnalysisBucket[];
  /** Classes by how many direct superclasses each has. */
  superclasses: AnalysisBucket[];
  /** The largest branches, largest first, and what the rest come to together. */
  branches: { largest: AnalysisBranch[]; others: { branches: number; classes: number } | null };
  findings: AnalysisFinding[];
  /** The longest ways down, each from a class at the top to a leaf. */
  deepest: ClassRef[][];
  /** Where the hierarchy that was measured comes from. Not "current": there was none to measure, and every number is null. */
  provenance: Provenance;
  /** The reasoner the number of unsatisfiable classes is from, or why there is none. */
  reasoning: Provenance;
  warnings: string[];
}

export interface ClassSetQuery extends OntologyRef {
  mode: HierarchyMode;
  /** A set named by an analysis of the same hierarchy. */
  set: string;
  limit?: number;
  cursor?: string;
}

export interface ClassSetItem {
  class: ClassRef;
  /** The number that put it in the set: its level, how many subclasses it has, and so on. */
  value?: number;
  /** Other classes it is in the set with: the rest of its cycle, the superclass that is redundant, its equivalents. */
  related?: ClassRef[];
}

export interface ClassSetPage extends OntologyRef {
  mode: HierarchyMode;
  set: string;
  items: ClassSetItem[];
  offset: number;
  total: number;
  nextCursor?: string;
}

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. */
  signal?: AbortSignal;
}

export interface AnalysisOptions extends CallOptions {
  /** Told how far the measuring has got, from 0 to 1, while it goes on. */
  onProgress?: (fraction: number) => void;
}

/** The questions the Structure Explorer asks. */
export interface StructureService {
  /** The direct subclasses of a class, or the classes at the top, a page at a time. */
  children(query: HierarchyQuery, options?: CallOptions): Promise<HierarchyPage>;
  /** The same for several classes in one question: a page for each, in the order they were asked for. */
  branches(query: BranchesQuery, options?: CallOptions): Promise<HierarchyPage[]>;
  /** The ways down the hierarchy to a class. */
  paths(query: PathQuery, options?: CallOptions): Promise<PathResult>;
  /** The structure of one class at a glance. */
  summary(query: SummaryQuery, options?: CallOptions): Promise<ClassSummary>;
  /** The classes a text finds, best first. */
  search(query: ClassSearchQuery, options?: CallOptions): Promise<ClassSearchResult>;
  /** Two classes side by side: how they stand to each other, and what is asserted of and inherited by each. */
  compare(query: ComparisonQuery, options?: CallOptions): Promise<ClassComparison>;
  /** Why one class is a subclass of another, where a justification is to be had. Asked for only when someone wants to see it. */
  explain(query: ExplanationQuery, options?: CallOptions): Promise<SubclassExplanation>;
  /** The hierarchy as a whole in numbers. It can take a while for a large ontology: it reports how far it has got and can be given up. */
  analyze(query: AnalysisQuery, options?: AnalysisOptions): Promise<StructureAnalysis>;
  /** The classes behind one of an analysis's numbers, a page at a time. */
  members(query: ClassSetQuery, options?: CallOptions): Promise<ClassSetPage>;
}

/**
 * stale-revision: the ontology has moved on from the revision asked about. not-found: there is
 * no such class. unsupported: the service cannot answer this kind of question. invalid: the
 * question makes no sense. aborted: it was given up.
 */
export type StructureErrorCode = 'stale-revision' | 'not-found' | 'unsupported' | 'invalid' | 'aborted';

/** Why a question was not answered. Over a wire it is its code and its message. */
export class StructureError extends Error {
  constructor(
    readonly code: StructureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StructureError';
  }
}
