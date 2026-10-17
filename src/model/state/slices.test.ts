import { describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { documentSlice } from './document';
import { editsSlice } from './edits';
import { externalsSlice } from './externals';
import { layoutSlice } from './layout';
import { reasoningSlice } from './reasoning';
import { sessionSlice } from './session';
import { subgraphSlice } from './subgraph';
import type { Slice } from './types';
import { validationSlice } from './validation';

/**
 * The store is its slices put together (store.ts). Put together by spreading, a key two slices
 * both had would be one slice's, silently: so each key is one slice's, and the slices together
 * are the whole store. And each holds what its lifetime says it does.
 */
const SLICES: Record<string, Slice<object>> = {
  document: documentSlice,
  edits: editsSlice,
  session: sessionSlice,
  subgraph: subgraphSlice,
  validation: validationSlice,
  reasoning: reasoningSlice,
  externals: externalsSlice,
  layout: layoutSlice,
};
// Made without a store: nothing in a slice asks the store for anything until an action runs.
const keysOf = (slice: Slice<object>) => Object.keys(slice(() => undefined, (() => undefined) as never, {} as never));

describe('the slices of the store', () => {
  it('have no key in common, and together are every key of the store', () => {
    const all = Object.entries(SLICES).flatMap(([name, slice]) => keysOf(slice).map((k) => [k, name]));
    const owners = new Map<string, string[]>();
    for (const [k, name] of all) owners.set(k, [...(owners.get(k) ?? []), name]);
    expect([...owners].filter(([, names]) => names.length > 1)).toEqual([]);
    expect([...owners.keys()].sort()).toEqual(Object.keys(useStore.getState()).sort());
  });

  it('keep the document apart from the session: the model and its history in one, what is looked at in the other', () => {
    expect(keysOf(documentSlice).sort()).toEqual(['apply', 'changeSetOf', 'checkpoint', 'discardLast', 'doc', 'docSeq', 'editService', 'future', 'libraryAutosave', 'logicalEdit', 'logicalQuery', 'model', 'openFromLibrary', 'openWorkingCopy', 'past', 'redo', 'replaceModel', 'saveToLibrary', 'setLibraryAutosave', 'storageKept', 'syncDoc', 'undo', 'version', 'workingCopyAtRisk']);
    const session = keysOf(sessionSlice);
    for (const k of ['sel', 'vp', 'view', 'dialog', 'theme', 'structure', 'entityViews', 'notify']) expect(session).toContain(k);
    for (const k of ['model', 'past', 'validation', 'ext', 'layoutBusy', 'subgraph']) expect(session).not.toContain(k);
    expect(keysOf(validationSlice).sort()).toEqual(['cancelValidation', 'requestChecks', 'runValidation', 'setValidation', 'validation', 'validationService']);
    expect(keysOf(reasoningSlice).sort()).toEqual(['cancelReasoning', 'reasonWithDl', 'reasoning', 'reasoningService', 'requestReasoning']);
  });
});
