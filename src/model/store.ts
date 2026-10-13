import { create } from 'zustand';
import type { BulkRelation, BulkTerm, Outline } from './bulk';
import { findPath } from './checks';
import { bounds, type Anchor } from './geometry';
import { hierarchyLayout } from './layout';
import { builtIn } from '../layout/compute';
import { graphOf } from '../layout/graph';
import { LayoutCancelled, runLayout } from '../layout/run';
import { LAYOUTS, noLayout, type GraphLayout, type LayoutKind, type Places } from '../layout/types';
import { sampleModel } from './sample';
import { convertModel } from './convert';
import { declaredProp, findProp, propKey, relChoices, type RelChoice } from './props';
import { cannotRelate, settleRelation, typed } from './relating';
import { reconnect, type End } from './reconnect';
import { labelKey, resolveModel, suggestFor } from './vocab';
import { DEFAULT_MAX_NODES, extractSubgraph, MAX_DEPTH, type Direction, type Subgraph } from './subgraph';
import { checkValues, metaEntity, registry, withProfile, writeValues, type MetaOwner, type MetaValue } from './governance';
import { normalizeByKind, PALETTE, patchNodes, resetOwn, withAnchor, withoutAnchors, type GraphStyle, type SavedStyle } from './graphStyle';
import { allowsKind, allowsView, configOf, supports, termTypeFor, viewFor, type View } from './modelTypes';
import { baseIriOf, moveNamespace, withIris } from './iri';
import { loadModel as loadSaved, saveModel as saveToLibraryDb } from './library';
import type { SettingsDraft } from './prefixes';
import { makeInstanceOf, type Edit } from './axioms';
import { addExternal, importsClosure, readExternal, removeExternal, type Collision, type ExternalSummary } from './external';
import { collisions } from './external';
import { listMappings } from './alignment';
import { cachedOntology, cachedOntologyByIri, cacheOntology, uncacheOntology } from './library';
import { MODEL_DATA, validate, type DataGraph, type Scope, type ValidationRun } from './validation';
import { askReasoner, DEFAULT_REASONER_URL, dlRequest, type EngineId, type ReasoningResult } from './reasoning';
import { stable } from './stable';
import { assertedSuperclasses, isInstanceOf, wouldCycle } from './props';
import { classIriOf } from '../structure/local';
import type { HierarchyMode, Iri } from '../structure/contracts';
import { LIST_KINDS, type EntitySort, type FilterValues, type ListKind } from '../entities/contracts';
import { emptyModel, INSTANCE_OF, PROP_LINKS, type EntityKind, type ModelMode, type Shapes, type ObjProp, newRelation, newTerm, normalizeModel, type Model, type Relation, type Term, type TermType } from './types';

export type { View } from './modelTypes';
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
  /** How the subgraph is arranged: a layout of its own, chosen apart from the full graph's. */
  layout: GraphLayout;
}

const NO_SUBGRAPH: SubgraphState = { active: false, roots: [], depth: 1, direction: 'both', off: [], expanded: [], hidden: [], maxNodes: DEFAULT_MAX_NODES, pos: {}, result: null, layout: noLayout('hierarchy') };

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

/** Terms gliding from where they were to where a layout put them. `p` goes from 0 to 1. */
export interface Tween {
  from: Places;
  p: number;
}

/** How far out the view goes: far enough to see all of a wide tree of a few hundred terms. */
const MIN_ZOOM = 0.03;

/** Above this many terms and relationships a new arrangement is shown at once: gliding them would stutter. */
const GLIDE = { terms: 300, relations: 700, ms: 380 };

interface Selection {
  terms: string[];
  rels: string[];
}

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
const noEntityViews = () => Object.fromEntries(LIST_KINDS.map((k) => [k, NO_ENTITY_VIEW])) as Record<ListKind, EntityViewState>;

const MODEL_KEY = 'conceptweaver:model:v1';
const THEME_KEY = 'conceptweaver:theme';
/** Which saved model the working copy belongs to, and whether it has changes not yet saved there. */
const DOC_KEY = 'conceptweaver:doc';
const AUTOSAVE_KEY = 'conceptweaver:autosave';

/** A stored setting, also looked for under the app's former name so that nothing saved before the rename is lost. */
const stored = (key: string) => localStorage.getItem(key) ?? localStorage.getItem(key.replace('conceptweaver:', 'termloom:'));
const STYLES_KEY = 'conceptweaver:graph-styles';

/** The graph styles saved under a name in this browser, to use in any model. */
function loadSavedStyles(): SavedStyle[] {
  try {
    const list = JSON.parse(localStorage.getItem(STYLES_KEY) ?? '[]') as unknown;
    return (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).filter((x) => x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim()).map((x) => ({ name: (x.name as string).trim(), ...normalizeByKind(x) }));
  } catch {
    return [];
  }
}

