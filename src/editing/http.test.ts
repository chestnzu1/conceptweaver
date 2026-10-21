import { describe, expect, it } from 'vitest';
import type { Model } from '../model/types';
import { sampleModel } from '../model/sample';
import { withIris } from '../model/iri';
import { EditError, type Axiom, type ChangeSet, type OntologyEditService } from './contracts';
import { answerEditRequest, createHttpEditService, QUESTIONS } from './http';
import { createLocalEditService } from './local';
import { revisionOf } from '../structure/local';

const REF = { ontologyId: 'onto', revisionId: 'r1' };

/** The axioms of the sample model, by the IRIs the change sets name. */
const S = 'http://example.org/film-knowledge-graph#';
const cls = (name: string) => ({ type: 'Class' as const, iri: S + name });
const add = (axiom: Axiom) => ({ op: 'add' as const, axiom });
const changeSet = (changes: ChangeSet['changes']): ChangeSet => ({ ontologyId: REF.ontologyId, baseRevision: REF.revisionId, changes, summary: 'From elsewhere' });

/** A local edit service over a model of the caller's, and the same service asked over HTTP. */
function services(model: Model) {
  let current = model;
  const local = createLocalEditService({ current: () => ({ model: current, ontologyId: REF.ontologyId }), commit: (next) => (current = next) });
  const sent: { url: string; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const question = url.slice(url.lastIndexOf('/') + 1);
    const body = JSON.parse(String(init?.body));
    sent.push({ url, body });
    const answer = await answerEditRequest(local, question, body);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { local, remote: createHttpEditService('http://backend.example/api/', send), sent, now: () => current };
}

describe('the edit service over HTTP', () => {
  it('applies a change set over the wire as the local service applies it, and validates without changing anything', async () => {
    const model = withIris(sampleModel());
    const ref = { ontologyId: REF.ontologyId, baseRevision: revisionOf(model) };
    const { local, remote, sent, now } = services(model);
    const cs = { ...ref, changes: [add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Film') })], summary: 'Award is a kind of Film' };
    const there = await remote.apply(cs);
    expect(there).toEqual({ ontologyId: REF.ontologyId, revisionId: revisionOf(now()), notes: [] });
    // The whole of the change set is in what is sent; the revision it was made against included.
    expect(sent[0].body).toEqual(cs);
    const moved = { ontologyId: REF.ontologyId, baseRevision: there.revisionId };
    expect(await remote.validate({ ...moved, changes: [add({ type: 'SubClassOf', sub: cls('Person'), sup: cls('Award') })], summary: '' })).toEqual(await local.validate({ ...moved, changes: [add({ type: 'SubClassOf', sub: cls('Person'), sup: cls('Award') })], summary: '' }));
    expect(QUESTIONS).toEqual(['apply', 'validate', 'entity']);
  });

  it('refuses for the same reasons, said the same way', async () => {
    const model = withIris(sampleModel());
    const ref = { ontologyId: REF.ontologyId, baseRevision: revisionOf(model) };
    const { local, remote } = services(model);
    const code = async (run: (s: OntologyEditService) => Promise<unknown>) => {
      const of = (s: OntologyEditService) => run(s).then(() => 'applied', (e) => (e instanceof EditError ? { code: e.code, message: e.message, refusals: e.refusals } : 'other'));
      const [here, there] = [await of(local), await of(remote)];
      expect(there).toEqual(here);
      return there;
    };
    // A change set against a revision the ontology has moved on from.
    expect(await code((s) => s.apply({ ...ref, baseRevision: 'r0', changes: [add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Film') })], summary: '' }))).toMatchObject({ code: 'stale-revision' });
    // A change set held to the editor's rules: a class cannot be its own superclass.
    const refused = await code((s) => s.apply({ ...ref, changes: [add({ type: 'SubClassOf', sub: cls('Award'), sup: cls('Award') })], summary: '' }));
    expect(refused).toMatchObject({ code: 'refused', refusals: [{ code: 'refused' }] });
    // A question the service does not know.
    expect(await answerEditRequest(local, 'delete', {})).toMatchObject({ status: 404, body: { code: 'not-found' } });
    const gone = new AbortController();
    gone.abort();
    await expect(remote.apply(changeSet([]), { signal: gone.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('says what is stated about one entity', async () => {
    const model = withIris(sampleModel());
    const ref = { ontologyId: REF.ontologyId, revisionId: revisionOf(model) };
    const { local, remote } = services(model);
    const [here, there] = [await local.entity({ ...ref, iri: S + 'Award' }), await remote.entity({ ...ref, iri: S + 'Award' })];
    expect({ ...there, revisionId: 'R' }).toEqual({ ...here, revisionId: 'R' });
  });
});
