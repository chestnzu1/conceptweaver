import { graphOf } from '../../layout/graph';
import { LayoutCancelled, runLayout } from '../../layout/run';
import { LAYOUTS, type GraphLayout, type LayoutKind, type Places } from '../../layout/types';
import type { Viewport } from './session';
import type { Slice } from './types';
import { layoutOf, viewOf } from './view';

/**
 * A job: arranging the graph. A layout is worked out (in a worker where it can be), may be
 * cancelled, and its result glides into place; the run and the glide are this slice's own.
 */

/** Terms gliding from where they were to where a layout put them. `p` goes from 0 to 1. */
export interface Tween {
  from: Places;
  p: number;
}

/** Above this many terms and relationships a new arrangement is shown at once: gliding them would stutter. */
const GLIDE = { terms: 300, relations: 700, ms: 380 };

export interface LayoutSlice {
  /** The layout being worked out, while one is. */
  layoutBusy: LayoutKind | null;
  /** Terms on their way to a new arrangement. */
  tween: Tween | null;
  endTween: () => void;

  /** Arranges what the canvas shows by this layout, and makes it the chosen one. */
  arrange: (kind: LayoutKind) => void;
  /** Changes the layout or its settings. Whatever moves terms is worked out again; how lines are routed is not. */
  setLayout: (patch: Partial<Omit<GraphLayout, 'saved'>>) => void;
  /** Runs the chosen layout again, over whatever was moved by hand since. */
  rearrange: () => void;
  /** Stops a layout that is still being worked out. */
  cancelLayout: () => void;
  /** Takes the arrangement on screen as the one made by hand: nothing rearranges it from here on. */
  keepAsManual: () => void;
  /** Remembers where every term is now, and puts the terms back where they were last remembered. */
  savePositions: () => void;
  restorePositions: () => void;
}