/** The last change to the graph style: a drag on a slider or in a colour picker is one step to undo, not fifty. */
let lastStyleEdit = { key: '', at: 0 };
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
  /** Goes up each time another model is put in the editor, so that views can start afresh for it. */
  docSeq: number;
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
  /** Whether the canvas also draws the class memberships the reasoner works out. A way of looking; never part of the model. */
  showInferred: boolean;
  setShowInferred: (on: boolean) => void;
  /** Whether the canvas draws a line from each enumeration class to the individuals it lists. */
  showEnumerations: boolean;
  setShowEnumerations: (on: boolean) => void;
  /** Whether the graph style panel is open on the canvas. */
  stylePanel: boolean;
  setStylePanel: (open: boolean) => void;
  /**
   * Changes how the graph is drawn. Nothing about the ontology changes. Changes that share a
   * `gesture` and follow each other closely are undone together.
   */
  setStyle: (fn: (s: GraphStyle) => GraphStyle, gesture?: string) => void;
  /**
   * Gives single terms a fill of their own, or takes it away. One of the canvas colours is kept
   * as the term's colour, exactly as the canvas menu sets it; any other is kept in the style.
   */
  setOwnFill: (ids: string[], fill: string | undefined) => void;
  /** Takes away the look single terms and relationships were given: their own style, and a term's canvas colour. */
  resetOwnStyle: (terms: string[] | 'all', rels: string[] | 'all') => void;
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
  subgraph: SubgraphState;
  /** The search, the order and the filters of each list of the Entities page. */
  entityViews: Record<ListKind, EntityViewState>;
  setEntityView: (kind: ListKind, patch: Partial<EntityViewState>) => void;
  /** Whether the panel of filters is open. It is the page's, not a list's: open, it stays open from tab to tab. */
  entityFiltersOpen: boolean;
  setEntityFiltersOpen: (open: boolean) => void;
  dialog: 'bulk' | 'settings' | 'library' | 'saveas' | 'new' | 'openurl' | null;
  toast: string | null;
  /**
   * The validation workbench. Results are a record of one run over one model: they live here,
   * beside the model, and are never saved with it or undone with it.
   */
  validation: {
    run: ValidationRun | null;
    running: boolean;
    /** What the run in progress is doing, for showing while it works. */
    phase: string;
    /** The data graph SHACL validates. */
    data: DataGraph;
    tab: 'results' | 'shapes' | 'rules' | 'inferences';
    /** The shape open in the shape editor. */
    shapeId: string | null;
    /** Which reasoner answers the OWL questions: the app's own rules, or the OWL 2 DL reasoning service. */
    engine: EngineId;
    /** Where the reasoning service is. */
    reasonerUrl: string;
    /** A finding to open in the results, asked for from elsewhere on the page. */
    focus: string | null;
  };
  graphScope: GraphScope;
  setGraphScope: (scope: GraphScope) => void;
  structure: StructureState;
  setStructure: (patch: Partial<Pick<StructureState, 'mode' | 'hierarchy' | 'markInferred' | 'focus' | 'search' | 'compare'>>) => void;
  /**
   * Other ontologies. Their content is read from the browser's cache into `loaded` and is never
   * part of the model; `missing` are the ones the model refers to whose content is not in this browser.
   */
  ext: {
    loaded: Record<string, Model>;
    missing: string[];
    tab: 'library' | 'align' | 'mappings' | 'suggestions';
    selected: string | null;
    /** An ontology that has been read and is waiting for the user to say what to do with it. */
    preview: { summary: ExternalSummary; text: string; collisions: Collision[] } | null;
  };
  setExt: (patch: Partial<Pick<State['ext'], 'tab' | 'selected' | 'preview'>>) => void;
  /** Reads an ontology and shows what it is, without adding anything. Returns why it could not be read, if so. */
  previewExternal: (text: string, source: string, kind: 'file' | 'url' | 'model') => string | undefined;
  /** Adds the previewed ontology to the library; as a dependency (owl:imports) or only to browse and reuse. */
  confirmExternal: (imports: boolean) => string | undefined;
  /** Brings the content of the model's external ontologies in from the browser's cache. */
  loadExternals: () => Promise<void>;
  removeExternalRef: (id: string) => string | undefined;
  /** Runs the checks in `scope`. A run already under way is left to finish. */
  runValidation: (scope?: Scope) => Promise<void>;
  setValidation: (patch: Partial<Pick<State['validation'], 'data' | 'tab' | 'shapeId' | 'engine' | 'reasonerUrl' | 'focus'>>) => void;
  /** Changes the model's SHACL shapes; an edit like any other, so it can be undone and is saved with the model. */
  setShapes: (fn: (s: Shapes) => Shapes) => void;

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
  /**
   * Adds a relationship and gives its id. In an ontology what it is follows from what it joins
   * and what it is called (see relating.ts); two terms that cannot be related are not, the reason
   * is shown, and the id is empty.
   */
  addRelation: (p: Partial<Relation> & { from: string; to: string }, history?: boolean) => string;
  updateRelation: (id: string, patch: Partial<Relation>, history?: boolean) => void;
  reverseRelation: (id: string) => void;
  /**
   * Moves one end of a relationship to another term, as one step that undo takes back. What the
   * relationship is stays what it was (see reconnect.ts): where the two cannot be related in that
   * way nothing changes, the reason is shown, and the answer is false.
   */
  reconnectRelation: (id: string, end: End, termId: string) => boolean;
  /**
   * Puts one end of a relationship at a place on the outline of its term, or lets it be placed
   * automatically again. It is part of how the graph is drawn: the ontology says nothing else for it.
   */
  setAnchor: (id: string, end: End, anchor: Anchor | undefined, gesture?: string) => void;
  /** Lets both ends of these relationships, or of every relationship, be placed automatically again. */
  resetAnchors: (ids: string[] | 'all') => void;
  remove: (terms: string[], rels: string[]) => void;
  deleteSelection: () => void;
  /** Adds new terms and fills in metadata on ones that already exist (matched by name). */
  bulkAddTerms: (items: BulkTerm[]) => { added: number; updated: number };
  /** Adds relationships between terms named in the input; unknown names are created or the line is skipped. */
  bulkAddRelations: (items: BulkRelation[], createMissing: boolean) => { added: number; created: number; skipped: number };
  /** Adds an indented hierarchy: its terms (reusing existing ones by name) and the links between them. */
  bulkAddOutline: (outline: Outline) => { terms: number; rels: number };
  /** Turns the model into the other type, translating what its relations mean. */
  convertTo: (mode: ModelMode) => void;
  selectProp: (key: string | null) => void;
  /** Declares a new object property and opens it. */
  addProp: () => string;
  /** Makes a relationship label an object property: every relationship carrying it becomes a use. */
  declareProp: (name: string) => void;
  /**
   * Changes what one relationship is: a use of an object property, a plain relationship, "is a",
   * "is instance of" or "has property". Says whether it did: a kind the two terms cannot have is
   * refused, with a notice saying why.
   */
  setRelChoice: (id: string, choice: RelChoice, history?: boolean) => boolean;
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
  /**
   * Makes one of the edits of the entity editor (see axioms.ts). A refused edit changes nothing
   * and its reason is returned, for the editor to show where the edit was tried; anything worth
   * knowing about an accepted one is shown as a notice.
   */
  edit: (fn: (m: Model) => Edit) => string | undefined;
  /** Sets what an entity has for one metadata field. Returns the reason if the values were refused. */
  setMeta: (owner: MetaOwner, fieldId: string, values: MetaValue[]) => string | undefined;
  /** Gives a term a metadata profile (business or technical data asset), or takes it away again. */
  setProfile: (termId: string, kind: EntityKind) => void;
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
  /** The layout being worked out, while one is. */
  layoutBusy: LayoutKind | null;
  /** Terms on their way to a new arrangement. */
  tween: Tween | null;
  endTween: () => void;

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
  /** Something to tell that takes longer to read than a notice is shown for, such as why a file could not be opened: it stays until it is dismissed. */
  message: { title: string; text: string } | null;
  showMessage: (title: string, text: string) => void;
  dismissMessage: () => void;
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

