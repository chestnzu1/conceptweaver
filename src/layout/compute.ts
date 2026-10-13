import { circularLayout } from './circular';
import { forceLayout } from './force';
import { hierarchyLayout } from './hierarchy';
import { radialLayout } from './radial';
import { treeLayout } from './tree';
import type { LayoutGraph, LayoutRequest, LayoutResult, Places, Positions } from './types';

/**
 * How large a graph Dagre is given, counting a term as one and a line as two. Its time grows
 * much faster than the graph, and with the lines more than with the terms. Measured: 400 terms
 * with 750 lines take four seconds, 600 with 1,400 half a minute, 960 with 2,550 three minutes.
 * Beyond this weight the built-in hierarchical layout stands in.
 */
export const DAGRE_LIMIT = 2400;
export const dagreWeight = (g: LayoutGraph): number => g.nodes.length + 2 * g.edges.length;

/**
 * Where the layers are columns, the words on a line lie along it, between two columns, and need
 * more room there than between two rows: the columns are set that much further apart.
 */
const roomy = (o: LayoutRequest['options']): LayoutRequest['options'] => (o.direction === 'LR' || o.direction === 'RL' ? { ...o, layerSpacing: o.layerSpacing + 50 } : o);

const done = (pos: Positions, note?: string): LayoutResult => ({ places: Object.fromEntries(pos) as Places, ...(note ? { note } : {}) });

/** The layouts the app has of its own: each answers at once. */
export function builtIn(req: LayoutRequest): Positions {
  const { graph } = req;
  const options = roomy(req.options);
  switch (req.kind) {
    case 'force':
      return forceLayout(graph, options);
    case 'radial':
      return radialLayout(graph, options);
    case 'circular':
      return circularLayout(graph, options);
    case 'orthogonal':
      return treeLayout(graph, options);
    default:
      return hierarchyLayout(graph, options);
  }
}

/**
 * Works a layout out, here or in a worker: it is the same on both sides. Dagre is fetched only
 * when the layered layout is asked for, so that nobody who does not use it pays for it.
 */
export async function compute(req: LayoutRequest): Promise<LayoutResult> {
  if (req.kind !== 'layered') return done(builtIn(req));
  if (dagreWeight(req.graph) > DAGRE_LIMIT) {
    return done(hierarchyLayout(req.graph, roomy(req.options)), `Dagre would take minutes on a graph of ${req.graph.nodes.length.toLocaleString('en')} terms and ${req.graph.edges.length.toLocaleString('en')} lines, so the built-in hierarchical layout was used instead.`);
  }
  const { layeredLayout } = await import('./layered');
  return done(layeredLayout(req.graph, roomy(req.options)));
}
