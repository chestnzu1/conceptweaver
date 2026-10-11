import { create } from 'zustand';
import type { BulkRelation, BulkTerm, Outline } from './bulk';
import { findPath } from './checks';
import { bounds } from './geometry';
import { forceLayout, hierarchyLayout } from './layout';
import { sampleModel } from './sample';
import { convertModel } from './convert';
import { declaredProp, findProp, propKey, type RelChoice } from './props';
import { labelKey, resolveModel, suggestFor } from './vocab';
import { DEFAULT_MAX_NODES, extractSubgraph, MAX_DEPTH, type Direction, type Subgraph } from './subgraph';
import { baseIriOf, moveNamespace, withIris } from './iri';
import { loadModel as loadSaved, saveModel as saveToLibraryDb } from './library';
import type { SettingsDraft } from './prefixes';
import { assertedSuperclasses, wouldCycle } from './props';
import { emptyModel, type ModelMode, type ObjProp, newRelation, newTerm, normalizeModel, type Model, type Relation, type Term } from './types';

export type View = 'graph' | 'table' | 'hierarchy' | 'checks' | 'rdf' | 'sparql' | 'vocab';
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
}

const NO_SUBGRAPH: SubgraphState = { active: false, roots: [], depth: 1, direction: 'both', off: [], expanded: [], hidden: [], maxNodes: DEFAULT_MAX_NODES, pos: {}, result: null };

let viewCache: { model: Model; sub: SubgraphState; view: Model } | undefined;

/**
 * The model as the canvas should draw it: the model itself in full-graph mode, or in subgraph
 * mode a copy holding only the visible terms and relationships, placed by the subgraph's layout.
 */
