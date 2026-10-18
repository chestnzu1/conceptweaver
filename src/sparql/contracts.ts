/**
 * What the SPARQL view asks, and what it is answered with (FR-M9-4).
 *
 * A query is put against one of three graphs: the ontology as it is stated, the ontology together
 * with the ones it imports, or that graph with the statements a reasoner entails from it. Every
 * answer says which graph it was read from, so that the view can say so too, and carries the
 * revision it is about, as the other services' answers do.
 *
 * Nothing here knows how the query is run or where the graph comes from. Today the local service
 * (local.ts) runs it over the model in the editor; a backend answers the same question by
 * implementing `SparqlService`, with SPARQL over the ontology where it lives.
 *
 * This file imports nothing, as the other services' contracts do. The shapes of a result are
 * stated again from src/model/sparql.ts, which cannot be imported from here without taking the
 * model with it; the two are kept the same by their tests.
 */

/** One revision of one ontology (the same thing the other services' questions name). */
export interface OntologyRef {
  ontologyId: string;
  revisionId: string;
}

/** Which graph a query reads. */
export type SparqlGraph = 'asserted' | 'imports' | 'inferred';

/** The graphs there are, in the order the view offers them. */
export const GRAPHS: SparqlGraph[] = ['asserted', 'imports', 'inferred'];

/** The graph a query reads when it does not say. */
export const DEFAULT_GRAPH: SparqlGraph = 'asserted';

export interface SparqlCell {
  kind: 'iri' | 'literal' | 'bnode';
  /** Full IRI, literal text, or blank node label. */
  value: string;
  /** How it is displayed: IRIs shortened to prefixed names. */
  text: string;
  lang?: string;
}

export type SparqlResult =
  | { type: 'select'; vars: string[]; rows: (SparqlCell | null)[][] }
  | { type: 'ask'; value: boolean }
  /** CONSTRUCT / DESCRIBE: one row per triple. */
  | { type: 'graph'; vars: string[]; rows: (SparqlCell | null)[][] };

export interface SparqlQuery extends OntologyRef {
  /** A SELECT, ASK, CONSTRUCT or DESCRIBE query. */
  text: string;
  /** What it reads; `asserted` when not given. */
  graph?: SparqlGraph;
}

/** An ontology the query's graph depends on whose content is not here, so it was left out. */
export interface MissingImport {
  id: string;
  name: string;
  iri?: string;
}

export interface SparqlAnswer extends OntologyRef {
  /** The graph the query was actually read from. */
  graph: SparqlGraph;
  result: SparqlResult;
  /** What is worth saying about how the answer was come by: what was missing, how far the reasoning went. */
  notes: string[];
  /** Ontologies left out of the graph because their content is not here. */
  missing?: MissingImport[];
}

export interface CallOptions {
  /** Gives the question up: the answer is no longer wanted. */
  signal?: AbortSignal;
}

/** The one question the SPARQL view puts. */
export interface SparqlService {
  /** Runs a read-only query over the chosen graph of the chosen revision. */
  query(query: SparqlQuery, options?: CallOptions): Promise<SparqlAnswer>;
}

/**
 * stale-revision: the ontology has moved on from the revision asked about. invalid: the query is
 * not one that can be run here (not a read-only query, or not readable). unsupported: nothing is
 * inferred for this type of model. inconsistent: a reasoner found a contradiction, and from one
 * everything follows, so nothing is answered as inferred. aborted: it was given up.
 */
export type SparqlErrorCode = 'stale-revision' | 'invalid' | 'unsupported' | 'inconsistent' | 'aborted';

/** Why a query was not answered. Over a wire it is its code and its message. */
export class SparqlError extends Error {
  constructor(
    readonly code: SparqlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SparqlError';
  }
}
