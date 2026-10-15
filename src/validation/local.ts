import type { QuickFix } from '../model/quality';
import type { DlReport } from '../reasoning/contracts';
import type { Model } from '../model/types';
import { qualityFindings, validate } from '../model/validation';
import { ValidationError, type CallOptions, type Category, type DataGraph, type Finding, type OntologyRef, type ValidationJob, type ValidationReport, type ValidationService } from './contracts';

/**
 * The validation service of the editor: the checks of the model in it, as jobs.
 *
 * The checks run in a Web Worker, one for each job, so that the page is never held up while they
 * work; stopping a job stops its worker. Where there are no workers (in tests, or where one
 * cannot be started) they run here, between moments in which the page can redraw. When the OWL 2
 * DL reasoner is the one chosen it is asked first, through the reasoning service, and its answer
 * goes into the job.
 */

/** What a job is given to work on. */
export interface WorkerInput {
  model: Model;
  data: DataGraph;
  categories: Category[];
  previous?: ValidationReport;
  withImports?: Model;
  dl?: DlReport;
  ref: OntologyRef;
}

/** How the checks are run: given their input, what they find, unless `signal` stops them first; `progress` hears what they are doing. */
export type Runner = (input: WorkerInput, signal: AbortSignal, progress: (phase: string) => void) => Promise<ValidationReport>;

const cancelled = () => new ValidationError('cancelled', 'The job was stopped.');

/** A report as it travels: a quick fix as what it does, in words, without the function that does it. */
export const plain = (report: ValidationReport): ValidationReport => ({ ...report, findings: report.findings.map((f) => (f.fix ? { ...f, fix: { label: f.fix.label, preview: f.fix.preview } } : f)) });

/** The checks on the page itself, giving it a moment to redraw between parts. */
export const onThePage: Runner = async (input, signal, progress) => {
  const tick = async (phase: string) => {
    progress(phase);
    await new Promise((r) => setTimeout(r, 0));
    if (signal.aborted) throw cancelled();
  };
  await tick('Starting…');
  return validate(input.model, input.data, input.categories, input.previous ?? null, { tick, withImports: input.withImports, askDl: input.dl ? async () => input.dl! : undefined, ref: input.ref });
};

/** The checks in a worker of their own, which is stopped when the job is. */
export const inAWorker: Runner = (input, signal, progress) => {
  if (typeof Worker === 'undefined') return onThePage(input, signal, progress);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return onThePage(input, signal, progress);
  }
  return new Promise<ValidationReport>((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(cancelled());
    };
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    const end = () => {
      signal.removeEventListener('abort', stop);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ phase?: string; report?: ValidationReport; error?: string }>) => {
      if (e.data.phase !== undefined) return progress(e.data.phase);
      end();
      if (e.data.report) resolve(e.data.report);
      else reject(new ValidationError('failed', e.data.error || 'The checks stopped.'));
    };
    worker.onerror = (e) => {
      end();
      // A worker that cannot be loaded is no reason to check nothing.
      e.preventDefault?.();
      onThePage(input, signal, progress).then(resolve, reject);
    };
    worker.postMessage(input);
  });
};

/** What the validation service is given of the editor. */
export interface ValidationHost {
  /** The ontology being edited, as it is now. */
  current(): { model: Model; ontologyId: string; revisionId: string };
  /** The ontology together with the ones it imports, as far as they are in this browser; nothing where it imports none. */
  withImports(model: Model): Model | undefined;
  /** Asks the OWL 2 DL reasoner about the model as it is, unless `signal` gives the question up: its report, or nothing when it was stopped. */
  askDl(signal: AbortSignal): Promise<DlReport | undefined>;
  /** Told of every change of a job: begun, how it goes, finished, failed, stopped. */
  changed?(job: ValidationJob): void;
}

const KEPT = 32;

interface Held {
  status: ValidationJob;
  report: Promise<ValidationReport>;
  stop: AbortController;
}

