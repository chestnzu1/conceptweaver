import { withoutEntities } from '../domains';
import { linkProps } from '../identity';
import { withIris } from '../iri';
import { loadModel as loadSaved, saveModel as saveToLibraryDb } from '../library';
import { supports, viewFor } from '../modelTypes';
import { sampleModel } from '../sample';
import { normalizeModel, type Model } from '../types';
import { withoutIris } from '../unmapped';
import { MODEL_DATA } from '../validation';
import { noEntityViews, type Selection } from './session';
import { AUTOSAVE_KEY, DOC_KEY, MODEL_KEY, stored } from './storage';
import { NO_SUBGRAPH } from './subgraph';
import type { Slice, State } from './types';

/**
 * The document: the model being edited, its history, and which saved model it is. Every edit of
 * the ontology goes through `apply` here (see edits.ts for the edits themselves).
 */

const HISTORY = 100;

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

function loadModel(): Model {
  try {
    const raw = stored(MODEL_KEY);
    if (raw) return prepared(normalizeModel(JSON.parse(raw)));
  } catch {
    // Unreadable autosave: fall through to the example.
  }
  return prepared(sampleModel());
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

const pushHistory = (s: State) => ({ past: [...s.past.slice(-(HISTORY - 1)), s.model], future: [] as Model[] });

export const prune = (sel: Selection, m: Model): Selection => {
  const t = new Set(m.terms.map((x) => x.id));
  const r = new Set(m.relations.map((x) => x.id));
  return { terms: sel.terms.filter((id) => t.has(id)), rels: sel.rels.filter((id) => r.has(id)) };
};

export const initialModel = loadModel();

export interface DocumentSlice {
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

}

export const documentSlice: Slice<DocumentSlice> = (set, get) => ({
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
  apply: (fn, history = true) =>
    set((s) => {
      // Whatever the edit, every named entity ends up with an IRI, made once and then left alone,
      // and every relationship joined to the object property it uses, by id.
      const model = prepared(fn(s.model), s.model);
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
    const model = prepared(m);
    get().cancelLayout();
    get().endTween();
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

});
