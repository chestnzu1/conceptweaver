import { EditError, type Applied, type CallOptions, type ChangeSet, type EntityAxioms, type OntologyEditService, type OntologyRef, type Verdict } from './contracts';

/**
 * The edit service asked over HTTP: what the editor is given in place of the local one once the
 * ontology lives in a backend. Each question is one POST of the query as JSON to
 * `{base}/editing/{question}`, answered with the result as JSON. A change set that is refused
 * answers with its code, its message and its refusals; a change set that is applied answers with
 * the new revision, which a backend that holds ontologies by content hash is.
 *
 * It is not what the app uses today. It is here so that what goes over the wire is settled, and
 * tested against the local service, before there is a backend to write.
 */

export const QUESTIONS = ['apply', 'validate', 'entity'] as const;
export type Question = (typeof QUESTIONS)[number];

/** How each reason for not answering is said in HTTP. Anything else that goes wrong is a 500, which is nobody's refusal. */
export const STATUS: Record<string, number> = { 'stale-revision': 409, 'not-found': 404, refused: 409, unsupported: 501, aborted: 499 };

export function createHttpEditService(base: string, send: typeof fetch = fetch): OntologyEditService {
  const root = base.replace(/\/+$/, '');
  const ask = async <T>(question: Question, query: unknown, options?: CallOptions): Promise<T> => {
    if (options?.signal?.aborted) throw new EditError('aborted', 'The question was given up.');
    let response: Response;
    try {
      response = await send(`${root}/editing/${question}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: options?.signal });
    } catch (e) {
      // Giving a question up ends the request, which the browser reports as a failure of its own.
      if (options?.signal?.aborted) throw new EditError('aborted', 'The question was given up.');
      throw e;
    }
    const body = (await response.json()) as T & { code?: string; message?: string; refusals?: unknown[] };
    if (!response.ok) {
      if (body.code && body.code in STATUS) throw new EditError(body.code as EditError['code'], body.message ?? 'The question was not answered.', body.refusals as EditError['refusals']);
      throw new Error(body.message ?? `The edit service answered ${response.status}.`);
    }
    return body;
  };
  return {
    apply: (query, options) => ask('apply', query, options),
    validate: (query, options) => ask('validate', query, options),
    entity: (query, options) => ask('entity', query, options),
  };
}

/**
 * The other end of it: what a server does with one request, given an edit service to put the
 * question to. The status and the body it answers with are exactly what the client above expects.
 */
export async function answerEditRequest(service: OntologyEditService, question: string, query: unknown): Promise<{ status: number; body: unknown }> {
  if (!(QUESTIONS as readonly string[]).includes(question)) return { status: 404, body: { code: 'not-found', message: `There is no question “${question}”.` } };
  try {
    const answer = await (service[question as Question] as (q: never) => Promise<unknown>)(query as never);
    return { status: 200, body: answer };
  } catch (e) {
    if (e instanceof EditError) return { status: STATUS[e.code], body: { code: e.code, message: e.message, ...(e.refusals.length ? { refusals: e.refusals } : {}) } };
    return { status: 500, body: { message: e instanceof Error ? e.message : 'The question could not be answered.' } };
  }
}

/** What a change set over one revision looks like on the wire, for a service that holds ontologies by content hash. */
export type WireApplied = Applied & { document?: string };
export type WireVerdict = Verdict;
export type WireChangeSet = ChangeSet;
export type WireEntity = EntityAxioms & OntologyRef;
