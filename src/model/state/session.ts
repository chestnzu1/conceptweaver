import { LIST_KINDS, type EntitySort, type FilterValues, type ListKind } from '../../entities/contracts';
import type { HierarchyMode, Iri } from '../../structure/contracts';
import { classIriOf } from '../../structure/local';
import { findPath } from '../checks';
import { bounds } from '../geometry';
import { normalizeByKind, type SavedStyle } from '../graphStyle';
import { allowsView, supports, type View } from '../modelTypes';
import { initialModel } from './document';
import { stored, STYLES_KEY, THEME_KEY } from './storage';
import type { Slice, State } from './types';
import { viewOf, type GraphScope } from './view';

/**
 * The session: what this person is looking at and how, kept for as long as the page is open (and
 * some of it, the preferences, in the browser). Nothing here is part of the ontology.
 */

export type Theme = 'light' | 'dark';

export interface Editing {
  kind: 'term' | 'rel';
  id: string;
  /** Just created: cancelling the edit removes it again. */
  isNew?: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Selection {
  terms: string[];
  rels: string[];
}

/** How far out the view goes: far enough to see all of a wide tree of a few hundred terms. */
export const MIN_ZOOM = 0.03;

/** What the Structure Explorer is used for at the moment: looking through the hierarchy, setting two classes side by side, or measuring the whole. */
export type StructureMode = 'explore' | 'compare' | 'analyze';

/**
 * The Structure Explorer. It reads the ontology and changes nothing in it, and what it is
 * looking at is its own: a class is brought into focus there without being selected, so the
 * entity editor opens only when it is asked for.
 */
export interface StructureState {
  mode: StructureMode;
  /** Which hierarchy is on show: what is stated, or what the chosen reasoner entails. */
  hierarchy: HierarchyMode;
  /** In the inferred hierarchy: whether the places that are entailed and nowhere stated are marked. */
  markInferred: boolean;
  /** The class in focus, by IRI. */
  focus: Iri | null;
  /** Goes up each time a class is pointed at from outside the explorer, which then brings it into view. */
  pointed: number;
  /** The text the hierarchy is narrowed to. */
  search: string;
  /** The two classes set side by side, by IRI. */
  compare: { a: Iri | null; b: Iri | null };
}

/**
 * How one list of the Entities page is narrowed and put in order. Each list has its own: what is
 * searched for among the classes is not searched for among the individuals. None of it is part
 * of the model, and none of it changes the model.
 */
export interface EntityViewState {
  search: string;
  /** Nothing: the order the model has them in. */
  sort: EntitySort | null;
  filters: FilterValues;
}

const NO_ENTITY_VIEW: EntityViewState = { search: '', sort: null, filters: {} };

export const noEntityViews = () => Object.fromEntries(LIST_KINDS.map((k) => [k, NO_ENTITY_VIEW])) as Record<ListKind, EntityViewState>;

/** The graph styles saved under a name in this browser, to use in any model. */
function loadSavedStyles(): SavedStyle[] {
  try {
    const list = JSON.parse(localStorage.getItem(STYLES_KEY) ?? '[]') as unknown;
    return (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).filter((x) => x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim()).map((x) => ({ name: (x.name as string).trim(), ...normalizeByKind(x) }));
  } catch {
    return [];
  }
}

function loadTheme(): Theme {
  try {
    const t = stored(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    // ignore
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** The widths the sidebar on the left can be given: narrow enough to be out of the way, wide enough for long names. */
export const SIDEBAR_WIDTH = { min: 180, max: 720, initial: 232 } as const;

const sidebarWidthOf = (width: number) => (Number.isFinite(width) ? Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width))) : SIDEBAR_WIDTH.initial);

/**
 * The Structure Explorer follows what is pointed at elsewhere: when one term is selected and it
 * is a class, that class is in focus there too. Anything else leaves its focus where it was.
 */
const pointingAt = (s: Pick<State, 'model' | 'structure'>, terms: string[], rels: string[] = []): StructureState => {
  const iri = terms.length === 1 && !rels.length ? classIriOf(s.model, terms[0]) : undefined;
  return iri === undefined ? s.structure : { ...s.structure, focus: iri, pointed: s.structure.pointed + 1 };
};

export interface SessionSlice {
  sel: Selection;
  /** Key of the object property open in the side panel, when one is. */
  selProp: string | null;
  vp: Viewport;
  canvasSize: { w: number; h: number };
  view: View;
  editing: Editing | null;
  /** Ids of terms and relations to spotlight (everything else is dimmed). */
  highlight: string[];
  /** What the spotlight shows, for the banner on the canvas. */
  highlightLabel: string;
  /** Whether the canvas also draws the class memberships the reasoner works out. A way of looking; never part of the model. */
  showInferred: boolean;
  setShowInferred: (on: boolean) => void;
  /** Whether the canvas draws a line from each enumeration class to the individuals it lists. */
  showEnumerations: boolean;
  setShowEnumerations: (on: boolean) => void;
  /** Whether the graph style panel is open on the canvas. */
  stylePanel: boolean;
  setStylePanel: (open: boolean) => void;
  savedStyles: SavedStyle[];
  /** Keeps the styles by kind under a name in this browser. Returns the reason if it could not. */
  saveStyleAs: (name: string) => string | undefined;
  deleteSavedStyle: (name: string) => void;
  filter: string;
  theme: Theme;
  /** The entity editor takes more room, for entities with a lot to say about them. */
  editorWide: boolean;
  /** Whether the model details, which the side panel shows while nothing is selected, are folded away. */
  modelPanelHidden: boolean;
  setModelPanelHidden: (hidden: boolean) => void;
  /** Whether the sidebar on the left, with the hierarchy and the lists of terms, is folded away to a strip. */
  sidebarHidden: boolean;
  setSidebarHidden: (hidden: boolean) => void;
  /** How wide that sidebar is when it is open, in pixels. Its edge can be dragged. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  setEditorWide: (wide: boolean) => void;
  /** The search, the order and the filters of each list of the Entities page. */
  entityViews: Record<ListKind, EntityViewState>;
  setEntityView: (kind: ListKind, patch: Partial<EntityViewState>) => void;
  /** Whether the panel of filters is open. It is the page's, not a list's: open, it stays open from tab to tab. */
  entityFiltersOpen: boolean;
  setEntityFiltersOpen: (open: boolean) => void;
  dialog: 'bulk' | 'settings' | 'library' | 'saveas' | 'new' | 'openurl' | null;
  toast: string | null;
  graphScope: GraphScope;
  setGraphScope: (scope: GraphScope) => void;
  structure: StructureState;
  setStructure: (patch: Partial<Pick<StructureState, 'mode' | 'hierarchy' | 'markInferred' | 'focus' | 'search' | 'compare'>>) => void;
  /** Opens an object property, by id. */
  selectProp: (id: string | null) => void;
  select: (terms: string[], rels?: string[]) => void;
  toggleTerm: (id: string) => void;
  selectAll: () => void;
  focusTerm: (id: string) => void;
  focusRelation: (id: string) => void;
  showPath: (a: string, b: string) => void;
  /** Spotlights the terms that point at the given terms ('in'), that they point at ('out'), or both. */
  showNeighbours: (ids: string[], direction: 'in' | 'out' | 'both') => void;

