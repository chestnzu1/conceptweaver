import { describe, expect, it } from 'vitest';
import { createHttpSessionService, QUESTIONS } from './http';

const REF = { ontologyId: 'http://example.org/onto', revisionId: 'r1' };

describe('the session service over HTTP', () => {
  it('uploads a document once and gets the reference the questions ask by', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const send = (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(REF), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const sessions = createHttpSessionService('http://backend.example/api/', send);
    const document = '@prefix : <http://example.org/> .';
    expect(await sessions.upload({ document })).toEqual(REF);
    expect(sent).toEqual([{ url: 'http://backend.example/api/sessions', body: { document } }]);
    // The whole of the upload is in what is sent: the document, and the imports it declares.
    await sessions.upload({ document, imports: [{ iri: 'http://example.org/import', text: '@prefix : <http://example.org/> .' }] });
    expect(sent[1].body).toEqual({ document, imports: [{ iri: 'http://example.org/import', text: '@prefix : <http://example.org/> .' }] });
    expect(QUESTIONS).toEqual(['upload']);
  });

  it('says why an upload was refused, in the service\'s own words', async () => {
    const send = (async () => new Response(JSON.stringify({ message: 'The ontology could not be read as OWL.' }), { status: 422 })) as typeof fetch;
    const sessions = createHttpSessionService('http://backend.example/api/', send);
    await expect(sessions.upload({ document: 'not an ontology' })).rejects.toThrow('The ontology could not be read as OWL.');
  });
});
