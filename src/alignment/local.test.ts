import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { addMapping } from '../model/alignment';
import { addIsA } from '../model/axioms';
import { iriKey } from '../model/external';
import { withIris } from '../model/iri';
import { emptyModel, newTerm, type Model } from '../model/types';
import { AlignmentError, type AlignmentHost } from './contracts';
import { createLocalAlignmentService } from './local';

const ORG = `@prefix org: <http://example.org/org#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://example.org/org> a owl:Ontology ; rdfs:label "Organization Ontology" .
org:Person a owl:Class ; rdfs:label "Person" .
org:Organization a owl:Class ; rdfs:label "Organization" .
`;

/** Imports the Organization ontology. */
const MIDDLE = `@prefix mid: <http://example.org/mid#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://example.org/mid> a owl:Ontology ; rdfs:label "Middle Ontology" ; owl:imports <http://example.org/org> .
mid:Team a owl:Class ; rdfs:label "Team" ; rdfs:subClassOf <http://example.org/org#Organization> .
`;

/** Imports the middle ontology, which imports the Organization ontology. */
const TOP = `@prefix top: <http://example.org/top#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://example.org/top> a owl:Ontology ; rdfs:label "Top Ontology" ; owl:imports <http://example.org/mid> .
top:Squad a owl:Class ; rdfs:label "Squad" .
`;

const A = `@prefix a: <http://example.org/a#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://example.org/a> a owl:Ontology ; rdfs:label "A" ; owl:imports <http://example.org/b> .
a:One a owl:Class ; rdfs:label "One" .
`;
const B = `@prefix b: <http://example.org/b#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<http://example.org/b> a owl:Ontology ; rdfs:label "B" ; owl:imports <http://example.org/a> .
b:Two a owl:Class ; rdfs:label "Two" .
`;

const ok = (e: { model?: Model; error?: string }) => {
  expect(e.error).toBeUndefined();
  return e.model!;
};
const studio = (): Model => withIris({ ...emptyModel('Studio'), baseIri: 'http://example.org/studio#', terms: [newTerm({ name: 'Person' }), newTerm({ name: 'Freelancer' })] });
const serviceOver = (current: () => Model, cache = new Map<string, string>()) => ({
  service: createLocalAlignmentService({
    current,
    cached: async (id, iri) => cache.get(id) ?? (iri ? cache.get(iri) : undefined),
  } satisfies AlignmentHost),
  cache,
});

