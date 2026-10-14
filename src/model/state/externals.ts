import { addExternal, collisions, readExternal, removeExternal, type Collision, type ExternalSummary } from '../external';
import { cachedOntology, cachedOntologyByIri, cacheOntology, uncacheOntology } from '../library';
import type { Model } from '../types';
import type { Slice, State } from './types';

/** A job: the other ontologies, read from the browser's cache. Their content is never part of the model. */

export interface ExternalsSlice {
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
}

export const externalsSlice: Slice<ExternalsSlice> = (set, get) => ({
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
});
