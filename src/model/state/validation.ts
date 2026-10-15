import { WORKING_COPY } from '../../structure/local';
import { CATEGORIES, MODEL_DATA, ValidationError, type DataGraph, type Scope, type ValidationReport, type ValidationService } from '../../validation/contracts';
import { createLocalValidationService } from '../../validation/local';
import { importsClosure } from '../external';
import type { Model } from '../types';
import { supports } from '../modelTypes';
import { DEFAULT_REASONER_URL, type EngineId, type ReasoningResult } from '../reasoning';
import type { Slice, State } from './types';

/**
 * A job: the validation workbench and the checks that run by themselves (src/validation). Its
 * results are reports, each of one revision, never saved or undone with the model.
 */

/**
 * The OWL 2 DL reasoner's result for the model as it is now. There is none once the model has
 * changed since it was asked, when it gave no answer, or when the other reasoner is the one
 * chosen: an old result, or one of the engine that was switched away from, is never shown as current.
 */
export const currentDl = (s: Pick<State, 'version' | 'validation' | 'reasoning'>): ReasoningResult | undefined => {
  const dl = s.reasoning.dl;
  return s.validation.engine === 'dl' && dl?.revisionId === s.version.revision && dl.result.status !== 'failed' ? dl.result : undefined;
};

/**
 * The checks that run by themselves after an edit, away from the page. problems: the OWL and
 * quality checks of the model, whose findings the header counts. mappings: the OWL checks of the
 * model with what it imports, which the mappings lead to.
 */
export type CheckKind = 'problems' | 'mappings';

export interface Check {
  revisionId: string;
  /** What the ontologies it imports were, as they were loaded, for the checks that take them in. */
  loaded?: object;
  /** What the checks found; nothing when they could not run. */
  report?: ValidationReport;
  /** Why they could not run. */
  error?: string;
}

/** How many findings of a report are worth a count: the errors and the warnings. */
export const problemCount = (report: ValidationReport | undefined): number => report?.findings.filter((f) => f.severity !== 'info').length ?? 0;

export interface ValidationSlice {
  /**
   * The validation workbench. Results are a report of one run over one revision: they live here,
   * beside the model, and are never saved with it or undone with it.
   */
  validation: {
    run: ValidationReport | null;
    running: boolean;
    /** What the run in progress is doing, for showing while it works. */
    phase: string;
    /** The job of the run in progress, which can be stopped. */
    job: string | null;
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
    /** The last report of each of the checks that run by themselves. */
    checks: Partial<Record<CheckKind, Check>>;
  };
  /** Validation as a service: jobs, started, followed and stopped (src/validation/contracts.ts). */
  validationService: ValidationService;
  /** Runs the checks in `scope` as a job. A run already under way is left to finish. */
  runValidation: (scope?: Scope) => Promise<void>;
  /** Stops the run under way, and the OWL 2 DL reasoner if it was asked for it. */
  cancelValidation: () => void;
  /** Asks for checks that run by themselves about the model as it is, unless their report is of it already. */
  requestChecks: (kind: CheckKind) => void;
  setValidation: (patch: Partial<Pick<State['validation'], 'data' | 'tab' | 'shapeId' | 'engine' | 'reasonerUrl' | 'focus'>>) => void;
}

