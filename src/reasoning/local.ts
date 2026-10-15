import { derive } from '../model/reasoner';
import { ReasonerCancelled } from '../model/reasoning';
import type { Model } from '../model/types';
import { ReasoningError, type CallOptions, type Derivation, type DlReport, type EngineId, type ReasoningAnswer, type ReasoningJob, type ReasoningService } from './contracts';

/**
 * The reasoning service of the editor: reasoning about the model in it, as jobs.
 *
 * The fast reasoner runs in a Web Worker, one for each job, so that the page is never held up
 * while it works; stopping a job stops its worker. Where there are no workers (in tests, or where
 * one cannot be started) it runs here, after the page has had a moment to show that it is busy.
 * The OWL 2 DL reasoner is asked through the reasoning service beside the app, a request that
 * stopping the job gives up.
 *
 * Each job is of the revision it was started for, and its answer is that revision's; whether the
 * answer is still wanted is for whoever asked to say.
 */

/** How the fast reasoner is run: given a model, what follows from it, unless `signal` stops it first. */
export type Runner = (model: Model, signal: AbortSignal) => Promise<Derivation>;

const cancelled = () => new ReasoningError('cancelled', 'The job was stopped.');

/** The fast reasoner on the page itself, after a moment in which the page can redraw. */
export const onThePage: Runner = async (model, signal) => {
  await new Promise((r) => setTimeout(r, 0));
  if (signal.aborted) throw cancelled();
  return derive(model);
};

/** The fast reasoner in a worker of its own, which is stopped when the job is. */
export const inAWorker: Runner = (model, signal) => {
  if (typeof Worker === 'undefined') return onThePage(model, signal);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return onThePage(model, signal);
  }
  return new Promise<Derivation>((resolve, reject) => {
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
    worker.onmessage = (e: MessageEvent<{ derivation?: Derivation; error?: string }>) => {
      end();
      if (e.data.derivation) resolve(e.data.derivation);
      else reject(new ReasoningError('failed', e.data.error || 'The reasoner stopped.'));
    };
    worker.onerror = (e) => {
      end();
      // A worker that cannot be loaded is no reason to give no answer.
      e.preventDefault?.();
      onThePage(model, signal).then(resolve, reject);
    };
    worker.postMessage({ model });
  });
};

/** What the reasoning service is given of the editor. */
export interface ReasoningHost {
  /** The ontology being edited, as it is now. */
  current(): { model: Model; ontologyId: string; revisionId: string };
  /** Asks the OWL 2 DL reasoner about a model, unless `signal` gives the question up. */
  askDl(model: Model, signal: AbortSignal): Promise<DlReport>;
  /** Told of every change of a job: begun, answered, failed, stopped. */
  changed?(job: ReasoningJob): void;
}

/** How many jobs, finished or not, are remembered. */
const KEPT = 32;

interface Held {
  status: ReasoningJob;
  answer: Promise<ReasoningAnswer>;
  stop: AbortController;
}

export function createLocalReasoningService(host: ReasoningHost, run: Runner = inAWorker): ReasoningService {
  const jobs = new Map<string, Held>();
  let made = 0;
  const held = (job: string): Held => {
    const h = jobs.get(job);
    if (!h) throw new ReasoningError('not-found', `There is no job ${job}.`);
    return h;
  };
  const given = (options?: CallOptions) => {
    if (options?.signal?.aborted) throw new ReasoningError('aborted', 'The question was given up.');
  };
  const update = (h: Held, patch: Partial<ReasoningJob>) => {
    h.status = { ...h.status, ...patch };
    host.changed?.(h.status);
  };

  return {
    async start(query, options) {
      given(options);
      const now = host.current();
      if (query.ontologyId !== now.ontologyId) throw new ReasoningError('not-found', `The ontology “${query.ontologyId}” is not the one being edited.`);
      if (query.revisionId !== now.revisionId) throw new ReasoningError('stale-revision', `The ontology has moved on from revision ${query.revisionId}.`);
      const engine: EngineId = query.engine;
      const stop = new AbortController();
      const h = { stop, status: { job: `${engine}-${++made}`, ontologyId: now.ontologyId, revisionId: now.revisionId, engine, state: 'running', phase: engine === 'fast' ? 'Reasoning…' : 'Asking the OWL 2 DL reasoner…' } } as Held;
      const ref = { ontologyId: now.ontologyId, revisionId: now.revisionId };
      h.answer = (engine === 'fast' ? run(now.model, stop.signal).then((derivation): ReasoningAnswer => ({ ...ref, engine, derivation })) : host.askDl(now.model, stop.signal).then((report): ReasoningAnswer => ({ ...ref, engine: 'dl', report }))).then(
        (answer) => {
          if (stop.signal.aborted) throw cancelled();
          update(h, { state: 'done', phase: '' });
          return answer;
        },
        (e: unknown) => {
          const stopped = stop.signal.aborted || e instanceof ReasonerCancelled || (e instanceof ReasoningError && e.code === 'cancelled');
          if (stopped) {
            update(h, { state: 'cancelled', phase: '' });
            throw cancelled();
          }
          const error = e instanceof Error ? e.message : String(e);
          update(h, { state: 'failed', phase: '', error });
          throw new ReasoningError('failed', error);
        },
      );
      // Nobody may ever wait for the answer: that it went wrong is not to be left unheard of.
      h.answer.catch(() => {});
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
    async result(job, options) {
      given(options);
      const h = held(job);
      if (!options?.signal) return h.answer;
      const signal = options.signal;
      return new Promise<ReasoningAnswer>((resolve, reject) => {
        const giveUp = () => reject(new ReasoningError('aborted', 'The question was given up.'));
        signal.addEventListener('abort', giveUp, { once: true });
        h.answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', giveUp));
      });
    },
  };
}
