import { createLocalAlignmentService } from '../../alignment/local';
import type { AlignmentService, OntologyPreview } from '../../alignment/contracts';
import { cachedOntology, cachedOntologyByIri, cacheOntology, uncacheOntology } from '../library';
import type { ExternalRef, Model } from '../types';
import type { Slice, State } from './types';

/** A job: the other ontologies, read from the browser's cache. Their content is never part of the model. */

export interface ExternalsSlice {
  /**
   * Other ontologies. Their content is read from the browser's cache into `loaded` and is never
   * part of the model; `missing` are the ones the model depends on, directly or through another
   * ontology, whose content is not in this browser.
   */
  ext: {
    loaded: Record<string, Model>;
    missing: ExternalRef[];
    tab: 'library' | 'align' | 'mappings' | 'suggestions';
    selected: string | null;
    /** An ontology that has been read, with its text, waiting for the user to say what to do with it. */
    preview: (OntologyPreview & { text: string }) | null;
  };
  /** Other ontologies, mappings and suggestions as a service (src/alignment/contracts.ts). */
  alignmentService: AlignmentService;
  setExt: (patch: Partial<Pick<State['ext'], 'tab' | 'selected' | 'preview'>>) => void;
  /** Reads an ontology and shows what it is, without adding anything. Returns why it could not be read, if so. */
  previewExternal: (text: string, source: string, kind: 'file' | 'url' | 'model') => string | undefined;
  /** Adds the previewed ontology to the library; as a dependency (owl:imports) or only to browse and reuse. */
  confirmExternal: (imports: boolean) => string | undefined;
  /** Brings the content of the model's external ontologies in from the browser's cache, transitive imports too. */
  loadExternals: () => Promise<void>;
  removeExternalRef: (id: string) => string | undefined;
}

export const externalsSlice: Slice<ExternalsSlice> = (set, get) => {
  const service = createLocalAlignmentService({
    current: () => get().model,
    cached: async (id, iri) => (await cachedOntology(id).catch(() => undefined))?.text ?? (iri ? (await cachedOntologyByIri(iri).catch(() => undefined))?.text : undefined),
  });

  return {
    ext: { loaded: {}, missing: [], tab: 'library', selected: null, preview: null },
    alignmentService: service,
    setExt: (patch) => set((s) => ({ ext: { ...s.ext, ...patch } })),
    previewExternal: (text, source, kind) => {
      try {
        const preview = service.read(text, source, kind);
        set((s) => ({ ext: { ...s.ext, preview: { ...preview, text } } }));
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : 'It could not be read.';
      }
    },
    confirmExternal: (imports) => {
      const preview = get().ext.preview;
      if (!preview) return undefined;
      const { model, ref } = service.add(preview, imports);
      get().apply(() => model);
      set((s) => ({
        ext: {
          ...s.ext,
          preview: null,
          selected: ref.id,
          loaded: { ...s.ext.loaded, [ref.id]: preview.summary.model },
          missing: s.ext.missing.filter((x) => x.id !== ref.id && (!ref.iri || x.iri !== ref.iri)),
        },
      }));
      // Kept in this browser so that it is there next time; the model itself holds only the reference.
      cacheOntology(ref.id, ref.iri, preview.text).catch((e) => get().notify(`“${ref.name}” is in the library for now, but could not be kept in the browser: ${e instanceof Error ? e.message : ''}`));
      return ref.id;
    },
    loadExternals: async () => {
      const { loaded, missing } = await service.contents(get().model, get().ext.loaded);
      set((s) => ({ ext: { ...s.ext, loaded, missing } }));
    },
    removeExternalRef: (id) => {
      try {
        const model = service.remove(id);
        get().apply(() => model);
        set((s) => ({ ext: { ...s.ext, selected: s.ext.selected === id ? null : s.ext.selected } }));
        void uncacheOntology(id).catch(() => undefined);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : 'It could not be removed.';
      }
    },
  };
};
