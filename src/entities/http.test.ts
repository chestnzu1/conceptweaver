import { describe, expect, it } from 'vitest';
import { EntityQueryError, ON, type EntityQueryService } from './contracts';
import { answerEntityRequest, createHttpEntityService, QUESTIONS } from './http';
import { createRecordService, type EntityRecord } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };
const RECORDS: EntityRecord[] = ['Party', 'Person', 'Organisation', 'Clerk'].map((label, i) => ({
  key: label.toLowerCase(),
  iri: 'http://example.org/onto#' + label,
  label,
  texts: [{ field: 'name', text: label }, { field: 'iri', text: 'http://example.org/onto#' + label }],
  sort: { name: label, subclasses: 3 - i },
  facts: { leaf: i === 3 ? [ON] : [], member: i % 2 ? ['party'] : [] },
}));

/** A service held in memory, and the same service asked over HTTP: every question and answer goes through JSON, as it would to a backend. */
function services() {
  const local = createRecordService(() => ({
    ...REF,
    records: () => RECORDS,
    sorts: () => [{ id: 'name', label: 'Name' }, { id: 'subclasses', label: 'Subclasses', numeric: true }],
    filters: () => [
      { id: 'leaf', label: 'Leaf', about: 'No subclass.', type: 'flag', options: [{ value: ON, label: 'Yes', count: 1 }] },
      { id: 'member', label: 'Member of', about: 'A member.', type: 'any', options: [], entities: true },
    ],
    costly: (_kind, filter) => (filter === 'leaf' ? { facts: new Map([['clerk', [ON]]]), note: 'As a reasoner has it.' } : undefined),
    candidates: () => [{ value: 'party', label: 'Party', count: 2, text: 'party' }],
  }));
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url, body });
    const answer = await answerEntityRequest(local, url.slice(url.lastIndexOf('/') + 1), body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { local, remote: createHttpEntityService('http://backend.example/api/', send), sent };
}

