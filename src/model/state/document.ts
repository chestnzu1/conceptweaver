import { drawnWhole } from '../culling';
import { checkpointed, committed, createLocalEditService, discarded, opened, redone, stepChangeSet, undone, type DocumentState, type Step, type Version } from '../../editing/local';
import type { ChangeSet, OntologyEditService } from '../../editing/contracts';
import { WORKING_COPY } from '../../structure/local';
import { createLocalLogicalServices } from '../../logical/local';
import type { LogicalModelEditService, LogicalModelQueryService } from '../../logical/contracts';
import { createLocalTraceabilityService, createLocalTransformationService } from '../../traceability/local';
import type { TraceabilityService, TransformationService } from '../../traceability/contracts';
import { storedModel } from '../../projects/local';
import { withoutEntities } from '../domains';
import { importsClosure } from '../external';
import { linkProps } from '../identity';
import { withIris } from '../iri';
import { loadModel as loadSaved, saveModel as saveToLibraryDb, type WorkingCopy } from '../library';
import { supports, viewFor } from '../modelTypes';
import { sampleModel } from '../sample';
import { normalizeModel, type Model } from '../types';
import { withoutIris } from '../unmapped';
import { MODEL_DATA } from '../validation';
import { noEntityViews, type Selection } from './session';
import { AUTOSAVE_KEY } from './storage';
import { NO_REASONING } from './reasoning';
import { NO_SUBGRAPH } from './subgraph';
import type { Slice, State } from './types';

/**
 * The document: the model being edited, its history, and which saved model it is. Every edit of
 * the ontology goes through `apply` here (see edits.ts for the edits themselves), and is a change
 * set of the edit service (src/editing/local.ts): one step of the history, which undo applies
 * backwards. A change set made elsewhere comes in through `editService`.
 */

/** The IRIs of a model's own entities: its terms, object properties and named datatypes. */
const entityIris = (m: Model) => new Set([...m.terms, ...m.props, ...m.datatypes].map((x) => x.iri).filter((x): x is string => !!x));

/**
 * A model as the editor holds it: every named entity with its IRI, every relationship joined to
 * the object property it uses. After an edit (`before` is the model it was made to), what the
 * domains and ranges say of an entity no longer there, and the statements kept as they were read
 * that mention one, go with it.
 */
export const prepared = (m: Model, before?: Model): Model => {
  let next = linkProps(withIris(m));
  // Only an edit that leaves fewer entities than there were can have deleted one.
  const shrunk = !!before && (next.terms.length < before.terms.length || next.props.length < before.props.length || next.datatypes.length < before.datatypes.length);
  if (!before || (!next.unmapped && !shrunk)) return next;
  const now = entityIris(next);
  const gone = new Set([...entityIris(before)].filter((iri) => !now.has(iri)));
  if (shrunk) {
    const enums = new Set(next.datatypes.map((d) => d.id));
    next = withoutEntities(next, gone, new Set(before.datatypes.filter((d) => !enums.has(d.id)).map((d) => d.id)));
  }
  if (!gone.size || !next.unmapped) return next;
  const unmapped = withoutIris(next.unmapped, gone);
  if (unmapped === next.unmapped) return next;
  const { unmapped: _was, ...rest } = next;
  return unmapped ? { ...rest, unmapped } : rest;
};

/**
 * How the model in the editor relates to the library of saved models. `saved` is the state of
 * the document that was last saved or opened (`Version.state`), so "has unsaved changes" is
 * simply "the document is in another state now", and undoing back to it makes it clean again.
 * Moving terms counts: where they sit is saved with the model.
 */
export interface Doc {
  /** Id of the saved model this is, or null when it has never been saved to the library. */
  id: string | null;
  saved: number | null;
}

export const isDirty = (s: { version: Version; doc: Doc }) => s.version.state !== s.doc.saved;

