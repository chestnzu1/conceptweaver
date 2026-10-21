import { describe, expect, it } from 'vitest';
import { sampleModel } from '../model/sample';
import type { Model } from '../model/types';
import { ReasoningError, type DlReport, type ReasoningService } from './contracts';
import { answerReasoningRequest, createHttpReasoningService, QUESTIONS, STATUS } from './http';
import { createLocalReasoningService, onThePage, type Runner } from './local';

const REPORT: DlReport = { engine: 'HermiT', engineVersion: '1.4', status: 'complete', consistency: 'consistent', ms: 3, errors: [], warnings: [] };
const REF = { ontologyId: 'working-copy', revisionId: 'r1' };
const CONTENT = {
  ontology: '@prefix : <http://example.org/> .',
  imports: [{ iri: 'http://example.org/import', text: '@prefix : <http://example.org/> .' }],
  timeoutMs: 60_000,
  explanations: { perSubject: 1, max: 25, timeoutMs: 20_000 },
  reasoner: 'auto' as const,
};

/** A service over one model, as the editor holds it. */
const service = (model: Model, run: Runner = onThePage, askDl: (m: Model, s: AbortSignal) => Promise<DlReport> = async () => REPORT) =>
  createLocalReasoningService({ current: () => ({ model, ontologyId: REF.ontologyId, revisionId: REF.revisionId }), askDl }, run);

/**
 * A local service and another asked over HTTP through the same JSON. Two services, not one:
 * each numbers its jobs from the same start, so the answers can be compared job for job. They
 * reason over the same model, whose ids are the answer's: a sample model is made anew each time.
 */
function services(run?: Runner, askDl?: (m: Model, s: AbortSignal) => Promise<DlReport>) {
  const model = sampleModel();
  const local = service(model, run, askDl);
  const server = service(model, run, askDl);
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    sent.push({ url, body });
    const answer = await answerReasoningRequest(server, url.slice(url.lastIndexOf('/') + 1), body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { local, remote: createHttpReasoningService('http://backend.example/api/', () => CONTENT, send), sent };
}

/** What JSON keeps of an answer, which is what a service over HTTP can answer with. */
const wire = <T>(answer: T): T => JSON.parse(JSON.stringify(answer)) as T;

describe('the reasoning service over HTTP', () => {
  it('gives the same answer to every question as the service it is put in front of', async () => {
    const { local, remote, sent } = services();
    for (const engine of ['fast', 'dl'] as const) {
      const here = await local.start({ ...REF, engine });
      const there = await remote.start({ ...REF, engine });
      expect(there).toEqual(here);
      expect(await remote.status(there.job)).toEqual(await local.status(here.job));
      const [mine, yours] = [await local.result(here.job), await remote.result(there.job)];
      expect(yours).toEqual(wire(mine));
      expect((await remote.status(there.job)).state).toBe('done');
    }
    expect(sent.map((x) => x.url)).toEqual([
      'http://backend.example/api/reasoning/start',
      'http://backend.example/api/reasoning/status',
      'http://backend.example/api/reasoning/result',
      'http://backend.example/api/reasoning/status',
      'http://backend.example/api/reasoning/start',
      'http://backend.example/api/reasoning/status',
      'http://backend.example/api/reasoning/result',
      'http://backend.example/api/reasoning/status',
    ]);
    // The whole of the question is in what is sent, the content that makes the revision concrete
    // included; nothing is narrowed on this side.
    expect(sent[0].body).toEqual({ ...REF, engine: 'fast', ...CONTENT });
    expect(QUESTIONS).toEqual(['start', 'status', 'cancel', 'result']);
  });

  it('refuses over the wire what the service refuses, by the same code and message', async () => {
    const { local, remote } = services();
    const refusal = async (run: (s: ReasoningService) => Promise<unknown>) => {
      const [here, there] = [await of(local, run), await of(remote, run)];
      expect(there).toEqual(here);
      return there;
    };
    expect(await refusal((s) => s.start({ ...REF, revisionId: 'r0', engine: 'fast' }))).toMatchObject({ code: 'stale-revision' });
    expect(await refusal((s) => s.status('nothing'))).toMatchObject({ code: 'not-found' });
    expect(await refusal((s) => s.result('nothing'))).toMatchObject({ code: 'not-found' });

    const broken = services(onThePage, async () => {
      throw new Error('Out of memory.');
    });
    const failed = async (s: ReasoningService) => s.start({ ...REF, engine: 'dl' }).then((job) => s.result(job.job));
    expect(await of(broken.local, failed)).toMatchObject({ code: 'failed', message: 'Out of memory.' });
    expect(await of(broken.remote, failed)).toMatchObject({ code: 'failed', message: 'Out of memory.' });

    expect(await answerReasoningRequest(local, 'delete', {})).toMatchObject({ status: 404 });
    expect(STATUS).toMatchObject({ 'stale-revision': 409, 'not-found': 404, cancelled: 409, failed: 422, aborted: 499, busy: 429 });
  });

  it('stops a job over the wire, and the answer is no longer wanted', async () => {
    // A reasoner that works until it is stopped.
    const forever: Runner = (_m, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ReasoningError('cancelled', 'Stopped.'))));
    const { local, remote } = services(forever);
    const here = await local.start({ ...REF, engine: 'fast' });
    const there = await remote.start({ ...REF, engine: 'fast' });
    expect(await remote.cancel(there.job)).toEqual(await local.cancel(here.job));
    await expect(local.result(here.job)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(remote.result(there.job)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('lets a question be given up, and says when the service has as much work as it takes', async () => {
    const { remote } = services();
    const gone = new AbortController();
    gone.abort();
    await expect(remote.start({ ...REF, engine: 'fast' }, { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
    await expect(remote.result('fast-1', { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });

    // A backend that is at its limit refuses the start rather than queueing without end.
    const busy = (async () => new Response(JSON.stringify({ code: 'busy', message: 'The reasoning service is busy.' }), { status: 429 })) as typeof fetch;
    const full = createHttpReasoningService('http://backend.example/api/', () => CONTENT, busy);
    await expect(full.start({ ...REF, engine: 'dl' })).rejects.toMatchObject({ code: 'busy', message: 'The reasoning service is busy.' });
  });
});

/** What one service does with a question, as a code and a message; the answer itself is not compared. */
async function of(service: ReasoningService, run: (s: ReasoningService) => Promise<unknown>) {
  try {
    await run(service);
    return { code: 'answered', message: '' };
  } catch (e) {
    return e instanceof ReasoningError ? { code: e.code, message: e.message } : { code: 'other', message: e instanceof Error ? e.message : String(e) };
  }
}