export const layoutSlice: Slice<LayoutSlice> = (set, get) => {
  let layoutRun: AbortController | undefined;

  let glide: { frame: number; to: Viewport } | undefined;

  /** Ends a glide where it is going: the terms are in the model already, only the picture was behind. */
  function stopGlide() {
    if (!glide) return;
    cancelAnimationFrame(glide.frame);
    const to = glide.to;
    glide = undefined;
    set({ tween: null, vp: to });
  }

  /** Where every term of what the canvas shows is now. */
  function placesNow(): Places {
    const s = get();
    if (s.subgraph.active) return { ...s.subgraph.pos };
    return Object.fromEntries(s.model.terms.map((t) => [t.id, { x: t.x, y: t.y }]));
  }

  /** Writes the layout that is chosen, moving nothing. In the full graph it is part of the model's file, though not of its history. */
  function writeLayout(layout: GraphLayout) {
    const s = get();
    if (s.subgraph.active) set({ subgraph: { ...s.subgraph, layout } });
    else s.apply((m) => ({ ...m, layout }), false);
  }

  /**
   * Puts terms where a layout says, and makes that layout the chosen one. In the full graph the
   * two are one step to undo; a subgraph's arrangement is its own and no part of the history.
   * The terms glide there, and the view follows to show all of them.
   */
  function place(layout: GraphLayout, places: Places) {
    stopGlide();
    const s = get();
    const before = s.vp;
    const shown = viewOf(s).terms;
    const from: Places = Object.fromEntries(shown.map((t) => [t.id, { x: t.x, y: t.y }]));
    if (s.subgraph.active) {
      const pos = { ...s.subgraph.pos };
      for (const id of Object.keys(pos)) if (places[id]) pos[id] = places[id];
      set({ subgraph: { ...s.subgraph, layout, pos } });
    } else {
      s.apply((m) => ({ ...m, layout, terms: m.terms.map((t) => (places[t.id] && (places[t.id].x !== t.x || places[t.id].y !== t.y) ? { ...t, x: places[t.id].x, y: places[t.id].y } : t)) }));
    }
    get().fit();
    const to = get().vp;
    const calm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const view = viewOf(get());
    if (calm || typeof requestAnimationFrame === 'undefined' || view.terms.length > GLIDE.terms || view.relations.length > GLIDE.relations || !shown.length) return;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / GLIDE.ms);
      if (t >= 1 || !glide) return stopGlide();
      // Quick away and slow to arrive.
      const p = 1 - (1 - t) ** 3;
      glide.frame = requestAnimationFrame(step);
      set({ tween: { from, p }, vp: { k: before.k + (to.k - before.k) * p, x: before.x + (to.x - before.x) * p, y: before.y + (to.y - before.y) * p } });
    };
    glide = { frame: requestAnimationFrame(step), to };
    set({ tween: { from, p: 0 }, vp: before });
  }

  /**
   * Arranges what the canvas shows by a layout. The layout is given boxes and lines and nothing
   * else, and what comes back is places: the terms move, and no statement of the model changes.
   */
  async function applyLayout(next: GraphLayout): Promise<void> {
    const s = get();
    const now = layoutOf(s);
    layoutRun?.abort();
    layoutRun = undefined;
    if (next.kind === 'manual') {
      set({ layoutBusy: null });
      // Back to the arrangement made by hand, where there is one; otherwise what is on screen becomes it.
      if (now.kind !== 'manual' && next.saved) place(next, next.saved);
      else writeLayout(next);
      return;
    }
    // The arrangement made by hand is remembered when it is left, so that it can be come back to.
    const kind = next.kind;
    const layout = now.kind === 'manual' ? { ...next, saved: placesNow() } : next;
    const view = viewOf(s);
    if (!view.terms.length) return writeLayout(layout);
    // A radial tree is drawn around the term chosen for it, or else the one that is selected.
    const shown = new Set(view.terms.map((t) => t.id));
    const root = shown.has(layout.root) ? layout.root : s.sel.terms.length === 1 && shown.has(s.sel.terms[0]) ? s.sel.terms[0] : (s.subgraph.active && s.subgraph.roots.find((id) => shown.has(id))) || '';
    const run = (layoutRun = new AbortController());
    set({ layoutBusy: kind });
    try {
      const result = await runLayout({ kind, graph: graphOf(view), options: { direction: layout.direction, nodeSpacing: layout.nodeSpacing, layerSpacing: layout.layerSpacing, repulsion: layout.repulsion, root } }, run.signal);
      if (layoutRun !== run) return;
      layoutRun = undefined;
      set({ layoutBusy: null });
      place(layout, result.places);
      if (result.note) get().notify(result.note);
    } catch (e) {
      if (layoutRun !== run) return;
      layoutRun = undefined;
      set({ layoutBusy: null });
      if (!(e instanceof LayoutCancelled)) get().notify(`The layout could not be worked out: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    layoutBusy: null,
    tween: null,
    endTween: () => stopGlide(),
    arrange: (kind) => void applyLayout({ ...layoutOf(get()), kind }),
    setLayout: (patch) => {
      const now = layoutOf(get());
      const next = { ...now, ...patch };
      const info = LAYOUTS[next.kind];
      // What moves terms under the layout that is chosen. A setting it does not have is kept for the layout that does.
      const moves = next.kind !== now.kind || (['direction', 'nodeSpacing', 'layerSpacing', 'repulsion', 'root'] as const).some((k) => info[k] && next[k] !== now[k]);
      if (moves) void applyLayout(next);
      else writeLayout(next);
    },
    rearrange: () => void applyLayout(layoutOf(get())),
    cancelLayout: () => {
      layoutRun?.abort();
      layoutRun = undefined;
      set({ layoutBusy: null });
    },
    keepAsManual: () => writeLayout({ ...layoutOf(get()), kind: 'manual', saved: placesNow() }),
    savePositions: () => {
      writeLayout({ ...layoutOf(get()), saved: placesNow() });
      get().notify('This arrangement is remembered. It comes back whenever Manual is chosen again.');
    },
    restorePositions: () => {
      const saved = layoutOf(get()).saved;
      if (saved) place(layoutOf(get()), saved);
    },

  };
};
