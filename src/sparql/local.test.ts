import { describe, expect, it } from 'vitest';
import { emptyModel, newRelation, newTerm, type ExternalRef, type Model } from '../model/types';
import { ontologyRef } from '../structure/local';
import type { SparqlAnswer, SparqlGraph, SparqlQuery } from './contracts';
import { createLocalSparqlService, type SparqlHost } from './local';

const BASE = 'http://example.org/films#';

/** Film < Genre, and Parasite is a Film. No reasoner is needed for the one inferred row: it follows from the subclass. */
function fixture(): Model {
  const m = emptyModel('Films');
  m.baseIri = BASE;
  m.terms = [newTerm({ id: 'film', name: 'Film', iri: BASE + 'Film' }), newTerm({ id: 'genre', name: 'Genre', iri: BASE + 'Genre' }), newTerm({ id: 'parasite', name: 'Parasite', type: 'instance', iri: BASE + 'Parasite' })];
  m.relations = [newRelation({ id: 'r1', from: 'film', to: 'genre', kind: 'generalization' }), newRelation({ id: 'r2', from: 'parasite', to: 'film', kind: 'generalization' })];
  return m;
}

const TYPES = `SELECT ?individual ?type
WHERE {
  ?individual a owl:NamedIndividual ;
              a ?type .
  FILTER(?type != owl:NamedIndividual)
}
ORDER BY ?individual ?type`;
const CLASSES = 'SELECT ?c WHERE { ?c a owl:Class } ORDER BY ?c';

const service = (host: SparqlHost) => createLocalSparqlService(host);
const one = (m: Model, host?: Partial<SparqlHost>) =>
  service({
    current: () => ({ model: m, docId: null }),
    imports: async () => ({ loaded: {}, missing: [] }),
    ...host,
  });
const ask = (m: Model, text: string, graph?: SparqlGraph): SparqlQuery => ({ ...ontologyRef(m, null), text, ...(graph ? { graph } : {}) });

function table(answer: SparqlAnswer): string[][] {
  if (answer.result.type === 'ask') throw new Error('The answer is a yes or no, not a table.');
  return answer.result.rows.map((row) => row.map((c) => c?.text ?? ''));
}

const PEOPLE: ExternalRef = {
  id: 'ext1',
  name: 'People',
  iri: 'http://example.org/people',
  namespace: 'http://example.org/people#',
  source: 'people.ttl',
  sourceKind: 'file',
  addedAt: 0,
  classes: 1,
  objectProperties: 0,
  dataProperties: 0,
  individuals: 0,
  imports: true,
};

function people(): Model {
  const ext = emptyModel('People');
  ext.baseIri = 'http://example.org/people#';
  ext.prefixes = [{ prefix: 'ppl', iri: ext.baseIri }];
  ext.terms = [newTerm({ id: 'person', name: 'Person', iri: ext.baseIri + 'Person' })];
  return ext;
}

