/**
 * What the canvas and the subgraph panel ask when they show a part of the model around a few
 * chosen terms, and what they are answered with.
 *
 * This is the whole of what a view knows about how a subgraph is found. Today the answers come
 * from the model in the editor (local.ts); a backend answers the same questions by implementing
 * `GraphService`, one request for each method, doing the walking over the ontology where it is.
 * So that this stays possible:
 *
 *   - A question says everything it wants: where to start, how far to go, in which direction,
 *     through which kinds of relationship, and what to leave out. Nothing is narrowed afterwards
 *     by whoever asked.
 *   - Every answer is plain data: no maps, sets, functions or class instances, so that a question
 *     and its answer can travel as JSON. What a view puts where on its canvas is its own business
 *     and is never asked for.
 *   - Every question names the ontology and the revision of it that is meant, is asynchronous
 *     and can be given up.
 *
 * Nothing here changes an ontology: every question is a reading of it.
 */

/** One revision of one ontology (the same thing the other services' questions name). */
export interface OntologyRef {
  ontologyId: string;
  revisionId: string;
}

/** Which way from the chosen terms to walk. */
export type Direction = 'both' | 'out' | 'in';

/** How many steps out a subgraph may be asked to go, and the default limit on how many terms it may show. */
export const MAX_DEPTH = 6;
export const DEFAULT_MAX_NODES = 250;
/** The most terms a subgraph may be asked to show. */
export const MAX_NODES = 5000;

export interface NeighbourhoodQuery extends OntologyRef {
  /** The terms the subgraph grows from. Terms that are not in the ontology are left out. */
  roots: string[];
  /** How many steps out from the roots: 0 shows the roots alone. */
  depth: number;
  direction: Direction;
  /** Relationship types that are switched off (see `Kind`). */
  off?: string[];
  /** Terms whose direct neighbours are shown whatever the depth. */
  expanded?: string[];
  /** Terms taken out of the view by hand. */
  hidden?: string[];
  /** Upper limit on the number of terms shown, so that a huge subgraph is cut off rather than drawn. */
  maxNodes?: number;
}

/** Which terms are visible, and what brought each one in. */
export interface Neighbourhood extends OntologyRef {
  /** Visible term keys, roots first, then in the order they were reached. */
  terms: string[];
  /** Keys of the relationships between visible terms. */
  rels: string[];
  /** For each visible term that is not a root: the visible term it was reached from. */
  via: Record<string, string>;
  /** For each visible term: how many of its neighbours (by the filters given) are not shown. */
  more: Record<string, number>;
  /** The limit on terms was reached, so the subgraph is incomplete. */
  truncated: boolean;
}

export interface GraphSearchQuery extends OntologyRef {
  /** Text found in a term's name, other names or IRI, whatever the case. */
  text: string;
  /** The most matches to answer with; left out, the service decides. */
  limit?: number;
  /** The language names are shown in, where a term has several. */
  lang?: string;
}

/** A term a search found, as much of it as choosing it needs. */
export interface TermMatch {
  id: string;
  name: string;
  /** 'concept', 'property' or 'instance', in the model's own terms. */
  type: string;
}

export interface GraphSearchAnswer extends OntologyRef {
  /** The best matches first. */
  matches: TermMatch[];
}

/** A kind of relationship there is in the ontology, to switch on or off. */
export interface GraphKind {
  key: string;
  label: string;
  /** How many relationships are of the kind. */
  count: number;
}

export interface GraphKindsAnswer extends OntologyRef {
  /** The kinds present in the ontology, in the order the panel offers them. */
  kinds: GraphKind[];
}

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. */
  signal?: AbortSignal;
}

/** The questions the canvas and the subgraph panel ask. */
export interface GraphService {
  /** The terms within some steps of the chosen ones, and the relationships between them. */
  neighbourhood(query: NeighbourhoodQuery, options?: CallOptions): Promise<Neighbourhood>;
  /** Terms to start a subgraph from, by what they are called. */
  search(query: GraphSearchQuery, options?: CallOptions): Promise<GraphSearchAnswer>;
  /** The kinds of relationship there are to follow or leave out. */
  kinds(query: OntologyRef, options?: CallOptions): Promise<GraphKindsAnswer>;
}

/**
 * stale-revision: the ontology has moved on from the revision asked about. invalid: the question
 * makes no sense (a direction that is none of the three). aborted: it was given up.
 */
export type GraphErrorCode = 'stale-revision' | 'invalid' | 'aborted';

/** Why a question was not answered. Over a wire it is its code and its message. */
export class GraphError extends Error {
  constructor(
    readonly code: GraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}
