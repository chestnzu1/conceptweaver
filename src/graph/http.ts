import { GraphError, type CallOptions, type GraphErrorCode, type GraphService } from './contracts';

/**
 * The graph service asked over HTTP: what the canvas and the subgraph panel are given in place
 * of the local one once the ontology lives in a backend, which then walks the graph itself. Each
 * question is one POST of the query as JSON to `{base}/graph/{question}`, answered with the
 * result as JSON. Nothing of the view changes: it knows the service by its interface only.
 *
 * It is not what the app uses today. It is here so that what goes over the wire is settled, and
 * tested against the local service, before there is a backend to write.
 */

export const QUESTIONS = ['neighbourhood', 'search', 'kinds'] as const;
export type Question = (typeof QUESTIONS)[number];

/** How each reason for not answering is said in HTTP. Anything else that goes wrong is a 500, which is nobody's refusal. */
export const STATUS: Record<GraphErrorCode, number> = { 'stale-revision': 409, invalid: 400, aborted: 499 };

export function createHttpGraphService(base: string, send: typeof fetch = fetch): GraphService {
  const root = base.replace(/\/+$/, '');
  const ask = async <T>(question: Question, query: unknown, options?: CallOptions): Promise<T> => {
    if (options?.signal?.aborted) throw new GraphError('aborted', 'The question was given up.');
    let response: Response;
    try {
      response = await send(`${root}/graph/${question}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: options?.signal });
    } catch (e) {
      // Giving a question up ends the request, which the browser reports as a failure of its own.
      if (options?.signal?.aborted) throw new GraphError('aborted', 'The question was given up.');
      throw e;
    }
    const body = (await response.json()) as T & { code?: GraphErrorCode; message?: string };
    if (!response.ok) {
      if (body.code && body.code in STATUS) throw new GraphError(body.code, body.message ?? 'The question was not answered.');
      throw new Error(body.message ?? `The graph service answered ${response.status}.`);
    }
    return body;
  };
  return {
    neighbourhood: (query, options) => ask('neighbourhood', query, options),
    search: (query, options) => ask('search', query, options),
    kinds: (query, options) => ask('kinds', query, options),
  };
}

/**
 * The other end of it: what a server does with one request, given a graph service to put the
 * question to. The status and the body it answers with are exactly what the client above expects.
 */
export async function answerGraphRequest(service: GraphService, question: string, query: unknown): Promise<{ status: number; body: unknown }> {
  if (!(QUESTIONS as readonly string[]).includes(question)) return { status: 404, body: { message: `There is no question “${question}”.` } };
  try {
    const answer = await (service[question as Question] as (q: unknown) => Promise<unknown>)(query);
    return { status: 200, body: answer };
  } catch (e) {
    if (e instanceof GraphError) return { status: STATUS[e.code], body: { code: e.code, message: e.message } };
    return { status: 500, body: { message: e instanceof Error ? e.message : 'The question could not be answered.' } };
  }
}