describe('the SPARQL service over the model in the editor', () => {
  it('reads the asserted graph, or the same graph with what is inferred, and says which', async () => {
    const m = fixture();
    const s = one(m);
    const asked = ontologyRef(m, null);
    const asserted = await s.query(ask(m, TYPES, 'asserted'));
    expect(asserted).toMatchObject({ ontologyId: 'working-copy', revisionId: asked.revisionId, graph: 'asserted' });
    expect(table(asserted)).toEqual([[':Parasite', ':Film']]);

    const inferred = await s.query(ask(m, TYPES, 'inferred'));
    expect(inferred.graph).toBe('inferred');
    expect(table(inferred)).toEqual([
      [':Parasite', ':Film'],
      [':Parasite', ':Genre'],
    ]);
    // The model itself is untouched: the inferred statement is only in the graph the query read.
    expect(m.relations).toHaveLength(2);

    // A query that does not say reads the asserted graph.
    expect((await s.query(ask(m, TYPES))).graph).toBe('asserted');
  });

  it('reads the ontology together with what it imports, naming any import that is missing', async () => {
    const m = fixture();
    m.externals = [PEOPLE];
    const ext = people();
    const s = one(m, { imports: async () => ({ loaded: { ext1: ext }, missing: [] }) });
    const asserted = table(await s.query(ask(m, CLASSES, 'asserted'))).map((r) => r[0]);
    expect(asserted).toEqual([':Film', ':Genre']);

    const imported = await s.query(ask(m, CLASSES, 'imports'));
    expect(imported.graph).toBe('imports');
    // Person is written with the prefix of the ontology it comes from, which the model itself does not have.
    expect(table(imported).map((r) => r[0])).toEqual([':Film', ':Genre', 'ppl:Person']);
    expect(imported.missing).toBeUndefined();
    expect(imported.notes).toEqual([]);

    // What this browser does not keep is named, left out, and said in a note.
    const missing = one(m, { imports: async () => ({ loaded: {}, missing: [PEOPLE] }) });
    const left = await missing.query(ask(m, CLASSES, 'imports'));
    expect(table(left).map((r) => r[0])).toEqual([':Film', ':Genre']);
    expect(left.missing).toEqual([{ id: 'ext1', name: 'People', iri: 'http://example.org/people' }]);
    expect(left.notes).toEqual(['“People” is imported, but its content is not in this browser, so the query read the graph without it.']);
  });

  it('has no inferred graph for a type of model without reasoning', async () => {
    const m = { ...fixture(), mode: 'skos' as const };
    await expect(one(m).query(ask(m, TYPES, 'inferred'))).rejects.toMatchObject({ code: 'unsupported', message: 'There is no reasoning for this type of model, so nothing is inferred from it.' });
  });

  it('refuses an ontology that contradicts itself rather than answering from a contradiction', async () => {
    const m = emptyModel('Contradiction');
    m.baseIri = BASE;
    m.vocab.enabled = true;
    const person = newTerm({ id: 'person', name: 'Person', iri: BASE + 'Person' });
    const robot = newTerm({ id: 'robot', name: 'Robot', iri: BASE + 'Robot' });
    const rex = newTerm({ id: 'rex', name: 'Rex', type: 'instance', iri: BASE + 'Rex' });
    m.terms = [person, robot, rex];
    m.relations = [newRelation({ from: person.id, to: robot.id, predicate: 'owl:disjointWith' }), newRelation({ from: rex.id, to: person.id, kind: 'generalization' }), newRelation({ from: rex.id, to: robot.id, kind: 'generalization' })];
    await expect(one(m).query(ask(m, TYPES, 'inferred'))).rejects.toMatchObject({ code: 'inconsistent' });
  });

  it('refuses a query it cannot run, saying which kind of query it is', async () => {
    const m = fixture();
    const s = one(m);
    await expect(s.query(ask(m, 'DELETE WHERE { ?s ?p ?o }'))).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Updates are not supported here') });
    await expect(s.query(ask(m, 'SELECT ?s WHERE {'))).rejects.toMatchObject({ code: 'invalid' });
    await expect(s.query({ ...ask(m, TYPES), graph: 'union' as SparqlGraph })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('answers only about the revision it was asked about', async () => {
    let m = fixture();
    const s = service({ current: () => ({ model: m, docId: null }), imports: async () => ({ loaded: {}, missing: [] }) });
    const asked = ontologyRef(m, null);
    m = { ...m, terms: m.terms.map((t) => (t.id === 'film' ? { ...t, name: 'Picture' } : t)) };
    await expect(s.query({ ...asked, text: TYPES })).rejects.toMatchObject({ code: 'stale-revision', message: 'The ontology has changed since this was asked about.' });

    // Also when the model changes while the ontologies it imports are being read.
    let current = fixture();
    const changed = { ...current, terms: current.terms.map((t) => (t.id === 'genre' ? { ...t, name: 'Kind' } : t)) };
    const during = ontologyRef(current, null);
    const reading = service({
      current: () => ({ model: current, docId: null }),
      imports: async () => {
        current = changed;
        return { loaded: {}, missing: [] };
      },
    });
    await expect(reading.query({ ...during, text: CLASSES, graph: 'imports' })).rejects.toMatchObject({ code: 'stale-revision' });
  });

  it('gives the question up when it is no longer wanted', async () => {
    const m = fixture();
    const gone = new AbortController();
    gone.abort();
    await expect(one(m).query(ask(m, TYPES), { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});
