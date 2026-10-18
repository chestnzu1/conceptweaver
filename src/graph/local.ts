import { stable } from '../model/stable';
import { edgeTypes, extractSubgraph, searchTerms } from '../model/subgraph';
import type { Model } from '../model/types';
import { ontologyRef } from '../structure/local';
import type { GraphService } from './contracts';
import { createNeighbourhoodService } from './service';

/**
 * The graph service over the model in the editor: the subgraph walk, the search for terms to
 * start from, and the kinds of relationship to follow, read off the model as it is when each
 * question is asked. This is the one place where the subgraph questions read the app's own
 * model; the questions themselves (service.ts) know nothing of it.
 */
export function createLocalGraphService(current: () => { model: Model; docId: string | null }): GraphService {
  return createNeighbourhoodService(() => {
    const { model, docId } = current();
    // Two models that differ only in where their terms sit are the same revision, and the same graph.
    const m = stable(model);
    return {
      ...ontologyRef(model, docId),
      neighbourhood: (query) => {
        const found = extractSubgraph(m, query);
        return { terms: found.terms, rels: found.rels, via: Object.fromEntries(found.via), more: Object.fromEntries(found.more), truncated: found.truncated };
      },
      search: (query) => ({ matches: searchTerms(m, query.text, query.limit, query.lang) }),
      kinds: () => ({ kinds: edgeTypes(m) }),
    };
  });
}
