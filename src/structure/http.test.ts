import { describe, expect, it } from 'vitest';
import type { ClassAxiom, Iri, Provenance, StructureService } from './contracts';
import { StructureError } from './contracts';
import { graphOf, NS, wide } from './fixtures';
import { answerStructureRequest, createHttpStructureService, QUESTIONS } from './http';
import { createGraphService, MAX_BRANCHES, type InferredInput } from './service';

const REF = { ontologyId: 'onto', revisionId: 'r1' };
const REASONED: Provenance = { engine: { id: 'test', name: 'Test reasoner', version: '2.0' }, revisionId: 'r1', status: 'current', completeness: 'complete', notes: ['a note'] };

/** A service held in memory, and the same service asked over HTTP: every question and answer goes through JSON, as it would to a backend. */
function wired(local: StructureService) {
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const question = url.slice(url.lastIndexOf('/') + 1);
    const body = JSON.parse(String(init?.body));
    sent.push({ url, body });
    const answer = await answerStructureRequest(local, question, body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { remote: createHttpStructureService('http://backend.example/api/', send), sent };
}

function services() {
  const input = graphOf('Party; Organisation < Party; Person < Party; PartyLocalProfile; OrganisationLocalProfile < PartyLocalProfile; Clerk < Person; Chimera < Person; Org; Org = Organisation');
  input.disjoint = [{ a: NS + 'Person', b: NS + 'Organisation' }];
  const restriction = (property: string, filler: string): ClassAxiom => ({ kind: 'restriction', key: `r|${NS}${property}|some||${NS}${filler}`, property: { iri: NS + property, label: property, type: 'object' }, quantifier: 'some', filler: { iri: NS + filler, label: filler, kind: 'class' }, text: `${property} some ${filler}` });
  const axioms = new Map<Iri, ClassAxiom[]>([
    [NS + 'Party', [restriction('hasLocalProfile', 'PartyLocalProfile')]],
    [NS + 'Organisation', [restriction('hasLocalProfile', 'OrganisationLocalProfile'), { kind: 'expression', key: 'x|subClassOf|[ ]', relation: 'subClassOf', text: '[ ]' }]],
  ]);
  const answer: InferredInput = { provenance: REASONED, entailed: { subClassOf: [...input.subClassOf, { sub: NS + 'Clerk', sup: NS + 'Organisation' }], links: 'direct', equivalent: [[NS + 'Org', NS + 'Organisation']], unsatisfiable: [NS + 'Chimera'] }, explain: () => ['a ground'] };
  const properties = {
    properties: [
      { ref: { iri: NS + 'relatedTo', label: 'related to', type: 'object' as const } },
      { ref: { iri: NS + 'worksFor', label: 'works for', type: 'object' as const } },
      { ref: { iri: NS + 'employedBy', label: 'employed by', type: 'object' as const }, search: ['employment'] },
      { ref: { iri: NS + 'age', label: 'age', type: 'data' as const } },
    ],
    subPropertyOf: [
      { sub: NS + 'worksFor', sup: NS + 'relatedTo' },
      { sub: NS + 'employedBy', sup: NS + 'worksFor' },
    ],
  };
  const local = createGraphService(() => ({ ...REF, graph: () => input, properties: () => properties, inferred: () => answer, axioms: (iris) => new Map(iris.filter((i) => axioms.has(i)).map((i) => [i, axioms.get(i)!])), connections: () => new Map([[NS + 'Party', 9]]) }));
  return { local, ...wired(local) };
}

describe('the structure service over HTTP', () => {
  it('gives the same answer to every question as the service it is put in front of', async () => {
    const { local, remote, sent } = services();
    const both = async <T>(ask: (s: StructureService) => Promise<T>) => {
      const [here, there] = [await ask(local), await ask(remote)];
      expect(there).toEqual(here);
      // And nothing of an answer is lost in JSON: no map, set, function or class instance is in it.
      expect(JSON.parse(JSON.stringify(here))).toEqual(here);
      return there;
    };
    for (const mode of ['asserted', 'inferred'] as const) {
      const top = await both((s) => s.children({ ...REF, mode }));
      await both((s) => s.children({ ...REF, mode, parentIri: NS + 'Party', limit: 1 }));
      await both((s) => s.children({ ...REF, mode, filter: 'organ', through: NS + 'Party' }));
      await both((s) => s.branches({ ...REF, mode, parents: [{}, { parentIri: NS + 'Party' }, { parentIri: NS + 'Person', limit: 1 }] }));
      await both((s) => s.paths({ ...REF, mode, classIri: NS + 'Clerk' }));
      await both((s) => s.summary({ ...REF, mode, classIri: NS + 'Organisation' }));
      const measured = await both((s) => s.analyze({ ...REF, mode }));
      for (const set of [...Object.values(measured.sets), ...measured.depth.map((b) => b.set), measured.branches.largest[0].set, ...measured.findings.map((f) => f.set)]) await both((s) => s.members({ ...REF, mode, set, limit: 3 }));
      expect(top.provenance.engine).toEqual(mode === 'inferred' ? REASONED.engine : null);
    }
    await both((s) => s.search({ ...REF, text: 'org' }));
    await both((s) => s.compare({ ...REF, classAIri: NS + 'Party', classBIri: NS + 'Organisation' }));
    await both((s) => s.compare({ ...REF, classAIri: NS + 'Clerk', classBIri: NS + 'Chimera' }));
    await both((s) => s.explain({ ...REF, subClassIri: NS + 'Clerk', superClassIri: NS + 'Party' }));
    await both((s) => s.explain({ ...REF, subClassIri: NS + 'Clerk', superClassIri: NS + 'Organisation' }));
    await both((s) => s.propertyChildren({ ...REF }));
    await both((s) => s.propertyChildren({ ...REF, parentIri: NS + 'relatedTo', limit: 1 }));
    await both((s) => s.propertyChildren({ ...REF, parentIri: NS + 'relatedTo', filter: 'employ', through: NS + 'worksFor' }));
    await both((s) => s.propertyBranches({ ...REF, parents: [{}, { parentIri: NS + 'relatedTo' }] }));
    await both((s) => s.propertyPaths({ ...REF, propertyIri: NS + 'employedBy' }));
    await both((s) => s.propertySummary({ ...REF, propertyIri: NS + 'worksFor' }));
    // Every question the service has was asked, each as one request to its own address.
    expect(new Set(sent.map((x) => x.url.replace('http://backend.example/api/structure/', ''))).size).toBe(QUESTIONS.length);
    expect(sent.every((x) => x.url.startsWith('http://backend.example/api/structure/'))).toBe(true);
    expect(sent[0].body).toEqual({ ontologyId: 'onto', revisionId: 'r1', mode: 'asserted' });
  });

  it('refuses for the same reasons, said the same way', async () => {
    const { remote } = services();
    const refused = async (p: Promise<unknown>) => p.then(() => 'answered', (e) => (e instanceof StructureError ? e.code : 'other: ' + String(e)));
    expect(await refused(remote.children({ ...REF, revisionId: 'r0', mode: 'asserted' }))).toBe('stale-revision');
    expect(await refused(remote.summary({ ...REF, mode: 'asserted', classIri: NS + 'Nobody' }))).toBe('not-found');
    expect(await refused(remote.children({ ...REF, mode: 'asserted', cursor: 'nowhere' }))).toBe('invalid');
    expect(await refused(remote.members({ ...REF, mode: 'asserted', set: 'no-such-set' }))).toBe('not-found');
    expect(await refused(remote.branches({ ...REF, mode: 'asserted', parents: Array.from({ length: MAX_BRANCHES + 1 }, () => ({})) }))).toBe('invalid');
    expect(await refused(remote.propertyChildren({ ...REF, revisionId: 'r0' }))).toBe('stale-revision');
    expect(await refused(remote.propertySummary({ ...REF, propertyIri: NS + 'Nobody' }))).toBe('not-found');
    expect(await refused(remote.propertyBranches({ ...REF, parents: Array.from({ length: MAX_BRANCHES + 1 }, () => ({})) }))).toBe('invalid');
    // A source without a reasoner has no inferred hierarchy to ask for, and one without properties has no property hierarchy.
    const bare = wired(createGraphService(() => ({ ...REF, graph: () => wide(3) }))).remote;
    expect(await refused(bare.children({ ...REF, mode: 'inferred' }))).toBe('unsupported');
    expect(await refused(bare.propertyChildren({ ...REF }))).toBe('unsupported');
    // A question that was given up is not sent at all.
    const abort = new AbortController();
    abort.abort();
    expect(await refused(remote.children({ ...REF, mode: 'asserted' }, { signal: abort.signal }))).toBe('aborted');
  });

  it('says only at the end how far a measuring has got, and tells a question it does not know', async () => {
    const { local, remote } = services();
    const seen: number[] = [];
    await remote.analyze({ ...REF, mode: 'asserted' }, { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([1]);
    expect(await answerStructureRequest(local, 'drop-everything', {})).toMatchObject({ status: 404, body: { code: 'not-found' } });
    expect(await answerStructureRequest(local, 'children', { ...REF, revisionId: 'gone', mode: 'asserted' })).toMatchObject({ status: 409, body: { code: 'stale-revision' } });
  });
});

// ---------------------------------------------------------------- against the companion

import { afterAll, beforeAll } from 'vitest';
import { startReasoner, unavailable } from '../../reasoner/run.mjs';
import { askReasoner, dlResult } from '../model/reasoning';
import { fromTurtle } from '../model/rdf';
import { createLocalStructureService, ontologyRef } from './local';

/**
 * The suite against the Java implementation (FR-M6-7): the same questions put to the local
 * service and to the companion over the same ontology document, answered the same. The document
 * is the fixture above written as OWL, and both sides read the same reasoner's answer — the
 * suite asks the service /reason, and the local service and the service's inferred hierarchy are
 * both driven by it. What the service chooses itself (the reference of the session) is not
 * compared: each answer's revision is the one it was asked about.
 *
 * These need the companion built and Java 21; set CONCEPTWEAVER_COMPANION_JAR to its jar to run
 * them, as reasoner/run.mjs starts it.
 */
const DOCUMENT = `@prefix : <http://example.org/o#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/o> a owl:Ontology .
:Party a owl:Class ; rdfs:label "Party" .
:Organisation a owl:Class ; rdfs:label "Organisation" ; rdfs:subClassOf :Party .
:Person a owl:Class ; rdfs:label "Person" ; rdfs:subClassOf :Party .
:PartyLocalProfile a owl:Class ; rdfs:label "PartyLocalProfile" .
:OrganisationLocalProfile a owl:Class ; rdfs:label "OrganisationLocalProfile" ; rdfs:subClassOf :PartyLocalProfile .
:Clerk a owl:Class ; rdfs:label "Clerk" ; rdfs:subClassOf :Person .
:Chimera a owl:Class ; rdfs:label "Chimera" ; rdfs:subClassOf :Person .
:Org a owl:Class ; rdfs:label "Org" ; owl:equivalentClass :Organisation .
:Person owl:disjointWith :Organisation .
:hasLocalProfile a owl:ObjectProperty ; rdfs:label "hasLocalProfile" .
:Party rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasLocalProfile ; owl:someValuesFrom :PartyLocalProfile ] .
:Organisation rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :hasLocalProfile ; owl:someValuesFrom :OrganisationLocalProfile ] .
:relatedTo a owl:ObjectProperty ; rdfs:label "related to" .
:worksFor a owl:ObjectProperty ; rdfs:label "works for" ; rdfs:subPropertyOf :relatedTo .
:employedBy a owl:ObjectProperty ; rdfs:label "employed by" ; rdfs:subPropertyOf :worksFor .
:age a owl:DatatypeProperty ; rdfs:label "age" .
`;

const noCompanion = process.env.CONCEPTWEAVER_COMPANION_JAR ? unavailable() : 'The companion service is not built: set CONCEPTWEAVER_COMPANION_JAR to companion/target/companion-0.1.0-SNAPSHOT.jar.';

describe.skipIf(!!noCompanion)('the structure service against the companion', () => {
  let service: Awaited<ReturnType<typeof startReasoner>>;
  let ref: { ontologyId: string; revisionId: string };
  let localRevision: string;
  let local: StructureService;
  let remote: StructureService;

  beforeAll(async () => {
    service = await startReasoner({ port: 5195, quiet: true, log: () => {} });
    expect(service.health).toMatchObject({ service: 'conceptweaver-reasoner', sessions: true });
    ref = (await (await fetch(service.url + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: DOCUMENT }) })).json()) as { ontologyId: string; revisionId: string };
    const model = fromTurtle(DOCUMENT);
    localRevision = ontologyRef(model, null).revisionId;
    // The same reasoner's answer drives the local service's inferred hierarchy and the service's own.
    const report = await askReasoner(service.url, { ontology: DOCUMENT, imports: [], timeoutMs: 60_000, explanations: { perSubject: 0, max: 0, timeoutMs: 0 }, reasoner: 'auto' });
    local = createLocalStructureService(() => ({ model, docId: ref.ontologyId, reasoning: { engine: 'dl', dl: { revisionId: localRevision, result: dlResult(model, report) } } }));
    remote = createHttpStructureService(service.url + '/');
  }, 120_000);

  afterAll(async () => {
    await service?.stop();
  });

  /** The local answer next to the service's: the revisions they were asked about are their own, and alike either way. */
  const normalize = <T>(answer: T): T => JSON.parse(JSON.stringify(answer).replaceAll(JSON.stringify(ref.revisionId), '"R"').replaceAll(JSON.stringify(localRevision), '"R"')) as T;
  const here = (query: { [k: string]: unknown }) => ({ ontologyId: ref.ontologyId, revisionId: localRevision, ...query });
  const there = (query: { [k: string]: unknown }) => ({ ontologyId: ref.ontologyId, revisionId: ref.revisionId, ...query });

  it('gives the same answer to every question as the local service over the same document', async () => {
    const both = async <T>(ask: (s: StructureService, query: never) => Promise<T>, query: { [k: string]: unknown }) => {
      const [localAnswer, serverAnswer] = [await ask(local, here(query) as never), await ask(remote, there(query) as never)];
      expect(normalize(serverAnswer)).toEqual(normalize(localAnswer));
      return serverAnswer;
    };
    for (const mode of ['asserted', 'inferred'] as const) {
      const top = await both((s, q) => s.children(q), { mode });
      await both((s, q) => s.children(q), { mode, parentIri: NS + 'Party', limit: 1 });
      await both((s, q) => s.children(q), { mode, filter: 'organ', through: NS + 'Party' });
      await both((s, q) => s.branches(q), { mode, parents: [{}, { parentIri: NS + 'Party' }, { parentIri: NS + 'Person', limit: 1 }] });
      await both((s, q) => s.paths(q), { mode, classIri: NS + 'Clerk' });
      await both((s, q) => s.summary(q), { mode, classIri: NS + 'Organisation' });
      const measured = await both((s, q) => s.analyze(q), { mode });
      for (const set of [...Object.values(measured.sets), ...measured.depth.map((b) => b.set), measured.branches.largest[0].set, ...measured.findings.map((f) => f.set)]) {
        await both((s, q) => s.members(q), { mode, set, limit: 3 });
      }
      // The asserted hierarchy is read off as it stands; the inferred one is the reasoner's, named as such.
      expect(top.provenance.engine).toEqual(mode === 'inferred' ? { id: 'dl', name: expect.any(String), version: expect.any(String) } : null);
    }
    await both((s, q) => s.search(q), { text: 'org' });
    await both((s, q) => s.compare(q), { classAIri: NS + 'Party', classBIri: NS + 'Organisation' });
    await both((s, q) => s.compare(q), { classAIri: NS + 'Clerk', classBIri: NS + 'Chimera' });
    await both((s, q) => s.explain(q), { subClassIri: NS + 'Clerk', superClassIri: NS + 'Party' });
    await both((s, q) => s.explain(q), { subClassIri: NS + 'Clerk', superClassIri: NS + 'Organisation' });
    await both((s, q) => s.propertyChildren(q), {});
    await both((s, q) => s.propertyChildren(q), { parentIri: NS + 'relatedTo', limit: 1 });
    await both((s, q) => s.propertyChildren(q), { parentIri: NS + 'relatedTo', filter: 'employ', through: NS + 'worksFor' });
    await both((s, q) => s.propertyBranches(q), { parents: [{}, { parentIri: NS + 'relatedTo' }] });
    await both((s, q) => s.propertyPaths(q), { propertyIri: NS + 'employedBy' });
    await both((s, q) => s.propertySummary(q), { propertyIri: NS + 'worksFor' });
  });

  it('refuses for the same reasons, said the same way', async () => {
    const refused = async (p: Promise<unknown>) => p.then(() => 'answered', (e) => (e instanceof StructureError ? e.code : 'other: ' + String(e)));
    const both = async (ask: (s: StructureService, query: never) => Promise<unknown>, query: { [k: string]: unknown }) => {
      const [hereCode, thereCode] = [await refused(ask(local, here(query) as never)), await refused(ask(remote, there(query) as never))];
      expect(thereCode).toBe(hereCode);
      return thereCode;
    };
    expect(await both((s, q) => s.children(q), { mode: 'asserted', revisionId: 'r0' })).toBe('stale-revision');
    expect(await both((s, q) => s.summary(q), { mode: 'asserted', classIri: NS + 'Nobody' })).toBe('not-found');
    expect(await both((s, q) => s.children(q), { mode: 'asserted', cursor: 'nowhere' })).toBe('invalid');
    expect(await both((s, q) => s.propertySummary(q), { propertyIri: NS + 'Nobody' })).toBe('not-found');
    expect(await both((s, q) => s.branches(q), { mode: 'asserted', parents: Array.from({ length: MAX_BRANCHES + 1 }, () => ({})) })).toBe('invalid');
    // A question the service does not know is told so, as the page's own answerer tells it.
    const unknown = await (await fetch(service.url + '/structure/drop-everything', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(there({ mode: 'asserted' })) })).json();
    expect(unknown).toEqual({ code: 'not-found', message: 'There is no question “drop-everything”.' });
    // The inferred hierarchy is the real reasoner's: the stated equivalence shares one place, under the first of the two by label.
    const inferred = normalize(await remote.children(there({ mode: 'inferred', parentIri: NS + 'Party' }) as never));
    expect(inferred.nodes.map((n) => n.class.iri)).toContain(NS + 'Org');
    expect(inferred.nodes.map((n) => n.class.iri)).not.toContain(NS + 'Organisation');
    expect(inferred.nodes.find((n) => n.class.iri === NS + 'Org')?.equivalents.map((e) => e.label)).toEqual(['Organisation']);
  });
});
