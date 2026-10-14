import { builtIn } from '../../layout/compute';
import { graphOf } from '../../layout/graph';
import { noLayout, type GraphLayout } from '../../layout/types';
import { DEFAULT_MAX_NODES, extractSubgraph, MAX_DEPTH, type Direction, type Subgraph } from '../subgraph';
import type { Slice } from './types';

/** The subgraph view: a slice of the session. It is a way of looking at the model, never part of it. */

/**
 * The subgraph view: a filtered picture of the model around a few chosen terms. It lives beside
 * the model, never in it: it has its own layout and is not part of undo or of any saved file.
 */
export interface SubgraphState {
  /** Subgraph mode is on; otherwise the canvas shows the full graph. */
  active: boolean;
  roots: string[];
  depth: number;
  direction: Direction;
  /** Relationship types switched off. */
  off: string[];
  expanded: string[];
  hidden: string[];
  maxNodes: number;
  /** Where each term sits in the subgraph, which has a layout of its own. */
  pos: Record<string, { x: number; y: number }>;
  /** What is visible for the settings above; null until first worked out. */
  result: Subgraph | null;
  /** How the subgraph is arranged: a layout of its own, chosen apart from the full graph's. */
  layout: GraphLayout;
}

export const NO_SUBGRAPH: SubgraphState = { active: false, roots: [], depth: 1, direction: 'both', off: [], expanded: [], hidden: [], maxNodes: DEFAULT_MAX_NODES, pos: {}, result: null, layout: noLayout('hierarchy') };

export interface SubgraphSlice {
  subgraph: SubgraphState;
  /** Changes subgraph settings (roots, depth, direction, filters, limit) and updates what is shown. */
  setSubgraph: (patch: Partial<Pick<SubgraphState, 'roots' | 'depth' | 'direction' | 'off' | 'expanded' | 'hidden' | 'maxNodes'>>) => void;
  /** Works out the subgraph afresh. With `relayout` every visible term is placed anew; otherwise only new ones are. */
  refreshSubgraph: (relayout?: boolean) => void;
  /** Switches to subgraph mode, laying the subgraph out. */
  visualizeSubgraph: () => void;
  /** Back to subgraph mode as it was left: same terms, same places, same expansions. */
  resumeSubgraph: () => void;
  /** Back to the full graph; the subgraph's settings are kept for next time. */
  showFullGraph: () => void;
  /** Shows or stops showing the direct neighbours of one term. */
  toggleExpand: (id: string) => void;
}

export const subgraphSlice: Slice<SubgraphSlice> = (set, get) => ({
  subgraph: NO_SUBGRAPH,
  setSubgraph: (patch) => {
    const clean = { ...patch };
    if (clean.depth !== undefined) clean.depth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(clean.depth)));
    if (clean.maxNodes !== undefined) clean.maxNodes = Math.max(1, Math.min(5000, Math.floor(clean.maxNodes) || DEFAULT_MAX_NODES));
    set((s) => ({ subgraph: { ...s.subgraph, ...clean } }));
    if (!get().subgraph.active) return;
    get().refreshSubgraph();
    // A change of scope can put terms well outside what is on screen; expanding or hiding one term does not move the view.
    if (['roots', 'depth', 'direction', 'off', 'maxNodes'].some((k) => k in patch)) get().fit();
  },
  refreshSubgraph: (relayout = false) => {
    const { model, subgraph: sub } = get();
    const result = extractSubgraph(model, sub);
    const byId = new Map(model.terms.map((t) => [t.id, t]));
    let pos: SubgraphState['pos'] = {};
    if (relayout || !Object.keys(sub.pos).length) {
      // A layout of the visible part alone, as if it were the whole model.
      const visible = new Set(result.terms);
      const rels = new Set(result.rels);
      const part = { ...model, terms: model.terms.filter((t) => visible.has(t.id)), relations: model.relations.filter((r) => rels.has(r.id)) };
      // By the subgraph's own layout. Dagre answers later (see visualizeSubgraph), and a manual arrangement has to start from something.
      const kind = sub.layout.kind === 'layered' || sub.layout.kind === 'manual' ? 'hierarchy' : sub.layout.kind;
      const laid = builtIn({ kind, graph: graphOf(part), options: { ...sub.layout, root: sub.layout.root || sub.roots[0] || '' } });
      for (const [id, p] of laid) pos[id] = p;
    } else {
      // Terms already on show stay where they are; a new one is put beside the term that brought it in.
      for (const id of result.terms) if (sub.pos[id]) pos[id] = sub.pos[id];
      const taken = Object.values(pos);
      const free = (p: { x: number; y: number }) => {
        for (let i = 0; i < 40 && taken.some((q) => Math.abs(q.x - p.x) < 150 && Math.abs(q.y - p.y) < 52); i++) p = { x: p.x + (i % 2 ? 0 : 170), y: p.y + (i % 2 ? 64 : 0) };
        taken.push(p);
        return p;
      };
      const children = new Map<string, number>();
      const maxX = () => Math.max(...taken.map((q) => q.x), 0);
      for (const id of result.terms) {
        if (pos[id]) continue;
        const parent = result.via.get(id);
        const from = parent ? pos[parent] : undefined;
        if (!from) {
          pos[id] = free({ x: taken.length ? maxX() + 220 : 0, y: taken.length ? taken[0].y : 0 });
          continue;
        }
        const k = children.get(parent!) ?? 0;
        children.set(parent!, k + 1);
        // Fanned out below it, alternating left and right.
        pos[id] = free({ x: Math.round(from.x + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 180), y: from.y + 120 });
      }
    }
    for (const id of Object.keys(pos)) if (!byId.has(id)) delete pos[id];
    set((s) => ({ subgraph: { ...s.subgraph, pos, result }, sel: { terms: s.sel.terms.filter((id) => pos[id]), rels: s.sel.rels } }));
  },
  visualizeSubgraph: () => {
    if (!get().subgraph.roots.length) {
      get().notify('Choose at least one term to start the subgraph from.');
      return;
    }
    set((s) => ({ subgraph: { ...s.subgraph, active: true, expanded: [], hidden: [] }, view: 'graph', highlight: [], highlightLabel: '' }));
    get().refreshSubgraph(true);
    get().fit();
    if (get().subgraph.layout.kind === 'layered') get().rearrange();
    const { result, maxNodes } = get().subgraph;
    if (result?.truncated) get().notify(`The subgraph is cut off at ${maxNodes} terms. Lower the depth, switch off some relationship types, or raise the limit.`);
  },
  resumeSubgraph: () => {
    set((s) => ({ subgraph: { ...s.subgraph, active: true }, view: 'graph', highlight: [], highlightLabel: '' }));
    // The model may have been edited in the meantime, so what is visible is worked out again; places are kept.
    get().refreshSubgraph();
    get().fit();
  },
  showFullGraph: () => {
    if (!get().subgraph.active) return;
    set((s) => ({ subgraph: { ...s.subgraph, active: false } }));
    get().fit();
  },
  toggleExpand: (id) => {
    const { expanded } = get().subgraph;
    get().setSubgraph({ expanded: expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id] });
  },
});