describe('the alignment service of the editor', () => {
  it('reads an ontology for review, with the entities whose IRI the model already defines', () => {
    const m = withIris({ ...emptyModel('Studio'), terms: [newTerm({ name: 'Person', iri: 'http://example.org/org#Person' })] });
    const { service } = serviceOver(() => m);
    const preview = service.read(ORG, 'org.ttl', 'file');
    expect(preview.summary.ref).toMatchObject({ name: 'Organization Ontology', iri: 'http://example.org/org', namespace: 'http://example.org/org#', classes: 2 });
    expect(preview.collisions).toEqual([{ iri: 'http://example.org/org#Person', name: 'Person' }]);
    // What cannot be read is said so, and the model is untouched.
    let caught: unknown;
    try {
      service.read('<http://a/x> <http://a/y> "unfinished', 'bad.ttl', 'file');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AlignmentError);
    expect(caught).toMatchObject({ code: 'invalid' });
  });

  it('adds an ontology, keeps it while statements use it, then takes it out', () => {
    let m = studio();
    const { service } = serviceOver(() => m);
    const preview = service.read(ORG, 'org.ttl', 'file');
    const added = service.add(preview, true, 1000);
    m = added.model;
    expect(added.ref).toMatchObject({ name: 'Organization Ontology', imports: true, addedAt: 1000 });
    const person = preview.summary.model.terms.find((t) => t.name === 'Person')!;
    const reuse = service.reuse(added.ref, preview.summary.model, { term: person.id });
    m = reuse.model;
    const freelancer = m.terms.find((t) => t.name === 'Freelancer')!;
    m = ok(addIsA(m, freelancer.id, reuse.entity.id));
    let caught: unknown;
    try {
      service.remove(added.ref.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ name: 'AlignmentError', code: 'in-use' });
    expect((caught as Error).message).toBe('1 statement in this ontology still refer to entities of “Organization Ontology”. Remove those first (the Mappings tab lists them).');
    m = { ...m, relations: [] };
    const gone = service.remove(added.ref.id);
    expect(gone.externals).toEqual([]);
    expect(gone.terms.some((t) => t.external === added.ref.id)).toBe(false);
  });

  it('copies entities in, and answers about mappings, objections and look-alikes', () => {
    let m = studio();
    const { service } = serviceOver(() => m);
    const preview = service.read(ORG, 'org.ttl', 'file');
    const added = service.add(preview, true);
    m = added.model;
    const find = (name: string) => preview.summary.model.terms.find((t) => t.name === name)!;
    const copied = service.copy(added.ref, preview.summary.model, { terms: [find('Organization').id], props: [] });
    expect(copied).toMatchObject({ copied: 1, skipped: [] });
    expect(copied.model.terms.find((t) => t.iri === 'http://example.org/org#Organization')!.external).toBeUndefined();
    // A mapping, with nothing to object to; once Person is mapped, it is no longer suggested.
    const reuse = service.reuse(added.ref, preview.summary.model, { term: find('Person').id });
    m = reuse.model;
    const local = m.terms.find((t) => t.name === 'Person' && t.external === undefined)!;
    m = ok(addMapping(m, { kind: 'term', id: local.id }, 'owl:equivalentClass', reuse.entity));
    expect(service.mappings(m).map((x) => `${x.source.name} ${x.predicate} ${x.target.name}`)).toEqual(['Person owl:equivalentClass Person']);
    expect(service.issues(m)).toEqual([]);
    const mapped = new Set(service.mappings(m).flatMap((x) => [`${x.source.iri}|${x.target.iri}`, `${x.target.iri}|${x.source.iri}`]));
    expect(service.suggest(m, preview.summary.model, mapped).map((s) => s.local.name)).not.toContain('Person');
  });

  it('hands over every ontology the model depends on, however deep the imports go, and names the one it cannot read', async () => {
    const preview = (text: string, source: string) => serviceOver(() => studio()).service.read(text, source, 'file');
    const withTop = { ...studio(), externals: [{ ...preview(TOP, 'top.ttl').summary.ref, id: 'top', addedAt: 1, imports: true }] };
    const cache = new Map<string, string>([
      ['http://example.org/top', TOP],
      ['http://example.org/mid', MIDDLE],
      ['http://example.org/org', ORG],
    ]);
    const { service } = serviceOver(() => withTop, cache);
    const contents = await service.contents(withTop);
    expect(contents.missing).toEqual([]);
    expect(Object.keys(contents.loaded).sort()).toEqual(['iri:http://example.org/mid', 'iri:http://example.org/org', 'iri:http://example.org/top', 'top']);
    const closure = service.closure(withTop, new Map(Object.entries(contents.loaded)));
    expect(closure.missing).toEqual([]);
    expect(closure.model.terms.map((t) => t.iri)).toEqual(expect.arrayContaining(['http://example.org/top#Squad', 'http://example.org/mid#Team', 'http://example.org/org#Person']));
    // Remove the third from the cache: it is named, and its axioms no longer count.
    cache.delete('http://example.org/org');
    const broken = await service.contents(withTop);
    expect(broken.missing.map((e) => e.iri)).toEqual(['http://example.org/org']);
    const partial = service.closure(withTop, new Map(Object.entries(broken.loaded)));
    expect(partial.missing.map((e) => e.iri)).toEqual(['http://example.org/org']);
    expect(partial.model.terms.some((t) => t.iri === 'http://example.org/org#Person')).toBe(false);
  });

  it('reads a cycle of imports once, and stops', async () => {
    const preview = (text: string, source: string) => serviceOver(() => studio()).service.read(text, source, 'file');
    const model = { ...studio(), externals: [{ ...preview(A, 'a.ttl').summary.ref, id: 'a', addedAt: 1, imports: true }] };
    const cache = new Map<string, string>([
      ['http://example.org/a', A],
      ['http://example.org/b', B],
    ]);
    const { service } = serviceOver(() => model, cache);
    const contents = await service.contents(model);
    expect(contents.missing).toEqual([]);
    expect(Object.keys(contents.loaded).sort()).toEqual(['a', 'iri:http://example.org/a', 'iri:http://example.org/b']);
    expect(contents.loaded[iriKey('http://example.org/b')].terms.map((t) => t.name)).toContain('Two');
  });
});