export function viewOf(s: { model: Model; subgraph: SubgraphState }): Model {
  const { model, subgraph: sub } = s;
  if (!sub.active || !sub.result) return model;
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

interface Selection {
  terms: string[];
  rels: string[];
}

const MODEL_KEY = 'conceptweaver:model:v1';
const THEME_KEY = 'conceptweaver:theme';
const MODE_KEY = 'conceptweaver:mode';
/** Which saved model the working copy belongs to, and whether it has changes not yet saved there. */
const DOC_KEY = 'conceptweaver:doc';
const AUTOSAVE_KEY = 'conceptweaver:autosave';

/** A stored setting, also looked for under the app's former name so that nothing saved before the rename is lost. */
const stored = (key: string) => localStorage.getItem(key) ?? localStorage.getItem(key.replace('conceptweaver:', 'termloom:'));
const HISTORY = 100;

function loadModel(): Model {
  try {
    const raw = stored(MODEL_KEY);
    if (raw) return withIris(normalizeModel(JSON.parse(raw)));
  } catch {
    // Unreadable autosave: fall through to the example.
  }
  return withIris(sampleModel());
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

/**
 * How the model in the editor relates to the library of saved models. `saved` is the very model
 * object that was last saved or opened, so "has unsaved changes" is simply "the model is no
 * longer that object" and undoing back to it makes the model clean again.
 */
export interface Doc {
  /** Id of the saved model this is, or null when it has never been saved to the library. */
  id: string | null;
  saved: Model | null;
}

export const isDirty = (s: { model: Model; doc: Doc }) => s.model !== s.doc.saved;

function loadDoc(model: Model): Doc {
  try {
    const d = JSON.parse(localStorage.getItem(DOC_KEY) ?? 'null') as { id?: unknown; dirty?: unknown } | null;
    if (d) return { id: typeof d.id === 'string' ? d.id : null, saved: d.dirty === true ? null : model };
  } catch {
    // Unreadable: treat the working copy as an unsaved model.
  }
  return { id: null, saved: model };
}

interface State {
  model: Model;
  doc: Doc;
  /** Save to the library by itself a moment after each change, for a model that is already in it. */
  libraryAutosave: boolean;
  /** The working copy could not be kept in the browser, so closing the page would lose unsaved changes. */
  workingCopyAtRisk: boolean;
  past: Model[];
  future: Model[];
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
  filter: string;
  theme: Theme;
  subgraph: SubgraphState;
  dialog: 'bulk' | 'settings' | 'library' | 'saveas' | null;
  toast: string | null;

  apply: (fn: (m: Model) => Model, history?: boolean) => void;
  checkpoint: () => void;
  discardLast: () => void;
  undo: () => void;
  redo: () => void;
  /** Puts another model in the editor. `docId` says which saved model it is, if it is one. */
  replaceModel: (m: Model, docId?: string | null) => void;
  /**
   * Saves the model to the library in this browser. A model that is already there is updated;
   * a new one, or any model with `asNew`, needs a `name` and becomes a new entry. Without a
   * name where one is needed, the Save As dialog opens instead. Resolves to whether it was saved.
   */
  saveToLibrary: (opts?: { name?: string; asNew?: boolean; quiet?: boolean }) => Promise<boolean>;
  /** Opens a saved model from the library. */
  openFromLibrary: (id: string) => Promise<boolean>;
  /** Called when the library changed a saved model behind the editor's back (renamed or deleted). */
  syncDoc: (change: { renamed?: { id: string; name: string }; deleted?: string }) => void;
  setLibraryAutosave: (on: boolean) => void;

  addTerm: (p?: Partial<Term>) => string;
  updateTerm: (id: string, patch: Partial<Term>, history?: boolean) => void;
  updateTerms: (ids: string[], patch: Partial<Term>) => void;
  moveTerms: (ids: string[], dx: number, dy: number) => void;
  addRelation: (p: Partial<Relation> & { from: string; to: string }) => string;
  updateRelation: (id: string, patch: Partial<Relation>, history?: boolean) => void;
  reverseRelation: (id: string) => void;
  remove: (terms: string[], rels: string[]) => void;
  deleteSelection: () => void;
  /** Adds new terms and fills in metadata on ones that already exist (matched by name). */
  bulkAddTerms: (items: BulkTerm[]) => { added: number; updated: number };
  /** Adds relationships between terms named in the input; unknown names are created or the line is skipped. */
  bulkAddRelations: (items: BulkRelation[], createMissing: boolean) => { added: number; created: number; skipped: number };
  /** Adds an indented hierarchy: its terms (reusing existing ones by name) and the links between them. */
  bulkAddOutline: (outline: Outline) => { terms: number; rels: number };
  /** Creates a term under `parentId` in the hierarchy (or a top-level one) and returns its id. */
  addNarrower: (parentId: string | null, name: string) => string;
  /** Turns the model into the other type, translating what its relations mean. */
  convertTo: (mode: ModelMode) => void;
  selectProp: (key: string | null) => void;
  /** Declares a new object property and opens it. */
  addProp: () => string;
  /** Makes a relationship label an object property: every relationship carrying it becomes a use. */
  declareProp: (name: string) => void;
  /** Changes what one relationship is: a use of an object property, a plain relationship, "is a" or "has property". */
  setRelChoice: (id: string, choice: RelChoice) => void;
  /** Changes what is declared about an object property, declaring it first if it only existed through use. */
  updateProp: (key: string, patch: Partial<ObjProp>) => void;
  /** Renames an object property everywhere: its declaration, the relationships that use it, and references to it. */
  renameProp: (key: string, name: string) => boolean;
  /** Removes an object property together with the relationships that use it. */
  deleteProp: (key: string) => void;
  /**
   * Saves the ontology IRI, default namespace and prefixes. Existing IRIs are left exactly as they
   * are, except that the entities of each namespace in `moveFrom` are moved into the default namespace.
   */
  setOntologySettings: (d: SettingsDraft, moveFrom?: string[]) => void;
  /** States that one term is a kind of another. Says so if it was already stated, is the term itself, or closes a cycle. */
  addSuperclass: (id: string, superId: string) => void;
  /** Withdraws that statement, and only that one. */
  removeSuperclass: (id: string, superId: string) => void;
  setVocabEnabled: (on: boolean) => void;
  /** Maps every relation with this label to a standard property; an empty property removes the mapping. */
  mapLabel: (label: string, predicate: string) => void;

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
  arrange: (kind: 'hierarchy' | 'force') => void;

  setView: (v: View) => void;
  setEditing: (e: Editing | null) => void;
  setHighlight: (ids: string[], label?: string) => void;
  setFilter: (f: string) => void;
  setTheme: (t: Theme) => void;

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
  setDialog: (d: State['dialog']) => void;
  notify: (msg: string) => void;
}

const pushHistory = (s: State) => ({ past: [...s.past.slice(-(HISTORY - 1)), s.model], future: [] as Model[] });

const prune = (sel: Selection, m: Model): Selection => {
  const t = new Set(m.terms.map((x) => x.id));
  const r = new Set(m.relations.map((x) => x.id));
  return { terms: sel.terms.filter((id) => t.has(id)), rels: sel.rels.filter((id) => r.has(id)) };
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;

const initialModel = loadModel();

export const useStore = create<State>((set, get) => ({
  model: initialModel,
  doc: loadDoc(initialModel),
  libraryAutosave: (() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === 'on';
    } catch {
      return false;
    }
  })(),
  workingCopyAtRisk: false,
  past: [],
  future: [],
  sel: { terms: [], rels: [] },
  selProp: null,
  vp: { x: 0, y: 0, k: 1 },
  canvasSize: { w: 0, h: 0 },
  view: 'graph',
  editing: null,
  highlight: [],
  highlightLabel: '',
  filter: '',
  theme: loadTheme(),
  dialog: null,
  subgraph: NO_SUBGRAPH,
  toast: null,

  apply: (fn, history = true) =>
    set((s) => {
      // Whatever the edit, every named entity ends up with an IRI, made once and then left alone.
      const model = withIris(fn(s.model));
      if (model === s.model) return s;
      return history ? { model, ...pushHistory(s) } : { model };
    }),
  // Moving terms about in a subgraph changes its own layout, not the model, so there is nothing to undo.
  checkpoint: () => set((s) => (s.subgraph.active ? s : pushHistory(s))),
  discardLast: () =>
    set((s) => {
      if (!s.past.length) return s;
      const model = s.past[s.past.length - 1];
      return { model, past: s.past.slice(0, -1), sel: prune(s.sel, model), editing: null };
    }),
  undo: () =>
    set((s) => {
      if (!s.past.length) return s;
      const model = s.past[s.past.length - 1];
      return { model, past: s.past.slice(0, -1), future: [s.model, ...s.future], sel: prune(s.sel, model), editing: null, highlight: [] };
    }),
  redo: () =>
    set((s) => {
      if (!s.future.length) return s;
      const model = s.future[0];
      return { model, past: [...s.past, s.model], future: s.future.slice(1), sel: prune(s.sel, model), editing: null, highlight: [] };
    }),
  replaceModel: (m, docId = null) => {
    const model = withIris(m);
    // A different document: its history starts afresh, and it counts as unchanged until edited.
    set({ model, doc: { id: docId, saved: model }, past: [], future: [], sel: { terms: [], rels: [] }, selProp: null, editing: null, highlight: [], filter: '', subgraph: NO_SUBGRAPH });
    get().fit();
  },
  saveToLibrary: async ({ name, asNew = false, quiet = false } = {}) => {
    const fresh = asNew || !get().doc.id;
    if (fresh && !name?.trim()) {
      set({ dialog: 'saveas' });
      return false;
    }
    if (name?.trim() && name.trim() !== get().model.name) get().apply((m) => ({ ...m, name: name.trim() }));
    // What is saved is the model as it is now; edits made while the browser is writing stay unsaved.
    const model = get().model;
    try {
      const info = await saveToLibraryDb(model, fresh ? undefined : (get().doc.id ?? undefined));
      set({ doc: { id: info.id, saved: model } });
      if (!quiet) get().notify(fresh ? `Saved “${info.name}” to My Models in this browser.` : `Saved “${info.name}”.`);
      return true;
    } catch (e) {
      get().notify(`Not saved. ${e instanceof Error ? e.message : 'The browser could not store the model.'}`);
      return false;
    }
  },
  openFromLibrary: async (id) => {
    try {
      const found = await loadSaved(id);
      if (!found) {
        get().notify('That model is no longer in My Models.');
        return false;
      }
      get().replaceModel(found.model, id);
      // Opening must not itself count as a change (replaceModel may have filled in missing IRIs).
      set((s) => ({ doc: { id, saved: s.model }, view: 'graph' }));
      get().notify(`Opened “${found.info.name}”.`);
      return true;
    } catch (e) {
      get().notify(`Could not open it. ${e instanceof Error ? e.message : ''}`);
      return false;
    }
  },
  syncDoc: ({ renamed, deleted }) => {
    const { doc, model } = get();
    if (deleted && deleted === doc.id) set({ doc: { id: null, saved: null } });
    if (renamed && renamed.id === doc.id && renamed.name !== model.name) {
      // The open model takes the new name too, without that counting as an unsaved change.
      const clean = !isDirty(get());
      get().apply((m) => ({ ...m, name: renamed.name }), false);
      if (clean) set((s) => ({ doc: { ...s.doc, saved: s.model } }));
    }
  },
  setLibraryAutosave: (libraryAutosave) => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, libraryAutosave ? 'on' : 'off');
    } catch {
      // The choice just isn't remembered.
    }
    set({ libraryAutosave });
  },

  addTerm: (p = {}) => {
    const t = newTerm(p);
    // Created while looking at a subgraph: it has to be part of that subgraph to be seen.
    if (get().subgraph.active) set((s) => ({ subgraph: { ...s.subgraph, roots: [...s.subgraph.roots, t.id], pos: { ...s.subgraph.pos, [t.id]: { x: t.x, y: t.y } } } }));
    get().apply((m) => ({ ...m, terms: [...m.terms, t] }));
    return t.id;
  },
  updateTerm: (id, patch, history = true) =>
    get().apply((m) => (m.terms.some((t) => t.id === id) ? { ...m, terms: m.terms.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : m), history),
  updateTerms: (ids, patch) => {
    const set_ = new Set(ids);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => (set_.has(t.id) ? { ...t, ...patch } : t)) }));
  },
  moveTerms: (ids, dx, dy) => {
    if (get().subgraph.active) {
      set((s) => {
        const pos = { ...s.subgraph.pos };
        for (const id of ids) if (pos[id]) pos[id] = { x: pos[id].x + dx, y: pos[id].y + dy };
        return { subgraph: { ...s.subgraph, pos } };
      });
      return;
    }
    const set_ = new Set(ids);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => (set_.has(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t)) }), false);
  },
  addRelation: (p) => {
    const r = newRelation(p);
    get().apply((m) => ({ ...m, relations: [...m.relations, r] }));
    return r.id;
  },
  updateRelation: (id, patch, history = true) =>
    get().apply((m) => (m.relations.some((r) => r.id === id) ? { ...m, relations: m.relations.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : m), history),
  reverseRelation: (id) =>
    get().apply((m) => ({
      ...m,
      relations: m.relations.map((r) => (r.id === id ? { ...r, from: r.to, to: r.from, fromCard: r.toCard, toCard: r.fromCard } : r)),
    })),
  remove: (terms, rels) => {
    if (!terms.length && !rels.length) return;
    const t = new Set(terms);
    const r = new Set(rels);
    get().apply((m) => ({
      ...m,
      terms: m.terms.filter((x) => !t.has(x.id)).map((x) => (x.domain && x.domain.some((id) => t.has(id)) ? { ...x, domain: x.domain.filter((id) => !t.has(id)) } : x)),
      relations: m.relations.filter((x) => !r.has(x.id) && !t.has(x.from) && !t.has(x.to)),
      props: !t.size
        ? m.props
        : m.props.map((p) => ({
            ...p,
            ...(p.domain ? { domain: p.domain.filter((id) => !t.has(id)) } : {}),
            ...(p.range ? { range: p.range.filter((id) => !t.has(id)) } : {}),
          })),
    }));
    set((s) => ({ sel: prune(s.sel, s.model), highlight: [] }));
  },
  deleteSelection: () => get().remove(get().sel.terms, get().sel.rels),
  bulkAddTerms: (items) => {
    const { model, vp, canvasSize } = get();
    const byName = new Map(model.terms.map((t) => [t.name.trim().toLowerCase(), t]));
    const b = bounds(model.terms);
    const origin = b ? { x: b.x0 + 60, y: b.y1 + 90 } : { x: (canvasSize.w / 2 - vp.x) / vp.k - 380, y: (canvasSize.h / 2 - vp.y) / vp.k - 100 };
    const added: Term[] = [];
    const patches = new Map<string, Partial<Term>>();
    for (const p of items) {
      const existing = byName.get(p.name.toLowerCase());
      if (!existing) {
        added.push(
          newTerm({
            name: p.name,
            type: p.type ?? (p.range ? 'property' : 'concept'),
            ...(p.range ? { range: p.range } : {}),
            description: p.description,
            synonyms: p.synonyms,
            color: p.color ?? '',
            fields: p.fields,
            x: origin.x + (added.length % 5) * 190,
            y: origin.y + Math.floor(added.length / 5) * 70,
          }),
        );
        continue;
      }
      // Metadata given for a term that already exists fills in or replaces what is there.
      const patch: Partial<Term> = {};
      if (p.type && p.type !== existing.type) patch.type = p.type;
      if (p.range && p.range !== existing.range) patch.range = p.range;
      if (p.description && p.description !== existing.description) patch.description = p.description;
      if (p.synonyms && p.synonyms !== existing.synonyms) patch.synonyms = p.synonyms;
      if (p.color !== undefined && p.color !== existing.color) patch.color = p.color;
      if (p.fields.length) {
        const keys = new Set(p.fields.map((f) => f.key.toLowerCase()));
        patch.fields = [...existing.fields.filter((f) => !keys.has(f.key.toLowerCase())), ...p.fields];
      }
      if (Object.keys(patch).length) patches.set(existing.id, patch);
    }
    if (!added.length && !patches.size) return { added: 0, updated: 0 };
    get().apply((m) => ({ ...m, terms: [...m.terms.map((t) => (patches.has(t.id) ? { ...t, ...patches.get(t.id) } : t)), ...added] }));
    set({ sel: { terms: [...added.map((t) => t.id), ...patches.keys()], rels: [] } });
    if (added.length) get().fit();
    return { added: added.length, updated: patches.size };
  },
  bulkAddRelations: (items, createMissing) => {
    const { model, vp, canvasSize } = get();
    const wasEmpty = !model.terms.length;
    const byName = new Map(model.terms.map((t) => [t.name.trim().toLowerCase(), t]));
    const b = bounds(model.terms);
    const origin = b ? { x: b.x0 + 60, y: b.y1 + 90 } : { x: (canvasSize.w / 2 - vp.x) / vp.k, y: (canvasSize.h / 2 - vp.y) / vp.k };
    const created: Term[] = [];
    const rels: Relation[] = [];
    const existing = new Set(model.relations.map((r) => `${r.from}|${r.to}|${r.kind}|${r.label.trim().toLowerCase()}`));
    let skipped = 0;
    const resolve = (name: string) => {
      let t = byName.get(name.toLowerCase());
      if (!t && createMissing) {
        t = newTerm({ name, x: origin.x + (created.length % 5) * 190, y: origin.y + Math.floor(created.length / 5) * 70 });
        byName.set(name.toLowerCase(), t);
        created.push(t);
      }
      return t;
    };
    for (const r of items) {
      // Look both ends up before creating either, so a skipped line leaves nothing behind.
      if (!createMissing && (!byName.has(r.from.toLowerCase()) || !byName.has(r.to.toLowerCase()))) {
        skipped++;
        continue;
      }
      const from = resolve(r.from)!;
      const to = resolve(r.to)!;
      const key = `${from.id}|${to.id}|${r.kind}|${r.label.trim().toLowerCase()}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      // In a concept scheme, labels such as "related" or "exact match" mean the SKOS property itself.
      const std = model.mode === 'skos' && r.kind === 'association' ? suggestFor(model, r.label) : undefined;
      if (std?.hierarchical) rels.push(newRelation({ from: from.id, to: to.id, kind: 'generalization' }));
      else if (std) rels.push(newRelation({ from: from.id, to: to.id, predicate: std.id }));
      else rels.push(newRelation({ from: from.id, to: to.id, label: r.label, kind: r.kind }));
    }
    if (!rels.length) return { added: 0, created: 0, skipped };
    get().apply((m) => ({ ...m, terms: [...m.terms, ...created], relations: [...m.relations, ...rels] }));
    if (wasEmpty) {
      const pos = hierarchyLayout(get().model);
      get().apply((m) => ({ ...m, terms: m.terms.map((t) => ({ ...t, ...pos.get(t.id) })) }), false);
    }
    set({ sel: { terms: created.map((t) => t.id), rels: rels.map((r) => r.id) } });
    get().fit();
    return { added: rels.length, created: created.length, skipped };
  },
  bulkAddOutline: (outline) => {
    const { model } = get();
    const byName = new Map(model.terms.map((t) => [t.name.trim().toLowerCase(), t]));
    const created: Term[] = [];
    for (const name of outline.terms) {
      if (byName.has(name.toLowerCase())) continue;
      const t = newTerm({ name });
      byName.set(name.toLowerCase(), t);
      created.push(t);
    }
    const existing = new Set(model.relations.filter((r) => r.kind === 'generalization').map((r) => `${r.from}|${r.to}`));
    const rels: Relation[] = [];
    for (const r of outline.rels) {
      const from = byName.get(r.from.toLowerCase())!;
      const to = byName.get(r.to.toLowerCase())!;
      if (existing.has(`${from.id}|${to.id}`)) continue;
      existing.add(`${from.id}|${to.id}`);
      rels.push(newRelation({ from: from.id, to: to.id, kind: 'generalization' }));
    }
    if (!created.length && !rels.length) return { terms: 0, rels: 0 };
    // Lay the new terms out as a tree of their own, below whatever is already on the canvas.
    const fresh = new Set(created.map((t) => t.id));
    const pos = hierarchyLayout({ ...model, terms: created, relations: rels.filter((r) => fresh.has(r.from) && fresh.has(r.to)) });
    const b = bounds(model.terms);
    const xs = [...pos.values()].map((p) => p.x);
    const dx = b ? (b.x0 + b.x1) / 2 - (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
    const dy = b ? b.y1 + 130 : 0;
    for (const t of created) Object.assign(t, { x: pos.get(t.id)!.x + dx, y: pos.get(t.id)!.y + dy });
    get().apply((m) => ({ ...m, terms: [...m.terms, ...created], relations: [...m.relations, ...rels] }));
    set({ sel: { terms: created.map((t) => t.id), rels: [] } });
    get().fit();
    return { terms: created.length, rels: rels.length };
  },
  addNarrower: (parentId, name) => {
    const { model, vp, canvasSize } = get();
    const parent = model.terms.find((t) => t.id === parentId);
    const siblings = parent ? model.relations.filter((r) => r.kind === 'generalization' && r.to === parent.id).length : 0;
    const b = bounds(model.terms);
    // Under its parent, fanning out to the right; a top-level term goes beside everything else.
    const at = parent
      ? { x: parent.x + (siblings - 0.5) * 170, y: parent.y + 110 + (siblings % 2) * 26 }
      : b
        ? { x: b.x1 + 130, y: b.y0 + 20 }
        : { x: (canvasSize.w / 2 - vp.x) / vp.k, y: (canvasSize.h / 2 - vp.y) / vp.k };
    const t = newTerm({ name, x: Math.round(at.x), y: Math.round(at.y), color: parent?.color ?? '' });
    get().apply((m) => ({
      ...m,
      terms: [...m.terms, t],
      relations: parent ? [...m.relations, newRelation({ from: t.id, to: parent.id, kind: 'generalization' })] : m.relations,
    }));
    return t.id;
  },
  convertTo: (mode) => {
    const before = get().model;
    if (before.mode === mode) return;
    get().apply((m) => convertModel(m, mode));
  },
  selectProp: (selProp) => set({ selProp, sel: { terms: [], rels: [] } }),
  addProp: () => {
    const taken = new Set(get().model.props.map((p) => propKey(p.name)));
    let name = 'new property';
    for (let i = 2; taken.has(propKey(name)) || findProp(get().model, propKey(name)); i++) name = `new property ${i}`;
    get().apply((m) => ({ ...m, props: [...m.props, { name, description: '', chars: [] }] }));
    set({ selProp: propKey(name), sel: { terms: [], rels: [] } });
    return propKey(name);
  },
  declareProp: (name) => {
    const clean = name.trim() || 'related to';
    if (findProp(get().model, propKey(clean))) return;
    get().apply((m) => ({
      ...m,
      props: [...m.props, { name: clean, description: '', chars: [] }],
      // Every relationship with the label becomes a use. Unlabelled ones get the name, so that
      // they keep pointing at the property if it is renamed.
      relations: m.relations.map((r) => {
        if (r.kind !== 'association' || r.predicate || propKey(r.label) !== propKey(clean)) return r;
        const { plain: _plain, ...rest } = r;
        return { ...rest, label: r.label.trim() || clean };
      }),
    }));
  },
  setRelChoice: (id, choice) =>
    get().apply((m) => {
      const rel = m.relations.find((r) => r.id === id);
      if (!rel) return m;
      const { plain: _plain, predicate: _predicate, ...base } = rel;
      if (choice === 'property') return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...base, kind: choice } : r)) };
      if (choice === 'generalization') {
        // "Is a" restricts nothing, so a quantifier left over from before goes.
        const { restriction: _restriction, restrictionN: _n, ...bare } = base;
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...bare, kind: choice } : r)) };
      }
      const key = propKey(rel.label);
      const declared = m.props.some((p) => propKey(p.name) === key);
      if (choice === 'plain') {
        // The flag is only needed where the label would otherwise make it a use of a property.
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...base, kind: 'association', ...(declared ? { plain: true } : {}) } : r)) };
      }
      const name = rel.label.trim() || 'related to';
      return {
        ...m,
        // Declared on the spot if need be. Other relationships that merely share the label stay plain.
        props: declared ? m.props : [...m.props, { name, description: '', chars: [] }],
        relations: m.relations.map((r) =>
          r.id === id
            ? { ...base, kind: 'association', label: name }
            : !declared && r.kind === 'association' && !r.predicate && propKey(r.label) === key
              ? { ...r, plain: true }
              : r,
        ),
      };
    }),
  updateProp: (key, patch) =>
    get().apply((m) => {
      const next = { ...declaredProp(m, key), ...patch };
      // An emptied optional field means "not set", so it isn't stored.
      for (const k of ['domain', 'range', 'inverseOf', 'parent'] as const) if (next[k] === undefined) delete next[k];
      const exists = m.props.some((p) => propKey(p.name) === key);
      return { ...m, props: exists ? m.props.map((p) => (propKey(p.name) === key ? next : p)) : [...m.props, next] };
    }),
  renameProp: (key, name) => {
    const to = propKey(name);
    const clean = name.trim();
    if (!clean) return false;
    if (to !== key && findProp(get().model, to)) {
      get().notify(`There is already a property called “${clean}”.`);
      return false;
    }
    get().apply((m) => {
      const entry = { ...declaredProp(m, key), name: clean };
      const others = m.props.filter((p) => propKey(p.name) !== key).map((p) => ({
        ...p,
        ...(p.inverseOf === key ? { inverseOf: to } : {}),
        ...(p.parent === key ? { parent: to } : {}),
      }));
      return {
        ...m,
        props: [...others, { ...entry, ...(entry.inverseOf === key ? { inverseOf: to } : {}) }],
        relations: m.relations.map((r) => (r.kind === 'association' && !r.predicate && propKey(r.label) === key ? { ...r, label: clean } : r)),
      };
    });
    set((s) => (s.selProp === key ? { selProp: to } : s));
    return true;
  },
  deleteProp: (key) => {
    get().apply((m) => ({
      ...m,
      props: m.props
        .filter((p) => propKey(p.name) !== key)
        .map((p) => {
          const { inverseOf, parent, ...rest } = p;
          return { ...rest, ...(inverseOf && inverseOf !== key ? { inverseOf } : {}), ...(parent && parent !== key ? { parent } : {}) };
        }),
      relations: m.relations.filter((r) => !(r.kind === 'association' && !r.predicate && propKey(r.label) === key)),
    }));
    set((s) => ({ selProp: s.selProp === key ? null : s.selProp, sel: prune(s.sel, s.model), highlight: [] }));
  },
  setOntologySettings: (d, moveFrom = []) =>
    get().apply((m) => {
      const next = { ...m, ontologyIri: d.ontologyIri, baseIri: d.baseIri, prefixes: d.prefixes };
      return moveFrom.reduce((acc, from) => moveNamespace(acc, from, baseIriOf(next)), next);
    }),
  addSuperclass: (id, superId) => {
    const { model } = get();
    const name = (x: string) => model.terms.find((t) => t.id === x)?.name || 'Unnamed';
    if (id === superId) return get().notify('A class cannot be its own superclass.');
    if (assertedSuperclasses(model, id).includes(superId)) return get().notify(`“${name(superId)}” is already an asserted superclass of “${name(id)}”.`);
    const cycle = wouldCycle(model, id, superId);
    get().apply((m) => ({ ...m, relations: [...m.relations, newRelation({ from: id, to: superId, kind: 'generalization' })] }));
    // Allowed, since OWL allows it (the classes become equivalent), but rarely what was meant.
    if (cycle) get().notify(`“${name(superId)}” is already a kind of “${name(id)}”, so the two are now each other's superclass. Checks lists this as a circular hierarchy.`);
  },
  removeSuperclass: (id, superId) =>
    get().apply((m) => {
      // Every statement of it goes (a duplicate would otherwise keep it alive), and nothing else.
      const stated = new Set(resolveModel(m).relations.filter((r) => r.kind === 'generalization' && r.from === id && r.to === superId).map((r) => r.id));
      return stated.size ? { ...m, relations: m.relations.filter((r) => !stated.has(r.id)) } : m;
    }),
  setVocabEnabled: (enabled) => get().apply((m) => ({ ...m, vocab: { ...m.vocab, enabled } })),
  mapLabel: (label, predicate) =>
    get().apply((m) => {
      const { [labelKey(label)]: _old, ...rest } = m.vocab.map;
      return { ...m, vocab: { ...m.vocab, map: predicate ? { ...rest, [labelKey(label)]: predicate } : rest } };
    }),

  select: (terms, rels = []) => set((s) => ({ sel: { terms, rels }, selProp: terms.length || rels.length ? null : s.selProp })),
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
    set({ view: 'graph', sel: { terms: [id], rels: [] }, vp: { ...vp, x: canvasSize.w / 2 - t.x * vp.k, y: canvasSize.h / 2 - t.y * vp.k } });
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
      const k = Math.min(3, Math.max(0.1, s.vp.k * factor));
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
    const k = Math.min(1.25, Math.max(0.1, Math.min(w / (b.x1 - b.x0 + pad * 2), h / (b.y1 - b.y0 + pad * 2))));
    set({ vp: { k, x: w / 2 - ((b.x0 + b.x1) / 2) * k, y: h / 2 - ((b.y0 + b.y1) / 2) * k } });
  },
  arrange: (kind) => {
    if (get().subgraph.active) {
      // Only the subgraph's own layout is redone; the full graph keeps its arrangement.
      const laid = (kind === 'force' ? forceLayout : hierarchyLayout)(viewOf(get()));
      set((s) => ({ subgraph: { ...s.subgraph, pos: Object.fromEntries(laid) } }));
      get().fit();
      return;
    }
    const pos = (kind === 'force' ? forceLayout : hierarchyLayout)(get().model);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => ({ ...t, ...pos.get(t.id) })) }));
    get().fit();
  },

  setView: (view) => set({ view }),
  setEditing: (editing) => set({ editing }),
  setHighlight: (highlight, highlightLabel = '') => set({ highlight, highlightLabel }),
  setFilter: (filter) => set({ filter }),
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
      const laid = hierarchyLayout({ ...model, terms: model.terms.filter((t) => visible.has(t.id)), relations: model.relations.filter((r) => rels.has(r.id)) });
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
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
    set({ theme });
  },
  setDialog: (dialog) => set({ dialog }),
  notify: (toast) => {
    clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(() => set({ toast: null }), 4000);
  },
}));