/** The widths the sidebar on the left can be given: narrow enough to be out of the way, wide enough for long names. */
export const SIDEBAR_WIDTH = { min: 180, max: 720, initial: 232 } as const;
const sidebarWidthOf = (width: number) => (Number.isFinite(width) ? Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width))) : SIDEBAR_WIDTH.initial);

/**
 * The OWL 2 DL reasoner's result for the model as it is now. There is none once the model has
 * changed since it was asked, when it gave no answer, or when the other reasoner is the one
 * chosen: an old result, or one of the engine that was switched away from, is never shown as current.
 */
export const currentDl = (s: Pick<State, 'model' | 'validation'>): ReasoningResult | undefined => {
  const run = s.validation.run;
  return s.validation.engine === 'dl' && run?.dl && run.model === stable(s.model) && run.dl.result.status !== 'failed' ? run.dl.result : undefined;
};

/**
 * The Structure Explorer follows what is pointed at elsewhere: when one term is selected and it
 * is a class, that class is in focus there too. Anything else leaves its focus where it was.
 */
const pointingAt = (s: Pick<State, 'model' | 'structure'>, terms: string[], rels: string[] = []): StructureState => {
  const iri = terms.length === 1 && !rels.length ? classIriOf(s.model, terms[0]) : undefined;
  return iri === undefined ? s.structure : { ...s.structure, focus: iri, pointed: s.structure.pointed + 1 };
};

