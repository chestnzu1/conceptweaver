import type { DlRequest } from '../model/reasoning';
import { ReasoningError, type CallOptions, type OntologyRef, type ReasoningAnswer, type ReasoningErrorCode, type ReasoningJob, type ReasoningService } from './contracts';

/**
 * The reasoning service asked over HTTP: what the editor is given in place of the local service
 * once a backend reasons. Each question is one POST of the query as JSON to
 * `{base}/reasoning/{question}`, answered with the result as JSON.
 *
 * A start carries the ontology and its imports, as the local service carries its model: the
 * service holds no ontology of its own until ontology sessions (roadmap task 3.4). `content`
 * says what a revision is, so that a caller asks by revision only.
 *
 * It is not what the app uses today. It is here so that what goes over the wire is settled, and
 * tested against the local service, before the app adopts it (3.4, 3.7).
 */

/** The questions, by the name each is asked under. */
export const QUESTIONS = ['start', 'status', 'cancel', 'result'] as const;
export type Question = (typeof QUESTIONS)[number];

/** How each reason for not answering is said in HTTP. Anything else that goes wrong is a 500, which is nobody's refusal. */
export const STATUS: Record<ReasoningErrorCode, number> = { 'stale-revision': 409, 'not-found': 404, cancelled: 409, failed: 422, aborted: 499, busy: 429, invalid: 400, unsupported: 501 };

/** What the service is to reason over for a revision: the ontology, its imports, and how to ask. */
export type ReasoningContent = (ref: OntologyRef) => DlRequest | Promise<DlRequest>;

export function createHttpReasoningService(base: string, content: ReasoningContent, send: typeof fetch = fetch): ReasoningService {
  const root = base.replace(/\/+$/, '');
  const ask = async <T>(question: Question, query: unknown, options?: CallOptions): Promise<T> => {
    if (options?.signal?.aborted) throw new ReasoningError('aborted', 'The question was given up.');
    let response: Response;
    try {
      response = await send(`${root}/reasoning/${question}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: options?.signal });
    } catch (e) {
      // Giving a question up ends the request, which the browser reports as a failure of its own.
      if (options?.signal?.aborted) throw new ReasoningError('aborted', 'The question was given up.');
      throw e;
    }
    let body: (T & { code?: ReasoningErrorCode; message?: string }) | undefined;
    try {
      body = (await response.json()) as T & { code?: ReasoningErrorCode; message?: string };
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      if (body?.code && body.code in STATUS) throw new ReasoningError(body.code, body.message ?? 'The question was not answered.');
      throw new Error(body?.message ?? `The reasoning service answered ${response.status}.`);
    }
    if (body === undefined) throw new Error(`What answered at ${root} is not the reasoning service.`);
    return body;
  };
  const about = (job: string) => ({ job });
  return {
    async start(query, options) {
      if (options?.signal?.aborted) throw new ReasoningError('aborted', 'The question was given up.');
      const request = await content({ ontologyId: query.ontologyId, revisionId: query.revisionId });
      if (options?.signal?.aborted) throw new ReasoningError('aborted', 'The question was given up.');
      // The question is the revision and engine; the content is what makes the revision concrete here.
      return ask<ReasoningJob>(
        'start',
        { ...query, ontology: request.ontology, imports: request.imports, timeoutMs: request.timeoutMs, explanations: request.explanations, ...(request.reasoner ? { reasoner: request.reasoner } : {}) },
        options,
      );
    },
    status: (job, options) => ask<ReasoningJob>('status', about(job), options),
    cancel: (job) => ask<ReasoningJob>('cancel', about(job)),
    result: (job, options) => ask<ReasoningAnswer>('result', about(job), options),
  };
}

/**
 * The other end of it: what a server does with one request, given a reasoning service to put the
 * question to. The status and the body it answers with are exactly what the client above expects.
 * A start is the whole question, content and all; the rest name a job.
 */
export async function answerReasoningRequest(service: ReasoningService, question: string, query: unknown): Promise<{ status: number; body: unknown }> {
  if (!(QUESTIONS as readonly string[]).includes(question)) return { status: 404, body: { message: `There is no question “${question}”.` } };
  try {
    const answer =
      question === 'start'
        ? await service.start(query as Parameters<ReasoningService['start']>[0])
        : question === 'status'
          ? await service.status(String((query as { job?: unknown })?.job))
          : question === 'cancel'
            ? await service.cancel(String((query as { job?: unknown })?.job))
            : await service.result(String((query as { job?: unknown })?.job));
    return { status: 200, body: answer };
  } catch (e) {
    if (e instanceof ReasoningError) return { status: STATUS[e.code], body: { code: e.code, message: e.message } };
    return { status: 500, body: { message: e instanceof Error ? e.message : 'The question could not be answered.' } };
  }
}
