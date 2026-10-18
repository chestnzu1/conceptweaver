import { WORKING_COPY } from '../../structure/local';
import { CATEGORIES, MODEL_DATA, ValidationError, type DataGraph, type Scope, type ValidationReport, type ValidationService } from '../../validation/contracts';
import { createLocalValidationService } from '../../validation/local';
import { isStale } from '../../validation/report';
import { currentData, currentShapeSet, graphText } from '../dataGraphs';
import type { Model } from '../types';
import { supports } from '../modelTypes';
import { DEFAULT_REASONER_URL, type DlReasonerChoice, type EngineId, type ReasoningResult } from '../reasoning';
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
  return s.validation.engine === 'dl' && dl?.revisionId === s.version.revision && dl.reasoner === s.validation.dlReasoner && dl.result.status !== 'failed' ? dl.result : undefined;
};

/**
 * Whether the last run no longer describes what is in the editor: another revision of the model,
 * another data graph or another content of it, or another choice of shapes.
 */
export const runIsStale = (s: Pick<State, 'model' | 'version' | 'validation'>): boolean => isStale(s.validation.run, s.version.revision, currentData(s.model, s.validation.data), currentShapeSet(s.model, s.validation.shapeSet));

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
    /** The data graph SHACL validates: the model's own, or one of its data graphs (without its content). */
    data: DataGraph;
    /** The shape set SHACL validates with, by its id; every set when none. */
    shapeSet: string | null;
    tab: 'results' | 'rules' | 'inferences' | 'graphs';
    /** Which reasoner answers the OWL questions: the app's own rules, or the OWL 2 DL reasoning service. */
    engine: EngineId;
    /** Where the reasoning service is. */
    reasonerUrl: string;
    /** Which of its reasoners: chosen by the ontology's profile (the default), HermiT or ELK. */
    dlReasoner: DlReasonerChoice;
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
  setValidation: (patch: Partial<Pick<State['validation'], 'data' | 'shapeSet' | 'tab' | 'engine' | 'reasonerUrl' | 'dlReasoner' | 'focus'>>) => void;
}

export const validationSlice: Slice<ValidationSlice> = (set, get) => {
  const ref = () => ({ ontologyId: get().doc.id ?? WORKING_COPY, revisionId: get().version.revision });
  const service = createLocalValidationService({
    current: () => ({ model: get().model, ...ref() }),
    withImports: (model: Model) => (model.externals.some((e) => e.imports) ? get().alignmentService.closure(model, new Map(Object.entries(get().ext.loaded))) : undefined),
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
      shapeSet: null,
      tab: 'results',
      focus: null,
      checks: {},
      ...(() => {
        try {
          const chosen = localStorage.getItem('conceptweaver:dl-reasoner');
          return {
            engine: (localStorage.getItem('conceptweaver:reasoning-engine') === 'dl' ? 'dl' : 'fast') as EngineId,
            reasonerUrl: localStorage.getItem('conceptweaver:reasoner-url') || DEFAULT_REASONER_URL,
            dlReasoner: (chosen === 'hermit' || chosen === 'elk' ? chosen : 'auto') as DlReasonerChoice,
          };
        } catch {
          return { engine: 'fast' as EngineId, reasonerUrl: DEFAULT_REASONER_URL, dlReasoner: 'auto' as DlReasonerChoice };
        }
      })(),
    },
    validationService: service,
    runValidation: async (scope = 'all') => {
      if (get().validation.running || !supports(get().model, 'validation')) return;
      const { run, engine } = get().validation;
      const categories = scope === 'all' ? CATEGORIES : [scope];
      // The data graph and the shape set as they are in the model now; a graph's content is read where SHACL needs it.
      const data = currentData(get().model, get().validation.data);
      const shapeSet = currentShapeSet(get().model, get().validation.shapeSet);
      set((s) => ({ validation: { ...s.validation, running: true, phase: categories.includes('shacl') && data.id ? 'Reading the data graph…' : 'Starting…' } }));
      try {
        const text = categories.includes('shacl') && data.id ? await graphText(data.id) : undefined;
        // An ontology that imports others is checked together with them, as far as they are in this browser.
        const job = await service.start({ ...ref(), categories, data: text === undefined ? data : { ...data, text }, ...(shapeSet ? { shapeSet } : {}), engine, imports: true, ...(run ? { previous: run } : {}) });
        set((s) => ({ validation: { ...s.validation, job: job.job } }));
        const report = await service.report(job.job);
        set((s) => ({ validation: { ...s.validation, run: report, running: false, phase: '', job: null } }));
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
        if (patch.dlReasoner) localStorage.setItem('conceptweaver:dl-reasoner', patch.dlReasoner);
      } catch {
        // Remembered for this visit only.
      }
      // Another reasoner chosen: the last one's answer is not left standing as if it were this one's.
      const switched = patch.dlReasoner !== undefined && patch.dlReasoner !== get().validation.dlReasoner;
      set((s) => ({ validation: { ...s.validation, ...patch }, ...(switched ? { reasoning: { ...s.reasoning, dl: null } } : {}) }));
    },
  };
};
