import { describe, expect, it } from 'vitest';
import { emptyModel, newRelation, newTerm, type Model } from '../model/types';
import { ontologyRef } from '../structure/local';
import { SparqlError, type SparqlGraph, type SparqlQuery, type SparqlService } from './contracts';
import { answerSparqlRequest, createHttpSparqlService, QUESTIONS } from './http';
import { createLocalSparqlService } from './local';

const BASE = 'http://example.org/films#';
const TYPES = `SELECT ?individual ?type
WHERE {
  ?individual a owl:NamedIndividual ;
              a ?type .
  FILTER(?type != owl:NamedIndividual)
}
ORDER BY ?individual ?type`;

/** Film < Genre, Parasite a Film: the asserted graph has one class for Parasite, the inferred graph also the superclass. */
function films(): Model {
  const m = emptyModel('Films');
  m.baseIri = BASE;
  m.terms = [newTerm({ id: 'film', name: 'Film', iri: BASE + 'Film' }), newTerm({ id: 'genre', name: 'Genre', iri: BASE + 'Genre' }), newTerm({ id: 'parasite', name: 'Parasite', type: 'instance', iri: BASE + 'Parasite' })];
  m.relations = [newRelation({ id: 'r1', from: 'film', to: 'genre', kind: 'generalization' }), newRelation({ id: 'r2', from: 'parasite', to: 'film', kind: 'generalization' })];
  return m;
}

/** A service held in memory, and the same service asked over HTTP: every question and answer goes through JSON, as it would to a backend. */
function services() {
  const m = films();
  const local = createLocalSparqlService({ current: () => ({ model: m, docId: null }), imports: async () => ({ loaded: {}, missing: [] }) });
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url, body });
    const answer = await answerSparqlRequest(local, url.slice(url.lastIndexOf('/') + 1), body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { local, m, remote: createHttpSparqlService('http://backend.example/api/', send), sent };
}

const ask = (m: Model, graph?: SparqlGraph): SparqlQuery => ({ ...ontologyRef(m, null), text: TYPES, ...(graph ? { graph } : {}) });

describe('the SPARQL service over HTTP', () => {
  it('gives the same answer over the wire as the service it is put in front of', async () => {
    const { local, m, remote, sent } = services();
    const asked = ask(m, 'inferred');
    const [here, there] = [await local.query(asked), await remote.query(asked)];
    expect(there).toEqual(here);
    expect(there.result.type).toBe('select');
    expect(there.graph).toBe('inferred');
    expect(sent.map((x) => x.url)).toEqual(['http://backend.example/api/sparql/query']);
    // The whole of a question is in what is sent: the graph choice too.
    expect(sent[0].body).toEqual(asked);
    expect(QUESTIONS).toEqual(['query']);
  });

  it('refuses over the wire what the service refuses, by the same code', async () => {
    const { local, m, remote } = services();
    const code = async (run: (s: SparqlService) => Promise<unknown>) => {
      const of = (s: SparqlService) => run(s).then(() => 'answered', (e) => (e instanceof SparqlError ? e.code : 'other: ' + e));
      const [here, there] = [await of(local), await of(remote)];
      expect(there).toBe(here);
      return there;
    };
    expect(await code((s) => s.query({ ...ask(m), revisionId: 'r0' }))).toBe('stale-revision');
    expect(await code((s) => s.query({ ...ask(m), text: 'DELETE WHERE { ?s ?p ?o }' }))).toBe('invalid');
    expect(await answerSparqlRequest(local, 'delete', {})).toMatchObject({ status: 404 });
    expect(await answerSparqlRequest(local, 'query', { ...ask(m), revisionId: 'r0' })).toEqual({ status: 409, body: { code: 'stale-revision', message: 'The ontology has changed since this was asked about.' } });
    expect((await answerSparqlRequest(local, 'query', { ...ask(m), text: 'DELETE WHERE { ?s ?p ?o }' })).status).toBe(400);
    const gone = new AbortController();
    gone.abort();
    await expect(remote.query(ask(m), { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });

    // An ontology that contradicts itself is understood, and cannot be answered as asked.
    const bad = emptyModel('Contradiction');
    bad.baseIri = BASE;
    bad.vocab.enabled = true;
    const person = newTerm({ id: 'person', name: 'Person', iri: BASE + 'Person' });
    const robot = newTerm({ id: 'robot', name: 'Robot', iri: BASE + 'Robot' });
    const rex = newTerm({ id: 'rex', name: 'Rex', type: 'instance', iri: BASE + 'Rex' });
    bad.terms = [person, robot, rex];
    bad.relations = [newRelation({ from: person.id, to: robot.id, predicate: 'owl:disjointWith' }), newRelation({ from: rex.id, to: person.id, kind: 'generalization' }), newRelation({ from: rex.id, to: robot.id, kind: 'generalization' })];
    const contradiction = createLocalSparqlService({ current: () => ({ model: bad, docId: null }), imports: async () => ({ loaded: {}, missing: [] }) });
    const answer = await answerSparqlRequest(contradiction, 'query', { ...ontologyRef(bad, null), text: TYPES, graph: 'inferred' });
    expect(answer).toMatchObject({ status: 422, body: { code: 'inconsistent' } });
  });
});
