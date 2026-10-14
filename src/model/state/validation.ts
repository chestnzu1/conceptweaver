import { importsClosure } from '../external';
import { cachedOntology } from '../library';
import { supports } from '../modelTypes';
import { askReasoner, DEFAULT_REASONER_URL, dlRequest, type EngineId, type ReasoningResult } from '../reasoning';
import { stable } from '../stable';
import { MODEL_DATA, validate, type DataGraph, type Scope, type ValidationRun } from '../validation';
import type { Slice, State } from './types';

/** A job: the validation workbench and the reasoner it asks. Its results are of one run over one model, never saved or undone with it. */

/**
 * The OWL 2 DL reasoner's result for the model as it is now. There is none once the model has
 * changed since it was asked, when it gave no answer, or when the other reasoner is the one
 * chosen: an old result, or one of the engine that was switched away from, is never shown as current.
 */
export const currentDl = (s: Pick<State, 'model' | 'validation'>): ReasoningResult | undefined => {
  const run = s.validation.run;
  return s.validation.engine === 'dl' && run?.dl && run.model === stable(s.model) && run.dl.result.status !== 'failed' ? run.dl.result : undefined;
};

export interface ValidationSlice {
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
  /** Runs the checks in `scope`. A run already under way is left to finish. */
  runValidation: (scope?: Scope) => Promise<void>;
  setValidation: (patch: Partial<Pick<State['validation'], 'data' | 'tab' | 'shapeId' | 'engine' | 'reasonerUrl' | 'focus'>>) => void;
}

export const validationSlice: Slice<ValidationSlice> = (set, get) => ({
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
});
