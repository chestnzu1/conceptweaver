/**
 * How the graph is arranged: which layout, and how it is set. Like the graph style and the
 * positions of the terms, none of it is part of the ontology. It is kept beside the model, is
 * never written to RDF, and changing it changes nothing the reasoner or the validation sees.
 *
 * Everything here is plain data, with no knowledge of the model or of how the graph is drawn:
 * a layout is given boxes and lines and answers with places, on the page or in a worker.
 */

export const LAYOUT_KINDS = ['hierarchy', 'layered', 'orthogonal', 'radial', 'circular', 'force', 'manual'] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

export const DIRECTIONS = ['TB', 'BT', 'LR', 'RL'] as const;
/** Which way the layers run: the general above the specific (top to bottom), or any of the other three. */
export type LayoutDirection = (typeof DIRECTIONS)[number];
export const DIRECTION_LABEL: Record<LayoutDirection, string> = { TB: 'Top to bottom', BT: 'Bottom to top', LR: 'Left to right', RL: 'Right to left' };

export const ROUTINGS = ['auto', 'direct', 'curved', 'orthogonal'] as const;
/** How a line gets from one term to the other. `auto` is what suits the layout. */
export type EdgeRouting = (typeof ROUTINGS)[number];
export const ROUTING_LABEL: Record<EdgeRouting, string> = { auto: 'As the layout suggests', direct: 'Straight', curved: 'Curved', orthogonal: 'Right angles' };

export type Positions = Map<string, { x: number; y: number }>;
export type Places = Record<string, { x: number; y: number }>;

export interface GraphLayout {
  kind: LayoutKind;
  direction: LayoutDirection;
  /** The room between two terms side by side, in pixels. */
  nodeSpacing: number;
  /** The room between two layers, or two rings. */
  layerSpacing: number;
  /** How hard terms push each other apart in the network layout: 1 is the usual. */
  repulsion: number;
  routing: EdgeRouting;
  /** The term a radial tree is drawn around, by id. Empty: the selected term, or else the one that fits best. */
  root: string;
  /** The arrangement made by hand, as it was when another layout was chosen: where each term was. */
  saved?: Places;
}

export const SPACING = { node: { min: 8, max: 200, initial: 36 }, layer: { min: 20, max: 300, initial: 70 }, repulsion: { min: 0.25, max: 4, initial: 1 } } as const;

/** A model that says nothing about its layout was arranged by hand, or as good as: nothing rearranges it unasked. */
export const noLayout = (kind: LayoutKind = 'manual'): GraphLayout => ({ kind, direction: 'TB', nodeSpacing: SPACING.node.initial, layerSpacing: SPACING.layer.initial, repulsion: SPACING.repulsion.initial, routing: 'auto', root: '' });

export interface LayoutInfo {
  label: string;
  about: string;
  /** What can be set for it. */
  direction?: boolean;
  nodeSpacing?: boolean;
  layerSpacing?: boolean;
  repulsion?: boolean;
  root?: boolean;
}

export const LAYOUTS: Record<LayoutKind, LayoutInfo> = {
  hierarchy: { label: 'Hierarchical', about: 'Layers, the general above the specific. Each row is centred.', direction: true, nodeSpacing: true, layerSpacing: true },
  layered: { label: 'Layered (Dagre)', about: 'Layers placed to keep lines short and straight, with room left where a line passes a layer.', direction: true, nodeSpacing: true, layerSpacing: true },
  orthogonal: { label: 'Orthogonal', about: 'A tree with each term over what is under it, and lines that turn at right angles.', direction: true, nodeSpacing: true, layerSpacing: true },
  radial: { label: 'Radial tree', about: 'One term in the middle and the others in rings around it, by how many steps away they are.', nodeSpacing: true, layerSpacing: true, root: true },
  circular: { label: 'Circular', about: 'All terms on a circle, related ones beside each other.', nodeSpacing: true },
  force: { label: 'Force-directed network', about: 'Related terms pull together and all terms push apart, until they settle.', nodeSpacing: true, repulsion: true },
  manual: { label: 'Manual', about: 'Terms stay where they are put. Nothing is rearranged.' },
};

/** How the lines of a layout run when nothing else was asked for. */
export const routingOf = (l: Pick<GraphLayout, 'kind' | 'routing'>): Exclude<EdgeRouting, 'auto'> => (l.routing !== 'auto' ? l.routing : l.kind === 'orthogonal' ? 'orthogonal' : 'direct');

/** How lines are drawn under a layout: the way they run, and which way the layers go. */
export interface Route {
  how: Exclude<EdgeRouting, 'auto'>;
  dir: LayoutDirection;
}
const ROUTES = new Map<string, Route>();
/** The same object for the same answer, so that nothing is drawn again because it was asked twice. */
export function routeOf(l: Pick<GraphLayout, 'kind' | 'direction' | 'routing'>): Route {
  const how = routingOf(l);
  // A layout without layers has no direction of its own: its lines are drawn as for top to bottom.
  const dir = LAYOUTS[l.kind].direction ? l.direction : 'TB';
  const key = how + dir;
  return ROUTES.get(key) ?? ROUTES.set(key, { how, dir }).get(key)!;
}

const num = (v: unknown, range: { min: number; max: number; initial: number }): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, v)) : range.initial);
const oneOf = <T extends string>(v: unknown, all: readonly T[], otherwise: T): T => ((all as readonly unknown[]).includes(v) ? (v as T) : otherwise);

/** A well-formed layout from untrusted JSON. Places of terms that no longer exist are dropped. */
export function normalizeLayout(raw: unknown, termIds: Set<string>): GraphLayout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const saved: Places = {};
  if (o.saved && typeof o.saved === 'object') {
    for (const [id, p] of Object.entries(o.saved as Record<string, { x?: unknown; y?: unknown } | null>)) {
      if (termIds.has(id) && p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) saved[id] = { x: p.x, y: p.y };
    }
  }
  return {
    kind: oneOf(o.kind, LAYOUT_KINDS, 'manual'),
    direction: oneOf(o.direction, DIRECTIONS, 'TB'),
    nodeSpacing: num(o.nodeSpacing, SPACING.node),
    layerSpacing: num(o.layerSpacing, SPACING.layer),
    repulsion: num(o.repulsion, SPACING.repulsion),
    routing: oneOf(o.routing, ROUTINGS, 'auto'),
    root: typeof o.root === 'string' && termIds.has(o.root) ? o.root : '',
    ...(Object.keys(saved).length ? { saved } : {}),
  };
}

// ---------------------------------------------------------------- what a layout is given

export interface LayoutNode {
  id: string;
  /** Its size as it is drawn, which follows from its name, its shape and its style. */
  w: number;
  h: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** "Is a": the term it points to is the more general one, and belongs above. */
  up?: boolean;
  /** Class membership: it points from an individual to its class. */
  member?: boolean;
}

export interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** What a layout is asked to do. */
export interface LayoutRequest {
  kind: Exclude<LayoutKind, 'manual'>;
  graph: LayoutGraph;
  options: Pick<GraphLayout, 'direction' | 'nodeSpacing' | 'layerSpacing' | 'repulsion' | 'root'>;
}

export interface LayoutResult {
  places: Places;
  /** Something to tell whoever asked, such as that another layout stood in for the one asked for. */
  note?: string;
}
