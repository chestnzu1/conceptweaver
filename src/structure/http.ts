import { StructureError, type AnalysisOptions, type CallOptions, type StructureErrorCode, type StructureService } from './contracts';

/**
 * The structure service asked over HTTP: what the Structure Explorer is given in place of the
 * local one once the ontology lives in a backend. Each question is one POST of the query as
 * JSON to `{base}/structure/{question}`, answered with the result as JSON. Nothing else of the
 * explorer changes: its views know the service by its interface only.
 *
 * It is not what the app uses today. It is here so that what goes over the wire is settled, and
 * tested against the local service, before there is a backend to write.
 */

/** The questions, by the name each is asked under. */
export const QUESTIONS = ['children', 'branches', 'paths', 'summary', 'search', 'compare', 'explain', 'analyze', 'members'] as const;
export type Question = (typeof QUESTIONS)[number];

/** How each reason for not answering is said in HTTP. Anything else that goes wrong is a 500, which is nobody's refusal. */
export const STATUS: Record<StructureErrorCode, number> = { 'stale-revision': 409, 'not-found': 404, unsupported: 501, invalid: 400, aborted: 499 };

export function createHttpStructureService(base: string, send: typeof fetch = fetch): StructureService {
  const root = base.replace(/\/+$/, '');
  const ask = async <T>(question: Question, query: unknown, options?: CallOptions): Promise<T> => {
    if (options?.signal?.aborted) throw new StructureError('aborted', 'The question was given up.');
    let response: Response;
    try {
      response = await send(`${root}/structure/${question}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: options?.signal });
    } catch (e) {
      // Giving a question up ends the request, which the browser reports as a failure of its own.
      if (options?.signal?.aborted) throw new StructureError('aborted', 'The question was given up.');
      throw e;
    }
    const body = (await response.json()) as T & { code?: StructureErrorCode; message?: string };
    if (!response.ok) {
      if (body.code && body.code in STATUS) throw new StructureError(body.code, body.message ?? 'The question was not answered.');
      throw new Error(body.message ?? `The structure service answered ${response.status}.`);
    }
    return body;
  };
  return {
    children: (query, options) => ask('children', query, options),
    branches: (query, options) => ask('branches', query, options),
    paths: (query, options) => ask('paths', query, options),
    summary: (query, options) => ask('summary', query, options),
    search: (query, options) => ask('search', query, options),
    compare: (query, options) => ask('compare', query, options),
    explain: (query, options) => ask('explain', query, options),
    // One request, one answer: how far a backend has got with the measuring is not said until it is done.
    analyze: async (query, options?: AnalysisOptions) => {
      const result = await ask<Awaited<ReturnType<StructureService['analyze']>>>('analyze', query, options);
      options?.onProgress?.(1);
      return result;
    },
    members: (query, options) => ask('members', query, options),
  };
}

/**
 * The other end of it: what a server does with one request, given a structure service to put the
 * question to. The status and the body it answers with are exactly what the client above expects.
 */
export async function answerStructureRequest(service: StructureService, question: string, query: unknown): Promise<{ status: number; body: unknown }> {
  if (!(QUESTIONS as readonly string[]).includes(question)) return { status: 404, body: { code: 'not-found', message: `There is no question “${question}”.` } };
  try {
    const answer = await (service[question as Question] as (q: unknown) => Promise<unknown>)(query);
    return { status: 200, body: answer };
  } catch (e) {
    if (e instanceof StructureError) return { status: STATUS[e.code], body: { code: e.code, message: e.message } };
    return { status: 500, body: { message: e instanceof Error ? e.message : 'The question could not be answered.' } };
  }
}