export function createLocalValidationService(host: ValidationHost, run: Runner = inAWorker): ValidationService {
  const jobs = new Map<string, Held>();
  let made = 0;
  const held = (job: string): Held => {
    const h = jobs.get(job);
    if (!h) throw new ValidationError('not-found', `There is no job ${job}.`);
    return h;
  };
  const given = (options?: CallOptions) => {
    if (options?.signal?.aborted) throw new ValidationError('aborted', 'The question was given up.');
  };
  const update = (h: Held, patch: Partial<ValidationJob>) => {
    if (h.status.state !== 'running' && patch.state === undefined) return;
    h.status = { ...h.status, ...patch };
    host.changed?.(h.status);
  };

  return {
    async start(query, options) {
      given(options);
      const now = host.current();
      if (query.ontologyId !== now.ontologyId) throw new ValidationError('not-found', `The ontology “${query.ontologyId}” is not the one being edited.`);
      if (query.revisionId !== now.revisionId) throw new ValidationError('stale-revision', `The ontology has moved on from revision ${query.revisionId}.`);
      const stop = new AbortController();
      const ref = { ontologyId: now.ontologyId, revisionId: now.revisionId };
      const h = { stop, status: { ...ref, job: `checks-${++made}`, categories: query.categories, state: 'running', phase: 'Starting…' } } as Held;
      const model = now.model;
      h.report = (async () => {
        // The OWL 2 DL reasoner, when it is the one chosen, is asked first, as a reasoning job of its own.
        let dl: DlReport | undefined;
        if (query.engine === 'dl' && query.categories.includes('owl') && model.mode !== 'skos') {
          update(h, { phase: 'Reasoning with the OWL 2 DL reasoner…' });
          dl = await host.askDl(stop.signal);
          if (!dl || stop.signal.aborted) throw cancelled();
        }
        const input: WorkerInput = { model, data: query.data, categories: query.categories, ref, ...(query.previous ? { previous: query.previous } : {}), ...(dl ? { dl } : {}) };
        const closure = query.imports && !dl ? host.withImports(model) : undefined;
        if (closure) input.withImports = closure;
        return plain(await run(input, stop.signal, (phase) => update(h, { phase })));
      })().then(
        (report) => {
          if (stop.signal.aborted) throw cancelled();
          update(h, { state: 'done', phase: '' });
          return report;
        },
        (e: unknown) => {
          if (stop.signal.aborted || (e instanceof ValidationError && e.code === 'cancelled')) {
            update(h, { state: 'cancelled', phase: '' });
            throw cancelled();
          }
          const error = e instanceof Error ? e.message : String(e);
          update(h, { state: 'failed', phase: '', error });
          throw new ValidationError('failed', error);
        },
      );
      // Nobody may ever wait for the report: that it went wrong is not to be left unheard of.
      h.report.catch(() => {});
      jobs.set(h.status.job, h);
      for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - KEPT))) jobs.delete(old);
      host.changed?.(h.status);
      return h.status;
    },
    async status(job, options) {
      given(options);
      return held(job).status;
    },
    async cancel(job) {
      const h = held(job);
      if (h.status.state === 'running' || h.status.state === 'queued') {
        h.stop.abort();
        update(h, { state: 'cancelled', phase: '' });
      }
      return h.status;
    },
    async report(job, options) {
      given(options);
      const h = held(job);
      if (!options?.signal) return h.report;
      const signal = options.signal;
      return new Promise<ValidationReport>((resolve, reject) => {
        const giveUp = () => reject(new ValidationError('aborted', 'The question was given up.'));
        signal.addEventListener('abort', giveUp, { once: true });
        h.report.then(resolve, reject).finally(() => signal.removeEventListener('abort', giveUp));
      });
    },
  };
}

/**
 * The quick fix of a finding, ready to apply to `model`: a finding travels with what its fix
 * does, in words, and the fix itself is found again here, by checking the model the finding is
 * of. Nothing where the model no longer has it.
 */
export function fixOf(model: Model, finding: Finding): QuickFix | undefined {
  if (finding.category !== 'quality' || !finding.fix) return undefined;
  const again = qualityFindings(model).findings.find((f) => f.id === finding.id);
  return again?.fix && again.fix.label === finding.fix.label ? again.fix : undefined;
}