describe('the entity query service over HTTP', () => {
  it('gives the same answer to every question as the service it is put in front of', async () => {
    const { local, remote, sent } = services();
    const both = async <T>(ask: (s: EntityQueryService) => Promise<T>) => {
      const [here, there] = [await ask(local), await ask(remote)];
      expect(there).toEqual(here);
      return there;
    };
    await both((s) => s.describe({ ...REF, kind: 'class' }));
    const page = await both((s) => s.query({ ...REF, kind: 'class', search: 'p', sort: { by: 'subclasses', dir: 'desc' }, filters: { member: ['party'] }, offset: 0, limit: 10 }));
    expect(page.rows.map((r) => r.label)).toEqual(['Person']);
    expect((await both((s) => s.query({ ...REF, kind: 'class', filters: { leaf: [ON] } }))).notes).toEqual(['As a reasoner has it.']);
    await both((s) => s.options({ ...REF, kind: 'class', filter: 'member', search: 'par' }));
    expect(sent.map((x) => x.url)).toEqual(['http://backend.example/api/entities/describe', 'http://backend.example/api/entities/query', 'http://backend.example/api/entities/query', 'http://backend.example/api/entities/options']);
    // The whole of a question is in what is sent: nothing is narrowed or put in order on this side.
    expect(sent[1].body).toEqual({ ...REF, kind: 'class', search: 'p', sort: { by: 'subclasses', dir: 'desc' }, filters: { member: ['party'] }, offset: 0, limit: 10 });
    expect(QUESTIONS).toEqual(['describe', 'query', 'options']);
  });

  it('refuses over the wire what the service refuses, by the same code', async () => {
    const { local, remote } = services();
    const code = async (run: (s: EntityQueryService) => Promise<unknown>) => {
      const of = (s: EntityQueryService) => run(s).then(() => 'answered', (e) => (e instanceof EntityQueryError ? e.code : 'other: ' + e));
      const [here, there] = [await of(local), await of(remote)];
      expect(there).toBe(here);
      return there;
    };
    expect(await code((s) => s.query({ ...REF, revisionId: 'r0', kind: 'class' }))).toBe('stale-revision');
    expect(await code((s) => s.query({ ...REF, kind: 'class', sort: { by: 'colour', dir: 'asc' } }))).toBe('invalid');
    expect(await code((s) => s.options({ ...REF, kind: 'class', filter: 'leaf' }))).toBe('invalid');
    expect(await answerEntityRequest(local, 'delete', {})).toMatchObject({ status: 404 });
    expect(await answerEntityRequest(local, 'query', { ...REF, revisionId: 'r0', kind: 'class' })).toEqual({ status: 409, body: { code: 'stale-revision', message: 'The ontology has changed since this was asked about.' } });
    const gone = new AbortController();
    gone.abort();
    await expect(remote.query({ ...REF, kind: 'class' }, { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});

// ---------------------------------------------------------------- against the companion

import { afterAll, beforeAll } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { reason } from '../model/reasoner';
import { askReasoner, dlResult } from '../model/reasoning';
import { entityIris, fromTurtle } from '../model/rdf';
import { ontologyRef } from '../structure/local';
import { createLocalEntityService } from './local';

/**
 * The suite against the Java implementation (FR-M6-7): the same questions put to the local
 * service and to the companion over the same ontology document, answered the same. An entity in
 * an answer is a key, which the service chooses and nobody reads, so the keys are compared by
 * the IRI they name, and a list that is in the ontology's order on one side and the other's on
 * the other is compared as a set. What is sorted is compared in order.
 *
 * These need the companion built and Java 21; set CONCEPTWEAVER_COMPANION_JAR to its jar to run
 * them, as reasoner/run.mjs starts it.
 */
const DOCUMENT = `@prefix : <http://example.org/o#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<http://example.org/o> a owl:Ontology .
:Party a owl:Class ; rdfs:label "Party" ; rdfs:comment "An organisation of people." .
:Organisation a owl:Class ; rdfs:label "Organisation" ; rdfs:subClassOf :Party .
:Person a owl:Class ; rdfs:label "Person" ; rdfs:subClassOf :Party .
:PartyLocalProfile a owl:Class ; rdfs:label "PartyLocalProfile" .
:OrganisationLocalProfile a owl:Class ; rdfs:label "OrganisationLocalProfile" ; rdfs:subClassOf :PartyLocalProfile .
:Clerk a owl:Class ; rdfs:label "Clerk" ; rdfs:subClassOf :Person .
:Org a owl:Class ; rdfs:label "Org" ; owl:equivalentClass :Organisation .
:Person owl:disjointWith :Organisation .
:hasLocalProfile a owl:ObjectProperty ; rdfs:label "hasLocalProfile" .
:Party rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasLocalProfile ; owl:someValuesFrom :PartyLocalProfile ] .
:age a owl:DatatypeProperty ; rdfs:label "age" ; rdfs:range xsd:string .
:Person rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :age ; owl:someValuesFrom xsd:string ] .
:author a owl:AnnotationProperty ; rdfs:label "author" .
:Clerk :author "someone" .
:alice a owl:NamedIndividual ; rdfs:label "Alice" ; a :Clerk .
`;

const noCompanion = process.env.CONCEPTWEAVER_COMPANION_JAR ? unavailable() : 'The companion service is not built: set CONCEPTWEAVER_COMPANION_JAR to companion/target/companion-0.1.0-SNAPSHOT.jar.';

describe.skipIf(!!noCompanion)('the entity query service against the companion', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  let ref: { ontologyId: string; revisionId: string };
  let localRevision: string;
  let local: EntityQueryService;
  let remote: EntityQueryService;
  let idToIri: Map<string, string>;

  beforeAll(async () => {
    service = await startReasoner({ port: 5196, quiet: true, log: () => {} });
    expect(service.health).toMatchObject({ service: 'conceptweaver-reasoner', sessions: true });
    ref = (await (await fetch(service.url + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: DOCUMENT }) })).json()) as { ontologyId: string; revisionId: string };
    const model = fromTurtle(DOCUMENT);
    localRevision = ontologyRef(model, null).revisionId;
    // The same reasoner's answer drives the local filters and the service's own, beside the app's own reasoner.
    const report = await askReasoner(service.url, { ontology: DOCUMENT, imports: [], timeoutMs: 60_000, explanations: { perSubject: 0, max: 0, timeoutMs: 0 }, reasoner: 'auto' });
    local = createLocalEntityService(() => ({ model, docId: ref.ontologyId, dl: dlResult(model, report), fast: reason(model) }));
    remote = createHttpEntityService(service.url + '/');
    const iris = entityIris(model);
    idToIri = new Map([...[...iris.terms].map(([iri, id]) => [id, iri] as const), ...[...iris.props].map(([iri, id]) => [id, iri] as const)]);
  }, 120_000);

  afterAll(async () => {
    await service?.stop();
  });

  const normalize = <T>(answer: T, sorted = false): T => {
    const json = JSON.parse(JSON.stringify(answer).replaceAll(JSON.stringify(ref.revisionId), '"R"').replaceAll(JSON.stringify(localRevision), '"R"')) as {
      revisionId?: string;
      rows?: { key: string; iri?: string; label: string; matches?: unknown }[];
      options?: { value: string; label: string; count?: number }[];
      filters?: { id: string; options?: { value: string; label: string; count?: number }[] }[];
    };
    if (json.revisionId !== undefined) json.revisionId = 'R';
    for (const row of json.rows ?? []) row.key = row.iri ?? 'rel';
    if (!sorted && json.rows) json.rows.sort((a, b) => (a.iri ?? a.label).localeCompare(b.iri ?? b.label));
    for (const o of json.options ?? []) o.value = idToIri.get(o.value) ?? o.value;
    for (const f of json.filters ?? []) {
      if (f.id === 'kind' && f.options) f.options.sort((a, b) => a.value.localeCompare(b.value));
    }
    return json as T;
  };
  const here = (query: { [k: string]: unknown }) => ({ ontologyId: ref.ontologyId, revisionId: localRevision, ...query });
  const there = (query: { [k: string]: unknown }) => ({ ontologyId: ref.ontologyId, revisionId: ref.revisionId, ...query });

  it('gives the same answer to every question as the local service over the same document', async () => {
    const both = async (ask: (s: EntityQueryService, query: never) => Promise<unknown>, query: { [k: string]: unknown }, sorted = false) => {
      const [localAnswer, serverAnswer] = [await ask(local, here(query) as never), await ask(remote, there(query) as never)];
      expect(normalize(serverAnswer, sorted)).toEqual(normalize(localAnswer, sorted));
      return serverAnswer;
    };
    for (const kind of ['class', 'objectProperty', 'dataProperty', 'annotationProperty', 'individual', 'relationship'] as const) {
      await both((s, q) => s.describe(q), { kind });
    }
    await both((s, q) => s.query(q), { kind: 'class' });
    // What is equal under a sort stays in the ontology's order, which is each implementation's own:
    // the sorted questions are compared as sets, and one answer is checked for its order outright.
    await both((s, q) => s.query(q), { kind: 'class', sort: { by: 'name', dir: 'asc' } });
    await both((s, q) => s.query(q), { kind: 'class', sort: { by: 'subclasses', dir: 'desc' } });
    await both((s, q) => s.query(q), { kind: 'class', search: 'org', sort: { by: 'name', dir: 'asc' } });
    await both((s, q) => s.query(q), { kind: 'class', filters: { position: ['root'] }, sort: { by: 'name', dir: 'asc' } });
    await both((s, q) => s.query(q), { kind: 'class', filters: { unsatisfiable: ['yes'] } });
    await both((s, q) => s.query(q), { kind: 'objectProperty' });
    await both((s, q) => s.query(q), { kind: 'dataProperty', sort: { by: 'range', dir: 'asc' } });
    await both((s, q) => s.query(q), { kind: 'annotationProperty', sort: { by: 'name', dir: 'asc' } });
    await both((s, q) => s.query(q), { kind: 'individual', sort: { by: 'name', dir: 'asc' } });
    await both((s, q) => s.query(q), { kind: 'relationship', sort: { by: 'label', dir: 'asc' } });
    await both((s, q) => s.options(q), { kind: 'individual', filter: 'assertedType' });
    await both((s, q) => s.options(q), { kind: 'relationship', filter: 'from', search: 'clerk' });
    // The service puts a list in the order asked for: the classes by name, and by how many subclasses each has, the largest first.
    expect(((await remote.query(there({ kind: 'class', sort: { by: 'name', dir: 'asc' } }) as never)) as { rows: { label: string }[] }).rows.map((r) => r.label))
      .toEqual(['Clerk', 'Org', 'Organisation', 'OrganisationLocalProfile', 'Party', 'PartyLocalProfile', 'Person']);
    expect(((await remote.query(there({ kind: 'class', sort: { by: 'subclasses', dir: 'desc' } }) as never)) as { rows: { label: string }[] }).rows.map((r) => r.label)[0])
      .toBe('Party');
    // A filter whose options are entities is asked with each side's own values for the same class.
    const clerk = 'http://example.org/o#Clerk';
    const localClerk = [...idToIri].find(([, iri]) => iri === clerk)?.[0] ?? clerk;
    expect(localClerk).not.toBe(clerk); // The local service names the class by an id of its own; both answer the same.
    for (const filter of ['assertedType', 'inferredType'] as const) {
      const [localAnswer, serverAnswer] = [
        await local.query({ ...here({ kind: 'individual' }), filters: { [filter]: [localClerk] } } as never),
        await remote.query({ ...there({ kind: 'individual' }), filters: { [filter]: [clerk] } } as never),
      ];
      expect(normalize(serverAnswer)).toEqual(normalize(localAnswer));
    }
  });

  it('refuses for the same reasons, said the same way', async () => {
    const code = async (p: Promise<unknown>) => p.then(() => 'answered', (e) => (e instanceof EntityQueryError ? e.code : 'other: ' + String(e)));
    const both = async (ask: (s: EntityQueryService, query: never) => Promise<unknown>, query: { [k: string]: unknown }) => {
      const [hereCode, thereCode] = [await code(ask(local, here(query) as never)), await code(ask(remote, there(query) as never))];
      expect(thereCode).toBe(hereCode);
      return thereCode;
    };
    expect(await both((s, q) => s.query(q), { kind: 'class', revisionId: 'r0' })).toBe('stale-revision');
    expect(await both((s, q) => s.query(q), { kind: 'class', sort: { by: 'colour', dir: 'asc' } })).toBe('invalid');
    expect(await both((s, q) => s.options(q), { kind: 'class', filter: 'leaf' })).toBe('invalid');
    const unknown = await (await fetch(service.url + '/entities/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(there({ kind: 'class' })) })).json();
    expect(unknown).toEqual({ message: 'There is no question “delete”.' });
  });
});
