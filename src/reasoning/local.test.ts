import { describe, expect, it } from 'vitest';
import { reason, view } from '../model/reasoner';
import { sampleModel, skosSample } from '../model/sample';
import { universitySample } from '../model/sampleUniversity';
import { stressModel } from '../model/stress';
import type { Model } from '../model/types';
import { ReasoningError, type DlReport, type ReasoningJob } from './contracts';
import { createLocalReasoningService, onThePage, type Runner } from './local';

const REPORT: DlReport = { engine: 'HermiT', engineVersion: '1.4', status: 'complete', consistency: 'consistent', ms: 3, errors: [], warnings: [] };

/** A service over one model, as the editor holds it. */
const serviceOver = (model: Model, run: Runner = onThePage, askDl = async (_m: Model, _s: AbortSignal) => REPORT) => {
  const seen: ReasoningJob[] = [];
  const now = { model, ontologyId: 'working-copy', revisionId: 'r1' };
  const service = createLocalReasoningService({ current: () => now, askDl, changed: (job) => seen.push(job) }, run);
  return { service, seen, now };
};
const ref = { ontologyId: 'working-copy', revisionId: 'r1' };

describe('the fast reasoner as a job', () => {
  it('answers with what follows, the same as reasoning on the page, from a copy of its work', async () => {
    for (const model of [sampleModel(), skosSample(), universitySample(), stressModel(60)]) {
      const { service } = serviceOver(model);
      const job = await service.start({ ...ref, engine: 'fast' });
      const answer = await service.result(job.job);
      if (answer.engine !== 'fast') throw new Error('Not the fast reasoner.');
      // What a worker sends is copied on the way: the answer is plain data, and reads the same.
      const copy = structuredClone(answer.derivation);
      const here = reason(model, true);
      const there = view(model, copy);
      expect(there.consistent).toBe(here.consistent);
      expect(there.conflicts).toEqual(here.conflicts);
      expect(there.inferences).toEqual(here.inferences);
      expect([there.asserted, there.inferred, there.truncated]).toEqual([here.asserted, here.inferred, here.truncated]);
      expect([...there.unsatisfiable]).toEqual([...here.unsatisfiable]);
      for (const t of model.terms) {
        expect(there.superclasses(t.id)).toEqual(here.superclasses(t.id));
        expect(there.types(t.id)).toEqual(here.types(t.id));
      }
    }
  });

  it('says how it goes, and of which revision its answer is', async () => {
    const { service, seen } = serviceOver(sampleModel());
    const job = await service.start({ ...ref, engine: 'fast' });
    expect(job).toMatchObject({ ...ref, engine: 'fast', state: 'running' });
    const answer = await service.result(job.job);
    expect(answer).toMatchObject({ ...ref, engine: 'fast' });
    expect((await service.status(job.job)).state).toBe('done');
    expect(seen.map((j) => j.state)).toEqual(['running', 'done']);
  });

  it('can be stopped, and then has no answer', async () => {
    // A reasoner that works until it is stopped.
    const forever: Runner = (_m, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ReasoningError('cancelled', 'Stopped.'))));
    const { service } = serviceOver(sampleModel(), forever);
    const job = await service.start({ ...ref, engine: 'fast' });
    const waiting = service.result(job.job);
    expect((await service.cancel(job.job)).state).toBe('cancelled');
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    // Stopping a job that has finished changes nothing.
    const other = serviceOver(sampleModel()).service;
    const done = await other.start({ ...ref, engine: 'fast' });
    await other.result(done.job);
    expect((await other.cancel(done.job)).state).toBe('done');
  });

  it('is refused for a revision the ontology has moved on from, or another ontology', async () => {
    const { service } = serviceOver(sampleModel());
    await expect(service.start({ ...ref, revisionId: 'r0', engine: 'fast' })).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(service.start({ ...ref, ontologyId: 'another', engine: 'fast' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.status('nothing')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('says why it failed', async () => {
    const broken: Runner = async () => {
      throw new Error('Out of memory.');
    };
    const { service } = serviceOver(sampleModel(), broken);
    const job = await service.start({ ...ref, engine: 'fast' });
    await expect(service.result(job.job)).rejects.toMatchObject({ code: 'failed', message: 'Out of memory.' });
    expect(await service.status(job.job)).toMatchObject({ state: 'failed', error: 'Out of memory.' });
  });
});

describe('the OWL 2 DL reasoner as a job', () => {
  it('answers with what the reasoning service says, and can be stopped', async () => {
    let stopped = false;
    const slow = (_m: Model, signal: AbortSignal) =>
      new Promise<DlReport>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          stopped = true;
          reject(new ReasoningError('cancelled', 'Stopped.'));
        });
        setTimeout(() => resolve(REPORT), 50);
      });
    const { service } = serviceOver(sampleModel(), onThePage, slow);
    const answered = await service.start({ ...ref, engine: 'dl' });
    expect(await service.result(answered.job)).toEqual({ ...ref, engine: 'dl', report: REPORT });
    const given = await service.start({ ...ref, engine: 'dl' });
    await service.cancel(given.job);
    expect(stopped).toBe(true);
    await expect(service.result(given.job)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('lets a question for the answer be given up without stopping the job', async () => {
    const { service } = serviceOver(sampleModel());
    const job = await service.start({ ...ref, engine: 'dl' });
    const gone = new AbortController();
    const waiting = service.result(job.job, { signal: gone.signal });
    gone.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    expect((await service.result(job.job)).engine).toBe('dl');
  });
});
