import { create } from 'zustand';
import { documentSlice, isDirty } from './state/document';
import { editsSlice } from './state/edits';
import { externalsSlice } from './state/externals';
import { layoutSlice } from './state/layout';
import { startWorkingCopy as start } from './state/persistence';
import { reasoningSlice } from './state/reasoning';
import { sessionSlice } from './state/session';
import { subgraphSlice } from './state/subgraph';
import type { State } from './state/types';
import { validationSlice } from './state/validation';
import { emptyModel, type ModelMode } from './types';

/**
 * The editor's store: one zustand store, made of slices by how long what they hold lives
 * (src/model/state):
 *
 * - the document (`document.ts`, with its edits in `edits.ts`): the model being edited, its
 *   history, and which saved model it is. It is what will one day talk to an edit service;
 * - the session (`session.ts`, and the subgraph in `subgraph.ts`): what is selected and looked
 *   at, the panels, the dialogs, the preferences. Nothing of it is part of the ontology;
 * - the jobs: validation (`validation.ts`), reasoning (`reasoning.ts`), the other ontologies
 *   (`externals.ts`), arranging the graph (`layout.ts`);
 * - and, once the app starts, the working copy kept in the browser (`persistence.ts`).
 *
 * Each slice reaches the others through the store (`get()`), never by importing their state.
 */

export type { View } from './modelTypes';
export { SIDEBAR_WIDTH, type Editing, type EntityViewState, type StructureMode, type StructureState, type Theme, type Viewport } from './state/session';
export type { SubgraphState } from './state/subgraph';
export { layoutOf, viewOf, type GraphScope } from './state/view';
export type { Tween } from './state/layout';
export { isDirty, type Doc } from './state/document';
export { currentDl, problemCount, runIsStale, type CheckKind } from './state/validation';
export { currentReasoning, type Inference, type Reasoning } from './state/reasoning';

export const useStore = create<State>()((...a) => ({
  ...documentSlice(...a),
  ...editsSlice(...a),
  ...sessionSlice(...a),
  ...subgraphSlice(...a),
  ...validationSlice(...a),
  ...reasoningSlice(...a),
  ...externalsSlice(...a),
  ...layoutSlice(...a),
}));

// An edit can add or remove what the subgraph shows.
useStore.subscribe((s, prev) => {
  if (s.model !== prev.model && s.subgraph.active) s.refreshSubgraph();
});

/**
 * Opens the working copy kept in this browser and keeps it from then on (state/persistence.ts).
 * The app is shown once this is done.
 */
export const startWorkingCopy = () => start(useStore);

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

