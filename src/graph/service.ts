import { DEFAULT_MAX_NODES, GraphError, MAX_DEPTH, MAX_NODES, type CallOptions, type Direction, type GraphKindsAnswer, type GraphSearchAnswer, type GraphSearchQuery, type GraphService, type Neighbourhood, type NeighbourhoodQuery, type OntologyRef } from './contracts';

/**
 * The questions themselves: checking the revision asked about, putting the answer in the terms
 * the question is in, and refusing what cannot be answered. Where the terms, relationships and
 * kinds come from is not known here. The model in the editor gives them today (local.ts);
 * anything else that can give them, or answer the questions outright, takes its place.
 */

/** A subgraph as a source answers it: plain data, without the revision it is answered for. */
export type NeighbourhoodData = Omit<Neighbourhood, 'ontologyId' | 'revisionId'>;
export type SearchData = Pick<GraphSearchAnswer, 'matches'>;
export type KindsData = Pick<GraphKindsAnswer, 'kinds'>;

/** The question as a source is given it, with everything filled in and clamped. */
export type NeighbourhoodPlan = Omit<NeighbourhoodQuery, 'ontologyId' | 'revisionId' | 'off' | 'expanded' | 'hidden' | 'maxNodes'> & {
  off: string[];
  expanded: string[];
  hidden: string[];
  maxNodes: number;
};
export type SearchPlan = Omit<GraphSearchQuery, 'ontologyId' | 'revisionId' | 'limit' | 'lang'> & { limit: number; lang: string };

export interface GraphSource extends OntologyRef {
  neighbourhood(query: NeighbourhoodPlan): NeighbourhoodData;
  search(query: SearchPlan): SearchData;
  kinds(query: OntologyRef): KindsData;
}

/** How many matches a search gives when nothing is asked for, and at most. */
export const SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 50;

const DIRECTIONS: Direction[] = ['both', 'out', 'in'];
const whole = (n: number | undefined, otherwise: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : otherwise);

/**
 * The service over a source of subgraphs. `current` gives the source for the ontology as it is
 * now, when each question is asked: a question about a revision it has left is refused, not
 * answered from what is there.
 */
export function createNeighbourhoodService(current: () => GraphSource): GraphService {
  const at = (query: OntologyRef, options?: CallOptions): GraphSource => {
    if (options?.signal?.aborted) throw new GraphError('aborted', 'The question was given up.');
    const now = current();
    if (query.ontologyId !== now.ontologyId || query.revisionId !== now.revisionId) throw new GraphError('stale-revision', 'The ontology has changed since this was asked about.');
    return now;
  };
  return {
    async neighbourhood(query, options): Promise<Neighbourhood> {
      const source = at(query, options);
      if (!DIRECTIONS.includes(query.direction)) throw new GraphError('invalid', `“${String(query.direction)}” is not a direction: it is both, out or in.`);
      const plan: NeighbourhoodPlan = {
        roots: [...new Set(query.roots ?? [])],
        // 0 is a depth like any other: the roots alone.
        depth: Math.max(0, Math.min(MAX_DEPTH, whole(query.depth, 1))),
        direction: query.direction,
        off: query.off ?? [],
        expanded: query.expanded ?? [],
        hidden: query.hidden ?? [],
        maxNodes: Math.max(1, Math.min(MAX_NODES, whole(query.maxNodes, DEFAULT_MAX_NODES) || DEFAULT_MAX_NODES)),
      };
      return { ontologyId: source.ontologyId, revisionId: source.revisionId, ...source.neighbourhood(plan) };
    },

    async search(query, options): Promise<GraphSearchAnswer> {
      const source = at(query, options);
      const plan: SearchPlan = { text: query.text ?? '', limit: Math.max(1, Math.min(MAX_SEARCH_LIMIT, whole(query.limit, SEARCH_LIMIT) || SEARCH_LIMIT)), lang: query.lang ?? '' };
      return { ontologyId: source.ontologyId, revisionId: source.revisionId, ...source.search(plan) };
    },

    async kinds(query, options): Promise<GraphKindsAnswer> {
      const source = at(query, options);
      return { ontologyId: source.ontologyId, revisionId: source.revisionId, ...source.kinds(query) };
    },
  };
}
