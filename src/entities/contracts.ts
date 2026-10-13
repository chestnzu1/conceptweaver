/**
 * What the Entities page asks when it searches, sorts and filters its tables, and what it is
 * answered with.
 *
 * This is the whole of what the page knows about how a list of entities is found. Today the
 * answers come from the model in the editor (local.ts); a backend answers the same questions by
 * implementing `EntityQueryService`, one request for each method, with the searching, the
 * sorting and the filtering done where the ontology is. So that this stays possible:
 *
 *   - A question says everything it wants: the kind of entity, the text, the order, the filters
 *     and which page. Nothing is narrowed or put in order afterwards by whoever asked.
 *   - An entity in an answer is a key, which the service chooses and nobody reads, with what is
 *     needed to show why it was found. What else a row shows is the page's own business.
 *   - The sorts and the filters there are for a kind of entity are themselves an answer
 *     (`describe`), so that the page offers what the service can do and nothing else.
 *   - Every question names the ontology and the revision of it that is meant, is asynchronous
 *     and can be given up, and a list is answered a page at a time.
 *   - Everything is plain data: no maps, sets, functions or class instances, so that a question
 *     and its answer can travel as JSON.
 *
 * Nothing here changes an ontology: every question is a reading of it.
 */

/** One revision of one ontology (the same thing the Structure Explorer's questions name). */
export interface OntologyRef {
  ontologyId: string;
  revisionId: string;
}

/**
 * The lists the Entities page has, each of one kind of thing. A relationship is a statement
 * between two entities, listed like one.
 */
export const LIST_KINDS = ['class', 'objectProperty', 'dataProperty', 'individual', 'relationship'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export interface EntitySort {
  /** One of the sorts the service describes for the kind. */
  by: string;
  dir: 'asc' | 'desc';
}

/**
 * The filters that are on: for each, by its id, the options chosen. A filter that is simply on
 * or off has the one option `ON`. A filter that is not named, or has nothing chosen, is off.
 */
export type FilterValues = Record<string, string[]>;
export const ON = 'yes';

export interface EntityQuery extends OntologyRef {
  kind: ListKind;
  /**
   * Text to find: each word of it has to occur somewhere in what the entity is searched by (its
   * name and other labels, its IRI with a prefix and in full, its definition), whatever the case.
   * A word is looked for in the full IRI only when it is written like part of one, with a ":",
   * "/", "#" or "." in it: otherwise "org" would find everything under example.org.
   */
  search?: string;
  /** Left out: the order the ontology has them in. Entities that are equal under a sort stay in that order. */
  sort?: EntitySort;
  filters?: FilterValues;
  /** Where the page starts among what was found. */
  offset?: number;
  /** How many to answer with. Left out, the service decides; it may also give fewer than were asked for. */
  limit?: number;
}

/** Where a search found its text. */
export type MatchField = 'name' | 'label' | 'iri' | 'curie' | 'description' | 'from' | 'to' | 'kind';

/** One of the texts an entity is searched by. */
export interface SearchText {
  field: MatchField;
  /** The annotation property the text is a value of, where it is one (skos:altLabel). */
  property?: string;
  text: string;
}

/** A text the words of a search were found in, whole, with where in it they are: each a start and an end, in order, none overlapping. */
export interface EntityMatch extends SearchText {
  ranges: [number, number][];
}

export interface EntityRow {
  /** What the service knows the entity by. It is given back to nothing but the service, and to whoever resolves it to the entity itself. */
  key: string;
  iri?: string;
  /** What to show it as where nothing else is at hand. */
  label: string;
  /** With a search: everywhere its words were found, the name first. */
  matches?: EntityMatch[];
}

export interface EntityPage {
  kind: ListKind;
  revisionId: string;
  rows: EntityRow[];
  offset: number;
  /** How many entities of the kind there are in all. */
  total: number;
  /** How many of them the search and the filters leave. */
  matched: number;
  /** The words that were looked for, as the service split the search: what to mark in a text that was found. */
  words: string[];
  /** Something to tell whoever asked, such as that a filter rests on a reasoner that may not have found everything. */
  notes: string[];
}

export interface EntitySortSpec {
  id: string;
  label: string;
  /** It counts something: the largest first is the order most often wanted. */
  numeric?: boolean;
}

export interface FilterOption {
  value: string;
  label: string;
  /** How many entities of the kind have it, where that is known without asking a reasoner. */
  count?: number;
}

export interface EntityFilterSpec {
  id: string;
  label: string;
  /** What it lets through, in a sentence. */
  about: string;
  /**
   * flag: on or off. one: at most one of the options. any: an entity that has any of the options
   * chosen. all: one that has every option chosen.
   */
  type: 'flag' | 'one' | 'any' | 'all';
  options: FilterOption[];
  /**
   * The options are entities, which may be many. They are not listed here: they are asked for
   * with `options`, narrowed by what is typed, and a chosen one is shown by resolving its key.
   */
  entities?: boolean;
  /** Why it cannot be answered now, when it cannot: there is no reasoner for this ontology, or it found a contradiction. */
  unavailable?: string;
}

export interface EntityDescription {
  kind: ListKind;
  revisionId: string;
  total: number;
  sorts: EntitySortSpec[];
  filters: EntityFilterSpec[];
}

export interface OptionsQuery extends OntologyRef {
  kind: ListKind;
  /** A filter of that kind whose options are entities. */
  filter: string;
  /** Text to narrow them by: words of the name or of the IRI. */
  search?: string;
  limit?: number;
}

export interface OptionsPage {
  /** The best matches first; without a search, the ones most entities have. */
  options: FilterOption[];
  /** How many there are to choose from in all, for the text given. */
  total: number;
}

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. */
  signal?: AbortSignal;
}

/** The questions the Entities page asks. */
export interface EntityQueryService {
  /** The sorts and the filters there are for a kind of entity, with what there is to choose from. */
  describe(query: OntologyRef & { kind: ListKind }, options?: CallOptions): Promise<EntityDescription>;
  /** The entities of a kind that a search and some filters leave, in an order, a page at a time. */
  query(query: EntityQuery, options?: CallOptions): Promise<EntityPage>;
  /** What there is to choose from for a filter whose options are entities. */
  options(query: OptionsQuery, options?: CallOptions): Promise<OptionsPage>;
}

/**
 * stale-revision: the ontology has moved on from the revision asked about. invalid: the
 * question makes no sense (a sort or a filter the kind does not have). aborted: it was given up.
 */
export type EntityQueryErrorCode = 'stale-revision' | 'invalid' | 'aborted';

/** Why a question was not answered. Over a wire it is its code and its message. */
export class EntityQueryError extends Error {
  constructor(
    readonly code: EntityQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntityQueryError';
  }
}