export const useStore = create<State>((set, get) => ({
  model: initialModel,
  doc: loadDoc(initialModel),
  docSeq: 0,
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
  setStyle: (fn, gesture = '') => {
    const now = Date.now();
    const same = !!gesture && gesture === lastStyleEdit.key && now - lastStyleEdit.at < 1200;
    lastStyleEdit = { key: gesture, at: now };
    get().apply((m) => {
      const style = fn(m.style);
      return style === m.style ? m : { ...m, style };
    }, !same);
  },
  setOwnFill: (ids, fill) => {
    const swatch = (PALETTE as readonly string[]).includes(fill ?? '') ? fill! : '';
    const set_ = new Set(ids);
    get().apply((m) => ({ ...m, terms: m.terms.map((t) => (set_.has(t.id) && t.color !== swatch ? { ...t, color: swatch } : t)), style: patchNodes(m.style, ids, { fill: swatch ? undefined : fill }) }));
  },
  resetOwnStyle: (terms, rels) =>
    get().apply((m) => {
      const termIds = terms === 'all' ? m.terms.map((t) => t.id) : terms;
      const relIds = rels === 'all' ? m.relations.map((r) => r.id) : rels;
      const set_ = new Set(termIds);
      return { ...m, terms: m.terms.map((t) => (set_.has(t.id) && t.color ? { ...t, color: '' } : t)), style: resetOwn(m.style, termIds, relIds) };
    }),
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
  dialog: null,
  subgraph: NO_SUBGRAPH,
  entityViews: noEntityViews(),
  setEntityView: (kind, patch) => set((s) => ({ entityViews: { ...s.entityViews, [kind]: { ...s.entityViews[kind], ...patch } } })),
  entityFiltersOpen: false,
  setEntityFiltersOpen: (entityFiltersOpen) => set({ entityFiltersOpen }),
  toast: null,
  graphScope: 'all',
  setGraphScope: (graphScope) => {
    set({ graphScope });
    get().fit();
  },
  structure: { mode: 'explore', hierarchy: 'asserted', markInferred: true, focus: null, pointed: 0, search: '', compare: { a: null, b: null } },
  setStructure: (patch) => set((s) => ({ structure: { ...s.structure, ...patch } })),
  ext: { loaded: {}, missing: [], tab: 'library', selected: null, preview: null },
  setExt: (patch) => set((s) => ({ ext: { ...s.ext, ...patch } })),
  previewExternal: (text, source, kind) => {
    try {
      const summary = readExternal(text, source, kind);
      set((s) => ({ ext: { ...s.ext, preview: { summary, text, collisions: collisions(get().model, summary.model) } } }));
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : 'It could not be read.';
    }
  },
  confirmExternal: (imports) => {
    const preview = get().ext.preview;
    if (!preview) return undefined;
    const { model, ref } = addExternal(get().model, preview.summary, imports);
    get().apply(() => model);
    set((s) => ({ ext: { ...s.ext, preview: null, selected: ref.id, loaded: { ...s.ext.loaded, [ref.id]: preview.summary.model }, missing: s.ext.missing.filter((x) => x !== ref.id) } }));
    // Kept in this browser so that it is there next time; the model itself holds only the reference.
    cacheOntology(ref.id, ref.iri, preview.text).catch((e) => get().notify(`“${ref.name}” is in the library for now, but could not be kept in the browser: ${e instanceof Error ? e.message : ''}`));
    return ref.id;
  },
  loadExternals: async () => {
    const refs = get().model.externals;
    const loaded: Record<string, Model> = {};
    const missing: string[] = [];
    for (const ref of refs) {
      if (get().ext.loaded[ref.id]) {
        loaded[ref.id] = get().ext.loaded[ref.id];
        continue;
      }
      try {
        const hit = (await cachedOntology(ref.id)) ?? (await cachedOntologyByIri(ref.iri));
        if (hit) loaded[ref.id] = readExternal(hit.text, ref.source || ref.name, ref.sourceKind).model;
        else missing.push(ref.id);
      } catch {
        missing.push(ref.id);
      }
    }
    set((s) => ({ ext: { ...s.ext, loaded, missing } }));
  },
  removeExternalRef: (id) => {
    const result = removeExternal(get().model, id);
    if (result.error !== undefined) return result.error;
    get().apply(() => result.model);
    set((s) => ({ ext: { ...s.ext, selected: s.ext.selected === id ? null : s.ext.selected } }));
    void uncacheOntology(id).catch(() => undefined);
    return undefined;
  },
  validation: {
    run: null,
    running: false,
    phase: '',
    data: MODEL_DATA,
    tab: 'results',
    shapeId: null,
    focus: null,
    ...(() => {
      try {
        return { engine: (localStorage.getItem('conceptweaver:reasoning-engine') === 'dl' ? 'dl' : 'fast') as EngineId, reasonerUrl: localStorage.getItem('conceptweaver:reasoner-url') || DEFAULT_REASONER_URL };
      } catch {
        return { engine: 'fast' as EngineId, reasonerUrl: DEFAULT_REASONER_URL };
      }
    })(),
  },
  runValidation: async (scope = 'all') => {
    if (get().validation.running || !supports(get().model, 'validation')) return;
    const { model } = get();
    const { run, data, engine, reasonerUrl } = get().validation;
    set((s) => ({ validation: { ...s.validation, running: true, phase: 'Starting…' } }));
    try {
      // Between parts the page gets a moment to redraw, so a long validation shows its progress.
      const closure = model.externals.some((e) => e.imports) ? importsClosure(model, new Map(Object.entries(get().ext.loaded))).model : undefined;
      // The OWL 2 DL reasoner is given the ontology as it is exported, and what it imports as it was read:
      // the Turtle kept in this browser. An import that is not there is named in the answer.
      const askDl =
        engine === 'dl' && supports(model, 'reasoning')
          ? async () => {
              const imports: { iri: string; text: string }[] = [];
              for (const ref of model.externals) {
                if (!ref.imports || !ref.iri) continue;
                const hit = await cachedOntology(ref.id).catch(() => undefined);
                if (hit) imports.push({ iri: ref.iri, text: hit.text });
              }
              return askReasoner(reasonerUrl, dlRequest(model, imports));
            }
          : undefined;
      const next = await validate(
        model,
        data,
        scope,
        run,
        async (phase) => {
          set((s) => ({ validation: { ...s.validation, phase } }));
          await new Promise((r) => setTimeout(r, 16));
        },
        closure,
        askDl,
      );
      set((s) => ({ validation: { ...s.validation, run: next, running: false, phase: '' } }));
    } catch (e) {
      set((s) => ({ validation: { ...s.validation, running: false, phase: '' } }));
      get().notify(`Validation stopped: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  },
  setValidation: (patch) => {
    try {
      if (patch.engine) localStorage.setItem('conceptweaver:reasoning-engine', patch.engine);
      if (patch.reasonerUrl !== undefined) localStorage.setItem('conceptweaver:reasoner-url', patch.reasonerUrl);
    } catch {
      // Remembered for this visit only.
    }
    set((s) => ({ validation: { ...s.validation, ...patch } }));
  },
  setShapes: (fn) => get().apply((m) => ({ ...m, shapes: fn(m.shapes) })),

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
    get().cancelLayout();
    stopGlide();
    // A different document: its history starts afresh, and it counts as unchanged until edited.
    // Another model may be of another type: the view stays only if that type has it.
    set({ view: viewFor(model, get().view), showInferred: get().showInferred && supports(model, 'reasoning'), model, doc: { id: docId, saved: model }, docSeq: get().docSeq + 1, past: [], future: [], sel: { terms: [], rels: [] }, selProp: null, editing: null, highlight: [], filter: '', subgraph: NO_SUBGRAPH, entityViews: noEntityViews(), graphScope: 'all', structure: { ...get().structure, focus: null, search: '', compare: { a: null, b: null } }, ext: { ...get().ext, loaded: {}, missing: [], selected: null, preview: null }, validation: { ...get().validation, run: null, data: MODEL_DATA, shapeId: null, tab: 'results' } });
    void get().loadExternals();
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
    // A term is of a kind the type of model has: in a vocabulary everything new is a concept.
    const t = newTerm({ ...p, type: termTypeFor(get().model, p.type) });
    // Created while looking at a subgraph: it has to be part of that subgraph to be seen.
    if (get().subgraph.active) set((s) => ({ subgraph: { ...s.subgraph, roots: [...s.subgraph.roots, t.id], pos: { ...s.subgraph.pos, [t.id]: { x: t.x, y: t.y } } } }));
    get().apply((m) => ({ ...m, terms: [...m.terms, t] }));
    return t.id;
  },
  updateTerm: (id, patch, history = true) => {
    // A kind of term the type of model does not have cannot be given to one.
    const { type, ...rest } = patch;
    const allowed = type === undefined || configOf(get().model).termTypes.includes(type) ? patch : rest;
    get().apply((m) => (m.terms.some((t) => t.id === id) ? { ...m, terms: m.terms.map((t) => (t.id === id ? { ...t, ...allowed } : t)) } : m), history);
  },
  updateTerms: (ids, given) => {
    const { type, ...rest } = given;
    const patch = type === undefined || configOf(get().model).termTypes.includes(type) ? given : rest;
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
  addRelation: (p, history = true) => {
    const r = newRelation(p);
    const m = get().model;
    const settled = settleRelation({ ...m, relations: [...m.relations, r] }, r.id);
    if (settled.error !== undefined) {
      get().notify(settled.error);
      return '';
    }
    get().apply(() => settled.model!, history);
    if (settled.note) get().notify(settled.note);
    return r.id;
  },
  updateRelation: (id, given, history = true) => {
    const m = get().model;
    if (!m.relations.some((r) => r.id === id)) return;
    // What the type of model does not have is not set, whoever asks: no restrictions, no data properties.
    const patch = { ...given };
    if (!supports(m, 'restrictions')) for (const k of ['restriction', 'restrictionN', 'more'] as const) delete patch[k];
    if (patch.kind === 'property' && !allowsKind(m, 'property')) delete patch.kind;
    let next = { ...m, relations: m.relations.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
    // In an ontology a new name or a new end can make it something else: "is a" between two classes
    // is a superclass, another name an object property. Ends that cannot be related are refused.
    let note: string | undefined;
    if (typed(m) && ('label' in patch || 'from' in patch || 'to' in patch || 'kind' in patch) && !patch.predicate) {
      const settled = settleRelation(next, id, m);
      if (settled.error !== undefined) return get().notify(settled.error);
      next = settled.model!;
      note = settled.note;
    }
    // Moving an end or changing the kind must not state a class membership a second time.
    const now = next.relations.find((r) => r.id === id)!;
    const moved = 'from' in patch || 'to' in patch || 'kind' in patch || 'predicate' in patch;
    if (moved && isInstanceOf(next, now) && next.relations.some((r) => r.id !== id && r.from === now.from && r.to === now.to && isInstanceOf(next, r))) {
      const name = (x: string) => m.terms.find((t) => t.id === x)?.name || 'Unnamed';
      return get().notify(`“${name(now.from)}” is already stated to be an instance of “${name(now.to)}”.`);
    }
    get().apply(() => next, history);
    if (note) get().notify(note);
  },
  reverseRelation: (id) => {
    const rel = get().model.relations.find((r) => r.id === id);
    if (rel && isInstanceOf(get().model, rel)) return get().notify(`“${INSTANCE_OF}” always points from the individual to the class.`);
    if (rel && typed(get().model) && rel.kind === 'property' && !rel.predicate) return get().notify('“Has data property” always points from the class to the data property.');
    get().apply((m) => ({
      ...m,
      relations: m.relations.map((r) => (r.id === id ? { ...r, from: r.to, to: r.from, fromCard: r.toCard, toCard: r.fromCard } : r)),
    }));
  },
  reconnectRelation: (id, end, termId) => {
    const result = reconnect(get().model, id, end, termId);
    if (result.error !== undefined) {
      get().notify(result.error);
      return false;
    }
    get().apply(() => result.model);
    if (result.note) get().notify(result.note);
    return true;
  },
  setAnchor: (id, end, anchor, gesture = '') => {
    if (!get().model.relations.some((r) => r.id === id)) return;
    get().setStyle((s) => withAnchor(s, id, end, anchor), gesture);
  },
  resetAnchors: (ids) => get().setStyle((s) => withoutAnchors(s, ids === 'all' ? Object.keys(s.anchors) : ids)),
  remove: (terms, rels) => {
    if (!terms.length && !rels.length) return;
    const t = new Set(terms);
    const r = new Set(rels);
    get().apply((m) => ({
      ...m,
      terms: m.terms
        .filter((x) => !t.has(x.id))
        .map((x) => (x.domain && x.domain.some((id) => t.has(id)) ? { ...x, domain: x.domain.filter((id) => !t.has(id)) } : x))
        // A value goes with the data property it is a value of.
        .map((x) => (x.values?.some((v) => t.has(v.prop)) ? { ...x, values: x.values.filter((v) => !t.has(v.prop)) } : x))
        // An individual that is gone is no longer listed by the enumerations it was a member of.
        .map((x) => (x.oneOf?.some((id) => t.has(id)) ? { ...x, oneOf: x.oneOf.filter((id) => !t.has(id)) } : x)),
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
    const resolve = (name: string, type?: TermType) => {
      let t = byName.get(name.toLowerCase());
      if (!t && createMissing) {
        t = newTerm({ name, ...(type ? { type } : {}), x: origin.x + (created.length % 5) * 190, y: origin.y + Math.floor(created.length / 5) * 70 });
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
      // What a class "has property" is a data property, so a new term at that end is made one.
      const to = resolve(r.to, r.kind === 'property' && typed(model) ? 'property' : undefined)!;
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
    // In an ontology each line becomes what its ends and its name make it: "is a", a use of an object
    // property (declared if it is new), "has data property". A line between two terms that cannot
    // be related is left out and counted as skipped.
    let work: Model = { ...model, terms: [...model.terms, ...created] };
    const kept: Relation[] = [];
    for (const r of rels) {
      const settled = settleRelation({ ...work, relations: [...work.relations, r] }, r.id);
      if (settled.error !== undefined) {
        skipped++;
        continue;
      }
      work = settled.model!;
      kept.push(r);
    }
    rels.length = 0;
    rels.push(...kept);
    if (!rels.length) return { added: 0, created: 0, skipped };
    // A term made for a line that was then left out is not kept either.
    const ends = new Set(work.relations.flatMap((r) => [r.from, r.to]));
    const orphans = new Set(created.filter((t) => !ends.has(t.id)).map((t) => t.id));
    if (orphans.size) {
      work = { ...work, terms: work.terms.filter((t) => !orphans.has(t.id)) };
      created.splice(0, created.length, ...created.filter((t) => !orphans.has(t.id)));
    }
    get().apply(() => work);
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
  convertTo: (mode) => {
    const before = get().model;
    if (before.mode === mode) return;
    get().apply((m) => convertModel(m, mode));
    // The other type may not have the view this was done from.
    set({ view: viewFor(get().model, get().view), showInferred: get().showInferred && supports(get().model, 'reasoning') });
  },
  selectProp: (selProp) => set({ selProp, sel: { terms: [], rels: [] } }),
  addProp: () => {
    if (!supports(get().model, 'objectProperties')) return '';
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
  setRelChoice: (id, choice, history = true) => {
    if (!allowsKind(get().model, choice)) {
      const label = configOf(get().model).label;
      get().notify(`${/^[aeiou]/i.test(label) ? 'An' : 'A'} ${label} has no relationships of that kind.`);
      return false;
    }
    // In an ontology the two ends decide what a relationship can be.
    const wanted = get().model.relations.find((r) => r.id === id);
    const offer = wanted && typed(get().model) ? relChoices(get().model, wanted).find((c) => c.value === choice) : undefined;
    if (wanted && offer?.disabled) {
      get().notify(cannotRelate(get().model, wanted.from, wanted.to) ?? `${offer.label}: ${offer.disabled.toLowerCase()}.`);
      return false;
    }
    if (choice === 'instanceOf') {
      const result = makeInstanceOf(get().model, id);
      if (result.error !== undefined) {
        get().notify(result.error);
        return false;
      }
      get().apply(() => result.model, history);
      if (result.note) get().notify(result.note);
      return true;
    }
    get().apply((m) => {
      const rel = m.relations.find((r) => r.id === id);
      if (!rel) return m;
      const { plain: _plain, predicate: _predicate, ...kept } = rel;
      // Only a plain relationship has cardinalities at its ends.
      const base = choice === 'plain' ? kept : { ...kept, fromCard: '', toCard: '' };
      if (choice === 'property') {
        // "Has data property" points from the class to the property, whichever way the line was drawn.
        const type = (x: string) => m.terms.find((t) => t.id === x)?.type;
        const ends = type(rel.from) === 'property' && type(rel.to) === 'concept' ? { from: rel.to, to: rel.from } : {};
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...base, ...ends, kind: choice } : r)) };
      }
      if (choice === 'generalization') {
        // "Is a" restricts nothing, so a quantifier left over from before goes.
        const { restriction: _restriction, restrictionN: _n, more: _more, ...bare } = base;
        // Where the name decides the kind, a superclass has none: any other name would make it an object property again.
        return { ...m, relations: m.relations.map((r) => (r.id === id ? { ...bare, kind: choice, ...(typed(m) ? { label: '' } : {}) } : r)) };
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
    }, history);
    return true;
  },
  updateProp: (key, patch) =>
    get().apply((m) => {
      const next = { ...declaredProp(m, key), ...patch };
      // An emptied optional field means "not set", so it isn't stored.
      for (const k of ['domain', 'range', 'fields', ...PROP_LINKS] as const) if (next[k] === undefined || (k !== 'domain' && k !== 'range' && !next[k]!.length)) delete next[k];
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
      // Every mention of the property by another one follows the new name.
      const follow = (p: ObjProp): ObjProp => {
        let out = p;
        for (const link of PROP_LINKS) if (p[link]?.includes(key)) out = { ...out, [link]: p[link]!.map((k) => (k === key ? to : k)) };
        return out;
      };
      const others = m.props.filter((p) => propKey(p.name) !== key).map(follow);
      return {
        ...m,
        props: [...others, entry],
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
          let out = p;
          for (const link of PROP_LINKS) {
            if (!p[link]?.includes(key)) continue;
            const { [link]: list, ...rest } = out;
            const left = list!.filter((k) => k !== key);
            out = left.length ? { ...rest, [link]: left } : rest;
          }
          return out;
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
  setMeta: (owner, fieldId, values) => {
    const { model } = get();
    const f = registry(model).find((x) => x.id === fieldId);
    const e = metaEntity(model, owner);
    if (!f || !e) return 'That field or entity no longer exists.';
    if (e.external) return 'This entity belongs to another ontology; what is said about it is said there.';
    const refused = checkValues(f, values);
    if (refused) return refused;
    const first = values[0]?.value.trim() ?? '';
    if ('term' in owner) {
      const patch: Partial<Term> =
        f.bind === 'name' ? { name: first } : f.bind === 'description' ? { description: first } : f.bind === 'synonyms' ? { synonyms: values.map((v) => v.value.trim()).filter(Boolean).join(', ') } : f.bind === 'range' ? { range: first || undefined } : { fields: writeValues(e.fields, f, values) };
      get().updateTerm(owner.term, patch);
    } else if (f.bind === 'name') {
      if (!get().renameProp(owner.prop, first)) return 'That name could not be given to the property.';
    } else if (f.bind === 'description') get().updateProp(owner.prop, { description: first });
    else if (!f.bind) get().updateProp(owner.prop, { fields: writeValues(e.fields, f, values) });
    return undefined;
  },
  setProfile: (termId, kind) =>
    get().apply((m) => {
      const t = m.terms.find((x) => x.id === termId);
      return t ? { ...m, terms: m.terms.map((x) => (x === t ? { ...x, fields: withProfile(m, x, kind) } : x)) } : m;
    }),
  edit: (fn) => {
    const result = fn(get().model);
    if (result.error !== undefined) return result.error;
    get().apply(() => result.model);
    if (result.note) get().notify(result.note);
    return undefined;
  },
  addSuperclass: (id, superId) => {
    const { model } = get();
    const name = (x: string) => model.terms.find((t) => t.id === x)?.name || 'Unnamed';
    if (id === superId) return get().notify('A class cannot be its own superclass.');
    if (assertedSuperclasses(model, id).includes(superId)) return get().notify(`“${name(superId)}” is already an asserted superclass of “${name(id)}”.`);
    const cycle = wouldCycle(model, id, superId);
    get().apply((m) => ({ ...m, relations: [...m.relations, newRelation({ from: id, to: superId, kind: 'generalization' })] }));
    // Allowed, since OWL allows it (the classes become equivalent), but rarely what was meant.
    if (cycle) get().notify(`“${name(superId)}” is already a kind of “${name(id)}”, so the two are now each other's superclass. Validation lists this as a circular hierarchy.`);
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

  // A function the type of model does not have is not opened, however it was asked for.
  setView: (view) => allowsView(get().model, view) && set({ view }),
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
}));

// ---------------------------------------------------------------- arranging the graph

let layoutRun: AbortController | undefined;
let glide: { frame: number; to: Viewport } | undefined;

/** Ends a glide where it is going: the terms are in the model already, only the picture was behind. */
function stopGlide() {
  if (!glide) return;
  cancelAnimationFrame(glide.frame);
  const to = glide.to;
  glide = undefined;
  useStore.setState({ tween: null, vp: to });
}

/** Where every term of what the canvas shows is now. */
function placesNow(): Places {
  const s = useStore.getState();
  if (s.subgraph.active) return { ...s.subgraph.pos };
  return Object.fromEntries(s.model.terms.map((t) => [t.id, { x: t.x, y: t.y }]));
}

/** Writes the layout that is chosen, moving nothing. In the full graph it is part of the model's file, though not of its history. */
function writeLayout(layout: GraphLayout) {
  const s = useStore.getState();
  if (s.subgraph.active) useStore.setState({ subgraph: { ...s.subgraph, layout } });
  else s.apply((m) => ({ ...m, layout }), false);
}

/**
 * Puts terms where a layout says, and makes that layout the chosen one. In the full graph the
 * two are one step to undo; a subgraph's arrangement is its own and no part of the history.
 * The terms glide there, and the view follows to show all of them.
 */
function place(layout: GraphLayout, places: Places) {
  stopGlide();
  const s = useStore.getState();
  const before = s.vp;
  const shown = viewOf(s).terms;
  const from: Places = Object.fromEntries(shown.map((t) => [t.id, { x: t.x, y: t.y }]));
  if (s.subgraph.active) {
    const pos = { ...s.subgraph.pos };
    for (const id of Object.keys(pos)) if (places[id]) pos[id] = places[id];
    useStore.setState({ subgraph: { ...s.subgraph, layout, pos } });
  } else {
    s.apply((m) => ({ ...m, layout, terms: m.terms.map((t) => (places[t.id] && (places[t.id].x !== t.x || places[t.id].y !== t.y) ? { ...t, x: places[t.id].x, y: places[t.id].y } : t)) }));
  }
  useStore.getState().fit();
  const to = useStore.getState().vp;
  const calm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const view = viewOf(useStore.getState());
  if (calm || typeof requestAnimationFrame === 'undefined' || view.terms.length > GLIDE.terms || view.relations.length > GLIDE.relations || !shown.length) return;
  const start = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / GLIDE.ms);
    if (t >= 1 || !glide) return stopGlide();
    // Quick away and slow to arrive.
    const p = 1 - (1 - t) ** 3;
    glide.frame = requestAnimationFrame(step);
    useStore.setState({ tween: { from, p }, vp: { k: before.k + (to.k - before.k) * p, x: before.x + (to.x - before.x) * p, y: before.y + (to.y - before.y) * p } });
  };
  glide = { frame: requestAnimationFrame(step), to };
  useStore.setState({ tween: { from, p: 0 }, vp: before });
}

/**
 * Arranges what the canvas shows by a layout. The layout is given boxes and lines and nothing
 * else, and what comes back is places: the terms move, and no statement of the model changes.
 */
async function applyLayout(next: GraphLayout): Promise<void> {
  const s = useStore.getState();
  const now = layoutOf(s);
  layoutRun?.abort();
  layoutRun = undefined;
  if (next.kind === 'manual') {
    useStore.setState({ layoutBusy: null });
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
  useStore.setState({ layoutBusy: kind });
  try {
    const result = await runLayout({ kind, graph: graphOf(view), options: { direction: layout.direction, nodeSpacing: layout.nodeSpacing, layerSpacing: layout.layerSpacing, repulsion: layout.repulsion, root } }, run.signal);
    if (layoutRun !== run) return;
    layoutRun = undefined;
    useStore.setState({ layoutBusy: null });
    place(layout, result.places);
    if (result.note) useStore.getState().notify(result.note);
  } catch (e) {
    if (layoutRun !== run) return;
    layoutRun = undefined;
    useStore.setState({ layoutBusy: null });
    if (!(e instanceof LayoutCancelled)) useStore.getState().notify(`The layout could not be worked out: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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

/** A blank model of the type that was chosen for it, in the namespace that was given, if one was. */
export const createModel = (spec: { name: string; mode: ModelMode; baseIri?: string; ontologyIri?: string }) => {
  useStore.getState().replaceModel({ ...emptyModel(spec.name), mode: spec.mode, baseIri: spec.baseIri ?? '', ontologyIri: spec.ontologyIri ?? '' });
  // An empty model is begun on the canvas.
  useStore.getState().setView('graph');
};

void useStore.getState().loadExternals();