export const validationSlice: Slice<ValidationSlice> = (set, get) => {
  const ref = () => ({ ontologyId: get().doc.id ?? WORKING_COPY, revisionId: get().version.revision });
  const service = createLocalValidationService({
    current: () => ({ model: get().model, ...ref() }),
    withImports: (model: Model) => (model.externals.some((e) => e.imports) ? importsClosure(model, new Map(Object.entries(get().ext.loaded))).model : undefined),
    askDl: async (signal) => {
      const stop = () => get().cancelReasoning('dl');
      signal.addEventListener('abort', stop, { once: true });
      try {
        return await get().reasonWithDl();
      } finally {
        signal.removeEventListener('abort', stop);
      }
    },
    changed: (job) => {
      if (job.job === get().validation.job && job.state === 'running') set((s) => ({ validation: { ...s.validation, phase: job.phase } }));
    },
  });
  /** The checks each kind has been asked for and not answered yet: of which revision, with which ontologies loaded. */
  const asked: Partial<Record<CheckKind, { revisionId: string; loaded?: object; job?: string }>> = {};

  return {
    validation: {
      run: null,
      running: false,
      phase: '',
      job: null,
      data: MODEL_DATA,
      tab: 'results',
      shapeId: null,
      focus: null,
      checks: {},
      ...(() => {
        try {
          return { engine: (localStorage.getItem('conceptweaver:reasoning-engine') === 'dl' ? 'dl' : 'fast') as EngineId, reasonerUrl: localStorage.getItem('conceptweaver:reasoner-url') || DEFAULT_REASONER_URL };
        } catch {
          return { engine: 'fast' as EngineId, reasonerUrl: DEFAULT_REASONER_URL };
        }
      })(),
    },
    validationService: service,
    runValidation: async (scope = 'all') => {
      if (get().validation.running || !supports(get().model, 'validation')) return;
      const { run, data, engine } = get().validation;
      set((s) => ({ validation: { ...s.validation, running: true, phase: 'Starting…' } }));
      try {
        // An ontology that imports others is checked together with them, as far as they are in this browser.
        const job = await service.start({ ...ref(), categories: scope === 'all' ? CATEGORIES : [scope], data, engine, imports: true, ...(run ? { previous: run } : {}) });
        set((s) => ({ validation: { ...s.validation, job: job.job } }));
        const report = await service.report(job.job);
        // The data graph is the one the page holds, so that a change of it is seen as one.
        set((s) => ({ validation: { ...s.validation, run: { ...report, data }, running: false, phase: '', job: null } }));
      } catch (e) {
        set((s) => ({ validation: { ...s.validation, running: false, phase: '', job: null } }));
        if (e instanceof ValidationError && e.code === 'cancelled') get().notify('Validation stopped. The results shown are from before.');
        else get().notify(`Validation stopped: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    },
    cancelValidation: () => {
      const job = get().validation.job;
      if (job) void service.cancel(job);
    },
    requestChecks: (kind) => {
      const s = get();
      if (!supports(s.model, 'validation')) return;
      const { revisionId } = ref();
      const loaded = kind === 'mappings' ? s.ext.loaded : undefined;
      const have = s.validation.checks[kind];
      const pending = asked[kind];
      if ((have?.revisionId === revisionId && have.loaded === loaded) || (pending?.revisionId === revisionId && pending.loaded === loaded)) return;
      // What was asked about an earlier revision, or other ontologies, is not wanted any more.
      if (pending?.job) void service.cancel(pending.job);
      const mine: { revisionId: string; loaded?: object; job?: string } = (asked[kind] = { revisionId, ...(loaded ? { loaded } : {}) });
      void (async () => {
        try {
          const job = await service.start({ ...ref(), categories: kind === 'problems' ? ['owl', 'quality'] : ['owl'], data: MODEL_DATA, engine: 'fast', imports: kind === 'mappings' });
          mine.job = job.job;
          const report = await service.report(job.job);
          if (get().version.revision !== report.revisionId || (kind === 'mappings' && get().ext.loaded !== loaded)) return;
          set((x) => ({ validation: { ...x.validation, checks: { ...x.validation.checks, [kind]: { revisionId: report.revisionId, ...(loaded ? { loaded } : {}), report } } } }));
        } catch (e) {
          // Stopped, or about a revision that was gone by then: asked again when wanted. Anything else is said.
          if (e instanceof ValidationError && (e.code === 'cancelled' || e.code === 'stale-revision')) return;
          if (get().version.revision === revisionId) set((x) => ({ validation: { ...x.validation, checks: { ...x.validation.checks, [kind]: { revisionId, ...(loaded ? { loaded } : {}), error: e instanceof Error ? e.message : String(e) } } } }));
        } finally {
          if (asked[kind] === mine) delete asked[kind];
        }
      })();
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
  };
};
