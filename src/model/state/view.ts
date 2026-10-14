import type { GraphLayout } from '../../layout/types';
import { listMappings } from '../alignment';
import type { Model, Term } from '../types';
import type { SubgraphState } from './subgraph';

/**
 * What the canvas shows of the model: all of it, the part a scope keeps, or a subgraph. Worked
 * out from the document and the session, and kept by neither.
 */

/** Which part of the full graph the canvas draws: all of it, only this ontology's own entities, or only the mappings to other ontologies. */
export type GraphScope = 'all' | 'local' | 'alignment';

let viewCache: { model: Model; sub: SubgraphState; view: Model } | undefined;

let scopeCache: { model: Model; scope: GraphScope; view: Model } | undefined;

function scoped(model: Model, scope: GraphScope): Model {
  if (scope === 'all') return model;
  if (scopeCache && scopeCache.model === model && scopeCache.scope === scope) return scopeCache.view;
  let view: Model;
  if (scope === 'local') {
    const hidden = new Set(model.terms.filter((t) => t.external !== undefined).map((t) => t.id));
    view = hidden.size ? { ...model, terms: model.terms.filter((t) => !hidden.has(t.id)), relations: model.relations.filter((r) => !hidden.has(r.from) && !hidden.has(r.to)) } : model;
  } else {
    // The mappings and the entities at their ends, and nothing else.
    const rels = new Set(listMappings(model).flatMap((m) => m.rels));
    const kept = model.relations.filter((r) => rels.has(r.id));
    const ends = new Set(kept.flatMap((r) => [r.from, r.to]));
    view = { ...model, terms: model.terms.filter((t) => ends.has(t.id)), relations: kept };
  }
  scopeCache = { model, scope, view };
  return view;
}

/**
 * The model as the canvas should draw it: the model itself in full-graph mode, or in subgraph
 * mode a copy holding only the visible terms and relationships, placed by the subgraph's layout.
 */
export function viewOf(s: { model: Model; subgraph: SubgraphState; graphScope?: GraphScope }): Model {
  const { model, subgraph: sub } = s;
  if (!sub.active || !sub.result) return scoped(model, s.graphScope ?? 'all');
  if (viewCache && viewCache.model === model && viewCache.sub === sub) return viewCache.view;
  const byId = new Map(model.terms.map((t) => [t.id, t]));
  const rels = new Set(sub.result.rels);
  const terms: Term[] = [];
  for (const id of sub.result.terms) {
    const t = byId.get(id);
    if (!t) continue;
    const p = sub.pos[id];
    terms.push(p && (p.x !== t.x || p.y !== t.y) ? { ...t, x: p.x, y: p.y } : t);
  }
  const view = { ...model, terms, relations: model.relations.filter((r) => rels.has(r.id)) };
  viewCache = { model, sub, view };
  return view;
}

/** The layout of what the canvas shows: the model's own for the full graph, the subgraph's for a subgraph. */
export const layoutOf = (s: { model: Model; subgraph: SubgraphState }): GraphLayout => (s.subgraph.active ? s.subgraph.layout : s.model.layout);
