import { nodeSize } from '../model/geometry';
import { isInstanceOf } from '../model/props';
import type { Model } from '../model/types';
import { resolveModel } from '../model/vocab';
import type { LayoutGraph } from './types';

/**
 * A model as a layout sees it: a box for each term, as large as it is drawn, and a line for
 * each relationship, with what the layout needs to know of its meaning. With the RDFS/OWL
 * layer on, a relation mapped to a standard property counts as what that property is.
 */
export function graphOf(model: Model): LayoutGraph {
  const m = resolveModel(model);
  const ids = new Set(m.terms.map((t) => t.id));
  return {
    nodes: m.terms.map((t) => ({ id: t.id, ...nodeSize(t) })),
    edges: m.relations
      .filter((r) => ids.has(r.from) && ids.has(r.to))
      .map((r) => ({ from: r.from, to: r.to, ...(r.kind === 'generalization' ? { up: true } : m.mode !== 'skos' && isInstanceOf(m, r) ? { member: true } : {}) })),
  };
}
