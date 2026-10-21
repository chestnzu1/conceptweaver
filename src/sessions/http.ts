import type { OntologyRef } from '../entities/contracts';

/**
 * An ontology uploaded to a backend: what the structure and the entity query services' questions
 * name after it. One POST of `{document, imports?}` to `{base}/sessions`, answered with the
 * reference that questions ask by (`{ontologyId, revisionId}`). The same content uploaded again
 * is the same revision; the backend holds the ontology by the hash of its content, so nothing is
 * sent again until the content changes.
 *
 * It is not what the app uses today. It is here so that what goes over the wire is settled, and
 * tested, before the app adopts it.
 */

export const QUESTIONS = ['upload'] as const;
export type Question = (typeof QUESTIONS)[number];

export interface SessionQuery {
  /** The ontology, in Turtle. */
  document: string;
  /** The ontologies it imports, each by the IRI the import declares and its text. */
  imports?: { iri: string; text: string }[];
}

export function createHttpSessionService(base: string, send: typeof fetch = fetch): {
  upload(query: SessionQuery, options?: { signal?: AbortSignal }): Promise<OntologyRef>;
} {
  const root = base.replace(/\/+$/, '');
  const ask = async (query: unknown, options?: { signal?: AbortSignal }): Promise<OntologyRef> => {
    let response: Response;
    try {
      response = await send(`${root}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: options?.signal });
    } catch (e) {
      // Giving a question up ends the request, which the browser reports as a failure of its own.
      if (options?.signal?.aborted) throw new Error('The upload was given up.');
      throw e;
    }
    const body = (await response.json()) as OntologyRef & { message?: string };
    if (!response.ok) throw new Error(body.message ?? `The ontology service answered ${response.status}.`);
    return { ontologyId: body.ontologyId, revisionId: body.revisionId };
  };
  return { upload: (query, options) => ask(query, options) };
}