/** The document as the edit service has it, and the parts of the store that hold it. */
const documentOf = (s: State): DocumentState => ({ model: s.model, version: s.version, past: s.past, future: s.future });
const held = (d: DocumentState) => ({ model: d.model, version: d.version, past: d.past, future: d.future });

export const prune = (sel: Selection, m: Model): Selection => {
  const t = new Set(m.terms.map((x) => x.id));
  const r = new Set(m.relations.map((x) => x.id));
  return { terms: sel.terms.filter((id) => t.has(id)), rels: sel.rels.filter((id) => r.has(id)) };
};

/**
 * What the editor starts with: the example, until the working copy kept in this browser has been
 * read (`openWorkingCopy`, before the app is shown; see persistence.ts).
 */
export const initialModel = prepared(sampleModel());
const initial = opened(initialModel);

export interface DocumentSlice {
  model: Model;
  /** Which state the document is in, and which revision of the ontology that is. */
  version: Version;
  doc: Doc;
  /** Goes up each time another model is put in the editor, so that views can start afresh for it. */
  docSeq: number;
  /** Save to the library by itself a moment after each change, for a model that is already in it. */
  libraryAutosave: boolean;
  /** The working copy could not be kept in the browser, so closing the page would lose unsaved changes. */
  workingCopyAtRisk: boolean;
  /** Whether the browser keeps what this site stores even when space runs low; undefined where it has not said. */
  storageKept: boolean | undefined;
  /** Puts the working copy kept in this browser in the editor, as the model it is and with what it was saved as. */
  openWorkingCopy: (copy: WorkingCopy) => void;
  /** The steps undo takes back, the last one last; each a change set made in the editor. */
  past: Step[];
  future: Step[];
  /** Makes an edit: one step of the history, or (`history` false) part of the last one. */
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
  /** Applies change sets made elsewhere to the document, and answers what it states (src/editing/contracts.ts). */
  editService: OntologyEditService;
  /** A step that undo would take back (`index` into `past`), as a change set of axioms. Worked out when asked for, one at a time. */
  changeSetOf: (index: number) => ChangeSet | undefined;
  /** Questions about the project's logical data models (src/logical). */
  logicalQuery: LogicalModelQueryService;
  /** Changes to them: each one step of the history, never a change to the ontology. */
  logicalEdit: LogicalModelEditService;
  /** Proposals for an LDM from the ontology, and their application (src/traceability). */
  transformationService: TransformationService;
  /** Traceability, impact and reviewed synchronization of the LDMs with the ontology (src/traceability). */
  traceabilityService: TraceabilityService;
}