// Autosave: the model lives in this browser's storage until it is saved to a file.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let libraryTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.doc !== prev.doc || s.model !== prev.model) {
    // Remembered across reloads: which saved model this is, and whether it has moved on from it.
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify({ id: s.doc.id, dirty: isDirty(s) }));
    } catch {
      // ignore
    }
  }
  if (s.model === prev.model) return;
  // An edit can add or remove what the subgraph shows.
  if (s.subgraph.active) s.refreshSubgraph();
  if (s.model.mode !== prev.model.mode) {
    // Remembered so that the next new model is of the type being worked on.
    try {
      localStorage.setItem(MODE_KEY, s.model.mode);
    } catch {
      // ignore
    }
  }
  // The working copy: whatever is in the editor is kept in this browser as it is edited, saved
  // to the library or not, so that a reload or a crash loses nothing.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(useStore.getState().model));
      if (useStore.getState().workingCopyAtRisk) useStore.setState({ workingCopyAtRisk: false });
    } catch {
      useStore.setState({ workingCopyAtRisk: true });
      useStore.getState().notify('This model is too large to keep as a working copy in the browser. Save it to My Models or to a file before closing the page.');
    }
  }, 300);
  // Optional: a model that is already in the library is saved there too, a little after each change.
  clearTimeout(libraryTimer);
  if (s.libraryAutosave && s.doc.id && isDirty(s)) {
    libraryTimer = setTimeout(() => {
      const now = useStore.getState();
      if (now.libraryAutosave && now.doc.id && isDirty(now)) void now.saveToLibrary({ quiet: true });
    }, 1500);
  }
});

/**
 * Asks before the model in the editor is replaced by another, if it has changes that are not
 * saved. Returns whether to go ahead.
 */
export function confirmDiscard(): boolean {
  const s = useStore.getState();
  if (!isDirty(s) || !s.model.terms.length) return true;
  return window.confirm(`“${s.model.name}” has changes that are not saved to My Models.\n\nReplace it anyway? The unsaved changes will be lost.`);
}

/** A blank model of the type last worked on, so SKOS work starts in SKOS. */
export const newModel = () => {
  const m = emptyModel();
  try {
    if (stored(MODE_KEY) === 'skos') m.mode = 'skos';
  } catch {
    // ignore
  }
  useStore.getState().replaceModel(m);
};
