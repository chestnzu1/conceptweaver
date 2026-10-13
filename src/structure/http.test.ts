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
  const local = createGraphService(() => ({ ...REF, graph: () => input, inferred: () => answer, axioms: (iris) => new Map(iris.filter((i) => axioms.has(i)).map((i) => [i, axioms.get(i)!])), connections: () => new Map([[NS + 'Party', 9]]) }));
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
    // A source without a reasoner has no inferred hierarchy to ask for.
    const bare = wired(createGraphService(() => ({ ...REF, graph: () => wide(3) }))).remote;
    expect(await refused(bare.children({ ...REF, mode: 'inferred' }))).toBe('unsupported');
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