export const documentSlice: Slice<DocumentSlice> = (set, get) => ({
  model: initialModel,
  version: initial.version,
  doc: { id: null, saved: initial.version.state },
  docSeq: 0,
  libraryAutosave: (() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === 'on';
    } catch {
      return false;
    }
  })(),
  workingCopyAtRisk: false,
  storageKept: undefined,
  openWorkingCopy: (copy) => {
    get().replaceModel(normalizeModel(copy.model), copy.doc.id);
    // A copy with changes not saved to My Models opens as one; otherwise it is the saved model.
    if (copy.doc.dirty) set((s) => ({ doc: { ...s.doc, saved: null } }));
  },
  past: [],
  future: [],
  apply: (fn, history = true) =>
    set((s) => {
      // Whatever the edit, every named entity ends up with an IRI, made once and then left alone,
      // and every relationship joined to the object property it uses, by id.
      const model = prepared(fn(s.model), s.model);
      if (model === s.model) return s;
      const d = committed(documentOf(s), model, history);
      return d.model === s.model ? s : held(d);
    }),
  // Moving terms about in a subgraph changes its own layout, not the model, so there is nothing to undo.
  checkpoint: () => set((s) => (s.subgraph.active ? s : held(checkpointed(documentOf(s))))),
  discardLast: () =>
    set((s) => {
      const d = discarded(documentOf(s));
      return d ? { ...held(d), sel: prune(s.sel, d.model), editing: null } : s;
    }),
  undo: () =>
    set((s) => {
      const d = undone(documentOf(s));
      return d ? { ...held(d), sel: prune(s.sel, d.model), editing: null, highlight: [] } : s;
    }),
  redo: () =>
    set((s) => {
      const d = redone(documentOf(s));
      return d ? { ...held(d), sel: prune(s.sel, d.model), editing: null, highlight: [] } : s;
    }),
  replaceModel: (m, docId = null) => {
    const model = prepared(m);
    get().cancelLayout();
    get().endTween();
    get().cancelReasoning();
    get().cancelValidation();
    // A different document: its history starts afresh, and it counts as unchanged until edited.
    // Another model may be of another type: the view stays only if that type has it.
    const d = opened(model);
    // A model too large to draw whole opens on the Structure Explorer, where the graph around a class is a click away.
    const view = viewFor(model, get().view);
    set({ view: view === 'graph' && !drawnWhole(model) ? viewFor(model, 'structure') : view, showInferred: get().showInferred && supports(model, 'reasoning'), ...held(d), doc: { id: docId, saved: d.version.state }, docSeq: get().docSeq + 1, sel: { terms: [], rels: [] }, selProp: null, editing: null, highlight: [], filter: '', subgraph: NO_SUBGRAPH, entityViews: noEntityViews(), graphScope: 'all', structure: { ...get().structure, focus: null, search: '', compare: { a: null, b: null } }, ext: { ...get().ext, loaded: {}, missing: [], selected: null, preview: null }, validation: { ...get().validation, run: null, running: false, phase: '', job: null, checks: {}, data: MODEL_DATA, shapeSet: null, tab: 'results' }, shapesView: { set: null, shape: null }, ldmView: { model: null, section: 'entities', entity: null, relationship: null, domain: null, rule: null, element: null, search: '' }, reasoning: NO_REASONING });
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
    const { model, version } = get();
    try {
      const info = await saveToLibraryDb(model, fresh ? undefined : (get().doc.id ?? undefined));
      set({ doc: { id: info.id, saved: version.state } });
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
      set((s) => ({ doc: { id, saved: s.version.state }, view: drawnWhole(s.model) ? 'graph' : s.view }));
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
      if (clean) set((s) => ({ doc: { ...s.doc, saved: s.version.state } }));
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
  editService: createLocalEditService({
    current: () => ({ model: get().model, ontologyId: get().doc.id ?? WORKING_COPY }),
    commit: (next) => get().apply(() => next),
  }),
  changeSetOf: (index) => stepChangeSet(documentOf(get()), index, get().doc.id ?? WORKING_COPY),
  ...(() => {
    // A change to the logical models changes nothing an entity's IRI or a property's link depends
    // on, so it is committed as it is, without what an edit of the ontology is prepared with.
    const { query, edit } = createLocalLogicalServices({
      current: () => ({ model: get().model }),
      commit: (next) =>
        set((s) => {
          const d = committed(documentOf(s), next);
          return d.model === s.model ? s : held(d);
        }),
    });
    const transformation = createLocalTransformationService({
      current: () => ({ model: get().model, ontologyId: get().doc.id ?? WORKING_COPY, revisionId: get().version.revision }),
      withImports: (model) => (model.externals.some((e) => e.imports) ? importsClosure(model, new Map(Object.entries(get().ext.loaded))).model : undefined),
      edit,
    });
    const traceability = createLocalTraceabilityService({
      current: () => ({ model: get().model, ontologyId: get().doc.id ?? WORKING_COPY, revisionId: get().version.revision }),
      withImports: (model) => (model.externals.some((e) => e.imports) ? importsClosure(model, new Map(Object.entries(get().ext.loaded))).model : undefined),
      savedVersion: (version) => storedModel(version),
      edit,
    });
    return { logicalQuery: query, logicalEdit: edit, transformationService: transformation, traceabilityService: traceability };
  })(),
});
