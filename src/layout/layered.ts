import { Graph, layout } from '@dagrejs/dagre';
import { eachPart } from './shared';
import type { LayoutGraph, LayoutRequest, Positions } from './types';

/** Up to this many terms and lines the ranking that makes the shortest lines; above it a quicker one. */
const SIMPLEX_LIMIT = 900;

/**
 * Layered layout by Dagre: the layers are chosen to keep lines short, room is left where a line
 * passes a layer, and terms are placed so that lines run straight. Each part of the graph that
 * hangs together is laid out on its own.
 */
export function layeredLayout(g: LayoutGraph, o: Pick<LayoutRequest['options'], 'direction' | 'nodeSpacing' | 'layerSpacing'>): Positions {
  return eachPart(g, o.nodeSpacing, (part) => {
    const dg = new Graph();
    dg.setGraph({ rankdir: o.direction, nodesep: o.nodeSpacing, edgesep: Math.max(8, o.nodeSpacing / 2), ranksep: o.layerSpacing, ranker: part.nodes.length + part.edges.length > SIMPLEX_LIMIT ? 'tight-tree' : 'network-simplex' });
    dg.setDefaultEdgeLabel(() => ({}));
    for (const n of part.nodes) dg.setNode(n.id, { width: n.w, height: n.h });
    // The general above the specific, and a class above its individuals. Dagre breaks rings itself.
    for (const e of part.edges) if (e.from !== e.to) e.up || e.member ? dg.setEdge(e.to, e.from) : dg.setEdge(e.from, e.to);
    layout(dg);
    const pos: Positions = new Map();
    for (const n of part.nodes) {
      const p = dg.node(n.id);
      pos.set(n.id, { x: Math.round(p.x), y: Math.round(p.y) });
    }
    return pos;
  });
}
