import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { addIsA } from '../model/axioms';
import { withIris } from '../model/iri';
import { deleteModel, saveModel, storedVersions, useIndexedDb } from '../model/library';
import { fromTurtle } from '../model/rdf';
import { sampleModel } from '../model/sample';
import { importIntoSet, newSetFor } from '../model/shapes';
import type { Model } from '../model/types';
import { changesOf, nothingChanged } from './difference';
import { contentHash, createLocalProjectService } from './local';

/** Named versions and what changed between them (roadmap task 2.3, FR-M10-1 to FR-M10-3), kept in this browser. */

beforeEach(() => useIndexedDb(new IDBFactory()));

/** A service over a model that can be changed, as the editor's is. */
function editor(start: Model) {
  let model = start;
  const service = createLocalProjectService({ current: () => model, replace: (m) => (model = m) });
  return { service, set: (m: Model) => (model = m), get: () => model };
}

const T = `@prefix : <http://example.org/w#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/w> a owl:Ontology .
:Work a owl:Class . :Person a owl:Class .
:Film a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :by ; owl:someValuesFrom :Person ] .
:by a owl:ObjectProperty .`;

describe('versions of a project', () => {
  it('are saved with a name and a summary, listed newest first, and kept in the browser', async () => {
    const m = withIris(sampleModel());
    const { service } = editor(m);
    const a = await service.saveVersion('p1', 'First', 'As it began');
    const b = await service.saveVersion('p1', '  Second  ', '');
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b).toMatchObject({ project: 'p1', name: 'Second', summary: '', entities: m.terms.length + m.props.length, hash: contentHash(m) });
    // Another service over the same database, as a later session: the same versions, newest first.
    const later = createLocalProjectService({ current: () => m, replace: () => {} });
    expect((await later.versions('p1')).map((v) => v.name)).toEqual(['Second', 'First']);
    expect(await later.versions('another')).toEqual([]);
    // The model comes back as it was saved.
    expect(await later.version('p1', a.id)).toEqual(m);
    await expect(service.saveVersion('p1', ' ', '')).rejects.toMatchObject({ code: 'invalid' });
    await expect(service.version('p2', a.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('says there is no change to the ontology when only terms were moved on the canvas', async () => {
    const m = withIris(sampleModel());
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before moving', '');
    ed.set({ ...m, terms: m.terms.map((t) => ({ ...t, x: t.x + 120, y: t.y - 40 })) });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(nothingChanged(d)).toBe(true);
    expect(d.drawing).toBe(true);
    expect(d.axioms).toEqual({ added: 0, removed: 0 });
  });

  it('shows one superclass added and one restriction removed as exactly two changes, under the class', async () => {
    const m = withIris(fromTurtle(T));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const film = m.terms.find((t) => t.name === 'Film')!;
    const work = m.terms.find((t) => t.name === 'Work')!;
    let next = addIsA(m, film.id, work.id).model!;
    // The restriction is the relationship from Film drawn with "by".
    next = { ...next, relations: next.relations.filter((r) => !(r.from === film.id && r.label === 'by')) };
    ed.set(next);
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    const lines = changesOf(d, film.iri!).map((l) => `${l.op === 'add' ? '+' : '-'} ${l.text}`);
    expect(lines).toEqual(['+ Film SubClassOf Work', '- Film SubClassOf by some Person']);
    expect(d.entities.find((e) => e.iri === film.iri)).toMatchObject({ name: 'Film', kind: 'class', status: 'changed' });
  });

  it('tells entities added and removed, the shape sets and the data graphs', async () => {
    const m = withIris(fromTurtle(T));
    const ed = editor(m);
    const v = await ed.service.saveVersion('p', 'Before', '');
    const set = importIntoSet(newSetFor('Catalogue'), '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix : <http://example.org/w#> . :FilmShape sh:targetClass :Film ; sh:property [ sh:path :by ; sh:minCount 1 ] .').set;
    const person = m.terms.find((t) => t.name === 'Person')!;
    ed.set({ ...m, terms: m.terms.filter((t) => t.id !== person.id), relations: m.relations.filter((r) => r.from !== person.id && r.to !== person.id), shapeSets: [set], dataGraphs: [{ id: 'g', name: 'films', file: 'films.ttl', format: 'turtle', triples: 3, fingerprint: 'f', includeOntology: true, read: 1 }] });
    const d = await ed.service.diff('p', { version: v.id }, 'current');
    expect(d.entities.find((e) => e.iri === person.iri)).toMatchObject({ status: 'removed', kind: 'class' });
    expect(d.shapeSets).toEqual([expect.objectContaining({ name: 'Catalogue', status: 'added' })]);
    expect(d.shapeSets[0].changes.map((c) => `${c.op} ${c.text}`).sort()).toEqual(['add :FilmShape sh:property [ sh:minCount 1 ; sh:path :by ] .', 'add :FilmShape sh:targetClass :Film .']);
    expect(d.dataGraphs).toEqual([{ id: 'g', name: 'films', status: 'added' }]);
    // And the other way, everything the other way round.
    const back = await ed.service.diff('p', 'current', { version: v.id });
    expect(back.entities.find((e) => e.iri === person.iri)!.status).toBe('added');
    expect(back.shapeSets[0].status).toBe('removed');
  });

  it('restores a version as a new one, never by deleting history: of five, the sixth is the third', async () => {
    let m = withIris(fromTurtle(T));
    const ed = editor(m);
    const film = m.terms.find((t) => t.name === 'Film')!;
    const saved = [];
    for (let i = 1; i <= 5; i++) {
      m = { ...m, terms: m.terms.map((t) => (t.id === film.id ? { ...t, description: `Edit ${i}` } : t)) };
      ed.set(m);
      saved.push(await ed.service.saveVersion('p', `Version ${i}`, ''));
    }
    const restored = await ed.service.restore('p', saved[2].id);
    const all = await ed.service.versions('p');
    expect(all).toHaveLength(6);
    expect(restored).toMatchObject({ seq: 6, name: 'Restored version 3', hash: saved[2].hash });
    expect(ed.get().terms.find((t) => t.id === film.id)!.description).toBe('Edit 3');
    expect(nothingChanged(await ed.service.diff('p', { version: saved[2].id }, { version: restored.id }))).toBe(true);
    expect(nothingChanged(await ed.service.diff('p', { version: saved[4].id }, { version: restored.id }))).toBe(false);
  });

  it('go when the model is deleted from My Models', async () => {
    const m = withIris(sampleModel());
    const info = await saveModel(m);
    const { service } = editor(m);
    await service.saveVersion(info.id, 'One', '');
    await deleteModel(info.id);
    expect(await storedVersions(info.id)).toEqual([]);
  });
});
