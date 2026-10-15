import type { StoreApi } from 'zustand';
import { keepStorage, readWorkingCopy, writeWorkingCopy, type WorkingCopy } from '../library';
import { isDirty } from './document';
import { DOC_KEY, MODEL_KEY, stored } from './storage';
import type { State } from './types';

/**
 * The working copy: whatever is in the editor is kept in this browser as it is edited, saved to
 * My Models or not, so that a reload or a crash loses nothing. It is kept in IndexedDB (see
 * library.ts), as the model itself: there is no limit on its size but the browser's space for
 * the site, and the browser is asked once to keep that space even when it runs low. A model
 * that is in My Models is saved there too, where that is asked for.
 */

/** How long after a change the working copy is kept: a drag or a burst of typing is kept once. */
const AFTER = 300;

/** The working copy an earlier version of the app kept in localStorage, as one string, if it is still there. */
function leftInLocalStorage(): WorkingCopy | undefined {
  try {
    const raw = stored(MODEL_KEY);
    if (!raw) return undefined;
    const doc = JSON.parse(stored(DOC_KEY) ?? 'null') as { id?: unknown; dirty?: unknown } | null;
    return { model: JSON.parse(raw), doc: { id: typeof doc?.id === 'string' ? doc.id : null, dirty: doc?.dirty === true }, kept: 0 };
  } catch {
    return undefined;
  }
}

/** Takes the old working copy out of localStorage, under the app's names old and new. */
function forgetLocalStorage() {
  try {
    for (const key of [MODEL_KEY, DOC_KEY]) for (const k of [key, key.replace('conceptweaver:', 'termloom:')]) localStorage.removeItem(k);
  } catch {
    // Nothing to take out.
  }
}

/**
 * Opens the working copy kept in this browser, if there is one, and keeps it from then on. The
 * app is shown once this is done, and nothing is kept before it is: the example the editor starts
 * with never takes the place of what was there. A working copy an earlier version kept in
 * localStorage is moved over.
 */
export async function startWorkingCopy(store: StoreApi<State>): Promise<void> {
  let copy: WorkingCopy | undefined;
  try {
    copy = await readWorkingCopy();
  } catch {
    // This browser keeps nothing for the site (IndexedDB is unavailable): it is said when the copy is first kept.
  }
  const moved = copy ? undefined : leftInLocalStorage();
  copy ??= moved;
  let opened = false;
  if (copy) {
    try {
      store.getState().openWorkingCopy(copy);
      opened = true;
    } catch {
      // Unreadable: the example instead.
    }
  }
  if (!opened) void store.getState().loadExternals();
  keepWorkingCopy(store);
  if (moved && opened) {
    try {
      const s = store.getState();
      await writeWorkingCopy({ model: s.model, doc: { id: s.doc.id, dirty: isDirty(s) } });
      forgetLocalStorage();
    } catch {
      // Kept where it was until it can be moved.
    }
  }
}

/** Keeps the working copy as it changes, and in My Models where that is asked for. */
export function keepWorkingCopy(store: StoreApi<State>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let libraryTimer: ReturnType<typeof setTimeout> | undefined;
  /** A write under way, and whether another is wanted after it: writes are made one at a time, the latest last. */
  let writing = false;
  let again = false;
  /** Whether anything was edited in this session, so that keeping it is worth asking the browser for. */
  let edited = false;
  let asked = false;

  const write = async () => {
    timer = undefined;
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    try {
      const s = store.getState();
      await writeWorkingCopy({ model: s.model, doc: { id: s.doc.id, dirty: isDirty(s) } });
      if (store.getState().workingCopyAtRisk) store.setState({ workingCopyAtRisk: false });
      // There is something worth keeping: the browser is asked, once, not to clear it when space runs low.
      if (edited && !asked) {
        asked = true;
        void keepStorage().then((kept) => store.setState({ storageKept: kept }));
      }
    } catch (e) {
      if (!store.getState().workingCopyAtRisk) {
        store.setState({ workingCopyAtRisk: true });
        store.getState().notify(`This model could not be kept as a working copy in the browser: ${e instanceof Error ? e.message : 'the browser refused it'} Save it to My Models or to a file before closing the page.`);
      }
    } finally {
      writing = false;
      if (again) {
        again = false;
        void write();
      }
    }
  };
  /** A write that was waiting is made at once: the page is going away. */
  const now = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    void write();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && now());
  if (typeof window !== 'undefined') window.addEventListener('pagehide', now);

  store.subscribe((s, prev) => {
    if (s.model === prev.model && s.doc === prev.doc) return;
    if (s.model !== prev.model) edited = true;
    clearTimeout(timer);
    timer = setTimeout(() => void write(), AFTER);
    if (s.model === prev.model) return;
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