  setVp: (vp: Viewport) => void;
  zoomBy: (factor: number, cx?: number, cy?: number) => void;
  setCanvasSize: (w: number, h: number) => void;
  fit: () => void;
  setView: (v: View) => void;
  setEditing: (e: Editing | null) => void;
  setHighlight: (ids: string[], label?: string) => void;
  setFilter: (f: string) => void;
  setTheme: (t: Theme) => void;

  setDialog: (d: State['dialog']) => void;
  /** Something to tell that takes longer to read than a notice is shown for, such as why a file could not be opened: it stays until it is dismissed. */
  message: { title: string; text: string } | null;
  showMessage: (title: string, text: string) => void;
  dismissMessage: () => void;
  notify: (msg: string) => void;
}

export const sessionSlice: Slice<SessionSlice> = (set, get) => ({
  sel: { terms: [], rels: [] },
  selProp: null,
  vp: { x: 0, y: 0, k: 1 },
  canvasSize: { w: 0, h: 0 },
  view: 'graph',
  editing: null,
  highlight: [],
  highlightLabel: '',
  // Whether the graph also draws what the reasoner works out is remembered, like the other choices of what it shows.
  showInferred: (() => {
    try {
      return localStorage.getItem('conceptweaver:show-inferred') === 'on' && supports(initialModel, 'reasoning');
    } catch {
      return false;
    }
  })(),
  setShowInferred: (wanted) => {
    const showInferred = wanted && supports(get().model, 'reasoning');
    try {
      localStorage.setItem('conceptweaver:show-inferred', showInferred ? 'on' : 'off');
    } catch {
      // Remembered for this visit only.
    }
    set({ showInferred });
  },
  showEnumerations: true,
  setShowEnumerations: (showEnumerations) => set({ showEnumerations }),
  stylePanel: false,
  setStylePanel: (stylePanel) => set({ stylePanel }),
  savedStyles: loadSavedStyles(),
  saveStyleAs: (name) => {
    const clean = name.trim();
    if (!clean) return 'Give the style a name.';
    const { nodeTypes, edgeTypes } = get().model.style;
    const savedStyles = [...get().savedStyles.filter((x) => x.name.toLowerCase() !== clean.toLowerCase()), { name: clean, nodeTypes, edgeTypes }].sort((a, b) => a.name.localeCompare(b.name));
    try {
      localStorage.setItem(STYLES_KEY, JSON.stringify(savedStyles));
    } catch {
      return 'The browser would not store it.';
    }
    set({ savedStyles });
    get().setStyle((s) => ({ ...s, theme: clean, customized: undefined }));
    get().notify(`Graph style “${clean}” saved in this browser.`);
    return undefined;
  },
  deleteSavedStyle: (name) => {
    const savedStyles = get().savedStyles.filter((x) => x.name !== name);
    try {
      localStorage.setItem(STYLES_KEY, JSON.stringify(savedStyles));
    } catch {
      // Not stored either way.
    }
    set({ savedStyles });
  },
  filter: '',
  theme: loadTheme(),
  editorWide: (() => {
    try {
      return localStorage.getItem('conceptweaver:editor-wide') === 'on';
    } catch {
      return false;
    }
  })(),
  modelPanelHidden: (() => {
    try {
      return localStorage.getItem('conceptweaver:model-panel') === 'hidden';
    } catch {
      return false;
    }
  })(),
  setModelPanelHidden: (modelPanelHidden) => {
    try {
      localStorage.setItem('conceptweaver:model-panel', modelPanelHidden ? 'hidden' : 'shown');
    } catch {
      // Remembered for this visit only.
    }
    set({ modelPanelHidden });
  },
  sidebarHidden: (() => {
    try {
      return localStorage.getItem('conceptweaver:sidebar') === 'hidden';
    } catch {
      return false;
    }
  })(),
  setSidebarHidden: (sidebarHidden) => {
    try {
      localStorage.setItem('conceptweaver:sidebar', sidebarHidden ? 'hidden' : 'shown');
    } catch {
      // Remembered for this visit only.
    }
    set({ sidebarHidden });
  },
  sidebarWidth: (() => {
    try {
      return sidebarWidthOf(Number(localStorage.getItem('conceptweaver:sidebar-width')) || SIDEBAR_WIDTH.initial);
    } catch {
      return SIDEBAR_WIDTH.initial;
    }
  })(),
  setSidebarWidth: (width) => {
    const sidebarWidth = sidebarWidthOf(width);
    try {
      localStorage.setItem('conceptweaver:sidebar-width', String(sidebarWidth));
    } catch {
      // Remembered for this visit only.
    }
    set({ sidebarWidth });
  },
  setEditorWide: (editorWide) => {
    try {
      localStorage.setItem('conceptweaver:editor-wide', editorWide ? 'on' : 'off');
    } catch {
      // The choice just isn't remembered.
    }
    set({ editorWide });
  },
  entityViews: noEntityViews(),
  setEntityView: (kind, patch) => set((s) => ({ entityViews: { ...s.entityViews, [kind]: { ...s.entityViews[kind], ...patch } } })),
  entityFiltersOpen: false,
  setEntityFiltersOpen: (entityFiltersOpen) => set({ entityFiltersOpen }),
  dialog: null,
  toast: null,
  graphScope: 'all',
  setGraphScope: (graphScope) => {
    set({ graphScope });
    get().fit();
  },
  structure: { mode: 'explore', hierarchy: 'asserted', markInferred: true, focus: null, pointed: 0, search: '', compare: { a: null, b: null } },
  setStructure: (patch) => set((s) => ({ structure: { ...s.structure, ...patch } })),
  selectProp: (selProp) => set({ selProp, sel: { terms: [], rels: [] } }),
  select: (terms, rels = []) => set((s) => ({ sel: { terms, rels }, selProp: terms.length || rels.length ? null : s.selProp, structure: pointingAt(s, terms, rels) })),
  toggleTerm: (id) =>
    set((s) => ({
      sel: { ...s.sel, terms: s.sel.terms.includes(id) ? s.sel.terms.filter((x) => x !== id) : [...s.sel.terms, id] },
    })),
  selectAll: () => set((s) => ({ sel: { terms: viewOf(s).terms.map((t) => t.id), rels: [] } })),
  focusTerm: (id) => {
    if (!get().model.terms.some((x) => x.id === id)) return;
    // Asked to show a term that the subgraph leaves out: it joins the subgraph as a starting point.
    if (get().subgraph.active && !viewOf(get()).terms.some((x) => x.id === id)) {
      const { roots, hidden } = get().subgraph;
      get().setSubgraph({ roots: [...roots, id], hidden: hidden.filter((x) => x !== id) });
    }
    const { canvasSize, vp } = get();
    const t = viewOf(get()).terms.find((x) => x.id === id);
    if (!t) return;
    set((s) => ({ view: 'graph', sel: { terms: [id], rels: [] }, structure: pointingAt(s, [id]), vp: { ...vp, x: canvasSize.w / 2 - t.x * vp.k, y: canvasSize.h / 2 - t.y * vp.k } }));
  },
  focusRelation: (id) => {
    const r = get().model.relations.find((x) => x.id === id);
    if (!r) return;
    if (get().subgraph.active) {
      const shown = new Set(viewOf(get()).terms.map((t) => t.id));
      const missing = [r.from, r.to].filter((x) => !shown.has(x));
      if (missing.length) get().setSubgraph({ roots: [...get().subgraph.roots, ...missing], hidden: get().subgraph.hidden.filter((x) => !missing.includes(x)) });
    }
    const { canvasSize, vp } = get();
    const view = viewOf(get());
    const a = view.terms.find((x) => x.id === r.from);
    const b = view.terms.find((x) => x.id === r.to);
    if (!a || !b) return;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    set({ view: 'graph', sel: { terms: [], rels: [id] }, vp: { ...vp, x: canvasSize.w / 2 - cx * vp.k, y: canvasSize.h / 2 - cy * vp.k } });
  },
  showPath: (a, b) => {
    const path = findPath(get().model, a, b);
    if (!path) {
      get().notify('These two terms are not connected.');
      return;
    }
    set({ highlight: [...path.terms, ...path.rels], highlightLabel: 'Showing the shortest path', view: 'graph' });
  },
  showNeighbours: (ids, direction) => {
    const { model } = get();
    const own = new Set(ids);
    const spot = new Set(ids);
    let found = 0;
    for (const r of model.relations) {
      if (r.from === r.to) continue;
      const incoming = own.has(r.to) && direction !== 'out';
      const outgoing = own.has(r.from) && direction !== 'in';
      if (!incoming && !outgoing) continue;
      spot.add(r.id).add(r.from).add(r.to);
      found++;
    }
    const what = direction === 'in' ? 'incoming' : direction === 'out' ? 'outgoing' : 'connected';
    if (!found) {
      get().notify(`No ${what} relations here.`);
      return;
    }
    const names = model.terms.filter((t) => own.has(t.id)).map((t) => t.name || 'Unnamed');
    const subject = names.length === 1 ? `“${names[0]}”` : `${names.length} terms`;
    const label =
      direction === 'in' ? `Terms that point to ${subject}` : direction === 'out' ? `Terms that ${subject} ${names.length === 1 ? 'points' : 'point'} to` : `Everything connected to ${subject}`;
    set({ highlight: [...spot], highlightLabel: `${label} (${spot.size - own.size - found})`, view: 'graph' });
  },

  setVp: (vp) => set({ vp }),
  zoomBy: (factor, cx, cy) =>
    set((s) => {
      const px = cx ?? s.canvasSize.w / 2;
      const py = cy ?? s.canvasSize.h / 2;
      const k = Math.min(3, Math.max(MIN_ZOOM, s.vp.k * factor));
      const ratio = k / s.vp.k;
      return { vp: { k, x: px - (px - s.vp.x) * ratio, y: py - (py - s.vp.y) * ratio } };
    }),
  setCanvasSize: (w, h) => set({ canvasSize: { w, h } }),
  fit: () => {
    const { canvasSize } = get();
    const { w, h } = canvasSize;
    if (!w || !h) return;
    const b = bounds(viewOf(get()).terms);
    if (!b) {
      set({ vp: { x: w / 2, y: h / 2, k: 1 } });
      return;
    }
    const pad = 70;
    // The style panel floats over the right of the canvas: with it open, the graph is fitted into the room beside it.
    const room = get().stylePanel && w > 760 ? w - 340 : w;
    // The bar of buttons floats over the top left. The graph is fitted below it where it takes more than
    // one line, and beside its settings while they are open and leave room for that.
    const el = typeof document === 'undefined' ? null : document.querySelector('.subgraph');
    const bar = el?.querySelector(':scope > .row')?.getBoundingClientRect().height ?? 0;
    // The settings are part of the bar's box, which is as wide as its buttons need.
    const open = el?.querySelector('.subgraph-body') ? el.getBoundingClientRect().width : 0;
    const left = open && room - open > 300 ? open + 12 : 0;
    const top = !left && bar > 48 && h > 420 ? bar - 34 : 0;
    const k = Math.min(1.25, Math.max(MIN_ZOOM, Math.min((room - left) / (b.x1 - b.x0 + pad * 2), (h - top) / (b.y1 - b.y0 + pad * 2))));
    set({ vp: { k, x: left + (room - left) / 2 - ((b.x0 + b.x1) / 2) * k, y: top + (h - top) / 2 - ((b.y0 + b.y1) / 2) * k } });
  },
  // A function the type of model does not have is not opened, however it was asked for.
  setView: (view) => allowsView(get().model, view) && set({ view }),
  setEditing: (editing) => set({ editing }),
  setHighlight: (highlight, highlightLabel = '') => set({ highlight, highlightLabel }),
  setFilter: (filter) => set({ filter }),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
    set({ theme });
  },
  setDialog: (dialog) => set({ dialog }),
  message: null,
  showMessage: (title, text) => set({ message: { title, text } }),
  dismissMessage: () => set({ message: null }),
  notify: (toast) => {
    clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(() => set({ toast: null }), 4000);
  },
});
