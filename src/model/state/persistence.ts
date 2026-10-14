import type { StoreApi } from 'zustand';
import { isDirty } from './document';
import { DOC_KEY, MODEL_KEY } from './storage';
import type { State } from './types';

/**
 * The working copy: whatever is in the editor is kept in this browser as it is edited, and a model
 * that is in the library is saved there too where that is asked for. Attached to the store once it exists.
 */

// Autosave: the model lives in this browser's storage until it is saved to a file.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let libraryTimer: ReturnType<typeof setTimeout> | undefined;

export function keepWorkingCopy(store: StoreApi<State>): void {
  store.subscribe((s, prev) => {
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
        localStorage.setItem(MODEL_KEY, JSON.stringify(store.getState().model));
        if (store.getState().workingCopyAtRisk) store.setState({ workingCopyAtRisk: false });
      } catch {
        store.setState({ workingCopyAtRisk: true });
        store.getState().notify('This model is too large to keep as a working copy in the browser. Save it to My Models or to a file before closing the page.');
      }
    }, 300);
    // Optional: a model that is already in the library is saved there too, a little after each change.
    clearTimeout(libraryTimer);
    if (s.libraryAutosave && s.doc.id && isDirty(s)) {
      libraryTimer = setTimeout(() => {
        const now = store.getState();
        if (now.libraryAutosave && now.doc.id && isDirty(now)) void now.saveToLibrary({ quiet: true });
      }, 1500);
    }
  });
}
